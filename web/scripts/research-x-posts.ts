import { mkdir, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { marketInstruments, marketStances, MINIMUM_PARTICIPANTS, X_STANCE_METHOD, type LanguageCue } from "../lib/consensus/bluesky.ts";
import { fetchText, localConfig, xSearchQueries } from "./collect-following-feeds.ts";

const replies = process.argv.length === 3 && process.argv[2] === "--supplement-replies";
if (process.argv.length > 2 && !replies) throw Error("Use --supplement-replies only for the existing partial run");
const totalTarget = 10_000;
const maximumRead = replies ? 3_000 : 11_000;
const maximumRequests = 140;
const syntax = ` lang:en -is:retweet ${replies ? "is:reply" : "-is:reply"} -is:quote`;
const id = (value: unknown): value is string => typeof value === "string" && /^\d{1,25}$/.test(value);
type Counts = Record<LanguageCue, number>;
type Cue = { at: string; baseline: LanguageCue; current: LanguageCue };
type Bucket = { day: string; instrument: string; cohort: string; posts: number; authors: Map<string, Cue> };
const empty = (): Counts => ({ upward: 0, downward: 0, mixed: 0, unclassified: 0 });

const config = await localConfig();
const bearer = (config.xPublic as { bearerToken?: unknown } | undefined)?.bearerToken;
if (typeof bearer !== "string" || !/^[!-~]{1,2048}$/.test(bearer)) throw Error("X public search is not configured");
let end = Date.now() - 30_000;
let start = new Date(end - 7 * 86_400_000 + 15 * 60_000).toISOString();
let cutoff = new Date(end).toISOString();
const directory = resolve(homedir(), ".local/share/daily-consensus");
await mkdir(directory, { recursive: true, mode: 0o700 });
const directoryInfo = await lstat(directory);
if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid?.() || (directoryInfo.mode & 0o777) !== 0o700)
  throw Error("X research directory must be owner-only");
const path = resolve(directory, `x-posts-${cutoff.slice(0, 10)}.sqlite`);
if (!replies) await (await open(path, "wx", 0o600)).close();
const databaseInfo = await lstat(path);
if (!databaseInfo.isFile() || databaseInfo.uid !== process.getuid?.() || (databaseInfo.mode & 0o777) !== 0o600)
  throw Error("X research database must be owner-only");
const db = new DatabaseSync(path);
const seen = new Set<string>();
const buckets = new Map<string, Bucket>();
let read = 0;
let requests = 0;
let status = "complete";
let target = totalTarget;

async function collect(terms: string, cohort: string, limit: number) {
  let remaining = limit;
  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.search = new URLSearchParams({ query: terms + syntax, start_time: start, end_time: cutoff,
    "tweet.fields": "author_id,created_at,lang,referenced_tweets,withheld" }).toString();
  const cursors = new Set<string>();
  while (remaining > 0 && seen.size < target && maximumRead - read >= 10 && requests < maximumRequests) {
    const limit = Math.min(100, Math.max(10, remaining), maximumRead - read);
    url.searchParams.set("max_results", String(limit));
    requests++;
    // App-only recent search can only access public content. Avoid separate billable user reads.
    const body = JSON.parse(await fetchText(url, { Authorization: "Bearer " + bearer }));
    const rows = body.data ?? [];
    if (!Array.isArray(rows) || rows.length > limit || body.meta?.result_count !== rows.length)
      throw Error("Invalid X research page");
    read += rows.length;
    remaining -= rows.length;
    for (const row of rows) {
      if (seen.size >= target) break;
      if (!row || !id(row.id) || !id(row.author_id) || seen.has(row.id) || row.lang !== "en" ||
          row.withheld !== undefined || typeof row.text !== "string" ||
          row.text.length > 12_000 || typeof row.created_at !== "string" ||
          !(Date.parse(row.created_at) >= Date.parse(start) && Date.parse(row.created_at) <= end)) continue;
      const references = row.referenced_tweets;
      if (replies ? !Array.isArray(references) || !references.length || references.some(ref => ref?.type !== "replied_to")
        : references !== undefined) continue;
      const instruments = marketInstruments(row.text).filter(instrument => instrument !== "MARKET");
      if (!instruments.length) continue;
      seen.add(row.id);
      const baseline = marketStances(row.text);
      const current = marketStances(row.text, "x");
      const day = row.created_at.slice(0, 10);
      for (const instrument of instruments) {
        const key = JSON.stringify([day, instrument, cohort]);
        const bucket = buckets.get(key) ?? { day, instrument, cohort, posts: 0, authors: new Map<string, Cue>() };
        buckets.set(key, bucket);
        bucket.posts++;
        const prior = bucket.authors.get(row.author_id);
        if (!prior || prior.at < row.created_at)
          bucket.authors.set(row.author_id, { at: row.created_at,
            baseline: baseline[instrument] ?? "unclassified", current: current[instrument] ?? "unclassified" });
      }
    }
    const cursor = body.meta.next_token;
    if (typeof cursor !== "string" || !cursor || cursor.length > 2048 || cursors.has(cursor)) break;
    cursors.add(cursor);
    url.searchParams.set("next_token", cursor);
  }
}

