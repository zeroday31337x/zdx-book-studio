import type { AuthorProfile, BookProject, FrontMatterConfig } from "./types.js";

export function defaultFrontMatter(): FrontMatterConfig {
  return {
    authorProfileId: null,
    copyrightPage: { mode: "default", year: new Date().getFullYear(), holder: "", customText: "" },
    dedicationPage: { mode: "default", dedicatee: "", customText: "" },
    preface: "",
    acknowledgments: ""
  };
}

function section(heading: string, prose: string): string {
  return `# ${heading}\n\n${prose.trim()}`;
}

/** Only canon chapters are exported; drafts and private character notes are excluded. */
export function assembleManuscript(book: BookProject, author?: AuthorProfile): string {
  const approved = book.chapters.filter(ch => ch.status === "canon").sort((a,b) => a.number - b.number);
  const chapters = approved.map(ch => section(ch.title, ch.approvedText));
  const config = book.frontMatter;
  if (!config) return `# ${book.title}\n\n${chapters.join("\n\n---\n\n")}\n`;
  if (config.authorProfileId && (!author || author.id !== config.authorProfileId || author.ownerEmail !== book.ownerEmail))
    throw new Error("selected_author_profile_unavailable");
  const parts = [`# ${book.title}${author ? `\n\nBy ${author.byline}` : ""}`];
  if (config.copyrightPage.mode !== "off") {
    let body = config.copyrightPage.customText.trim();
    if (config.copyrightPage.mode === "default") {
      const holder = config.copyrightPage.holder.trim() || author?.byline.trim();
      if (!holder) throw new Error("copyright_holder_required");
      body = `Copyright © ${config.copyrightPage.year} ${holder}. All rights reserved.\n\nNo part of this publication may be reproduced or distributed without permission, except as permitted by law.`;
    }
    if (body) parts.push(section("Copyright", body));
  }
  if (config.dedicationPage.mode === "default" && config.dedicationPage.dedicatee.trim())
    parts.push(section("Dedication", `Dedicated to ${config.dedicationPage.dedicatee.trim()}.`));
  if (config.dedicationPage.mode === "custom" && config.dedicationPage.customText.trim())
    parts.push(section("Dedication", config.dedicationPage.customText));
  if (config.preface.trim()) parts.push(section("Preface", config.preface));
  parts.push(...chapters);
  if (config.acknowledgments.trim()) parts.push(section("Acknowledgments", config.acknowledgments));
  if (author) {
    const details = [author.bio.trim(), author.website.trim(), author.contactEmail.trim()].filter(Boolean);
    parts.push(section("About the Author", `**${author.byline}**\n\n${details.join("\n\n")}`));
  }
  return (parts.join("\n\n---\n\n") + "\n");
}
