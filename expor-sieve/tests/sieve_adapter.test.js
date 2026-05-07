// Tests for lib/sieve_adapter.js — ruleToSieve / sieveToRule.
//
// Фикстуры лежат в tests/fixtures/rules.json и сгенерированы предыдущим
// агентом. Если их формат разойдётся с реализацией адаптера — байт-в-байт
// тест упадёт, а round-trip покажет, в адаптере или в фикстурах баг.
// TODO: regenerate fixtures (если ruleToSieve поменяется).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ruleToSieve,
  sieveToRule,
  rulesToCombinedSieve,
  combinedSieveToRules,
  detectVersion,
  RULE_MARKER,
  RULE_MARKER_V1,
  RULE_MARKER_V2,
} from '../lib/sieve_adapter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesPath = resolve(__dirname, 'fixtures/rules.json');
const fixturesRaw = JSON.parse(readFileSync(fixturesPath, 'utf8'));

// Файл фикстур обёрнут в объект { fixtures: [...] } с _comment-ключом.
// На случай альтернативного формата (просто массив) — поддержим оба.
const fixtures = Array.isArray(fixturesRaw)
  ? fixturesRaw
  : fixturesRaw.fixtures || [];

// Для каждой фикстуры извлекаем «объектную часть», которую возвращает
// sieveToRule: { matchAll, conditions, actions, stopAfter, [order] }.
function ruleObjectPart(rule) {
  const out = {
    matchAll: rule.matchAll,
    conditions: rule.conditions,
    actions: rule.actions,
    stopAfter: rule.stopAfter,
  };
  if (Number.isFinite(rule.order)) out.order = rule.order;
  return out;
}

describe('SieveAdapter — фикстуры', () => {
  it('фикстуры реально загружены и их хотя бы 10', () => {
    expect(Array.isArray(fixtures)).toBe(true);
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const f of fixtures) {
      expect(f).toHaveProperty('rule');
      expect(f).toHaveProperty('sieve');
    }
  });

  describe('ruleToSieve(rule) === fixture.sieve (байт-в-байт)', () => {
    for (const f of fixtures) {
      it(`fixture: ${f.name}`, () => {
        const out = ruleToSieve(f.rule);
        expect(out).toBe(f.sieve);
      });
    }
  });

  describe('sieveToRule(fixture.sieve) deep-equal объектной части rule', () => {
    for (const f of fixtures) {
      it(`fixture: ${f.name}`, () => {
        const got = sieveToRule(f.sieve);
        // sieveToRule может вернуть order только если он реально был в # order:
        // строке. Чтобы deep-equal был устойчив, сравниваем только пересечение.
        const expected = ruleObjectPart(f.rule);
        if (got.order === undefined) delete expected.order;
        expect(got).toEqual(expected);
      });
    }
  });

  describe('round-trip: sieveToRule(ruleToSieve(rule)) ≡ объектная часть rule', () => {
    for (const f of fixtures) {
      it(`fixture: ${f.name}`, () => {
        const sieve = ruleToSieve(f.rule);
        const back = sieveToRule(sieve);
        const expected = ruleObjectPart(f.rule);
        expect(back).toEqual(expected);
      });
    }
  });
});

describe('SieveAdapter — order маркер', () => {
  const baseRule = {
    matchAll: true,
    conditions: [{ field: 'from', op: 'contains', value: '@x.ru' }],
    actions: [{ type: 'fileinto', folder: 'X' }],
    stopAfter: false,
  };

  it('rule.order = 5 → вторая строка скрипта = "# order: 5"', () => {
    const sieve = ruleToSieve({ ...baseRule, order: 5 });
    const lines = sieve.split('\n');
    expect(lines[0]).toBe(RULE_MARKER);
    expect(lines[1]).toBe('# order: 5');
  });

  it('sieveToRule парсит "# order: 5" обратно в result.order === 5', () => {
    const sieve = ruleToSieve({ ...baseRule, order: 5 });
    const back = sieveToRule(sieve);
    expect(back.order).toBe(5);
  });

  it('rule без order → НЕТ строки # order:', () => {
    const sieve = ruleToSieve(baseRule);
    expect(sieve.includes('# order:')).toBe(false);
  });

  it('sieveToRule без # order: строки → result.order не определён', () => {
    const sieve = ruleToSieve(baseRule);
    const back = sieveToRule(sieve);
    expect(back.order).toBeUndefined();
  });
});

