import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Accounts } from "./accounts.js";
import type { Config } from "./config.js";
import { READ, guarded } from "./tools/common.js";
import { registerGmailTools } from "./tools/gmail.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerDriveDocsSheetsTools } from "./tools/drive-docs-sheets.js";
import { registerSlackTools } from "./tools/slack.js";

const INSTRUCTIONS = `Multi-account connector for Chris's work accounts.
Google tools take an "account" argument: a label such as "culture" (chris@cultureco.co) or "northsix"
(chris.vannoy@northsix.com), an email, or "all" where allowed. Call list_accounts if unsure.
Email: there is no send tool. gmail_create_draft only saves drafts for Chris to review and send.
Calendar: invitations are not emailed unless send_invites/send_updates is explicitly true.
Slack: hansberry_* tools read the Hansberry workspace only (read-only).
Personal Gmail (chris.vannoy@gmail.com) is NOT here; it uses Claude's built-in Google connector.`;

export function buildMcpServer(cfg: Config, accounts: Accounts): McpServer {
  const server = new McpServer({ name: "claude-connector", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const relinkUrl = `${cfg.baseUrl}/admin`;

  server.registerTool(
    "list_accounts",
    {
      title: "List linked accounts",
      description: "List every linked Google and Slack account with its label. Use the label as the 'account' argument.",
      inputSchema: {},
      annotations: READ
    },
    guarded(relinkUrl, async () => ({
      accounts: (await accounts.list()).map((a) =>
        a.kind === "google"
          ? { kind: "google", label: a.label, email: a.email, linked_at: a.addedAt }
          : { kind: "slack", label: a.label, workspace: a.team.name, user: a.user.name ?? a.user.id, linked_at: a.addedAt }
      ),
      manage_at: relinkUrl
    }))
  );

  registerGmailTools(server, accounts, relinkUrl);
  registerCalendarTools(server, accounts, relinkUrl);
  registerDriveDocsSheetsTools(server, accounts, relinkUrl);
  if (cfg.slack) registerSlackTools(server, accounts, relinkUrl);
  return server;
}
