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
import { syncCanonChapters, writeCanonChapter } from "./manuscript.js";

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });
const app = express();
const store = new BookStore();
const agents = new BookAgentService();
const auth = new AuthStore();
syncCanonChapters(store.list());
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const adminEmail = process.env.BOOK_STUDIO_ADMIN_EMAIL || "";
const adminPassword = process.env.BOOK_STUDIO_ADMIN_PASSWORD || "";
if (adminEmail && adminPassword) auth.seedAdmin(adminEmail, adminPassword);
// Cognito is the production identity provider; local records remain for explicit migration.

app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));
app.use(express.static(publicDir, { index: false }));

const cognitoIssuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_NeJS2Eu71";
const cognitoDomain = "https://zdx-core-166044977986.auth.us-east-1.amazoncognito.com";
const bookClientId = process.env.BOOK_COGNITO_CLIENT_ID || "";
const bookCallback = "https://studio.zerodrivex.com/api/auth/oidc/callback";
const oidcCookieName = "zdx_book_oidc_flow";

function oidcSecret() { return process.env.ZDX_OIDC_SECRET || process.env.JWT_SECRET || ""; }
function signedFlow(payload: Record<string, string>) {
  const raw = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 5 * 60_000 })).toString("base64url");
  const signature = crypto.createHmac("sha256", oidcSecret()).update(raw).digest("base64url");
  return raw + "." + signature;
}
function readFlow(value: string | undefined): Record<string, string> | null {
  if (!value || !oidcSecret()) return null;
  const [raw, signature] = value.split(".");
  if (!raw || !signature) return null;
  const expected = crypto.createHmac("sha256", oidcSecret()).update(raw).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return parsed && parsed.exp > Date.now() ? parsed : null;
  } catch { return null; }
}
function cookieValue(req: express.Request, name: string) {
  const header = req.header("cookie") || "";
  const item = header.split(";").map(value => value.trim()).find(value => value.startsWith(name + "="));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : undefined;
}
async function verifyCognitoIdToken(token: string, nonce: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token");
  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("invalid_token_header");
  const response = await fetch(cognitoIssuer + "/.well-known/jwks.json", { signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (!response.ok) throw new Error("jwks_unavailable");
  const jwks = await response.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string }> };
  const jwk = jwks.keys?.find(key => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new Error("unknown_signing_key");
  const key = crypto.createPublicKey({ key: jwk as any, format: "jwk" });
  const valid = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2]!, "base64url"));
  if (!valid || claims.iss !== cognitoIssuer || claims.aud !== bookClientId || claims.token_use !== "id" ||
      claims.nonce !== nonce || typeof claims.sub !== "string" || typeof claims.email !== "string" ||
      !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("invalid_identity");
  }
  return claims as { sub: string; email: string; email_verified?: boolean; ["cognito:groups"]?: string[] };
}


function requestSecure(req: express.Request) {
  if (process.env.BOOK_STUDIO_COOKIE_SECURE === "1") return true;
  return req.secure || req.header("x-forwarded-proto") === "https";
}

function studioUser(req: express.Request) {
  return auth.authenticate(sessionTokenFromCookie(req.header("cookie")));
}

// Attach the authenticated local session to every non-static request. API handlers
// rely on this property; without it the UI receives { user: undefined } after OIDC.
app.use((req, _res, next) => {
  (req as any).studioUser = studioUser(req);
  next();
});

app.get("/api/auth/oidc/start", (req, res) => {
  if (req.header("host") !== "studio.zerodrivex.com" || req.header("x-forwarded-proto") !== "https") return res.status(400).json({ error: "invalid_origin" });
  if (!bookClientId || !oidcSecret() || Buffer.byteLength(oidcSecret(), "utf8") < 32) return res.status(503).json({ error: "oidc_not_configured" });
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const flow = signedFlow({ verifier, state, nonce });
  const url = new URL("/oauth2/authorize", cognitoDomain);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", bookClientId);
  url.searchParams.set("redirect_uri", bookCallback);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  res.setHeader("Set-Cookie", oidcCookieName + "=" + encodeURIComponent(flow) + "; Path=/api/auth/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=300");
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, url.toString());
});

