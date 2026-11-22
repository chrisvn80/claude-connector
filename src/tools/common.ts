import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CHARACTER_LIMIT } from "../config.js";
import { AccountError } from "../accounts.js";

// ============================================================
// Shared tool helpers: result formatting and friendly errors.
// ============================================================

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
export const WRITE_ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const WRITE_CHANGE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

export function ok(result: unknown): CallToolResult {
  let text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    text =
      text.slice(0, CHARACTER_LIMIT) +
      `\n\n[Truncated at ${CHARACTER_LIMIT} characters. Narrow the query, lower max_results, or page.]`;
  }
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function friendlyError(err: unknown, relinkUrl: string): string {
  if (err instanceof AccountError) return err.message;
  const e = err as {
    message?: string;
    status?: number;
    code?: number | string;
    response?: { status?: number; data?: { error?: string | { message?: string; status?: string } } };
    data?: { error?: string };
  };
  const status = e.response?.status ?? e.status ?? (typeof e.code === "number" ? e.code : undefined);
  const dataErr = e.response?.data?.error;
  const detail = typeof dataErr === "string" ? dataErr : dataErr?.message ?? e.message ?? String(err);

  if (detail.includes("invalid_grant") || detail.includes("token_revoked") || detail.includes("invalid_auth")) {
    return `The account's sign-in has expired or was revoked (${detail}). Relink it at ${relinkUrl}`;
  }
  if (status === 403 && /insufficient|scope|permission/i.test(detail)) {
    return `Permission missing for this action (${detail}). Relink the account at ${relinkUrl} and leave every permission box checked. If it keeps failing, the Workspace admin may be blocking this access.`;
  }
  if (status === 404) return `Not found (${detail}). Check the ID and that it belongs to this account.`;
  if (status === 429 || detail.includes("ratelimited")) return `Rate limited by the provider (${detail}). Retry shortly.`;
  if (detail.includes("missing_scope")) return `Slack token is missing a scope (${detail}). Relink Hansberry at ${relinkUrl}`;
  if (detail.includes("not_in_channel") || detail.includes("channel_not_found")) {
    return `${detail} — only conversations the connected Hansberry user can already see are readable.`;
  }
  return `Error: ${detail}`;
}

export type Handler<A> = (args: A) => Promise<unknown>;

export function guarded<A>(relinkUrl: string, fn: Handler<A>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (!(err instanceof AccountError)) console.error("[tool error]", err);
      return fail(friendlyError(err, relinkUrl));
    }
  };
}

/** Run fn for each item in parallel; collect successes and per-item failures. */
export async function fanOut<T, R>(
  items: T[],
  key: (t: T) => string,
  fn: (t: T) => Promise<R>,
  relinkUrl: string
): Promise<{ results: Array<{ account: string; value: R }>; failed: Array<{ account: string; error: string }> }> {
  const settled = await Promise.allSettled(items.map(fn));
  const results: Array<{ account: string; value: R }> = [];
  const failed: Array<{ account: string; error: string }> = [];
  settled.forEach((s, i) => {
    const account = key(items[i]!);
    if (s.status === "fulfilled") results.push({ account, value: s.value });
    else failed.push({ account, error: friendlyError(s.reason, relinkUrl) });
  });
  return { results, failed };
}

export const ACCOUNT_DESC =
  'Which Google account: its label (e.g. "culture", "northsix"), its email, or its domain. Use list_accounts to see options.';
export const ACCOUNT_OR_ALL_DESC = ACCOUNT_DESC.replace("Which Google account:", 'Which Google account, or "all" for every linked account:');
