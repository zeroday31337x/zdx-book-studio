import test from "node:test";
import assert from "node:assert/strict";
import { parseStructuredReview } from "../src/review-parser.js";

const valid = { verdict: "PASS", notes: ["Clear scene"], summary: "Characters uncover evidence.", continuityDelta: [], knowledgeDelta: [], relationshipDelta: [], originalityFlags: [] };
test("accepts complete structured reviews", () => {
  const result = parseStructuredReview(JSON.stringify(valid));
  assert.equal(result.verdict, "PASS");
  assert.equal(result.summary, valid.summary);
});
test("rejects malformed PASS with quoted fragments", () => {
  assert.throws(() => parseStructuredReview('{"verdict:PASS,notes:["Looks good","summary",": ["]}'), /invalid JSON/);
});
test("rejects incomplete JSON and missing summary", () => {
  assert.throws(() => parseStructuredReview(JSON.stringify({...valid, summary:""})), /schema validation/);
  assert.throws(() => parseStructuredReview(JSON.stringify({verdict:"PASS", notes:["ok"]})), /schema validation/);
  assert.throws(() => parseStructuredReview(JSON.stringify({...valid, continuityDelta:["fine"], unexpected:true})), /schema validation/);
});
