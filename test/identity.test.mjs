/**
 * Identity drift guard.
 *
 * The package name is not a label this plugin can choose: DSH keys the client
 * boot row by package name and asserts the loaded script registered exactly
 * that id, claims CSS ownership by it, and resolves the overlay row's `name`
 * against it. A rename that updates `package.json` but leaves any of these
 * stale has already taken the whole Web shell down once ("Failed to load
 * plugins"), so every surface is asserted here instead of being remembered.
 *
 *   node test/identity.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, ROOT), 'utf8');

const pkg = JSON.parse(await read('package.json'));
const NAME = pkg.name;

function makeDocument() {
  const makeNode = (tag = 'div') => ({
    tagName: String(tag).toUpperCase(),
    dataset: {},
    className: '',
    textContent: '',
    children: [],
    style: {},
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
  });
  const head = makeNode('head');
  return {
    head,
    body: makeNode('body'),
    querySelector: () => null,
    createElement: (tag) => makeNode(tag),
  };
}

/** Load the bundle the way the client module system does and materialize it. */
function materialize() {
  const document = makeDocument();
  let entry = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration) => {
          entry = registration;
        },
      },
    },
    document,
    console: { error() {}, log() {}, warn() {} },
    navigator: { language: 'zh-CN' },
    setTimeout,
    Symbol,
    Object,
    Array,
    String,
    Error,
    Promise,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const source = readFile(fileURLToPath(new URL('client/client.js', ROOT)), 'utf8');
  return source.then((code) => {
    vm.runInContext(code, sandbox, { filename: 'client.js' });
    assert.ok(entry !== null, 'the bundle registers a module with the loader');
    const exported = entry.factory((id) => {
      if (id === 'react') return { createElement: (type, props, ...children) => ({ type, props, children }) };
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
      throw new Error(`unexpected require: ${id}`);
    });
    return { entry, exported, document };
  });
}

const tests = [];
const test = (title, run) => tests.push([title, run]);

test('the client bundle registers under the package name', async () => {
  const { entry } = await materialize();
  assert.equal(entry.id, NAME, 'the boot row looks for the package name and gives up otherwise');
});

test('the dialog stylesheet is owned by the package name', async () => {
  const { document } = await materialize();
  const styles = document.head.children.filter((node) => node.tagName === 'STYLE');
  assert.equal(styles.length, 1, 'materializing injects exactly one stylesheet');
  assert.equal(styles[0].dataset.plugin, NAME, 'the loader claims and removes styles by this owner attribute');
  assert.ok(styles[0].dataset.pluginCss.startsWith(`${NAME}/`), 'the CSS inventory key is namespaced by the package name');
});

test('the host half exports the package name', async () => {
  const host = await import(new URL('lib/index.js', ROOT).href);
  assert.equal(host.name, NAME, 'the Loader prints this name in diagnostics; it must match the package');
});

test('the bundle overlay inserts the package name', async () => {
  const overlay = await read('cordis.patch.yml');
  const row = overlay.match(/-\s*insert:\s*\n\s*-\s*id:\s*(\S+)\s*\n\s*name:\s*'([^']+)'/u);
  assert.ok(row !== null, 'cordis.patch.yml carries one insert row');
  assert.equal(row[2], NAME, 'the inserted Loader entry resolves this package');
});

test('the market index advertises the package name', async () => {
  // `market/index.json` is a build artifact (gitignored): CI generates it from
  // package.json during the release, so a clean checkout legitimately has none
  // and there is nothing that could have drifted. Check it only when present.
  let raw;
  try {
    raw = await read('market/index.json');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('     (skipped: market/index.json is generated at release time)');
    return;
  }
  const index = JSON.parse(raw);
  assert.equal(index.plugins[0].name, NAME);
});

let failed = 0;
for (const [title, run] of tests) {
  try {
    await run();
    console.log(`ok   ${title}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${title}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${tests.length} failed`);
  process.exit(1);
}
console.log(`\n${tests.length} passed`);
