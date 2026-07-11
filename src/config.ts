// Load .env before reading any variable so every module that imports `config`
// gets a fully-populated, validated environment. Modules should import from here
// instead of touching process.env directly.
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

export const config = {
  // Postgres connection string (Render internal URL in prod, external locally).
  databaseUrl: required("DATABASE_URL"),
  // Firebase service-account JSON, base64-encoded (decoded in firebase.ts).
  firebaseServiceAccount: required("FIREBASE_SERVICE_ACCOUNT"),
  // Shopify app credentials + OAuth settings.
  shopify: {
    apiKey: required("SHOPIFY_API_KEY"),
    apiSecret: required("SHOPIFY_API_SECRET"),
    scopes: optional("SHOPIFY_SCOPES", "read_products"),
    apiVersion: optional("SHOPIFY_API_VERSION", "2026-04"),
  },
  // This server's public origin (used to build the Shopify redirect URI).
  host: optional("HOST", "http://localhost:3000"),
  // Where the merchant is sent back to after a successful store connect.
  clientUrl: optional("CLIENT_URL", "https://wholesale-client.onrender.com"),
  port: Number(optional("PORT", "3000")),
} as const;
