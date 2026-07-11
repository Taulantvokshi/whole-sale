# Server Architecture Plan

How to restructure `server/` from one 440-line `src/index.ts` into a **modular
routes + services** layout backed by **Drizzle ORM** and **drizzle-kit migrations**,
so the new buyers / templates / orders / share features have a clean home.

## Decisions (confirmed)

- **Layering:** modular — one folder per feature under `src/modules/`, each with a
  `*.routes.ts` (Express router) + `*.service.ts` (SQL + business logic).
- **Data access:** **Drizzle ORM** — schema-as-code in TypeScript, wraps the existing
  `pg` Pool (`src/db.ts`). Chosen over Prisma because it reuses the current connection
  layer and is a smaller departure from the existing raw-`pg` code.
- **Migrations:** **drizzle-kit** — versioned SQL under `server/migrations/`, applied
  by an `npm run db:migrate` step (deploy + local).

---

## Target directory layout

```
server/
  drizzle.config.ts            # drizzle-kit config: schema path, out=./migrations, dialect=postgresql, DATABASE_URL
  migrations/                  # generated SQL migrations (committed) + meta/
  .env.example                 # UPDATE: add DATABASE_URL, FIREBASE_SERVICE_ACCOUNT, CLIENT_URL (currently stale)
  package.json                 # + drizzle-orm, drizzle-kit; + db:generate / db:migrate / db:studio scripts
  src/
    index.ts                   # bootstrap ONLY: build app, global middleware, mount routers, listen
    config.ts                  # parse + validate all env once; throws on missing; exported typed object
    db/
      client.ts                # drizzle(pool) — wraps the pool from db.ts; exports `db`
      schema.ts                # all Drizzle table defs (users, shops, buyers, templates, template_items, orders, order_items)
      migrate.ts               # runs pending migrations via drizzle-orm's migrator — used by db:migrate
                               #   NOTE: db:migrate runs this (node -r ts-node/register) NOT `drizzle-kit migrate`,
                               #   whose CLI swallows errors and mishandles the Render SSL connection.
    db.ts                      # existing pg Pool (kept; client.ts builds drizzle on top of it)
    firebase.ts                # unchanged (verifyIdToken)
    middleware/
      cors.ts                  # the CORS block moved out of index.ts
      auth.ts                  # requireAuth, AuthedRequest, requireRole('admin')
      asyncHandler.ts          # wrap async handlers -> forward thrown errors to errorHandler
      errorHandler.ts          # central: maps AppError -> {status, json}; last app.use
    lib/
      errors.ts                # AppError + BadRequest/Unauthorized/Forbidden/NotFound/Conflict
      validate.ts              # zod helper: parse body/query or throw BadRequest
    modules/
      users/
        users.routes.ts        # GET /me (role, shop, counts)
        users.service.ts       # upsertUser, setRole, getMe
      shopify/
        shopify.routes.ts      # /connect, /auth/callback, /collections, /products, /disconnect
        shopify.service.ts     # token store (saveToken/getValidToken/toRecord), OAuth, GraphQL calls, pendingConnects
      buyers/
        buyers.routes.ts       # GET/POST /buyers, GET /buyers/:id
        buyers.service.ts
      templates/
        templates.routes.ts    # CRUD /templates
        templates.service.ts
      orders/
        orders.routes.ts       # /orders, /orders/:id, PATCH, /orders/:id/items/:itemId, /orders/:id/submit,
                               #  GET /share/:token (no auth), POST /share/:token/claim
        orders.service.ts      # snapshot template->order_items, share_token, status transitions, assertCanAccessOrder
    types.ts                   # shared server types; re-export Drizzle-inferred row types ($inferSelect/$inferInsert)
```

**What moves out of today's `index.ts`:**
- CORS middleware → `middleware/cors.ts`.
- `requireAuth` / `AuthedRequest` / `upsertUser` → `middleware/auth.ts` + `users.service.ts`.
- `TokenRecord`, `toRecord`, `saveToken`, `getTokenRecord`, `getShopForUser`, `getValidToken`, `isValidShop`, `pendingConnects`, `/connect`, `/auth/callback`, `/collections`, `/products`, `/disconnect` → `modules/shopify/`.
- `/me` → `modules/users/`.
- Env reads (SHOPIFY_*, HOST, PORT, CLIENT_URL) → `config.ts`.
After the move, `index.ts` is just: create app → `cors` → `express.json()` → `express.static(public)` → mount each module router → `errorHandler` → `listen`.

---

## Drizzle setup

1. **Install:** `drizzle-orm` (dep), `drizzle-kit` (dev). Optionally `zod` for validation.
2. **`src/db/client.ts`:** `import { pool } from "../db"; export const db = drizzle(pool);`
   — reuses the one pool (SSL logic in `db.ts` stays as-is).
