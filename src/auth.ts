import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type StudioRole = "admin";
export type StudioUser = { email: string; role: StudioRole; mustChangePassword: boolean };
type UserRecord = StudioUser & { passwordSalt: string; passwordHash: string; createdAt: string; updatedAt: string };
type SessionRecord = { tokenHash: string; email: string; expiresAt: string; createdAt: string };
type AuthData = { users: UserRecord[]; sessions: SessionRecord[] };

const SESSION_HOURS = Math.max(1, Number(process.env.BOOK_STUDIO_SESSION_HOURS || 12));

export class AuthStore {
  constructor(private filePath = process.env.BOOK_STUDIO_AUTH_DATA || path.resolve("data/auth.json")) {}
  hasUsers() { return this.read().users.length > 0; }

  seedAdmin(email: string, password: string) {
    const normalized = normalizeEmail(email);
    if (!normalized || !password) throw new Error("BOOK_STUDIO_ADMIN_EMAIL and BOOK_STUDIO_ADMIN_PASSWORD are required");
    const data = this.read();
    if (data.users.some(user => user.email === normalized)) return;
    const now = new Date().toISOString();
    const { salt, hash } = hashPassword(password);
    data.users.push({ email: normalized, role: "admin", mustChangePassword: true, passwordSalt: salt, passwordHash: hash, createdAt: now, updatedAt: now });
    this.write(data);
  }

  login(email: string, password: string): { token: string; user: StudioUser } | null {
    const data = this.read(); this.prune(data);
    const user = data.users.find(item => item.email === normalizeEmail(email));
    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) { this.write(data); return null; }
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    data.sessions.push({ tokenHash: tokenDigest(token), email: user.email, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString() });
    this.write(data);
    return { token, user: publicUser(user) };
  }

  authenticate(token: string | undefined): StudioUser | null {
    if (!token) return null;
    const data = this.read(); this.prune(data);
    const session = data.sessions.find(item => safeEqual(item.tokenHash, tokenDigest(token)));
    if (!session) { this.write(data); return null; }
    const user = data.users.find(item => item.email === session.email);
    this.write(data);
    return user ? publicUser(user) : null;
  }

  logout(token: string | undefined) {
    if (!token) return;
    const data = this.read(); const digest = tokenDigest(token);
    data.sessions = data.sessions.filter(item => !safeEqual(item.tokenHash, digest));
    this.write(data);
  }

  changePassword(email: string, currentPassword: string, newPassword: string) {
    if (newPassword.length < 14) throw new Error("New password must be at least 14 characters");
    const data = this.read();
    const user = data.users.find(item => item.email === normalizeEmail(email));
    if (!user || !verifyPassword(currentPassword, user.passwordSalt, user.passwordHash)) return false;
    const { salt, hash } = hashPassword(newPassword);
    user.passwordSalt = salt; user.passwordHash = hash; user.mustChangePassword = false; user.updatedAt = new Date().toISOString();
    data.sessions = data.sessions.filter(item => item.email !== user.email);
    this.write(data); return true;
  }

  private prune(data: AuthData) { const now = Date.now(); data.sessions = data.sessions.filter(item => Date.parse(item.expiresAt) > now); }
  private read(): AuthData {
    if (!existsSync(this.filePath)) return { users: [], sessions: [] };
    try { const parsed = JSON.parse(readFileSync(this.filePath, "utf8")); return { users: Array.isArray(parsed?.users) ? parsed.users : [], sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [] }; }
    catch { return { users: [], sessions: [] }; }
  }
  private write(data: AuthData) {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.filePath);
  }
}

export function sessionTokenFromCookie(cookieHeader: string | undefined) {
  if (!cookieHeader) return undefined;
  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rest] = item.trim().split("=");
    if (rawName === "zdx_book_session") return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
export function sessionCookie(token: string, secure = true) { return `zdx_book_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`; }
export function expiredSessionCookie(secure = true) { return `zdx_book_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`; }
function normalizeEmail(value: string) { return String(value || "").trim().toLowerCase(); }
function tokenDigest(token: string) { return crypto.createHash("sha256").update(token).digest("hex"); }
function hashPassword(password: string) { const salt = crypto.randomBytes(16).toString("hex"); const hash = crypto.scryptSync(password, salt, 64).toString("hex"); return { salt, hash }; }
function verifyPassword(password: string, salt: string, expected: string) { try { return safeEqual(crypto.scryptSync(password, salt, 64).toString("hex"), expected); } catch { return false; } }
function safeEqual(a: string, b: string) { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); }
function publicUser(user: UserRecord): StudioUser { return { email: user.email, role: user.role, mustChangePassword: user.mustChangePassword }; }
