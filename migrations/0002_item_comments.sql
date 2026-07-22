-- Per-product comment threads: buyer and owner converse on each order item.
-- Replaces the single order_items.comment field (column kept for now so the
-- currently-deployed server keeps working until this code ships; its data is
-- backfilled below as the thread's first message).
CREATE TABLE IF NOT EXISTS "order_item_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid NOT NULL,
	"author_uid" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "order_item_comments_item_fk"
		FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_item_comments_item_idx"
	ON "order_item_comments" ("order_item_id");
--> statement-breakpoint
INSERT INTO "order_item_comments" ("order_item_id", "author_uid", "body", "created_at")
SELECT oi."id",
	coalesce(b."buyer_uid", o."owner_uid"),
	oi."comment",
	coalesce(o."updated_at", now())
FROM "order_items" oi
JOIN "orders" o ON o."id" = oi."order_id"
LEFT JOIN "buyers" b ON b."id" = o."buyer_id"
WHERE oi."comment" IS NOT NULL
	AND btrim(oi."comment") <> ''
	AND NOT EXISTS (
		SELECT 1 FROM "order_item_comments" c WHERE c."order_item_id" = oi."id"
	);
