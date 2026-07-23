import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  boolean,
  integer,
  numeric,
  timestamp,
  uuid,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// --- Existing tables (already present in the live DB) ---
// Columns mirror what server/src/index.ts created by hand. `role` is the one
// addition; the baseline migration guards it with IF NOT EXISTS so prod is safe.

export const users = pgTable("users", {
  firebaseUid: text("firebase_uid").primaryKey(),
  email: text("email"),
  // 'owner' | 'buyer' | 'admin' — set by the action that establishes it
  // (connect store -> owner, claim a share link -> buyer). Nullable until then.
  role: text("role"),
});

export const shops = pgTable("shops", {
  shop: text("shop").primaryKey(),
  accessToken: text("access_token").notNull(),
  // epoch-ms expiries stored as bigint (come back as JS numbers via mode).
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  refreshToken: text("refresh_token").notNull(),
  refreshTokenExpiresAt: bigint("refresh_token_expires_at", {
    mode: "number",
  }).notNull(),
  ownerUid: text("owner_uid"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

// --- New tables (wholesale MVP) ---

// A buyer business (e.g. "B-Jewelery") that belongs to one owner — this row IS
// the owner↔buyer connection. `buyerUid` is null until the buyer signs in and
// claims it via a share link (claim requires their email to match
// contactEmail; after that, identity is buyerUid and the email is just contact
// info). first/last name + email are required for new rows via route
// validation; columns stay nullable for legacy rows.
export const buyers = pgTable(
  "buyers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUid: text("owner_uid").notNull(),
    businessName: text("business_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    contactEmail: text("contact_email"),
    buyerUid: text("buyer_uid"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("buyers_owner_email_unique")
      .on(t.ownerUid, sql`lower(${t.contactEmail})`)
      .where(sql`${t.contactEmail} is not null`),
  ]
);

// A reusable curated product list the owner builds from their Shopify catalog.
export const templates = pgTable("templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUid: text("owner_uid").notNull(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const templateItems = pgTable("template_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  templateId: uuid("template_id")
    .notNull()
    .references(() => templates.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull(),
  variantId: text("variant_id"),
  title: text("title").notNull(),
  imageUrl: text("image_url"),
  wholesalePrice: numeric("wholesale_price", { precision: 12, scale: 2 }),
  minQty: integer("min_qty").notNull().default(1),
  position: integer("position").notNull().default(0),
});

// An order = a template shared with a buyer. Snapshots the template's items so
// later template edits don't mutate an in-flight order.
export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerUid: text("owner_uid").notNull(),
  buyerId: uuid("buyer_id").references(() => buyers.id, {
    onDelete: "set null",
  }),
  templateId: uuid("template_id").references(() => templates.id, {
    onDelete: "set null",
  }),
  shareToken: text("share_token").notNull().unique(),
  // 'pending' | 'submitted' | 'in_process' | 'completed'
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
});

export const orderItems = pgTable("order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull(),
  variantId: text("variant_id"),
  title: text("title").notNull(),
  imageUrl: text("image_url"),
  // Owner-set snapshot values.
  wholesalePrice: numeric("wholesale_price", { precision: 12, scale: 2 }),
  minQty: integer("min_qty").notNull().default(1),
  // Buyer-set values.
  selected: boolean("selected").notNull().default(false),
  buyerQty: integer("buyer_qty").notNull().default(0),
  // Legacy single comment — superseded by order_item_comments (kept so the
  // previously-deployed server keeps working; new code never writes it).
  comment: text("comment"),
  position: integer("position").notNull().default(0),
});

// Per-item conversation between the buyer and the owner. Author side is
// derived at read time by comparing authorUid against the order's ownerUid.
export const orderItemComments = pgTable("order_item_comments", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderItemId: uuid("order_item_id")
    .notNull()
    .references(() => orderItems.id, { onDelete: "cascade" }),
  authorUid: text("author_uid").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// When a user last opened an order — drives unread-comment badges.
export const orderReads = pgTable(
  "order_reads",
  {
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderId, t.uid] })]
);

// Inferred row types for use across services/routes.
export type UserRow = typeof users.$inferSelect;
export type ShopRow = typeof shops.$inferSelect;
export type BuyerRow = typeof buyers.$inferSelect;
export type TemplateRow = typeof templates.$inferSelect;
export type TemplateItemRow = typeof templateItems.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
