// tests/local_filter_mapper.test.js
//
// Юнит-тесты для маппера TBFilter → Rule (см. lib/local_filter_mapper.js).
// Реальное Experiment API (XPCOM nsIMsgFilter) недоступно в node — мы
// тестируем чистую функцию-маппер с уже спроекцированными JSON-структурами.

import { describe, it, expect, vi } from 'vitest';

// rule_model.js использует crypto.randomUUID — стабим один раз для всего теста.
let _uuidCounter = 0;
vi.stubGlobal('crypto', {
  randomUUID: () => `uuid-${++_uuidCounter}`,
});

import {
  mapLocalToRule,
  mapLocalToRules,
} from '../lib/local_filter_mapper.js';

// ── helpers ─────────────────────────────────────────────────────────────────
function tbFilter(opts = {}) {
  return {
    name: opts.name || 'test',
    enabled: opts.enabled !== false,
    matchAll: opts.matchAll !== false,
    searchTerms: opts.searchTerms || [],
    actions: opts.actions || [],
  };
}

function term(attrib, op, value, extra = {}) {
  return { attrib, op, value: String(value), booleanAnd: true, ...extra };
}

function action(type, opts = {}) {
  return { type, ...opts };
}

// ────────────────────────────────────────────────────────────────────────────
// term mapping
// ────────────────────────────────────────────────────────────────────────────

