import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { hash, now, projectIdentity, stateHome } from './core.mjs';
import { atomicWrite, assertSafePath, jsonRead, safeRead } from './storage.mjs';
import { assertNoSecrets, environmentSecrets, redact } from './security.mjs';
import { check, choice, id, keys, text } from './validation.mjs';

export const ARENA_LABELS = Object.freeze([
  'Current authoritative fact',
  'Historical evidence',
  'Supported conclusion',
  'Hypothesis',
  'Unresolved',
  'Non-goal',
]);
export const ARENA_CONTRACT = Object.freeze({
  name: 'open-arena',
  version: '0.1.0',
  revision: '4ec32d13d952e6cabba78b00a077b37d67ef4357',
  // Contract identity only; no skill code is vendored or installed.
  sha256: 'ee668a02242fbc4006ccce908ccee4245ecedb372641667e808e8534a9741128',
});
export const ARENA_LIMITS = Object.freeze({ files: 128, fileBytes: 262144, totalBytes: 1048576 });

export const digestRecord = (value) => hash(JSON.stringify(value));
export function assertDigest(actual, expected, label) {
  check(actual === expected, `${label} hash changed`, 'integrity');
}
export function outside(file, directory, label = 'Host state') {
  let ancestor = resolve(file);
  const pending = [];
  while (!existsSync(ancestor)) {
    pending.unshift(posix.basename(ancestor));
    ancestor = dirname(ancestor);
  }
  const canonical = resolve(realpathSync(ancestor), ...pending);
  const rel = relative(realpathSync(directory), canonical);
  check(
    rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel),
    `${label} must be outside the input repository`,
    'unsafe_path',
  );
}

export function portablePath(value) {
  text(value, 'relative path', 1024);
  check(
    !isAbsolute(value) && !value.includes('\\') && !/[\x00-\x1f]/.test(value),
    'Invalid portable path',
    'unsafe_path',
  );
  check(
    value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Path escapes package',
    'unsafe_path',
  );
  return value;
}

function inventory(root) {
  const paths = ['OPEN_ARENA.md'];
  const walk = (dir) => {
    assertSafePath(join(root, dir), root);
    check(
      lstatSync(join(root, dir)).isDirectory(),
      'references must be a directory',
      'unsafe_path',
    );
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const path = portablePath(`${dir}/${entry.name}`);
      assertSafePath(join(root, path), root);
      if (entry.isDirectory()) walk(path);
      else {
        check(entry.isFile(), 'Knowledge references must be regular files', 'unsafe_path');
        paths.push(path);
        check(paths.length <= ARENA_LIMITS.files, 'Too many reference files', 'payload_limit');
      }
    }
  };
  walk('references');
  return paths;
}

function readDocument(path, root) {
  assertSafePath(join(root, path), root);
  const stat = lstatSync(join(root, path));
  check(
    stat.isFile() && stat.size <= ARENA_LIMITS.fileBytes,
    'Knowledge file exceeds size limit',
    'payload_limit',
  );
  const value = safeRead(join(root, path), root);
  check(
    Buffer.byteLength(value) === stat.size && !value.includes('\ufffd') && !value.includes('\0'),
    'Knowledge files must be UTF-8 text',
    'invalid_record',
  );
  return value;
}

function validateLinks(path, content, paths) {
  // These are dependency checks, not a semantic review of the document.
  const links = [
    ...content.matchAll(/\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g),
    ...content.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm),
    ...content.matchAll(/(?:href|src)=["']([^"']+)["']/gi),
  ];
  for (const match of links) {
    const dest = match[1];
    if (dest.startsWith('#') || /^https?:\/\//i.test(dest)) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(dest.split('#')[0]);
    } catch {
      check(false, 'Invalid reference URL', 'unsafe_path');
    }
    check(
      !isAbsolute(decoded) && !decoded.includes('\\') && !/^[a-z][a-z0-9+.-]*:/i.test(decoded),
      'Path escapes package',
      'unsafe_path',
    );
    const target = posix.normalize(posix.join(posix.dirname(path), decoded));
    portablePath(target);
    check(paths.includes(target), `Missing or unlisted reference: ${target}`, 'invalid_record');
  }
}

