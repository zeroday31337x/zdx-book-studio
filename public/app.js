const state = { user: null, books: [], book: null, openBooks: (() => { try { return JSON.parse(localStorage.getItem("zdx-book-studio-open-books") || "[]"); } catch { return []; } })(), tab: "overview", chapter: Number(sessionStorage.getItem("zdx-book-studio-chapter") || 1) };
let reviewPollTimer = null;
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));

$("seedCodebound").onclick = seedCodebound;
$("emptySeed").onclick = seedCodebound;
$("newBook").onclick = newBook;

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers["content-type"] = "application/json";
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) { location.replace("/login.html"); throw new Error("Authentication required"); }
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.message || body?.error || `${res.status} ${res.statusText}`);
  return body;
}

async function refresh() {
  try {
    state.books = await api("/api/books");
    renderBookList();
    if (state.book) await openBook(state.book.id);
    else if (state.books.length) await openBook(state.books[0].id);
    else renderEmpty();
    checkCore();
  } catch (error) { renderError(error); }
}

async function checkCore() {
  const el = $("agentStatus");
  try {
    const status = await api("/api/agent-status");
    const active = status.activeGeneration;
    if (active) {
      el.textContent = `${active.phase === "review" ? "Reviewing" : "Generating"}: inference pool / model not reported`;
      el.className = "status-dot ready";
      el.title = `Chapter ${active.chapter} · Upstream model identification pending pool telemetry`;
    } else {
      el.textContent = "Inference pool: idle";
      el.className = "status-dot";
      el.title = "Configured Ollama model is not necessarily the upstream executing model";
    }
  } catch { el.textContent = "Inference status unavailable"; el.className = "status-dot bad"; }
}
setInterval(checkCore, 3000);

function renderBookList() {
  $("bookList").innerHTML = state.books.map(book => `<button class="book-item ${state.book?.id === book.id ? "active" : ""}" data-book="${book.id}">${esc(book.title)}<span>${book.canonChapters}/${book.chapterCount} canon · ${esc(book.status)}</span></button>`).join("");
  document.querySelectorAll("[data-book]").forEach(el => el.onclick = () => openBook(el.dataset.book));
}

async function openBook(id) {
  state.book = await api("/api/books/" + id);
  state.openBooks = [...new Set([...state.openBooks.filter(bookId => state.books.some(book => book.id === bookId)), id])];
  localStorage.setItem("zdx-book-studio-open-books", JSON.stringify(state.openBooks));
  if (state.chapter > state.book.chapterCount) state.chapter = 1;
  renderBookList(); renderWorkspace();
  syncReviewPolling();
}

function syncReviewPolling() {
  const selected = state.book?.chapters?.find(ch => ch.number === state.chapter);
  if (selected?.reviewStatus === "reviewing" || selected?.generationStatus === "generating") {
    if (reviewPollTimer) return;
    reviewPollTimer = setInterval(async () => {
      try {
        if (!state.book) return;
        const latest = await api(`/api/books/${state.book.id}`);
        state.book = latest;
        state.books = await api("/api/books");
        renderBookList();
        renderWorkspace();
        const current = state.book.chapters.find(ch => ch.number === state.chapter);
        if (current?.reviewStatus !== "reviewing" && current?.generationStatus !== "generating") {
          clearInterval(reviewPollTimer);
          reviewPollTimer = null;
        }
      } catch (error) {
        if (reviewPollTimer) { clearInterval(reviewPollTimer); reviewPollTimer = null; }
      }
    }, 5000);
  } else if (reviewPollTimer) {
    clearInterval(reviewPollTimer);
    reviewPollTimer = null;
  }
}

function renderBookTabs() {
  const tabs = state.openBooks.map(id => {
    const book = state.books.find(item => item.id === id);
    if (!book) return "";
    const active = state.book && state.book.id === id ? " active" : "";
    return '<div class="book-tab' + active + '"><button class="book-tab-open" data-open-book="' + esc(id) + '" title="Open ' + esc(book.title) + '">' + esc(book.title) + '</button><button class="book-tab-close" data-close-book="' + esc(id) + '" aria-label="Close ' + esc(book.title) + ' tab" title="Close tab">×</button></div>';
  }).join("");
  return '<nav class="book-tabs" aria-label="Open books">' + tabs + '<button class="book-tab-new" id="tabNewBook">+ New book</button></nav>';
}