try {
  if (replies) {
    const prior = db.prepare("SELECT * FROM run").all();
    const first = prior[0];
    if (prior.length !== 1 || first?.status !== "insufficient_unique_results" || first.target !== totalTarget ||
        typeof first.unique_posts !== "number" || first.unique_posts >= totalTarget ||
        typeof first.starts_at !== "string" || Date.parse(first.starts_at) < Date.now() - 7 * 86_400_000 ||
        typeof first.cutoff !== "string") throw Error("No eligible partial original-post run to supplement");
    db.exec("CREATE TABLE reply_attempt (reserved INTEGER NOT NULL)");
    start = first.starts_at;
    cutoff = first.cutoff;
    end = Date.parse(cutoff);
    target = totalTarget - first.unique_posts;
  } else db.exec(`CREATE TABLE run (cutoff TEXT, starts_at TEXT, target INTEGER, unique_posts INTEGER,
      api_rows INTEGER, requests INTEGER, status TEXT, classifier TEXT);
    CREATE TABLE cohorts (day TEXT, instrument TEXT, cohort TEXT, posts INTEGER, participants INTEGER,
      baseline_up INTEGER, baseline_down INTEGER, baseline_mixed INTEGER, baseline_unclassified INTEGER,
      current_up INTEGER, current_down INTEGER, current_mixed INTEGER, current_unclassified INTEGER,
      PRIMARY KEY (day, instrument, cohort));`);
  const terms = Object.values(xSearchQueries);
  try {
    if (replies) {
      await collect("($SPY OR $QQQ OR $IWM OR $DIA OR $TLT)", "replies", maximumRead);
    } else {
      for (const term of terms) {
        await collect(`${term} (bullish OR upside OR "going long")`, "upward_keywords", 100);
        await collect(`${term} (bearish OR downside OR "going short")`, "downward_keywords", 100);
      }
      for (const term of terms) await collect(term, "broad", 300);
      await collect(`(${terms.join(" OR ")})`, "broad", maximumRead);
    }
    if (seen.size < target) status = "insufficient_unique_results";
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    status = /^Source HTTP \d{3}$/.test(message) ? message : "collection_interrupted";
  }
  db.exec("BEGIN IMMEDIATE");
  const insert = db.prepare("INSERT INTO cohorts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const bucket of buckets.values()) {
    const baseline = empty(), current = empty();
    for (const cue of bucket.authors.values()) {
      baseline[cue.baseline]++;
      current[cue.current]++;
    }
    const counts = bucket.authors.size < MINIMUM_PARTICIPANTS ? Array<null>(8).fill(null) :
      [...Object.values(baseline), ...Object.values(current)];
    insert.run(bucket.day, bucket.instrument, bucket.cohort, bucket.posts, bucket.authors.size, ...counts);
  }
  db.prepare("INSERT INTO run VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(cutoff, start, target, seen.size, read, requests, status, X_STANCE_METHOD);
  db.exec("COMMIT");
  console.log(JSON.stringify({ status, uniquePosts: seen.size, totalUniquePosts: totalTarget - target + seen.size,
    apiRows: read, requests, database: path,
    cohorts: db.prepare(`SELECT instrument, cohort, sum(posts) AS posts, sum(participants) AS author_days,
      sum(baseline_up) AS baseline_up, sum(baseline_down) AS baseline_down,
      sum(current_up) AS current_up, sum(current_down) AS current_down
      FROM cohorts GROUP BY instrument, cohort ORDER BY instrument, cohort`).all() }));
  if (status !== "complete") process.exitCode = 1;
} finally {
  db.close();
}
