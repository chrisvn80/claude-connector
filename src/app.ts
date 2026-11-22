import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadConfig } from "./config.js";
import { Crypto } from "./crypto.js";
import { FirestoreStore, MemoryStore } from "./store.js";
import { Accounts } from "./accounts.js";
import { GoogleSignIn } from "./google-signin.js";
import { OwnerOAuthProvider } from "./oauth-provider.js";
import { webRouter } from "./web.js";
import { buildMcpServer } from "./mcp.js";

// ============================================================
// Entry point. One Express app:
//   /.well-known/*, /authorize, /token, /register, /revoke  — OAuth for Claude
//   /mcp                                                    — MCP (bearer-token protected)
//   /admin, /oauth/*/callback                               — account linking (owner only)
// ============================================================

export function createApp(overrides: { google?: GoogleSignIn } = {}) {
  const cfg = loadConfig();
  const crypto = new Crypto(cfg.encryptionKey);
  const store = cfg.storeBackend === "memory" ? new MemoryStore() : new FirestoreStore();
  const accounts = new Accounts(cfg, store, crypto);
  const google = overrides.google ?? new GoogleSignIn(cfg);
  const provider = new OwnerOAuthProvider(cfg, store, google);
  const mcpUrl = new URL(`${cfg.baseUrl}/mcp`);

  const app = express();
  app.set("trust proxy", 1); // Cloud Run sits behind one proxy hop
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.redirect(302, "/admin"));

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(cfg.baseUrl),
      resourceServerUrl: mcpUrl,
      resourceName: "Chris's work accounts",
      scopesSupported: ["mcp"],
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 }
    })
  );

  app.use(webRouter({ cfg, store, crypto, accounts, google, provider }));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl
  });

  // Stateless Streamable HTTP: a fresh server + transport per request (Cloud Run friendly).
  app.post("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
    const server = buildMcpServer(cfg, accounts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    transport.onerror = (err) => console.warn(`[mcp transport] ${err.message}`);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[mcp]", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null
    });
  };
  app.get("/mcp", bearer, methodNotAllowed);
  app.delete("/mcp", bearer, methodNotAllowed);

  return { app, cfg };
}
