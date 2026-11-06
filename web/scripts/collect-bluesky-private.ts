import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPrivateBluesky, type PrivateBlueskyOperation } from "../lib/bluesky-private.ts";

try {
  const args = process.argv.slice(2);
  let operation: PrivateBlueskyOperation;
  if (args[0] === "--publish" && args.length === 1) operation = { kind: "publish" };
  else if (args[0] === "--invalidate" && args.length === 1) operation = { kind: "invalidate" };
  else if (args[0] === "--exclude-stdin" && args.length === 1) {
    // Verified report subject via stdin, never account identifiers in argv or logs.
    let input = "";
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 2048) throw new Error(); }
    operation = { kind: "exclude", identifier: input.trim() };
  } else if (args.length === 0 || (args.length === 2 && args[0] === "--seconds")) {
    operation = { kind: "collect", seconds: args.length ? Number(args[1]) : 120 };
  } else throw new Error();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  console.log(JSON.stringify(await runPrivateBluesky(root, operation)));
} catch {
  console.error("Bluesky private operation failed safely. Check the bounded arguments, private storage, publisher lock and stream availability. No post, account identifier, response body or credential was logged. Nothing was published.");
  process.exitCode = 1;
}
