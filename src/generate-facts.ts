/**
 * Calls the OpenAI API to turn a chunk of interview text into structured,
 * machine-validated candidate facts (never raw `.facts` text - see
 * docs in the project README, "API usage").
 */
import OpenAI from "openai";
import type { ExtractionResult } from "./types.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

const MAX_CHUNK_CHARS = 12_000;

/**
 * Splits transcript text into paragraph-aligned chunks no larger than
 * `maxChars`, so long interviews can be sent to the model within a
 * reasonable context budget without splitting mid-sentence where avoidable.
 */
export function chunkText(text: string, maxChars: number = MAX_CHUNK_CHARS): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);

  // A single paragraph longer than maxChars still needs to be split so we
  // never silently skip content.
  return chunks.flatMap((chunk) => (chunk.length <= maxChars ? [chunk] : hardSplit(chunk, maxChars)));
}

function hardSplit(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    parts.push(text.slice(i, i + maxChars));
  }
  return parts;
}

const ARGUMENT_VARIANTS = [
  { kind: "atom", valueType: "string" },
  { kind: "string", valueType: "string" },
  { kind: "year", valueType: "integer" },
  { kind: "integer", valueType: "integer" },
  { kind: "decimal", valueType: "string" },
  { kind: "boolean", valueType: "boolean" },
] as const;

const EXTRACTION_RESULT_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          type: { type: "string" },
        },
        required: ["id", "label", "type"],
        additionalProperties: false,
      },
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          predicate: { type: "string" },
          arguments: {
            type: "array",
            items: {
              anyOf: ARGUMENT_VARIANTS.map((v) => ({
                type: "object",
                properties: {
                  kind: { type: "string", enum: [v.kind] },
                  value: { type: v.valueType },
                },
                required: ["kind", "value"],
                additionalProperties: false,
              })),
            },
          },
          evidence: { type: "string" },
          confidence: { type: "string", enum: ["explicit", "supported", "uncertain"] },
          page: { type: ["integer", "null"] },
        },
        required: ["predicate", "arguments", "evidence", "confidence", "page"],
        additionalProperties: false,
      },
    },
  },
  required: ["entities", "facts"],
  additionalProperties: false,
} as const;

/** Reported before/after each chunk's model call, so a caller can show progress during a slow multi-chunk run. */
export interface ExtractFactsProgress {
  chunkIndex: number;
  chunkCount: number;
  phase: "start" | "done";
  /** Only set when phase is "done". */
  factCount?: number;
  /** Only set when phase is "done". */
  elapsedMs?: number;
}

export interface ExtractFactsOptions {
  client: OpenAI;
  model: string;
  interviewName: string;
  fullText: string;
  /** Overrides MAX_CHUNK_CHARS; primarily for tests. */
  maxChunkChars?: number;
  /** Called before and after each chunk's model call, so long extractions don't look hung. */
  onProgress?: (progress: ExtractFactsProgress) => void;
}

/** Runs structured extraction over every chunk of an interview's text, returning one result per chunk. */
export async function extractFacts(options: ExtractFactsOptions): Promise<ExtractionResult[]> {
  const { client, model, interviewName, fullText, onProgress } = options;
  const chunks = chunkText(fullText, options.maxChunkChars);
  const results: ExtractionResult[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i]!;
    onProgress?.({ chunkIndex: i, chunkCount: chunks.length, phase: "start" });
    const startedAt = Date.now();

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: buildUserPrompt({ interviewName, chunkIndex: i, chunkCount: chunks.length, chunkText }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "extraction_result", schema: EXTRACTION_RESULT_SCHEMA, strict: true },
      },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error(`generate-facts: chunk ${i + 1}/${chunks.length} returned no content from the model`);
    }
    const result = JSON.parse(content) as ExtractionResult;
    results.push(result);
    onProgress?.({
      chunkIndex: i,
      chunkCount: chunks.length,
      phase: "done",
      factCount: result.facts.length,
      elapsedMs: Date.now() - startedAt,
    });
  }

  return results;
}
