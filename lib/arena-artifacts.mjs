import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { hash } from './core.mjs';
import { assertSafePath, atomicWrite, jsonRead, safeRead } from './storage.mjs';
import { assertNoSecrets } from './security.mjs';
import { assertDigest, digestRecord, portablePath } from './open-arena.mjs';
import { check } from './validation.mjs';

export const ARTIFACT_LIMITS = Object.freeze({
  files: 4096,
  fileBytes: 1048576,
  totalBytes: 8388608,
});
export function git(cwd, args, input, encoding = 'utf8') {
  return execFileSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.attributesFile=/dev/null',
      '-C',
      cwd,
      ...args,
    ],
    {
      input,
      encoding,
      timeout: 10000,
      maxBuffer: 24 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

export function inspectBundle(bundle, specification, auditDir, root) {
  assertSafePath(bundle);
  check(
    lstatSync(bundle).size <= 16 * 1024 * 1024,
    'Snapshot bundle exceeds size limit',
    'payload_limit',
  );
  assertDigest(hash(readFileSync(bundle)), specification.hash, 'Snapshot bundle');
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  git(auditDir, ['init', '--bare', '--quiet']);
  git(auditDir, ['bundle', 'verify', bundle]);
  const refs = git(auditDir, ['bundle', 'list-heads', bundle])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [commit, ref] = line.split(' ');
      return { ref, commit };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref, 'en'));
  check(
    JSON.stringify(refs) === JSON.stringify(specification.allowedRefs),
    'Snapshot refs differ from approved allowlist',
    'integrity',
  );
  git(auditDir, ['bundle', 'unbundle', bundle]);
  const inventory = git(auditDir, [
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objectname)',
  ])
    .trim()
    .split('\n')
    .sort();
  check(
    JSON.stringify(inventory) === JSON.stringify(specification.objectIds),
    'Snapshot object inventory differs from approved allowlist',
    'integrity',
  );
  check(
    specification.forbiddenObjectIds.every((oid) => !inventory.includes(oid)),
    'Snapshot contains excluded reference objects',
    'integrity',
  );
  check(
    refs.some((ref) => ref.commit === specification.baseCommit),
    'Snapshot base must be an approved ref',
    'integrity',
  );
  check(
    git(auditDir, ['cat-file', '-t', specification.baseCommit]).trim() === 'commit',
    'Snapshot base is not a commit',
    'integrity',
  );
  assertDigest(
    git(auditDir, ['rev-parse', `${specification.baseCommit}^{tree}`]).trim(),
    specification.baseTree,
    'Snapshot base tree',
  );
  check(
    !existsSync(join(auditDir, 'objects', 'info', 'alternates')),
    'Git alternates are forbidden',
    'integrity',
  );
  const tree = git(auditDir, ['ls-tree', '-r', specification.baseTree]);
  check(
    !/^(120000|160000) /m.test(tree),
    'Snapshot symlinks and submodules are unsupported',
    'unsupported_artifact',
  );
  atomicWrite(
    join(dirname(auditDir), 'bundle-audit.json'),
    JSON.stringify({
      refs,
      objectIds: inventory,
      hash: specification.hash,
      baseCommit: specification.baseCommit,
      baseTree: specification.baseTree,
    }),
    root,
  );
  return { refs, objectIds: inventory };
}

export function cloneBundle(bundle, workspace, baseCommit) {
  git(dirname(workspace), ['clone', '--quiet', '--no-local', '--no-checkout', bundle, workspace]);
  git(workspace, ['remote', 'remove', 'origin']);
  git(workspace, ['checkout', '--quiet', '--detach', baseCommit]);
  check(
    !existsSync(join(workspace, '.git', 'objects', 'info', 'alternates')),
    'Git alternates are forbidden',
    'integrity',
  );
  check(
    git(workspace, ['remote']).trim() === '',
    'Attempt cannot retain a source remote',
    'integrity',
  );
}

