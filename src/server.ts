import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { BookStore, seedCodebound } from "./store.js";
import { BookAgentService } from "./agent-service.js";
import { previousCanonRequired, wordCount } from "./context.js";
import type { BookProject, Character } from "./types.js";
import { AuthStore, expiredSessionCookie, sessionCookie, sessionTokenFromCookie } from "./auth.js";

loadEnv();
const app = express();
const store = new BookStore();
const agents = new BookAgentService();
const auth = new AuthStore();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const adminEmail = process.env.BOOK_STUDIO_ADMIN_EMAIL || "";
const adminPassword = process.env.BOOK_STUDIO_ADMIN_PASSWORD || "";
if (adminEmail && adminPassword) auth.seedAdmin(adminEmail, adminPassword);
if (!auth.hasUsers()) throw new Error("Book Studio requires at least one seeded account");

app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));
app.use(express.static(publicDir, { index: false }));

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(500) });
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(500), newPassword: z.string().min(14).max(500) });

function requestSecure(req: express.Request) {
  if (process.env.BOOK_STUDIO_COOKIE_SECURE === "1") return true;
  return req.secure || req.header("x-forwarded-proto") === "https";
}
function studioUser(req: express.Request) { return auth.authenticate(sessionTokenFromCookie(req.header("cookie"))); }
function loginAllowed(ip: string) {
  const now = Date.now(); const current = loginAttempts.get(ip);
  if (!current || current.resetAt <= now) { loginAttempts.set(ip, { count: 0, resetAt: now + 15 * 60_000 }); return true; }
  return current.count < 8;
}
function loginFailed(ip: string) {
  const item = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60_000 };
  item.count++; loginAttempts.set(ip, item);
}

app.post("/api/auth/login", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!loginAllowed(ip)) return res.status(429).json({ error: "too_many_attempts", message: "Too many login attempts. Try again later." });
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) { loginFailed(ip); return res.status(400).json({ error: "invalid_login" }); }
  const result = auth.login(parsed.data.email, parsed.data.password);
  if (!result) { loginFailed(ip); return res.status(401).json({ error: "invalid_credentials", message: "Invalid email or password." }); }
  loginAttempts.delete(ip);
  res.setHeader("Set-Cookie", sessionCookie(result.token, requestSecure(req)));
  res.json({ user: result.user });
});

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api", (req, res, next) => {
  const user = studioUser(req);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  (req as any).studioUser = user;
  if (user.mustChangePassword && !["/auth/me", "/auth/change-password", "/auth/logout"].includes(req.path)) return res.status(428).json({ error: "password_change_required", message: "Change the temporary password before using Book Studio." });
  next();
});

app.get("/api/auth/me", (req, res) => res.json({ user: (req as any).studioUser }));
app.post("/api/auth/logout", (req, res) => {
  auth.logout(sessionTokenFromCookie(req.header("cookie")));
  res.setHeader("Set-Cookie", expiredSessionCookie(requestSecure(req)));
  res.json({ ok: true });
});
app.post("/api/auth/change-password", (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_password", message: "New password must be at least 14 characters." });
  const user = (req as any).studioUser;
  if (!auth.changePassword(user.email, parsed.data.currentPassword, parsed.data.newPassword)) return res.status(401).json({ error: "current_password_invalid", message: "Current password is incorrect." });
  res.setHeader("Set-Cookie", expiredSessionCookie(requestSecure(req)));
  res.json({ ok: true, reauthenticate: true });
});

app.get(["/", "/index.html"], (req, res) => {
  if (!studioUser(req)) return res.redirect(302, "/login.html");
  res.sendFile(path.join(publicDir, "index.html"));
});

