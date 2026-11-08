/**
 * Browser-half smoke test: load the bundle exactly as the client module system
 * does (`window.__ModuleLoader__.load({id, factory})`), then drive `apply()`
 * against stub contexts. Catches syntax errors, wiring mistakes, and 闁?most
 * importantly 闁?activation that throws.
 *
 *   node test/client.test.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BUNDLE = fileURLToPath(new URL('../client/client.js', import.meta.url));

/** Minimal React stand-in: only createElement is used by the fallback row. */
const reactStub = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
};

function makeDocument() {
  const makeNode = (tag = 'div') => ({
    tagName: String(tag).toUpperCase(),
    dataset: {},
    className: '',
    textContent: '',
    children: [],
    style: {},
    disabled: false,
    type: '',
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    focus() {},
  });
  return {
    querySelector: () => null,
    createElement: (tag) => makeNode(tag),
    head: makeNode('head'),
    body: makeNode('body'),
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeSandbox() {
  let loaded = null;
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry;
      },
    },
  };
  const sandbox = {
    window,
    document: makeDocument(),
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
  return { sandbox, getLoaded: () => loaded };
}

function requireStub(id) {
  if (id === 'react') return reactStub;
  if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
  if (id === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      MenuItemButton: 'MenuItemButton',
      IconTrashOutlineRegular: 'IconTrashOutlineRegular',
    };
  }
  throw new Error(`unexpected require: ${id}`);
}

async function loadBundle() {
  const { sandbox, getLoaded } = makeSandbox();
  const source = await readFile(BUNDLE, 'utf8');
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  const entry = getLoaded();
  assert.ok(entry, 'the bundle registers a module with the loader');
  return entry;
}

/**
 * Stub context; `overrides` lets a test break one service on purpose.
 */
function makeContext({ withMenus = true, overrides = {} } = {}) {
  const registrations = [];
  const reports = [];
  const effects = [];
  const ctx = {
    connection: { rpc: { call: async (channel, method, params) => ({ ok: true, value: { deleted: true, method, params } }) } },
    locale: {
      register: (ns, dicts) => {
        registrations.push(['locale', ns, dicts]);
        return () => {};
      },
      bind: () => (key, vars) => `${key}${vars ? `:${JSON.stringify(vars)}` : ''}`,
    },
    effect: (fn) => {
      // Cordis runs an effect body immediately; the return value is its disposer.
      const dispose = fn();
      effects.push(dispose);
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
  // Slot contributions are always available; the menu service is optional.
  // A Slot factory may be a plain callback or a generator, exactly as the Host
  // accepts both shapes; generator bodies only run while iterated.
  ctx.slots = {
    inject: (name, fn) => {
      registrations.push(['inject', name]);
      const produced = fn();
      if (typeof produced !== 'function' && produced !== null && typeof produced === 'object' && typeof produced[Symbol.iterator] === 'function') {
        const disposers = [];
        for (const item of produced) if (typeof item === 'function') disposers.push(item);
        return () => {
          for (const dispose of disposers) dispose();
        };
      }
      return typeof produced === 'function' ? produced : () => {};
    },
    register: (config, component) => {
      registrations.push(['slot', config, component]);
      return () => {};
    },
  };
  if (withMenus) {
    ctx.contextMenus = {
      register: (config) => {
        registrations.push(['menu', config]);
        return () => {};
      },
    };
  }
  // A test may replace any service, including contextMenus, on purpose.
  Object.assign(ctx, overrides);
  ctx.get = (name) => (name === 'contextMenus' ? ctx.contextMenus : name === 'connection' ? ctx.connection : undefined);
  // Report calls are collected instead of written to a Host.
  ctx.connection.rpc.call = async (channel, method, params) => {
    if (method.endsWith('/report')) reports.push(params.args.request);
    return { ok: true, value: { deleted: true, method } };
  };
  return { ctx, registrations, reports, effects };
}

const tests = [];
const test = (name, run) => tests.push([name, run]);

test('the bundle registers under its package name', async () => {
  const entry = await loadBundle();
  assert.equal(entry.id, 'dsh-session-delete');
  assert.equal(typeof entry.factory, 'function');
});

test('the module exports apply and its injected services', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual([...exports.inject], ['slots', 'locale', 'connection', 'contextMenus']);
});

test('apply prefers contextMenus and puts Delete after archive', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  const { ctx, registrations, effects } = makeContext({ withMenus: true });
  exports.apply(ctx);

  const menu = registrations.find(([kind]) => kind === 'menu');
  assert.ok(menu, 'a contextMenus registration happened');
  const config = menu[1];
  assert.equal(config.target, 'session');
  assert.ok(config.order > 600, 'ordered after the shipped archive action (600)');
  const items = config.resolve({ sessionId: 'session-x', displayTitle: 'A chat' });
  assert.equal(items.length, 1);
  assert.equal(typeof items[0].run, 'function');
  assert.equal(items[0].separatorBefore, true);
  // The stub's locale face answers with the key itself, which is what a Host
  // whose locale service cannot see this namespace does; the row must still show
  // real copy instead of `menu.delete`.
  assert.equal(items[0].label, '删除会话…');
  assert.equal(items[0].danger, true, 'the row is styled as destructive');
  assert.equal(items[0].afterContent, true, 'the row joins the footer group with Archive');
  assert.equal(items[0].icon && items[0].icon.key, 'session-delete.delete', 'the row carries a glyph key');
  assert.ok(
    registrations.some(([kind, cfg]) => kind === 'slot' && cfg && cfg.key === 'session-delete.delete'),
    'the glyph component was registered into contextMenu.icon',
  );
});

