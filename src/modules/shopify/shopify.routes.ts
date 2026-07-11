import { Router, Request, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { setRole } from "../users/users.service";
import { config } from "../../config";
import {
  startConnect,
  consumeState,
  verifyHmac,
  completeConnect,
  deleteShopForUser,
  isValidShop,
  listCollections,
  listCollectionProducts,
} from "./shopify.service";

export const shopifyRouter = Router();

// Step 1: the logged-in user starts connecting their store. Returns the Shopify
// authorize URL for the client to redirect to.
shopifyRouter.get(
  "/connect",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const url = startConnect(req.uid!, String(req.query.shop || ""));
    res.json({ url });
  })
);

// Step 2: Shopify redirects back here with a code we exchange for a token.
// No auth header on this request — we recover the owner from the OAuth `state`.
shopifyRouter.get(
  "/auth/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const { shop, code, state, hmac } = req.query as Record<string, string>;

    if (!shop || !code || !state || !hmac) {
      return res.status(400).send("Missing required parameters");
    }
    if (!isValidShop(shop)) {
      return res.status(400).send("Invalid shop");
    }
    const ownerUid = consumeState(state);
    if (!ownerUid) {
      return res.status(403).send("Invalid state");
    }
    if (!verifyHmac(req.query as Record<string, any>, hmac)) {
      return res.status(403).send("HMAC validation failed");
    }

    try {
      await completeConnect(shop, code, ownerUid);
      await setRole(ownerUid, "owner");
      console.log(`Connected ${shop} for user ${ownerUid}`);
      // Back to the app; the client will now see the connected store via /me.
      res.redirect(`${config.clientUrl}/?connected=1`);
    } catch (err) {
      console.error(err);
      res.status(502).send("Something went wrong during installation");
    }
  })
);

// Disconnect the user's store: remove the stored token/link entirely.
// Logging out does NOT do this — only an explicit disconnect.
shopifyRouter.post(
  "/disconnect",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await deleteShopForUser(req.uid!);
    res.json({ disconnected: true });
  })
);

// List the connected shop's collections.
shopifyRouter.get(
  "/collections",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await listCollections(req.uid!));
  })
);

// List the products in a single collection (?collection=<id>).
shopifyRouter.get(
  "/products",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await listCollectionProducts(req.uid!, String(req.query.collection || "")));
  })
);
