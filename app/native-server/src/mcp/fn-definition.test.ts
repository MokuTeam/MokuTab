import { describe, expect, test } from '@jest/globals';
import {
  checkParams,
  findSecretLiterals,
  renderTemplate,
  renderValue,
  validateDefinition,
  validateHelper,
  type FnDefinition,
} from './fn-definition';

function sendDef(overrides: Partial<FnDefinition> = {}): FnDefinition {
  return {
    name: 'acme.case.send_email',
    description: 'Send a case email',
    kind: 'send',
    params: {
      type: 'object',
      properties: {
        case_id: { type: 'integer' },
        subject: { type: 'string' },
        code: { type: 'string' },
      },
      required: ['case_id'],
    },
    target: { url: 'https://acme.example.com/case?id={case_id}', host: 'acme.example.com' },
    steps: [
      { id: 'ready', type: 'wait_for', until: "document.readyState === 'complete'" },
      { id: 'fill', type: 'js', code: 'return { subject: args.subject };' },
      { id: 'check', type: 'verify', code: 'return prev.fill.subject !== "";' },
      {
        id: 'submit',
        type: 'js',
        commit: true,
        code: 'document.querySelector("#go").click(); return true;',
      },
    ],
    preview: 'fill',
    dedupe_key: '{case_id}|{subject}',
    verify_hint: 'SELECT id FROM message WHERE activity = {case_id}',
    ...overrides,
  };
}

describe('validateDefinition', () => {
  test('a well-formed send passes', () => {
    expect(validateDefinition(sendDef())).toEqual([]);
  });

  test('reports every problem at once, each naming its field', () => {
    const errors = validateDefinition({
      ...sendDef(),
      name: 'Bad Name',
      kind: 'read',
      steps: [
        { id: 'a', type: 'js', code: 'return (' },
        { id: 'a', type: 'tool', tool: 'chrome_close_tabs', args: { tabId: 1 } },
        { id: 'b', type: 'navigate', url: 'https://x/{nope}' },
        { id: 'c', type: 'js', commit: true, code: 'return 1' },
      ],
    } as any);
    const text = errors.join('\n');
    expect(text).toMatch(/^name:/m);
    expect(text).toMatch(/steps\[0\] \(a\)\.code:/);
    expect(text).toMatch(/steps\[1\] \(a\)\.id: duplicate/);
    expect(text).toMatch(/steps\[1\] \(a\)\.tool: one of/);
    expect(text).toMatch(/tabId, lease and profile are set by the runner/);
    expect(text).toMatch(/\{nope\} is not a param/);
    expect(text).toMatch(/kind read: no step may commit/);
  });

  test('a write or send must mark its commit step', () => {
    const def = sendDef({
      steps: [{ id: 'fill', type: 'js', code: 'return 1' }],
      preview: undefined,
    });
    expect(validateDefinition(def).join('\n')).toMatch(/mark the step that changes data/);
  });

  test('prev references must point at earlier steps; the dedupe key may use params only', () => {
    const errors = validateDefinition(
      sendDef({
        steps: [
          { id: 'go', type: 'navigate', url: 'https://x/{prev.later.id}' },
          { id: 'later', type: 'js', commit: true, code: 'return 1' },
        ],
        preview: undefined,
        dedupe_key: '{prev.go.url}',
      }),
    ).join('\n');
    expect(errors).toMatch(
      /steps\[0\] \(go\)\.url: \{prev\.later\.id\} does not name an earlier step/,
    );
    expect(errors).toMatch(/dedupe_key: \{prev\.go\.url\} does not name an earlier step/);
  });

  test('a pause may only ask for optional params', () => {
    const def = sendDef({
      steps: [
        { id: 'wait', type: 'pause', needs: ['case_id', 'missing'] },
        { id: 'go', type: 'js', commit: true, code: 'return 1' },
      ],
      preview: undefined,
    });
    const errors = validateDefinition(def).join('\n');
    expect(errors).toMatch(/"case_id" is required up front/);
    expect(errors).toMatch(/"missing" is not a param/);
  });

  test('refuses embedded credentials', () => {
    const def = sendDef({
      steps: [
        { id: 'fill', type: 'js', code: 'const password = "hunter2hunter2"; return 1;' },
        { id: 'go', type: 'js', commit: true, code: 'return 1' },
      ],
    });
    expect(validateDefinition(def).join('\n')).toMatch(
      /a credential literal: definitions must not embed credentials/,
    );
  });

  test('a helper needs a name, description and code that compiles', () => {
    expect(validateHelper({ name: '_helpers.dom', description: 'DOM', code: 'h.x = 1;' })).toEqual(
      [],
    );
    expect(validateHelper({ name: 'dom', description: '', code: 'h.x = (' }).length).toBe(3);
    // Helpers run in a plain function: top-level await would break every step that loads them.
    const awaited = validateHelper({
      name: '_helpers.dom',
      description: 'DOM',
      code: 'h.v = await Promise.resolve(1);',
    });
    expect(awaited.join()).toMatch(/runs synchronously/);
  });

  test('function names cannot leave the registry or hit reserved Windows names', () => {
    expect(validateDefinition({ ...sendDef(), name: 'acme.con' }).join()).toMatch(/^name:/);
    expect(validateDefinition({ ...sendDef(), name: 'a./../x' }).join()).toMatch(/^name:/);
  });
});

