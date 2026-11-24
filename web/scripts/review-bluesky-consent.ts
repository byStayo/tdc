import { closeSync, openSync, watch } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ReadStream } from "node:tty";
import type { SocialAnnotation } from "../lib/consensus/social-annotation-source.ts";

const enterScreen = "\u001b[?1049h";
const clearScreen = "\u001b[2J\u001b[H";
const leaveScreen = "\u001b[?1049l";
const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP"] as const;

export function requireConsentReviewTerminal() {
  if (!process.stdout.isTTY || !process.env.TERM || process.env.TERM === "dumb")
    throw new Error("A local terminal is required for Bluesky blind review");
}

function displayText(text: string) {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => char === "\n" ? "\n" : `<U+${char.codePointAt(0)!.toString(16)}>`);
}

export async function reviewBlueskyConsent(path: string, expiresAt: string, items: SocialAnnotation[]) {
  requireConsentReviewTerminal();
  const deadline = Date.parse(expiresAt);
  const remaining = deadline - Date.now();
  if (!(remaining > 0) || !items.length) throw new Error("No current Bluesky reviews");
  const fd = openSync("/dev/tty", "r");
  let input: ReadStream;
  try { input = new ReadStream(fd); } catch (error) { closeSync(fd); throw error; }
  const reviewer = createInterface({ input, output: process.stdout, terminal: false });
  const stop = new AbortController();
  const abort = () => stop.abort();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(remaining)]);
  let watcher: ReturnType<typeof watch> | undefined;
  let screen = false;
  try {
    watcher = watch(path, { persistent: false }, abort);
    watcher.once("error", abort);
    reviewer.once("close", abort);
    input.once("error", abort);
    for (const event of signals) process.once(event, abort);
    process.stdout.write(enterScreen);
    screen = true;
    for (let next = 0; next < items.length && !signal.aborted && Date.now() < deadline;) {
      const { ref, instrument, text } = items[next];
      process.stdout.write(`${clearScreen}${next + 1}/${items.length}  ${instrument}\n${ref}\n\n${displayText(text)}\n\n`);
      const answer = (await reviewer.question("Enter next, p previous, q close > ", { signal })).trim().toLowerCase();
      if (answer === "q") break;
      if (answer === "p") next = Math.max(0, next - 1);
      if (answer === "") next++;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    if (screen) process.stdout.write(clearScreen + leaveScreen);
    for (const event of signals) process.off(event, abort);
    watcher?.close();
    reviewer.close();
    input.destroy();
  }
}