const createBookSchema = z.object({
  title: z.string().min(1).max(200), tagline: z.string().max(500).optional(), genre: z.string().max(120).optional(), tone: z.string().max(500).optional(),
  premise: z.string().max(10000).optional(), overview: z.string().max(30000).optional(), canon: z.string().max(100000).optional(),
  chapterCount: z.number().int().min(1).max(200).optional(), movementCount: z.number().int().min(1).max(50).optional(), targetWords: z.number().int().min(1000).max(1000000).optional()
});
const characterSchema = z.object({
  id: z.string().min(1).max(80).optional(), name: z.string().min(1).max(200), guild: z.string().max(200).default(""), role: z.enum(["protagonist", "antagonist", "supporting"]).default("supporting"),
  povOrder: z.number().int().min(1).max(20).optional(), publicProfile: z.string().max(10000).default(""), worldview: z.string().max(10000).default(""), wound: z.string().max(10000).default(""),
  strength: z.string().max(10000).default(""), blindSpot: z.string().max(10000).default(""), voice: z.string().max(20000).default(""), privateKnowledge: z.string().max(30000).default("")
});

app.get("/api/agent-status", async (_req, res) => {
  try { res.json(await agents.providerState()); }
  catch (error) { res.status(503).json({ error: "agent_core_unavailable", message: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/books", (_req, res) => {
  res.json(store.list().map(book => ({ id: book.id, title: book.title, status: book.status, chapterCount: book.chapterCount, canonChapters: book.chapters.filter(ch => ch.status === "canon").length, updatedAt: book.updatedAt })));
});
app.post("/api/books", (req, res) => {
  const parsed = createBookSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_book", details: parsed.error.flatten() });
  res.status(201).json(store.create(parsed.data));
});
app.post("/api/codebound/seed", (_req, res) => res.status(201).json(seedCodebound(store)));
app.get("/api/books/:id", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" }); res.json(book);
});
app.patch("/api/books/:id", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const allowed = ["title", "tagline", "genre", "tone", "premise", "overview", "canon", "targetWords", "movementCount", "status"] as const;
  for (const key of allowed) if (req.body[key] !== undefined) (book as any)[key] = req.body[key];
  res.json(store.save(book));
});
app.post("/api/books/:id/characters", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const parsed = characterSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "invalid_character", details: parsed.error.flatten() });
  const id = parsed.data.id || parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || crypto.randomUUID();
  if (book.characters.some(c => c.id === id)) return res.status(409).json({ error: "character_id_exists" });
  const character = { ...parsed.data, id } as Character; book.characters.push(character); res.status(201).json(store.save(book));
});
app.patch("/api/books/:id/characters/:characterId", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const character = book.characters.find(c => c.id === req.params.characterId); if (!character) return res.status(404).json({ error: "character_not_found" });
  const parsed = characterSchema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "invalid_character", details: parsed.error.flatten() });
  Object.assign(character, parsed.data); res.json(store.save(book));
});
app.post("/api/books/:id/outline", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const chapters = Array.isArray(req.body.chapters) ? req.body.chapters : null;
  if (!chapters || chapters.length !== book.chapterCount) return res.status(400).json({ error: "outline_count_mismatch", expected: book.chapterCount, received: chapters?.length || 0 });
  const povs = book.characters.filter(c => c.role === "protagonist" && c.povOrder).sort((a,b) => (a.povOrder || 0) - (b.povOrder || 0));
  for (let i = 0; i < chapters.length; i++) {
    const item = chapters[i]; const chapter = book.chapters[i];
    chapter.title = typeof item === "string" ? `Chapter ${i + 1}` : String(item.title || `Chapter ${i + 1}`);
    chapter.structure = typeof item === "string" ? item.trim() : String(item.structure || "").trim();
    if (typeof item === "object" && item.povCharacterId) chapter.povCharacterId = String(item.povCharacterId);
    else if (povs.length) chapter.povCharacterId = povs[i % povs.length].id;
  }
  res.json(store.save(book));
});
app.patch("/api/books/:id/chapters/:number", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const chapter = chapterOf(book, req.params.number); if (!chapter) return res.status(404).json({ error: "chapter_not_found" });
  for (const key of ["title", "structure", "povCharacterId", "draft"] as const) if (req.body[key] !== undefined) (chapter as any)[key] = String(req.body[key]);
  if (req.body.draft !== undefined) { chapter.wordCount = wordCount(chapter.draft); chapter.status = "draft"; chapter.review = undefined; }
  res.json(store.save(book));
});
app.post("/api/books/:id/chapters/:number/generate", async (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const chapter = chapterOf(book, req.params.number); if (!chapter) return res.status(404).json({ error: "chapter_not_found" });
  if (!previousCanonRequired(book, chapter.number)) return res.status(409).json({ error: "previous_chapters_not_canon", message: "Approve all previous chapters before generating this chapter." });
  try {
    chapter.draft = await agents.writeChapter(book, chapter.number); chapter.wordCount = wordCount(chapter.draft); chapter.generatedAt = new Date().toISOString(); chapter.status = "draft";
    chapter.review = await agents.reviewChapter(book, chapter.number, chapter.draft); chapter.status = chapter.review.verdict === "PASS" ? "reviewed" : "draft";
    store.save(book); res.json({ chapter, review: chapter.review });
  } catch (error) { res.status(500).json({ error: "generation_failed", message: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/books/:id/chapters/:number/review", async (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const chapter = chapterOf(book, req.params.number); if (!chapter) return res.status(404).json({ error: "chapter_not_found" });
  if (!chapter.draft.trim()) return res.status(409).json({ error: "empty_draft" });
  try { chapter.review = await agents.reviewChapter(book, chapter.number, chapter.draft); chapter.status = chapter.review.verdict === "PASS" ? "reviewed" : "draft"; res.json(store.save(book)); }
  catch (error) { res.status(500).json({ error: "review_failed", message: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/books/:id/chapters/:number/approve", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const chapter = chapterOf(book, req.params.number); if (!chapter) return res.status(404).json({ error: "chapter_not_found" });
  if (!chapter.review || chapter.review.verdict !== "PASS") return res.status(409).json({ error: "review_pass_required" });
  chapter.approvedText = chapter.draft; chapter.status = "canon"; chapter.approvedAt = new Date().toISOString(); chapter.wordCount = wordCount(chapter.approvedText);
  pushUnique(book.continuity.facts, chapter.review.continuityDelta); pushUnique(book.continuity.knowledgeState, chapter.review.knowledgeDelta); pushUnique(book.continuity.relationshipState, chapter.review.relationshipDelta);
  book.continuity.timeline.push(`Chapter ${chapter.number}: ${chapter.review.summary}`);
  if (book.chapters.every(ch => ch.status === "canon")) book.status = "complete"; else book.status = "production";
  res.json(store.save(book));
});
app.get("/api/books/:id/manuscript", (req, res) => {
  const book = store.get(req.params.id); if (!book) return res.status(404).json({ error: "book_not_found" });
  const text = book.chapters.filter(ch => ch.status === "canon").map(ch => `# ${ch.title}\n\n${ch.approvedText}`).join("\n\n---\n\n");
  res.type("text/markdown").send(`# ${book.title}\n\n${text}\n`);
});

function chapterOf(book: BookProject, value: string) { const number = Number(value); return Number.isInteger(number) ? book.chapters.find(ch => ch.number === number) : undefined; }
function pushUnique(target: string[], values: string[]) { for (const value of values) if (value && !target.includes(value)) target.push(value); }

app.get("/{*splat}", (req, res) => { if (!studioUser(req)) return res.redirect(302, "/login.html"); res.sendFile(path.join(publicDir, "index.html")); });
const port = Number(process.env.BOOK_STUDIO_PORT || 3210);
const host = process.env.BOOK_STUDIO_HOST || "127.0.0.1";
app.listen(port, host, () => console.log(`ZDX Book Studio listening on http://${host}:${port}`));