describe('findSecretLiterals', () => {
  test('flags tokens but not code that merely names them', () => {
    expect(findSecretLiterals('const token = getToken(); headers.Authorization = auth;')).toEqual(
      [],
    );
    expect(findSecretLiterals({ a: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' })).toEqual([
      'a: a bearer token',
    ]);
  });

  test('a fixed protocol word under a token-named key is not a secret', () => {
    expect(findSecretLiterals("headers: { 'X-Atlassian-Token': 'no-check' }")).toEqual([]);
    expect(findSecretLiterals("const apiKey = 'a1b2c3d4e5';")).toEqual([
      'value: a credential literal',
    ]);
  });
});

describe('checkParams', () => {
  const schema = sendDef().params;

  test('fills defaults and rejects unknown or mistyped params', () => {
    expect(checkParams(schema, { case_id: 7 })).toEqual({
      ok: true,
      value: { case_id: 7 },
      errors: [],
    });
    const bad = checkParams(schema, { case_id: 1.5, subjct: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual(['case_id: expected integer, got 1.5', 'subjct: unknown parameter']);
    expect(checkParams(schema, {}).errors).toEqual(['case_id: required']);
  });

  test('params a pause asks for may be missing at the start', () => {
    const later = new Set(['case_id']);
    expect(checkParams(schema, {}, later).ok).toBe(true);
  });

  test('defaults, enums and nested items', () => {
    const check = checkParams(
      {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      { lines: ['x', 2] },
    );
    expect(check.value.mode).toBe('a');
    expect(check.errors).toEqual(['lines[1]: expected string, got 2']);
  });
});

describe('templates', () => {
  const scope = {
    args: { id: 'a b', acct: '7654321_SB1', n: 2 },
    prev: { open: { url: 'https://x' } },
  };

  test('URL-encodes by default in URLs, with filters and literal braces', () => {
    expect(renderTemplate('https://h/?id={id}&n={n}', scope, true)).toBe('https://h/?id=a%20b&n=2');
    expect(renderTemplate('{acct|ns_host}.app.netsuite.com', scope, false)).toBe(
      '7654321-sb1.app.netsuite.com',
    );
    expect(renderTemplate('{{literal}} {prev.open.url|raw}', scope, true)).toBe(
      '{literal} https://x',
    );
  });

  test('in a URL every filtered value is still encoded; ns_host takes account ids only', () => {
    const evil = { args: { q: 'A&b=c#x', acct: 'Evil.com/x#' }, prev: {} };
    expect(renderTemplate('https://h/?q={q|lower}', evil, true)).toBe('https://h/?q=a%26b%3Dc%23x');
    expect(() => renderTemplate('https://{acct|ns_host}.app.netsuite.com/', evil, true)).toThrow(
      /not an account id/,
    );
    expect(renderTemplate('https://h/?q={q|raw}', evil, true)).toBe('https://h/?q=A&b=c#x');
  });

  test('a missing value is an error, not an empty string', () => {
    expect(() => renderTemplate('https://h/?id={missing}', scope, true)).toThrow(
      'template value {missing} is missing',
    );
  });

  test('a lone placeholder keeps its type in tool args', () => {
    expect(renderValue({ value: '{n}', text: 'n={n}', list: ['{id}'] }, scope)).toEqual({
      value: 2,
      text: 'n=2',
      list: ['a b'],
    });
  });
});

describe('bridge tool steps', () => {
  const base = (steps: any[]): FnDefinition => ({
    name: 'acme.login.store',
    description: 'x',
    kind: 'read',
    params: { type: 'object', properties: { account: { type: 'string' } } },
    target: { url: 'https://acme.example.com/' },
    steps,
  });

  test('a NetSuite session tool, optional, and a step field in when are accepted', () => {
    expect(
      validateDefinition(
        base([
          {
            id: 'store',
            type: 'tool',
            tool: 'netsuite_session_ensure',
            args: { account: '{account}' },
            optional: true,
          },
          {
            id: 'done',
            type: 'finish',
            when: { step: 'store.state', equals: 'imported' },
            value: 'ok',
          },
        ]),
      ),
    ).toEqual([]);
  });

  test('other tools, a non-boolean optional and an unknown step head are refused', () => {
    const errors = validateDefinition(
      base([
        { id: 'a', type: 'tool', tool: 'netsuite_session_status', optional: 'yes' },
        { id: 'b', type: 'finish', when: { step: 'nope.state', equals: 1 }, value: 'x' },
      ]),
    );
    expect(errors.join('\n')).toMatch(/steps\[0\] \(a\)\.tool: one of .*netsuite_session_ensure/);
    expect(errors.join('\n')).toMatch(/optional: true or false/);
    expect(errors.join('\n')).toMatch(/"nope\.state" is not an earlier step/);
  });
});
