import { ZodType } from "zod";
import { BadRequest } from "./errors";

// Parse an unknown payload (usually req.body) against a zod schema, throwing a
// 400 BadRequest with a readable message instead of zod's raw error shape.
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    throw new BadRequest(message);
  }
  return result.data;
}
