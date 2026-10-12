import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hash, now, projectDir, projectIdentity, stateHome } from './core.mjs';
import { assertSafePath, atomicWrite, ensureDir, lockDir, safeRead } from './storage.mjs';
import { parseMarkdown, markdown } from './frontmatter.mjs';
import { assertNoSecrets, environmentSecrets } from './security.mjs';
import { check, choice, id, keys, number, text, OmhaError } from './validation.mjs';

export const MEMORY_CAPS = {
  indexLines: 200,
  indexBytes: 24000,
  topicBytes: 65536,
  injectLines: 200,
  injectBytes: 16000,
};
const SCOPES = ['project', 'user', 'worktree', 'session', 'role'];
const TYPES = ['project', 'decision', 'fact', 'procedure', 'preference', 'constraint', 'reference'];

function topicName(value) {
  check(
    typeof value === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) &&
      !value.includes('..'),
    'Memory name must be a simple filename',
    'unsafe_path',
  );
  return value;
}

export function memoryPaths(cwd = process.cwd(), options = {}) {
  const identity = projectIdentity(cwd),
    root = stateHome(),
    scope = options.scope || 'project';
  choice(scope, SCOPES, 'memory scope');
  let base = join(root, 'projects', identity.projectId),
    scopeId = identity.projectId;
  if (scope === 'user') {
    scopeId = hash(`${process.getuid?.() ?? 'user'}:${homedir()}`).slice(0, 24);
    base = join(root, 'users', scopeId);
  }
  if (scope === 'worktree') {
    scopeId = identity.worktreeId;
    base = join(base, 'worktrees', scopeId);
  }
  if (scope === 'session') {
    scopeId = id(options.session, 'memory session');
    base = join(base, 'sessions', scopeId);
  }
  if (scope === 'role') {
    scopeId = id(options.role, 'memory role');
    base = join(base, 'roles', scopeId);
  }
  const dir = join(base, 'memory');
  assertSafePath(dir, root);
  return {
    identity,
    root,
    scope,
    scopeId,
    dir,
    topics: join(dir, 'topics'),
    index: join(dir, 'MEMORY.md'),
    lock: join(dir, '.lock'),
  };
}

function validateRecord(metadata, p, name) {
  keys(
    metadata,
    [
      'version',
      'name',
      'description',
      'type',
      'scope',
      'scopeId',
      'projectId',
      'provenance',
      'createdAt',
      'updatedAt',
      'freshness',
      'status',
    ],
    'memory record',
  );
  check(metadata.version === 1, 'Memory record version must be 1', 'invalid_record');
  check(
    metadata.name === name &&
      metadata.scope === p.scope &&
      metadata.scopeId === p.scopeId &&
      metadata.projectId === (p.scope === 'user' ? null : p.identity.projectId),
    'Memory scope or name mismatch',
    'invalid_record',
  );
  text(metadata.description, 'memory description', 512);
  check(!/[\r\n\[\]<>]/.test(metadata.description), 'Description must be a single safe index line');
  choice(metadata.type, TYPES, 'memory type');
  choice(metadata.status, ['active', 'superseded', 'archived'], 'memory status');
  for (const key of ['createdAt', 'updatedAt'])
    check(
      typeof metadata[key] === 'string' && Number.isFinite(Date.parse(metadata[key])),
      `Invalid ${key}`,
      'invalid_record',
    );
  check(
    Date.parse(metadata.createdAt) <= Date.parse(metadata.updatedAt),
    'Memory timestamps are out of order',
    'invalid_record',
  );
  keys(metadata.provenance, ['source', 'author', 'reference'], 'provenance');
  text(metadata.provenance.source, 'provenance source', 256);
  text(metadata.provenance.author, 'provenance author', 256);
  if (metadata.provenance.reference !== null)
    text(metadata.provenance.reference, 'provenance reference', 2048);
  keys(metadata.freshness, ['ttlDays', 'reviewAfter'], 'freshness');
  number(metadata.freshness.ttlDays, 'ttlDays', 0, 36500);
  check(
    typeof metadata.freshness.reviewAfter === 'string' &&
      Number.isFinite(Date.parse(metadata.freshness.reviewAfter)),
    'Invalid reviewAfter',
    'invalid_record',
  );
  assertNoSecrets(metadata, environmentSecrets(process.env));
  return metadata;
}