app.get("/api/auth/oidc/callback", async (req, res) => {
  if (req.header("host") !== "studio.zerodrivex.com" || req.header("x-forwarded-proto") !== "https") return res.status(400).json({ error: "invalid_origin" });
  if (!bookClientId || !oidcSecret() || Buffer.byteLength(oidcSecret(), "utf8") < 32) return res.status(503).json({ error: "oidc_not_configured" });
  const flow = readFlow(cookieValue(req, oidcCookieName));
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const clearFlow = oidcCookieName + "=; Path=/api/auth/oidc; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  if (!flow || !code || code.length > 4096 || !state || flow.state !== state) return res.status(400).setHeader("Set-Cookie", clearFlow).json({ error: "invalid_oidc_flow" });
  try {
    const upstream = await fetch(cognitoDomain + "/oauth2/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: bookClientId, code, redirect_uri: bookCallback, code_verifier: flow.verifier }),
      signal: AbortSignal.timeout(10000), cache: "no-store",
    });
    if (!upstream.ok) return res.status(401).setHeader("Set-Cookie", clearFlow).json({ error: "token_exchange_failed" });
    const tokens = await upstream.json() as { id_token?: string };
    if (!tokens.id_token) return res.status(401).setHeader("Set-Cookie", clearFlow).json({ error: "missing_id_token" });
    const identity = await verifyCognitoIdToken(tokens.id_token, flow.nonce);
    const groups = Array.isArray(identity["cognito:groups"]) ? identity["cognito:groups"] : [];
    if (!groups.includes("zdx-admin") && !groups.includes("zdx-bookstudio")) return res.status(403).setHeader("Set-Cookie", clearFlow).json({ error: "product_access_denied" });
    const adminEmailExpected = process.env.ZDX_COGNITO_ADMIN_EMAIL?.trim().toLowerCase();
    const adminSubExpected = process.env.ZDX_COGNITO_ADMIN_SUB;
    const bootstrapAdmin = Boolean(adminEmailExpected && adminSubExpected && identity.email.toLowerCase() === adminEmailExpected && identity.sub === adminSubExpected && groups.includes("zdx-admin"));
    if (identity.email_verified !== true && !bootstrapAdmin) return res.status(403).setHeader("Set-Cookie", clearFlow).json({ error: "email_not_verified" });
    const studioRole = groups.includes("zdx-admin") ? "admin" : "writer";
    const session = auth.loginCognito(identity.sub, identity.email, studioRole, bootstrapAdmin);
    if (!session) return res.status(403).setHeader("Set-Cookie", clearFlow).json({ error: "account_requires_explicit_migration" });
    res.append("Set-Cookie", sessionCookie(session.token, true));
    res.append("Set-Cookie", clearFlow);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, "/");
  } catch (error) {
    console.error("[BOOK_STUDIO_OIDC]", error instanceof Error ? error.name : "unknown");
    return res.status(401).setHeader("Set-Cookie", clearFlow).json({ error: "oidc_login_failed" });
  }
});

app.post("/api/auth/login", (_req, res) => res.status(410).json({ error: "cognito_required", loginUrl: "/api/auth/oidc/start" }));

app.get("/api/auth/me", (req, res) => {
  const user = studioUser(req);
  if (!user) return res.status(401).json({ user: null, error: "authentication_required" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ user });
});

app.post("/api/auth/logout", (req, res) => {
  auth.logout(sessionTokenFromCookie(req.header("cookie")));
  res.setHeader("Set-Cookie", expiredSessionCookie(requestSecure(req)));
  res.json({ ok: true });
});

app.post("/api/auth/change-password", (_req, res) => res.status(410).json({ error: "cognito_managed_password", message: "Change your password through ZeroDriveX sign-in." }));

app.use("/api", (req, res, next) => {
  const user = (req as any).studioUser;
  if (!user) return res.status(401).json({ error: "authentication_required" });
  next();
});

app.get("/admin", (req, res) => {
  const user = studioUser(req);
  if (!user) return res.redirect(302, "/login.html");
  if (user.role !== "admin") return res.redirect(302, "/");
  if (user.mustChangePassword) return res.redirect(302, "/login.html");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(publicDir, "admin.html"));
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
app.get("/api/admin/overview", async (req, res) => {
  const user = (req as any).studioUser;
  if (!user || user.role !== "admin") return res.status(403).json({ error: "admin_required" });
  const books = store.list();
  let inference: { status: string; activeModel?: string | null } = { status: "unavailable" };
  try {
    const provider = await agents.providerState();
    inference = { status: provider.activeProvider ? "ready" : "unavailable", activeModel: provider.activeModel };
  } catch { /* Admin dashboard remains usable if model introspection fails. */ }
  const overviewBooks = books.map(book => ({
    id: book.id, title: book.title, status: book.status, updatedAt: book.updatedAt,
    chapterCount: book.chapterCount,
    canonChapters: book.chapters.filter(chapter => chapter.status === "canon").length,
  }));
  res.setHeader("Cache-Control", "no-store");
  res.json({
    generatedAt: new Date().toISOString(),
    summary: {
      totalBooks: books.length,
      activeBooks: books.filter(book => book.status !== "complete").length,
      completedBooks: books.filter(book => book.status === "complete").length,
      canonChapters: overviewBooks.reduce((total, book) => total + book.canonChapters, 0),
    },
    inference, books: overviewBooks,
  });
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
    store.save(book);
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
  try { writeCanonChapter(book, chapter); res.json(store.save(book)); }
  catch (error) { res.status(500).json({ error: "canon_file_write_failed", message: error instanceof Error ? error.message : String(error) }); }
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

[executed on device: ubuntu-8gb-hel1-1 (5253a8e3-d739-4485-be9e-dd4d2e9b4eec)]