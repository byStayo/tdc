import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { durableDirectory, durableJSON } from "../publication-storage.ts";
import { operfPeriods, operfSignal, OPERF_INDEX, validInstant, validateOperfCapital, type OperfQuarter } from "./operf-capital.ts";
import { sourceFailureKind } from "./source-failure.ts";

type Capture = { bytes: Buffer; sha256: string; retrievedAt: string };
type Saved = { url: string; sha256: string; retrievedAt: string; gzip: string };
type Receipt = { version: 1; index: Saved; previous: Saved; current: Saved };
const limit = 2_000_000;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const numberPattern = /\(?\$[\d,]+\.\d\)?/g;
const rowPattern = /^\s*(?:\*\s*)?((?:19|20)\d{2})\s+(.+?)\s{2,}$/;
const headings = [
  /Vintage\s+Capital\s+Total Capital\s+Total Capital\s+Fair Market\s+Total Value/,
  /Partnership/, /Year\s+Commitment\s+Contributed\s+Distributed\s+Value\s+Multiple/,
];
const columnCount = 4;

function tenths(raw: string) {
  if (!/^(?:\$\d{1,3}(?:,\d{3})*\.\d|\(\$\d{1,3}(?:,\d{3})*\.\d\))$/.test(raw))
    throw Error("Unrecognized Oregon dollar field");
  const n = Number(raw.replace(/[^\d]/g, "")) * (raw.startsWith("(") ? -1 : 1);
  if (!Number.isSafeInteger(n)) throw Error("Oregon dollar field exceeds bounds");
  return n;
}

export function parseOperfTable(text: string, period: string) {
  const rows = new Map<string, number[]>(), sums = [0, 0, 0, 0];
  let total: number[] | undefined;
  const printed = new Intl.DateTimeFormat("en-US", {month: "long", day: "numeric", year: "numeric", timeZone: "UTC"}).format(new Date(period + "T12:00:00Z"));
  const pages = text.trim().split("\f");
  if (!pages.length || text.length > limit || /all rights reserved|copyright|©|confidential|proprietary|internal use only|distribution (?:is )?prohibited|may not be (?:copied|redistributed)/i.test(text))
    throw Error("Unexpected Oregon document format or usage notice");
  for (const page of pages) {
    const asOf = [...page.matchAll(/^\s*As of ([A-Za-z]+ \d{1,2}, \d{4})\s*$/gm)];
    if (!page.includes("Oregon Public Employees Retirement Fund") || !page.includes("Private Equity Portfolio") ||
        asOf.length !== 1 || asOf[0][1] !== printed || !page.includes("($ in millions)") || !headings.every(re => re.test(page)))
      throw Error("Oregon printed scope, quarter, units or column headings changed");
    for (const line of page.split(/\r?\n/)) {
      if (!/\$\d/.test(line) && !/^\s*(?:\*\s*)?(?:19|20)\d{2}\s/.test(line)) continue;
      const matches = [...line.matchAll(numberPattern)];
      if (total || matches.length !== columnCount) throw Error("Unrecognized or misplaced Oregon table row");
      if (matches.slice(1).some((m, i) => line.slice(matches[i].index! + matches[i][0].length, m.index).trim()))
        throw Error("Unexpected text within Oregon monetary columns");
      const values = matches.map(m => tenths(m[0])), prefix = line.slice(0, matches[0].index);
      if (values.slice(0, 3).some(n => n < 0)) throw Error("Negative Oregon commitment or lifetime cash balance");
      if (prefix.trim() === "Total") { total = values; continue; }
      const m = rowPattern.exec(prefix);
      if (!m) throw Error("Missing Oregon partnership name or vintage");
      const name = m[1] + "\t" + m[2].trim().replace(/\s+/g, " ");
      if (rows.has(name)) throw Error("Duplicate Oregon partnership and vintage");
      rows.set(name, values);
      values.forEach((value, i) => { sums[i] += value; });
    }
  }
  // Both the displayed rows and the separately rounded total are printed to $0.1m.
  if (!rows.size || !total || total.some((n, i) => Math.abs(n - sums[i]) > (rows.size + 1) / 2))
    throw Error("Oregon rows do not reconcile to their printed portfolio totals");
  return { rows, total, sums };
}

export function compareOperfTables(previous: ReturnType<typeof parseOperfTable>, current: ReturnType<typeof parseOperfTable>) {
  let commonFunds = 0, contributions = 0, distributions = 0, decreasingContributions = 0, decreasingDistributions = 0;
  for (const [key, latest] of current.rows) {
    const prior = previous.rows.get(key);
    if (!prior) continue;
    commonFunds++;
    const paid = latest[1] - prior[1], returned = latest[2] - prior[2];
    contributions += paid;
    distributions += returned;
    if (paid < 0) decreasingContributions++;
    if (returned < 0) decreasingDistributions++;
  }
  if (!commonFunds) throw Error("No exact Oregon fund and vintage pairs");
  return { previousFunds: previous.rows.size, currentFunds: current.rows.size, commonFunds,
    decreasingContributions, decreasingDistributions, changes: [contributions / 10, distributions / 10] as [number, number] };
}

