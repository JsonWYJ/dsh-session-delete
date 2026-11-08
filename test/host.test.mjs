/**
 * Host-half checks against a throwaway Harness home: no DSH process, no real
 * session data. Run with the bundled Node:
 *
 *   node test/host.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteSession, findSessionPaths, resolveDshHome } from '../lib/index.js';

const SESSION = 'session-11111111-2222-3333-4444-555555555555';
const OTHER = 'session-99999999-8888-7777-6666-555555555555';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A fake home holding two sessions in two cwd buckets plus one cache file. */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'));
  const bucketA = join(home, 'sessions', '--D-work-a--', SESSION);
  const bucketB = join(home, 'sessions', '--D-work-b--', OTHER);
  await mkdir(bucketA, { recursive: true });
  await mkdir(bucketB, { recursive: true });
  await writeFile(join(bucketA, 'session.v4.jsonl.zstd'), 'a');
  await writeFile(join(bucketB, 'session.v4.jsonl.zstd'), 'b');
  await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${SESSION}.json`), '{}');
  return { home, bucketA, bucketB };
}

/** Registry stub recording every mutation the plugin attempts. */
function makeContext({ live = new Set(), detachThrows = false } = {}) {
  const calls = [];
  const workspace = {
    id: 'ws-1',
    sessionIds: [SESSION, OTHER],
    async detachSession(id) {
      calls.push(['detach', id]);
      if (detachThrows) throw new Error('registry refused');
      this.sessionIds = this.sessionIds.filter((entry) => entry !== id);
    },
  };
  const registry = {
    list: () => [workspace],
    async unarchiveSession(id) {
      calls.push(['unarchive', id]);
    },
    async unpinSession(id) {
      calls.push(['unpin', id]);
    },
  };
  const events = [];
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? registry : name === 'sessions' ? { get: (id) => (live.has(id) ? { id } : undefined) } : undefined),
    emit: (event, id) => events.push([event, id]),
  };
  return { ctx, calls, events, workspace };
}

const tests = [];
const test = (name, run) => tests.push([name, run]);

test('resolveDshHome prefers a non-blank DSH_HOME', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\x' }), 'D:\\x');
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }).endsWith(join('.dsh')), true);
});

test('findSessionPaths locates every bucket and the cache file', async () => {
  const { home, bucketA } = await makeHome();
  try {
    const paths = await findSessionPaths(SESSION, home);
    assert.equal(paths.length, 2, 'one session directory plus one cache file');
    assert.ok(paths.includes(bucketA));
    assert.ok(paths.some((path) => path.endsWith(`${SESSION}.json`)));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('deleteSession trashes the files and forgets the session', async () => {
  const { home, bucketA, bucketB } = await makeHome();
  try {
    const { ctx, calls, events, workspace } = makeContext();
    const result = await deleteSession(ctx, SESSION, { home });

    assert.equal(result.deleted, true);
    assert.equal(result.moved, 2);
    assert.equal(await exists(bucketA), false, 'session directory is gone');
    assert.equal(await exists(bucketB), true, 'the other session is untouched');
    assert.ok(result.trashDir.startsWith(join(home, 'sessions-trash')));
    const trashed = await readdir(result.trashDir);
    assert.deepEqual(trashed.sort(), [`${SESSION}.json`, SESSION].sort());
    assert.deepEqual(workspace.sessionIds, [OTHER]);
    assert.deepEqual(calls, [['detach', SESSION], ['unarchive', SESSION], ['unpin', SESSION]]);
    assert.deepEqual(events, [['api-session/removed', SESSION]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('deleteSession refuses a malformed id before touching the disk', async () => {
  const { home } = await makeHome();
  try {
    for (const bad of ['', '../etc', 'session/../x', null, 42]) {
      const result = await deleteSession(makeContext().ctx, bad, { home });
      assert.equal(result.deleted, false);
      assert.equal(result.code, 'invalid');
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('deleteSession still cleans up when the files are already gone', async () => {
  const { home } = await makeHome();
  try {
    const { ctx, calls } = makeContext();
    const result = await deleteSession(ctx, 'session-00000000-0000-0000-0000-000000000000', { home });
    assert.equal(result.deleted, true);
    assert.equal(result.moved, 0);
    assert.deepEqual(calls, [['unarchive', 'session-00000000-0000-0000-0000-000000000000'], ['unpin', 'session-00000000-0000-0000-0000-000000000000']]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a registry refusal does not undo the delete or leak an exception', async () => {
  const { home } = await makeHome();
  try {
    const { ctx, events } = makeContext({ detachThrows: true });
    const result = await deleteSession(ctx, SESSION, { home });
    assert.equal(result.deleted, true);
    assert.ok(result.applied.some((entry) => entry.startsWith('detach-failed:')));
    assert.deepEqual(events, [['api-session/removed', SESSION]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

let failed = 0;
for (const [name, run] of tests) {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`\n${tests.length} passed`);