describe('SieveAdapter — отказ на чужих скриптах', () => {
  it('sieveToRule бросает на скрипте без маркера', () => {
    // Реальный текст ошибки модуля — английский: "marker missing".
    expect(() => sieveToRule('# чужой скрипт\nfileinto "X";')).toThrow(/marker/i);
  });

  it('сообщение об ошибке упоминает marker', () => {
    let err;
    try { sieveToRule('# чужой скрипт\nfileinto "X";'); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.message.toLowerCase()).toMatch(/marker|маркер/);
  });
});

describe('SieveAdapter — stopAfter', () => {
  const rule = {
    matchAll: true,
    conditions: [{ field: 'from', op: 'contains', value: '@x.ru' }],
    actions: [{ type: 'fileinto', folder: 'X' }],
    stopAfter: false,
  };

  it('stopAfter=false → в скрипте НЕТ "stop;"', () => {
    const sieve = ruleToSieve(rule);
    expect(sieve.includes('stop;')).toBe(false);
  });

  it('stopAfter=true → в скрипте ЕСТЬ "stop;"', () => {
    const sieve = ruleToSieve({ ...rule, stopAfter: true });
    expect(sieve.includes('stop;')).toBe(true);
  });
});

describe('SieveAdapter — экранирование значений', () => {
  it('значение со спец-символами " и \\ корректно квотится и парсится обратно', () => {
    const rule = {
      matchAll: true,
      conditions: [
        { field: 'subject', op: 'contains', value: 'путь C:\\foo "bar" \\\\end' },
      ],
      actions: [{ type: 'fileinto', folder: 'Spec' }],
      stopAfter: false,
    };
    const sieve = ruleToSieve(rule);
    const back = sieveToRule(sieve);
    expect(back.conditions).toEqual(rule.conditions);
  });

  it('папка с " и \\ выживает round-trip', () => {
    const rule = {
      matchAll: true,
      conditions: [{ field: 'from', op: 'contains', value: 'a@b' }],
      actions: [{ type: 'fileinto', folder: 'Inbox/"weird"\\folder' }],
      stopAfter: true,
    };
    const sieve = ruleToSieve(rule);
    const back = sieveToRule(sieve);
    expect(back.actions).toEqual(rule.actions);
    expect(back.stopAfter).toBe(true);
  });

  it('contains_any со значениями, содержащими кавычки — round-trip', () => {
    const rule = {
      matchAll: true,
      conditions: [
        { field: 'subject', op: 'contains_any', value: ['a"b', 'c\\d', 'normal'] },
      ],
      actions: [{ type: 'flag' }],
      stopAfter: false,
    };
    const sieve = ruleToSieve(rule);
    const back = sieveToRule(sieve);
    expect(back.conditions).toEqual(rule.conditions);
  });
});

// ---------------------------------------------------------------------------
// v2 combined sieve script
// ---------------------------------------------------------------------------

describe('detectVersion', () => {
  it('возвращает v1 для скрипта с маркером v1', () => {
    expect(detectVersion(`${RULE_MARKER_V1}\nrequire []` )).toBe('v1');
  });
  it('возвращает v2 для скрипта с маркером v2', () => {
    expect(detectVersion(`${RULE_MARKER_V2}\n` )).toBe('v2');
  });
  it('возвращает null для постороннего sieve', () => {
    expect(detectVersion('require ["fileinto"];\nfileinto "X";')).toBe(null);
  });
  it('возвращает null для пустой строки', () => {
    expect(detectVersion('')).toBe(null);
  });
  it('возвращает null для null', () => {
    expect(detectVersion(null)).toBe(null);
  });
  it('игнорирует whitespace вокруг маркера', () => {
    expect(detectVersion(`  ${RULE_MARKER_V2}  \n` )).toBe('v2');
  });
});

