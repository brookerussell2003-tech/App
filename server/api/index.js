// Vercel runs this as a serverless function. vercel.json sends /api/* and /health here;
// the web app in public/ is served by Vercel directly.
let app;
export default async function handler(req, res) {
  try {
    // Imported here so a startup failure comes back as a readable error instead of a crash.
    const { buildApp } = await import("../src/setup.js");
    app ??= await buildApp();
  } catch (err) {
    app = undefined;
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
  return app(req, res);
}
