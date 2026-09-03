import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('fence info-string tagging', () => {
  const rows: [string, string, string][] = [
    ['json-tagged (lowercase)', '```json', '```'],
    ['JSON-tagged (uppercase, case-insensitive)', '```JSON', '```'],
    ['jsonc-tagged', '```jsonc', '```'],
    ['json5-tagged', '```json5', '```'],
    ['untagged backtick fence', '```', '```'],
    ['javascript-tagged (treated as a generic fenced block)', '```javascript', '```'],
    ['tilde fence, json-tagged', '~~~json', '~~~'],
    ['tilde fence, untagged', '~~~', '~~~'],
  ];

  for (const [label, open, close] of rows) {
    it(`extracts and repairs JSON from a ${label} fence`, () => {
      const input = `${open}\n{"a":1}\n${close}`;
      expect(repairJson(input)).toBe('{"a":1}');
    });
  }

  it('repairs content inside a fence while extracting it', () => {
    const input = '```json\n{a:1,}\n```';
    expect(repairJson(input)).toBe('{"a":1}');
  });
});

describe('fence indentation', () => {
  it('recognises a fence indented by up to 3 spaces', () => {
    const input = '   ```json\n{"a":1}\n   ```';
    expect(repairJson(input)).toBe('{"a":1}');
  });

  it('recognises an indented tilde fence', () => {
    const input = '  ~~~json\n{"a":1}\n  ~~~';
    expect(repairJson(input)).toBe('{"a":1}');
  });
});

describe('fence marker length', () => {
  it('recognises a 4-backtick fence opened and closed with matching markers', () => {
    const input = '````json\n{"a":1}\n````';
    expect(repairJson(input)).toBe('{"a":1}');
  });

  it('recognises a 5-backtick fence', () => {
    const input = '`````\n{"a":1}\n`````';
    expect(repairJson(input)).toBe('{"a":1}');
  });
});

describe('formatting rule: verbatim vs. canonical output', () => {
  it('returns pretty-printed valid JSON inside a fence completely unchanged', () => {
    const pretty = '{\n  "a": 1,\n  "b": [1, 2]\n}';
    const input = `\`\`\`json\n${pretty}\n\`\`\``;
    expect(repairJson(input)).toBe(pretty);
  });

  it('compacts pretty-printed JSON inside a fence once an internal repair is required', () => {
    const brokenPretty = '{\n  "a": 1,\n  "b": [1, 2],\n}'; // trailing comma before the closing brace
    const input = `\`\`\`json\n${brokenPretty}\n\`\`\``;
    expect(repairJson(input)).toBe('{"a":1,"b":[1,2]}');
  });
});

describe('fence tier priority', () => {
  it('prefers a JSON-tagged fence over a plain fence that appears earlier in the document', () => {
    const input = [
      'Here is some context:',
      '```',
      '{"decoy":true}',
      '```',
      'And here is the actual answer:',
      '```json',
      '{"real":true}',
      '```',
    ].join('\n');
    expect(repairJson(input)).toBe('{"real":true}');
  });

  it('prefers a jsonc-tagged fence over an earlier javascript-tagged fence', () => {
    const input = ['```javascript', '{"decoy":1}', '```', '```jsonc', '{"real":2}', '```'].join(
      '\n',
    );
    expect(repairJson(input)).toBe('{"real":2}');
  });

  it('falls back to a plain fenced block when no tagged fence is present', () => {
    const input = ['Some notes.', '```', '{"a":1,}', '```'].join('\n');
    expect(repairJson(input)).toBe('{"a":1}');
  });
});
