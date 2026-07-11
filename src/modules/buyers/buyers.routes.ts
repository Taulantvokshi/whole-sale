import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { parse } from "../../lib/validate";
import { listBuyers, createBuyer, getBuyerWithOrders } from "./buyers.service";

export const buyersRouter = Router();

const createBuyerSchema = z.object({
  businessName: z.string().trim().min(1, "Business name is required"),
  contactEmail: z.email().optional().nullable(),
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

buyersRouter.get(
  "/buyers/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const id = parse(idParam, req.params.id);
    res.json(await getBuyerWithOrders(req.uid!, id));
  })
);
