import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Plaid access tokens are as sensitive as a bank login, so they are encrypted at rest
// with AES-256-GCM. ENCRYPTION_KEY is 32 random bytes, base64 encoded.
export function makeSealer(base64Key) {
  const key = Buffer.from(base64Key ?? "", "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded");
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
