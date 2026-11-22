# CLAUDE.md

Hosted MCP connector for Claude (claude.ai web, desktop, iOS). One server exposes:
- Google Workspace for multiple linked accounts (labels `culture` = chris@cultureco.co, `northsix` = chris.vannoy@northsix.com): Gmail (search/read/**draft only**), Calendar (list/get/create/update, no delete), Drive (search/read), Docs (create/append/replace), Sheets (info/read/write/append/create).
- Hansberry Slack (read-only, user token), tool names `hansberry_*` kept from the old local server.

Personal Gmail (chris.vannoy@gmail.com) is **not** here; it uses Claude's built-in Google connector.

## Hard rules
- **No email send tool, ever.** gmail.compose scope technically allows sending; the code must never call `messages.send` or `drafts.send`.
- **No delete tools** (events, files, docs, sheets).
- Calendar writes default to `sendUpdates: "none"`; only send invites when the caller sets the flag.
- Never log or return tokens. Linked-account tokens are AES-256-GCM encrypted in Firestore; MCP tokens are stored as SHA-256 hashes only.
- Only `OWNER_EMAIL` may authorize Claude or use /admin. Client registration only accepts redirect hosts in `ALLOWED_CLIENT_REDIRECT_HOSTS`.

## Layout
```
src/main.ts              entry (listen)
src/app.ts               express app: OAuth router, /mcp (stateless Streamable HTTP), web router
src/oauth-provider.ts    OAuth 2.1 AS for Claude (DCR + PKCE); owner verified via Google sign-in
src/google-signin.ts     Google OAuth URLs + code exchange (owner login and account linking)
src/web.ts               /admin page, /oauth/google/callback, /oauth/slack/callback, session cookie, CSRF
src/accounts.ts          linked accounts, scopes, per-account Google/Slack clients, Slack token rotation
src/store.ts             Firestore (prod) / in-memory (tests) KV with TTL
src/crypto.ts            HKDF-derived enc + MAC keys from ENCRYPTION_KEY
src/tools/*.ts           MCP tools
test/flow.test.ts        end-to-end OAuth + MCP flow with Google stubbed
deploy/                  gcloud setup + deploy scripts; cloudbuild.yaml = auto-deploy on push to main
```

## Commands
```bash
npm test          # e2e flow tests (no network)
npm run build     # tsc -> dist/
./deploy/deploy.sh   # manual deploy (needs gcloud auth); pushes to main auto-deploy via Cloud Build
```

## Adding a Google scope
Add it to `GOOGLE_ACCOUNT_SCOPES` in `src/accounts.ts`, enable the API in `deploy/setup.sh`, deploy, then relink each account at `<BASE_URL>/admin`. The admin page flags accounts missing scopes.
