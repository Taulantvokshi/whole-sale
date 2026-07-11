import { Router, Request, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { getMe } from "./users.service";

export const usersRouter = Router();

// Who am I? Returns the logged-in user, their role, and their connected store.
usersRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getMe(req.uid!, req.email));
  })
);
