# Server

TypeScript + Express server that serves an HTML page for merchants to OAuth
their Shopify store.

## Setup

```bash
cd server
npm install
cp .env.example .env   # then fill in your Shopify app credentials
npm run dev
```

Open http://localhost:3000, enter a `*.myshopify.com` domain, and click
**Install app**.

## OAuth flow

1. `GET /` — HTML page with the shop input form.
2. `GET /auth?shop=...` — redirects the merchant to Shopify's grant screen.
3. `GET /auth/callback` — verifies `state` + `hmac`, then exchanges the `code`
   for an access token.

## Shopify app config

In your [Shopify Partner dashboard](https://partners.shopify.com), set the
app's **Allowed redirection URL** to:

```
http://localhost:3000/auth/callback
```

> Note: persisting the access token is left as a `TODO` in `src/index.ts`.
> Node 18+ is required (uses the built-in `fetch`).
