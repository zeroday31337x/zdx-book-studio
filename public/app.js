const state = { user: null, books: [], book: null, tab: "overview", chapter: 1 };
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
    const provider = status.activeProvider || "none"; const model = status.activeModel || "no model";
    el.textContent = `Core: ${provider} / ${model}`; el.className = provider === "none" ? "status-dot bad" : "status-dot ready";
  } catch (error) { el.textContent = `Core unavailable`; el.className = "status-dot bad"; }
}

function renderBookList() {
  $("bookList").innerHTML = state.books.map(book => `<button class="book-item ${state.book?.id === book.id ? "active" : ""}" data-book="${book.id}">${esc(book.title)}<span>${book.canonChapters}/${book.chapterCount} canon · ${esc(book.status)}</span></button>`).join("");
  document.querySelectorAll("[data-book]").forEach(el => el.onclick = () => openBook(el.dataset.book));
}

async function openBook(id) {
  state.book = await api(`/api/books/${id}`);
  if (state.chapter > state.book.chapterCount) state.chapter = 1;
  renderBookList(); renderWorkspace();
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
    <section class="hero"><div><div class="eyebrow">${esc(b.genre || "Book project")}</div><h1>${esc(b.title)}</h1><div class="tagline">${esc(b.tagline)}</div></div>
    <div class="metrics"><div class="metric"><strong>${canon}/${b.chapterCount}</strong><span>Canon chapters</span></div><div class="metric"><strong>${words.toLocaleString()}</strong><span>Approved words</span></div><div class="metric"><strong>${b.movementCount}</strong><span>Movements</span></div></div></section>
    <nav class="tabs">${["overview","characters","chapters","manuscript"].map(tab => `<button class="tab ${state.tab === tab ? "active" : ""}" data-tab="${tab}">${tab[0].toUpperCase()+tab.slice(1)}</button>`).join("")}</nav>
    <section id="panel-overview" class="panel ${state.tab === "overview" ? "active" : ""}">${overviewPanel(b)}</section>
    <section id="panel-characters" class="panel ${state.tab === "characters" ? "active" : ""}">${charactersPanel(b)}</section>
    <section id="panel-chapters" class="panel ${state.tab === "chapters" ? "active" : ""}">${chaptersPanel(b)}</section>
    <section id="panel-manuscript" class="panel ${state.tab === "manuscript" ? "active" : ""}">${manuscriptPanel(b)}</section>`;
  bindWorkspace();
}

function overviewPanel(b) { return `<div class="grid2"><div class="card"><h2>Book design</h2>${field("tagline","Tagline",b.tagline)}${field("genre","Genre",b.genre)}${field("tone","Tone",b.tone,true)}${field("premise","Premise",b.premise,true)}${field("overview","Overview",b.overview,true,"tall")}</div><div class="card"><h2>Authoritative canon</h2><div class="notice">Anything placed here is treated as immutable during chapter generation unless you edit it deliberately.</div>${field("canon","Canon / world rules",b.canon,true,"tall")}<div class="grid2">${field("targetWords","Target words",b.targetWords)}${field("movementCount","Movements",b.movementCount)}</div><button id="saveBook">Save design</button></div></div>`; }
function field(id,label,value,textarea=false,cls="") { return `<div class="field"><label for="${id}">${label}</label>${textarea ? `<textarea id="${id}" class="${cls}">${esc(value)}</textarea>` : `<input id="${id}" value="${esc(value)}" />`}</div>`; }

function charactersPanel(b) {
  return `<div class="notice">Each POV agent receives its own full character specification. Other POV agents receive only that character's public profile unless continuity says they learned more.</div><div class="character-grid">${b.characters.map(c => `<article class="character-card"><div class="guild">${esc(c.guild)} · ${esc(c.role)}</div><h3>${esc(c.name)}</h3><p>${esc(c.publicProfile)}</p><p class="muted"><strong>Worldview:</strong> ${esc(c.worldview)}</p><p class="muted"><strong>Blind spot:</strong> ${esc(c.blindSpot)}</p><button class="ghost edit-character" data-character="${esc(c.id)}">Edit character bible</button></article>`).join("")}</div><button id="addCharacter" class="ghost" style="margin-top:14px">+ Add character</button>`;
}

function chaptersPanel(b) {
  const selected = b.chapters.find(ch => ch.number === state.chapter) || b.chapters[0]; const pov = b.characters.find(c => c.id === selected.povCharacterId);
  return `<div class="actions" style="margin-bottom:12px"><button id="importOutline" class="ghost">Import ${b.chapterCount}-chapter structure</button><span class="muted">POV rotation is assigned from protagonist POV order unless a chapter specifies otherwise.</span></div><div class="chapter-layout"><div class="card chapter-list">${b.chapters.map(ch => { const c=b.characters.find(x=>x.id===ch.povCharacterId); return `<div class="chapter-row ${ch.number===selected.number?"active":""}" data-chapter="${ch.number}"><div class="num">${ch.number}</div><div><strong>${esc(ch.title)}</strong><div class="pov">${esc(c?.name || "POV unassigned")}</div></div><div class="badge ${ch.status}">${ch.status}</div></div>`; }).join("")}</div><div class="card chapter-detail"><div class="eyebrow">Chapter ${selected.number} · ${esc(pov?.guild || "No guild")}</div><h2>${esc(selected.title)}</h2><div class="field"><label>POV</label><select id="chapterPov">${b.characters.filter(c=>c.role==="protagonist").map(c=>`<option value="${c.id}" ${c.id===selected.povCharacterId?"selected":""}>${esc(c.name)} — ${esc(c.guild)}</option>`).join("")}</select></div><div class="field"><label>One-paragraph chapter structure</label><textarea id="chapterStructure">${esc(selected.structure)}</textarea></div><div class="field"><label>Draft prose · ${selected.wordCount.toLocaleString()} words</label><textarea id="chapterDraft" class="draft">${esc(selected.draft)}</textarea></div><div class="actions"><button id="saveChapter" class="ghost">Save edits</button><button id="generateChapter" ${!selected.structure.trim()?"disabled":""}>Generate + review</button><button id="reviewChapter" class="ghost" ${!selected.draft.trim()?"disabled":""}>Review again</button><button id="approveChapter" ${selected.review?.verdict!=="PASS"?"disabled":""}>Approve as Canon</button></div><div id="chapterMessage"></div>${reviewBlock(selected.review)}</div></div>`;
}
function reviewBlock(review) { if (!review) return ""; return `<div class="review ${review.verdict === "PASS" ? "" : "fail"}"><strong>${esc(review.verdict)}</strong><p>${esc(review.summary)}</p>${review.notes?.length?`<ul>${review.notes.map(n=>`<li>${esc(n)}</li>`).join("")}</ul>`:""}${review.originalityFlags?.length?`<p><strong>Originality flags:</strong> ${esc(review.originalityFlags.join(" · "))}</p>`:""}</div>`; }

