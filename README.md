# ZDX Book Studio

Private manuscript-production console built on the ZDX 5-agent core.

The Studio owns book-specific state: canon, characters, POV assignments, chapter structures, continuity, review state, and manuscript assembly. It imports the existing ZDX Agent Team runtime at execution time rather than duplicating the model/provider layer.

## Production model

Each chapter is sequential and human-gated:

1. Manager receives the authoritative chapter packet.
2. The assigned POV writer produces the chapter.
3. The independent book reviewer checks canon, continuity, POV knowledge, voice, pacing, and originality risk notes.
4. A human approves the reviewed draft as Canon.
5. Only then can the next chapter be generated.

For CodeBound the intended rotation is Phreaker -> Hacker -> Crypto, repeated 14 times across 42 chapters.

## Run

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3210` for local-only development. For network exposure, put the service behind HTTPS and configure a seeded admin account with `BOOK_STUDIO_ADMIN_EMAIL` and `BOOK_STUDIO_ADMIN_PASSWORD`. The first login forces the temporary password to be changed.

The default core path points to the existing sibling `/home/zdxadmin/zdx-agent-team` installation. Provider credentials are loaded from the agent core `.env`; no keys are copied into this repository. Runtime manuscript data, authentication records, sessions, and `.env` files are excluded from Git.
