import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { WebClient } from "@slack/web-api";
import type { Config } from "./config.js";
import type { Crypto } from "./crypto.js";
import type { Store } from "./store.js";

// ============================================================
// Linked accounts — the Google and Slack identities whose data
// the tools act on. Tokens are stored encrypted.
// ============================================================

export const GOOGLE_ACCOUNT_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose", // drafts; no send tool is exposed
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets"
];

export const SLACK_USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "search:read",
  "users:read",
  "users:read.email",
  "files:read"
];

export interface GoogleAccount {
  kind: "google";
  label: string;
  email: string;
  scopes: string;
  addedAt: string;
  secret: string; // encrypted { refresh_token }
}

export interface SlackTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // epoch ms
  scope: string;
}

export interface SlackAccount {
  kind: "slack";
  label: string;
  team: { id: string; name: string; domain?: string };
  user: { id: string; name?: string; email?: string };
  scopes: string;
  addedAt: string;
  secret: string; // encrypted SlackTokens
}

export type LinkedAccount = GoogleAccount | SlackAccount;

const COLLECTION = "accounts";

export class AccountError extends Error {}

export class Accounts {
  private googleClients = new Map<string, OAuth2Client>();

  constructor(private cfg: Config, private store: Store, private crypto: Crypto) {}

  // ---------- generic ----------

  async list(): Promise<LinkedAccount[]> {
    const rows = await this.store.list<LinkedAccount>(COLLECTION);
    return rows.map((r) => r.data).sort((a, b) => a.label.localeCompare(b.label));
  }

  async remove(id: string): Promise<void> {
    await this.store.delete(COLLECTION, id);
    this.googleClients.clear();
  }

  static idFor(a: LinkedAccount): string {
    return a.kind === "google" ? `google:${a.email}` : `slack:${a.team.id}`;
  }

  // ---------- Google ----------

  async saveGoogle(label: string, email: string, refreshToken: string, scopes: string): Promise<void> {
    const account: GoogleAccount = {
      kind: "google",
      label: label.toLowerCase(),
      email: email.toLowerCase(),
      scopes,
      addedAt: new Date().toISOString(),
      secret: this.crypto.encrypt({ refresh_token: refreshToken })
    };
    // A label must point at one account only.
    for (const existing of await this.googleAccounts()) {
      if (existing.label === account.label && existing.email !== account.email) {
        await this.store.delete(COLLECTION, Accounts.idFor(existing));
      }
    }
    await this.store.set(COLLECTION, Accounts.idFor(account), account);
    this.googleClients.delete(account.email);
  }

  async googleAccounts(): Promise<GoogleAccount[]> {
    return (await this.list()).filter((a): a is GoogleAccount => a.kind === "google");
  }

  /**
   * Resolve an account selector to Google accounts.
   * Accepts a label ("culture"), an email, a domain ("northsix.com" or "northsix"), or "all".
   */
  async resolveGoogle(selector: string, allowAll = false): Promise<GoogleAccount[]> {
    const accounts = await this.googleAccounts();
    if (accounts.length === 0) {
      throw new AccountError(`No Google accounts are linked. Link one at ${this.cfg.baseUrl}/admin`);
    }
    const s = selector.trim().toLowerCase();
    if (s === "all") {
      if (!allowAll) throw new AccountError(`This tool needs one specific account, not "all". Linked: ${describe(accounts)}`);
      return accounts;
    }
    const match = accounts.filter((a) => {
      const domain = a.email.split("@")[1] ?? "";
      return a.label === s || a.email === s || domain === s || domain.split(".")[0] === s;
    });
    if (match.length === 0) {
      throw new AccountError(`No linked Google account matches "${selector}". Linked: ${describe(accounts)}`);
    }
    if (match.length > 1 && !allowAll) {
      throw new AccountError(`"${selector}" matches more than one account; use the label or full email. Linked: ${describe(accounts)}`);
    }
    return match;
  }

  async resolveOneGoogle(selector: string): Promise<GoogleAccount> {
    return (await this.resolveGoogle(selector, false))[0]!;
  }

  googleAuth(account: GoogleAccount): OAuth2Client {
    let client = this.googleClients.get(account.email);
    if (!client) {
      const { refresh_token } = this.crypto.decrypt<{ refresh_token: string }>(account.secret);
      client = new google.auth.OAuth2(this.cfg.google.clientId, this.cfg.google.clientSecret);
      client.setCredentials({ refresh_token });
      this.googleClients.set(account.email, client);
    }
    return client;
  }

  // ---------- Slack ----------

  async saveSlack(acct: Omit<SlackAccount, "secret" | "addedAt" | "kind">, tokens: SlackTokens): Promise<void> {
    const account: SlackAccount = {
      kind: "slack",
      ...acct,
      addedAt: new Date().toISOString(),
      secret: this.crypto.encrypt(tokens)
    };
    await this.store.set(COLLECTION, Accounts.idFor(account), account);
  }

  async slackAccount(): Promise<SlackAccount> {
    const all = (await this.list()).filter((a): a is SlackAccount => a.kind === "slack");
    const pinned = all.find((a) => a.team.id === this.cfg.slack?.teamId);
    if (!pinned) {
      throw new AccountError(`The Hansberry Slack workspace is not linked. Link it at ${this.cfg.baseUrl}/admin`);
    }
    return pinned;
  }

  /** Returns a Slack WebClient, refreshing the user token first if Slack token rotation is on. */
  async slackClient(): Promise<WebClient> {
    const account = await this.slackAccount();
    let tokens = this.crypto.decrypt<SlackTokens>(account.secret);
    const fiveMin = 5 * 60 * 1000;
    if (tokens.refresh_token && tokens.expires_at && Date.now() > tokens.expires_at - fiveMin && this.cfg.slack) {
      const body = new URLSearchParams({
        client_id: this.cfg.slack.clientId,
        client_secret: this.cfg.slack.clientSecret,
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token
      });
      const res = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        authed_user?: { access_token?: string; refresh_token?: string; expires_in?: number };
      };
      const t = json.authed_user?.access_token ? json.authed_user : json;
      if (json.ok && t.access_token) {
        tokens = {
          access_token: t.access_token,
          refresh_token: t.refresh_token ?? tokens.refresh_token,
          expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
          scope: tokens.scope
        };
        await this.store.set(COLLECTION, Accounts.idFor(account), { ...account, secret: this.crypto.encrypt(tokens) });
      } else {
        console.error(`[slack] token refresh failed: ${json.error ?? "unknown"}`);
      }
    }
    return new WebClient(tokens.access_token);
  }
}

function describe(accounts: GoogleAccount[]): string {
  return accounts.map((a) => `${a.label} (${a.email})`).join(", ");
}
