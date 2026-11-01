// Local read-only dashboard for Omha state. The server is a plain node:http
// listener bound to the loopback interface by default; it only reads the
// state directory and never mutates it unless the operator starts it with
// `allowActions`, in which case the two available actions call the same
// host-validated functions the CLI uses — the UI never becomes a second,
// weaker boundary.
import { createServer } from 'node:http';
import { hash, now, projectIdentity } from './core.mjs';
import { check, id, keys, object, OmhaError } from './validation.mjs';
import { environmentSecrets, redactData } from './security.mjs';
import { cancelRun, projectStatus, runStatus, sendTaskMessage } from './orchestrator.mjs';
import { listTeams } from './teams.mjs';
import { listAgents } from './agents.mjs';
import { listReviews } from './review.mjs';
import { delay } from './runner.mjs';

export const UI_DEFAULTS = { host: '127.0.0.1', port: 7800, intervalMs: 1000 };

export function uiStatus(cwd) {
  const identity = projectIdentity(cwd);
  return redactData(
    {
      generatedAt: now(),
      projectId: identity.projectId,
      worktreeId: identity.worktreeId,
      projectRoot: identity.root,
      ...projectStatus(cwd),
      teams: listTeams(cwd),
      agents: Object.entries(listAgents().agents).map(([name, agent]) => ({
        name,
        description: agent.description,
        role: agent.role,
      })),
      reviews: listReviews(),
    },
    environmentSecrets(process.env),
  );
}

export async function* watchUiStatus(cwd, options = {}) {
  const intervalMs = Math.max(10, options.intervalMs ?? UI_DEFAULTS.intervalMs);
  let previous;
  while (!options.signal?.aborted) {
    const snapshot = uiStatus(cwd);
    const digest = hash(JSON.stringify(snapshot));
    if (digest !== previous) {
      previous = digest;
      yield snapshot;
    }
    try {
      await delay(intervalMs, options.signal);
    } catch (error) {
      if (error.code !== 'cancellation') throw error;
      break;
    }
  }
}

function actions(cwd, input) {
  object(input, 'action request');
  keys(input, ['action', 'params'], 'action request');
  id(input.action, 'action name');
  const params = input.params ?? {};
  object(params, 'action params');
  if (input.action === 'cancel_run') {
    keys(params, ['runId'], 'cancel_run params');
    return cancelRun(cwd, params.runId);
  }
  if (input.action === 'send_task_message') {
    keys(params, ['runId', 'taskId', 'content'], 'send_task_message params');
    return sendTaskMessage(cwd, params.runId, params.taskId, params.content, { sender: 'host' });
  }
  throw new OmhaError('configuration', `Unknown UI action: ${input.action}`);
}

