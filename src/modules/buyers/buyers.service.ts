import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { buyers, orders } from "../../db/schema";
import { NotFound } from "../../lib/errors";

// All buyer businesses that belong to an owner.
export async function listBuyers(ownerUid: string) {
  return db
    .select()
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
