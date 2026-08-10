/**
 * Source acquisition: fetch a configured interview URL and cache the raw
 * bytes locally. Deliberately narrow - this pipeline only ever fetches a
 * single, curated URL per call. It never crawls or discovers links.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface FetchedSource {
  bytes: Buffer;
  /** SHA-256 of the raw fetched bytes. */
  checksum: string;
  /** Where the bytes were cached on disk. */
  cachePath: string;
}

/**
 * Downloads a source document with native `fetch`, caching it to
 * `source/<id>.pdf`. Throws a clear, descriptive error on any HTTP failure
 * rather than silently producing an empty/partial result.
 */
export async function fetchSource(url: string, id: string, sourceDir: string): Promise<FetchedSource> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch-source: failed to download ${url} (HTTP ${response.status} ${response.statusText})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length === 0) {
    throw new Error(`fetch-source: downloaded 0 bytes from ${url}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const looksLikePdf = contentType.includes("pdf") || bytes.subarray(0, 4).toString("latin1") === "%PDF";
  if (!looksLikePdf) {
    throw new Error(
      `fetch-source: ${url} did not return a PDF (content-type: "${contentType}"). ` +
        `Only PDF sources are currently supported.`,
    );
  }

  fs.mkdirSync(sourceDir, { recursive: true });
  const cachePath = path.join(sourceDir, `${id}.pdf`);
  fs.writeFileSync(cachePath, bytes);

  const checksum = createHash("sha256").update(bytes).digest("hex");
  return { bytes, checksum, cachePath };
}
