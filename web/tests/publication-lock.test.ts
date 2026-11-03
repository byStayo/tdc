import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { acquirePublicationLock } from '../lib/publication-lock.ts';

const moduleURL = new URL('../lib/publication-lock.ts', import.meta.url).href;
test('kernel publication lock excludes concurrent writers, preserves its inode and has idempotent owned release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tdc-lock-'));
  try {
    const release = await acquirePublicationLock(root, 'first');
    const path = join(root, '.editorial/publish.lock');
    const before = await stat(path), first = JSON.parse(await readFile(path, 'utf8'));
    try { await assert.rejects(acquirePublicationLock(root, 'second'), /busy/); }
    finally { await release(); }
    const second = await acquirePublicationLock(root, 'second');
    try {
      await release(); // A previous owner's repeated release cannot clear this lock.
      await assert.rejects(acquirePublicationLock(root, 'third'), /busy/);
      assert.equal((await stat(path)).ino, before.ino);
      assert.notEqual(JSON.parse(await readFile(path, 'utf8')).token, first.token);
    } finally { await second(); }
    await writeFile(path, JSON.stringify({pid: process.pid, startedAt:'2000-01-01'}));
    await assert.rejects(acquirePublicationLock(root, 'legacy'), /owner is alive/);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('killing a publisher releases the kernel lock without deleting or stealing a live lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tdc-lock-crash-'));
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `import {acquirePublicationLock} from ${JSON.stringify(moduleURL)}; await acquirePublicationLock(${JSON.stringify(root)}, 'crash-fixture'); console.log('READY'); setInterval(()=>{},1000);`], {stdio:['ignore','pipe','pipe']});
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), 5000);
      child.stdout.on('data', chunk => {if (String(chunk).includes('READY')) { clearTimeout(timer); resolve(); }});
      child.once('error', error => {clearTimeout(timer);reject(error);});
    });
    await assert.rejects(acquirePublicationLock(root, 'contender'), /busy/);
    const closed = once(child,'close'); child.kill('SIGKILL'); await closed;
    let release: (() => Promise<void>) | undefined;
    for(let i=0;i<20;i++) {
      try { release = await acquirePublicationLock(root,'after-crash'); break; }
      catch(error) { if(!/busy/.test(String(error))) throw error; await delay(20); }
    }
    assert.ok(release, 'kernel releases ownership after parent pipe closes');
    await release();
    const path = join(root,'.editorial/publish.lock');
    await writeFile(path, JSON.stringify({pid:child.pid,startedAt:'2000-01-01'}));
    const legacy = await acquirePublicationLock(root,'dead-legacy'); await legacy();
  } finally { child.kill('SIGKILL'); await rm(root,{recursive:true,force:true}); }
});