function sse(response, data) {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function startUi(cwd, options = {}) {
  const host = options.host || UI_DEFAULTS.host;
  const port = Math.trunc(Number(options.port ?? UI_DEFAULTS.port));
  check(Number.isInteger(port) && port >= 0 && port <= 65535, 'UI port must be 0-65535');
  const allowActions = options.allowActions === true;
  const intervalMs = Math.max(10, options.intervalMs ?? UI_DEFAULTS.intervalMs);
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const fail = (status, error) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          redactData({ ok: false, error: { code: error.code || 'error', message: error.message } }),
        ),
      );
    };
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(uiStatus(cwd)));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/stream') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      (async () => {
        for await (const snapshot of watchUiStatus(cwd, { signal: controller.signal, intervalMs }))
          sse(response, snapshot);
      })()
        .catch(() => {})
        .finally(() => response.end());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/action') {
      if (!allowActions)
        return fail(
          403,
          new OmhaError('forbidden', 'UI actions are disabled; start with --allow-actions'),
        );
      let body = '';
      let size = 0;
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) {
          fail(413, new OmhaError('payload_too_large', 'UI action body exceeds 64 KiB'));
          request.destroy();
          return;
        }
        body += chunk;
      });
      request.on('end', () => {
        if (!response.writableEnded) {
          try {
            const parsed = body.trim() ? JSON.parse(body) : {};
            const result = actions(cwd, parsed);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(redactData({ ok: true, result })));
          } catch (error) {
            if (!response.writableEnded) fail(error instanceof SyntaxError ? 400 : 422, error);
          }
        }
      });
      return;
    }
    fail(404, new OmhaError('not_found', `No UI route ${request.method} ${url.pathname}`));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    host,
    port: server.address().port,
    url: `http://${host}:${server.address().port}/`,
    close: () =>
      new Promise((resolve) => {
        controller.abort();
        server.close(resolve);
      }),
  };
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Omha dashboard</title>
<style>
  :root { color-scheme: dark; --bg:#101418; --panel:#171d24; --line:#232c36; --text:#dbe4ee; --dim:#7d8b9b; --ok:#4cc38a; --warn:#e5b567; --bad:#e5734c; --accent:#6cb6ff; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; padding: 14px 20px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .08em; text-transform: uppercase; }
  header .meta { color: var(--dim); font-size: 12px; }
  main { padding: 0 20px 40px; }
  section { margin-top: 22px; }
  section > h2 { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .1em; margin: 0 0 8px; }
  .grid { display: grid; gap: 10px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: top; }
  th { color: var(--dim); font-weight: normal; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--line); }
  .ok { color: var(--ok); border-color: var(--ok); }
  .bad { color: var(--bad); border-color: var(--bad); }
  .warn { color: var(--warn); border-color: var(--warn); }
  .accent { color: var(--accent); }
  .dim { color: var(--dim); }
  details summary { cursor: pointer; color: var(--dim); }
  .tasks { margin: 6px 0 2px; }
  .bar { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--ok); }
  button { background: var(--panel); color: var(--bad); border: 1px solid var(--bad); border-radius: 4px; font: inherit; font-size: 11px; padding: 2px 10px; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
  .error { color: var(--bad); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Omha</h1>
  <span class="meta" id="project"></span>
  <span class="meta" id="updated"></span>
  <span class="meta" id="conn">connecting…</span>
</header>
<main>
  <section id="runs-section"><h2>Runs</h2><div id="runs" class="grid"></div></section>
  <section id="teams-section"><h2>Teams</h2><div id="teams" class="grid"></div></section>
  <section id="handoffs-section"><h2>Handoffs</h2><div id="handoffs" class="grid"></div></section>
  <section id="decisions-section"><h2>Decisions &amp; reviews</h2><div id="decisions" class="grid"></div></section>
  <section id="agents-section"><h2>Agents</h2><div id="agents" class="grid"></div></section>
</main>
<script>
const state = {};
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pill = (value, cls) => value == null ? '' : \`<span class="pill \${cls || ''}">\${esc(value)}</span>\`;
const statusClass = (value) => ({ completed: 'ok', running: 'accent', failed: 'bad', cancelled: 'dim', interrupted: 'warn' }[value] || 'warn');

function renderRuns(runs) {
  const el = document.getElementById('runs');
  el.innerHTML = runs.length ? '' : '<p class="dim">No runs yet.</p>';
  for (const run of runs) {
    const tasks = Object.values(run.tasks || {});
    const done = tasks.filter((t) => t.status === 'completed').length;
    const percent = tasks.length ? Math.round((100 * done) / tasks.length) : 0;
    const rows = tasks.map((t) => \`<tr><td>\${esc(t.id)}</td><td>\${pill(t.status, statusClass(t.status))}</td>
      <td>\${pill(t.acceptanceAccepted == null ? '' : t.acceptanceAccepted ? 'accepted' : 'acceptance failed', t.acceptanceAccepted ? 'ok' : 'bad')}</td>
      <td>\${pill(t.reviewApproved == null ? '' : t.reviewApproved ? 'review approved' : 'review rejected', t.reviewApproved ? 'ok' : 'bad')}</td>
      <td>\${t.inputWait ? pill('needs input', 'warn') : ''} \${t.attempts ? esc('attempts ' + t.attempts) : ''}</td></tr>\`).join('');
    el.insertAdjacentHTML('beforeend', \`
      <details><summary>\${pill(run.status, statusClass(run.status))} <b>\${esc(run.runId)}</b>
        <span class="dim">\${done}/\${tasks.length} tasks · updated \${esc((run.updatedAt || '').replace('T', ' ').slice(0, 19))}</span></summary>
        <div class="bar"><i style="width:\${percent}%"></i></div>
        <table class="tasks"><tbody>\${rows}</tbody></table>
        <p class="dim">metrics: \${esc(JSON.stringify(run.metrics))}</p>
      </details>\`);
  }
}

function renderTeams(teams) {
  const el = document.getElementById('teams');
  el.innerHTML = teams.length ? '' : '<p class="dim">No teams yet.</p>';
  for (const team of teams) {
    const rows = (team.tasks || []).map((t) => \`<tr><td>\${esc(t.subject)}</td><td>\${pill(t.status, t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'bad' : '')}</td>
      <td>\${t.derived ? pill(t.derived, t.derived === 'ready' ? 'accent' : t.derived === 'blocked' ? 'bad' : 'dim') : ''}</td>
      <td class="dim">\${esc(t.assignee || 'unclaimed')}</td></tr>\`).join('');
    el.insertAdjacentHTML('beforeend', \`<details><summary><b>\${esc(team.name)}</b>
      <span class="dim">\${esc(team.teamId)} · \${team.open}/\${team.tasks.length ?? 0} open · mailbox \${esc(JSON.stringify(team.mailbox || {}))}</span></summary>
      <table><tbody>\${rows}</tbody></table></details>\`);
  }
}

function renderHandoffs(handoffs) {
  const el = document.getElementById('handoffs');
  el.innerHTML = handoffs.length ? '' : '<p class="dim">No handoffs.</p>';
  const rows = handoffs.map((h) => \`<tr><td>\${esc(h.name || h.id)}</td><td>\${pill(h.state, ['completed', 'closed'].includes(h.state) ? 'ok' : ['failed', 'timed_out', 'interrupted'].includes(h.state) ? 'bad' : 'accent')}</td>
    <td class="dim">\${esc(h.backend || '')}</td><td class="dim">\${esc((h.updatedAt || '').replace('T', ' ').slice(0, 19))}</td></tr>\`).join('');
  el.insertAdjacentHTML('beforeend', \`<table><tbody>\${rows}</tbody></table>\`);
}

function renderDecisions(decisions, reviews) {
  const el = document.getElementById('decisions');
  const parts = [];
  for (const d of decisions || [])
    parts.push(\`<tr><td>\${esc(d.decisionId)}</td><td>\${pill(d.status, d.status === 'completed' ? 'ok' : 'warn')}</td><td class="dim">\${esc(d.outcome || d.status)} · gate \${esc(d.gate && d.gate.status)}</td></tr>\`);
  for (const r of reviews || [])
    parts.push(\`<tr><td>\${esc(r.reviewId || r.id)}</td><td>\${pill(r.state || r.status, (r.state || r.status) === 'completed' ? 'ok' : 'warn')}</td><td class="dim">\${esc(r.kind || 'review')}</td></tr>\`);
  el.innerHTML = parts.length ? \`<table><tbody>\${parts.join('')}</tbody></table>\` : '<p class="dim">Nothing pending.</p>';
}

function renderAgents(agents) {
  const el = document.getElementById('agents');
  el.innerHTML = agents.length ? '' : '<p class="dim">Registry empty — add agents with omha agents add.</p>';
  const rows = agents.map((a) => \`<tr><td>\${esc(a.name)}</td><td>\${pill(a.role)}</td><td class="dim">\${esc(a.description)}</td></tr>\`).join('');
  el.insertAdjacentHTML('beforeend', \`<table><tbody>\${rows}</tbody></table>\`);
}

function render(s) {
  state.last = s;
  document.getElementById('project').textContent = \`project \${s.projectId}\`;
  document.getElementById('updated').textContent = \`updated \${(s.generatedAt || '').replace('T', ' ').slice(0, 19)}\`;
  renderRuns(s.runs || []);
  renderTeams(s.teams || []);
  renderHandoffs(s.handoffs || []);
  renderDecisions(s.decisions, s.reviews);
  renderAgents(s.agents || []);
}

function connect() {
  const source = new EventSource('/api/stream');
  source.onopen = () => (document.getElementById('conn').textContent = 'live');
  source.onerror = () => {
    document.getElementById('conn').textContent = 'reconnecting…';
  };
  source.onmessage = (event) => {
    try { render(JSON.parse(event.data)); } catch (error) { console.error(error); }
  };
}

fetch('/api/status').then((r) => r.json()).then(render).catch(() => {});
connect();
</script>
</body>
</html>`;
}