describe('rulesToCombinedSieve / combinedSieveToRules — base', () => {
  it('пустой массив → script с маркером v2 без правил', () => {
    const out = rulesToCombinedSieve([]);
    expect(detectVersion(out)).toBe('v2');
    expect(combinedSieveToRules(out)).toEqual([]);
  });

  it('один простой Rule — round-trip deep-equal', () => {
    const rules = [
      {
        id: 'r-1',
        name: 'Силвер',
        active: true,
        matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: '@silver.ru' }],
        actions: [{ type: 'fileinto', folder: 'Силвер' }],
        stopAfter: true,
        order: 0,
      },
    ];
    const out = rulesToCombinedSieve(rules);
    expect(detectVersion(out)).toBe('v2');
    expect(combinedSieveToRules(out)).toEqual(rules);
  });

  it('include кириллицу в имени и папке', () => {
    const rules = [
      {
        id: 'r-cyr',
        name: 'Кириллица — тест',
        active: true,
        matchAll: false,
        conditions: [
          { field: 'from', op: 'contains', value: 'россылка' },
          { field: 'subject', op: 'contains', value: 'отчёт' },
        ],
        actions: [{ type: 'fileinto', folder: 'INBOX/Россылки' }],
        stopAfter: true,
        order: 0,
      },
    ];
    const back = combinedSieveToRules(rulesToCombinedSieve(rules));
    expect(back).toEqual(rules);
  });

  it('5 правил, разный matchAll/stopAfter/active — round-trip', () => {
    const rules = [];
    for (let i = 0; i < 5; i++) {
      rules.push({
        id: `r-${i}`,
        name: `rule-${i}`,
        active: i % 2 === 0,
        matchAll: i % 3 === 0,
        conditions: [
          { field: 'from', op: 'contains', value: `u${i}@x.ru` },
          { field: 'subject', op: 'contains', value: `subj-${i}` },
        ],
        actions: [{ type: 'fileinto', folder: `F${i}` }],
        stopAfter: i % 2 === 1,
        order: i,
      });
    }
    const back = combinedSieveToRules(rulesToCombinedSieve(rules));
    expect(back).toEqual(rules);
  });

  it('30 правил — round-trip без потерь', () => {
    const rules = [];
    for (let i = 0; i < 30; i++) {
      rules.push({
        id: `r-${i}`,
        name: `Rule#${i}`,
        active: true,
        matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: `u${i}@x.ru` }],
        actions: [{ type: 'fileinto', folder: `F${i}` }],
        stopAfter: true,
        order: i,
      });
    }
    const back = combinedSieveToRules(rulesToCombinedSieve(rules));
    expect(back).toEqual(rules);
  });
});