test('apply falls back to the legacy Slot when contextMenus is absent', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  const { ctx, registrations, effects } = makeContext({ withMenus: false });
  exports.apply(ctx);

  const slot = registrations.find(([kind, cfg]) => kind === 'slot' && cfg && cfg.name === 'sidebar.workspaces.session.menu.item');
  assert.ok(slot, 'a Slot registration happened');
  assert.equal(slot[1].name, 'sidebar.workspaces.session.menu.item');
  assert.equal(slot[1].locale, 'dshSessionDelete');
});

test('a broken locale service is reported but never fatal', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  const { ctx, registrations, reports, effects } = makeContext({
    withMenus: true,
    overrides: {
      locale: {
        register: () => {
          throw new Error('locale exploded');
        },
        bind: () => {
          throw new Error('bind exploded');
        },
      },
    },
  });
  assert.doesNotThrow(() => exports.apply(ctx));
  assert.ok(registrations.some(([kind]) => kind === 'menu'), 'the menu still registered');
  await Promise.resolve();
  assert.ok(reports.some((entry) => entry.label === 'locale-register'), 'the failure was reported');
  assert.ok(reports.some((entry) => entry.label === 'locale-bind'), 'bind failure was reported');
});

test('a broken menu service falls through to the legacy Slot', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  const { ctx, registrations, effects } = makeContext({
    withMenus: true,
    overrides: {
      contextMenus: {
        register: () => {
          throw new Error('menu exploded');
        },
      },
    },
  });
  ctx.slots = {
    inject: (name, fn) => {
      registrations.push(['inject', name]);
      return fn();
    },
    register: (config) => {
      registrations.push(['slot', config]);
      return () => {};
    },
  };
  assert.doesNotThrow(() => exports.apply(ctx));
  assert.ok(registrations.some(([kind]) => kind === 'slot'), 'the Slot fallback took over');
});

test('a locale service that answers with real copy wins over the bundled dictionary', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  const { ctx, registrations } = makeContext({
    withMenus: true,
    overrides: {
      locale: {
        register: () => () => {},
        bind: () => (key) => (key === 'menu.delete' ? 'Delete session…' : key),
        resolveText: (map) => map.en,
      },
    },
  });
  exports.apply(ctx);

  const config = registrations.find(([kind]) => kind === 'menu')[1];
  assert.equal(config.resolve({ sessionId: 'session-x' })[0].label, 'Delete session…');
});

test('the row keeps a glyph when the shared primitives ship no trash icon', async () => {
  const entry = await loadBundle();
  const exports = entry.factory((id) => {
    if (id === 'react') return reactStub;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`unexpected require: ${id}`);
  });
  const { ctx, registrations } = makeContext({ withMenus: true });
  assert.doesNotThrow(() => exports.apply(ctx));

  const glyph = registrations.find(([kind, cfg]) => kind === 'slot' && cfg && cfg.key === 'session-delete.delete');
  assert.ok(glyph, 'a glyph component was registered into contextMenu.icon');
  assert.equal(typeof glyph[2], 'function');
  assert.equal(glyph[2]().type, 'svg', 'the bundled SVG stands in for the shared icon');
});

test('a service returning its own Disposable never loses the registration', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  const { ctx, registrations } = makeContext({ withMenus: true });
  // The Host's services answer with Disposable objects, and its effect runner
  // rejects anything but a bare function — the shape that silently dropped both
  // the dictionaries and the glyph before.
  ctx.effect = (fn) => {
    const produced = fn();
    if (produced !== null && produced !== undefined && typeof produced !== 'function') {
      throw new TypeError('Invalid effect');
    }
    return () => {};
  };
  ctx.locale.register = () => ({ dispose() {} });
  ctx.locale.bind = () => (key) => key;
  ctx.slots.inject = (name, factory) => {
    registrations.push(['inject', name]);
    const produced = factory();
    for (const item of produced) if (item !== null && typeof item === 'object') registrations.push(['slot-disposable', item]);
    return { dispose() {} };
  };
  exports.apply(ctx);

  const config = registrations.find(([kind]) => kind === 'menu')[1];
  assert.equal(config.resolve({ sessionId: 'session-x' })[0].label, '删除会话…', 'copy survived');
  assert.ok(
    registrations.some(([kind]) => kind === 'inject'),
    'the glyph factory still ran',
  );
});

test('both locale dictionaries cover the same keys', async () => {
  const entry = await loadBundle();
  const exports = entry.factory(requireStub);
  const { zh, en } = exports.__testing.MESSAGES;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('a bundle the Host executes twice never aborts the web boot', async () => {
  // The client module system refuses a second factory under a taken id, and a
  // throw from module scope fails the whole page load: the window stays blank
  // and DSH reports "web boot: 1 entry did not activate". Run the bundle twice
  // against a loader that enforces that rule.
  const registered = new Map();
  const warnings = [];
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        if (registered.has(entry.id)) {
          throw new Error(
            `client-modules: duplicate factory registration for "${entry.id}" (bundle executed twice without invalidate?)`,
          );
        }
        registered.set(entry.id, entry);
      },
    },
  };
  const sandbox = {
    window,
    document: makeDocument(),
    console: { error() {}, log() {}, warn: (...args) => warnings.push(args) },
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
  const source = await readFile(BUNDLE, 'utf8');

  assert.doesNotThrow(() => vm.runInContext(source, sandbox, { filename: 'client.js' }), 'the first execution registers');
  assert.doesNotThrow(() => vm.runInContext(source, sandbox, { filename: 'client.js' }), 'the second execution stays quiet');
  assert.equal(registered.size, 1, 'one factory serves the id');
  assert.equal(warnings.length, 1, 'the refused duplicate is reported once');
  assert.ok(registered.get('dsh-session-delete'), 'the id the Host expects is the one registered');
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
