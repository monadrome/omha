#!/usr/bin/env node
import { finishAutoClose } from '../lib/terminal.mjs';

try {
  const record = await finishAutoClose(process.argv[2], process.argv[3]);
  if (record.autoClose.state !== 'closed') process.exitCode = 1;
} catch {
  // A durable scheduled/closing claim is never replayed after a worker failure.
  process.exitCode = 1;
}