function validateMetadata(metadata, documents) {
  check(
    Buffer.byteLength(JSON.stringify(metadata)) <= ARENA_LIMITS.totalBytes,
    'Knowledge metadata exceeds size limit',
    'payload_limit',
  );
  keys(
    metadata,
    ['version', 'authority', 'sources', 'evidence', 'semanticReview'],
    'knowledge metadata',
  );
  check(metadata.version === 1, 'Knowledge metadata version must be 1');
  const authority = metadata.authority;
  keys(
    authority,
    [
      'requirementId',
      'generatedAt',
      'worktree',
      'branch',
      'baseline',
      'revision',
      'sourcePrecedence',
    ],
    'authority',
  );
  for (const key of ['requirementId', 'generatedAt', 'worktree', 'branch', 'baseline', 'revision'])
    text(authority[key], `authority.${key}`, 4096);
  check(Number.isFinite(Date.parse(authority.generatedAt)), 'Invalid authority generation time');
  check(
    Array.isArray(authority.sourcePrecedence) && authority.sourcePrecedence.length > 0,
    'Authority source precedence is required',
  );
  authority.sourcePrecedence.forEach((value) => text(value, 'source precedence', 4096));
  check(
    Array.isArray(metadata.sources) && metadata.sources.length === documents.length,
    'Every knowledge file requires source provenance',
  );
  const seen = new Set();
  for (const source of metadata.sources) {
    keys(
      source,
      ['path', 'origin', 'snapshotAt', 'revision', 'status', 'rawHash'],
      'knowledge source',
    );
    portablePath(source.path);
    check(
      !seen.has(source.path) && documents.some((doc) => doc.path === source.path),
      'Unknown or duplicate knowledge source',
    );
    seen.add(source.path);
    text(source.origin, 'source origin', 4096);
    text(source.snapshotAt, 'source snapshot time', 64);
    check(Number.isFinite(Date.parse(source.snapshotAt)), 'Invalid source snapshot time');
    choice(source.status, ['current', 'historical', 'unresolved'], 'source status');
    if (source.revision !== null) text(source.revision, 'source revision', 256);
    if (source.rawHash !== undefined)
      assertDigest(
        documents.find((doc) => doc.path === source.path).rawHash,
        source.rawHash,
        'Original source',
      );
  }
  check(
    Array.isArray(metadata.evidence) &&
      metadata.evidence.length > 0 &&
      metadata.evidence.length <= 512,
    'Evidence registry is required',
  );
  const ids = new Set();
  for (const entry of metadata.evidence) {
    keys(entry, ['id', 'label', 'path', 'quote'], 'knowledge evidence');
    id(entry.id, 'evidence id');
    check(!ids.has(entry.id), 'Duplicate evidence id');
    ids.add(entry.id);
    choice(entry.label, ARENA_LABELS, 'evidence label');
    text(entry.quote, 'evidence quote', 100000);
    const doc = documents.find((item) => item.path === entry.path);
    check(
      doc && doc.content.includes(entry.quote),
      'Evidence quote is absent from frozen content',
      'invalid_record',
    );
    const source = metadata.sources.find((item) => item.path === entry.path);
    check(
      entry.label !== 'Current authoritative fact' || source.status === 'current',
      'Historical or unresolved sources cannot become current facts',
      'invalid_record',
    );
    check(
      source.status !== 'unresolved' ||
        ['Hypothesis', 'Unresolved', 'Non-goal'].includes(entry.label),
      'Unresolved sources cannot become supported conclusions',
      'invalid_record',
    );
  }
  const review = metadata.semanticReview;
  keys(
    review,
    ['status', 'by', 'source', 'at', 'knowledgeOnly', 'noEvidencePromotion'],
    'semantic review',
  );
  choice(review.status, ['approved', 'unresolved'], 'semantic review status');
  for (const key of ['by', 'source', 'at']) text(review[key], `semantic review ${key}`, 4096);
  check(Number.isFinite(Date.parse(review.at)), 'Invalid semantic review time');
  if (review.status === 'approved')
    check(
      review.knowledgeOnly === true && review.noEvidencePromotion === true,
      'Approved semantic review must attest both knowledge boundaries',
    );
}

