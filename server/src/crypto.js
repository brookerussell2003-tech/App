import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Plaid access tokens are as sensitive as a bank login, so they are encrypted at rest
// with AES-256-GCM. ENCRYPTION_KEY is ideally 32 random bytes, base64 encoded; any other long
// secret (such as a value a host generates for you) is stretched to 32 bytes with SHA-256.
export function makeSealer(secret) {
  if (!secret || secret.length < 16) throw new Error("ENCRYPTION_KEY must be at least 16 characters");
  const decoded = Buffer.from(secret, "base64");
  const key = decoded.length === 32 ? decoded : createHash("sha256").update(secret).digest();
  return {
    seal(text) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(text, "utf8"), c.final()]);
      return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
    },
    open(sealed) {
      const [iv, tag, body] = sealed.split(".").map((s) => Buffer.from(s, "base64"));
      const d = createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString("utf8");
    },
  };
}
