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
- **Deploys**: every push to `main` builds and deploys automatically (Cloud Build trigger `claude-connector-main`, us-east1, ~3 min). `./deploy/deploy.sh` is the manual path and the only way to change env vars or secrets.
- **Cost guard**: $5/month budget alert on the billing account; Artifact Registry keeps the 3 newest images.
- **Rotate a secret**: add a new version in Secret Manager, then redeploy.

See `CLAUDE.md` for the code layout and rules.
