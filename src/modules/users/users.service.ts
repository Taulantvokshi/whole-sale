import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { users, shops } from "../../db/schema";

export type Role = "owner" | "buyer" | "admin";

// Ensure a row exists for this Firebase user (first login creates it). New users
// default to 'buyer' — only an admin promotes someone to 'owner'. Existing rows
// keep their role (we only update the email on conflict).
export async function upsertUser(uid: string, email?: string): Promise<void> {
  await db
    .insert(users)
    .values({ firebaseUid: uid, email: email ?? null, role: "buyer" })
    .onConflictDoUpdate({
      target: users.firebaseUid,
      set: { email: email ?? null },
    });
}

// Set a user's role. Only overwrites when the role actually changes so we don't
// clobber an existing role (e.g. an admin who later connects a store).
export async function setRole(uid: string, role: Role): Promise<void> {
  await db.update(users).set({ role }).where(eq(users.firebaseUid, uid));
}

// Assign a role only when the user has none yet — never demotes an existing
// owner/admin (e.g. an owner claiming a buyer invite keeps their role).
export async function setRoleIfUnset(uid: string, role: Role): Promise<void> {
  await db
    .update(users)
    .set({ role })
    .where(and(eq(users.firebaseUid, uid), isNull(users.role)));
}

export async function getUserRole(uid: string): Promise<string | null> {
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.firebaseUid, uid));
  return rows[0]?.role ?? null;
}

// Who am I? Returns the logged-in user, their role, and their connected store.
export async function getMe(uid: string, email?: string) {
  const [roleRows, shopRows] = await Promise.all([
    db.select({ role: users.role }).from(users).where(eq(users.firebaseUid, uid)),
    db.select({ shop: shops.shop }).from(shops).where(eq(shops.ownerUid, uid)),
  ]);
  return {
    uid,
    email: email ?? null,
    role: roleRows[0]?.role ?? null,
    shop: shopRows[0]?.shop ?? null,
  };
}
