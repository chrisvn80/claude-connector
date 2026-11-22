import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Accounts } from "../accounts.js";
import { READ, guarded } from "./common.js";

// ============================================================
// Hansberry Slack — read-only, user token. Ported from the local
// hansberry-slack-mcp-server; tool names kept so /sweep keeps working.
// ============================================================

export function registerSlackTools(server: McpServer, accounts: Accounts, relinkUrl: string) {
  const g = <A>(fn: (args: A) => Promise<unknown>) => guarded<A>(relinkUrl, fn);

  server.registerTool(
    "hansberry_status",
    {
      title: "Hansberry Slack connection status",
      description: "Whether the Hansberry Slack workspace is linked, as which user, and with which scopes. Never returns tokens.",
      inputSchema: {},
      annotations: READ
    },
    g(async () => {
      try {
        const a = await accounts.slackAccount();
        return { connected: true, team: a.team, user: a.user, scopes: a.scopes.split(","), connected_at: a.addedAt };
      } catch (err) {
        return { connected: false, detail: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  server.registerTool(
    "hansberry_search_messages",
    {
      title: "Search Hansberry messages",
      description: `Search Hansberry Slack with Slack search syntax, e.g. "from:@alice budget", "in:#general has:link",
"invoice after:2026-11-01". Only returns what the connected Hansberry user can see.`,
      inputSchema: {
        query: z.string().min(1),
        count: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
        sort: z.enum(["score", "timestamp"]).default("score"),
        sort_dir: z.enum(["asc", "desc"]).default("desc")
      },
      annotations: READ
    },
    g(async ({ query, count, page, sort, sort_dir }) => {
      const c = await accounts.slackClient();
      const r = await c.search.messages({ query, count, page, sort, sort_dir });
      const matches = r.messages?.matches ?? [];
      return {
        total: r.messages?.total ?? matches.length,
        page: r.messages?.paging?.page ?? page,
        pages: r.messages?.paging?.pages ?? 1,
        matches: matches.map((m) => ({
          channel: { id: m.channel?.id, name: m.channel?.name },
          user: m.user,
          username: m.username,
          ts: m.ts,
          text: m.text,
          permalink: m.permalink
        }))
      };
    })
  );

  server.registerTool(
    "hansberry_conversation_history",
    {
      title: "Read Hansberry conversation history",
      description: `Messages from a channel, private channel, DM or group DM (newest first).
Get IDs from hansberry_list_channels / hansberry_list_dms. oldest/latest are Slack timestamps (e.g. "1763700000").
Use hansberry_read_thread for replies to a message that has reply_count > 0.`,
      inputSchema: {
        channel: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(20),
        cursor: z.string().optional(),
        oldest: z.string().optional(),
        latest: z.string().optional()
      },
      annotations: READ
    },
    g(async ({ channel, limit, cursor, oldest, latest }) => {
      const c = await accounts.slackClient();
      const r = await c.conversations.history({ channel, limit, cursor, oldest, latest });
      return {
        messages: (r.messages ?? []).map((m) => ({
          ts: m.ts,
          user: m.user,
          text: m.text,
          thread_ts: m.thread_ts,
          reply_count: m.reply_count,
          files: (m.files ?? []).map((f) => ({ id: f.id, name: f.name, mimetype: f.mimetype }))
        })),
        has_more: r.has_more ?? false,
        next_cursor: r.response_metadata?.next_cursor || undefined
      };
    })
  );

  server.registerTool(
    "hansberry_read_thread",
    {
      title: "Read Hansberry thread replies",
      description: "Read a message and all its thread replies, given the channel ID and the parent message ts.",
      inputSchema: {
        channel: z.string().min(1),
        thread_ts: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100)
      },
      annotations: READ
    },
    g(async ({ channel, thread_ts, limit }) => {
      const c = await accounts.slackClient();
      const r = await c.conversations.replies({ channel, ts: thread_ts, limit });
      return {
        messages: (r.messages ?? []).map((m) => ({ ts: m.ts, user: m.user, text: m.text })),
        has_more: r.has_more ?? false
      };
    })
  );

  server.registerTool(
    "hansberry_list_channels",
    {
      title: "List Hansberry channels",
      description: "Public and private channels visible to the connected user, with IDs, membership, topic and purpose.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
        exclude_archived: z.boolean().default(true)
      },
      annotations: READ
    },
    g(async ({ limit, cursor, exclude_archived }) => {
      const c = await accounts.slackClient();
      const r = await c.conversations.list({ types: "public_channel,private_channel", limit, cursor, exclude_archived });
      return {
        channels: (r.channels ?? []).map((ch) => ({
          id: ch.id,
          name: ch.name,
          is_private: ch.is_private ?? false,
          is_member: ch.is_member ?? false,
          is_archived: ch.is_archived ?? false,
          topic: ch.topic?.value ?? "",
          purpose: ch.purpose?.value ?? "",
          num_members: ch.num_members
        })),
        next_cursor: r.response_metadata?.next_cursor || undefined
      };
    })
  );

  server.registerTool(
    "hansberry_list_dms",
    {
      title: "List Hansberry DMs and group DMs",
      description: "DM and group-DM conversations visible to the connected user; 1:1 DMs include the other person's name.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        cursor: z.string().optional()
      },
      annotations: READ
    },
    g(async ({ limit, cursor }) => {
      const c = await accounts.slackClient();
      const r = await c.conversations.list({ types: "im,mpim", limit, cursor });
      const conversations = await Promise.all(
        (r.channels ?? []).map(async (ch) => {
          if (ch.is_im && ch.user) {
            try {
              const u = await c.users.info({ user: ch.user });
              return {
                id: ch.id,
                type: "im",
                with_user: { id: ch.user, name: u.user?.real_name ?? u.user?.name, email: u.user?.profile?.email }
              };
            } catch {
              return { id: ch.id, type: "im", with_user: { id: ch.user } };
            }
          }
          return { id: ch.id, type: "mpim", name: ch.name, num_members: ch.num_members };
        })
      );
      return { conversations, next_cursor: r.response_metadata?.next_cursor || undefined };
    })
  );

  server.registerTool(
    "hansberry_user_info",
    {
      title: "Look up Hansberry user",
      description: "Profile for one Slack user ID (name, email, title).",
      inputSchema: { user: z.string().min(1) },
      annotations: READ
    },
    g(async ({ user }) => {
      const c = await accounts.slackClient();
      const u = (await c.users.info({ user })).user;
      return {
        id: u?.id,
        name: u?.name,
        real_name: u?.real_name,
        email: u?.profile?.email,
        title: u?.profile?.title,
        is_bot: u?.is_bot ?? false,
        deleted: u?.deleted ?? false
      };
    })
  );

  server.registerTool(
    "hansberry_list_users",
    {
      title: "List Hansberry members",
      description: "Active members of the Hansberry workspace with IDs, names and emails.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(200),
        cursor: z.string().optional()
      },
      annotations: READ
    },
    g(async ({ limit, cursor }) => {
      const c = await accounts.slackClient();
      const r = await c.users.list({ limit, cursor });
      return {
        members: (r.members ?? [])
          .filter((m) => !m.deleted)
          .map((m) => ({ id: m.id, name: m.name, real_name: m.real_name, email: m.profile?.email, is_bot: m.is_bot ?? false })),
        next_cursor: r.response_metadata?.next_cursor || undefined
      };
    })
  );

  server.registerTool(
    "hansberry_file_info",
    {
      title: "Hansberry file metadata",
      description: "Metadata (not contents) for a Slack file ID: name, type, size, uploader, permalink.",
      inputSchema: { file: z.string().min(1) },
      annotations: READ
    },
    g(async ({ file }) => {
      const c = await accounts.slackClient();
      const f = (await c.files.info({ file })).file;
      return {
        id: f?.id,
        name: f?.name,
        title: f?.title,
        mimetype: f?.mimetype,
        size: f?.size,
        user: f?.user,
        created: f?.created,
        permalink: f?.permalink
      };
    })
  );
}
