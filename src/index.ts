// Load .env before any other import so modules like ./db can read DATABASE_URL
// at import time (imports run before the rest of this file's body).
import "dotenv/config";
import crypto from "crypto";
import path from "path";
import express, { Request, Response, NextFunction } from "express";
import { pool } from "./db";
import { verifyIdToken } from "./firebase";

const {
  SHOPIFY_API_KEY = "",
  SHOPIFY_API_SECRET = "",
  SHOPIFY_SCOPES = "read_products",
  SHOPIFY_API_VERSION = "2026-04",
  HOST = "http://localhost:3000",
  PORT = "3000",
  // Where to send the merchant back after a successful store connect.
  CLIENT_URL = "https://wholesale-client.onrender.com",
} = process.env;

const app = express();

// Allow the browser client (served from a different origin) to call the API.
// Simple GET endpoints, so a permissive header plus preflight handling is enough.
app.use((req: Request, res: Response, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Serve the static HTML page where the merchant starts the install.
app.use(express.static(path.join(__dirname, "..", "public")));

// In-memory map of pending store connects: OAuth `state` -> Firebase uid.
// Ties the Shopify callback (which has no auth header) back to the user who
// started the connect. In-memory, so a server restart mid-connect invalidates
// it and the user just clicks "Connect" again.
const pendingConnects = new Map<string, string>();

function isValidShop(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

// --- App auth (Firebase) ---
// The client logs in with Google via the Firebase web SDK and sends the
// resulting ID token as `Authorization: Bearer <token>`. We verify it here and
// attach the user's uid/email to the request.
interface AuthedRequest extends Request {
  uid?: string;
  email?: string;
}

// Ensure a row exists for this Firebase user (first login creates it).
async function upsertUser(uid: string, email?: string): Promise<void> {
  await pool.query(
    `insert into users (firebase_uid, email) values ($1, $2)
     on conflict (firebase_uid) do update set email = excluded.email`,
    [uid, email ?? null]
  );
}

// Middleware: require a valid Firebase ID token; 401 otherwise.
async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  try {
    const decoded = await verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = decoded.email;
    await upsertUser(decoded.uid, decoded.email);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// --- Per-shop token store (Postgres `shops` table) ---
// Shopify no longer accepts non-expiring tokens, so we store the expiring
// offline token together with its refresh token and expiry timestamps.
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

// Save (or update) a shop's token. Pass ownerUid when a user is connecting the
// store; omit it on background refreshes so the existing owner is preserved.
async function saveToken(
  shop: string,
  record: TokenRecord,
  ownerUid?: string
): Promise<void> {
  if (ownerUid) {
    // One store per user: drop any other store this user had connected.
    await pool.query(`delete from shops where owner_uid = $1 and shop <> $2`, [
      ownerUid,
      shop,
    ]);
  }
  await pool.query(
    `insert into shops
       (shop, access_token, expires_at, refresh_token, refresh_token_expires_at, owner_uid, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (shop) do update set
       access_token = excluded.access_token,
       expires_at = excluded.expires_at,
       refresh_token = excluded.refresh_token,
       refresh_token_expires_at = excluded.refresh_token_expires_at,
       owner_uid = coalesce(excluded.owner_uid, shops.owner_uid),
       updated_at = now()`,
    [
      shop,
      record.access_token,
      record.expires_at,
      record.refresh_token,
      record.refresh_token_expires_at,
      ownerUid ?? null,
    ]
  );
}

async function getTokenRecord(shop: string): Promise<TokenRecord | undefined> {
  const { rows } = await pool.query(
    `select access_token, expires_at, refresh_token, refresh_token_expires_at
       from shops where shop = $1`,
    [shop]
  );
  if (rows.length === 0) return undefined;
  const r = rows[0];
  // bigint columns come back as strings from pg — coerce the epoch-ms values.
  return {
    access_token: r.access_token,
    expires_at: Number(r.expires_at),
    refresh_token: r.refresh_token,
    refresh_token_expires_at: Number(r.refresh_token_expires_at),
  };
}

// The shop a given user has connected (or undefined if none).
async function getShopForUser(uid: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select shop from shops where owner_uid = $1`,
    [uid]
  );
  return rows[0]?.shop;
}

// Return a valid access token for the shop, refreshing it if it has (nearly)
// expired. Returns undefined if the shop isn't installed or refresh fails.
async function getValidToken(shop: string): Promise<string | undefined> {
  const rec = await getTokenRecord(shop);
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
    await saveToken(shop, updated);
    return updated.access_token;
  } catch {
    return undefined;
  }
}

// Who am I? Returns the logged-in user and their connected store (if any).
app.get("/me", requireAuth, async (req: AuthedRequest, res: Response) => {
  const { rows } = await pool.query(
    `select shop from shops where owner_uid = $1`,
    [req.uid]
  );
  res.json({
    uid: req.uid,
    email: req.email,
    shop: rows[0]?.shop ?? null,
  });
});

// Disconnect the user's store: remove the stored token/link entirely.
// Logging out does NOT do this — only an explicit disconnect.
app.post("/disconnect", requireAuth, async (req: AuthedRequest, res: Response) => {
  await pool.query(`delete from shops where owner_uid = $1`, [req.uid]);
  res.json({ disconnected: true });
});

// Step 1: the logged-in user starts connecting their store. We return the
// Shopify authorize URL for the client to redirect to. The `state` is tied to
// this user so the callback knows who is connecting.
app.get("/connect", requireAuth, (req: AuthedRequest, res: Response) => {
  const shop = String(req.query.shop || "");
  if (!isValidShop(shop)) {
    return res.status(400).json({ error: "Invalid shop. Use your-store.myshopify.com" });
  }

  const state = crypto.randomBytes(16).toString("hex");
  pendingConnects.set(state, req.uid!);

  const redirectUri = `${HOST}/auth/callback`;
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.json({ url: authUrl });
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
  const ownerUid = pendingConnects.get(state);
  if (!ownerUid) {
    return res.status(403).send("Invalid state");
  }
  pendingConnects.delete(state);

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
    await saveToken(shop, toRecord(data), ownerUid);
    console.log(`Connected ${shop} for user ${ownerUid}`);

    // Back to the app; the client will now see the connected store via /me.
    res.redirect(`${CLIENT_URL}/?connected=1`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong during installation");
  }
});

// List the connected shop's collections using its stored access token.
app.get("/collections", requireAuth, async (req: AuthedRequest, res: Response) => {
  const shop = await getShopForUser(req.uid!);
  if (!shop) {
    return res.status(409).json({ error: "No store connected" });
  }

  const token = await getValidToken(shop);
  if (!token) {
    return res.status(401).json({ error: "Store token unavailable. Reconnect the store." });
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
app.get("/products", requireAuth, async (req: AuthedRequest, res: Response) => {
  const shop = await getShopForUser(req.uid!);
  if (!shop) {
    return res.status(409).json({ error: "No store connected" });
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
    return res.status(401).json({ error: "Store token unavailable. Reconnect the store." });
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
