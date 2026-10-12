#!/usr/bin/env node
import { FINAL_MARKER, hash, now, stateHome } from '../lib/core.mjs';
import { handoffPaths } from '../lib/handoff-protocol.mjs';
import { atomicWrite, jsonRead, safeRead } from '../lib/storage.mjs';
import { run, processFingerprint } from '../lib/process.mjs';
import { environment, environmentSecrets, redact } from '../lib/security.mjs';
import { backendFor } from '../lib/backends.mjs';
import { Transform } from 'node:stream';

const record = jsonRead(process.argv[2], null, stateHome());
if (!record) process.exit(2);
const paths = handoffPaths(record.id);
const env = environment(record.envAllowlist);
env.OMHA_PROMPT_FILE = record.promptFile;
const secrets = environmentSecrets(env);
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
let inputStream;
if (record.interactive) {
  // Canonical terminal buffers truncate long pasted lines on macOS. The owned
  // terminal is put in raw mode, then Enter is normalized for line-mode workers.
  process.stdin.setRawMode?.(true);
  inputStream = new Transform({
    transform(chunk, encoding, callback) {
      const value = chunk.toString('utf8');
      if (value.includes('\x03')) controller.abort();
      if (value.includes('\x04')) {
        this.push(null);
        callback();
        return;
      }
      callback(null, value.replaceAll('\x03', '').replaceAll('\r', '\n'));
    },
  });
  process.stdin.pipe(inputStream);
}
const buffers = { stdout: '', stderr: '' };
const print = (kind, chunk) => {
  buffers[kind] += chunk.toString('utf8');
  const index = buffers[kind].lastIndexOf('\n');
  if (index >= 0) {
    process[kind].write(redact(buffers[kind].slice(0, index + 1), secrets));
    buffers[kind] = buffers[kind].slice(index + 1);
  }
};
try {
  const result = await run(record.command, record.args, {
    cwd: record.cwd,
    env,
    timeoutMs: record.timeoutMs,
    signal: controller.signal,
    input: record.interactive ? undefined : safeRead(record.promptFile, stateHome()),
    inputStream,
    onOutput: print,
    onSpawn: (childPid) =>
      atomicWrite(
        paths.processFile,
        JSON.stringify({
          token: record.owner.token,
          pid: process.pid,
          childPid,
          fingerprint: processFingerprint(childPid),
          startedAt: now(),
        }),
        stateHome(),
      ),
  });
  process.stdin.setRawMode?.(false);
  for (const kind of ['stdout', 'stderr'])
    if (buffers[kind]) process[kind].write(redact(buffers[kind], secrets));
  const state = result.cancelled
    ? 'cancelled'
    : result.timedOut
      ? 'timed_out'
      : result.code === 0 && !result.outputLimited && !result.spawnError
        ? 'completed'
        : 'failed';
  const final = {
    token: record.owner.token,
    state,
    exitCode: result.code ?? (result.timedOut ? 124 : 1),
    signal: result.signal,
    responseHash: hash(result.stdout),
    at: now(),
  };
  atomicWrite(paths.outputFile, redact(`${result.stdout}\n${result.stderr}`, secrets), stateHome());
  atomicWrite(paths.finalFile, JSON.stringify(final), stateHome());
  process.stdout.write(`\n${FINAL_MARKER}${JSON.stringify(final)}\n`);
  if (state === 'timed_out') {
    for (let i = 0; i < 20; i += 1) {
      const current = jsonRead(record.recordFile, null, stateHome());
      if (current?.ref) {
        try {
          await backendFor(current).close(current);
          current.backendClosed = true;
          atomicWrite(
            current.recordFile,
            JSON.stringify({ ...current, state }, null, 2),
            stateHome(),
          );
        } catch {
          /* poll/cancel will retry cleanup */
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
} catch {
  process.stdin.setRawMode?.(false);
  atomicWrite(
    paths.finalFile,
    JSON.stringify({ token: record.owner.token, state: 'failed', exitCode: 1, at: now() }),
    stateHome(),
  );
}
process.exit(0);
