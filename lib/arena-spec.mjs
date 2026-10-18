import { isAbsolute } from 'node:path';
import { assertNoSecrets } from './security.mjs';
import { portablePath } from './open-arena.mjs';
import { validateBudget } from './profiles.mjs';
import { check, choice, id, keys, number, text } from './validation.mjs';

export function authorization(value, label) {
  keys(value, ['by', 'source', 'at'], label);
  for (const key of ['by', 'source', 'at']) text(value[key], `${label}.${key}`, 4096);
  check(Number.isFinite(Date.parse(value.at)), `Invalid ${label} time`);
}
const oid = (value) => check(/^[a-f0-9]{40}$/.test(value), 'Expected a SHA-1 Git object id');
const sha = (value) => check(/^[a-f0-9]{64}$/.test(value), 'Expected a SHA-256 digest');

export function validateArenaSpec(input) {
  keys(
    input,
    [
      'version',
      'authorization',
      'objective',
      'knowledgeId',
      'bundle',
      'contenders',
      'allowedPaths',
      'securityMode',
      'isolation',
      'deadlineMs',
      'attemptTimeoutMs',
      'parallelism',
      'warmFirst',
      'budget',
      'verification',
    ],
    'arena execution specification',
  );
  assertNoSecrets(input);
  check(input.version === 1, 'Arena execution specification version must be 1');
  authorization(input.authorization, 'execution authorization');
  text(input.objective, 'implementation objective', 100000);
  sha(input.knowledgeId);
  const bundle = input.bundle;
  keys(
    bundle,
    ['path', 'hash', 'baseCommit', 'baseTree', 'allowedRefs', 'objectIds', 'forbiddenObjectIds'],
    'snapshot bundle',
  );
  text(bundle.path, 'bundle path', 4096);
  check(isAbsolute(bundle.path), 'Snapshot bundle requires an absolute host path');
  sha(bundle.hash);
  oid(bundle.baseCommit);
  oid(bundle.baseTree);
  check(
    Array.isArray(bundle.allowedRefs) &&
      bundle.allowedRefs.length > 0 &&
      bundle.allowedRefs.length <= 64,
    'Snapshot ref allowlist is required',
  );
  bundle.allowedRefs.forEach((ref) => {
    keys(ref, ['ref', 'commit'], 'allowed snapshot ref');
    check(
      /^refs\/[A-Za-z0-9_./-]+$/.test(ref.ref) && !ref.ref.includes('..'),
      'Invalid snapshot ref',
    );
    oid(ref.commit);
  });
  check(
    JSON.stringify(bundle.allowedRefs) ===
      JSON.stringify([...bundle.allowedRefs].sort((a, b) => a.ref.localeCompare(b.ref, 'en'))) &&
      new Set(bundle.allowedRefs.map((ref) => ref.ref)).size === bundle.allowedRefs.length,
    'Snapshot refs must be unique and sorted',
  );
  check(
    Array.isArray(bundle.objectIds) &&
      bundle.objectIds.length > 0 &&
      bundle.objectIds.length <= 100000,
    'Full snapshot object allowlist is required',
  );
  bundle.objectIds.forEach(oid);
  check(
    JSON.stringify(bundle.objectIds) === JSON.stringify([...new Set(bundle.objectIds)].sort()),
    'Snapshot object allowlist must be unique and sorted',
  );
  check(Array.isArray(bundle.forbiddenObjectIds), 'Excluded reference object list is required');
  bundle.forbiddenObjectIds.forEach(oid);
  check(
    Array.isArray(input.contenders) && input.contenders.length >= 2 && input.contenders.length <= 8,
    'Arena requires between 2 and 8 contenders',
  );
  input.contenders.forEach((contender) => {
    keys(contender, ['profile', 'role', 'name', 'label', 'suffix'], 'contender');
    id(contender.profile, 'contender profile');
    if (contender.role !== undefined) {
      id(contender.role, 'contender role');
      check(contender.role === 'implement', 'Arena fork branches currently require role implement');
    }
    if (contender.name !== undefined) text(contender.name, 'contender name', 4096);
    if (contender.label !== undefined) text(contender.label, 'contender label', 4096);
    if (contender.suffix !== undefined) text(contender.suffix, 'contender suffix', 65536);
  });
  check(
    Array.isArray(input.allowedPaths) && input.allowedPaths.length > 0,
    'Authorized write paths are required',
  );
  input.allowedPaths.forEach((path) => path === '.' || portablePath(path));
  choice(input.securityMode, ['cooperative', 'strict'], 'security mode');
  number(input.deadlineMs, 'batch deadlineMs', 10, 86400000);
  number(input.attemptTimeoutMs, 'attemptTimeoutMs', 10, input.deadlineMs);
  number(input.parallelism, 'parallelism', 1, input.contenders.length);
  if (input.warmFirst !== undefined)
    check(typeof input.warmFirst === 'boolean', 'warmFirst must be boolean');
  else input.warmFirst = input.contenders.length > 2;
  validateBudget(input.budget);
  check(input.budget, 'Explicit shared admission budget is required');
  keys(input.verification, ['authorization', 'criteria'], 'host verification');
  authorization(input.verification.authorization, 'verification authorization');
  check(
    Array.isArray(input.verification.criteria) && input.verification.criteria.length <= 32,
    'Verification criteria must be a bounded array',
  );
  const criteria = new Set();
  for (const criterion of input.verification.criteria) {
    keys(
      criterion,
      ['id', 'command', 'args', 'harnessPath', 'harnessHash', 'timeoutMs'],
      'verification criterion',
    );
    id(criterion.id, 'criterion id');
    check(!criteria.has(criterion.id), 'Duplicate verification criterion');
    criteria.add(criterion.id);
    check(
      isAbsolute(criterion.command) && isAbsolute(criterion.harnessPath),
      'Host verification executable and harness paths must be absolute',
    );
    text(criterion.command, 'verification command', 4096);
    text(criterion.harnessPath, 'verification harness', 4096);
    sha(criterion.harnessHash);
    check(
      Array.isArray(criterion.args) &&
        criterion.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) &&
        criterion.args.includes('{harness}'),
      'Verification args must bind the frozen host harness',
    );
    number(criterion.timeoutMs, 'verification timeoutMs', 10, input.deadlineMs);
  }
  if (input.isolation !== undefined) {
    keys(
      input.isolation,
      ['authorization', 'executorHash', 'readOnlyPaths', 'excludedPaths'],
      'strict isolation',
    );
    authorization(input.isolation.authorization, 'isolation authorization');
    sha(input.isolation.executorHash);
    for (const key of ['readOnlyPaths', 'excludedPaths']) {
      check(
        Array.isArray(input.isolation[key]) &&
          input.isolation[key].every(
            (path) => typeof path === 'string' && isAbsolute(path) && path !== '/',
          ),
        `isolation.${key} requires absolute paths`,
      );
    }
  }
  return structuredClone(input);
}
