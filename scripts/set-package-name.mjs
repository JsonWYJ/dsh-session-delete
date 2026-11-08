/**
 * Rename the package everywhere it is spelled out.
 *
 * A DSH bundle name appears in four places that must agree, or the install,
 * the Loader entry, and the market index stop pointing at the same package:
 *
 *   package.json      `name`
 *   cordis.patch.yml  the insert row's `name` (the `id` stays stable)
 *   README.md         install commands and prose
 *   docs/PUBLISH.md   examples
 *
 *   node scripts/set-package-name.mjs @your-name/dsh-session-delete
 *
 * The market index is generated from `package.json`, so rebuild it after a
 * rename with `node scripts/build-market-index.mjs`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

const next = process.argv[2];
if (next === undefined || !PACKAGE_NAME.test(next) || next.length > 214) {
  console.error('usage: node scripts/set-package-name.mjs <new-package-name>');
  console.error('  example: node scripts/set-package-name.mjs @alice/dsh-session-delete');
  console.error('  rules: lowercase, optional "@scope/", letters digits . _ ~ -');
  process.exit(1);
}

const packagePath = join(root, 'package.json');
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const previous = pkg.name;
if (previous === next) {
  console.log(`already named ${next}`);
  process.exit(0);
}

pkg.name = next;
await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`package.json        ${previous} -> ${next}`);

const patchPath = join(root, 'cordis.patch.yml');
const patch = await readFile(patchPath, 'utf8');
// YAML reserves a leading "@", so a scoped package name must be quoted.
const patchName = /[:"'#{}[\],&*!|>%@`]/u.test(next) || next.startsWith('@') ? `'${next.replaceAll("'", "''")}'` : next;
const patched = patch.replace(
  new RegExp(`(^\\s*name:\\s*)(?:'[^']*'|"[^"]*"|[^\\s#]+)$`, 'mu'),
  `$1${patchName}`,
);
if (patched === patch) console.warn('cordis.patch.yml   name row not found; check it by hand');
else {
  await writeFile(patchPath, patched);
  console.log(`cordis.patch.yml    name row -> ${patchName}`);
}

for (const file of ['README.md', join('docs', 'PUBLISH.md')]) {
  const path = join(root, file);
  try {
    const text = await readFile(path, 'utf8');
    if (!text.includes(previous)) continue;
    await writeFile(path, text.split(previous).join(next));
    console.log(`${file.padEnd(19)} references -> ${next}`);
  } catch {
    // A file that does not exist needs no rewrite.
  }
}

console.log(`
next steps:
  1. node scripts/build-market-index.mjs        # refresh market/index.json
  2. pnpm pack --pack-destination dist
  3. plugin_manager remove_bundle ${previous}
     plugin_manager install_bundle target=<abs path>/dist/<tarball>
  4. publish: npm publish --access public
`);
