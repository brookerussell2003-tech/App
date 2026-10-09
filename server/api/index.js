// Vercel runs this as a serverless function. vercel.json sends /api/* and /health here;
// the web app in public/ is served by Vercel directly.
let app;
// Plain Node response helpers, so this works with or without Vercel's res.status()/res.json().
const send = (res, code, body) => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};
const SETTINGS = ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV", "APP_TOKEN", "ENCRYPTION_KEY", "DATABASE_URL", "DATABASE_AUTH_TOKEN"];

export default async function handler(req, res) {
  // /health reports whether the app can start, and which settings are filled in (never their values).
  if (req.url.startsWith("/health")) {
    const settings = Object.fromEntries(SETTINGS.map((k) => [k, process.env[k] ? "set" : "missing"]));
    try {
      const { buildApp } = await import("../src/setup.js");
      app ??= await buildApp();
      return send(res, 200, { ok: true, settings });
    } catch (err) {
      app = undefined;
      return send(res, 200, { ok: false, error: err.message, settings });
    }
  }
  try {
    // Imported here so a startup failure comes back as a readable error instead of a crash.
    const { buildApp } = await import("../src/setup.js");
    app ??= await buildApp();
  } catch (err) {
    app = undefined;
    console.error(err);
    return send(res, 500, { error: err.message });
  }
  return app(req, res);
}
