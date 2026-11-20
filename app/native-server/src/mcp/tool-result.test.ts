import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { foldTexts, foldToolResult, splitSummaryAndJson } from './tool-result';

const result = (texts: string[], isError = false): CallToolResult => ({
  content: texts.map((text) => ({ type: 'text' as const, text })),
  isError,
});
const only = (folded: CallToolResult): string => {
  expect(folded.content).toHaveLength(1);
  return (folded.content[0] as any).text;
};
const CONTEXT = '{"context":{"tab_id":42,"host":"app.workato.com","profile":"centium"}}';

describe('splitSummaryAndJson', () => {
  test('reads whole JSON, a headline then JSON, and plain text', () => {
    expect(splitSummaryAndJson('{"a":1}')).toEqual({ json: '{"a":1}', value: { a: 1 } });
    expect(splitSummaryAndJson('found 2 tables\n[{"id":1},{"id":2}]')).toEqual({
      summary: 'found 2 tables',
      json: '[{"id":1},{"id":2}]',
      value: [{ id: 1 }, { id: 2 }],
    });
    expect(splitSummaryAndJson('[uid=3] button "Save"\n[uid=4] link')).toEqual({
      summary: '[uid=3] button "Save"\n[uid=4] link',
    });
  });

  test('a headline of several lines keeps every line ahead of the JSON', () => {
    expect(splitSummaryAndJson('saved\n{not json}\n{"version_no":7}')).toEqual({
      summary: 'saved\n{not json}',
      json: '{"version_no":7}',
      value: { version_no: 7 },
    });
  });
});

describe('foldToolResult', () => {
  test('a payload block and the context block become one object', () => {
    const folded = foldToolResult(result(['{"count":4,"recipes":[]}', CONTEXT]));
    expect(only(folded)).toBe(
      '{"count":4,"recipes":[],"context":{"tab_id":42,"host":"app.workato.com","profile":"centium"}}',
    );
  });

  test('a headline goes under headline, ahead of the payload', () => {
    const folded = foldToolResult(result(['connected as Roma\n{"user":{"id":1}}', CONTEXT]));
    expect(JSON.parse(only(folded))).toEqual({
      headline: 'connected as Roma',
      user: { id: 1 },
      context: { tab_id: 42, host: 'app.workato.com', profile: 'centium' },
    });
    expect(only(folded).startsWith('{"headline":')).toBe(true);
  });

  test('a top-level array goes under items', () => {
    const folded = foldToolResult(result(['found 2 lookup tables\n[{"id":1},{"id":2}]', CONTEXT]));
    expect(JSON.parse(only(folded))).toEqual({
      headline: 'found 2 lookup tables',
      items: [{ id: 1 }, { id: 2 }],
      context: { tab_id: 42, host: 'app.workato.com', profile: 'centium' },
    });
  });

  test('text with a context block is text plus context', () => {
    const folded = foldToolResult(result(['recipe 7 stopped', CONTEXT]));
    expect(JSON.parse(only(folded))).toEqual({
      text: 'recipe 7 stopped',
      context: { tab_id: 42, host: 'app.workato.com', profile: 'centium' },
    });
  });

  test('plain text, one compact object and image results come back as they are', () => {
    const snapshot = result(['[uid=3] button "Save"\n[uid=4] link']);
    expect(foldToolResult(snapshot)).toBe(snapshot);
    const compact = result(['{"bridge_version":"2.0.1"}']);
    expect(foldToolResult(compact)).toBe(compact);
    const image: CallToolResult = {
      content: [
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        { type: 'text', text: '{"saved_to":"x.png"}' },
      ],
    };
    expect(foldToolResult(image)).toBe(image);
  });

  test('pretty-printed JSON is written compact', () => {
    const folded = foldToolResult(result([JSON.stringify({ leases: [], note: 'a b' }, null, 2)]));
    expect(only(folded)).toBe('{"leases":[],"note":"a b"}');
  });

  test('numbers keep the text the tool wrote', () => {
    const folded = foldToolResult(result(['{"id":12345678901234567890,"ratio":1.0}', CONTEXT]));
    expect(only(folded)).toContain('"id":12345678901234567890,"ratio":1.0,');
  });

  test("a payload's own summary is its own, and its headline or context key is kept: the folded one takes an underscore", () => {
    const folded = foldToolResult(
      result(['done\n{"summary":{"added":1},"headline":"h","context":"c"}', CONTEXT]),
    );
    expect(JSON.parse(only(folded))).toEqual({
      _headline: 'done',
      summary: { added: 1 },
      headline: 'h',
      context: 'c',
      _context: { tab_id: 42, host: 'app.workato.com', profile: 'centium' },
    });
  });

  test('an empty object with a context is just the context', () => {
    expect(only(foldToolResult(result(['{}', CONTEXT])))).toBe(
      '{"context":{"tab_id":42,"host":"app.workato.com","profile":"centium"}}',
    );
  });

  test('a block that starts like a context but holds more is a payload', () => {
    const folded = foldToolResult(result(['ok', '{"context":{"a":1},"other":2}']));
    expect(JSON.parse(only(folded))).toEqual({ headline: 'ok', context: { a: 1 }, other: 2 });
  });

  test('folding twice changes nothing', () => {
    const once = foldToolResult(result(['found 1\n[{"id":1}]', CONTEXT]));
    expect(foldToolResult(once)).toBe(once);
    const failed = foldToolResult(result(['TabNotFound: no tab'], true));
    expect(only(foldToolResult(failed))).toBe(only(failed));
  });
});

