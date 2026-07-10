import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

// The service-account JSON is provided base64-encoded via FIREBASE_SERVICE_ACCOUNT
// (avoids newline/quoting issues with the private key in env files).
const encoded = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!encoded) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
}

const serviceAccount = JSON.parse(
  Buffer.from(encoded, "base64").toString("utf8")
);

const app = initializeApp({
  credential: cert(serviceAccount),
});

// Verify a Firebase ID token and return its decoded claims (throws if invalid).
export function verifyIdToken(idToken: string) {
  return getAuth(app).verifyIdToken(idToken);
}