function manuscriptPanel(b) { const canon=b.chapters.filter(ch=>ch.status==="canon"); return `<div class="card"><h2>Canonical manuscript</h2><p class="muted">Only human-approved Canon chapters are assembled here. ${canon.length}/${b.chapterCount} chapters currently included.</p><button id="loadManuscript" ${!canon.length?"disabled":""}>Load manuscript</button><textarea id="manuscriptText" class="tall" style="width:100%;min-height:60vh;margin-top:14px" readonly></textarea></div>`; }

function bindWorkspace() {
  document.querySelectorAll("[data-tab]").forEach(el => el.onclick = () => { state.tab = el.dataset.tab; renderWorkspace(); });
  if ($("saveBook")) $("saveBook").onclick = saveBook;
  document.querySelectorAll(".edit-character").forEach(el => el.onclick = () => editCharacter(el.dataset.character));
  if ($("addCharacter")) $("addCharacter").onclick = addCharacter;
  document.querySelectorAll("[data-chapter]").forEach(el => el.onclick = () => { state.chapter = Number(el.dataset.chapter); renderWorkspace(); });
  if ($("importOutline")) $("importOutline").onclick = importOutline;
  if ($("saveChapter")) $("saveChapter").onclick = saveChapter;
  if ($("generateChapter")) $("generateChapter").onclick = generateChapter;
  if ($("reviewChapter")) $("reviewChapter").onclick = reviewChapter;
  if ($("approveChapter")) $("approveChapter").onclick = approveChapter;
  if ($("loadManuscript")) $("loadManuscript").onclick = loadManuscript;
}

async function saveBook() {
  try { await api(`/api/books/${state.book.id}`, { method:"PATCH", body:JSON.stringify({ tagline:$("tagline").value, genre:$("genre").value, tone:$("tone").value, premise:$("premise").value, overview:$("overview").value, canon:$("canon").value, targetWords:Number($("targetWords").value)||80000, movementCount:Number($("movementCount").value)||6 }) }); await openBook(state.book.id); }
  catch(error){ alert(error.message); }
}

async function seedCodebound() { try { const book=await api("/api/codebound/seed",{method:"POST",body:"{}"}); await loadBooksThen(book.id); } catch(error){ alert(error.message); } }
async function newBook() { const title=prompt("Book title"); if(!title)return; try{const book=await api("/api/books",{method:"POST",body:JSON.stringify({title,chapterCount:42})}); await loadBooksThen(book.id);}catch(error){alert(error.message);} }
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
async function generateChapter(){const n=state.chapter;try{await saveChapterStructureOnly();message("POV writer and reviewer are working…");toggleChapterButtons(true);await api(`/api/books/${state.book.id}/chapters/${n}/generate`,{method:"POST",body:"{}"});await openBook(state.book.id);message("Generation complete.");}catch(error){message(error,true)}finally{toggleChapterButtons(false)}}
async function reviewChapter(){const n=state.chapter;try{await saveChapter();message("Reviewer is working…");toggleChapterButtons(true);await api(`/api/books/${state.book.id}/chapters/${n}/review`,{method:"POST",body:"{}"});await openBook(state.book.id);}catch(error){message(error,true)}finally{toggleChapterButtons(false)}}
async function approveChapter(){const n=state.chapter;if(!confirm(`Approve Chapter ${n} as canonical? This becomes authoritative context for later chapters.`))return;try{await api(`/api/books/${state.book.id}/chapters/${n}/approve`,{method:"POST",body:"{}"});if(n<state.book.chapterCount)state.chapter=n+1;await openBook(state.book.id);}catch(error){message(error,true)}}
async function saveChapterStructureOnly(){await api(`/api/books/${state.book.id}/chapters/${state.chapter}`,{method:"PATCH",body:JSON.stringify({structure:$("chapterStructure").value,povCharacterId:$("chapterPov").value})});state.book=await api(`/api/books/${state.book.id}`)}
function toggleChapterButtons(on){["saveChapter","generateChapter","reviewChapter","approveChapter"].forEach(id=>{if($(id))$(id).disabled=on})}
function message(value,isError=false){const el=$("chapterMessage");if(el){el.className=isError?"error":"success";el.textContent=value instanceof Error?value.message:String(value)}}
async function loadManuscript(){try{$(`manuscriptText`).value=await api(`/api/books/${state.book.id}/manuscript`);}catch(error){alert(error.message)}}
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
