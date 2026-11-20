import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import {
  applyAutoFile,
  autoFileSessionDir,
  combineAutoFileRules,
  CORE_AUTO_FILE_RULES,
  DEFAULT_AUTO_FILE_THRESHOLD_CHARS,
  parseResultPayload,
} from '../../mcp/auto-file';
import * as autoFile from '../../mcp/auto-file';
import { workatoModule } from '.';

/**
 * Core auto-file with the Workato module's rules on top: the rule set the
 * router uses while the module is installed.
 */
const RULES = combineAutoFileRules([CORE_AUTO_FILE_RULES, workatoModule.autoFile!]);
const isAutoFileEligible = (name: string) => autoFile.isAutoFileEligible(name, RULES);
const prepareAutoFileCall = (name: string, args: Record<string, unknown>) =>
  autoFile.prepareAutoFileCall(name, args, RULES);
const withOutFileToolSchemas = (tools: Tool[]) => autoFile.withOutFileToolSchemas(tools, RULES);

const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  isError: false,
});

const parseSummary = (result: { content: any[] }) => {
  const block = result.content.find((entry) => entry.type === 'text');
  return JSON.parse(block.text);
};

// A 16-byte payload; enough to prove the bytes reach disk decoded.
const PIXEL = 'AAECAwQFBgcICQoLDA0ODw==';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofile-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('browser read tools', () => {
  test('page-sized chrome reads spill to a file; chrome actions do not', () => {
    for (const name of [
      'chrome_snapshot',
      'chrome_get_web_content',
      'chrome_javascript',
      'chrome_search_page',
      'chrome_find_elements',
    ]) {
      expect(isAutoFileEligible(name)).toBe(true);
    }
    // chrome_act reports what its actions did (navigation, dialog): never a file summary.
    expect(isAutoFileEligible('chrome_act')).toBe(false);
    expect(isAutoFileEligible('chrome_click_element')).toBe(false);
    expect(isAutoFileEligible('chrome_navigate')).toBe(false);
  });

  test('a large plain-text snapshot is written as .txt with a summary', () => {
    const { args, plan } = prepareAutoFileCall('chrome_snapshot', {
      tabId: 7,
      auto_file_threshold_chars: 10,
    });
    expect(args).toEqual({ tabId: 7 });
    const result = applyAutoFile('chrome_snapshot', plan, textResult('RootWebArea [uid=1] big'));
    const summary = parseSummary(result);
    expect(summary.mode).toBe('auto_file');
    expect(summary.content_type).toBe('text/plain');
    expect(path.basename(summary.saved_to)).toMatch(/^chrome_snapshot-7-.*\.txt$/);
    expect(fs.readFileSync(summary.saved_to, 'utf8')).toBe('RootWebArea [uid=1] big');
    fs.rmSync(summary.saved_to, { force: true });
  });
});

