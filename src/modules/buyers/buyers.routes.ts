import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { parse } from "../../lib/validate";
import {
  listBuyers,
  createBuyer,
  updateBuyer,
  deleteBuyer,
  getBuyerWithOrders,
} from "./buyers.service";

export const buyersRouter = Router();

// Contact email is required: claiming a share link is gated on the signed-in
// account's email matching it. Normalized to lowercase at the boundary so the
// unique index and claim comparison stay simple.
const contactEmail = z
  .email("A valid contact email is required")
  .transform((e) => e.trim().toLowerCase());

const createBuyerSchema = z.object({
  businessName: z.string().trim().min(1, "Business name is required"),
  firstName: z.string().trim().min(1, "First name is required"),
  lastName: z.string().trim().min(1, "Last name is required"),
  contactEmail,
});

const updateBuyerSchema = z
  .object({
    businessName: z.string().trim().min(1).optional(),
    firstName: z.string().trim().min(1).optional(),
    lastName: z.string().trim().min(1).optional(),
    contactEmail: contactEmail.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: "Nothing to update",
  });

const idParam = z.uuid("Invalid buyer id");

buyersRouter.get(
  "/buyers",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await listBuyers(req.uid!));
  })
);

buyersRouter.post(
  "/buyers",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const body = parse(createBuyerSchema, req.body);
    res.status(201).json(await createBuyer(req.uid!, body));
  })
);

buyersRouter.patch(
  "/buyers/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    const body = parse(updateBuyerSchema, req.body);
    res.json(await updateBuyer(req.uid!, id, body));
  })
);

buyersRouter.delete(
  "/buyers/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    res.json(await deleteBuyer(req.uid!, id));
  })
);

buyersRouter.get(
  "/buyers/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    res.json(await getBuyerWithOrders(req.uid!, id));
  })
);
