import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { buyers, orders, orderItems, users } from "../../db/schema";
import { Conflict, NotFound, isUniqueViolation } from "../../lib/errors";

// `registered` is true when the buyer already has a buyer account — either
// already linked (buyer_uid) or their contact email matches an existing user
// with role 'buyer'. The role filter matters: it keeps an owner's own account
// from being treated as (and later auto-linked to) a buyer. Registered buyers
// can be sent orders directly (no share link needed), so this predicate must
// stay in sync with the auto-link query in orders.service.ts.
const registeredSql = sql<boolean>`(${buyers.buyerUid} is not null or exists (
  select 1 from users u
  where lower(u.email) = lower(${buyers.contactEmail}) and u.role = 'buyer'
))`;

const buyerColumns = {
  id: buyers.id,
  ownerUid: buyers.ownerUid,
  businessName: buyers.businessName,
  firstName: buyers.firstName,
  lastName: buyers.lastName,
  contactEmail: buyers.contactEmail,
  buyerUid: buyers.buyerUid,
  createdAt: buyers.createdAt,
  // The email of the Google account that actually claimed this buyer — shown
  // to the owner when it differs from contactEmail.
  accountEmail: users.email,
};

// All buyer businesses that belong to an owner, with order rollups for the
// directory view (how many sheets shared, when the last one went out).
export async function listBuyers(ownerUid: string) {
  return db
    .select({
      ...buyerColumns,
      registered: registeredSql,
      orderCount: sql<number>`cast((select count(*) from orders o where o.buyer_id = ${buyers.id}) as int)`,
      lastOrderAt: sql<string | null>`(select max(o.created_at) from orders o where o.buyer_id = ${buyers.id})`,
    })
    .from(buyers)
    .leftJoin(users, eq(users.firebaseUid, buyers.buyerUid))
    .where(eq(buyers.ownerUid, ownerUid))
    .orderBy(desc(buyers.createdAt));
}

export async function createBuyer(
  ownerUid: string,
  input: {
    businessName: string;
    firstName: string;
    lastName: string;
    contactEmail: string;
  }
) {
  try {
    const [row] = await db
      .insert(buyers)
      .values({
        ownerUid,
        businessName: input.businessName,
        firstName: input.firstName,
        lastName: input.lastName,
        contactEmail: input.contactEmail,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err))
      throw new Conflict("You already have a buyer with this email");
    throw err;
  }
}

// Owner edits contact info. Never touches buyer_uid: once claimed, identity is
// the linked account — changing the contact email must not unlink the buyer.
export async function updateBuyer(
  ownerUid: string,
  buyerId: string,
  input: {
    businessName?: string;
    firstName?: string;
    lastName?: string;
    contactEmail?: string;
  }
) {
  try {
    const [row] = await db
      .update(buyers)
      .set(input)
      .where(and(eq(buyers.id, buyerId), eq(buyers.ownerUid, ownerUid)))
      .returning();
    if (!row) throw new NotFound("Buyer not found");
    return row;
  } catch (err) {
    if (isUniqueViolation(err))
      throw new Conflict("You already have a buyer with this email");
    throw err;
  }
}

// Remove a buyer connection. Orders are kept (orders.buyer_id is ON DELETE
// SET NULL) but detach from the business — and the buyer's account loses
// access to them, since access is derived through the buyer row.
export async function deleteBuyer(ownerUid: string, buyerId: string) {
  const deleted = await db
    .delete(buyers)
    .where(and(eq(buyers.id, buyerId), eq(buyers.ownerUid, ownerUid)))
    .returning({ id: buyers.id });
  if (deleted.length === 0) throw new NotFound("Buyer not found");
  return { deleted: true };
}

// A single buyer (scoped to its owner) plus the orders under that business.
// Orders carry the same rollups as listOrders so the client renders them with
// the same card everywhere.
export async function getBuyerWithOrders(ownerUid: string, buyerId: string) {
  const [buyer] = await db
    .select(buyerColumns)
    .from(buyers)
    .leftJoin(users, eq(users.firebaseUid, buyers.buyerUid))
    .where(and(eq(buyers.id, buyerId), eq(buyers.ownerUid, ownerUid)));
  if (!buyer) throw new NotFound("Buyer not found");

  const buyerOrders = await db
    .select({
      id: orders.id,
      status: orders.status,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      submittedAt: orders.submittedAt,
      buyerId: orders.buyerId,
      ownerUid: orders.ownerUid,
      itemCount: sql<number>`cast(count(${orderItems.id}) as int)`,
      selectedUnits: sql<number>`cast(coalesce(sum(case when ${orderItems.selected} then ${orderItems.buyerQty} else 0 end), 0) as int)`,
      totalValue: sql<number>`cast(coalesce(sum(case when ${orderItems.selected} then ${orderItems.buyerQty} * coalesce(${orderItems.wholesalePrice}, 0) else 0 end), 0) as float8)`,
    })
    .from(orders)
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(eq(orders.buyerId, buyerId))
    .groupBy(orders.id)
    .orderBy(desc(orders.createdAt));

  return {
    ...buyer,
    orders: buyerOrders.map((o) => ({
      ...o,
      businessName: buyer.businessName,
      storeName: null,
    })),
  };
}
