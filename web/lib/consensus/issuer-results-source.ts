import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import type { PublicDocument } from "./calendars.ts";
import { exhibitURL, filingIndex, readIssuerReportedRevenue, type ResultsFiling } from "./issuer-revenue.ts";

export type SecDocument = PublicDocument & { url: string };
export type SecReader = (url: string) => Promise<SecDocument>;
export type ExhibitReceipt = { filing: ResultsFiling; index: SecDocument; original: SecDocument };

export function verifySecDocument(doc: SecDocument, url: string, acceptedAt: string) {
  if (doc.url !== url || !Number.isFinite(Date.parse(doc.retrievedAt)) || new Date(doc.retrievedAt).toISOString() !== doc.retrievedAt ||
      doc.retrievedAt < acceptedAt || createHash("sha256").update(doc.text).digest("hex") !== doc.sha256)
    throw new Error("SEC filing source, capture time or digest differs");
}

export async function immutableSecReceipt<T>(directory: string | undefined, filename: string, collect: () => Promise<T>,
  verify: (receipt: T) => void): Promise<T> {
  const path = directory && join(directory, filename);
  if (path) {
    try {
      const receipt = JSON.parse(await readFile(path, "utf8")) as T;
      verify(receipt);
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const fresh = await collect();
  verify(fresh);
  if (path && directory) {
    await durableDirectory(directory, 0o700);
    try { await durableJSON(path, fresh, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const winner = JSON.parse(await readFile(path, "utf8")) as T;
      verify(winner);
      return winner;
    }
  }
  return fresh;
}

export function originalExhibit(filing: ResultsFiling, read: SecReader, directory?: string) {
  return immutableSecReceipt<ExhibitReceipt>(directory, filing.accession + ".json", async () => {
    const index = await read(filingIndex(filing));
    return { filing, index, original: await read(exhibitURL(filing, index.text)) };
  }, receipt => {
    if (JSON.stringify(receipt.filing) !== JSON.stringify(filing))
      throw new Error(`Original SEC filing metadata changed for ${filing.accession}`);
    verifySecDocument(receipt.index, filingIndex(filing), filing.acceptedAt);
    verifySecDocument(receipt.original, exhibitURL(filing, receipt.index.text), filing.acceptedAt);
    readIssuerReportedRevenue(filing, receipt.original.text);
  });
}
