import { Request, Response, NextFunction, RequestHandler } from "express";

// Wrap an async route handler so any thrown/rejected error is forwarded to the
// central error handler instead of crashing the request. Lets handlers `throw`
// AppError (or anything) instead of writing try/catch in every route.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
