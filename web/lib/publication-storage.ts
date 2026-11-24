import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, link } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function durableDirectory(path: string, mode?: number): Promise<void> {
  const created = await mkdir(path, { recursive: true, mode });
  if (!created) return;
  let directory = path;
  for (;;) {
    await syncDirectory(directory);
    if (directory === dirname(created)) break;
    directory = dirname(directory);
  }
}

/** Sync content before exposing its name, then sync the directory entry. */
export async function durableJSON(path: string, value: unknown, immutable = false): Promise<void> {
  const directory = dirname(path);
  await durableDirectory(directory);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let failure: { error: unknown } | undefined;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    // Linking cannot overwrite an existing as-issued edition.
    if (immutable) await link(temporary, path);
    else await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    try {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await syncDirectory(directory);
    } catch (cleanupError) {
      if (failure) throw new AggregateError([failure.error, cleanupError], "Publication write and cleanup failed", { cause: failure.error });
      throw cleanupError;
    }
  }
}

/** The first verified source capture wins, including when two collectors run concurrently. */
export async function immutableSourceReceipt<T>(directory: string | undefined, filename: string, collect: () => Promise<T>,
  verify: (receipt: T) => void): Promise<T> {
  const path = directory && join(directory, filename);
  async function saved(file: string) {
    const receipt = JSON.parse(await readFile(file, "utf8")) as T;
    verify(receipt);
    return receipt;
  }
  if (path) {
    try { return await saved(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const fresh = await collect();
  verify(fresh);
  if (path && directory) {
    await durableDirectory(directory, 0o700);
    try { await durableJSON(path, fresh, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return saved(path);
    }
  }
  return fresh;
}
