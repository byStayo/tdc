import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFinraCredentials } from "../scripts/finra-credentials.ts";

const fixture = { clientId: "synthetic-client", clientSecret: "synthetic-secret-$'\\value" };
async function location() {
  const dir = await mkdtemp(join(tmpdir(), "finra-credentials-"));
  await chmod(dir, 0o700);
  return { dir, path: join(dir, "finra.json") };
}

test("FINRA credential selection never mixes a partial environment with a local credential", async () => {
  const { dir, path } = await location();
  try {
    await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
    assert.deepEqual(await loadFinraCredentials({}, path), fixture);
    assert.deepEqual(await loadFinraCredentials({ FINRA_CLIENT_ID: "env-client", FINRA_CLIENT_SECRET: "env-secret" }, path), { clientId: "env-client", clientSecret: "env-secret" });
    await assert.rejects(loadFinraCredentials({ FINRA_CLIENT_ID: "env-client" }, path), /credentials are incomplete/);
    await assert.rejects(loadFinraCredentials({ FINRA_CLIENT_SECRET: "env-secret" }, path), /credentials are incomplete/);
    assert.equal(await loadFinraCredentials({}, join(dir, "absent.json")), null);
    assert.equal(await loadFinraCredentials({}, join(dir, "absent", "finra.json")), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("FINRA loader refuses shared permissions, symlinks, hard links, non-files and oversize credentials", async () => {
  const { dir, path } = await location();
  try {
    await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
    await chmod(path, 0o644);
    await assert.rejects(loadFinraCredentials({}, path), /not private/);
    await chmod(path, 0o600);
    await chmod(dir, 0o755);
    await assert.rejects(loadFinraCredentials({}, path), /not private/);
    await chmod(dir, 0o700);
    const alias = join(dir, "alias.json");
    await symlink(path, alias);
    await assert.rejects(loadFinraCredentials({}, alias), /not private/);
    const directoryAlias = join(dir, "directory-link");
    await symlink(dir, directoryAlias);
    await assert.rejects(loadFinraCredentials({}, join(directoryAlias, "finra.json")), /not private/);
    await rm(alias);
    await link(path, alias);
    await assert.rejects(loadFinraCredentials({}, path), /not private/);
    await rm(alias);
    await mkdir(alias, { mode: 0o700 });
    await assert.rejects(loadFinraCredentials({}, alias), /not private/);
    await writeFile(path, "x".repeat(32769));
    await assert.rejects(loadFinraCredentials({}, path), /not private/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("FINRA loader sanitizes malformed values instead of including credential text in errors", async () => {
  const { dir, path } = await location();
  try {
    for (const body of [fixture.clientSecret, JSON.stringify({ ...fixture, clientId: "id:bad" }), JSON.stringify({ ...fixture, clientSecret: "line\nbreak" }), "null", "{}", JSON.stringify({ clientId: 7, clientSecret: "secret" })]) {
      await writeFile(path, body, { mode: 0o600 });
      await assert.rejects(loadFinraCredentials({}, path), (error: Error) => {
        assert.match(error.message, /credentials are incomplete/);
        assert.ok(!error.message.includes(fixture.clientSecret));
        assert.ok(!error.message.includes(body));
        return true;
      });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("FINRA setup refuses noninteractive input without echoing or saving piped values", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("../scripts/setup-finra.py", import.meta.url))], { input: `${fixture.clientId}\n${fixture.clientSecret}\n`, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Run this command yourself in Terminal/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture.clientId));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture.clientSecret));
});

test("FINRA setup hides both fields in an actual pseudoterminal and stores them outside the source tree", async () => {
  const { dir } = await location();
  try {
    const program = String.raw`
import errno, importlib.util, json, os, pathlib, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    spec = importlib.util.spec_from_file_location('setup_finra', sys.argv[1])
    setup = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(setup)
    test_home = pathlib.Path(sys.argv[2])
    setup.Path.home = classmethod(lambda cls: test_home)
    sys.argv = [sys.argv[1]]
    result = setup.main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(result)
prompts = [b'FINRA API Client ID (hidden): ', b'FINRA API Client Secret (hidden): ', b'Confirm API Client Secret (hidden): ']
values = [b'pty-client-8792', b'pty-secret-2358', b'pty-secret-2358']
received, sent, finished = b'', 0, False
deadline = time.monotonic() + 10
try:
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.2)[0]:
            try:
                chunk = os.read(fd, 4096)
            except OSError as exc:
                if exc.errno != errno.EIO:
                    raise
                chunk = b''
            if not chunk:
                finished = True
                break
            received += chunk
            if sent < len(prompts) and prompts[sent] in received:
                os.write(fd, values[sent] + b'\n')
                sent += 1
    assert finished, 'interactive setup timed out'
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0, received.decode().replace(values[0].decode(), '[client]').replace(values[1].decode(), '[secret]')
    assert all(value not in received for value in values), 'credential echoed in terminal'
    assert b'Saved privately' in received
    saved = json.loads((pathlib.Path(sys.argv[2]) / '.config/the-daily-consensus/finra.json').read_text())
    assert saved == {'clientId': values[0].decode(), 'clientSecret': values[1].decode()}
finally:
    if not finished:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(fd)
`;
    const result = spawnSync("python3", ["-c", program, fileURLToPath(new URL("../scripts/setup-finra.py", import.meta.url)), dir], { encoding: "utf8", timeout: 15000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("FINRA setup writes private JSON, refuses accidental replacement and unsafe locations, then rotates explicitly", async () => {
  const { dir, path } = await location();
  try {
    const program = `
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('setup_finra', sys.argv[1])
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
p = pathlib.Path(sys.argv[2])
setup.save_credentials(p, 'synthetic-client', 'synthetic-secret')
assert p.stat().st_mode & 0o777 == 0o600
assert p.parent.stat().st_mode & 0o777 == 0o700
try:
    setup.save_credentials(p, 'new-client', 'new-secret')
    raise AssertionError('overwrite was allowed')
except setup.SetupError:
    pass
assert json.loads(p.read_text())['clientId'] == 'synthetic-client'
setup.save_credentials(p, 'rotated-client', 'rotated-secret', replace=True)
p.chmod(0o644)
try:
    setup.save_credentials(p, 'unsafe', 'unsafe', replace=True)
    raise AssertionError('shared file was allowed')
except setup.SetupError:
    pass
p.chmod(0o600)
alias = p.parent / 'alias.json'
alias.symlink_to(p)
try:
    setup.save_credentials(alias, 'unsafe', 'unsafe', replace=True)
    raise AssertionError('symlink was allowed')
except setup.SetupError:
    pass
assert len(list(p.parent.glob('.finra-*.tmp'))) == 0
`;
    const result = spawnSync("python3", ["-c", program, fileURLToPath(new URL("../scripts/setup-finra.py", import.meta.url)), path], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(await loadFinraCredentials({}, path), { clientId: "rotated-client", clientSecret: "rotated-secret" });
    assert.ok(!(await readFile(path, "utf8")).includes("synthetic-secret"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
