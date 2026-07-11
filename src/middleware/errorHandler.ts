import { Request, Response, NextFunction } from "express";
import { AppError } from "../lib/errors";

// Central Express error handler. Must be registered last, after all routers.
// Maps AppError -> its status; anything else -> 500. Keeps route handlers free
// of repetitive try/catch + res.status().json() boilerplate.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong" });
}
