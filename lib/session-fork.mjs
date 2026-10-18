import { hash } from './core.mjs';
import { check, text } from './validation.mjs';

export const FORK_LIMITS = Object.freeze({ maxBranches: 8, maxNameBytes: 48 });
export const FORK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

function asciiSlug(value, fallback = 'fork') {
  const slug = String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return slug || fallback;
}

export function sanitizeForkName(value, { fallback, label = 'fork name' } = {}) {
  if (value !== undefined) text(value, label, 4096);
  const normalized = asciiSlug(value, fallback);
  check(normalized.length > 0, `${label} cannot be empty`);
  const name = normalized.slice(0, FORK_LIMITS.maxNameBytes).replace(/-+$/g, '');
  check(FORK_NAME_PATTERN.test(name), `Invalid ${label}`);
  return name;
}

function named(base, role, ordinal, identity, used) {
  const suffix = hash(identity);
  for (const size of [4, 6, 8, 10, 12]) {
    const tail = `${sanitizeForkName(role)}-${ordinal}-${suffix.slice(0, size)}`;
    const head = base.slice(0, Math.max(1, FORK_LIMITS.maxNameBytes - tail.length - 1));
    const candidate = `${head.replace(/-+$/g, '')}-${tail}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  check(false, 'Unable to derive a unique fork branch name', 'conflict');
}

export function forkNames({ treeId, prefixHash, objective, override, branches }) {
  const base = sanitizeForkName(override ?? objective, {
    fallback: override === undefined ? 'fork' : undefined,
    label: override === undefined ? 'fork objective' : 'fork name override',
  });
  const treeHash = hash(`${treeId}\0${prefixHash}\0tree`).slice(0, 6);
  const treeBase = base
    .slice(0, FORK_LIMITS.maxNameBytes - treeHash.length - 1)
    .replace(/-+$/g, '');
  const treeName = `${treeBase}-${treeHash}`;
  const used = new Set();
  return {
    treeName,
    treeLabel: String(override || objective || 'Fork').slice(0, 256),
    branches: branches.map((branch, index) => {
      const ordinal = index + 1;
      const role = branch.role || 'implement';
      const name = branch.name
        ? sanitizeForkName(branch.name, { label: `branch ${ordinal} name` })
        : named(
            base,
            role,
            ordinal,
            `${treeId}\0${prefixHash}\0${role}\0${ordinal}\0${branch.profile}`,
            used,
          );
      check(!used.has(name) || !branch.name, 'Duplicate fork branch name', 'conflict');
      used.add(name);
      return {
        name,
        label: String(
          branch.label || `${role === 'implement' ? 'Implement' : role} · ${objective}`,
        ).slice(0, 256),
        role,
        ordinal,
      };
    }),
  };
}

export function assertSealedForkRoot(root, prefix) {
  check(root?.sealed === true && root.kind === 'root', 'Fork parent must be sealed');
  check(root.pendingToolCalls === 0, 'Fork parent has pending tool calls');
  check(root.pendingApproval === false, 'Fork parent has pending approval');
  check(root.backgroundProcesses === false, 'Fork parent has background processes');
  check(root.prefixHash === hash(prefix), 'Fork parent prefix changed', 'integrity');
  check(
    root.prefixBytes === Buffer.byteLength(prefix),
    'Fork parent prefix bytes changed',
    'integrity',
  );
}

export function aggregateForkCache(nodes) {
  const cache = nodes.map((node) => node.usage?.normalized).filter(Boolean);
  const sum = (key) => {
    const values = cache.map((item) => item[key]);
    return values.some((value) => value !== null && value !== undefined)
      ? values.reduce((total, value) => total + (value || 0), 0)
      : null;
  };
  return {
    status:
      cache.length !== nodes.length || cache.some((item) => item.cacheStatus === 'unknown')
        ? 'unknown'
        : cache.some((item) => item.cacheStatus === 'hit')
          ? 'hit'
          : 'miss',
    creationInputTokens: sum('cacheCreationInputTokens'),
    readInputTokens: sum('cacheReadInputTokens'),
    missInputTokens: sum('cacheMissInputTokens'),
  };
}
