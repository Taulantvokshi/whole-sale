import "express";

// Populated by the requireAuth middleware after verifying the Firebase ID token.
declare global {
  namespace Express {
    interface Request {
      uid?: string;
      email?: string;
    }
  }
}

export {};
