import { mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFinraPrivate } from "../lib/consensus/finra.ts";
import { loadFinraCredentials } from "./finra-credentials.ts";

try {
  const credentials = await loadFinraCredentials();
  if (!credentials) {
    console.error(
      "FINRA setup required: run npm run consensus:finra-setup yourself in Terminal with an activated free Public credential. Alternatively provide both FINRA_CLIENT_ID and FINRA_CLIENT_SECRET in the secure environment. Do not put credentials in chat or source control.",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await collectFinraPrivate(credentials);
      const directory = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../.consensus/finra-private",
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = resolve(directory, `latest-${process.pid}.tmp`);
      await writeFile(temporary, JSON.stringify(result, null, 2), {
        mode: 0o600,
      });
      await rename(temporary, resolve(directory, "latest.json"));
      console.log(
        JSON.stringify({
          status: "private-verified",
          weeks: result.weeks.length,
          symbols: [...new Set(result.weeks.map((w) => w.instrument))],
          latestWeek: result.weeks.at(-1)?.weekStart,
          published: false,
        }),
      );
    } catch {
      // Provider bodies and transport errors can contain request headers. Never log them.
      console.error(
        "FINRA private collection failed. No data published and no credentials logged. Verify the free Public credential and availability in FINRA's console.",
      );
      process.exitCode = 1;
    }
  }
} catch {
  console.error(
    "FINRA credential setup could not be loaded safely. Check the private local setup or supply both environment variables. No query was sent and no credential values were logged.",
  );
  process.exitCode = 2;
}
