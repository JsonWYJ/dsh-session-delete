/**
 * Build the plugin market index (format 1) for this package.
 *
 * DSH's market is not an upload service: a market is one JSON document that
 * lists installable bundles, and every DSH reads the documents a user
 * configures. This script writes that document from `package.json`, so the
 * name, version, description, and install source cannot drift from the package.
 *
 *   node scripts/build-market-index.mjs [--publish-time <unix-seconds>]
 *   node scripts/build-market-index.mjs --source git --git-url <https url> --git-commit <40-hex>
 *
 * Two install sources are supported, and neither needs npm:
 *
 *   npm  source { type: 'npm' }                    — the package must be on a registry
 *   git  source { type: 'git', url, commit, path? } — pinned to one commit of a repo
 *
 * `--source git` requires `--git-commit`: format 1 refuses an unpinned git
 * source, because a branch name is not a version. `--git-path` names the
 * package directory inside the repo (omit it when the repo root is the package).
 *
 * `--publish-time` is the moment this version went out. Before publication the
 * script keeps the previous value, or the file's own build time, so a draft
 * index stays valid.
 *
 * Validation is delegated to DSH's own validator when it can be found; pass
 * `--validator <abs path to dsh-plugin-market-index/lib/index.js>` to be explicit.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKET_DIR = join(root, 'market');
const INDEX_PATH = join(MARKET_DIR, 'index.json');
const PACKAGE_PATH = join(root, 'package.json');

/** Where the validator lives inside a Desktop installation, newest layout first. */
const VALIDATOR_CANDIDATES = [
  'D:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js',
  'D:/Users/Administrator/AppData/Local/Programs/DeepSeek Harness/resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js',
];

function defaultValidator() {
  return VALIDATOR_CANDIDATES.find((candidate) => existsSync(candidate)) ?? VALIDATOR_CANDIDATES[0];
}

function parseArgs(argv) {
  const options = {
    source: 'npm',
    publishTime: undefined,
    gitUrl: process.env.REPO_URL,
    gitCommit: process.env.GIT_COMMIT,
    gitPath: undefined,
    validator: process.env.DSH_MARKET_INDEX_MODULE ?? defaultValidator(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish-time') options.publishTime = Number(argv[++index]);
    else if (arg === '--validator') options.validator = argv[++index];
    else if (arg === '--source') options.source = argv[++index];
    else if (arg === '--git-url') options.gitUrl = argv[++index];
    else if (arg === '--git-commit') options.gitCommit = argv[++index];
    else if (arg === '--git-path') options.gitPath = argv[++index];
  }
  return options;
}

/** Localized text accepted by format 1: a string, or `{ en, zh, ... }` with `en`. */
function localized(en, zh) {
  return { en, zh };
}

/** The install source for this version, validated against format 1's own rules. */
function installSource(options) {
  if (options.source === 'npm') return { type: 'npm' };
  if (options.source !== 'git') throw new Error(`--source must be "npm" or "git", got ${JSON.stringify(options.source)}`);
  if (typeof options.gitUrl !== 'string' || options.gitUrl === '') throw new Error('--source git needs --git-url (or REPO_URL)');
  if (!/^[0-9a-f]{40}$/.test(options.gitCommit ?? '')) throw new Error('--source git needs --git-commit, a lowercase 40-hex commit SHA');
  return {
    type: 'git',
    url: options.gitUrl.replace(/\.git$/, ''),
    commit: options.gitCommit,
    ...(options.gitPath === undefined ? {} : { path: options.gitPath }),
  };
}

function versionEntry(pkg, publishTime, source) {
  return {
    version: pkg.version,
    publishTimestamp: publishTime,
    source,
    ...(pkg.engines?.dsh === undefined ? {} : { engines: { dsh: pkg.engines.dsh } }),
  };
}

/** Keep the recorded publish time when rebuilding the same version. */
async function previousPublishTime(pkg) {
  try {
    const previous = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
    const entry = previous?.plugins?.[0]?.versions?.find((version) => version.version === pkg.version);
    return entry?.publishTimestamp;
  } catch {
    return undefined;
  }
}

const options = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

const publishTime = Number.isInteger(options.publishTime)
  ? options.publishTime
  : (await previousPublishTime(pkg)) ?? Math.floor(Date.now() / 1000);

const source = (() => {
  try {
    return installSource(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();

const repositoryUrl =
  source.type === 'git'
    ? source.url
    : pkg.repository === undefined
      ? undefined
      : typeof pkg.repository === 'string'
        ? pkg.repository
        : pkg.repository.url;

const index = {
  format: 1,
  title: localized('Session tools for DeepSeek Harness', 'DeepSeek Harness 会话工具'),
  description: localized(
    'One plugin index per publisher. Everyone else can point their DSH at the same URL.',
    '每个发布者自己的插件索引；别人把这个 URL 加进 DSH 就能看到并安装。',
  ),
  metadata: {
    categories: { sessions: { title: localized('Sessions', '会话') } },
    labels: { destructive: { title: localized('Destructive', '破坏性操作') } },
  },
  plugins: [
    {
      name: pkg.name,
      title: localized('Delete session (recoverable)', '删除会话（可恢复）'),
      description: localized(
        pkg.description,
        '侧栏会话右键菜单里的「删除会话」：文件移到本地回收目录，同时清掉工作区登记，归档之外的真正删除。',
      ),
      icon: 'icon.svg',
      ...(pkg.author === undefined ? {} : { author: typeof pkg.author === 'string' ? pkg.author : pkg.author.name }),
      ...(pkg.homepage === undefined ? {} : { homepage: pkg.homepage }),
      ...(repositoryUrl === undefined ? {} : { repository: { url: repositoryUrl } }),
      metadata: {
        category: 'sessions',
        labels: ['destructive'],
        keywords: ['dsh', 'deepseek-harness', 'session', 'delete', 'trash', 'sidebar'],
      },
      versions: [versionEntry(pkg, publishTime, source)],
    },
  ],
};

await mkdir(MARKET_DIR, { recursive: true });
await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`);
console.log(`wrote ${INDEX_PATH} (source: ${source.type}${source.type === 'git' ? ` @ ${source.commit.slice(0, 8)}` : ''})`);

/** Validate with DSH's own reader so a broken index fails here, not in someone's DSH. */
try {
  const validator = await import(pathToFileURL(options.validator).href);
  const parsed = validator.parseMarketIndex(index, 'https://example.com/index.json');
  console.log(`valid format 1: ${String(parsed.plugins.length)} plugin(s), icon ${String(parsed.plugins[0].icon)}`);
} catch (error) {
  if (error && error.name === 'MarketIndexError') {
    console.error(`index is invalid: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.warn(`skipped validation (${error instanceof Error ? error.message : String(error)})`);
  }
}