describe('foldToolResult on a failure', () => {
  test('the leading code becomes error.code', () => {
    const folded = foldToolResult(
      result(
        ['Error calling tool: TabNotFound: No Workato tab open in this Chrome profile.'],
        true,
      ),
    );
    expect(folded.isError).toBe(true);
    expect(JSON.parse(only(folded))).toEqual({
      error: { code: 'TabNotFound', message: 'No Workato tab open in this Chrome profile.' },
    });
  });

  test('a code behind the name of the tool is still the code', () => {
    const folded = foldToolResult(
      result(['workato_whoami failed: TabLeased: Every Workato tab is leased.'], true),
    );
    expect(JSON.parse(only(folded)).error).toEqual({
      code: 'TabLeased',
      message: 'workato_whoami failed: Every Workato tab is leased.',
    });
  });

  test('a failure with no code is a ToolError, and a tool-name prefix is not a code', () => {
    expect(
      JSON.parse(only(foldToolResult(result(['Error: lease must be a string.'], true)))),
    ).toEqual({
      error: { code: 'ToolError', message: 'lease must be a string.' },
    });
    const named = foldToolResult(result(['workato_ui_save_recipe_code: version moved'], true));
    expect(JSON.parse(only(named)).error).toEqual({
      code: 'ToolError',
      message: 'workato_ui_save_recipe_code: version moved',
    });
  });

  test('fields a failure came with stay next to the error', () => {
    const folded = foldToolResult(
      result(
        [
          '{"ok":false,"error":"VersionConflict: recipe moved to 9","stage":"preflight","version_no":9}',
        ],
        true,
      ),
    );
    expect(JSON.parse(only(folded))).toEqual({
      error: { code: 'VersionConflict', message: 'recipe moved to 9' },
      ok: false,
      stage: 'preflight',
      version_no: 9,
    });
  });

  test('JSON under a message goes to details, and the stage a code names stays in the message', () => {
    const folded = foldToolResult(
      result(
        [
          'WorkatoApiError (meta): GET /recipes/1.json returned HTTP 404\n--- body excerpt ---\n{"status":404,"message":"Not Found"}',
        ],
        true,
      ),
    );
    expect(JSON.parse(only(folded))).toEqual({
      error: { code: 'WorkatoApiError', message: '(meta) GET /recipes/1.json returned HTTP 404' },
      details: { status: 404, message: 'Not Found' },
    });
  });

  test('a failure that is one JSON object may name its own code', () => {
    const folded = foldToolResult(
      result(['{"status":"failed","code":"E42","message":"save failed"}'], true),
    );
    expect(JSON.parse(only(folded))).toEqual({
      error: { code: 'E42', message: 'save failed' },
      status: 'failed',
    });
  });

  test('an error that is already structured is left alone', () => {
    const text = '{"error":{"code":"Timeout","message":"no answer"},"waited_ms":120000}';
    const failed = result([text], true);
    expect(foldToolResult(failed)).toBe(failed);
  });
});

describe('foldTexts', () => {
  test('is null for text alone, and JSON for a file otherwise', () => {
    expect(foldTexts(['just text'])).toBeNull();
    expect(foldTexts(['found 2\n[1,2]'])).toBe('{"headline":"found 2","items":[1,2]}');
    // Two documents in one text are two results, not a headline and a payload.
    expect(foldTexts(['{"a":1}\n{"b":2}'])).toBe('{"results":[{"a":1},{"b":2}]}');
    expect(foldTexts(['{"a":1}', '{"b":2}'])).toBe('{"results":[{"a":1},{"b":2}]}');
  });
});
