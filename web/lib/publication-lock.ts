import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

// macOS/Linux publication host: a kernel-held advisory lock survives neither a
// crash nor reboot. Never unlink this inode: unlink/recreate permits two owners.
// Python's stdlib exposes flock without installing a native Node dependency.
const HOLDER = String.raw`
import fcntl, json, os, sys, datetime
path, kind, parent, token = sys.argv[1:]
def fail(message):
    print(message, file=sys.stderr, flush=True)
    sys.exit(23)
fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'r+') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fail('Publication lock is busy')
    old = lock.read(8192)
    if old:
        try:
            prior = json.loads(old)
            if not isinstance(prior, dict): raise ValueError()
        except (ValueError, TypeError):
            fail('Unrecognized legacy publication lock; inspect its owner')
        if prior.get('scheme') != 'posix-flock-v1':
            pid = prior.get('pid')
            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                fail('Unrecognized legacy publication lock; inspect its owner')
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                pass
            except PermissionError:
                fail('Legacy publication lock owner cannot be checked')
            else:
                fail('Legacy publication lock owner is alive')
    record = dict(scheme='posix-flock-v1', token=token, kind=kind,
                  pid=int(parent), holderPid=os.getpid(),
                  startedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    def save():
        lock.seek(0); lock.truncate(); json.dump(record, lock); lock.flush(); os.fsync(lock.fileno())
    save()
    print('locked', flush=True)
    # EOF also arrives if the Node parent is killed; no age-based eviction.
    sys.stdin.buffer.read()
    record['releasedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()
`;

export async function acquirePublicationLock(root: string, kind: string): Promise<() => Promise<void>> {
  await mkdir(resolve(root, ".editorial"), { recursive: true, mode: 0o700 });
  const child = spawn("python3", ["-u", "-c", HOLDER, resolve(root, ".editorial/publish.lock"), kind, String(process.pid), randomUUID()], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "", output = "", released = false, acquired = false;
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-4096); });
  // Install both listeners immediately, including the spawn-error path.
  const done = new Promise<void>((resolveDone, rejectDone) => {
    child.once("error", (error) => rejectDone(new Error(`Publication lock requires Python 3 on the local POSIX publisher: ${error.message}`)));
    child.once("close", (code) => code === 0 ? resolveDone() : rejectDone(new Error(errors.trim() || `Publication lock holder exited (${code})`)));
  });
  // An unexpected holder exit must stop the publishing process, not leave an
  // unprotected transaction running. The normal release sets its flag first.
  void done.then(() => { if (acquired && !released) process.kill(process.pid, "SIGTERM"); }, () => {
    if (acquired && !released) process.kill(process.pid, "SIGTERM");
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("locked\n")) { acquired = true; resolveReady(); }
    });
    void done.then(() => { if (!acquired) rejectReady(new Error("Publication lock exited before acquisition")); }, rejectReady);
  });
  return async () => {
    if (!released) { released = true; child.stdin.end(); }
    await done;
  };
}
