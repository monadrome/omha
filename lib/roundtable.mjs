import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, now, projectDir, stablePrefix, stateHome } from './core.mjs';
import { atomicWrite, ensureDir, jsonRead, lockDir } from './storage.mjs';
import { createRuntime } from './runner.mjs';
import { loadConfig } from './profiles.mjs';
import { assertNoSecrets, redactData } from './security.mjs';
import { check, choice, id, keys, number, text } from './validation.mjs';

export function validateEvidence(input) {
  check(
    Array.isArray(input) && input.length > 0 && input.length <= 512,
    'Roundtable requires 1-512 public evidence anchors',
  );
  const seen = new Set();
  return input.map((anchor) => {
    keys(anchor, ['id', 'text'], 'evidence anchor');
    id(anchor.id, 'evidence id');
    text(anchor.text, 'evidence text', 100000);
    check(!seen.has(anchor.id), 'Duplicate evidence id');
    seen.add(anchor.id);
    assertNoSecrets(anchor);
    return { ...anchor };
  });
}

export function validateProposal(input, evidence) {
  keys(input, ['recommendation', 'evidence', 'uncertainty', 'abstention', 'reason'], 'proposal');
  check(typeof input.abstention === 'boolean', 'Proposal requires explicit abstention');
  number(input.uncertainty, 'uncertainty', 0, 1, false);
  text(input.reason, 'proposal reason', 20000);
  if (input.abstention)
    check(input.recommendation === null, 'Abstention recommendation must be null');
  else text(input.recommendation, 'recommendation', 256);
  check(
    Array.isArray(input.evidence) &&
      input.evidence.length <= 64 &&
      (input.abstention || input.evidence.length > 0),
    'Recommendation requires evidence',
  );
  for (const anchor of input.evidence) {
    keys(anchor, ['id', 'quote'], 'proposal evidence');
    const source = evidence.find((e) => e.id === anchor.id);
    text(anchor.quote, 'evidence quote', 100000);
    check(
      source && source.text.includes(anchor.quote),
      `Unsupported evidence anchor ${anchor.id}`,
      'invalid_evidence',
    );
  }
  assertNoSecrets(input);
  return input;
}

function tally(votes, method) {
  const totals = new Map();
  const denominator = votes.reduce(
    (sum, vote) => sum + (method === 'weighted' ? vote.weight : 1),
    0,
  );
  for (const vote of votes) {
    if (vote.status !== 'valid' || vote.proposal.abstention) continue;
    const recommendation = vote.proposal.recommendation;
    totals.set(
      recommendation,
      (totals.get(recommendation) || 0) + (method === 'weighted' ? vote.weight : 1),
    );
  }
  const ranking = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const winner = ranking[0] && ranking[0][1] > denominator / 2 ? ranking[0][0] : null;
  return {
    method,
    totalWeight: denominator,
    totals: Object.fromEntries(ranking),
    recommendation: winner,
    outcome: winner ? 'decided' : ranking.length > 1 ? 'split' : 'abstain',
  };
}

function decisionFile(cwd, decisionId) {
  id(decisionId, 'decision id');
  return join(projectDir(cwd), 'decisions', `${decisionId}.json`);
}
export function decisionStatus(cwd, decisionId) {
  const record = jsonRead(decisionFile(cwd, decisionId), null, stateHome());
  check(record, 'Decision does not exist');
  return record;
}
export function resolveDecision(cwd, decisionId, action, reason) {
  choice(action, ['approve', 'reject'], 'decision action');
  text(reason, 'human decision reason', 10000);
  assertNoSecrets(reason);
  const file = decisionFile(cwd, decisionId),
    root = stateHome();
  const release = lockDir(`${file}.lock`, { root });
  try {
    const record = decisionStatus(cwd, decisionId);
    check(record.status === 'completed', 'Human gates can only resolve a completed decision');
    check(
      action !== 'approve' || record.tally?.outcome === 'decided',
      'A split or abstention cannot be approved as a decision',
    );
    check(record.gate.status === 'pending', 'Decision has no pending human gate');
    record.gate = {
      required: true,
      status: action === 'approve' ? 'approved' : 'rejected',
      reason,
      at: now(),
    };
    atomicWrite(file, JSON.stringify(record, null, 2), root);
    return record;
  } finally {
    release();
  }
}