function renderEmpty() {
  state.book = null;
  $("workspace").innerHTML = `<section class="empty-state"><h1>Manuscript production</h1><p>Design the book, lock canon, assign POV agents, then build one reviewed chapter at a time.</p><button id="emptySeed2">Create CodeBound project</button></section>`;
  $("emptySeed2").onclick = seedCodebound;
}

function renderWorkspace() {
  const b = state.book; if (!b) return renderEmpty();
  const canon = b.chapters.filter(ch => ch.status === "canon").length;
  const words = b.chapters.reduce((sum, ch) => sum + (ch.status === "canon" ? ch.wordCount : 0), 0);
  $("workspace").innerHTML = `
    ${renderBookTabs()}
    <section class="hero"><div><div class="eyebrow">${esc(b.genre || "Book project")}</div><h1>${esc(b.title)}</h1><div class="tagline">${esc(b.tagline)}</div></div>
    <div class="metrics"><div class="metric"><strong>${canon}/${b.chapterCount}</strong><span>Canon chapters</span></div><div class="metric"><strong>${words.toLocaleString()}</strong><span>Approved words</span></div><div class="metric"><strong>${b.movementCount}</strong><span>Movements</span></div></div></section>
    <nav class="tabs">${["overview","characters","chapters","manuscript"].map(tab => `<button class="tab ${state.tab === tab ? "active" : ""}" data-tab="${tab}">${tab[0].toUpperCase()+tab.slice(1)}</button>`).join("")}</nav>
    <section id="panel-overview" class="panel ${state.tab === "overview" ? "active" : ""}">${overviewPanel(b)}</section>
    <section id="panel-characters" class="panel ${state.tab === "characters" ? "active" : ""}">${charactersPanel(b)}</section>
    <section id="panel-chapters" class="panel ${state.tab === "chapters" ? "active" : ""}">${chaptersPanel(b)}</section>
    <section id="panel-manuscript" class="panel ${state.tab === "manuscript" ? "active" : ""}">${manuscriptPanel(b)}</section>`;
  bindWorkspace();
}

