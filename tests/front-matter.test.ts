import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BookStore } from "../src/store.js";
import { assembleManuscript, defaultFrontMatter } from "../src/front-matter.js";

test("author pages persist and are isolated by account for reads, edits, and deletes", () => {
  const dir=mkdtempSync(path.join(tmpdir(),"zdx-frontmatter-"));
  const saved=process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR=path.join(dir,"manuscripts");
  try {
    const db=path.join(dir,"books.json");
    const store=new BookStore(db);
    const details={label:"Public pen name",byline:"J. V.",bio:"Writes imaginative fiction.",website:"https://example.org",contactEmail:"author@example.org"};
    const p=store.createAuthorProfile("a@example.org",details);
    assert.equal(store.listAuthorProfiles("a@example.org").length,1);
    assert.equal(store.listAuthorProfiles("b@example.org").length,0);
    assert.equal(store.getAuthorProfile("b@example.org",p.id),undefined);
    assert.equal(store.updateAuthorProfile("b@example.org",p.id,{...details,bio:"STEAL"}),undefined);
    assert.equal(store.deleteAuthorProfile("b@example.org",p.id),false);
    assert.equal(store.getAuthorProfile("a@example.org",p.id)?.bio,details.bio);
    const reopened=new BookStore(db);
    assert.equal(reopened.getAuthorProfile("a@example.org",p.id)?.byline,details.byline);
    assert.equal(reopened.updateAuthorProfile("a@example.org",p.id,{...details,label:"Updated"})?.label,"Updated");
    assert.equal(reopened.deleteAuthorProfile("a@example.org",p.id),true);
    assert.equal(reopened.listAuthorProfiles("a@example.org").length,0);
  } finally {
    if(saved===undefined)delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR=saved;
    rmSync(dir,{recursive:true,force:true});
  }
});

test("finished manuscript renders selected author, default legal/dedication and optional pages in order", () => {
  const dir=mkdtempSync(path.join(tmpdir(),"zdx-frontmatter-"));
  const saved=process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
  process.env.BOOK_STUDIO_MANUSCRIPT_DIR=path.join(dir,"manuscripts");
  try {
    const store=new BookStore(path.join(dir,"books.json"));
    const profile=store.createAuthorProfile("one@example.org",{label:"Sci-fi",byline:"Author One",bio:"Biography text",website:"https://example.org",contactEmail:"author@example.org"});
    const book=store.create({title:"The Next Book",ownerEmail:"one@example.org",chapterCount:2});
    book.chapters[0].title="First Chapter";book.chapters[0].status="canon";book.chapters[0].approvedText="APPROVED TEXT";
    book.chapters[1].title="Second Chapter";book.chapters[1].status="draft";book.chapters[1].draft="SECRET DRAFT";
    const before=assembleManuscript(book);
    assert.ok(!before.includes("About the Author"),"legacy default export remains unchanged");
    assert.ok(!before.includes("SECRET DRAFT"));
    book.frontMatter=defaultFrontMatter();
    book.frontMatter.authorProfileId=profile.id;
    book.frontMatter.copyrightPage.year=2026;
    book.frontMatter.dedicationPage.dedicatee="My family";
    book.frontMatter.preface="Before we begin.";
    book.frontMatter.acknowledgments="Thank you.";
    store.save(book);
    const loaded=store.get(book.id)!;
    const out=assembleManuscript(loaded,store.getAuthorProfile("one@example.org",profile.id));
    for(const text of ["Copyright © 2026 Author One", "Dedicated to My family.", "Before we begin.", "APPROVED TEXT", "Thank you.", "Biography text", "author@example.org"]){
      assert.ok(out.includes(text),"missing "+text);
    }
    assert.ok(!out.includes("SECRET DRAFT"));
    const positions=["# The Next Book","# Copyright","# Dedication","# Preface","# First Chapter","# Acknowledgments","# About the Author"].map(p=>out.indexOf(p));
    assert.ok(positions.every((p,i)=>p>=0&&(i===0||p>positions[i-1])),String(positions));
    assert.throws(()=>assembleManuscript(loaded,{...profile,ownerEmail:"wrong@example.org"}),/selected_author_profile_unavailable/);
    loaded.frontMatter!.copyrightPage.mode="custom";
    loaded.frontMatter!.copyrightPage.customText="Custom publication notice.";
    loaded.frontMatter!.dedicationPage.mode="custom";
    loaded.frontMatter!.dedicationPage.customText="To everyone who believed.";
    const custom=assembleManuscript(loaded,profile);
    assert.ok(custom.includes("Custom publication notice."));
    assert.ok(custom.includes("To everyone who believed."));
    assert.ok(!custom.includes("Copyright © 2026"));
    loaded.frontMatter!.copyrightPage.mode="off";
    loaded.frontMatter!.dedicationPage.mode="off";
    const off=assembleManuscript(loaded,profile);
    assert.ok(!off.includes("# Copyright"));
    assert.ok(!off.includes("# Dedication"));
    loaded.frontMatter!.copyrightPage.mode="default";
    loaded.frontMatter!.copyrightPage.holder="";
    loaded.frontMatter!.authorProfileId=null;
    assert.throws(()=>assembleManuscript(loaded),/copyright_holder_required/);
  } finally {
    if(saved===undefined)delete process.env.BOOK_STUDIO_MANUSCRIPT_DIR;
    else process.env.BOOK_STUDIO_MANUSCRIPT_DIR=saved;
    rmSync(dir,{recursive:true,force:true});
  }
});
