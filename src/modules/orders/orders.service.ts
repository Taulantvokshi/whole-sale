import crypto from "crypto";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import {
  orders,
  orderItems,
  templates,
  templateItems,
  buyers,
  users,
} from "../../db/schema";
import { config } from "../../config";
import { BadRequest, Forbidden, NotFound } from "../../lib/errors";
import { setRole } from "../users/users.service";

function shareUrl(token: string): string {
  return `${config.clientUrl}/share/${token}`;
}

// --- Owner: share a template with a buyer, creating an order ---

export async function createOrder(
  ownerUid: string,
  input: { templateId: string; buyerId: string }
) {
  return db.transaction(async (tx) => {
    const [template] = await tx
      .select()
      .from(templates)
      .where(
        and(eq(templates.id, input.templateId), eq(templates.ownerUid, ownerUid))
      );
    if (!template) throw new NotFound("Template not found");

    const [buyer] = await tx
      .select()
      .from(buyers)
      .where(and(eq(buyers.id, input.buyerId), eq(buyers.ownerUid, ownerUid)));
    if (!buyer) throw new NotFound("Buyer not found");

    // If the buyer isn't linked yet but their contact email matches an existing
    // account, link them now so the order goes straight to that user's dashboard.
    if (!buyer.buyerUid && buyer.contactEmail) {
      const [match] = await tx
        .select({ uid: users.firebaseUid })
        .from(users)
        .where(sql`lower(${users.email}) = lower(${buyer.contactEmail})`);
      if (match) {
        await tx.update(buyers).set({ buyerUid: match.uid }).where(eq(buyers.id, buyer.id));
        buyer.buyerUid = match.uid;
      }
    }

    const token = crypto.randomBytes(24).toString("hex");
    const [order] = await tx
      .insert(orders)
      .values({
        ownerUid,
        buyerId: buyer.id,
        templateId: template.id,
        shareToken: token,
        status: "pending",
      })
      .returning();

    // Snapshot the template's items so later template edits don't change the order.
    const srcItems = await tx
      .select()
      .from(templateItems)
      .where(eq(templateItems.templateId, template.id))
      .orderBy(templateItems.position);

    if (srcItems.length > 0) {
      await tx.insert(orderItems).values(
        srcItems.map((it) => ({
          orderId: order.id,
          productId: it.productId,
          variantId: it.variantId,
          title: it.title,
          imageUrl: it.imageUrl,
          wholesalePrice: it.wholesalePrice,
          minQty: it.minQty,
          position: it.position,
        }))
      );
    }

    return { ...order, shareUrl: shareUrl(token), buyer };
  });
}

// --- Access control ---

// Return the order if `uid` may access it (its owner, or the buyer who claimed
// its business); otherwise throw. Also returns the buyer row for convenience.
async function requireOrderAccess(uid: string, orderId: string) {
  const [row] = await db
    .select({ order: orders, buyer: buyers })
    .from(orders)
    .leftJoin(buyers, eq(orders.buyerId, buyers.id))
    .where(eq(orders.id, orderId));
  if (!row) throw new NotFound("Order not found");

  const isOwner = row.order.ownerUid === uid;
  const isBuyer = row.buyer?.buyerUid === uid;
  if (!isOwner && !isBuyer) throw new Forbidden();
  return { order: row.order, buyer: row.buyer, isOwner, isBuyer };
}

async function loadOrderItems(orderId: string) {
  return db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(orderItems.position);
}

// --- Read ---

// Orders visible to a user: those they own, plus those for a business they
// claimed. Includes per-order rollups (item count, selected units, and the
// estimated value = Σ selected qty × wholesale price) for list/dashboard views.
export async function listOrders(uid: string) {
  return db
    .select({
      id: orders.id,
      status: orders.status,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      submittedAt: orders.submittedAt,
      buyerId: orders.buyerId,
      businessName: buyers.businessName,
      itemCount: sql<number>`cast(count(${orderItems.id}) as int)`,
      selectedUnits: sql<number>`cast(coalesce(sum(case when ${orderItems.selected} then ${orderItems.buyerQty} else 0 end), 0) as int)`,
      totalValue: sql<number>`cast(coalesce(sum(case when ${orderItems.selected} then ${orderItems.buyerQty} * coalesce(${orderItems.wholesalePrice}, 0) else 0 end), 0) as float8)`,
    })
    .from(orders)
    .leftJoin(buyers, eq(orders.buyerId, buyers.id))
    .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
    .where(or(eq(orders.ownerUid, uid), eq(buyers.buyerUid, uid)))
    .groupBy(orders.id, buyers.id)
    .orderBy(desc(orders.createdAt));
}

