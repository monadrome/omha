import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp } from './helpers.mjs';
import { tmuxBackend } from '../lib/backends.mjs';

test(
  'tmux ownership option round-trips and private socket cleanup uses its creation prefix',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const root = temp('omha-backend-test-');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const state = join(root, 'tmux.json');
    const executable = join(bin, 'tmux');
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = ${JSON.stringify(state)};
const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { calls: [] };
saved.calls.push(args);
if (args[2] === 'set-option' && args[5].startsWith('@')) saved.owner = { key: args[5], value: args[6] };
if (args[2] === 'show-option') console.log(saved.owner?.key === args[6] ? saved.owner.value : '');
if (args[2] === 'display-message') console.log('0');
fs.writeFileSync(file, JSON.stringify(saved));
`,
    );
    chmodSync(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    let record;
    t.after(() => {
      process.env.PATH = previousPath;
      if (record?.socketDir) rmSync(record.socketDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    record = {
      id: 'fixture',
      cwd: root,
      recordFile: join(root, 'record.json'),
      owner: { token: 'owner-token' },
    };
    Object.assign(record, await tmuxBackend.prepare(record));
    assert.equal(record.ref, record.session);
    await tmuxBackend.start(record);
    await tmuxBackend.verify(record);
    await assert.rejects(tmuxBackend.verify({ ...record, owner: { token: 'wrong' } }), {
      code: 'ownership',
    });
    await tmuxBackend.close(record);
    assert.equal(existsSync(record.socketDir), false);
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    assert.equal(saved.calls.at(-1)[2], 'kill-session');
    assert.equal(saved.calls.at(-1)[4], `=${record.session}`);
  },
);