function recordAt(p, name, time = Date.now()) {
  topicName(name);
  const file = join(p.topics, `${name}.md`);
  const raw = safeRead(file, p.root);
  check(
    Buffer.byteLength(raw) <= MEMORY_CAPS.topicBytes,
    'Memory topic is oversized',
    'invalid_record',
  );
  const parsed = parseMarkdown(raw);
  validateRecord(parsed.metadata, p, name);
  assertNoSecrets(parsed.content, environmentSecrets(process.env));
  rejectTranscript(parsed.content, null, p.scope);
  return {
    name,
    file,
    hash: hash(raw),
    metadata: parsed.metadata,
    content: parsed.content,
    stale: time >= Date.parse(parsed.metadata.freshness.reviewAfter),
  };
}

function records(p, time) {
  if (!existsSync(p.topics)) return [];
  assertSafePath(p.topics, p.root);
  return readdirSync(p.topics)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => recordAt(p, file.slice(0, -3), time));
}

function buildIndex(p) {
  const topics = records(p).filter((r) => r.metadata.status === 'active');
  const lines = ['# Omha memory', '', `scope: ${p.scope}/${p.scopeId}`, '', ''];
  let included = 0;
  for (const record of topics) {
    const row = `- [${record.name}](topics/${record.name}.md) - ${record.metadata.type}: ${record.metadata.description}`;
    const footer = `\nOmitted topics: ${topics.length - included - 1}. Use memory list/search.\n`;
    if (
      lines.length + 3 > MEMORY_CAPS.indexLines ||
      Buffer.byteLength([...lines, row].join('\n') + footer) > MEMORY_CAPS.indexBytes
    )
      break;
    lines.push(row);
    included += 1;
  }
  if (included < topics.length)
    lines.push(`Omitted topics: ${topics.length - included}. Use memory list/search.`);
  return `${lines.join('\n')}\n`;
}

function rebuild(p) {
  const index = buildIndex(p);
  atomicWrite(p.index, index, p.root);
  return index;
}
function initialize(p) {
  ensureDir(p.topics, p.root);
  if (!existsSync(p.index)) {
    const release = lockDir(p.lock, { root: p.root });
    try {
      if (!existsSync(p.index)) rebuild(p);
    } finally {
      release();
    }
  } else assertSafePath(p.index, p.root);
}
function readIndex(p) {
  const content = safeRead(p.index, p.root);
  check(
    Buffer.byteLength(content) <= MEMORY_CAPS.indexBytes &&
      content.split('\n').length <= MEMORY_CAPS.indexLines,
    'Memory index exceeds caps; run memory doctor --rebuild',
    'invalid_record',
  );
  assertNoSecrets(content, environmentSecrets(process.env));
  return content;
}
export function initMemory(cwd = process.cwd(), options = {}) {
  const p = memoryPaths(cwd, options);
  initialize(p);
  return { ...p.identity, scope: p.scope, scopeId: p.scopeId, index: p.index, dir: p.dir };
}

function rejectTranscript(content, kind, scope) {
  if (scope !== 'project' && scope !== 'worktree' && scope !== 'role') return;
  check(
    kind !== 'transcript' &&
      !(
        /(?:^|\n)(?:user|assistant|system|human|agent)\s*:/i.test(content) &&
        (content.match(/(?:^|\n)(?:user|assistant|system|human|agent)\s*:/gi) || []).length >= 2
      ) &&
      !/"role"\s*:\s*"(?:user|assistant|system)"/.test(content),
    'Raw transcripts are not permitted in shared memory',
    'sensitive_content',
  );
}