describe('rulesToCombinedSieve — все типы actions', () => {
  it('fileinto, copy, mark_read, flag, redirect, discard, trash', () => {
    const rules = [
      {
        id: 'r-actions',
        name: 'all-actions',
        active: true,
        matchAll: false,
        conditions: [{ field: 'from', op: 'contains', value: '@x.ru' }],
        actions: [
          { type: 'fileinto', folder: 'A' },
          { type: 'copy', folder: 'B' },
          { type: 'mark_read' },
          { type: 'flag' },
          { type: 'redirect', address: 'forwarded@y.ru' },
          { type: 'trash' },
        ],
        stopAfter: false,
        order: 0,
      },
      {
        id: 'r-discard',
        name: 'discard-rule',
        active: true,
        matchAll: true,
        conditions: [{ field: 'subject', op: 'contains', value: 'spam' }],
        actions: [{ type: 'discard' }],
        stopAfter: true,
        order: 1,
      },
    ];
    const out = rulesToCombinedSieve(rules);
    // require должен агрегироваться: fileinto, copy, imap4flags
    expect(out).toMatch(/require\s+\[/);
    expect(out).toContain('fileinto');
    expect(out).toContain('copy');
    expect(out).toContain('imap4flags');
    const back = combinedSieveToRules(out);
    expect(back).toEqual(rules);
  });
});

describe('rulesToCombinedSieve — все типы conditions', () => {
  it('from/to/cc/subject/header/size/attachment — round-trip', () => {
    const rules = [
      {
        id: 'r-all-conds',
        name: 'all-cond-types',
        active: true,
        matchAll: false,
        conditions: [
          { field: 'from', op: 'contains', value: '@from.ru' },
          { field: 'to', op: 'is', value: 'me@x.ru' },
          { field: 'cc', op: 'contains', value: 'cc@y.ru' },
          { field: 'subject', op: 'starts', value: '[ALERT]' },
          { field: 'header', headerName: 'X-Mailer', op: 'contains', value: 'thunderbird' },
          { field: 'size', op: 'gt', value: 5, unit: 'MB' },
          { field: 'attachment', op: 'has_attachment' },
        ],
        actions: [{ type: 'fileinto', folder: 'X' }],
        stopAfter: true,
        order: 0,
      },
    ];
    const back = combinedSieveToRules(rulesToCombinedSieve(rules));
    expect(back).toEqual(rules);
  });
});

describe('rulesToCombinedSieve — inactive (if false wrapper)', () => {
  it('inactive rule оборачивается в if false и парсится обратно как active=false', () => {
    const rules = [
      {
        id: 'r-on',
        name: 'active rule',
        active: true,
        matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: '@on.ru' }],
        actions: [{ type: 'fileinto', folder: 'On' }],
        stopAfter: true,
        order: 0,
      },
      {
        id: 'r-off',
        name: 'inactive rule',
        active: false,
        matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: '@off.ru' }],
        actions: [{ type: 'fileinto', folder: 'Off' }],
        stopAfter: true,
        order: 1,
      },
    ];
    const out = rulesToCombinedSieve(rules);
    expect(out).toMatch(/if\s+false\s*\{/);
    expect(combinedSieveToRules(out)).toEqual(rules);
  });

  it('inactive rule с anyof / 3 условия / multiple actions — round-trip', () => {
    const rules = [
      {
        id: 'r-complex-off',
        name: 'inactive complex',
        active: false,
        matchAll: false,
        conditions: [
          { field: 'from', op: 'contains', value: '@a.ru' },
          { field: 'subject', op: 'is', value: 'Hello' },
          { field: 'size', op: 'gt', value: 1, unit: 'MB' },
        ],
        actions: [
          { field: undefined, type: 'fileinto', folder: 'X' },
          { type: 'flag' },
        ].map(({ field, ...rest }) => rest),
        stopAfter: false,
        order: 0,
      },
    ];
    const back = combinedSieveToRules(rulesToCombinedSieve(rules));
    expect(back).toEqual(rules);
  });
});

describe('rulesToCombinedSieve — require агрегация', () => {
  it('два правила, одно с fileinto, второе с imap4flags → require содержит оба', () => {
    const out = rulesToCombinedSieve([
      {
        id: 'a', name: 'a', active: true, matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: '@a.ru' }],
        actions: [{ type: 'fileinto', folder: 'A' }],
        stopAfter: false, order: 0,
      },
      {
        id: 'b', name: 'b', active: true, matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: '@b.ru' }],
        actions: [{ type: 'flag' }],
        stopAfter: false, order: 1,
      },
    ]);
    const requireMatch = out.match(/require\s+\[([^\]]*)\]/);
    expect(requireMatch).toBeTruthy();
    const list = requireMatch[1];
    expect(list).toContain('fileinto');
    expect(list).toContain('imap4flags');
  });

  it('правила без require-extension actions → ни одного require не пишется', () => {
    const out = rulesToCombinedSieve([
      {
        id: 'd', name: 'd', active: true, matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: 'x' }],
        actions: [{ type: 'discard' }],
        stopAfter: false, order: 0,
      },
    ]);
    expect(out.includes('require')).toBe(false);
  });
});

describe('combinedSieveToRules — отказы', () => {
  it('бросает на скрипте без v2-маркера', () => {
    expect(() => combinedSieveToRules(`${RULE_MARKER_V1}\nrequire []`)).toThrow(/v2|marker/i);
  });
  it('бросает на постороннем тексте', () => {
    expect(() => combinedSieveToRules('hello world')).toThrow(/marker/i);
  });
});

describe('RULE_MARKER backward-compat', () => {
  it('RULE_MARKER === RULE_MARKER_V1', () => {
    expect(RULE_MARKER).toBe(RULE_MARKER_V1);
  });
});

