/**
 * Text extraction: pulls the embedded text layer out of a PDF. Deliberately
 * does not fall back to OCR - if a source has no usable text layer, this
 * pipeline fails clearly instead of guessing at content from images.
 */
import * as fs from "node:fs";
import * as path from "node:path";
// pdf-parse ships as CommonJS with no default-export typings for its main
// entry; importing the module namespace and invoking it works reliably.
import pdfParse from "pdf-parse";
import { createHash } from "node:crypto";

const MIN_USABLE_TEXT_LENGTH = 200;

export interface ExtractedText {
  text: string;
  pageCount: number;
  /** SHA-256 of the extracted plain text (used for provenance, distinct from the PDF byte checksum). */
  checksum: string;
  cachePath: string;
}

/**
 * Extracts the embedded text layer of a PDF and caches it as plain text
 * alongside the source PDF. Throws if the extracted text is implausibly
 * short, which usually means the PDF is a scan with no text layer -
 * OCR is out of scope, so we fail rather than produce facts from nothing.
 */
export async function extractPdfText(pdfBytes: Buffer, id: string, sourceDir: string): Promise<ExtractedText> {
  const parsed = await pdfParse(pdfBytes);
  const text = parsed.text.trim();

  if (text.length < MIN_USABLE_TEXT_LENGTH) {
    throw new Error(
      `extract-text: only extracted ${text.length} characters of text from "${id}". ` +
        `This usually means the PDF has no embedded text layer (e.g. a scanned document). ` +
        `This pipeline does not use OCR, so this source cannot be processed reliably.`,
    );
  }

  fs.mkdirSync(sourceDir, { recursive: true });
  const cachePath = path.join(sourceDir, `${id}.txt`);
  fs.writeFileSync(cachePath, text, "utf8");

  const checksum = createHash("sha256").update(text, "utf8").digest("hex");
  return { text, pageCount: parsed.numpages, checksum, cachePath };
}
