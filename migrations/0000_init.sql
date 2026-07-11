-- Baseline migration. Idempotent CREATEs so it is safe against the live DB
-- (which already has `users` and `shops`) and a fresh one. Foreign keys use a
-- plain ADD CONSTRAINT: the referenced/altered tables are all brand new, so the
-- constraints never pre-exist. (No DO/$$ blocks — drizzle-kit's statement
-- splitter mishandles dollar-quoted bodies.)
CREATE TABLE IF NOT EXISTS "buyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_uid" text NOT NULL,
	"business_name" text NOT NULL,
	"contact_email" text,
	"buyer_uid" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text,
	"title" text NOT NULL,
	"image_url" text,
	"wholesale_price" numeric(12, 2),
	"min_qty" integer DEFAULT 1 NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	"buyer_qty" integer DEFAULT 0 NOT NULL,
	"comment" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_uid" text NOT NULL,
	"buyer_id" uuid,
	"template_id" uuid,
	"share_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"submitted_at" timestamp with time zone,
	CONSTRAINT "orders_share_token_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shops" (
	"shop" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"refresh_token" text NOT NULL,
	"refresh_token_expires_at" bigint NOT NULL,
	"owner_uid" text,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"variant_id" text,
	"title" text NOT NULL,
	"image_url" text,
	"wholesale_price" numeric(12, 2),
	"min_qty" integer DEFAULT 1 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_uid" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"firebase_uid" text PRIMARY KEY NOT NULL,
	"email" text,
	"role" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" text;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_items" ADD CONSTRAINT "template_items_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;
