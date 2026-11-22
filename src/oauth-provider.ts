import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  ALLOWED_CLIENT_REDIRECT_HOSTS,
  MCP_ACCESS_TOKEN_TTL_SEC,
  MCP_REFRESH_TOKEN_TTL_SEC,
  PENDING_FLOW_TTL_SEC,
  type Config
} from "./config.js";
import { hashToken, randomToken } from "./crypto.js";
import type { Store } from "./store.js";
import type { GoogleSignIn } from "./google-signin.js";

// ============================================================
// OAuth 2.1 authorization server for Claude (MCP auth spec).
// Claude registers itself, then sends the user here to authorize.
// We authenticate the user with Google and only ever issue tokens
// to OWNER_EMAIL. Everyone else is refused.
// ============================================================

export interface McpFlow {
  type: "mcp";
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string;
}

export interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  email: string;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  email: string;
  expiresAt: number; // seconds since epoch
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly resourceUrl: string;

  constructor(private cfg: Config, private store: Store, private google: GoogleSignIn) {
    this.resourceUrl = `${cfg.baseUrl}/mcp`;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (id: string) => this.store.get<OAuthClientInformationFull>("clients", id),
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        for (const uri of full.redirect_uris) {
          let host: string;
          try {
            host = new URL(String(uri)).hostname;
          } catch {
            throw new InvalidClientMetadataError(`Invalid redirect_uri: ${uri}`);
          }
          const ok = ALLOWED_CLIENT_REDIRECT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
          if (!ok) throw new InvalidClientMetadataError(`redirect_uri host not allowed: ${host}`);
        }
        await this.store.set("clients", full.client_id, full);
        return full;
      }
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = params.resource?.href ?? this.resourceUrl;
    if (!sameResource(resource, this.resourceUrl)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resourceUrl}`);
    }
    const flowId = randomToken();
    const flow: McpFlow = {
      type: "mcp",
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: this.resourceUrl
    };
    await this.store.set("flows", flowId, flow, PENDING_FLOW_TTL_SEC);
    res.redirect(302, this.google.ownerSignInUrl(flowId));
  }

  /** Called by the Google callback once the owner has been verified. Returns the redirect back to Claude. */
  async completeAuthorization(flow: McpFlow, email: string): Promise<string> {
    const code = randomToken();
    const record: AuthCodeRecord = {
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      codeChallenge: flow.codeChallenge,
      scopes: flow.scopes,
      resource: flow.resource,
      email
    };
    await this.store.set("codes", hashToken(code), record, 5 * 60);
    const url = new URL(flow.redirectUri);
    url.searchParams.set("code", code);
    if (flow.state) url.searchParams.set("state", flow.state);
    return url.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = await this.store.get<AuthCodeRecord>("codes", hashToken(code));
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const rec = await this.store.take<AuthCodeRecord>("codes", hashToken(code));
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && !sameResource(resource.href, rec.resource)) throw new InvalidTargetError("resource mismatch");
    return this.issue(client.client_id, rec.scopes, rec.resource, rec.email);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const rec = await this.store.take<TokenRecord>("refresh", hashToken(refreshToken));
    if (!rec || rec.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    if (resource && !sameResource(resource.href, rec.resource)) throw new InvalidTargetError("resource mismatch");
    if (rec.email !== this.cfg.ownerEmail) throw new InvalidGrantError("Token owner no longer authorized");
    return this.issue(client.client_id, rec.scopes, rec.resource, rec.email);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = await this.store.get<TokenRecord>("access", hashToken(token));
    if (!rec) throw new InvalidTokenError("Invalid or expired access token");
    if (rec.email !== this.cfg.ownerEmail) throw new InvalidTokenError("Token owner no longer authorized");
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt,
      resource: new URL(rec.resource),
      extra: { email: rec.email }
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const h = hashToken(request.token);
    await this.store.delete("access", h);
    await this.store.delete("refresh", h);
  }

  private async issue(clientId: string, scopes: string[], resource: string, email: string): Promise<OAuthTokens> {
    const now = Math.floor(Date.now() / 1000);
    const access = randomToken();
    const refresh = randomToken();
    await this.store.set<TokenRecord>(
      "access",
      hashToken(access),
      { clientId, scopes, resource, email, expiresAt: now + MCP_ACCESS_TOKEN_TTL_SEC },
      MCP_ACCESS_TOKEN_TTL_SEC
    );
    await this.store.set<TokenRecord>(
      "refresh",
      hashToken(refresh),
      { clientId, scopes, resource, email, expiresAt: now + MCP_REFRESH_TOKEN_TTL_SEC },
      MCP_REFRESH_TOKEN_TTL_SEC
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: MCP_ACCESS_TOKEN_TTL_SEC,
      refresh_token: refresh,
      scope: scopes.join(" ")
    };
  }
}

function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/#.*$/, "").replace(/\/$/, "");
  return norm(a) === norm(b);
}
