import { buildApp } from "./setup.js";

const app = await buildApp().catch((err) => { console.error(err.message); process.exit(1); });
const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`Money Book on http://localhost:${port} (Plaid ${process.env.PLAID_ENV ?? "sandbox"})`));
