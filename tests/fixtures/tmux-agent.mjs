import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [cli, root] = process.argv.slice(2);
const id = process.env.OMHA_HANDOFF_ID;
const save = (path, value) => {
  const pending = `${path}.${process.pid}`;
  writeFileSync(pending, typeof value === 'string' ? value : JSON.stringify(value));
  renameSync(pending, path);
};
const invoke = (args, input) =>
  JSON.parse(
    execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      input: input && JSON.stringify(input),
      timeout: 10000,
    }),
  );
// The child can start before the parent has saved its terminal references.
while (
  JSON.parse(readFileSync(join(process.env.OMHA_HOME, 'handoffs', id, 'record.json'))).state !==
  'running'
) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
save(join(root, 'ready'), id);
for await (const line of createInterface({ input: process.stdin })) {
  if (line === 'go on') {
    console.log('go on submitted');
    save(join(root, 'received'), line);
    continue;
  }
  const request = JSON.parse(line);
  let result;
  try {
    if (request.close)
      result = invoke([
        'auto-close',
        '--completed',
        '--reason',
        'Offline goal verified',
        '--delay-ms',
        String(request.delayMs || 500),
      ]);
    else
      result = invoke(['handoff', 'activity', '--input', '-'], {
        agent: 'codex',
        state: request.state,
      });
    if (!request.close) console.log('stream disconnected before completion');
    save(join(root, 'reply'), { ok: true, result });
    if (request.exitAfterClose) break;
  } catch (error) {
    save(join(root, 'reply'), { ok: false, error: String(error.stderr || error) });
  }
}
