// Vercel runs this as a serverless function. vercel.json sends /api/* and /health here;
// the web app in public/ is served by Vercel directly.
import { buildApp } from "../src/setup.js";

let app;
export default async function handler(req, res) {
  try {
    app ??= await buildApp();
  } catch (err) {
    app = undefined;
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
  return app(req, res);
}
