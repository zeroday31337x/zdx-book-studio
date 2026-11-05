import { z } from "zod";
import type { ChapterReview } from "./types.js";

const reviewSchema = z.object({
  verdict: z.enum(["PASS", "NEEDS_CHANGES"]),
  notes: z.array(z.string().min(1)).max(50),
  summary: z.string().trim().min(1),
  continuityDelta: z.array(z.string()),
  knowledgeDelta: z.array(z.string()),
  relationshipDelta: z.array(z.string()),
  originalityFlags: z.array(z.string())
}).strict();

export function parseStructuredReview(text: string): ChapterReview {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let payload: unknown;
  try {
    payload = JSON.parse(clean);
  } catch {
    throw new Error("invalid JSON review envelope");
  }
  const result = reviewSchema.safeParse(payload);
  if (!result.success) throw new Error("review schema validation failed: " + result.error.issues.map(x => x.path.join(".") + " " + x.message).slice(0, 3).join("; "));
  return { ...result.data, reviewedAt: new Date().toISOString() };
}