export function writeMemory(cwd, input, options = {}) {
  const p = memoryPaths(cwd, options);
  initialize(p);
  const name = topicName(input.name);
  text(input.content, 'memory content', MEMORY_CAPS.topicBytes);
  rejectTranscript(input.content, input.contentKind, p.scope);
  assertNoSecrets(input, environmentSecrets(process.env));
  const release = lockDir(p.lock, { root: p.root });
  try {
    const file = join(p.topics, `${name}.md`);
    const current = existsSync(file) ? recordAt(p, name) : null;
    if (Object.hasOwn(input, 'expectedHash'))
      check(
        input.expectedHash === (current?.hash ?? null),
        'memory_conflict: topic changed since it was read',
        'memory_conflict',
      );
    const at = input.at || now();
    const ttlDays = number(input.ttlDays ?? 30, 'ttlDays', 0, 36500);
    const metadata = {
      version: 1,
      name,
      description: input.description || name,
      type: input.type || 'fact',
      scope: p.scope,
      scopeId: p.scopeId,
      projectId: p.scope === 'user' ? null : p.identity.projectId,
      provenance: input.provenance || {
        source: input.source || 'cli',
        author: input.author || 'local-user',
        reference: input.reference || null,
      },
      createdAt: current?.metadata.createdAt || at,
      updatedAt: at,
      freshness: {
        ttlDays,
        reviewAfter: new Date(Date.parse(at) + ttlDays * 86400000).toISOString(),
      },
      status: input.status || 'active',
    };
    validateRecord(metadata, p, name);
    const body = markdown(metadata, input.content);
    check(Buffer.byteLength(body) <= MEMORY_CAPS.topicBytes, 'Memory topic exceeds byte cap');
    atomicWrite(file, body, p.root);
    rebuild(p);
    return {
      file,
      hash: hash(body),
      scope: p.scope,
      stale: Date.now() >= Date.parse(metadata.freshness.reviewAfter),
    };
  } finally {
    release();
  }
}

export const putMemory = writeMemory;
export function readMemory(cwd, name = null, options = {}) {
  const p = memoryPaths(cwd, options);
  initialize(p);
  if (!name) return readIndex(p);
  return safeRead(recordAt(p, name).file, p.root);
}
export function listMemory(cwd, options = {}) {
  const p = memoryPaths(cwd, options);
  initialize(p);
  return records(p, options.nowMs).map(({ content, ...record }) => record);
}
export function searchMemory(cwd, query, options = {}) {
  check(typeof query === 'string' && !query.includes('\0'), 'Invalid memory search query');
  const p = memoryPaths(cwd, options);
  initialize(p);
  const match = query.toLowerCase();
  return records(p)
    .filter((r) =>
      `${r.name}\n${r.metadata.description}\n${r.content}`.toLowerCase().includes(match),
    )
    .map((r) => `${r.name}.md`);
}
export function forgetMemory(cwd, name, options = {}) {
  const p = memoryPaths(cwd, options);
  topicName(name);
  initialize(p);
  const release = lockDir(p.lock, { root: p.root });
  try {
    const current = recordAt(p, name);
    if (Object.hasOwn(options, 'expectedHash'))
      check(options.expectedHash === current.hash, 'memory_conflict', 'memory_conflict');
    rmSync(current.file);
    rebuild(p);
    return { forgotten: name, scope: p.scope };
  } finally {
    release();
  }
}
export function memoryPointer(cwd = process.cwd(), options = {}) {
  const p = memoryPaths(cwd, options);
  initialize(p);
  const content = readIndex(p);
  return {
    uri: `memory://${p.scope}/${p.scopeId}/MEMORY.md#sha256=${hash(content)}`,
    path: p.index,
    scope: p.scope,
    project_id: p.identity.projectId,
    worktree_id: p.identity.worktreeId,
  };
}
export function memoryStatus(cwd, options = {}) {
  const topics = listMemory(cwd, options);
  return {
    ...initMemory(cwd, options),
    pointer: memoryPointer(cwd, options),
    count: topics.length,
    stale: topics.filter((r) => r.stale).map((r) => r.name),
    caps: MEMORY_CAPS,
  };
}