export async function getOrder(uid: string, orderId: string) {
  const { order, buyer } = await requireOrderAccess(uid, orderId);
  const items = await loadOrderItems(orderId);
  return { ...order, buyer, items };
}

// --- Share link (public preview + claim) ---

export async function getSharePreview(token: string) {
  const [row] = await db
    .select({ order: orders, buyer: buyers })
    .from(orders)
    .leftJoin(buyers, eq(orders.buyerId, buyers.id))
    .where(eq(orders.shareToken, token));
  if (!row) throw new NotFound("Link not found");

  const items = await loadOrderItems(row.order.id);
  // Read-only view: no owner uid / tokens leaked.
  return {
    id: row.order.id,
    status: row.order.status,
    businessName: row.buyer?.businessName ?? null,
    claimed: row.buyer?.buyerUid != null,
    items,
  };
}

// A signed-in Google user claims the business behind a share link so they can
// edit/submit. Sets the buyer's uid + marks the user as a buyer.
export async function claimShare(uid: string, token: string) {
  const [row] = await db
    .select({ order: orders, buyer: buyers })
    .from(orders)
    .leftJoin(buyers, eq(orders.buyerId, buyers.id))
    .where(eq(orders.shareToken, token));
  if (!row || !row.buyer) throw new NotFound("Link not found");

  const buyer = row.buyer;
  if (buyer.buyerUid && buyer.buyerUid !== uid) {
    throw new Forbidden("This business is already linked to another account");
  }
  if (!buyer.buyerUid) {
    await db.update(buyers).set({ buyerUid: uid }).where(eq(buyers.id, buyer.id));
    await setRole(uid, "buyer");
  }
  return getOrder(uid, row.order.id);
}

// --- Edits ---

const ALLOWED_STATUSES = ["pending", "submitted", "in_process", "completed"] as const;
type Status = (typeof ALLOWED_STATUSES)[number];

// Owner updates order status (and can tweak item owner-fields).
export async function updateOrderByOwner(
  ownerUid: string,
  orderId: string,
  input: {
    status?: Status;
    items?: { id: string; wholesalePrice?: string | null; minQty?: number }[];
  }
) {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.ownerUid, ownerUid)));
  if (!order) throw new NotFound("Order not found");

  await db.transaction(async (tx) => {
    if (input.status) {
      await tx
        .update(orders)
        .set({ status: input.status, updatedAt: sql`now()` })
        .where(eq(orders.id, orderId));
    }
    for (const it of input.items ?? []) {
      await tx
        .update(orderItems)
        .set({
          ...(it.wholesalePrice !== undefined
            ? { wholesalePrice: it.wholesalePrice }
            : {}),
          ...(it.minQty !== undefined ? { minQty: it.minQty } : {}),
        })
        .where(and(eq(orderItems.id, it.id), eq(orderItems.orderId, orderId)));
    }
  });

  return getOrder(ownerUid, orderId);
}

// Buyer (or owner) edits a single line item's buyer-facing fields.
export async function updateOrderItem(
  uid: string,
  orderId: string,
  itemId: string,
  input: { selected?: boolean; buyerQty?: number; comment?: string | null }
) {
  await requireOrderAccess(uid, orderId);
  const updated = await db
    .update(orderItems)
    .set({
      ...(input.selected !== undefined ? { selected: input.selected } : {}),
      ...(input.buyerQty !== undefined ? { buyerQty: input.buyerQty } : {}),
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    })
    .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)))
    .returning();
  if (updated.length === 0) throw new NotFound("Item not found");
  return updated[0];
}

// Buyer submits ("Send order").
export async function submitOrder(uid: string, orderId: string) {
  const { isBuyer } = await requireOrderAccess(uid, orderId);
  if (!isBuyer) throw new Forbidden("Only the buyer can send the order");
  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (order.status !== "pending") {
    throw new BadRequest(`Order is already ${order.status}`);
  }
  await db
    .update(orders)
    .set({ status: "submitted", submittedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(orders.id, orderId));
  return getOrder(uid, orderId);
}
