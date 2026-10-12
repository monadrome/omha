export class OmhaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OmhaError';
    this.code = code;
    this.details = details;
  }
}

export function check(condition, message, code = 'configuration') {
  if (!condition) throw new OmhaError(code, message);
}

export function object(value, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

export function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value))
    check(allowed.includes(key), `${label}: unknown field ${key}`);
}

export function text(value, label, max = 1000000) {
  check(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      !value.includes('\0') &&
      Buffer.byteLength(value) <= max,
    `${label} must be nonempty text (at most ${max} bytes)`,
  );
  return value;
}

export function id(value, label = 'id') {
  check(
    typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value),
    `${label} must be a simple identifier`,
  );
  return value;
}

export function number(value, label, min, max, integer = true) {
  check(
    Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)),
    `${label} must be ${integer ? 'an integer' : 'a number'} in [${min}, ${max}]`,
  );
  return value;
}

export function choice(value, values, label) {
  check(values.includes(value), `${label} must be one of ${values.join(', ')}`);
  return value;
}
