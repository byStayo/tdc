import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Snapshot } from "./types.ts";

let saved: Snapshot | undefined;

/** Parse the published JSON bytes directly so bundling cannot round frozen scores. */
export function publishedSnapshot(): Snapshot {
  if (saved) return saved;
  const snapshot: Snapshot = JSON.parse(readFileSync(join(process.cwd(), "lib/consensus/current.json"), "utf8"));
  if (process.env.NODE_ENV === "production") saved = snapshot;
  return snapshot;
}
