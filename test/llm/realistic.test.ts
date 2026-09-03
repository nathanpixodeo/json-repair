import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('Python-flavored literals from an LLM trained on Python examples', () => {
  const input = "{'name': 'x', 'ok': True, 'v': None}";

  it('safe mode normalises Python-style True', () => {
    expect(repairJson("{'name': 'x', 'ok': True}")).toBe('{"name":"x","ok":true}');
  });

  it('safe mode normalises Python-style None alongside True', () => {
    expect(repairJson(input)).toBe('{"name":"x","ok":true,"v":null}');
  });

  it('aggressive mode agrees with safe mode on the whole dict repr', () => {
    expect(repairJson(input, { mode: 'aggressive' })).toBe('{"name":"x","ok":true,"v":null}');
  });

  it('still refuses NaN in safe mode, since null would lose the number', () => {
    expect(() => repairJson("{'ratio': NaN}")).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
    expect(repairJson("{'ratio': NaN}", { mode: 'aggressive' })).toBe('{"ratio":null}');
  });
});

describe('a tool-call / function-call argument blob', () => {
  it('repairs a fenced tool-call arguments object with a trailing comma', () => {
    const input = [
      "I'll look that up for you.",
      '```json',
      '{',
      '  "name": "search_flights",',
      '  "arguments": {',
      '    "origin": "JFK",',
      '    "destination": "CDG",',
      '    "date": "2026-09-10",',
      '    "passengers": 2,',
      '  }',
      '}',
      '```',
    ].join('\n');
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({
      name: 'search_flights',
      arguments: {
        origin: 'JFK',
        destination: 'CDG',
        date: '2026-09-10',
        passengers: 2,
      },
    });
  });

  it('repairs an unquoted-key tool-call blob with no surrounding fence', () => {
    const input = '{name: "get_weather", arguments: {location: "Paris", unit: "celsius"}}';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({
      name: 'get_weather',
      arguments: { location: 'Paris', unit: 'celsius' },
    });
  });
});

describe('a JSON array of objects surrounded by prose', () => {
  it('extracts and compacts an array of result objects with an internal trailing comma', () => {
    const input = [
      'Here are the top 3 results:',
      '',
      '[',
      '  {"id": 1, "title": "First",},',
      '  {"id": 2, "title": "Second"},',
      '  {"id": 3, "title": "Third"}',
      ']',
      '',
      "Let me know if you'd like more details.",
    ].join('\n');
    const result = repairJson(input);
    expect(result).toBe(
      '[{"id":1,"title":"First"},{"id":2,"title":"Second"},{"id":3,"title":"Third"}]',
    );
    expect(JSON.parse(result)).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
      { id: 3, title: 'Third' },
    ]);
  });

  it('returns an already-valid pretty-printed array of objects verbatim, prose stripped', () => {
    const pretty = '[\n  {"id": 1},\n  {"id": 2}\n]';
    const input = `Results:\n${pretty}\nDone.`;
    expect(repairJson(input)).toBe(pretty);
  });
});

describe('a response with an explanatory comment inside the JSON', () => {
  it('strips a line comment following a field and compacts the result', () => {
    const input = [
      '```json',
      '{',
      '  "status": "ok", // request succeeded',
      '  "data": [1, 2, 3]',
      '}',
      '```',
    ].join('\n');
    const result = repairJson(input);
    expect(result).toBe('{"status":"ok","data":[1,2,3]}');
  });

  it('strips a block comment used to annotate a field', () => {
    const input = '{ "count": /* number of items */ 3 }';
    const result = repairJson(input);
    expect(result).toBe('{"count":3}');
  });
});

describe('a streamed response cut off mid-token', () => {
  it('recovers the surviving prefix of a response cut off mid-word inside a string', () => {
    const input = '{"role": "assistant", "content": "The answer is 42. Let me explain fur';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({
      role: 'assistant',
      content: 'The answer is 42. Let me explain fur',
    });
  });

  it('recovers a streamed tool-call cut off mid-argument value', () => {
    const input = '{"name":"get_weather","arguments":{"location":"Par';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({
      name: 'get_weather',
      arguments: { location: 'Par' },
    });
  });

  it('recovers a streamed array of chat deltas cut off after a comma', () => {
    const input = '{"deltas": ["Hi", "there", "how", "are",';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ deltas: ['Hi', 'there', 'how', 'are'] });
  });
});
