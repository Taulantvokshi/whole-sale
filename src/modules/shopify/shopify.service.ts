import crypto from "crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { shops } from "../../db/schema";
import { config } from "../../config";
import { AppError, BadRequest, Conflict, Unauthorized } from "../../lib/errors";

// In-memory map of pending store connects: OAuth `state` -> Firebase uid.
// Ties the Shopify callback (which has no auth header) back to the user who
// started the connect. In-memory, so a server restart mid-connect invalidates
// it and the user just clicks "Connect" again.
const pendingConnects = new Map<string, string>();

export function isValidShop(shop: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop);
}

// --- Per-shop token store (Postgres `shops` table via Drizzle) ---
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
    await db
      .delete(shops)
      .where(and(eq(shops.ownerUid, ownerUid), ne(shops.shop, shop)));
  }
  await db
    .insert(shops)
    .values({
      shop,
      accessToken: record.access_token,
      expiresAt: record.expires_at,
      refreshToken: record.refresh_token,
      refreshTokenExpiresAt: record.refresh_token_expires_at,
      ownerUid: ownerUid ?? null,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: shops.shop,
      set: {
        accessToken: sql`excluded.access_token`,
        expiresAt: sql`excluded.expires_at`,
        refreshToken: sql`excluded.refresh_token`,
        refreshTokenExpiresAt: sql`excluded.refresh_token_expires_at`,
        // Preserve the existing owner on refresh (excluded.owner_uid is null then).
        ownerUid: sql`coalesce(excluded.owner_uid, ${shops.ownerUid})`,
        updatedAt: sql`now()`,
      },
    });
}

async function getTokenRecord(shop: string): Promise<TokenRecord | undefined> {
  const rows = await db
    .select({
      access_token: shops.accessToken,
      expires_at: shops.expiresAt,
      refresh_token: shops.refreshToken,
      refresh_token_expires_at: shops.refreshTokenExpiresAt,
    })
    .from(shops)
    .where(eq(shops.shop, shop));
  return rows[0];
}

// The shop a given user has connected (or undefined if none).
export async function getShopForUser(uid: string): Promise<string | undefined> {
  const rows = await db
    .select({ shop: shops.shop })
    .from(shops)
    .where(eq(shops.ownerUid, uid));
  return rows[0]?.shop;
}

export async function deleteShopForUser(uid: string): Promise<void> {
  await db.delete(shops).where(eq(shops.ownerUid, uid));
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
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: config.shopify.apiKey,
        client_secret: config.shopify.apiSecret,
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

// --- OAuth connect flow ---

// Build the Shopify authorize URL and register the OAuth `state` for this user.
export function startConnect(uid: string, shop: string): string {
  if (!isValidShop(shop)) {
    throw new BadRequest("Invalid shop. Use your-store.myshopify.com");
  }
  const state = crypto.randomBytes(16).toString("hex");
  pendingConnects.set(state, uid);

  const redirectUri = `${config.host}/auth/callback`;
  return (
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${config.shopify.apiKey}` +
    `&scope=${encodeURIComponent(config.shopify.scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`
  );
}

// Recover the owner uid for a callback `state` (single-use).
export function consumeState(state: string): string | undefined {
  const uid = pendingConnects.get(state);
  if (uid) pendingConnects.delete(state);
  return uid;
}

// Verify the HMAC on a Shopify callback to confirm it really came from Shopify.
export function verifyHmac(query: Record<string, any>, hmac: string): boolean {
  const message = Object.keys(query)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${query[key]}`)
    .join("&");
  const generated = crypto
    .createHmac("sha256", config.shopify.apiSecret)
    .update(message)
    .digest("hex");
  return (
    generated.length === hmac.length &&
    crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmac))
  );
}

// Exchange an authorization code for an (expiring) access token and store it.
export async function completeConnect(
  shop: string,
  code: string,
  ownerUid: string
): Promise<void> {
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecret,
      code,
      expiring: 1, // request an expiring offline token (non-expiring rejected)
    }),
  });
  if (!tokenRes.ok) {
    throw new AppError(502, "Failed to obtain access token");
  }
  await saveToken(shop, toRecord(await tokenRes.json()), ownerUid);
}

// --- Shopify Admin GraphQL ---

async function shopifyGraphql(
  shop: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<any> {
  const res = await fetch(
    `https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  return res.json();
}

// Resolve the caller's shop + a valid token, or throw the right HTTP error.
async function requireShopToken(uid: string): Promise<{ shop: string; token: string }> {
  const shop = await getShopForUser(uid);
  if (!shop) throw new Conflict("No store connected");
  const token = await getValidToken(shop);
  if (!token) throw new Unauthorized("Store token unavailable. Reconnect the store.");
  return { shop, token };
}

export async function listCollections(uid: string) {
  const { shop, token } = await requireShopToken(uid);
  const query = `{
    collections(first: 50) {
      edges { node { id title handle productsCount { count } } }
    }
  }`;
  const json = await shopifyGraphql(shop, token, query);
  if (json?.errors || json?.data?.collections == null) {
    console.error("Shopify API error:", JSON.stringify(json));
    throw new AppError(502, "Unexpected API response");
  }
  return json.data.collections.edges.map((e: any) => e.node);
}

export async function listCollectionProducts(uid: string, rawId: string) {
  if (!rawId) throw new BadRequest("Missing collection id. Use ?collection=<id>");
  const { shop, token } = await requireShopToken(uid);

  // Accept either a full gid or a bare numeric id.
  const collectionId = rawId.startsWith("gid://")
    ? rawId
    : `gid://shopify/Collection/${rawId}`;

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
  const json = await shopifyGraphql(shop, token, query, { id: collectionId });
  if (json?.errors || json?.data?.collection == null) {
    console.error("Shopify API error:", JSON.stringify(json));
    throw new AppError(502, "Collection not found");
  }
  const collection = json.data.collection;
  // Flatten the variant edges so each product carries a plain variants array.
  const products = collection.products.edges.map((e: any) => ({
    ...e.node,
    variants: e.node.variants.edges.map((v: any) => v.node),
  }));
  return { id: collection.id, title: collection.title, products };
}
