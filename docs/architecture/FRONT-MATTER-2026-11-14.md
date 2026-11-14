# Book Studio — Tenant Author Profiles and Manuscript Pages (2026-11-14)

## Scope
Adds final-manuscript configuration for future books only. Does not edit published files or existing manuscript content.

## Features
- A private library of reusable Author Profiles per signed-in account (email is the current Book Studio tenant boundary), each with label, byline, bio, optional website, and public contact email.
- Manuscript tab selector: no author page, or one saved profile. Create/edit/delete profile controls. Profiles selected by an existing book cannot be deleted until unassigned.
- Per-book copyright mode: off, editable default template (year + holder; falls back to selected author byline), or fully custom text.
- Per-book dedication mode: off, default "Dedicated to [name]." with a fill-in name, or fully custom text. If the default name is blank, the dedication is omitted.
- Optional preface and acknowledgments text fields.
- Export ordering: book title/byline, copyright, dedication, preface, canon chapters, acknowledgments, about the selected author.

## Storage and security
- New author_profiles table in the existing SQLite database. Each query/mutation filters on the session-derived owner email. No customer profile input can override the owner.
- The per-book frontMatter JSON is saved in its existing books.metadata; no chapter rows or canonical text are rewritten.
- New API: GET /api/author-profiles, POST /api/author-profiles, PUT /api/author-profiles/:profileId, DELETE /api/author-profiles/:profileId, PUT /api/books/:id/front-matter.
- Existing book-owner middleware protects the per-book route. A profile may only be selected on a book with the same owner.
- The server resolves selected profiles at export time, verifying ownership again. Missing/cross-tenant profiles fail closed.
- The final Markdown output includes only approved (canon) chapter prose; draft text and private character knowledge are omitted.
- Legacy books without frontMatter preserve the original manuscript output.
- Author profile changes affect future exports; they do not mutate previously downloaded files.

## Release and migration
- The SQLite migration is additive (CREATE TABLE IF NOT EXISTS) but must not be executed against production before verifying and backing up the live DB (including WAL using SQLite online backup).
- Use the canonical repository (zeroday31337x/zdx-book-studio), not legacy zdx-books.
- Production is a non-Git working tree with possible unpublished drift. Do not blindly copy or overwrite live files; reconcile against active code and perform a staged deployment and rollback test.
- Run npm run build, node --check public/app.js, and npm test in an isolated working tree.
