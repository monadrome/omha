import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdown } from '../lib/frontmatter.mjs';
import { validateProfiles } from '../lib/profiles.mjs';
import { validatePlan } from '../lib/plans.mjs';
import { validateEvidence } from '../lib/roundtable.mjs';
import { validateHistory } from '../lib/butterfly.mjs';
import { validateReviewConfig } from '../lib/review.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
function files(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
let syntax = 0;
for (const path of [
  'index.mjs',
  ...['bin', 'lib', 'hooks', 'tests', 'scripts'].flatMap(files),
].filter((path) => path.endsWith('.mjs'))) {
  execFileSync(process.execPath, ['--check', join(root, path)], { stdio: 'pipe' });
  syntax += 1;
}
const pkg = json('package.json'),
  plugin = json('.claude-plugin/plugin.json'),
  marketplace = json('.claude-plugin/marketplace.json'),
  lock = json('package-lock.json');
assert.equal(pkg.name, '@huatalk/omha');
assert.equal(plugin.name, 'omha');
assert.equal(marketplace.name, 'omha');
assert.equal(pkg.version, plugin.version);
assert.equal(pkg.version, lock.version);
assert.equal(pkg.version, marketplace.plugins[0].version);
assert.equal(marketplace.plugins[0].source, './');
assert.equal(pkg.bin.omha, 'bin/omha.mjs');
assert.ok(existsSync(join(root, pkg.main)));
const skills = readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(skills, [
  'agent-handoff',
  'auto-butterfly-effect',
  'auto-close',
  'butterfly-effect',
  'concise-report',
  'hide',
  'leader-agent',
  'multi-review',
  'project-memory',
  'roundtable',
]);
for (const name of skills) {
  const path = join(root, 'skills', name, 'SKILL.md'),
    source = readFileSync(path, 'utf8');
  const { metadata } = parseMarkdown(source);
  assert.equal(metadata.name, name);
  assert.equal(typeof metadata.description, 'string');
  assert.ok(metadata.description.length > 20);
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const dest = match[1];
    if (dest.includes('://') || dest.startsWith('#')) continue;
    assert.ok(
      existsSync(resolve(dirname(path), dest.split('#')[0])),
      `${name}: missing reference ${dest}`,
    );
  }
}
for (const name of ['butterfly-effect', 'hide'])
  assert.match(
    readFileSync(join(root, 'skills', name, 'LICENSE'), 'utf8'),
    /Copyright \(c\) 2026 monadrome/,
  );
const profiles = validateProfiles(json('examples/providers.fake.json')).profiles;
validateProfiles(json('examples/providers.json'));
validatePlan(json('examples/plan.json'), profiles);
validateEvidence(json('examples/decision.json').evidence);
validateHistory(json('examples/history.json'));
validateReviewConfig(json('examples/review.json'));
for (const path of files('schemas')) {
  const schema = json(path);
  assert.ok(schema.$schema?.includes('2020-12'));
}
console.log(
  JSON.stringify({
    ok: true,
    syntaxFiles: syntax,
    skills,
    version: pkg.version,
    examplesValidated: true,
  }),
);
