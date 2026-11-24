import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPrivateBluesky, type PrivateBlueskyOperation } from "../lib/bluesky-private.ts";
import { BlueskyFailure, blueskyFailureReport } from "../lib/consensus/bluesky-failure.ts";

async function operationFrom(args: string[]): Promise<PrivateBlueskyOperation> {
  if (args[0] === "--publish" && args.length === 1) return { kind: "publish" };
  if (args[0] === "--invalidate" && args.length === 1) return { kind: "invalidate" };
  if (args[0] === "--exclude-stdin" && args.length === 1) {
    // Verified report subject via stdin, never account identifiers in argv or logs.
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 2048) throw new BlueskyFailure("invalid_arguments");
    }
    return { kind: "exclude", identifier: input.trim() };
  }
  if (args.length === 2 && args[0] === "--recent-seconds") return { kind: "collect", recentSeconds: Number(args[1]) };
  if (args.length === 0 || (args.length === 2 && args[0] === "--seconds")) {
    return { kind: "collect", seconds: args.length ? Number(args[1]) : 120 };
  }
  throw new BlueskyFailure("invalid_arguments");
}

export async function runPrivateBlueskyCommand(root: string, args: string[]): Promise<number> {
  try {
    const operation = await operationFrom(args);
    console.log(JSON.stringify(await runPrivateBluesky(root, operation)));
    return 0;
  } catch (error) {
    console.error(JSON.stringify(blueskyFailureReport(error)));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = await runPrivateBlueskyCommand(root, process.argv.slice(2));
}