describe('chrome_javascript out_file', () => {
  const jsResult = (payload: Record<string, unknown>) => textResult(JSON.stringify(payload));

  test('asks the extension for raw output only when out_file is explicit', () => {
    const outFile = path.join(tmpDir, 'template.html');
    const explicit = prepareAutoFileCall('chrome_javascript', {
      tabId: 3,
      code: 'x',
      out_file: outFile,
    });
    expect(explicit.args).toEqual({ tabId: 3, code: 'x', rawOutput: true });
    expect(explicit.plan?.raw).toBe(true);

    // A caller cannot ask for unredacted inline output by passing the internal arg.
    const inline = prepareAutoFileCall('chrome_javascript', {
      tabId: 3,
      code: 'x',
      rawOutput: true,
    });
    expect(inline.args).toEqual({ tabId: 3, code: 'x' });
    expect(inline.plan?.raw).toBeUndefined();

    // Other read tools never get it.
    const snapshot = prepareAutoFileCall('chrome_snapshot', { out_file: outFile });
    expect(snapshot.args).toEqual({});
  });

  test('writes the returned value itself, not the envelope', () => {
    const outFile = path.join(tmpDir, 'template.html');
    const { plan } = prepareAutoFileCall('chrome_javascript', { tabId: 3, out_file: outFile });
    const value = '<a href="/x?id=1&c=2">x</a>\n<p>a=1; b=2</p>';

    const result = applyAutoFile(
      'chrome_javascript',
      plan,
      jsResult({
        success: true,
        tabId: 3,
        engine: 'cdp',
        result: value,
        metrics: { elapsedMs: 5 },
      }),
    ) as any;

    expect(fs.readFileSync(outFile, 'utf8')).toBe(value);
    expect(result.content).toHaveLength(1);
    expect(parseSummary(result)).toEqual({
      tool: 'chrome_javascript',
      mode: 'out_file',
      saved_to: path.resolve(outFile),
      bytes: Buffer.byteLength(value, 'utf8'),
      sha256: require('crypto').createHash('sha256').update(value, 'utf8').digest('hex'),
      raw: true,
      content_type: 'text/plain',
      tabId: 3,
      engine: 'cdp',
      metrics: { elapsedMs: 5 },
      note: expect.stringContaining('unredacted'),
    });
  });

  test('keeps a job poll that has no result yet inline and writes nothing', () => {
    const outFile = path.join(tmpDir, 'job.json');
    const { plan } = prepareAutoFileCall('chrome_javascript', {
      job_id: 'job_1',
      out_file: outFile,
    });
    const running = jsResult({ success: true, tabId: 3, job_id: 'job_1', state: 'running' });
    expect(applyAutoFile('chrome_javascript', plan, running)).toBe(running);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  test('keeps the warnings of an isolated-world fallback next to the file', () => {
    const outFile = path.join(tmpDir, 'isolated.txt');
    const { plan } = prepareAutoFileCall('chrome_javascript', { out_file: outFile });
    const warning =
      'Debugger is busy. Falling back to chrome.scripting.executeScript (ISOLATED world).';
    const result = applyAutoFile(
      'chrome_javascript',
      plan,
      jsResult({ success: true, engine: 'scripting', result: 'value', warnings: [warning] }),
    ) as any;
    expect(fs.readFileSync(outFile, 'utf8')).toBe('value');
    expect(parseSummary(result)).toMatchObject({ engine: 'scripting', warnings: [warning] });
  });

  test('flags a value an older extension build still redacted', () => {
    const outFile = path.join(tmpDir, 'old.txt');
    const { plan } = prepareAutoFileCall('chrome_javascript', { out_file: outFile });
    const result = applyAutoFile(
      'chrome_javascript',
      plan,
      jsResult({ success: true, result: '[BLOCKED: Cookie/query string data]', redacted: true }),
    ) as any;
    expect(parseSummary(result)).toMatchObject({ raw: false, redacted: true });
  });

  test('an auto_file spill keeps the redacted envelope', () => {
    const { args, plan } = prepareAutoFileCall('chrome_javascript', {
      tabId: 3,
      auto_file_threshold_chars: 10,
    });
    expect(args).toEqual({ tabId: 3 });
    const envelope = JSON.stringify({ success: true, result: 'x'.repeat(50), redacted: true });
    const summary = parseSummary(applyAutoFile('chrome_javascript', plan, textResult(envelope)));
    expect(summary.mode).toBe('auto_file');
    expect(fs.readFileSync(summary.saved_to, 'utf8')).toBe(envelope);
    fs.rmSync(summary.saved_to, { force: true });
  });
});

describe('isAutoFileEligible', () => {
  test('claims workato tools and chrome_screenshot, never an existing out_file tool', () => {
    expect(isAutoFileEligible('workato_job_trace')).toBe(true);
    expect(isAutoFileEligible('chrome_screenshot')).toBe(true);
    // Both can return a large document and neither declares its own out_file.
    expect(isAutoFileEligible('workato_recipe_version_diff')).toBe(true);
    expect(isAutoFileEligible('workato_recipe_status')).toBe(true);
    expect(isAutoFileEligible('workato_pull_recipe')).toBe(false);
    expect(isAutoFileEligible('workato_api_request')).toBe(false);
    expect(isAutoFileEligible('workato_adapter_meta')).toBe(false);
    expect(isAutoFileEligible('workato_lcap_page_get')).toBe(false);
    expect(isAutoFileEligible('get_windows_and_tabs')).toBe(false);
  });
});

describe('prepareAutoFileCall', () => {
  test('strips the file params before the call leaves for the extension', () => {
    const prepared = prepareAutoFileCall('workato_job_trace', {
      recipe_id: 12,
      job_id: 5,
      out_file: path.join(tmpDir, 'trace.json'),
      auto_file: false,
      auto_file_threshold_chars: 10,
    });

    expect(prepared.args).toEqual({ recipe_id: 12, job_id: 5 });
    expect(prepared.plan).toMatchObject({
      tool: 'workato_job_trace',
      outFile: path.resolve(path.join(tmpDir, 'trace.json')),
      auto: false,
      thresholdChars: 10,
      idHint: '12',
    });
  });

  test('turns auto mode on for a read tool and leaves the args untouched', () => {
    const prepared = prepareAutoFileCall('workato_list_jobs', { recipe_id: 3 });
    expect(prepared.args).toEqual({ recipe_id: 3 });
    expect(prepared.plan).toMatchObject({
      auto: true,
      thresholdChars: DEFAULT_AUTO_FILE_THRESHOLD_CHARS,
    });
  });

  test('leaves a non-eligible tool and its own out_file alone', () => {
    const args = { recipe_id: 1, out_file: path.join(tmpDir, 'recipe.json') };
    const prepared = prepareAutoFileCall('workato_pull_recipe', args);
    expect(prepared.args).toBe(args);
    expect(prepared.plan).toBeUndefined();
  });

  test('does not build a plan for a write tool that was not asked for a file', () => {
    const prepared = prepareAutoFileCall('workato_rename_recipe', { recipe_id: 1, name: 'x' });
    expect(prepared.plan).toBeUndefined();
  });

  test('rejects an out_file whose directory does not exist', () => {
    expect(() =>
      prepareAutoFileCall('workato_job_trace', {
        out_file: path.join(tmpDir, 'nope', 'trace.json'),
      }),
    ).toThrow(/directory does not exist/);
  });

  test('rejects an out_file that is an existing directory', () => {
    expect(() => prepareAutoFileCall('chrome_javascript', { code: 'x', out_file: tmpDir })).toThrow(
      /is a directory/,
    );
  });

  test('rejects a non-numeric threshold', () => {
    expect(() =>
      prepareAutoFileCall('workato_job_trace', { auto_file_threshold_chars: 'big' }),
    ).toThrow(/non-negative number/);
  });
});

describe('applyAutoFile text results', () => {
  test('writes the full text and returns a summary when out_file is given', () => {
    const outFile = path.join(tmpDir, 'jobs.json');
    const { plan } = prepareAutoFileCall('workato_list_jobs', { recipe_id: 9, out_file: outFile });
    const payload = {
      version_no: 42,
      truncated: false,
      has_more: true,
      next_page: 2,
      jobs: [{ id: 1 }, { id: 2 }, { id: 3 }],
      counts: { ok: 3 },
    };

    const result = applyAutoFile(
      'workato_list_jobs',
      plan,
      textResult(JSON.stringify(payload)),
    ) as any;

    expect(fs.existsSync(outFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outFile, 'utf8'))).toEqual(payload);
    expect(result.content).toHaveLength(1);

    const summary = parseSummary(result);
    expect(summary).toMatchObject({
      tool: 'workato_list_jobs',
      mode: 'out_file',
      saved_to: path.resolve(outFile),
      content_type: 'application/json',
      version_no: 42,
      truncated: false,
      has_more: true,
      next_page: 2,
      item_counts: { jobs: 3 },
      note: expect.stringContaining('full result written to file'),
    });
    expect(summary.top_level_keys).toEqual([
      'version_no',
      'truncated',
      'has_more',
      'next_page',
      'jobs',
      'counts',
    ]);
    expect(summary.bytes).toBe(Buffer.byteLength(JSON.stringify(payload), 'utf8'));
  });

  test('leaves a small result inline in auto mode', () => {
    const { plan } = prepareAutoFileCall('workato_list_jobs', { recipe_id: 9 });
    const original = textResult(JSON.stringify({ jobs: [] }));
    expect(applyAutoFile('workato_list_jobs', plan, original)).toBe(original);
  });

  test('spills to a session file once the result crosses the threshold', () => {
    const { plan } = prepareAutoFileCall('workato_job_trace', {
      recipe_id: 77,
      auto_file_threshold_chars: 50,
    });
    const payload = { steps: new Array(40).fill({ name: 'step', input: 'x'.repeat(20) }) };

    const result = applyAutoFile(
      'workato_job_trace',
      plan,
      textResult(JSON.stringify(payload)),
    ) as any;
    const summary = parseSummary(result);

    expect(summary.mode).toBe('auto_file');
    expect(summary.saved_to.startsWith(autoFileSessionDir())).toBe(true);
    expect(path.basename(summary.saved_to)).toMatch(/^job_trace-77-/);
    expect(summary.item_counts).toEqual({ steps: 40 });
    expect(JSON.parse(fs.readFileSync(summary.saved_to, 'utf8'))).toEqual(payload);
    fs.rmSync(summary.saved_to, { force: true });
  });

  test('writes the `summary\\nJSON` response form as the one JSON object the call returns inline', () => {
    const outFile = path.join(tmpDir, 'search.json');
    const { plan } = prepareAutoFileCall('workato_search_recipes', { out_file: outFile });
    const text = `Found 2 recipes\n${JSON.stringify({ recipes: [{ id: 1 }, { id: 2 }] })}`;

    const result = applyAutoFile('workato_search_recipes', plan, textResult(text)) as any;
    const summary = parseSummary(result);

    expect(JSON.parse(fs.readFileSync(outFile, 'utf8'))).toEqual({
      headline: 'Found 2 recipes',
      recipes: [{ id: 1 }, { id: 2 }],
    });
    expect(summary.content_type).toBe('application/json');
    expect(summary.item_counts).toEqual({ recipes: 2 });
  });

  test('copies the search coverage keys into the summary', () => {
    const outFile = path.join(tmpDir, 'jobs.json');
    const { plan } = prepareAutoFileCall('workato_list_jobs', { out_file: outFile });
    const payload = {
      jobs: [{ id: 'j-1' }],
      search_mode: 'local',
      coverage: { scanned: 500, matched: 1, complete: false },
      truncated: false,
      next_cursor: 'j-9',
    };

    const result = applyAutoFile(
      'workato_list_jobs',
      plan,
      textResult(JSON.stringify(payload)),
    ) as any;
    const summary = parseSummary(result);

    expect(summary.search_mode).toBe('local');
    expect(summary.coverage).toEqual({ scanned: 500, matched: 1, complete: false });
    // Preserve false: "not truncated" is information, not noise.
    expect(summary.truncated).toBe(false);
    expect(summary.next_cursor).toBe('j-9');
  });

  test('never writes for a failed call', () => {
    const outFile = path.join(tmpDir, 'error.json');
    const { plan } = prepareAutoFileCall('workato_list_jobs', { out_file: outFile });
    const failure = { content: [{ type: 'text' as const, text: 'boom' }], isError: true };

    expect(applyAutoFile('workato_list_jobs', plan, failure)).toBe(failure);
    expect(fs.existsSync(outFile)).toBe(false);
  });

  test('is a no-op without a plan', () => {
    const original = textResult('x'.repeat(200000));
    expect(applyAutoFile('workato_list_jobs', undefined, original)).toBe(original);
  });
});

describe('applyAutoFile image results', () => {
  test('decodes the image block to bytes and keeps the image inline', () => {
    const outFile = path.join(tmpDir, 'shot.jpg');
    const { plan } = prepareAutoFileCall('chrome_screenshot', { out_file: outFile });
    const result = applyAutoFile('chrome_screenshot', plan, {
      content: [
        { type: 'image' as const, data: PIXEL, mimeType: 'image/jpeg' },
        { type: 'text' as const, text: JSON.stringify({ name: 'shot', width: 800 }) },
      ],
      isError: false,
    }) as any;

    expect(fs.readFileSync(outFile)).toEqual(Buffer.from(PIXEL, 'base64'));
    expect(result.content[0]).toEqual({ type: 'image', data: PIXEL, mimeType: 'image/jpeg' });

    const summary = parseSummary(result);
    expect(summary).toMatchObject({
      mode: 'out_file',
      saved_to: path.resolve(outFile),
      bytes: 16,
      content_type: 'image/jpeg',
      image_returned: true,
      metadata: { name: 'shot', width: 800 },
    });
  });

  test('drops the image block when no_inline is set', () => {
    const outFile = path.join(tmpDir, 'shot.png');
    const { args, plan } = prepareAutoFileCall('chrome_screenshot', {
      out_file: outFile,
      no_inline: true,
    });

    // Every file param is read in the bridge; none of them reaches the extension.
    expect(args).toEqual({});

    const result = applyAutoFile('chrome_screenshot', plan, {
      content: [{ type: 'image' as const, data: PIXEL, mimeType: 'image/png' }],
      isError: false,
    }) as any;

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(parseSummary(result).image_returned).toBe(false);
  });

  test('does not spill a screenshot without being asked', () => {
    const { plan } = prepareAutoFileCall('chrome_screenshot', { auto_file_threshold_chars: 4 });
    const original = {
      content: [{ type: 'image' as const, data: PIXEL, mimeType: 'image/png' }],
      isError: false,
    };
    expect(applyAutoFile('chrome_screenshot', plan, original)).toBe(original);
  });
});

describe('parseResultPayload', () => {
  test('reads plain JSON and the summary-prefixed form, and gives up quietly', () => {
    expect(parseResultPayload('{"a":1}')).toEqual({ a: 1 });
    expect(parseResultPayload('Renamed recipe\n{"a":1}')).toEqual({ a: 1 });
    expect(parseResultPayload('[1,2]')).toEqual([1, 2]);
    expect(parseResultPayload('not json at all')).toBeUndefined();
  });
});

describe('withOutFileToolSchemas', () => {
  const tools: Tool[] = [
    {
      name: 'workato_job_trace',
      description: 'trace',
      inputSchema: { type: 'object', properties: { recipe_id: { type: 'number' } } },
    },
    {
      name: 'chrome_screenshot',
      description: 'shot',
      inputSchema: {
        type: 'object',
        properties: { out_file: { type: 'string', description: 'declared by the tool' } },
      },
    },
    {
      name: 'workato_rename_recipe',
      description: 'rename',
      inputSchema: { type: 'object', properties: { recipe_id: { type: 'number' } } },
    },
  ];

  test('adds the file params to read tools only', () => {
    const served = withOutFileToolSchemas(tools);
    const trace = served[0].inputSchema.properties as Record<string, any>;
    const rename = served[2].inputSchema.properties as Record<string, any>;

    expect(trace.out_file).toMatchObject({ type: 'string' });
    expect(trace.auto_file).toMatchObject({ type: 'boolean' });
    expect(trace.auto_file_threshold_chars).toMatchObject({ type: 'number' });
    expect(trace.recipe_id).toMatchObject({ type: 'number' });
    expect(rename.out_file).toBeUndefined();
  });

  test('never overwrites a property the tool declares itself', () => {
    const served = withOutFileToolSchemas(tools);
    const shot = served[1].inputSchema.properties as Record<string, any>;
    expect(shot.out_file.description).toBe('declared by the tool');
    expect(shot.auto_file).toMatchObject({ type: 'boolean' });
  });

  test('leaves the source schemas unmutated', () => {
    withOutFileToolSchemas(tools);
    expect((tools[0].inputSchema.properties as Record<string, any>).out_file).toBeUndefined();
  });
});
