-- Per-user "last opened" marker for orders. Unread-comment badges = comments
-- from the other side newer than this timestamp. Upserted whenever a user
-- fetches the order; no realtime machinery needed.
CREATE TABLE IF NOT EXISTS "order_reads" (
	"order_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_reads_pk" PRIMARY KEY ("order_id", "uid"),
	CONSTRAINT "order_reads_order_fk"
		FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE
);