function pdfText(bytes: Buffer): Promise<string> {
  if (bytes.subarray(0, 5).toString() !== "%PDF-" || !bytes.subarray(-4096).includes(Buffer.from("%%EOF")))
    throw Error("Expected an Oregon quarterly PDF");
  return new Promise((resolveText, reject) => {
    const child = execFile("pdftotext", ["-layout", "-", "-"], {timeout: 8_000, maxBuffer: limit, encoding: "utf8"},
      (error, stdout) => error ? reject(Error("Oregon PDF text could not be verified")) : resolveText(stdout));
    child.stdin!.on("error", () => { /* execFile supplies the final process result. */ });
    child.stdin!.end(bytes);
  });
}

function checkCapture(capture: Capture, cutoff: string) {
  if (!Buffer.isBuffer(capture.bytes) || !capture.bytes.length || capture.bytes.length > limit || sha(capture.bytes) !== capture.sha256 ||
      !validInstant(capture.retrievedAt) || capture.retrievedAt > cutoff) throw Error("Oregon document digest or collection time is invalid");
}
function pack(url: string, doc: Capture): Saved {
  return { url, sha256: doc.sha256, retrievedAt: doc.retrievedAt, gzip: gzipSync(doc.bytes).toString("base64") };
}
function unpack(saved: Saved, cutoff: string) {
  const capture = {sha256: saved.sha256, retrievedAt: saved.retrievedAt, bytes: gunzipSync(Buffer.from(saved.gzip, "base64"), {maxOutputLength: limit})};
  checkCapture(capture, cutoff);
  return capture;
}
const pairId = (previous: Saved, current: Saved) => sha(JSON.stringify([previous.url, previous.sha256, current.url, current.sha256]));

async function readReceipt(path: string): Promise<Receipt> {
  const st = await lstat(path);
  if (!st.isFile() || st.mode & 0o077 || st.size > 9_000_000 || !st.size) throw Error("Invalid private Oregon source receipt");
  return JSON.parse(await readFile(path, "utf8"));
}
async function reading(receipt: Receipt, retrievedAt: string, expected?: string) {
  if (receipt.version !== 1 || receipt.index.url !== OPERF_INDEX || !validInstant(retrievedAt) ||
      (expected && pairId(receipt.previous, receipt.current) !== expected)) throw Error("Wrong Oregon source pair");
  const index = unpack(receipt.index, retrievedAt);
  const firstObservedAt = [index.retrievedAt, receipt.previous.retrievedAt, receipt.current.retrievedAt].sort().at(-1)!;
  const periods = operfPeriods(index.bytes.toString("utf8"), index.retrievedAt);
  const saved = [receipt.previous, receipt.current];
  const tables = await Promise.all(periods.map(async (q: OperfQuarter, i) => {
    if (q.url !== saved[i].url || q.period > saved[i].retrievedAt.slice(0, 10)) throw Error("Oregon source identity or clock mismatch");
    const item = unpack(saved[i], retrievedAt);
    return parseOperfTable(await pdfText(item.bytes), q.period);
  }));
  const {changes, ...counts} = compareOperfTables(tables[0], tables[1]);
  const signal = operfSignal(retrievedAt, { previous: {...periods[0], sha256: saved[0].sha256},
    current: {...periods[1], sha256: saved[1].sha256}, firstObservedAt, ...counts }, changes);
  validateOperfCapital(signal, retrievedAt);
  return signal;
}

export async function replayOperfCapital(path: string, asOf = new Date().toISOString()) {
  const receipt = await readReceipt(path);
  if (basename(path) !== pairId(receipt.previous, receipt.current) + ".json") throw Error("Wrong private Oregon receipt identity");
  const first = [receipt.index.retrievedAt, receipt.previous.retrievedAt, receipt.current.retrievedAt].sort().at(-1)!;
  if (!validInstant(asOf) || !validInstant(first) || first > asOf) throw Error("Oregon comparison had not been observed by this cutoff");
  return reading(receipt, first);
}

export async function collectOperfCapital(fetchBytes: (url: string) => Promise<Capture>, directory?: string, now = () => new Date().toISOString()) {
  try {
    const index = await fetchBytes(OPERF_INDEX);
    checkCapture(index, now());
    const [prev, cur] = operfPeriods(index.bytes.toString("utf8"), index.retrievedAt);
    const [p, c] = await Promise.all([fetchBytes(prev.url), fetchBytes(cur.url)]);
    const at = now();
    checkCapture(p, at); checkCapture(c, at);
    const retrievedAt = [index.retrievedAt, p.retrievedAt, c.retrievedAt].sort().at(-1)!;
    const receipt: Receipt = {version: 1, index: pack(OPERF_INDEX, index), previous: pack(prev.url, p), current: pack(cur.url, c)};
    if (!directory) return await reading(receipt, retrievedAt);
    const key = pairId(receipt.previous, receipt.current), path = resolve(directory, key + ".json");
    await durableDirectory(directory, 0o700);
    let existing: Receipt | undefined;
    try { existing = await readReceipt(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing) return await reading(existing, retrievedAt, key);
    const result = await reading(receipt, retrievedAt);
    try { await durableJSON(path, receipt, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return await reading(await readReceipt(path), retrievedAt, key);
    }
    return result;
  } catch (error) {
    return {...operfSignal(now()), failureKind: sourceFailureKind(error)};
  }
}
