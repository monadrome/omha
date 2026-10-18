import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import { hash } from './core.mjs';
import { invocation } from './adapters.mjs';
import { run } from './process.mjs';
import { atomicWrite, assertSafePath } from './storage.mjs';
import { assertDigest } from './open-arena.mjs';
import { check } from './validation.mjs';

export function requireWriteExecutor(profile, isolation) {
  check(
    isolation &&
      profile.adapter !== 'fake' &&
      profile.sandbox === 'external' &&
      profile.sandboxWrite === true &&
      isAbsolute(profile.sandboxCommand || '') &&
      ['{policy}', '{command}', '{args}'].every((token) => profile.sandboxArgs?.includes(token)),
    'Strict mode requires a write-capable external executor with host access-policy verification',
    'strict_unavailable',
  );
  assertSafePath(profile.sandboxCommand);
  assertDigest(
    hash(readFileSync(profile.sandboxCommand)),
    isolation.executorHash,
    'External write executor',
  );
}

export function writePolicy(
  file,
  { workspace, runtimeDir, publicDir, sourceRoot, siblings = [], home, isolation },
  root,
) {
  const policy = {
    version: 1,
    mode: 'write',
    allowedRead: [workspace, runtimeDir, publicDir, ...isolation.readOnlyPaths],
    allowedWrite: [workspace, runtimeDir],
    deniedRead: [sourceRoot, ...siblings, home, homedir(), ...isolation.excludedPaths],
    deniedWrite: ['outside-allowedWrite'],
    network: 'deny',
    providerConfiguration: 'isolated-home',
    backgroundProcesses: 'contained',
  };
  atomicWrite(file, JSON.stringify(policy), root);
  return policy;
}

// A supplied executor must enforce the policy, and pass actual local negative
// probes. Config names or an attestation flag alone do not admit strict writes.
export async function probeWriteExecutor(profile, policyPath, policy, options) {
  const marker = join(options.probeDir, `private-${randomUUID()}`);
  atomicWrite(marker, 'host-private probe marker');
  const readProbes = [marker];
  const directoryProbes = [];
  for (const directory of policy.deniedRead) {
    let stat;
    try {
      stat = lstatSync(directory);
    } catch {
      check(false, 'Strict denied-read target cannot be verified', 'strict_unavailable');
    }
    if (stat.isDirectory()) directoryProbes.push(directory);
    else if (stat.isFile()) readProbes.push(directory);
    else
      check(
        false,
        'Strict denied-read targets must be regular files or directories',
        'strict_unavailable',
      );
    // Test concrete files in the source/sibling/reference boundary as well as
    // directory listing. Probe output never contains file content.
    try {
      const head = join(directory, '.git', 'HEAD');
      if (lstatSync(head).isFile()) readProbes.push(head);
    } catch {
      /* boundary may not be a Git repository */
    }
    if (directory !== homedir()) {
      try {
        if (lstatSync(directory).isFile()) readProbes.push(directory);
        else {
          const entry = readdirSync(directory, { withFileTypes: true }).find((item) =>
            item.isFile(),
          );
          if (entry) readProbes.push(join(directory, entry.name));
        }
      } catch {
        /* unknown directory probes fail closed in the child */
      }
    }
  }
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const outsideTarget = join(options.probeDir, 'forbidden-write');
  const insideTarget = join(policy.allowedWrite[1], 'positive-control');
  const source = `
    const fs=require('node:fs'),net=require('node:net');
    const denied=${JSON.stringify([...new Set(directoryProbes)])};
    const reads=${JSON.stringify([...new Set(readProbes)])};
    const leaks=[];
    for(const p of denied){try{fs.readdirSync(p);leaks.push(p);}catch(e){if(!['EACCES','EPERM'].includes(e.code))leaks.push('unverified:'+p);}}
    for(const p of reads){try{fs.readFileSync(p);leaks.push(p);}catch(e){if(!['EACCES','EPERM'].includes(e.code))leaks.push('unverified:'+p);}}
    let wrote=false;try{fs.writeFileSync(${JSON.stringify(outsideTarget)},'probe');wrote=true;}catch(e){if(!['EACCES','EPERM'].includes(e.code))leaks.push('unverified-write');}
    let inside=false;try{fs.writeFileSync(${JSON.stringify(insideTarget)},'probe');inside=true;}catch{}
    const socket=net.connect({host:'127.0.0.1',port:${port}});
    let connected=false,networkDenied=false,emitted=false;
    socket.on('connect',()=>{connected=true;socket.destroy();});
    const done=()=>{if(emitted)return;emitted=true;console.log(JSON.stringify({leaks:leaks.length,wrote,inside,connected,networkDenied}));};
    socket.on('error',e=>{networkDenied=['EACCES','EPERM'].includes(e.code);done();});socket.on('close',()=>{if(connected)done();});
    setTimeout(()=>{if(!connected){socket.destroy();done();}},250);
  `;
  try {
    const spec = invocation(
      { ...profile, adapter: 'command', command: process.execPath, args: ['-e', source] },
      '',
      { mode: 'write', sandboxPolicyPath: policyPath },
    );
    const result = await run(spec.command, spec.args, {
      cwd: policy.allowedWrite[0],
      env: options.env,
      timeoutMs: 2000,
      signal: options.signal,
      maxOutputBytes: 4096,
    });
    let probe;
    try {
      probe = JSON.parse(result.stdout.trim().split('\n')[0]);
    } catch {
      /* fail closed below */
    }
    check(
      result.code === 0 &&
        !result.outputLimited &&
        !result.spawnError &&
        !result.callbackError &&
        !result.timedOut &&
        !result.cancelled &&
        probe?.leaks === 0 &&
        probe.wrote === false &&
        probe.inside === true &&
        probe.connected === false &&
        probe.networkDenied === true,
      'External executor failed strict read/write/network probes',
      'strict_unavailable',
    );
    // Containment beyond these probes remains an explicit executor contract.
    return {
      origin: 'host-observed-local-probes',
      policyHash: hash(readFileSync(policyPath)),
      result: probe,
      processContainment: 'external-executor-contract',
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
