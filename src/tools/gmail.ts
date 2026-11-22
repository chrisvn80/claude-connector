import { google, type gmail_v1 } from "googleapis";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Accounts, GoogleAccount } from "../accounts.js";
import { ACCOUNT_DESC, ACCOUNT_OR_ALL_DESC, READ, WRITE_ADD, fanOut, guarded } from "./common.js";

// ============================================================
// Gmail — search, read, and create drafts. There is deliberately
// no send tool: drafts are reviewed and sent by the owner in Gmail.
// ============================================================

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decode(data?: string | null): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefer text/plain; fall back to stripped text/html. */
function bodyText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  const find = (p: gmail_v1.Schema$MessagePart, mime: string): string => {
    if (p.mimeType === mime && p.body?.data) return decode(p.body.data);
    for (const c of p.parts ?? []) {
      const t = find(c, mime);
      if (t) return t;
    }
    return "";
  };
  const plain = find(part, "text/plain");
  if (plain) return plain.trim();
  const html = find(part, "text/html");
  return html ? stripHtml(html) : decode(part.body?.data);
}

function attachments(part: gmail_v1.Schema$MessagePart | undefined): Array<{ filename: string; mimeType: string; size: number }> {
  const out: Array<{ filename: string; mimeType: string; size: number }> = [];
  const walk = (p?: gmail_v1.Schema$MessagePart) => {
    if (!p) return;
    if (p.filename) out.push({ filename: p.filename, mimeType: p.mimeType ?? "", size: p.body?.size ?? 0 });
    (p.parts ?? []).forEach(walk);
  };
  walk(part);
  return out;
}

function summarize(account: GoogleAccount, m: gmail_v1.Schema$Message, includeBody: boolean) {
  const h = m.payload?.headers;
  return {
    account: account.label,
    id: m.id,
    threadId: m.threadId,
    date: header(h, "date"),
    internalDate: Number(m.internalDate ?? 0),
    from: header(h, "from"),
    to: header(h, "to"),
    cc: header(h, "cc") || undefined,
    subject: header(h, "subject"),
    snippet: m.snippet,
    unread: (m.labelIds ?? []).includes("UNREAD"),
    labels: m.labelIds,
    body: includeBody ? bodyText(m.payload) : undefined,
    attachments: includeBody ? attachments(m.payload) : undefined
  };
}

/** RFC 2047 encode a header value if it contains non-ASCII. */
function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

