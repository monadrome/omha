export const TRANSIENT = new Set(['rate_limit', 'capacity', 'timeout', 'transport']);
export const FALLBACK = new Set([...TRANSIENT, 'spawn', 'circuit_open']);

export function retryAfter(value, nowMs = Date.now()) {
  if (value === undefined || value === null) return null;
  const string = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(string)) return Math.ceil(Number(string) * 1000);
  const timestamp = Date.parse(string);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

export function retryAfterFromText(input, nowMs = Date.now()) {
  const source = String(input);
  for (const line of [source, ...source.split(/\r?\n/)]) {
    try {
      const object = JSON.parse(line);
      const headers = object.headers || object.error?.headers || {};
      const value =
        Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1] ??
        object.retry_after ??
        object.error?.retry_after;
      const parsed = retryAfter(value, nowMs);
      if (parsed !== null) return parsed;
    } catch {
      /* CLI diagnostics may be plain text. */
    }
  }
  const match = source.match(/retry-after\s*[=:]\s*([^\r\n]+)/i);
  return match ? retryAfter(match[1].replace(/["'}]+$/, ''), nowMs) : null;
}

export function classify(input = {}) {
  if (input.cancelled) return { kind: 'cancellation', stage: 'execution' };
  if (input.timedOut) return { kind: 'timeout', stage: 'execution' };
  if (input.spawnError)
    return {
      kind: ['ENOENT', 'EACCES'].includes(input.spawnError.code) ? 'spawn' : 'transport',
      stage: 'spawn',
    };
  if (input.callbackError) return { kind: 'task', stage: 'host' };
  if (input.outputLimited) return { kind: 'task', stage: 'output_limit' };
  if (input.parseError?.code === 'malformed_output')
    return { kind: 'malformed_output', stage: 'parse' };
  if (input.parseError?.code === 'task') return { kind: 'task', stage: 'parse' };
  const value = `${input.stderr || ''}\n${input.error || ''}\n${input.code !== 0 || input.parseError ? input.stdout || '' : ''}`;
  if (
    /\b(?:401|403)\b|unauthori[sz]ed|authentication|invalid api key|not logged in|login required/i.test(
      value,
    )
  )
    return { kind: 'auth', stage: 'provider' };
  if (
    /unknown (?:option|flag|model)|invalid (?:config|argument|model)|configuration error|unsupported model/i.test(
      value,
    )
  )
    return { kind: 'configuration', stage: 'configuration' };
  if (/\b429\b|rate[ -]?limit|too many requests|quota exceeded|resource exhausted/i.test(value))
    return { kind: 'rate_limit', stage: 'provider' };
  if (/\b(?:502|503|529)\b|overload|capacity|temporarily unavailable/i.test(value))
    return { kind: 'capacity', stage: 'provider' };
  if (
    /ECONNRESET|ECONNREFUSED|ENETUNREACH|EPIPE|fetch failed|network error|socket hang up|connection reset/i.test(
      value,
    )
  )
    return { kind: 'transport', stage: 'transport' };
  return { kind: 'task', stage: input.parseError ? 'parse' : 'execution' };
}
