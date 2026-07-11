import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { parse } from "../../lib/validate";
import {
  listTemplates,
  createTemplate,
  getTemplate,
  updateTemplate,
  deleteTemplate,
} from "./templates.service";

export const templatesRouter = Router();

const itemSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().nullish(),
  title: z.string().min(1),
  imageUrl: z.string().nullish(),
  // Prices come from Shopify as strings; keep them as strings end-to-end.
  wholesalePrice: z.string().nullish(),
  minQty: z.number().int().positive().optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  items: z.array(itemSchema).default([]),
});

const updateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    items: z.array(itemSchema).optional(),
  })
  .refine((v) => v.name !== undefined || v.items !== undefined, {
    message: "Provide name and/or items to update",
  });

const idParam = z.uuid("Invalid template id");

templatesRouter.get(
  "/templates",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await listTemplates(req.uid!));
  })
);

templatesRouter.post(
  "/templates",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = parse(createSchema, req.body);
    res.status(201).json(await createTemplate(req.uid!, body));
  })
);

templatesRouter.get(
  "/templates/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    res.json(await getTemplate(req.uid!, id));
  })
);

templatesRouter.patch(
  "/templates/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    const body = parse(updateSchema, req.body);
    res.json(await updateTemplate(req.uid!, id, body));
  })
);

templatesRouter.delete(
  "/templates/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    await deleteTemplate(req.uid!, id);
    res.json({ deleted: true });
  })
);
