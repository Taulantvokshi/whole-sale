import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { parse } from "../../lib/validate";
import {
  createOrder,
  listOrders,
  getOrder,
  getSharePreview,
  claimShare,
  updateOrderByOwner,
  deleteOrder,
  updateOrderItem,
  addItemComment,
  getOrderItemProduct,
  submitOrder,
} from "./orders.service";

export const ordersRouter = Router();

const idParam = z.uuid("Invalid id");

const createSchema = z.object({
  templateId: z.uuid(),
  buyerId: z.uuid(),
});

const ownerUpdateSchema = z
  .object({
    status: z.enum(["pending", "submitted", "in_process", "completed"]).optional(),
    items: z
      .array(
        z.object({
          id: z.uuid(),
          wholesalePrice: z.string().nullish(),
          minQty: z.number().int().positive().optional(),
        })
      )
      .optional(),
  })
  .refine((v) => v.status !== undefined || v.items !== undefined, {
    message: "Provide status and/or items to update",
  });

const itemUpdateSchema = z
  .object({
    selected: z.boolean().optional(),
    buyerQty: z.number().int().nonnegative().optional(),
    comment: z.string().nullish(),
  })
  .refine(
    (v) =>
      v.selected !== undefined ||
      v.buyerQty !== undefined ||
      v.comment !== undefined,
    { message: "Nothing to update" }
  );

// --- Public share link (no auth) ---
ordersRouter.get(
  "/share/:token",
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getSharePreview(req.params.token));
  })
);

ordersRouter.post(
  "/share/:token/claim",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await claimShare(req.uid!, req.email, req.params.token));
  })
);

// --- Orders ---
ordersRouter.get(
  "/orders",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await listOrders(req.uid!));
  })
);

ordersRouter.post(
  "/orders",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = parse(createSchema, req.body);
    res.status(201).json(await createOrder(req.uid!, body));
  })
);

ordersRouter.get(
  "/orders/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    res.json(await getOrder(req.uid!, id));
  })
);

ordersRouter.patch(
  "/orders/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    const body = parse(ownerUpdateSchema, req.body);
    res.json(await updateOrderByOwner(req.uid!, id, body));
  })
);

ordersRouter.delete(
  "/orders/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    res.json(await deleteOrder(req.uid!, id));
  })
);

ordersRouter.patch(
  "/orders/:id/items/:itemId",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    const itemId = parse(idParam, req.params.itemId);
    const body = parse(itemUpdateSchema, req.body);
    res.json(await updateOrderItem(req.uid!, id, itemId, body));
  })
);

ordersRouter.get(
  "/orders/:id/items/:itemId/product",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    const itemId = parse(idParam, req.params.itemId);
    res.json(await getOrderItemProduct(req.uid!, id, itemId));
  })
);

const commentSchema = z.object({
  body: z.string().trim().min(1, "Write a message first").max(2000),
});

ordersRouter.post(
  "/orders/:id/items/:itemId/comments",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    const itemId = parse(idParam, req.params.itemId);
    const { body } = parse(commentSchema, req.body);
    res.status(201).json(await addItemComment(req.uid!, id, itemId, body));
  })
);

const submitSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.uuid(),
        selected: z.boolean().optional(),
        buyerQty: z.number().int().nonnegative().optional(),
      })
    )
    .optional(),
});

ordersRouter.post(
  "/orders/:id/submit",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    const { items } = parse(submitSchema, req.body ?? {});
    res.json(await submitOrder(req.uid!, id, items));
  })
);
