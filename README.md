# claude-connector

A private, hosted MCP connector that gives Claude (web, desktop, iOS) access to several work accounts at once:
Gmail, Calendar, Drive, Docs and Sheets for each linked Google account, plus the Hansberry Slack workspace.

- Runs on Google Cloud Run (scales to zero; normally within the free tier).
- Only the owner's Google account can connect it to Claude or manage linked accounts.
- Email is draft-only. No delete tools. Calendar invites are not emailed unless explicitly requested.

## Using it
1. In Claude: Settings → Connectors → Add custom connector → URL `https://claude-connector-366382691520.us-east1.run.app/mcp`.
2. Sign in with the owner Google account when prompted.
3. Link work accounts at `https://claude-connector-366382691520.us-east1.run.app/admin`.

## Operating it
- **Relink an account** (expired sign-in, new permissions): `/admin` → link again with the same label.
- **Logs**: Cloud Console → Cloud Run → claude-connector → Logs.
- **Deploys**: push to `main` (Cloud Build trigger) or run `./deploy/deploy.sh`.
- **Rotate a secret**: add a new version in Secret Manager, then redeploy.

See `CLAUDE.md` for the code layout and rules.
