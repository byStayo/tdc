import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type FinraCredentials = { clientId: string; clientSecret: string };
const setupError = () =>
  new Error(
    "FINRA credentials are incomplete, invalid, or not private. Run the local FINRA setup command; credential values are never logged.",
  );

function validate(value: unknown): FinraCredentials {
  if (!value || typeof value !== "object") throw setupError();
  const { clientId, clientSecret } = value as Partial<FinraCredentials>;
  if (
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    !clientId.trim() ||
    !clientSecret.trim() ||
    clientId.length > 4096 ||
    clientSecret.length > 4096 ||
    /[:\r\n\0]/.test(clientId) ||
    /[\r\n\0]/.test(clientSecret)
  )
    throw setupError();
  return { clientId, clientSecret };
}

function privateOwner(stat: { mode: number; uid: number }): boolean {
  return (
    (stat.mode & 0o077) === 0 &&
    (typeof process.getuid !== "function" || stat.uid === process.getuid())
  );
}

/** Local publisher only. Never import this module into the website or log its result. */
export async function loadFinraCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
  path = join(homedir(), ".config/the-daily-consensus/finra.json"),
): Promise<FinraCredentials | null> {
  // Explicit environments take precedence, but never mix two different sources.
  if (env.FINRA_CLIENT_ID !== undefined || env.FINRA_CLIENT_SECRET !== undefined) {
    return validate({
      clientId: env.FINRA_CLIENT_ID,
      clientSecret: env.FINRA_CLIENT_SECRET,
    });
  }
  try {
    const directory = await lstat(dirname(path));
    if (!directory.isDirectory() || !privateOwner(directory)) throw setupError();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        !privateOwner(stat) ||
        stat.size > 32768 ||
        stat.nlink !== 1
      )
        throw setupError();
      return validate(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // JSON and operating-system exceptions must not expose file contents or values.
    throw setupError();
  }
}
