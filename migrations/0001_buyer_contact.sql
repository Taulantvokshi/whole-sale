-- Buyer contact identity: first/last name + one buyer per (owner, email).
-- Pre-launch data: before the unique index can build, null out the email on all
-- but the newest duplicate row per (owner, email). Identity lives in buyer_uid,
-- so a claimed duplicate keeps its link either way.
ALTER TABLE "buyers" ADD COLUMN IF NOT EXISTS "first_name" text;
--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN IF NOT EXISTS "last_name" text;
--> statement-breakpoint
UPDATE "buyers" b SET "contact_email" = NULL
WHERE "contact_email" IS NOT NULL AND EXISTS (
	SELECT 1 FROM "buyers" b2
	WHERE b2."owner_uid" = b."owner_uid"
		AND lower(b2."contact_email") = lower(b."contact_email")
		AND b2."id" <> b."id"
		AND (b2."created_at" > b."created_at"
			OR (b2."created_at" = b."created_at" AND b2."id" > b."id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "buyers_owner_email_unique"
	ON "buyers" ("owner_uid", lower("contact_email"))
	WHERE "contact_email" IS NOT NULL;
