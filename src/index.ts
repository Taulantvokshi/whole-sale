import crypto from "crypto";
import fs from "fs";
import path from "path";
import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const {
  SHOPIFY_API_KEY = "",
  SHOPIFY_API_SECRET = "",
  SHOPIFY_SCOPES = "read_products",
  SHOPIFY_API_VERSION = "2026-04",
  HOST = "http://localhost:3000",
  PORT = "3000",
  // Where to persist the token store. On Render, point this at a mounted disk
  // (e.g. /data/tokens.json) so tokens survive deploys and restarts. Defaults
  // to a file in the project root for local development.
  TOKENS_FILE: TOKENS_FILE_ENV = "",
} = process.env;

const app = express();

// Allow the browser client (served from a different origin) to call the API.
// Simple GET endpoints, so a permissive header plus preflight handling is enough.
app.use((req: Request, res: Response, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Serve the static HTML page where the merchant starts the install.
app.use(express.static(path.join(__dirname, "..", "public")));

// In-memory store for OAuth `state` nonces (use a real store in production).
const nonces = new Set<string>();

function isValidShop(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

// --- Dead-simple per-shop token store (a JSON file; swap for a DB later) ---
// Shopify no longer accepts non-expiring tokens, so we store the expiring
// offline token together with its refresh token and expiry timestamps.
const TOKENS_FILE =
  TOKENS_FILE_ENV || path.join(__dirname, "..", "tokens.json");

interface TokenRecord {
  access_token: string;
  expires_at: number; // epoch ms when the access token expires
  refresh_token: string;
  refresh_token_expires_at: number; // epoch ms when the refresh token expires
}

// Turn a Shopify token response into a stored record with absolute expiries.
function toRecord(data: any): TokenRecord {
  const now = Date.now();
  return {
    access_token: data.access_token,
    expires_at: now + (Number(data.expires_in) || 0) * 1000,
    refresh_token: data.refresh_token,
    refresh_token_expires_at:
      now + (Number(data.refresh_token_expires_in) || 0) * 1000,
  };
}

function loadTokens(): Record<string, TokenRecord> {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveToken(shop: string, record: TokenRecord): void {
  const tokens = loadTokens();
  tokens[shop] = record;
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function getTokenRecord(shop: string): TokenRecord | undefined {
  return loadTokens()[shop];
}

// Return a valid access token for the shop, refreshing it if it has (nearly)
// expired. Returns undefined if the shop isn't installed or refresh fails.
async function getValidToken(shop: string): Promise<string | undefined> {
  const rec = getTokenRecord(shop);
  if (!rec || !rec.access_token) return undefined;

  // Still valid (with a 60s safety margin)? Use it as-is.
  if (rec.expires_at && Date.now() < rec.expires_at - 60_000) {
    return rec.access_token;
  }

  // Access token expired — refresh it without bothering the merchant.
  if (!rec.refresh_token) return undefined;
  try {
    const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        grant_type: "refresh_token",
        refresh_token: rec.refresh_token,
      }),
    });
    if (!res.ok) return undefined;
    const updated = toRecord(await res.json());
    saveToken(shop, updated);
    return updated.access_token;
  } catch {
    return undefined;
  }
}

// Step 1: redirect the merchant to Shopify's OAuth grant screen.
app.get("/auth", (req: Request, res: Response) => {
  const shop = String(req.query.shop || "");
  if (!isValidShop(shop)) {
    return res.status(400).send("Invalid shop. Use your-store.myshopify.com");
  }

  const state = crypto.randomBytes(16).toString("hex");
  nonces.add(state);

  const redirectUri = `${HOST}/auth/callback`;
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

// Step 2: Shopify redirects back here with a code we exchange for a token.
app.get("/auth/callback", async (req: Request, res: Response) => {
  const { shop, code, state, hmac } = req.query as Record<string, string>;

  if (!shop || !code || !state || !hmac) {
    return res.status(400).send("Missing required parameters");
  }
  if (!isValidShop(shop)) {
    return res.status(400).send("Invalid shop");
  }
  if (!nonces.has(state)) {
    return res.status(403).send("Invalid state");
  }
  nonces.delete(state);

  // Verify the HMAC to confirm the request really came from Shopify.
  const message = Object.keys(req.query)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${req.query[key]}`)
    .join("&");

  const generatedHmac = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  if (
    !crypto.timingSafeEqual(Buffer.from(generatedHmac), Buffer.from(hmac))
  ) {
    return res.status(403).send("HMAC validation failed");
  }

  // Exchange the authorization code for a permanent access token.
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code,
        expiring: 1, // request an expiring offline token (non-expiring rejected)
      }),
    });

    if (!tokenRes.ok) {
      return res.status(502).send("Failed to obtain access token");
    }

    const data = await tokenRes.json();
    saveToken(shop, toRecord(data));
    console.log(`Installed on ${shop}`);

    // Send them straight to their collections so you can see it worked.
    res.redirect(`/collections?shop=${encodeURIComponent(shop)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong during installation");
  }
});

// List the shop's collections using its stored access token.
app.get("/collections", async (req: Request, res: Response) => {
  const shop = String(req.query.shop || "");
  if (!isValidShop(shop)) {
    return res.status(400).send("Invalid shop");
  }

  const token = await getValidToken(shop);
  if (!token) {
    return res.status(401).send(`No token for ${shop}. Install the app first.`);
  }

  const query = `{
    collections(first: 50) {
      edges { node { id title handle productsCount { count } } }
    }
  }`;

  try {
    const apiRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query }),
      }
    );

    const json = (await apiRes.json()) as any;
    // Don't silently swallow API errors as an empty list — surface them.
    if (json?.errors || json?.data?.collections == null) {
      console.error("Shopify API error:", JSON.stringify(json));
      return res.status(502).json({ error: json?.errors ?? "Unexpected API response" });
    }
    const collections = json.data.collections.edges.map((e: any) => e.node);
    res.json(collections);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to fetch collections");
  }
});