describe('mapLocalToRule — search terms', () => {
  it('Subject Contains → field=subject op=contains', () => {
    const tb = tbFilter({
      name: 'Acme - в папку',
      searchTerms: [term('Subject', 'Contains', 'acme')],
      actions: [action('MoveToFolder', { targetFolderPath: 'INBOX/Acme' })],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.conditions).toEqual([
      { field: 'subject', op: 'contains', value: 'acme' },
    ]);
  });

  it('Subject DoesntContain → not_contains', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'DoesntContain', 'spam')],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.rule.conditions[0]).toMatchObject({ field: 'subject', op: 'not_contains' });
  });

  it('Subject Is → is', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Is', 'precise')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.conditions[0].op).toBe('is');
  });

  it('Subject BeginsWith → starts', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'BeginsWith', '[NEWS]')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.conditions[0].op).toBe('starts');
  });

  it('Subject EndsWith → ends', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'EndsWith', '!!!')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.conditions[0].op).toBe('ends');
  });

  it('Sender (From) Contains → field=from', () => {
    const tb = tbFilter({
      searchTerms: [term('Sender', 'Contains', '@example.com')],
      actions: [action('MoveToFolder', { targetFolderPath: 'INBOX/Mail' })],
    });
    expect(mapLocalToRule(tb).rule.conditions[0]).toEqual({
      field: 'from', op: 'contains', value: '@example.com',
    });
  });

  it('To Contains → field=to', () => {
    const tb = tbFilter({
      searchTerms: [term('To', 'Contains', 'list@x.ru')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.conditions[0].field).toBe('to');
  });

  it('CC Contains → field=cc', () => {
    const tb = tbFilter({
      searchTerms: [term('CC', 'Contains', 'cc@x.ru')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.conditions[0].field).toBe('cc');
  });

  it('ToOrCC Contains → field=to + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('ToOrCC', 'Contains', 'me@x.ru')],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.rule.conditions[0].field).toBe('to');
    expect(r.warnings.some(w => /To or CC/i.test(w))).toBe(true);
  });

  it('OtherHeader Contains → field=header + headerName', () => {
    const tb = tbFilter({
      searchTerms: [term('OtherHeader', 'Contains', 'foo', { headerName: 'X-My-Tag' })],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.rule.conditions[0]).toEqual({
      field: 'header', headerName: 'X-My-Tag', op: 'contains', value: 'foo',
    });
  });

  it('OtherHeader без headerName → skip + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('OtherHeader', 'Contains', 'foo')],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
    expect(r.warnings.some(w => /заголовка не задано/i.test(w))).toBe(true);
  });

  it('Size IsGreaterThan → field=size op=gt unit=KB', () => {
    const tb = tbFilter({
      searchTerms: [term('Size', 'IsGreaterThan', '500')],
      actions: [action('Delete')],
    });
    expect(mapLocalToRule(tb).rule.conditions[0]).toEqual({
      field: 'size', op: 'gt', value: 500, unit: 'KB',
    });
  });

  it('Size IsLessThan → op=lt', () => {
    const tb = tbFilter({
      searchTerms: [term('Size', 'IsLessThan', '10')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.conditions[0].op).toBe('lt');
  });

  it('Size с нечисловым value → skip + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('Size', 'IsGreaterThan', 'big')],
      actions: [action('Delete')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
  });

  it('Body — не поддерживается, skip + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('Body', 'Contains', 'cookie')],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
    expect(r.warnings.some(w => /тело/i.test(w))).toBe(true);
  });

  it('Date / Priority / MsgStatus / Keywords / AnyText — все skip', () => {
    for (const a of ['Date', 'Priority', 'MsgStatus', 'Keywords', 'AnyText']) {
      const tb = tbFilter({
        name: `f-${a}`,
        searchTerms: [term(a, 'Is', '1')],
        actions: [action('MarkRead')],
      });
      const r = mapLocalToRule(tb);
      expect(r.skipped).toBe(true);
    }
  });

  it('Subject Isnt → не поддерживается, skip term', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Isnt', 'x')],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
    expect(r.warnings.some(w => /оператор Isnt/i.test(w))).toBe(true);
  });

  it('Subject Matches (regexp) → не поддерживается, skip term', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Matches', 'foo.*')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).skipped).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// action mapping
// ────────────────────────────────────────────────────────────────────────────

describe('mapLocalToRule — actions', () => {
  it('MoveToFolder → fileinto with targetFolderPath', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MoveToFolder', { targetFolderPath: 'INBOX/Logistics' })],
    });
    expect(mapLocalToRule(tb).rule.actions).toEqual([
      { type: 'fileinto', folder: 'INBOX/Logistics' },
    ]);
  });

  it('MoveToFolder с URI без targetFolderPath — fallback парсит URI', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MoveToFolder', {
        targetFolderUri: 'imap://user%40x.ru@mail.x.ru/INBOX/Logistics',
      })],
    });
    const r = mapLocalToRule(tb);
    expect(r.rule.actions[0]).toEqual({ type: 'fileinto', folder: 'INBOX/Logistics' });
  });

  it('MoveToFolder без папки — skip + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MoveToFolder')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
    expect(r.warnings.some(w => /Переместить/i.test(w))).toBe(true);
  });

  it('CopyToFolder → copy', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('CopyToFolder', { targetFolderPath: 'INBOX/Archive' })],
    });
    expect(mapLocalToRule(tb).rule.actions).toEqual([
      { type: 'copy', folder: 'INBOX/Archive' },
    ]);
  });

  it('MarkRead → mark_read', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.actions).toEqual([{ type: 'mark_read' }]);
  });

  it('MarkFlagged → flag', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MarkFlagged')],
    });
    expect(mapLocalToRule(tb).rule.actions).toEqual([{ type: 'flag' }]);
  });

  it('Delete → discard', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('Delete')],
    });
    expect(mapLocalToRule(tb).rule.actions).toEqual([{ type: 'discard' }]);
  });

  it('Forward со strValue → redirect with address + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('Forward', { strValue: 'me@example.com' })],
    });
    const r = mapLocalToRule(tb);
    expect(r.rule.actions).toEqual([
      { type: 'redirect', address: 'me@example.com' },
    ]);
    expect(r.warnings.some(w => /отправителю/i.test(w))).toBe(true);
  });

  it('Forward без адреса → skip + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('Forward')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
  });

  it('StopExecution → rule.stopAfter=true (не отдельное действие)', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [
        action('MarkRead'),
        action('StopExecution'),
      ],
    });
    const r = mapLocalToRule(tb);
    expect(r.rule.actions).toEqual([{ type: 'mark_read' }]);
    expect(r.rule.stopAfter).toBe(true);
  });

  it('Без StopExecution → stopAfter=false (зеркалит TB)', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.stopAfter).toBe(false);
  });

  it('AddTag со strValue=$labelN → tag action с этим keyword', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('AddTag', { strValue: '$label1' })],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.actions).toEqual([{ type: 'tag', keywords: ['$label1'] }]);
  });

  it('AddTag со strValue без $ — нормализуем к $-keyword', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('AddTag', { strValue: 'work' })],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.actions[0].type).toBe('tag');
    expect(r.rule.actions[0].keywords[0].startsWith('$')).toBe(true);
  });

  it('AddTag без strValue → skip + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('AddTag')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
    expect(r.warnings.some(w => /метку/i.test(w))).toBe(true);
  });

  it('Reply / JunkScore / MarkUnread / ChangePriority — все skip', () => {
    for (const t of ['Reply', 'JunkScore', 'MarkUnread', 'ChangePriority']) {
      const tb = tbFilter({
        name: `f-${t}`,
        searchTerms: [term('Subject', 'Contains', 'a')],
        actions: [action(t)],
      });
      expect(mapLocalToRule(tb).skipped).toBe(true);
    }
  });

  it('KillThread → skip + warning', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('KillThread')],
    });
    expect(mapLocalToRule(tb).skipped).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// rule-level
