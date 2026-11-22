import express, { type Request, type Response, type Router } from "express";
import { PENDING_FLOW_TTL_SEC, SESSION_TTL_SEC, type Config } from "./config.js";
import { randomToken, type Crypto } from "./crypto.js";
import type { Store } from "./store.js";
import { Accounts, GOOGLE_ACCOUNT_SCOPES, SLACK_USER_SCOPES, type LinkedAccount } from "./accounts.js";
import type { GoogleSignIn } from "./google-signin.js";
import type { McpFlow, OwnerOAuthProvider } from "./oauth-provider.js";

// ============================================================
// Browser-facing pages: the Google/Slack OAuth callbacks and a
// small /admin page (owner-only) for linking accounts.
// ============================================================

type Flow =
  | McpFlow
  | { type: "login" }
  | { type: "link-google"; label: string }
  | { type: "link-slack" };

const COOKIE = "cc_session";

interface Session {
  email: string;
  exp: number; // seconds since epoch
}

export function webRouter(deps: {
  cfg: Config;
  store: Store;
  crypto: Crypto;
  accounts: Accounts;
  google: GoogleSignIn;
  provider: OwnerOAuthProvider;
}): Router {
  const { cfg, store, crypto, accounts, google, provider } = deps;
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  // ---------- session helpers ----------

  function readSession(req: Request): Session | null {
    const raw = parseCookies(req.headers.cookie ?? "")[COOKIE];
    if (!raw) return null;
    const [payload, sig] = raw.split(".");
    if (!payload || !sig || !crypto.verify(payload, sig)) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
      if (s.exp < Date.now() / 1000 || s.email !== cfg.ownerEmail) return null;
      return s;
    } catch {
      return null;
    }
  }

  function writeSession(res: Response, email: string) {
    const payload = Buffer.from(
      JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC })
    ).toString("base64url");
    res.cookie(COOKIE, `${payload}.${crypto.sign(payload)}`, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_TTL_SEC * 1000,
      path: "/"
    });
  }

  function csrfFor(req: Request): string {
    const raw = parseCookies(req.headers.cookie ?? "")[COOKIE] ?? "";
    return crypto.sign(`csrf:${raw}`);
  }

  function checkCsrf(req: Request): boolean {
    const given = String((req.body as Record<string, unknown>)?.csrf ?? "");
    return given.length > 0 && given === csrfFor(req);
  }

  async function startFlow(flow: Flow): Promise<string> {
    const state = randomToken();
    await store.set("flows", state, flow, PENDING_FLOW_TTL_SEC);
    return state;
  }

  // ---------- Google callback (owner sign-in, MCP authorization, account linking) ----------

  router.get("/oauth/google/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const flow = state ? await store.take<Flow>("flows", state) : undefined;
    if (!flow) return page(res, 400, "Sign-in expired", "<p>This sign-in link expired or was already used. Start again.</p>");

    if (req.query.error) {
      if (flow.type === "mcp") {
        const url = new URL(flow.redirectUri);
        url.searchParams.set("error", "access_denied");
        if (flow.state) url.searchParams.set("state", flow.state);
        return res.redirect(302, url.toString());
      }
      return page(res, 400, "Sign-in cancelled", `<p>Google returned: ${esc(String(req.query.error))}</p><p><a href="/admin">Back</a></p>`);
    }

    try {
      const result = await google.exchange(String(req.query.code ?? ""));

      if (flow.type === "mcp") {
        if (!result.emailVerified || result.email !== cfg.ownerEmail) {
          console.warn(`[auth] refused MCP authorization for ${result.email}`);
          const url = new URL(flow.redirectUri);
          url.searchParams.set("error", "access_denied");
          url.searchParams.set("error_description", "This connector is private.");
          if (flow.state) url.searchParams.set("state", flow.state);
          return res.redirect(302, url.toString());
        }
        return res.redirect(302, await provider.completeAuthorization(flow, result.email));
      }

      if (flow.type === "login") {
        if (!result.emailVerified || result.email !== cfg.ownerEmail) {
          return page(res, 403, "Not allowed", `<p>${esc(result.email)} is not allowed to manage this connector.</p>`);
        }
        writeSession(res, result.email);
        return res.redirect(302, "/admin");
      }

      if (flow.type === "link-google") {
        if (!readSession(req)) return res.redirect(302, "/admin");
        if (!result.refreshToken) {
          return page(res, 400, "No long-lived access granted",
            `<p>Google didn't return a refresh token for ${esc(result.email)}. Remove this app at
             <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> (signed in as that account), then link again.</p>
             <p><a href="/admin">Back</a></p>`);
        }
        await accounts.saveGoogle(flow.label, result.email, result.refreshToken, result.scope);
        return res.redirect(302, `/admin?linked=${encodeURIComponent(result.email)}`);
      }
    } catch (err) {
      console.error("[google callback]", err);
      return page(res, 500, "Sign-in failed", `<p>${esc(errMsg(err))}</p><p><a href="/admin">Back</a></p>`);
    }
    return page(res, 400, "Unexpected sign-in", "<p>Unknown flow.</p>");
  });

  // ---------- Slack callback ----------

  router.get("/oauth/slack/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const flow = state ? await store.take<Flow>("flows", state) : undefined;
    if (!flow || flow.type !== "link-slack" || !readSession(req)) return res.redirect(302, "/admin");
    if (req.query.error || !cfg.slack) {
      return page(res, 400, "Slack linking cancelled", `<p>${esc(String(req.query.error ?? "Slack not configured"))}</p><p><a href="/admin">Back</a></p>`);
    }
    try {
      const body = new URLSearchParams({
        client_id: cfg.slack.clientId,
        client_secret: cfg.slack.clientSecret,
        code: String(req.query.code ?? ""),
        redirect_uri: `${cfg.baseUrl}/oauth/slack/callback`
      });
      const r = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      const json = (await r.json()) as {
        ok: boolean;
        error?: string;
        team?: { id: string; name: string; domain?: string };
        authed_user?: { id: string; access_token?: string; scope?: string; refresh_token?: string; expires_in?: number };
      };
      if (!json.ok) throw new Error(`Slack: ${json.error}`);
      const u = json.authed_user;
      if (!u?.access_token || !json.team) throw new Error("Slack returned no user token. Check the app's User Token Scopes.");
      if (json.team.id !== cfg.slack.teamId) {
        throw new Error(`That was workspace "${json.team.name}" (${json.team.id}), not the pinned Hansberry workspace (${cfg.slack.teamId}). Nothing was saved.`);
      }
      // Look up the authorizing user's name/email for display.
      let name: string | undefined;
      let email: string | undefined;
      try {
        const info = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(u.id)}`, {
          headers: { Authorization: `Bearer ${u.access_token}` }
        });
        const ij = (await info.json()) as { user?: { real_name?: string; profile?: { email?: string } } };
        name = ij.user?.real_name;
        email = ij.user?.profile?.email;
      } catch {
        /* display only */
      }
      await accounts.saveSlack(
        { label: "hansberry", team: json.team, user: { id: u.id, name, email }, scopes: u.scope ?? "" },
        {
          access_token: u.access_token,
          refresh_token: u.refresh_token,
          expires_at: u.expires_in ? Date.now() + u.expires_in * 1000 : undefined,
          scope: u.scope ?? ""
        }
      );
      return res.redirect(302, `/admin?linked=${encodeURIComponent(json.team.name)}`);
    } catch (err) {
      console.error("[slack callback]", err);
      return page(res, 500, "Slack linking failed", `<p>${esc(errMsg(err))}</p><p><a href="/admin">Back</a></p>`);
    }
  });

  // ---------- admin ----------

  router.get("/admin", async (req, res) => {
    if (!readSession(req)) {
      const state = await startFlow({ type: "login" });
      return res.redirect(302, google.ownerSignInUrl(state));
    }
    const list = await accounts.list();
    const csrf = csrfFor(req);
    const linked = req.query.linked ? `<p class="ok">Linked ${esc(String(req.query.linked))}.</p>` : "";
    const rows = list.map((a) => accountRow(a, csrf)).join("") || `<tr><td colspan="4">No accounts linked yet.</td></tr>`;
    const slackBlock = cfg.slack
      ? `<form method="post" action="/admin/link/slack"><input type="hidden" name="csrf" value="${csrf}">
           <button>Link Hansberry Slack</button></form>`
      : `<p class="muted">Slack is not configured on this server.</p>`;
    return page(res, 200, "Claude connector — accounts", `
      ${linked}
      <p class="muted">Signed in as ${esc(cfg.ownerEmail)}. MCP endpoint: <code>${esc(cfg.baseUrl)}/mcp</code></p>
      <table><tr><th>Label</th><th>Account</th><th>Status</th><th></th></tr>${rows}</table>
      <h2>Link a Google account</h2>
      <form method="post" action="/admin/link/google">
        <input type="hidden" name="csrf" value="${csrf}">
        <label>Label <input name="label" placeholder="culture" required pattern="[a-zA-Z0-9_-]{2,30}"></label>
        <button>Sign in with Google</button>
      </form>
      <p class="muted">On Google's screen, pick the work account and leave every permission box checked.</p>
      <h2>Slack</h2>
      ${slackBlock}
      <form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="link">Sign out</button></form>
    `);
  });

  router.post("/admin/link/google", async (req, res) => {
    if (!readSession(req) || !checkCsrf(req)) return res.redirect(302, "/admin");
    const label = String((req.body as Record<string, unknown>).label ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,30}$/.test(label)) return page(res, 400, "Bad label", `<p>Use 2–30 letters, numbers, - or _.</p><p><a href="/admin">Back</a></p>`);
    const state = await startFlow({ type: "link-google", label });
    return res.redirect(302, google.linkAccountUrl(state));
  });

  router.post("/admin/link/slack", async (req, res) => {
    if (!readSession(req) || !checkCsrf(req) || !cfg.slack) return res.redirect(302, "/admin");
    const state = await startFlow({ type: "link-slack" });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", cfg.slack.clientId);
    url.searchParams.set("user_scope", SLACK_USER_SCOPES.join(","));
    url.searchParams.set("redirect_uri", `${cfg.baseUrl}/oauth/slack/callback`);
    url.searchParams.set("team", cfg.slack.teamId);
    url.searchParams.set("state", state);
    return res.redirect(302, url.toString());
  });

  router.post("/admin/remove", async (req, res) => {
    if (!readSession(req) || !checkCsrf(req)) return res.redirect(302, "/admin");
    const id = String((req.body as Record<string, unknown>).id ?? "");
    if (/^(google|slack):/.test(id)) await accounts.remove(id);
    return res.redirect(302, "/admin");
  });

  router.post("/admin/logout", (req, res) => {
    res.clearCookie(COOKIE, { path: "/" });
    return page(res, 200, "Signed out", `<p>Signed out.</p>`);
  });

  return router;
}

// ---------- rendering ----------

function accountRow(a: LinkedAccount, csrf: string): string {
  const who = a.kind === "google" ? a.email : `${a.team.name} — ${a.user.name ?? a.user.id}`;
  const expected = a.kind === "google" ? GOOGLE_ACCOUNT_SCOPES.filter((s) => s.startsWith("https://")) : SLACK_USER_SCOPES;
  const granted = a.scopes.split(/[ ,]+/);
  const missing = expected.filter((s) => !granted.includes(s));
  const status = missing.length
    ? `<span class="warn">Missing: ${missing.map((m) => esc(m.replace("https://www.googleapis.com/auth/", ""))).join(", ")} — relink and leave all boxes checked</span>`
    : `<span class="ok">All permissions granted</span>`;
  return `<tr><td>${esc(a.label)}</td><td>${esc(a.kind)}: ${esc(who)}</td><td>${status}</td>
    <td><form method="post" action="/admin/remove" onsubmit="return confirm('Remove ${esc(a.label)}?')">
      <input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${esc(Accounts.idFor(a))}">
      <button class="link">Remove</button></form></td></tr>`;
}

function page(res: Response, status: number, title: string, body: string) {
  res.status(status).type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1f2328}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:8px 6px;text-align:left;vertical-align:top}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #888;background:#f6f8fa;cursor:pointer}
button.link{border:none;background:none;color:#0969da;padding:0}input{font:inherit;padding:5px 8px}
.ok{color:#1a7f37}.warn{color:#9a6700}.muted{color:#656d76}code{background:#f6f8fa;padding:1px 4px}
</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
