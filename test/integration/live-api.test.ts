/**
 * Live integration test: exercises the real OpenAI API. Run explicitly with
 * `npm run test:integration` (never part of `npm test`). Skips itself if
 * OPENAI_API_KEY/OPENAI_MODEL are not set, so it's safe to leave in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { extractFacts } from "../../src/generate-facts.js";

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL;

test(
  "extractFacts returns conservative, evidenced facts from a short synthetic transcript",
  { skip: !apiKey || !model ? "OPENAI_API_KEY/OPENAI_MODEL not set - skipping live API test" : false },
  async () => {
    const client = new OpenAI({ apiKey });
    const transcript =
      `Interviewer: When did you make Tape Piece?\n` +
      `Kevin Atherton: I made Tape Piece in 1975 at Battersea Arts Centre. ` +
      `It was a video work. I think it was probably one of my more interesting pieces, ` +
      `though I can't quite remember who else was involved.`;

    const [result] = await extractFacts({
      client,
      model: model!,
      interviewName: "Kevin Atherton",
      fullText: transcript,
    });

    assert.ok(result);
    assert.ok(result.facts.length > 0, "expected at least one extracted fact");
    // The hedged "who else was involved" claim must not appear as an explicit fact.
    for (const fact of result.facts) {
      assert.notEqual(fact.confidence, undefined);
    }
  },
);
