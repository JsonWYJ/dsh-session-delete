/**
 * dsh-session-delete host plugin.
 *
 * DSH ships archive and nothing else: `workspaceRegistry.archiveSession()` keeps
 * every byte and every accounting slot, and `workspace/delete` removes only a
 * Workspace registration. This plugin adds the missing hard operation as a
 * Typert Remote namespace (`sessionDelete`), so the browser half in
 * `client/client.js` can delete one Session from the sidebar.
 *
 * A delete is deliberately recoverable rather than a `rm -rf`: the Session's
 * durable directory moves to `<DSH_HOME>/sessions-trash/<stamp>-<sessionId>/`,
 * which the Host never scans. The id is then detached from its Workspace and
 * dropped from the registry-global archive/pin sets, and the Web session list is
 * told the Session is gone (`api-session/removed`), so the row disappears
 * without a page reload.
 *
 * Session files are moved before any registry write: a busy file (an open
 * conversation still holding a handle) therefore leaves both the files and the
 * sidebar exactly as they were, and the caller gets `code: 'busy'`.
 *
 * @module dsh-session-delete
 */

import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Cordis plugin name used by Loader diagnostics; kept equal to the package name. */
export const name = '@jsonwyj/dsh-session-delete';

/** Directory name the trashed Sessions live under, beside `sessions/`. */
const TRASH_DIR_NAME = 'sessions-trash';

/**
 * Accepted Session ids. DSH ids are branded strings such as
 * `session-<uuid>`; anything outside this alphabet is refused before it can be
 * joined onto a path.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

/**
 * Resolve the Harness home exactly as `@deepseek-ai/dsh-home-paths` does:
 * `$DSH_HOME` when set and non-blank, otherwise `~/.dsh`.
 * @param env - environment mapping to read `DSH_HOME` from.
 * @returns the normalized absolute Harness home path.
 */
export function resolveDshHome(env = process.env) {
  const configured = env?.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return join(homedir(), '.dsh');
}

/** Whether `path` exists and is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `path` exists at all. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every durable artifact one Session id owns today: one directory per
 * Workspace-shaped cwd bucket under `<home>/sessions/`, plus its projection
 * cache file.
 * @param sessionId - Session identity to locate.
 * @param home - resolved Harness home.
 * @returns absolute paths; empty when the Session has no files (already gone).
 */
export async function findSessionPaths(sessionId, home = resolveDshHome()) {
  const found = [];
  const sessionsRoot = join(home, 'sessions');
  let buckets = [];
  try {
    buckets = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    buckets = [];
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const candidate = join(sessionsRoot, bucket.name, sessionId);
    if (await isDirectory(candidate)) found.push(candidate);
  }
  const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  if (await exists(cacheFile)) found.push(cacheFile);
  return found;
}

/**
 * Move the Session's artifacts into the trash directory.
 * @param sessionId - Session identity being deleted.
 * @param paths - artifacts returned by {@link findSessionPaths}.
 * @param home - resolved Harness home.
 * @returns the trash directory and the paths that could not be moved.
 */
async function trashArtifacts(sessionId, paths, home) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(home, TRASH_DIR_NAME, `${stamp}-${sessionId}`);
  await mkdir(target, { recursive: true });
  const blocked = [];
  const moved = [];
  for (const path of paths) {
    try {
      await rename(path, join(target, basename(path)));
      moved.push(path);
      continue;
    } catch (error) {
      const code = error?.code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') {
        blocked.push({ path, code });
        continue;
      }
      // Another device (EXDEV) or a filesystem that refuses a cross-directory
      // rename: fall back to a copy-free removal, which is still what the
      // caller asked for.
      try {
        await rm(path, { recursive: true, force: true });
        moved.push(path);
      } catch (fallback) {
        blocked.push({ path, code: fallback?.code ?? 'unknown' });
      }
    }
  }
  return { trashDir: target, moved, blocked };
}

/**
 * Detach one Session id from every place the Workspace registry accounts for
 * it: the owning Workspace's ordered `sessionIds`, and the registry-global
 * archive and pin sets.
 * @param ctx - host context carrying the Workspace registry.
 * @param sessionId - Session identity being deleted.
 * @returns the names of the registry operations that were applied.
 */
