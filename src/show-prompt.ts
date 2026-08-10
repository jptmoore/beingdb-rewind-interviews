#!/usr/bin/env node
/** Prints the exact prompt text sent to the model, for review/audit without calling the API. */
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

console.log("=== SYSTEM PROMPT ===\n");
console.log(SYSTEM_PROMPT);

console.log("\n=== EXAMPLE USER PROMPT (chunk 1 of 1) ===\n");
console.log(
  buildUserPrompt({
    interviewName: "Kevin Atherton",
    chunkIndex: 0,
    chunkCount: 1,
    chunkText: "[... transcript chunk text goes here ...]",
  }),
);