3. **`src/db/schema.ts`:** define tables with `pgTable`. Map camelCase fields to the
   existing snake_case columns exactly (`firebase_uid`, `access_token`, `owner_uid`, …)
   so nothing in the live DB breaks. New: `users.role`, and the buyers/templates/orders tables
   from `PLAN.md`.
4. **`drizzle.config.ts`:** `{ schema: "./src/db/schema.ts", out: "./migrations", dialect: "postgresql", dbCredentials: { url: process.env.DATABASE_URL } }`.
5. **Scripts** (`package.json`):
   - `db:generate` = `drizzle-kit generate` — diff schema → new SQL migration (dev, commit it).
   - `db:migrate` = `ts-node src/db/migrate.ts` (or compiled) — apply pending migrations.
   - `db:studio` = `drizzle-kit studio` (optional GUI).

### Baseline the existing DB (do this FIRST — the live DB already has `users` + `shops`)
Do **not** let the first migration try to `CREATE` `users`/`shops` — they exist in
Render Postgres already. Two safe paths:
- **Introspect:** run `drizzle-kit introspect` against the live DB to generate the schema
  for the current `users`/`shops`, adopt that as `schema.ts`'s starting point, then add
  `role` + the new tables and `db:generate` — the first real migration only contains the
  *deltas* (add `role` column + create new tables).
- **Or** hand-write `schema.ts`, generate the init migration, and mark it applied on the
  live DB (insert into drizzle's `__drizzle_migrations`) so it isn't re-run.
The introspect path is safer and self-documenting. Local/empty DBs then get everything
from the migrations cleanly.

---

## Cross-cutting patterns (reduce per-endpoint boilerplate)

- **Errors:** services `throw new NotFound(...)` / `Forbidden(...)`; `asyncHandler` wraps
  every handler so thrown errors reach `errorHandler`, which formats `{ error }` + status.
  Replaces the repeated `try/catch { res.status(...).json(...) }` in today's handlers.
- **Auth/roles:** `requireAuth` (existing behavior) attaches `uid`/`email` and upserts the
  user; add `requireRole('admin')` for `/admin` endpoints. `assertCanAccessOrder(uid, order)`
  lives in `orders.service.ts` (owner_uid or buyer_uid match; admin bypass).
- **Validation:** `lib/validate.ts` + zod schemas per POST/PATCH body (`/buyers`,
  `/templates`, order item edits) → throw `BadRequest` on bad input.
- **Config:** `config.ts` validates required env at boot (`DATABASE_URL`,
  `FIREBASE_SERVICE_ACCOUNT`, `SHOPIFY_API_KEY/SECRET`, `HOST`, `CLIENT_URL`, …) and fails
  fast with a clear message. Every module imports from `config`, not `process.env`.

---

## Deploy / workflow changes

- **Local dev:** `npm run db:migrate` once, then `npm run dev` (ts-node-dev) as today.
- **Render:** add `npm run db:migrate` as a pre-deploy/release step (or run at start of
  `start` before `node dist/index.js`). Ensure `migrations/` ships with the build (it's
  raw SQL read at runtime, not compiled by `tsc`).
- **`build`** stays `tsc`; **`start`** stays `node dist/index.js` (optionally
  `db:migrate && node dist/index.js`).
- Update **`.env.example`** to list every required var (currently missing `DATABASE_URL`
  and `FIREBASE_SERVICE_ACCOUNT`, which the app hard-requires).

---

## Suggested order for the refactor

1. Add Drizzle + `config.ts` + `db/client.ts`; **introspect/baseline** `users`+`shops`.
2. Carve `middleware/` (cors, auth, asyncHandler, errorHandler) + `lib/errors.ts` out of `index.ts`.
3. Move Shopify + `/me` into `modules/shopify` and `modules/users`; slim `index.ts` to bootstrap. **Verify existing flows still work** (connect, collections, products, /me) — pure refactor, no behavior change.
4. Add `schema.ts` tables for buyers/templates/orders → `db:generate` first feature migration.
5. Build `modules/buyers`, `modules/templates`, `modules/orders` per `PLAN.md`.

Steps 1–3 are a behavior-preserving refactor; do them before adding features so the new
endpoints land in the clean structure.

## Verification

- After step 3: `npm run dev`, confirm `/me`, `/collections`, `/products`, connect, and
  disconnect behave exactly as before (regression — no functional change).
- After `db:migrate` on a local empty DB: `psql \dt` shows all tables; on the live DB the
  baseline migration adds only `role` + new tables (existing data untouched).
- Then follow `PLAN.md`'s end-to-end checks for the feature endpoints.
```
