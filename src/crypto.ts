import crypto from "node:crypto";

// ============================================================
// Encryption + signing. One 32-byte master key (from Secret Manager)
// is split via HKDF into an encryption key and a MAC key.
// ============================================================

function subkey(master: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
}

export class Crypto {
  private encKey: Buffer;
  private macKey: Buffer;

  constructor(masterKeyB64: string) {
    const master = Buffer.from(masterKeyB64, "base64");
    if (master.length !== 32) {
      throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (e.g. `openssl rand -base64 32`).");
    }
    this.encKey = subkey(master, "claude-connector/enc/v1");
    this.macKey = subkey(master, "claude-connector/mac/v1");
  }

  encrypt(value: unknown): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encKey, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
  }

  decrypt<T>(blob: string): T {
    const [version, iv, tag, data] = blob.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("Unrecognized encrypted value");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
    return JSON.parse(plain.toString("utf8")) as T;
  }

  sign(payload: string): string {
    return crypto.createHmac("sha256", this.macKey).update(payload).digest("base64url");
  }

  verify(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  }
}

// Tokens are stored only as hashes, so a database leak does not leak usable tokens.
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