// List the products in a single collection, identified by collection id.
// Pass either a full gid ("gid://shopify/Collection/123") or the bare number.
app.get("/products", async (req: Request, res: Response) => {
  const shop = String(req.query.shop || "");
  if (!isValidShop(shop)) {
    return res.status(400).send("Invalid shop");
  }

  const rawId = String(req.query.collection || "");
  if (!rawId) {
    return res.status(400).send("Missing collection id. Use ?collection=<id>");
  }
  // Accept either a full gid or a bare numeric id.
  const collectionId = rawId.startsWith("gid://")
    ? rawId
    : `gid://shopify/Collection/${rawId}`;

  const token = await getValidToken(shop);
  if (!token) {
    return res.status(401).send(`No token for ${shop}. Install the app first.`);
  }

  const query = `query($id: ID!) {
    collection(id: $id) {
      id
      title
      products(first: 50) {
        edges {
          node {
            id
            title
            handle
            featuredImage { url }
            variants(first: 20) {
              edges { node { id title sku price availableForSale } }
            }
          }
        }
      }
    }
  }`;

  try {
    const apiRes = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables: { id: collectionId } }),
      }
    );

    const json = (await apiRes.json()) as any;
    // A null collection means a bad id (or the shop can't see it) — surface it.
    if (json?.errors || json?.data?.collection == null) {
      console.error("Shopify API error:", JSON.stringify(json));
      return res
        .status(502)
        .json({ error: json?.errors ?? "Collection not found" });
    }

    const collection = json.data.collection;
    // Flatten the variant edges so each product carries a plain variants array.
    const products = collection.products.edges.map((e: any) => ({
      ...e.node,
      variants: e.node.variants.edges.map((v: any) => v.node),
    }));
    res.json({ id: collection.id, title: collection.title, products });
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to fetch products");
  }
});

app.listen(Number(PORT), () => {
  console.log(`Server running at ${HOST}`);
});