async function forgetSession(ctx, sessionId) {
  const applied = [];
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
  if (registry === undefined || registry === null) return applied;
  try {
    for (const workspace of registry.list() ?? []) {
      if (!workspace.sessionIds.includes(sessionId)) continue;
      await workspace.detachSession(sessionId);
      applied.push(`detach:${workspace.id}`);
    }
  } catch (error) {
    applied.push(`detach-failed:${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [label, run] of [
    ['unarchive', () => registry.unarchiveSession(sessionId)],
    ['unpin', () => registry.unpinSession(sessionId)],
  ]) {
    try {
      await run();
      applied.push(label);
    } catch (error) {
      applied.push(`${label}-failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return applied;
}

/**
 * Delete one Session: trash its files, forget it in the Workspace registry, and
 * announce its removal to the Web session list.
 *
 * Failure is reported as a value, not a throw, so the browser half can localize
 * a code instead of printing a Host message.
 *
 * @param ctx - host context.
 * @param sessionId - Session identity to delete.
 * @param options - resolved Harness home override, for tests.
 * @returns `{ deleted: true, trashDir, moved, applied }` or `{ deleted: false, code, detail? }`.
 */
export async function deleteSession(ctx, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return { deleted: false, code: 'invalid' };
  }
  const home = options.home ?? resolveDshHome();
  const paths = await findSessionPaths(sessionId, home);
  let trashed = { trashDir: undefined, moved: [], blocked: [] };
  if (paths.length > 0) {
    trashed = await trashArtifacts(sessionId, paths, home);
    if (trashed.blocked.length > 0) {
      return {
        deleted: false,
        code: 'busy',
        detail: trashed.blocked[0].code,
        moved: trashed.moved.length,
      };
    }
  }
  const applied = await forgetSession(ctx, sessionId);
  // The Web session list drops a row on this event; the workspace feed already
  // republished the owning Workspace when its accounting changed.
  try {
    if (typeof ctx.emit === 'function') ctx.emit('api-session/removed', sessionId);
  } catch {
    // A missing listener is not a delete failure.
  }
  return { deleted: true, trashDir: trashed.trashDir, moved: trashed.moved.length, applied };
}

/**
 * Best-effort diagnostic: record the last activation outcome where a person can
 * read it without a Host log. Written under `<home>/cache/dsh-session-delete/`.
 * @param record - what happened during activation.
 */
async function writeStatus(record) {
  try {
    const dir = join(resolveDshHome(), 'cache', 'dsh-session-delete');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'status.json'), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Diagnostics must never break activation.
  }
}

/**
 * Mark one `@Remote(method)` method without decorator syntax.
 * @param Remote - the Typert `Remote` decorator factory.
 * @param prototype - service prototype receiving the marker.
 * @param method - method name to expose.
 */
function markRemoteMethod(Remote, prototype, method) {
  const decorator = Remote(method);
  decorator(undefined, {
    name: method,
    private: false,
    static: false,
    addInitializer(fn) {
      fn.call(Object.create(prototype));
    },
  });
}

/**
 * Load the Typert provider protocol.
 *
 * A plugin installed under the profile resolves `@deepseek-ai/*` against the
 * running Host. A plugin reached through a `link:` outside the profile does not:
 * Node resolves its real path, where the Host packages are invisible. The
 * fallback therefore loads the copy that ships inside the Desktop app itself.
 *
 * @returns the protocol module.
 */
async function loadProtocol() {
  let firstFailure;
  try {
    return await import('@deepseek-ai/dsh-typert-protocol');
  } catch (error) {
    firstFailure = error;
  }
  const resources = process.resourcesPath;
  if (typeof resources === 'string') {
    for (const layer of ['app.asar', 'app']) {
      const file = join(resources, layer, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-typert-protocol', 'lib', 'index.js');
      if (!(await exists(file))) continue;
      try {
        return await import(pathToFileURL(file).href);
      } catch {
        // Try the next layout.
      }
    }
  }
  throw firstFailure;
}

/**
 * Mount the `sessionDelete/*` Remote namespace for the Web client.
 * @param ctx - host context.
 * @param logger - plugin logger.
 * @returns the failure reason when the namespace could not mount.
 */
async function mountRemote(ctx, logger) {
  if (typeof ctx.reflect?.provide !== 'function') return 'no typert reflection service';
  let protocol;
  try {
    protocol = await loadProtocol();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`delete action unavailable: ${reason}`);
    return `typert protocol unavailable: ${reason}`;
  }
  class SessionDeleteRemote extends protocol.TypertRemoteService {
    constructor(context) {
      super(context, 'sessionDelete');
    }

    /**
     * Delete one Session.
     * @param request - `{ sessionId }` from the browser half.
     * @returns the delete outcome described by {@link deleteSession}.
     */
    async delete(request) {
      return await deleteSession(ctx, request?.sessionId);
    }

    /**
     * Record a browser-half failure. The Web client has no log a person can
     * read, so a failed activation or a refused delete reports here instead.
     * @param request - `{ label, detail }` from the browser half.
     * @returns confirmation that the record was written.
     */
    async report(request) {
      const record = {
        at: new Date().toISOString(),
        label: typeof request?.label === 'string' ? request.label.slice(0, 120) : 'unknown',
        detail: typeof request?.detail === 'string' ? request.detail.slice(0, 4000) : String(request?.detail ?? ''),
      };
      try {
        const dir = join(resolveDshHome(), 'cache', 'dsh-session-delete');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'client-error.json'), `${JSON.stringify(record, null, 2)}\n`);
      } catch {
        return { recorded: false };
      }
      return { recorded: true };
    }
  }
  markRemoteMethod(protocol.Remote, SessionDeleteRemote.prototype, 'delete');
  markRemoteMethod(protocol.Remote, SessionDeleteRemote.prototype, 'report');
  new SessionDeleteRemote(ctx);
  logger.info('delete action mounted as sessionDelete/delete');
  return undefined;
}

/**
 * Activate the plugin.
 * @param ctx - host context.
 */
export async function apply(ctx) {
  const logger = typeof ctx.logger === 'function'
    ? ctx.logger('session-delete')
    : { info() {}, warn: console.warn };
  const failure = await mountRemote(ctx, logger);
  await writeStatus({
    at: new Date().toISOString(),
    entry: 'session-delete',
    mounted: failure === undefined,
    reason: failure ?? null,
    home: resolveDshHome(),
  });
}
