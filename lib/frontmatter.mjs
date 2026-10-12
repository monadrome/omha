import { parseDocument, stringify } from 'yaml';
import { check, OmhaError } from './validation.mjs';

export function parseMarkdown(input) {
  const match = input.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  check(match, 'Markdown record requires YAML frontmatter', 'invalid_record');
  const doc = parseDocument(match[1], { uniqueKeys: true, schema: 'core' });
  if (doc.errors.length) throw new OmhaError('invalid_record', 'Invalid YAML frontmatter');
  let metadata;
  try {
    metadata = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new OmhaError('invalid_record', 'YAML aliases are not permitted');
  }
  check(
    metadata && typeof metadata === 'object' && !Array.isArray(metadata),
    'Frontmatter must be a mapping',
    'invalid_record',
  );
  return { metadata, content: match[2].replace(/^\r?\n/, '') };
}

export function markdown(metadata, content) {
  return `---\n${stringify(metadata, { lineWidth: 0 })}---\n\n${content.trim()}\n`;
}