// ────────────────────────────────────────────────────────────────────────────

describe('mapLocalToRule — rule-level', () => {
  it('matchAll наследуется из tbFilter.matchAll=true', () => {
    const tb = tbFilter({
      matchAll: true,
      searchTerms: [
        term('Subject', 'Contains', 'a'),
        term('Subject', 'Contains', 'b'),
      ],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.matchAll).toBe(true);
  });

  it('matchAll наследуется из tbFilter.matchAll=false', () => {
    const tb = tbFilter({
      matchAll: false,
      searchTerms: [
        term('Subject', 'Contains', 'a'),
        term('Subject', 'Contains', 'b'),
      ],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.matchAll).toBe(false);
  });

  it('name из tbFilter.name', () => {
    const tb = tbFilter({
      name: 'Контрагенты Нестле',
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.name).toBe('Контрагенты Нестле');
  });

  it('active=false наследуется из tbFilter.enabled=false', () => {
    const tb = tbFilter({
      enabled: false,
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('MarkRead')],
    });
    expect(mapLocalToRule(tb).rule.active).toBe(false);
  });

  it('фильтр без поддерживаемых условий → skipped:true', () => {
    const tb = tbFilter({
      name: 'Body filters',
      searchTerms: [term('Body', 'Contains', 'cookie')],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
    expect(r.rule).toBeNull();
  });

  it('фильтр без поддерживаемых действий → skipped:true', () => {
    const tb = tbFilter({
      name: 'Reply only',
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [action('Reply')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(true);
  });

  it('многоусловный allof: все Subject Contains', () => {
    const tb = tbFilter({
      matchAll: true,
      searchTerms: [
        term('Subject', 'Contains', 'one'),
        term('Sender', 'Contains', '@x.ru'),
        term('Subject', 'BeginsWith', '[X]'),
      ],
      actions: [action('MoveToFolder', { targetFolderPath: 'INBOX/X' })],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.conditions).toHaveLength(3);
    expect(r.rule.matchAll).toBe(true);
  });

  it('многоусловный anyof: matchAll=false', () => {
    const tb = tbFilter({
      matchAll: false,
      searchTerms: [
        term('Subject', 'Contains', 'one'),
        term('Subject', 'Contains', 'two'),
      ],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.rule.matchAll).toBe(false);
  });

  it('mixed conditions: один Body skip + один Subject ok → итог=1 condition', () => {
    const tb = tbFilter({
      searchTerms: [
        term('Subject', 'Contains', 'a'),
        term('Body', 'Contains', 'b'),
      ],
      actions: [action('MarkRead')],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.conditions).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('mixed actions: один Reply skip + один MarkRead ok → итог=1 action', () => {
    const tb = tbFilter({
      searchTerms: [term('Subject', 'Contains', 'a')],
      actions: [
        action('Reply'),
        action('MarkRead'),
      ],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.actions).toHaveLength(1);
    expect(r.rule.actions[0].type).toBe('mark_read');
  });

  it('null/undefined input → skipped:true (не throw)', () => {
    expect(mapLocalToRule(null).skipped).toBe(true);
    expect(mapLocalToRule(undefined).skipped).toBe(true);
    expect(mapLocalToRule({}).skipped).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// mapLocalToRules (batch)
// ────────────────────────────────────────────────────────────────────────────

describe('mapLocalToRules — batch', () => {
  it('делит на mapped/skipped, аккумулирует warnings', () => {
    const arr = [
      tbFilter({
        name: 'A',
        searchTerms: [term('Subject', 'Contains', 'a')],
        actions: [action('MoveToFolder', { targetFolderPath: 'INBOX/A' })],
      }),
      tbFilter({
        name: 'B',
        searchTerms: [term('Body', 'Contains', 'b')],
        actions: [action('MarkRead')],
      }),
      tbFilter({
        name: 'C',
        searchTerms: [term('Subject', 'Contains', 'c')],
        actions: [action('MarkRead')],
      }),
    ];
    const r = mapLocalToRules(arr);
    expect(r.mapped).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toHaveProperty('name');
    expect(r.warnings[0]).toHaveProperty('msg');
  });

  it('пустой массив', () => {
    const r = mapLocalToRules([]);
    expect(r.mapped).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('not-array input — пустой результат', () => {
    expect(mapLocalToRules(null).mapped).toEqual([]);
    expect(mapLocalToRules(undefined).mapped).toEqual([]);
  });

  it('сохраняет порядок: mapped[i].name = первое имя совместимого', () => {
    const arr = [
      tbFilter({ name: 'X', searchTerms: [term('Body', 'Contains', '1')], actions: [action('MarkRead')] }),
      tbFilter({ name: 'Y', searchTerms: [term('Subject', 'Contains', '2')], actions: [action('MarkRead')] }),
      tbFilter({ name: 'Z', searchTerms: [term('Subject', 'Contains', '3')], actions: [action('MarkRead')] }),
    ];
    const r = mapLocalToRules(arr);
    expect(r.mapped.map(m => m.name)).toEqual(['Y', 'Z']);
    expect(r.skipped.map(s => s.name)).toEqual(['X']);
  });

  it('фильтр с 0 совместимыми терм-объектов → попадает в skipped', () => {
    const arr = [
      tbFilter({
        name: 'AllBody',
        searchTerms: [term('Body', 'Contains', '1'), term('Body', 'Contains', '2')],
        actions: [action('MarkRead')],
      }),
    ];
    const r = mapLocalToRules(arr);
    expect(r.mapped).toEqual([]);
    expect(r.skipped).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// realistic scenario
// ────────────────────────────────────────────────────────────────────────────

describe('mapLocalToRule — realistic Quick Filter migrations', () => {
  it('«Acme - в папку»: From contains @acme.example → MoveToFolder INBOX/Acme', () => {
    const tb = tbFilter({
      name: 'Acme - в папку',
      enabled: true,
      matchAll: true,
      searchTerms: [term('Sender', 'Contains', '@acme.example')],
      actions: [action('MoveToFolder', {
        targetFolderUri: 'imap://user%40x.ru@mail.x.ru/INBOX/Acme',
        targetFolderPath: 'INBOX/Acme',
      })],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.name).toBe('Acme - в папку');
    expect(r.rule.active).toBe(true);
    expect(r.rule.conditions).toEqual([
      { field: 'from', op: 'contains', value: '@acme.example' },
    ]);
    expect(r.rule.actions).toEqual([
      { type: 'fileinto', folder: 'INBOX/Acme' },
    ]);
  });

  it('«Контрагенты Нестле»: Subject Contains nestle OR From Contains @nestle.com → INBOX/Nestle + MarkRead', () => {
    const tb = tbFilter({
      name: 'Контрагенты Нестле',
      matchAll: false,
      searchTerms: [
        term('Subject', 'Contains', 'nestle'),
        term('Sender', 'Contains', '@nestle.com'),
      ],
      actions: [
        action('MoveToFolder', { targetFolderPath: 'INBOX/Nestle' }),
        action('MarkRead'),
        action('StopExecution'),
      ],
    });
    const r = mapLocalToRule(tb);
    expect(r.skipped).toBe(false);
    expect(r.rule.matchAll).toBe(false);
    expect(r.rule.conditions).toHaveLength(2);
    expect(r.rule.actions).toEqual([
      { type: 'fileinto', folder: 'INBOX/Nestle' },
      { type: 'mark_read' },
    ]);
    expect(r.rule.stopAfter).toBe(true);
  });
});