function overviewPanel(b) { return `<div class="card"><h2>FrictionWrite · Author voice</h2><p class="muted">Optional prose revision through the inference pool, before chapter review.</p><div class="field"><label for="frictionMode">Writing mode</label><select id="frictionMode">${[['off','Off'],['natural','Natural prose'],['my-voice','Write in my voice'],['write-as-me','Write as me'],['raw','Preserve raw voice']].map(([value,label])=>`<option value="${value}" ${b.frictionWrite?.mode===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="field"><label for="frictionSamples">Author samples (separate with a line containing ---)</label><textarea id="frictionSamples" class="tall">${esc((b.frictionWrite?.samples||[]).join('\n---\n'))}</textarea></div><div class="field"><label for="frictionNotes">Voice and reasoning notes</label><textarea id="frictionNotes">${esc(b.frictionWrite?.authorNotes||'')}</textarea></div><button id="saveFriction">Save FrictionWrite</button></div><div class="grid2"><div class="card"><h2>Book design</h2><div class="notice"><strong>Automatic manuscript production</strong><p>${b.autoRun ? `Status: ${esc(b.autoRun.status)} · Next chapter ${b.autoRun.nextChapter}${b.autoRun.lastError ? ` · ${esc(b.autoRun.lastError)}` : ""}` : "Generate and review all chapters in sequence. Only passing chapters are automatically accepted."}</p><div class="actions"><button type="button" id="autoRunBook">${b.autoRun?.status==="paused"?"Resume full book":"Generate full book"}</button><button type="button" class="ghost" id="pauseAutoBook">Pause</button></div></div>${field("tagline","Tagline",b.tagline)}${field("genre","Genre",b.genre)}${field("tone","Tone",b.tone,true)}${field("writingStyle","Your writing style / voice instructions",b.writingStyle||"",true)}${field("writingSample","Sample of your writing",b.writingSample||"",true,"tall")}${field("premise","Premise",b.premise,true)}${field("overview","Overview",b.overview,true,"tall")}</div><div class="card"><h2>Authoritative canon</h2><div class="notice">Anything placed here is treated as immutable during chapter generation unless you edit it deliberately.</div>${field("canon","Canon / world rules",b.canon,true,"tall")}<div class="grid2">${field("targetWords","Target total words",b.targetWords)}${field("chapterTargetWords","Words per chapter",b.chapterTargetWords || Math.round(b.targetWords/b.chapterCount))}${field("movementCount","Movements",b.movementCount)}</div><button id="saveBook">Save design</button></div></div>`; }
function field(id,label,value,textarea=false,cls="") { return `<div class="field"><label for="${id}">${label}</label>${textarea ? `<textarea id="${id}" class="${cls}">${esc(value)}</textarea>` : `<input id="${id}" value="${esc(value)}" />`}</div>`; }

function charactersPanel(b) {
  return `<div class="notice">Each POV agent receives its own full character specification. Other POV agents receive only that character's public profile unless continuity says they learned more.</div><div class="character-grid">${b.characters.map(c => `<article class="character-card"><div class="guild">${esc(c.guild)} · ${esc(c.role)}</div><h3>${esc(c.name)}</h3><p>${esc(c.publicProfile)}</p><p class="muted"><strong>Worldview:</strong> ${esc(c.worldview)}</p><p class="muted"><strong>Blind spot:</strong> ${esc(c.blindSpot)}</p><button class="ghost edit-character" data-character="${esc(c.id)}">Edit character bible</button></article>`).join("")}</div><button id="addCharacter" class="ghost" style="margin-top:14px">+ Add character</button>`;
}

function chaptersPanel(b) {
  const selected = b.chapters.find(ch => ch.number === state.chapter) || b.chapters[0]; const pov = b.characters.find(c => c.id === selected.povCharacterId);
  return `<div class="actions" style="margin-bottom:12px"><button id="importOutline" class="ghost">Import ${b.chapterCount}-chapter structure</button><span class="muted">POV rotation is assigned from protagonist POV order unless a chapter specifies otherwise.</span></div><div class="chapter-layout"><div class="card chapter-list">${b.chapters.map(ch => { const c=b.characters.find(x=>x.id===ch.povCharacterId); const activeTask=ch.generationStatus==="generating"||ch.reviewStatus==="reviewing"; const taskFailed=ch.generationStatus==="failed"||ch.reviewStatus==="failed"; return `<div class="chapter-row ${ch.number===selected.number?"active":""}" data-chapter="${ch.number}"><div class="num">${ch.number}</div><div><strong>${esc(ch.title)}</strong><div class="pov">${esc(c?.name || "POV unassigned")}</div></div><div class="badge ${activeTask?"reviewing":taskFailed?"fail":ch.status}">${ch.generationStatus==="generating"?"generating…":ch.reviewStatus==="reviewing"?"reviewing…":taskFailed?"task failed":ch.status}</div></div>`; }).join("")}</div><div class="card chapter-detail"><div class="eyebrow">Chapter ${selected.number} · ${esc(pov?.guild || "No guild")}</div><h2>${esc(selected.title)}</h2><div class="field"><label>POV</label><select id="chapterPov">${b.characters.filter(c=>c.role==="protagonist").map(c=>`<option value="${c.id}" ${c.id===selected.povCharacterId?"selected":""}>${esc(c.name)} — ${esc(c.guild)}</option>`).join("")}</select></div><div class="field"><label>One-paragraph chapter structure</label><textarea id="chapterStructure">${esc(selected.structure)}</textarea></div><div class="field"><label>Draft prose · ${selected.wordCount.toLocaleString()} words</label><textarea id="chapterDraft" class="draft">${esc(selected.draft)}</textarea></div><div class="notice">Review is optional. You can approve any saved draft as Canon yourself; approval is never automatic.</div><div class="actions"><button id="saveChapter" class="ghost">Save edits</button><button id="generateChapter" ${!selected.structure.trim()||selected.generationStatus==="generating"||selected.reviewStatus==="reviewing"?"disabled":""}>Generate + review</button><button id="reviewChapter" class="ghost" ${!selected.draft.trim()||selected.generationStatus==="generating"||selected.reviewStatus==="reviewing"?"disabled":""}>Review again</button><button id="approveChapter" ${!selected.draft.trim()||selected.generationStatus==="generating"||selected.reviewStatus==="reviewing"||selected.status==="canon"?"disabled":""}>Approve as Canon</button></div><div id="chapterMessage"></div>${taskStateBlock(selected)}${reviewBlock(selected.review)}</div></div>`;
}
function taskStateBlock(chapter) {
  if (chapter.generationStatus === "generating") return `<div class="notice" role="status">Generation is running · started ${esc(chapter.generationStartedAt || "just now")}. You can leave this page and return; task status is saved.</div>`;
  if (chapter.generationStatus === "failed") return `<div class="review fail" role="alert"><strong>Generation failed</strong><p>${esc(chapter.generationError || "The writer failed without returning a result.")}</p></div>`;
  if (chapter.reviewStatus === "reviewing") return `<div class="notice" role="status">Review in progress · started ${esc(chapter.reviewStartedAt || "just now")}. This status is saved and will update automatically.</div>`;
  if (chapter.reviewStatus === "failed") return `<div class="review fail" role="alert"><strong>Review failed</strong><p>${esc(chapter.reviewError || "The reviewer failed without returning a result.")}</p><p>Correct the issue and select Review again.</p></div>`;
  if (chapter.reviewStatus === "complete") return `<div class="notice" role="status">Latest review saved · ${esc(chapter.review?.reviewedAt || chapter.reviewStartedAt || "")}</div>`;
  if (chapter.generationStatus === "complete") return `<div class="notice" role="status">Generation and review task completed.</div>`;
  return "";
}

function reviewBlock(review) { if (!review) return ""; return `<div class="review ${review.verdict === "PASS" ? "" : "fail"}"><strong>${esc(review.verdict)}</strong><p>${esc(review.summary)}</p>${review.notes?.length?`<ul>${review.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}${review.originalityFlags?.length?`<p><strong>Originality flags:</strong> ${esc(review.originalityFlags.join(" · "))}</p>`:""}</div>`; }

function manuscriptPanel(b) { const canon=b.chapters.filter(ch=>ch.status==="canon"); return `<div class="card"><h2>Canonical manuscript</h2><p class="muted">Only human-approved Canon chapters are assembled here. ${canon.length}/${b.chapterCount} chapters currently included.</p><button id="loadManuscript" ${!canon.length?"disabled":""}>Load manuscript</button> <button id="downloadManuscript" ${!canon.length?"disabled":""}>Download manuscript (.md)</button><textarea id="manuscriptText" class="tall" style="width:100%;min-height:60vh;margin-top:14px" readonly></textarea></div>`; }

function bindWorkspace() {
  document.querySelectorAll("[data-open-book]").forEach(el => el.onclick = () => openBook(el.dataset.openBook));
  document.querySelectorAll("[data-close-book]").forEach(el => el.onclick = async () => {
    const id = el.dataset.closeBook;
    state.openBooks = state.openBooks.filter(bookId => bookId !== id);
    localStorage.setItem("zdx-book-studio-open-books", JSON.stringify(state.openBooks));
    if (state.book && state.book.id === id) {
      const next = state.openBooks[state.openBooks.length - 1];
      if (next) await openBook(next);
      else { state.book = null; renderWorkspace(); }
    } else renderWorkspace();
  });
  if ($("tabNewBook")) $("tabNewBook").onclick = newBook;
  document.querySelectorAll("[data-tab]").forEach(el => el.onclick = () => { state.tab = el.dataset.tab; renderWorkspace(); });
  if ($("saveBook")) $("saveBook").onclick = saveBook;
  if ($("saveFriction")) $("saveFriction").onclick = saveFriction;
  document.querySelectorAll(".edit-character").forEach(el => el.onclick = () => editCharacter(el.dataset.character));
  if ($("addCharacter")) $("addCharacter").onclick = addCharacter;
  document.querySelectorAll("[data-chapter]").forEach(el => el.onclick = () => { state.chapter = Number(el.dataset.chapter); try { sessionStorage.setItem("zdx-book-studio-chapter", String(state.chapter)); } catch {} renderWorkspace(); syncReviewPolling(); });
  if ($("importOutline")) $("importOutline").onclick = importOutline;
  if ($("saveChapter")) $("saveChapter").onclick = saveChapter;
  if ($("autoRunBook")) $("autoRunBook").onclick=async()=>{if(!confirm("Automatically generate, review and accept passing chapters until the book is complete?"))return;try{await api(`/api/books/${state.book.id}/auto-run`,{method:"POST",body:"{}"});await openBook(state.book.id)}catch(e){alert(e.message)}};
  if ($("pauseAutoBook")) $("pauseAutoBook").onclick=async()=>{try{await api(`/api/books/${state.book.id}/auto-pause`,{method:"POST",body:"{}"});await openBook(state.book.id)}catch(e){alert(e.message)}};
  if ($("generateChapter")) $("generateChapter").onclick = generateChapter;
  if ($("reviewChapter")) $("reviewChapter").onclick = reviewChapter;
  if ($("approveChapter")) $("approveChapter").onclick = approveChapter;
  if ($("loadManuscript")) $("loadManuscript").onclick = loadManuscript;
  if ($("downloadManuscript")) $("downloadManuscript").onclick = downloadManuscript;
}

async function saveFriction() {
  const mode = $('frictionMode').value;
  const samples = $('frictionSamples').value.split('\n---\n').map(s=>s.trim()).filter(Boolean);
  try {
    await api(`/api/books/${state.book.id}/frictionwrite`, {method:'PUT',body:JSON.stringify({mode,samples,authorNotes:$('frictionNotes').value})});
    await openBook(state.book.id);
  } catch(error) { alert(error.message); }
}

async function saveBook() {
  try { await api(`/api/books/${state.book.id}`, { method:"PATCH", body:JSON.stringify({ tagline:$("tagline").value, genre:$("genre").value, tone:$("tone").value, writingStyle:$("writingStyle").value, writingSample:$("writingSample").value, premise:$("premise").value, overview:$("overview").value, canon:$("canon").value, targetWords:Number($("targetWords").value)||80000, chapterTargetWords:Number($("chapterTargetWords").value)||undefined, movementCount:Number($("movementCount").value)||6 }) }); await openBook(state.book.id); }
  catch(error){ alert(error.message); }
}

async function seedCodebound() { try { const book=await api("/api/codebound/seed",{method:"POST",body:"{}"}); await loadBooksThen(book.id); } catch(error){ alert(error.message); } }
async function newBook() {
  const body = $("dialogBody");
  body.innerHTML = `
    <h2>Create a new book</h2>
    <div class="actions"><button type="button" id="nb-mode-auto">Auto Generate</button><button type="button" id="nb-mode-control" class="ghost">More Control</button></div>
    <div id="nb-auto" hidden><p>Describe your book in a paragraph or two. An outline and characters will be prepared for you to review.</p><textarea id="nb-idea" class="tall" placeholder="Describe the story, setting, characters or kind of book you want to read..."></textarea><div class="grid2"><div class="field"><label>Chapters</label><input id="nb-auto-chapters" type="number" min="1" max="60" value="12"></div><div class="field"><label>Words per chapter</label><input id="nb-auto-length" type="number" min="600" max="10000" value="1800"></div></div><div class="field"><label>Your writing style / voice (optional)</label><textarea id="nb-auto-style" maxlength="4000" placeholder="Describe your sentence rhythm, dialogue, mood and language preferences"></textarea></div><div class="field"><label>Paste a sample of your own writing (optional)</label><textarea id="nb-auto-sample" maxlength="12000"></textarea></div><button type="button" id="nb-auto-create">Generate book setup</button><div id="nb-auto-error" class="error"></div></div>
    <div id="nb-control" hidden>
    <p class="muted">Set up this book's own design and chapter plan. Nothing from CodeBound will be copied into it.</p>
    <div id="newBookForm">
      <div class="field"><label for="nb-title">Book title *</label><input id="nb-title" name="title" required maxlength="200" placeholder="Working title" /></div>
      <div class="grid2">
        <div class="field"><label for="nb-genre">Genre / category</label><input id="nb-genre" maxlength="120" placeholder="e.g. Science fiction, history" /></div>
        <div class="field"><label for="nb-tagline">Tagline</label><input id="nb-tagline" maxlength="500" placeholder="One-line description" /></div>
      </div>
      <div class="field"><label for="nb-premise">Premise / central idea</label><textarea id="nb-premise" maxlength="10000" placeholder="What is this book about?"></textarea></div>
      <div class="field"><label for="nb-overview">Book overview / intended outcome</label><textarea id="nb-overview" maxlength="30000" placeholder="Main themes, argument or story arc"></textarea></div>
      <div class="field"><label for="nb-tone">Tone and style</label><textarea id="nb-tone" maxlength="500" placeholder="e.g. accessible, rigorous, atmospheric, conversational"></textarea></div>
      <div class="field"><label for="nb-style">Your writing style / voice (optional)</label><textarea id="nb-style" maxlength="4000"></textarea></div><div class="field"><label for="nb-sample">Paste a sample of your own writing (optional)</label><textarea id="nb-sample" maxlength="12000"></textarea></div>
      <div class="field"><label for="nb-canon">Canon, world rules or editorial constraints</label><textarea id="nb-canon" maxlength="100000" placeholder="Facts, rules, source requirements, or things the writing must preserve"></textarea></div>
      <div class="grid2">
        <div class="field"><label for="nb-chapters">Planned chapter count *</label><input id="nb-chapters" type="number" min="1" max="200" value="12" required /></div>
        <div class="field"><label for="nb-movements">Parts / movements</label><input id="nb-movements" type="number" min="1" max="50" value="3" required /></div>
      </div>
      <div class="field"><label for="nb-length">Words per chapter</label><input id="nb-length" type="number" min="600" max="10000" value="1800" /></div>
      <div class="field"><label for="nb-words">Target total words</label><input id="nb-words" type="number" min="1000" max="1000000" step="1000" value="80000" required /></div>
      <div class="actions"><button type="button" id="createBookSubmit">Create book workspace</button><button type="button" class="ghost" id="cancelNewBook">Cancel</button></div>
      <div id="newBookError" class="error" role="alert"></div>
    </div></div>`;
  $("dialog").showModal();
  $("nb-mode-auto").onclick=()=>{$("nb-auto").hidden=false;$("nb-control").hidden=true};
  $("nb-mode-control").onclick=()=>{$("nb-auto").hidden=true;$("nb-control").hidden=false};
  $("nb-auto-create").onclick=async()=>{const button=$("nb-auto-create");button.disabled=true;$("nb-auto-error").textContent="";try{const book=await api("/api/books/auto-design",{method:"POST",body:JSON.stringify({idea:$("nb-idea").value,chapterCount:Number($("nb-auto-chapters").value),chapterTargetWords:Number($("nb-auto-length").value),writingStyle:$("nb-auto-style").value,writingSample:$("nb-auto-sample").value})});$("dialog").close();state.tab="overview";state.chapter=1;await loadBooksThen(book.id)}catch(e){$("nb-auto-error").textContent=e.message}finally{button.disabled=false}};
  $("cancelNewBook").onclick = () => $("dialog").close();
  $("createBookSubmit").onclick = async () => {
    const submit = $("createBookSubmit");
    submit.disabled = true;
    $("newBookError").textContent = "";
    const payload = {
      title: $("nb-title").value.trim(),
      genre: $("nb-genre").value.trim(),
      tagline: $("nb-tagline").value.trim(),
      premise: $("nb-premise").value.trim(),
      overview: $("nb-overview").value.trim(),
      tone: $("nb-tone").value.trim(),
      canon: $("nb-canon").value.trim(),
      writingStyle: $("nb-style").value.trim(), writingSample: $("nb-sample").value.trim(),
      chapterCount: Number($("nb-chapters").value),
      movementCount: Number($("nb-movements").value),
      targetWords: Number($("nb-chapters").value) * Number($("nb-length").value),
      chapterTargetWords: Number($("nb-length").value)
    };
    if (!payload.title || !Number.isInteger(payload.chapterCount) || payload.chapterCount < 1 || payload.chapterCount > 200 || !Number.isInteger(payload.movementCount) || payload.movementCount < 1 || payload.movementCount > 50 || !Number.isInteger(payload.targetWords) || payload.targetWords < 1000 || payload.targetWords > 1000000) {
      $("newBookError").textContent = "Enter a title, 1–200 chapters, 1–50 parts, and a target of 1,000–1,000,000 words.";
      submit.disabled = false;
      return;
    }
    try {
      const book = await api("/api/books", { method: "POST", body: JSON.stringify(payload) });
      $("dialog").close();
      state.tab = "overview";
      state.chapter = 1;
      try { sessionStorage.setItem("zdx-book-studio-chapter", "1"); } catch {}
      await loadBooksThen(book.id);
    } catch (error) {
      $("newBookError").textContent = error.message;
      submit.disabled = false;
    }
  };
}
async function loadBooksThen(id){ state.books=await api("/api/books"); await openBook(id); }

async function editCharacter(id) {
  const c=state.book.characters.find(x=>x.id===id); if(!c)return;
  const body=$("dialogBody"); body.innerHTML=`<h2>${esc(c.name)}</h2>${dialogField("dc-name","Name",c.name)}${dialogField("dc-guild","Guild",c.guild)}${dialogField("dc-public","Public profile",c.publicProfile,true)}${dialogField("dc-worldview","Worldview",c.worldview,true)}${dialogField("dc-wound","Wound",c.wound,true)}${dialogField("dc-strength","Strength",c.strength,true)}${dialogField("dc-blind","Blind spot",c.blindSpot,true)}${dialogField("dc-voice","Voice specification",c.voice,true)}${dialogField("dc-private","Private knowledge",c.privateKnowledge,true)}<button type="button" id="saveCharacter">Save character</button>`;
  $("dialog").showModal(); $("saveCharacter").onclick=async()=>{try{await api(`/api/books/${state.book.id}/characters/${id}`,{method:"PATCH",body:JSON.stringify({name:$("dc-name").value,guild:$("dc-guild").value,publicProfile:$("dc-public").value,worldview:$("dc-worldview").value,wound:$("dc-wound").value,strength:$("dc-strength").value,blindSpot:$("dc-blind").value,voice:$("dc-voice").value,privateKnowledge:$("dc-private").value})});$("dialog").close();await openBook(state.book.id);}catch(error){alert(error.message)}};
}
function dialogField(id,label,value,area=false){return `<div class="field"><label>${label}</label>${area?`<textarea id="${id}">${esc(value)}</textarea>`:`<input id="${id}" value="${esc(value)}" />`}</div>`;}
async function addCharacter(){const name=prompt("Character name");if(!name)return;const guild=prompt("Guild / faction")||"";try{await api(`/api/books/${state.book.id}/characters`,{method:"POST",body:JSON.stringify({name,guild,role:"supporting"})});await openBook(state.book.id);}catch(error){alert(error.message)}}

async function importOutline(){
  $("dialogBody").innerHTML=`<h2>Import chapter structure</h2><p class="muted">Paste exactly ${state.book.chapterCount} paragraphs, one per chapter, separated by blank lines. Leading chapter numbers are removed automatically.</p><div class="field"><textarea id="outlineText" class="tall"></textarea></div><button type="button" id="applyOutline">Apply outline</button>`;$("dialog").showModal();
  $("applyOutline").onclick=async()=>{const blocks=$("outlineText").value.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean).map(s=>s.replace(/^\s*(?:chapter\s*)?\d+\s*[.):-]?\s*/i,""));if(blocks.length!==state.book.chapterCount){alert(`Expected ${state.book.chapterCount} paragraphs; found ${blocks.length}.`);return;}try{await api(`/api/books/${state.book.id}/outline`,{method:"POST",body:JSON.stringify({chapters:blocks})});$("dialog").close();await openBook(state.book.id);}catch(error){alert(error.message)}};
}

async function saveChapter(){const n=state.chapter;try{await api(`/api/books/${state.book.id}/chapters/${n}`,{method:"PATCH",body:JSON.stringify({structure:$("chapterStructure").value,povCharacterId:$("chapterPov").value,draft:$("chapterDraft").value})});await openBook(state.book.id);}catch(error){message(error,true)}}
async function generateChapter(){const n=state.chapter;try{await saveChapterStructureOnly();message("Generation task queued. This page will update as it runs.");toggleChapterButtons(true);await api(`/api/books/${state.book.id}/chapters/${n}/generate`,{method:"POST",body:"{}"});await openBook(state.book.id);syncReviewPolling();}catch(error){message(error,true)}finally{toggleChapterButtons(false)}}
async function reviewChapter(){const n=state.chapter;try{await saveChapter();message("Review task queued. This page will update as it runs.");toggleChapterButtons(true);await api(`/api/books/${state.book.id}/chapters/${n}/review`,{method:"POST",body:"{}"});await openBook(state.book.id);syncReviewPolling();}catch(error){message(error,true)}finally{toggleChapterButtons(false)}}
async function approveChapter(){const n=state.chapter;if(!confirm(`Approve Chapter ${n} as canonical? This becomes authoritative context for later chapters.`))return;try{await api(`/api/books/${state.book.id}/chapters/${n}/approve`,{method:"POST",body:"{}"});if(n<state.book.chapterCount)state.chapter=n+1;await openBook(state.book.id);}catch(error){message(error,true)}}
async function saveChapterStructureOnly(){await api(`/api/books/${state.book.id}/chapters/${state.chapter}`,{method:"PATCH",body:JSON.stringify({structure:$("chapterStructure").value,povCharacterId:$("chapterPov").value})});state.book=await api(`/api/books/${state.book.id}`)}
function toggleChapterButtons(on){["saveChapter","generateChapter","reviewChapter","approveChapter"].forEach(id=>{if($(id))$(id).disabled=on})}
function message(value,isError=false){const el=$("chapterMessage");if(el){el.className=isError?"error":"success";el.textContent=value instanceof Error?value.message:String(value)}}
async function loadManuscript(){try{$("manuscriptText").value=await api(`/api/books/${state.book.id}/manuscript`);}catch(error){alert(error.message)}}
async function downloadManuscript(){try{const content=await api(`/api/books/${state.book.id}/manuscript`);const blob=new Blob([content],{type:"text/markdown;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`${(state.book.title||"manuscript").replace(/[^a-z0-9_-]+/gi,"-").replace(/^-|-$/g,"")||"manuscript"}.md`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){alert(error.message)}}
function renderError(error){$("workspace").innerHTML=`<div class="empty-state"><h1>Book Studio</h1><p class="error">${esc(error.message)}</p></div>`}

async function bootstrap(){
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
    $("userEmail").textContent = `${state.user.email} · ${state.user.role}`;
    $("logout").onclick = async () => { try { await api("/api/auth/logout", { method:"POST", body:"{}" }); } finally { location.replace("/login.html"); } };
    $("changePassword").onclick = changeOwnPassword;
    if (state.user.mustChangePassword) return location.replace("/login.html");
    await refresh();
  } catch (error) { renderError(error); }
}

async function changeOwnPassword(){
  const currentPassword = prompt("Current password"); if(!currentPassword) return;
  const newPassword = prompt("New password (at least 14 characters)"); if(!newPassword) return;
  if(newPassword.length < 14) return alert("New password must be at least 14 characters.");
  try {
    await api("/api/auth/change-password", { method:"POST", body:JSON.stringify({ currentPassword, newPassword }) });
    alert("Password changed. Sign in again.");
    location.replace("/login.html");
  } catch(error) { alert(error.message); }
}

bootstrap();