export function injectMemory(cwd, options = {}) {
  const scopes = options.scopes || [options.scope || 'project'];
  check(
    Array.isArray(scopes) && new Set(scopes).size === scopes.length,
    'Injection scopes must be unique',
  );
  check(
    !scopes.includes('user') || options.includePrivate === true,
    'User memory injection requires includePrivate',
  );
  const maxBytes = number(
    options.maxBytes ?? MEMORY_CAPS.injectBytes,
    'inject maxBytes',
    256,
    MEMORY_CAPS.injectBytes,
  );
  const maxLines = number(
    options.maxLines ?? MEMORY_CAPS.injectLines,
    'inject maxLines',
    5,
    MEMORY_CAPS.injectLines,
  );
  const selected = options.topics || [];
  check(Array.isArray(selected), 'Injection topics must be an array');
  selected.forEach(topicName);
  const chunks = [],
    warnings = [],
    included = [],
    omitted = [];
  for (const scope of scopes) {
    const scoped = { ...options, scope },
      p = memoryPaths(cwd, scoped);
    initialize(p);
    const candidates = selected.length
      ? selected.map((name) => recordAt(p, name, options.nowMs))
      : [];
    const pieces = [
      {
        name: `${scope}/pointer`,
        text: `Memory pointer: ${memoryPointer(cwd, scoped).uri}`,
      },
      {
        name: `${scope}/MEMORY.md`,
        text: readIndex(p),
      },
      ...candidates
        .filter((r) => r.metadata.status === 'active')
        .map((r) => ({
          name: `${scope}/${r.name}`,
          text: `Topic ${scope}/${r.name} (${r.metadata.type}):\n${r.content}`,
          stale: r.stale,
        })),
    ];
    for (const piece of pieces) {
      if (piece.stale) warnings.push(`Stale memory: ${piece.name}; verify before relying on it`);
      const candidate = [...chunks, piece.text].join('\n\n');
      if (Buffer.byteLength(candidate) > maxBytes || candidate.split('\n').length > maxLines) {
        omitted.push(piece.name);
        continue;
      }
      chunks.push(piece.text);
      included.push(piece.name);
    }
    for (const record of records(p, options.nowMs).filter(
      (r) => r.stale && r.metadata.status === 'active',
    )) {
      const warning = `Stale memory: ${scope}/${record.name}; verify before relying on it`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  const content = chunks.join('\n\n');
  return {
    content,
    bytes: Buffer.byteLength(content),
    lines: content ? content.split('\n').length : 0,
    included,
    omitted,
    warnings,
  };
}

export function doctorMemory(cwd, options = {}) {
  const p = memoryPaths(cwd, options),
    issues = [];
  try {
    initialize(p);
    const expected = buildIndex(p),
      current = safeRead(p.index, p.root);
    if (current !== expected) issues.push('index_out_of_date');
    if (
      Buffer.byteLength(current) > MEMORY_CAPS.indexBytes ||
      current.split('\n').length > MEMORY_CAPS.indexLines
    )
      issues.push('index_caps');
    if (options.rebuild) {
      const release = lockDir(p.lock, { root: p.root });
      try {
        rebuild(p);
      } finally {
        release();
      }
    }
    return {
      ok: issues.length === 0 || Boolean(options.rebuild),
      issues,
      rebuilt: Boolean(options.rebuild),
      stale: records(p)
        .filter((r) => r.stale)
        .map((r) => r.name),
      index: p.index,
    };
  } catch (error) {
    return {
      ok: false,
      issues: [error.code || 'invalid_record'],
      error: error.message,
      index: p.index,
    };
  }
}