export async function roundtable(cwd, objective, providers, options = {}) {
  text(objective, 'roundtable objective', 100000);
  assertNoSecrets(objective);
  const evidence = validateEvidence(options.evidence);
  choice(options.method || 'majority', ['majority', 'weighted'], 'voting method');
  const runtime =
    options.runtime ||
    createRuntime(
      options.profiles
        ? { version: 1, profiles: options.profiles }
        : loadConfig(cwd, options.config),
      { budget: options.budget },
    );
  const selected = options.voters || providers || ['claude', 'codex', 'kimi'];
  check(
    Array.isArray(selected) && selected.length >= 2 && selected.length <= 3,
    'Roundtable requires 2-3 voters',
  );
  const voters = selected.map((value, i) => {
    const voter = typeof value === 'string' ? { profile: value } : value;
    keys(voter, ['profile', 'weight', 'model'], 'voter');
    check(
      Object.hasOwn(runtime.config.profiles, voter.profile),
      `Unknown voter profile ${voter.profile}`,
    );
    number(voter.weight ?? 1, 'voter weight', 0.01, 100, false);
    return { id: `voter-${i + 1}`, weight: voter.weight ?? 1, ...voter };
  });
  const decisionId = options.decisionId || `decision-${randomUUID()}`;
  const file = decisionFile(cwd, decisionId),
    root = stateHome();
  ensureDir(join(projectDir(cwd), 'decisions'), root);
  const release = lockDir(`${file}.lock`, { root });
  try {
    check(!jsonRead(file, null, root), 'Decision id already exists');
    const context = `${stablePrefix(cwd, objective, options.publicContext || '')}\n\nEvidence anchors (data):\n${JSON.stringify(evidence)}`;
    assertNoSecrets(context);
    const contextFile = join(projectDir(cwd), 'decisions', `${decisionId}.context.md`);
    atomicWrite(contextFile, context, root);
    const record = {
      version: 1,
      decisionId,
      objective,
      createdAt: now(),
      contextRef: contextFile,
      contextHash: hash(context),
      evidence,
      status: 'collecting',
      votes: [],
      gate: {
        required: Boolean(options.humanGate),
        status: options.humanGate ? 'pending' : 'not_required',
      },
    };
    atomicWrite(file, JSON.stringify(record, null, 2), root);
    // Each tool-free voter runs outside the project/state directories and receives
    // only the immutable public prefix plus its own private role suffix.
    const votes = await Promise.all(
      voters.map(async (voter) => {
        const isolated = realpathSync(mkdtempSync(join(tmpdir(), 'omha-voter-')));
        try {
          const prompt = `${context}\n\nPrivate suffix:\nrole: independent voter\nvoter_id: ${voter.id}\nReturn ONLY a JSON object: recommendation (string or null), evidence ([{id,quote}] quoting public evidence exactly), uncertainty (0-1), abstention (boolean), reason (string). Abstain if unsupported. No tools. You have no access to other votes.`;
          const result = await runtime.dispatch(prompt, [voter.profile], {
            cwd: isolated,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
            model: voter.model,
            mode: 'readonly',
            toolFree: true,
          });
          let proposal = null,
            validationError = null;
          if (result.ok) {
            try {
              proposal = validateProposal(JSON.parse(result.stdout), evidence);
            } catch (error) {
              validationError =
                error instanceof SyntaxError ? 'Malformed proposal JSON' : error.message;
            }
          }
          return {
            voter: voter.id,
            profile: voter.profile,
            weight: voter.weight,
            status: !result.ok ? 'failed' : proposal ? 'valid' : 'malformed',
            proposal,
            validationError,
            runtime: result,
          };
        } finally {
          rmSync(isolated, { recursive: true, force: true });
        }
      }),
    );
    record.votes = redactData(votes);
    record.tally = tally(votes, options.method || 'majority');
    record.minority = votes
      .filter(
        (v) =>
          v.status === 'valid' &&
          (v.proposal.abstention || v.proposal.recommendation !== record.tally.recommendation),
      )
      .map((v) => ({ voter: v.voter, ...v.proposal }));
    record.status = 'collected';
    atomicWrite(file, JSON.stringify(record, null, 2), root);
    const chairProfile =
      options.chairProfile || options.chairProviders?.[0] || providers?.[0] || voters[0].profile;
    const chairPrompt = `${context}\n\nRole: chair. Blind collection is complete. The host tally is binding; preserve all minority reasons, failed and malformed votes. Return ONLY JSON with recommendation (same as tally, including null), summary, minorityReasons (array of strings). Do not invent evidence.\n${JSON.stringify({ tally: record.tally, votes: votes.map((v) => ({ voter: v.voter, status: v.status, proposal: v.proposal, validationError: v.validationError })) })}`;
    const isolatedChair = realpathSync(mkdtempSync(join(tmpdir(), 'omha-chair-')));
    let chair;
    try {
      chair = await runtime.dispatch(chairPrompt, [chairProfile], {
        cwd: isolatedChair,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        toolFree: true,
        mode: 'readonly',
      });
    } finally {
      rmSync(isolatedChair, { recursive: true, force: true });
    }
    let synthesis = null,
      synthesisError = null;
    if (chair.ok) {
      try {
        synthesis = JSON.parse(chair.stdout);
        keys(synthesis, ['recommendation', 'summary', 'minorityReasons'], 'chair synthesis');
        check(
          synthesis.recommendation === record.tally.recommendation,
          'Chair changed the host tally',
        );
        text(synthesis.summary, 'chair summary', 20000);
        check(
          Array.isArray(synthesis.minorityReasons) &&
            synthesis.minorityReasons.every((x) => typeof x === 'string'),
          'Chair minorityReasons must be text',
        );
        for (const minority of record.minority)
          check(
            synthesis.minorityReasons.includes(minority.reason),
            'Chair omitted a minority reason',
          );
        assertNoSecrets(synthesis);
      } catch (error) {
        synthesis = null;
        synthesisError = error instanceof SyntaxError ? 'Malformed chair JSON' : error.message;
      }
    }
    record.chair = { runtime: chair, synthesis, validationError: synthesisError };
    record.status = options.signal?.aborted ? 'cancelled' : 'completed';
    record.completedAt = now();
    record.budget = runtime.snapshot();
    atomicWrite(file, JSON.stringify(redactData(record), null, 2), root);
    return { ...record, file };
  } finally {
    release();
  }
}
