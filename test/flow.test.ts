import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// End-to-end test of the OAuth + MCP flow with Google stubbed out.

process.env.BASE_URL = "http://127.0.0.1:0"; // replaced below once the port is known
process.env.OWNER_EMAIL = "owner@example.com";
process.env.STORE_BACKEND = "memory";
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.SLACK_CLIENT_ID = "s-id";
process.env.SLACK_CLIENT_SECRET = "s-secret";
process.env.SLACK_TEAM_ID = "T0BPCMDASUR";

const PORT = 18000 + Math.floor(Math.random() * 1000);
process.env.BASE_URL = `http://127.0.0.1:${PORT}`;
const BASE = process.env.BASE_URL;

// code -> identity returned by the fake Google
const fakeIdentities: Record<string, { email: string; refreshToken?: string; scope?: string }> = {
  owner: { email: "owner@example.com" },
  intruder: { email: "someone@else.com" },
  work: { email: "chris@cultureco.co", refreshToken: "rt-work", scope: "openid email https://www.googleapis.com/auth/gmail.readonly" }
};

const fakeGoogle = {
  redirectUri: `${BASE}/oauth/google/callback`,
  ownerSignInUrl: (state: string) => `https://accounts.google.test/owner?state=${state}`,
  linkAccountUrl: (state: string) => `https://accounts.google.test/link?state=${state}`,
  exchange: async (code: string) => {
    const id = fakeIdentities[code];
    if (!id) throw new Error("bad code");
    return { email: id.email, emailVerified: true, refreshToken: id.refreshToken, scope: id.scope ?? "openid email" };
  }
};

let server: Server;

before(async () => {
  const { createApp } = await import("../src/app.js");
  const { app } = createApp({ google: fakeGoogle as never });
  await new Promise<void>((resolve) => {
    server = app.listen(PORT, "127.0.0.1", () => resolve());
  });
  assert.equal((server.address() as AddressInfo).port, PORT);
});

after(() => server.close());

const noFollow = { redirect: "manual" as const };
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

