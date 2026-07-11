import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { templates, templateItems } from "../../db/schema";
import { NotFound } from "../../lib/errors";

export interface TemplateItemInput {
  productId: string;
  variantId?: string | null;
  title: string;
  imageUrl?: string | null;
  wholesalePrice?: string | null;
  minQty?: number;
}

// List an owner's templates with a product count for each.
export async function listTemplates(ownerUid: string) {
  return db
    .select({
      id: templates.id,
      name: templates.name,
      createdAt: templates.createdAt,
      updatedAt: templates.updatedAt,
      itemCount: sql<number>`cast(count(${templateItems.id}) as int)`,
    })
    .from(templates)
    .leftJoin(templateItems, eq(templateItems.templateId, templates.id))
    .where(eq(templates.ownerUid, ownerUid))
    .groupBy(templates.id)
    .orderBy(desc(templates.createdAt));
}

// Rows to insert for a template's items, numbered by their order in the array.
function itemRows(templateId: string, items: TemplateItemInput[]) {
  return items.map((it, i) => ({
    templateId,
    productId: it.productId,
    variantId: it.variantId ?? null,
    title: it.title,
    imageUrl: it.imageUrl ?? null,
    wholesalePrice: it.wholesalePrice ?? null,
    minQty: it.minQty ?? 1,
    position: i,
  }));
}

export async function createTemplate(
  ownerUid: string,
  input: { name: string; items: TemplateItemInput[] }
) {
  return db.transaction(async (tx) => {
    const [template] = await tx
      .insert(templates)
      .values({ ownerUid, name: input.name })
      .returning();
    let items: (typeof templateItems.$inferSelect)[] = [];
    if (input.items.length > 0) {
      items = await tx
        .insert(templateItems)
        .values(itemRows(template.id, input.items))
        .returning();
    }
    return { ...template, items };
  });
}

// A single template (scoped to its owner) with its items in order.
export async function getTemplate(ownerUid: string, id: string) {
  const [template] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.ownerUid, ownerUid)));
  if (!template) throw new NotFound("Template not found");

  const items = await db
    .select()
    .from(templateItems)
    .where(eq(templateItems.templateId, id))
    .orderBy(templateItems.position);

  return { ...template, items };
}

// Update the name and/or fully replace the item list.
export async function updateTemplate(
  ownerUid: string,
  id: string,
  input: { name?: string; items?: TemplateItemInput[] }
) {
  return db.transaction(async (tx) => {
    const [template] = await tx
      .select()
      .from(templates)
      .where(and(eq(templates.id, id), eq(templates.ownerUid, ownerUid)));
    if (!template) throw new NotFound("Template not found");

    await tx
      .update(templates)
      .set({
        name: input.name ?? template.name,
        updatedAt: sql`now()`,
      })
      .where(eq(templates.id, id));

    if (input.items) {
      // Replace the whole item set — simplest correct model for edits.
      await tx.delete(templateItems).where(eq(templateItems.templateId, id));
      if (input.items.length > 0) {
        await tx.insert(templateItems).values(itemRows(id, input.items));
      }
    }
    return getTemplate(ownerUid, id);
  });
}

export async function deleteTemplate(ownerUid: string, id: string) {
  const deleted = await db
    .delete(templates)
    .where(and(eq(templates.id, id), eq(templates.ownerUid, ownerUid)))
    .returning({ id: templates.id });
  if (deleted.length === 0) throw new NotFound("Template not found");
}
