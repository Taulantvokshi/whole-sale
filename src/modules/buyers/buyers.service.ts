import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { buyers, orders } from "../../db/schema";
import { NotFound } from "../../lib/errors";

// All buyer businesses that belong to an owner. `registered` is true when the
// buyer already has an account — either already linked (buyer_uid) or their
// contact email matches an existing user. Registered buyers can be sent orders
// directly (no share link needed).
export async function listBuyers(ownerUid: string) {
  return db
    .select({
      id: buyers.id,
      ownerUid: buyers.ownerUid,
      businessName: buyers.businessName,
      contactEmail: buyers.contactEmail,
      buyerUid: buyers.buyerUid,
      createdAt: buyers.createdAt,
      registered: sql<boolean>`(${buyers.buyerUid} is not null or exists (
        select 1 from users u where lower(u.email) = lower(${buyers.contactEmail})
      ))`,
    })
    .from(buyers)
    .where(eq(buyers.ownerUid, ownerUid))
    .orderBy(desc(buyers.createdAt));
}

export async function createBuyer(
  ownerUid: string,
  input: { businessName: string; contactEmail?: string | null }
) {
  const [row] = await db
    .insert(buyers)
    .values({
      ownerUid,
      businessName: input.businessName,
      contactEmail: input.contactEmail ?? null,
    })
    .returning();
  return row;
}

// A single buyer (scoped to its owner) plus the orders under that business.
export async function getBuyerWithOrders(ownerUid: string, buyerId: string) {
  const [buyer] = await db
    .select()
    .from(buyers)
    .where(and(eq(buyers.id, buyerId), eq(buyers.ownerUid, ownerUid)));
  if (!buyer) throw new NotFound("Buyer not found");

  const buyerOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.buyerId, buyerId))
    .orderBy(desc(orders.createdAt));

  return { ...buyer, orders: buyerOrders };
}
