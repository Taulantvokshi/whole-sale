import { Request, Response, NextFunction } from "express";

// Allow the browser client (served from a different origin) to call the API.
// Permissive by design for the MVP; tighten the allowed origin later if needed.
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
}