async function register(redirect = CLAUDE_CB) {
  return fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect],
      client_name: "Claude",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post"
    })
  });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function authorizeAs(clientId: string, challenge: string, googleCode: string) {
  const u = new URL(`${BASE}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", CLAUDE_CB);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", "claude-state-123");
  u.searchParams.set("resource", `${BASE}/mcp`);
  const r1 = await fetch(u, noFollow);
  assert.equal(r1.status, 302, "authorize should redirect to Google");
  const googleUrl = new URL(r1.headers.get("location")!);
  assert.equal(googleUrl.host, "accounts.google.test");
  const state = googleUrl.searchParams.get("state")!;
  const r2 = await fetch(`${BASE}/oauth/google/callback?code=${googleCode}&state=${state}`, noFollow);
  assert.equal(r2.status, 302);
  return new URL(r2.headers.get("location")!);
}

async function mcp(token: string, method: string, params: unknown = {}, id = 1) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  return { status: r.status, body: (await r.json()) as any };
}

let client: { client_id: string; client_secret: string };
let tokens: { access_token: string; refresh_token: string };

test("discovery metadata is published", async () => {
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json() as any;
  assert.equal(as.authorization_endpoint, `${BASE}/authorize`);
  assert.equal(as.registration_endpoint, `${BASE}/register`);
  const pr = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json() as any;
  assert.equal(pr.resource, `${BASE}/mcp`);
});

test("MCP without a token is refused with a discovery hint", async () => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
});

test("client registration rejects non-Claude redirect hosts", async () => {
  const bad = await register("https://evil.example.com/cb");
  assert.equal(bad.status, 400);
  const good = await register();
  assert.equal(good.status, 201);
  client = (await good.json()) as any;
  assert.ok(client.client_id && client.client_secret);
});

test("a non-owner Google login is denied", async () => {
  const { challenge } = pkce();
  const back = await authorizeAs(client.client_id, challenge, "intruder");
  assert.equal(back.origin + back.pathname, CLAUDE_CB);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.get("code"), null);
});

test("owner login yields tokens via PKCE", async () => {
  const { verifier, challenge } = pkce();
  const back = await authorizeAs(client.client_id, challenge, "owner");
  assert.equal(back.searchParams.get("state"), "claude-state-123");
  const code = back.searchParams.get("code")!;
  assert.ok(code);

  // wrong verifier fails
  const badTok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: "wrong".padEnd(43, "x"),
      redirect_uri: CLAUDE_CB, client_id: client.client_id, client_secret: client.client_secret
    })
  });
  assert.equal(badTok.status, 400);

  const tok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: CLAUDE_CB, client_id: client.client_id, client_secret: client.client_secret,
      resource: `${BASE}/mcp`
    })
  });
  assert.equal(tok.status, 200, await tok.clone().text());
  tokens = (await tok.json()) as any;
  assert.ok(tokens.access_token && tokens.refresh_token);

  // code is single-use
  const reuse = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code, code_verifier: verifier,
      redirect_uri: CLAUDE_CB, client_id: client.client_id, client_secret: client.client_secret
    })
  });
  assert.equal(reuse.status, 400);
});

test("MCP initialize + tools/list works and exposes no send tool", async () => {
  const init = await mcp(tokens.access_token, "initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" }
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, "claude-connector");

  const list = await mcp(tokens.access_token, "tools/list", {}, 2);
  const names: string[] = list.body.result.tools.map((t: any) => t.name);
  for (const n of [
    "list_accounts", "gmail_search", "gmail_read_message", "gmail_read_thread", "gmail_create_draft",
    "calendar_list_events", "calendar_create_event", "calendar_update_event", "drive_search", "drive_read_file",
    "docs_create", "docs_append_text", "docs_replace_text", "sheets_read_range", "sheets_write_range",
    "sheets_append_rows", "sheets_create", "hansberry_search_messages", "hansberry_conversation_history"
  ]) assert.ok(names.includes(n), `missing tool ${n}`);
  assert.ok(!names.some((n) => /send/.test(n) && n.startsWith("gmail")), "no gmail send tool");
  assert.ok(!names.some((n) => /delete/.test(n)), "no delete tools");
  console.log(`  ${names.length} tools: ${names.join(", ")}`);
});

test("tools report clearly when nothing is linked", async () => {
  const r = await mcp(tokens.access_token, "tools/call", { name: "gmail_search", arguments: { account: "all", query: "is:unread" } }, 3);
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /No Google accounts are linked/);
  const s = await mcp(tokens.access_token, "tools/call", { name: "hansberry_status", arguments: {} }, 4);
  assert.match(s.body.result.content[0].text, /"connected": false/);
});

test("refresh token rotates and the old one dies", async () => {
  const refresh = (rt: string) =>
    fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: client.client_id, client_secret: client.client_secret })
    });
  const r1 = await refresh(tokens.refresh_token);
  assert.equal(r1.status, 200);
  const next = (await r1.json()) as any;
  assert.notEqual(next.access_token, tokens.access_token);
  const r2 = await refresh(tokens.refresh_token);
  assert.equal(r2.status, 400);
  tokens = next;
});

test("admin requires owner login, CSRF, and links an account", async () => {
  const a1 = await fetch(`${BASE}/admin`, noFollow);
  assert.equal(a1.status, 302);
  const state = new URL(a1.headers.get("location")!).searchParams.get("state")!;

  // intruder can't get a session
  const bad = await fetch(`${BASE}/oauth/google/callback?code=intruder&state=${state}`, noFollow);
  assert.equal(bad.status, 403);

  const a2 = await fetch(`${BASE}/admin`, noFollow);
  const state2 = new URL(a2.headers.get("location")!).searchParams.get("state")!;
  const login = await fetch(`${BASE}/oauth/google/callback?code=owner&state=${state2}`, noFollow);
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const page = await fetch(`${BASE}/admin`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;

  // no CSRF -> bounced
  const noCsrf = await fetch(`${BASE}/admin/link/google`, {
    method: "POST", headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: "label=culture", ...noFollow
  });
  assert.equal(noCsrf.headers.get("location"), "/admin");

  const start = await fetch(`${BASE}/admin/link/google`, {
    method: "POST", headers: { cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ label: "culture", csrf }), ...noFollow
  });
  const linkState = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const done = await fetch(`${BASE}/oauth/google/callback?code=work&state=${linkState}`, { headers: { cookie }, ...noFollow });
  assert.match(done.headers.get("location")!, /linked=chris%40cultureco\.co/);

  const after = await (await fetch(`${BASE}/admin`, { headers: { cookie } })).text();
  assert.match(after, /chris@cultureco\.co/);
  assert.match(after, /Missing:/); // only gmail.readonly was granted in the stub

  const r = await mcp(tokens.access_token, "tools/call", { name: "list_accounts", arguments: {} }, 5);
  assert.match(r.body.result.content[0].text, /"label": "culture"/);

  const amb = await mcp(tokens.access_token, "tools/call", { name: "gmail_create_draft", arguments: { account: "all", body: "x", to: ["a@b.c"] } }, 6);
  assert.equal(amb.body.result.isError, true);
  assert.match(amb.body.result.content[0].text, /needs one specific account/);
});

test("Slack linking refuses without a session", async () => {
  const r = await fetch(`${BASE}/admin/link/slack`, { method: "POST", ...noFollow });
  assert.equal(r.headers.get("location"), "/admin");
});
