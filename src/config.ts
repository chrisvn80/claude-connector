// ============================================================
// Configuration — everything comes from environment variables.
// On Cloud Run, secrets are injected from Secret Manager.
// ============================================================

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export interface Config {
  baseUrl: string;            // public https URL of this service, no trailing slash
  ownerEmail: string;         // the only Google identity allowed to use this connector
  port: number;
  storeBackend: "firestore" | "memory";
  encryptionKey: string;      // base64, 32 bytes
  google: { clientId: string; clientSecret: string };
  slack: { clientId: string; clientSecret: string; teamId: string } | null;
}

export function loadConfig(): Config {
  const baseUrl = required("BASE_URL").replace(/\/+$/, "");
  const slackId = optional("SLACK_CLIENT_ID");
  return {
    baseUrl,
    ownerEmail: required("OWNER_EMAIL").toLowerCase(),
    port: Number(optional("PORT", "8080")),
    storeBackend: optional("STORE_BACKEND", "firestore") === "memory" ? "memory" : "firestore",
    encryptionKey: required("ENCRYPTION_KEY"),
    google: {
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET")
    },
    slack: slackId
      ? {
          clientId: slackId,
          clientSecret: required("SLACK_CLIENT_SECRET"),
          teamId: required("SLACK_TEAM_ID")
        }
      : null
  };
}

// Redirect URIs that MCP clients may register. Restricting these means an attacker
// cannot register their own client and trick the owner into authorizing it.
export const ALLOWED_CLIENT_REDIRECT_HOSTS = [
  "claude.ai",
  "claude.com",
  "localhost",
  "127.0.0.1"
];

// Lifetimes
export const MCP_ACCESS_TOKEN_TTL_SEC = 60 * 60;            // 1 hour
export const MCP_REFRESH_TOKEN_TTL_SEC = 90 * 24 * 60 * 60; // 90 days, rolling
export const AUTH_CODE_TTL_SEC = 5 * 60;
export const PENDING_FLOW_TTL_SEC = 10 * 60;
export const SESSION_TTL_SEC = 12 * 60 * 60;

export const CHARACTER_LIMIT = 60000;
