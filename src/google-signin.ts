import { OAuth2Client } from "google-auth-library";
import type { Config } from "./config.js";
import { GOOGLE_ACCOUNT_SCOPES } from "./accounts.js";

// ============================================================
// Google sign-in. Used for two different things:
//  1. Proving the person at the keyboard is OWNER_EMAIL (openid email only).
//  2. Linking a work account (cultureco, northsix) with Workspace scopes.
// ============================================================

export interface GoogleExchangeResult {
  email: string;
  emailVerified: boolean;
  refreshToken?: string;
  scope: string;
}

export class GoogleSignIn {
  readonly redirectUri: string;

  constructor(private cfg: Config) {
    this.redirectUri = `${cfg.baseUrl}/oauth/google/callback`;
  }

  private client(): OAuth2Client {
    return new OAuth2Client(this.cfg.google.clientId, this.cfg.google.clientSecret, this.redirectUri);
  }

  ownerSignInUrl(state: string): string {
    return this.client().generateAuthUrl({
      scope: ["openid", "email"],
      state,
      access_type: "online",
      prompt: "select_account",
      login_hint: this.cfg.ownerEmail
    });
  }

  linkAccountUrl(state: string): string {
    return this.client().generateAuthUrl({
      scope: GOOGLE_ACCOUNT_SCOPES,
      state,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: false
    });
  }

  async exchange(code: string): Promise<GoogleExchangeResult> {
    const client = this.client();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.cfg.google.clientId });
    const payload = ticket.getPayload();
    if (!payload?.email) throw new Error("Google ID token has no email");
    return {
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
      refreshToken: tokens.refresh_token ?? undefined,
      scope: tokens.scope ?? ""
    };
  }
}
