import { Request, Response, NextFunction } from "express";
import { verifyIdToken } from "../firebase";
import { Unauthorized, Forbidden } from "../lib/errors";
import { upsertUser, getUserRole, Role } from "../modules/users/users.service";

// The client logs in with Google via the Firebase web SDK and sends the
// resulting ID token as `Authorization: Bearer <token>`. We verify it here,
// attach uid/email to the request, and ensure a users row exists.
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    next(new Unauthorized());
    return;
  }
  // Verify the token first: a failure here means the token is bad (401).
  let decoded;
  try {
    decoded = await verifyIdToken(token);
  } catch {
    next(new Unauthorized("Invalid or expired token"));
    return;
  }
  req.uid = decoded.uid;
  req.email = decoded.email;
  // Persisting the user is a separate concern: a failure here is a real (500)
  // error, so let it propagate to the central error handler.
  try {
    await upsertUser(decoded.uid, decoded.email);
    next();
  } catch (err) {
    next(err);
  }
}

// Guard endpoints that require a specific role (e.g. 'admin').
export function requireRole(role: Role) {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const current = await getUserRole(req.uid!);
      if (current !== role) {
        next(new Forbidden());
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
