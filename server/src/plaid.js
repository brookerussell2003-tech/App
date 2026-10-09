import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

export function makePlaidClient({ clientId, secret, env = "sandbox" }) {
  if (!PlaidEnvironments[env]) throw new Error(`PLAID_ENV must be one of: ${Object.keys(PlaidEnvironments).join(", ")}`);
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: { headers: { "PLAID-CLIENT-ID": clientId, "PLAID-SECRET": secret } },
    }),
  );
}