function contextFor(manifest, documents) {
  return `Omha frozen Open Arena v1\nknowledge_digest: ${manifest.id}\ncontract: ${ARENA_CONTRACT.version}/${ARENA_CONTRACT.sha256}\n\nKnowledge authority and evidence:\n${JSON.stringify(manifest.metadata)}\n\n${documents.map((doc) => `--- ${doc.path} ---\n${doc.content}`).join('\n\n')}`;
}

function packageDir(packageId) {
  check(/^[a-f0-9]{64}$/.test(packageId), 'Invalid knowledge package id');
  return join(stateHome(), 'arena', 'knowledge', packageId);
}

export function importOpenArena(directory, metadata, options = {}) {
  assertSafePath(resolve(directory));
  const root = realpathSync(resolve(directory));
  const home = stateHome();
  outside(home, root);
  outside(home, options.sourceCwd || projectIdentity(root).root);
  choice(options.secretPolicy || 'reject', ['reject', 'redact'], 'secret policy');
  const paths = inventory(root);
  let bytes = 0;
  const documents = paths.map((path) => {
    const raw = readDocument(path, root);
    bytes += Buffer.byteLength(raw);
    check(
      bytes <= ARENA_LIMITS.totalBytes,
      'Knowledge package exceeds size limit',
      'payload_limit',
    );
    const secrets = environmentSecrets(process.env);
    if (options.secretPolicy !== 'redact') assertNoSecrets(raw, secrets);
    const content = redact(raw, secrets);
    validateLinks(path, content, paths);
    return {
      path,
      content,
      rawHash: hash(raw),
      hash: hash(content),
      bytes: Buffer.byteLength(content),
      redacted: content !== raw,
    };
  });
  assertNoSecrets(metadata);
  validateMetadata(metadata, documents);
  const payload = {
    version: 1,
    contract: ARENA_CONTRACT,
    metadata,
    files: documents.map(({ content, ...entry }) => entry),
  };
  const packageId = digestRecord(payload);
  const dir = packageDir(packageId);
  if (existsSync(join(dir, 'manifest.json'))) return readOpenArena(packageId);
  const manifest = { ...payload, id: packageId, sourceRoot: root, importedAt: now() };
  for (const doc of documents) atomicWrite(join(dir, 'files', doc.path), doc.content, home);
  atomicWrite(join(dir, 'context.md'), contextFor(manifest, documents), home);
  atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), home);
  return readOpenArena(packageId);
}

export function readOpenArena(packageId) {
  const dir = packageDir(packageId),
    root = stateHome();
  const manifest = jsonRead(join(dir, 'manifest.json'), null, root);
  check(manifest, 'Knowledge package does not exist', 'invalid_record');
  const { id: storedId, sourceRoot, importedAt, ...payload } = manifest;
  assertDigest(digestRecord(payload), packageId, 'Knowledge manifest');
  assertDigest(storedId, packageId, 'Knowledge identity');
  check(
    digestRecord(manifest.contract) === digestRecord(ARENA_CONTRACT),
    'Unsupported knowledge contract',
    'integrity',
  );
  const documents = manifest.files.map((entry) => {
    portablePath(entry.path);
    const content = safeRead(join(dir, 'files', entry.path), root);
    assertDigest(hash(content), entry.hash, 'Frozen reference');
    assertDigest(hash(readDocument(entry.path, sourceRoot)), entry.rawHash, 'Original reference');
    return { ...entry, content };
  });
  check(
    JSON.stringify(inventory(sourceRoot)) ===
      JSON.stringify(manifest.files.map((entry) => entry.path)),
    'Knowledge dependency inventory changed',
    'integrity',
  );
  validateMetadata(manifest.metadata, documents);
  const context = safeRead(join(dir, 'context.md'), root);
  assertDigest(hash(context), hash(contextFor(manifest, documents)), 'Frozen public context');
  return {
    id: packageId,
    manifest,
    context,
    contextHash: hash(context),
    contextBytes: Buffer.byteLength(context),
  };
}