export function snapshotFiles(workspace, options = {}) {
  const files = [];
  const selected = options.paths === undefined ? null : new Set(options.paths.map(portablePath));
  const excluded = (options.excludePaths || []).map(portablePath);
  let bytes = 0;
  const walk = (dir = '') => {
    for (const entry of readdirSync(join(workspace, dir), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      if (!dir && entry.name === '.git') continue;
      const path = portablePath(dir ? `${dir}/${entry.name}` : entry.name);
      if (excluded.some((name) => path === name || path.startsWith(`${name}/`))) continue;
      if (
        selected &&
        !selected.has(path) &&
        ![...selected].some((name) => name.startsWith(`${path}/`))
      )
        continue;
      assertSafePath(join(workspace, path), workspace);
      if (entry.isDirectory()) walk(path);
      else {
        check(
          entry.isFile(),
          'Symlinks and special artifact files are unsupported',
          'unsupported_artifact',
        );
        const stat = lstatSync(join(workspace, path));
        check(
          stat.size <= ARTIFACT_LIMITS.fileBytes,
          'Artifact file exceeds size limit',
          'payload_limit',
        );
        const content = readFileSync(join(workspace, path));
        bytes += content.length;
        check(
          files.length < ARTIFACT_LIMITS.files && bytes <= ARTIFACT_LIMITS.totalBytes,
          'Artifact payload exceeds size limit',
          'payload_limit',
        );
        check(
          !content
            .subarray(0, 64)
            .toString()
            .startsWith('version https://git-lfs.github.com/spec/v1'),
          'LFS pointers cannot be certified',
          'unsupported_artifact',
        );
        if (!options.metadataOnly) assertNoSecrets(content.toString('utf8'));
        files.push({
          path,
          mode: stat.mode & 0o111 ? '100755' : '100644',
          bytes: content.length,
          hash: hash(content),
          ...(!options.metadataOnly ? { content: content.toString('base64') } : {}),
          binary: content.includes(0) || !isUtf8(content),
        });
      }
    }
  };
  walk();
  return files;
}

function writeTree(repository, files) {
  const tree = new Map();
  for (const file of files) {
    let node = tree;
    const parts = file.path.split('/');
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
    }
    const blob = git(
      repository,
      ['hash-object', '-w', '--stdin'],
      Buffer.from(file.content, 'base64'),
    ).trim();
    node.set(parts.at(-1), { ...file, blob });
  }
  const make = (node) =>
    git(
      repository,
      ['mktree', '-z'],
      Buffer.concat(
        [...node].map(([name, item]) =>
          Buffer.from(
            item instanceof Map
              ? `040000 tree ${make(item)}\t${name}\0`
              : `${item.mode} blob ${item.blob}\t${name}\0`,
          ),
        ),
      ),
    ).trim();
  return make(tree);
}

export function sealArtifact({
  workspace,
  dir,
  repository,
  candidateId,
  batchId,
  status,
  baseCommit,
  baseTree,
  allowedPaths,
  root,
  executionSpecHash,
}) {
  const files = snapshotFiles(workspace);
  const candidateTree = writeTree(repository, files);
  const patch = git(
    repository,
    [
      'diff',
      '--binary',
      '--full-index',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      baseTree,
      candidateTree,
      '--',
    ],
    undefined,
    null,
  );
  const changed = git(repository, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    baseTree,
    candidateTree,
  ])
    .split('\0')
    .filter(Boolean);
  check(
    changed.every((path) =>
      allowedPaths.some(
        (allowed) => allowed === '.' || path === allowed || path.startsWith(`${allowed}/`),
      ),
    ),
    'Artifact writes exceed the execution specification',
    'scope_violation',
  );
  const before = git(repository, ['ls-tree', '-r', '-z', baseTree])
    .split('\0')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf('\t') + 1));
  const manifest = {
    version: 1,
    candidateId,
    batchId,
    attempt: 1,
    status,
    baseCommit,
    baseTree,
    candidateTree,
    patchHash: hash(patch),
    patchBytes: patch.length,
    patchEncoding: isUtf8(patch) ? 'utf8' : 'base64',
    snapshotHash: digestRecord(files),
    files: files.map(({ content, ...file }) => ({ ...file, added: !before.includes(file.path) })),
    deleted: before.filter((path) => !files.some((file) => file.path === path)),
    changed,
    origin: 'host-observed-files',
    authority: { by: 'host', source: 'artifact-collector', executionSpecHash },
  };
  atomicWrite(join(dir, 'snapshot.json'), JSON.stringify(files), root);
  atomicWrite(join(dir, 'patch.diff'), patch, root);
  atomicWrite(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), root);
  return { ...manifest, digest: digestRecord(manifest) };
}

export function readArtifact(dir, expected, root, repository) {
  const manifest = jsonRead(join(dir, 'manifest.json'), null, root);
  check(manifest, 'Artifact is absent', 'integrity');
  assertDigest(digestRecord(manifest), expected, 'Artifact manifest');
  const files = jsonRead(join(dir, 'snapshot.json'), null, root);
  check(Array.isArray(files), 'Artifact snapshot is absent', 'integrity');
  assertDigest(digestRecord(files), manifest.snapshotHash, 'Artifact snapshot');
  for (const file of files) {
    portablePath(file.path);
    const bytes = Buffer.from(file.content, 'base64');
    assertDigest(hash(bytes), file.hash, 'Artifact file');
    check(bytes.length === file.bytes, 'Artifact file length changed', 'integrity');
  }
  assertDigest(
    hash(safeRead(join(dir, 'patch.diff'), root, null)),
    manifest.patchHash,
    'Artifact patch',
  );
  if (repository)
    assertDigest(writeTree(repository, files), manifest.candidateTree, 'Candidate tree');
  return { manifest, files };
}

export function materializeArtifact(files, directory, root) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of files) {
    portablePath(file.path);
    const target = assertSafePath(join(directory, file.path), root);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, Buffer.from(file.content, 'base64'), {
      flag: 'wx',
      mode: file.mode === '100755' ? 0o700 : 0o600,
    });
  }
}