export function registerGmailTools(server: McpServer, accounts: Accounts, relinkUrl: string) {
  const gmail = (a: GoogleAccount) => google.gmail({ version: "v1", auth: accounts.googleAuth(a) });

  server.registerTool(
    "gmail_search",
    {
      title: "Search Gmail",
      description: `Search one Gmail account or all linked accounts with Gmail search syntax
(e.g. "is:unread category:primary newer_than:2d", "from:oliver subject:WME", "has:attachment after:2026/11/01").
Results are merged across accounts, newest first. Set include_body=true to get full message text (costs more tokens);
otherwise you get headers + snippet and can call gmail_read_message / gmail_read_thread for detail.`,
      inputSchema: {
        account: z.string().default("all").describe(ACCOUNT_OR_ALL_DESC),
        query: z.string().default("").describe("Gmail search query"),
        max_results: z.number().int().min(1).max(100).default(20).describe("Per account"),
        include_body: z.boolean().default(false)
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, query, max_results, include_body }) => {
      const targets = await accounts.resolveGoogle(account, true);
      const { results, failed } = await fanOut(
        targets,
        (a) => a.label,
        async (a) => {
          const g = gmail(a);
          const list = await g.users.messages.list({ userId: "me", q: query, maxResults: max_results });
          const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);
          const msgs: ReturnType<typeof summarize>[] = [];
          for (let i = 0; i < ids.length; i += 10) {
            const batch = await Promise.all(
              ids.slice(i, i + 10).map((id) =>
                g.users.messages.get(
                  include_body
                    ? { userId: "me", id, format: "full" }
                    : { userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] }
                )
              )
            );
            batch.forEach((r) => msgs.push(summarize(a, r.data, include_body)));
          }
          return { messages: msgs, estimate: list.data.resultSizeEstimate ?? msgs.length };
        },
        relinkUrl
      );
      const messages = results.flatMap((r) => r.value.messages).sort((x, y) => y.internalDate - x.internalDate);
      return {
        accounts_searched: results.map((r) => r.account),
        accounts_failed: failed,
        total_returned: messages.length,
        messages
      };
    })
  );

  server.registerTool(
    "gmail_read_message",
    {
      title: "Read Gmail message",
      description: "Read one message in full (headers, plain-text body, attachment list).",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        message_id: z.string()
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, message_id }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await gmail(a).users.messages.get({ userId: "me", id: message_id, format: "full" });
      return summarize(a, r.data, true);
    })
  );

  server.registerTool(
    "gmail_read_thread",
    {
      title: "Read Gmail thread",
      description: "Read every message in a thread, oldest first.",
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        thread_id: z.string()
      },
      annotations: READ
    },
    guarded(relinkUrl, async ({ account, thread_id }) => {
      const a = await accounts.resolveOneGoogle(account);
      const r = await gmail(a).users.threads.get({ userId: "me", id: thread_id, format: "full" });
      const messages = (r.data.messages ?? []).map((m) => summarize(a, m, true));
      return { account: a.label, threadId: r.data.id, subject: messages[0]?.subject, messages };
    })
  );

  server.registerTool(
    "gmail_create_draft",
    {
      title: "Create Gmail draft",
      description: `Create a DRAFT in the given account. Nothing is sent: the owner reviews and sends it in Gmail.
To draft a reply, pass reply_to_message_id; the draft joins that thread with correct reply headers,
and "to"/"subject" default to the original sender and "Re: <subject>".`,
      inputSchema: {
        account: z.string().describe(ACCOUNT_DESC),
        to: z.array(z.string()).default([]).describe("Recipient addresses"),
        cc: z.array(z.string()).default([]),
        bcc: z.array(z.string()).default([]),
        subject: z.string().optional(),
        body: z.string().describe("Plain-text body"),
        reply_to_message_id: z.string().optional()
      },
      annotations: WRITE_ADD
    },
    guarded(relinkUrl, async ({ account, to, cc, bcc, subject, body, reply_to_message_id }) => {
      const a = await accounts.resolveOneGoogle(account);
      const g = gmail(a);
      let threadId: string | undefined;
      const extra: string[] = [];
      let toList = to;
      let subj = subject ?? "";

      if (reply_to_message_id) {
        const orig = await g.users.messages.get({
          userId: "me",
          id: reply_to_message_id,
          format: "metadata",
          metadataHeaders: ["From", "Reply-To", "Subject", "Message-ID", "References"]
        });
        const h = orig.data.payload?.headers;
        threadId = orig.data.threadId ?? undefined;
        const msgId = header(h, "message-id");
        if (msgId) {
          extra.push(`In-Reply-To: ${msgId}`);
          extra.push(`References: ${[header(h, "references"), msgId].filter(Boolean).join(" ")}`);
        }
        if (toList.length === 0) toList = [header(h, "reply-to") || header(h, "from")];
        if (!subject) {
          const s = header(h, "subject");
          subj = /^re:/i.test(s) ? s : `Re: ${s}`;
        }
      }
      if (toList.length === 0) throw new Error("Provide at least one recipient in 'to' (or reply_to_message_id).");

      const headers = [
        `From: ${a.email}`,
        `To: ${toList.join(", ")}`,
        cc.length ? `Cc: ${cc.join(", ")}` : null,
        bcc.length ? `Bcc: ${bcc.join(", ")}` : null,
        `Subject: ${encodeHeader(subj)}`,
        ...extra,
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64"
      ].filter((l): l is string => l !== null);
      const encodedBody = Buffer.from(body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
      const mime = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
      const raw = Buffer.from(mime, "utf8").toString("base64url");

      const r = await g.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId } } });
      return {
        account: a.label,
        draft_id: r.data.id,
        message_id: r.data.message?.id,
        thread_id: r.data.message?.threadId,
        to: toList,
        subject: subj,
        note: "Draft saved. It has NOT been sent — review and send it from Gmail.",
        open_in_gmail: `https://mail.google.com/mail/u/${encodeURIComponent(a.email)}/#drafts`
      };
    })
  );
}
