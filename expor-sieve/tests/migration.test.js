// Tests for v1 → v2 migration logic in background.js
//
// background.js имеет top-level вызовы browser.menus.create / addListener,
// поэтому перед import'ом мы заглушаем глобальный `browser`.
// Затем мокаем lib/proxy_client.js (через vi.mock) и lib/config_loader.js,
// чтобы listRulesAndContext / writeCombined ходили в наш виртуальный
// mailcow-стейт.

import { beforeEach, describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Глобальные API Thunderbird
// ---------------------------------------------------------------------------

const noopListener = { addListener: vi.fn() };

vi.stubGlobal('browser', {
  storage: { onChanged: noopListener, local: {}, managed: {} },
  action: { onClicked: noopListener },
  windows: { onRemoved: noopListener, create: vi.fn(), update: vi.fn() },
  menus: { create: vi.fn(), onClicked: noopListener },
  runtime: { onMessage: noopListener },
  i18n: { getMessage: () => '' },
  accounts: {
    list: async () => [],
    get: async () => null,
    onDeleted: noopListener,
  },
  mailTabs: { query: async () => [] },
  folders: { query: async () => [] },
  messages: { get: async () => ({}), getFull: async () => ({}) },
});

// ---------------------------------------------------------------------------
// 2. Виртуальный mailcow state + мок ProxyClient
// ---------------------------------------------------------------------------

let __filterState = [];     // [{id, active, script_desc, script_data, filter_type}]
let __nextId = 100;
let __addCount = 0;
let __editCount = 0;
let __deleteCount = 0;

vi.mock('../lib/proxy_client.js', () => {
  return {
    ProxyClient: class {
      constructor() {}
      async checkAuth() { return { ok: true, user: 'u@x.ru' }; }
      async listFilters(/* username */) {
        // Возвращаем deep-copy, чтобы сторонние мутации не влияли.
        return JSON.parse(JSON.stringify(__filterState));
      }
      async addFilter(payload) {
        __addCount++;
        const id = __nextId++;
        __filterState.push({
          id,
          active: payload.active,
          script_desc: payload.script_desc,
          script_data: payload.script_data,
          filter_type: payload.filter_type || 'prefilter',
          username: payload.username,
        });
        return { type: 'success', msg: 'added' };
      }
      async editFilter(id, attr) {
        __editCount++;
        const f = __filterState.find((x) => Number(x.id) === Number(id));
        if (!f) throw new Error(`mock: edit unknown id=${id}`);
        Object.assign(f, attr);
        return { type: 'success' };
      }
      async deleteFilter(id) {
        __deleteCount++;
        const before = __filterState.length;
        __filterState = __filterState.filter((x) => Number(x.id) !== Number(id));
        if (__filterState.length === before) {
          throw new Error(`mock: delete unknown id=${id}`);
        }
        return { type: 'success' };
      }
    },
  };
});

vi.mock('../lib/config_loader.js', () => ({
  loadConfig: async () => ({
    accountId: 'acc-1', baseUrl: 'https://x/sieve-proxy',
    mailbox: 'u@x.ru', password: 'p', source: 'manual',
  }),
  loadConfigFor: async (_accountId) => ({
    accountId: _accountId || 'acc-1',
    baseUrl: 'https://x/sieve-proxy',
    mailbox: 'u@x.ru',
    password: 'p',
    source: 'manual',
  }),
  loadAllConfig: async () => ({
    schema_version: 2,
    accounts: { 'acc-1': { password: 'p' } },
    selectedAccountId: 'acc-1',
    baseUrl_global: 'https://x/sieve-proxy',
    managedBaseUrl: '',
    migrationFailed: null,
  }),
  saveAccountConfig: async () => {},
  setSelectedAccountId: async () => {},
  getSelectedAccountId: async () => 'acc-1',
  setBaseUrlGlobal: async () => {},
  deleteAccountConfig: async () => {},
  saveManualConfig: async () => {},
  savePassword: async () => {},
  savePartialConfig: async () => {},
}));

// ---------------------------------------------------------------------------
// 3. Импорт после моков
// ---------------------------------------------------------------------------

const adapter = await import('../lib/sieve_adapter.js');
const { listRulesAndContext } = await import('../background.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function v1Filter(id, name, active, sieveText) {
  return {
    id,
    active,
    script_desc: name,
    script_data: sieveText,
    filter_type: 'prefilter',
    username: 'u@x.ru',
  };
}

function v2Filter(id, sieveText, active = '1') {
  return {
    id,
    active,
    script_desc: 'EXPOR sieve filters',
    script_data: sieveText,
    filter_type: 'prefilter',
    username: 'u@x.ru',
  };
}

function reset() {
  __filterState = [];
  __nextId = 100;
  __addCount = 0;
  __editCount = 0;
  __deleteCount = 0;
}

// Сериализуем простое v1-правило для фикстур.
function v1Sieve({ from, folder, order }) {
  return adapter.ruleToSieve({
    matchAll: true,
    conditions: [{ field: 'from', op: 'contains', value: from }],
    actions: [{ type: 'fileinto', folder }],
    stopAfter: true,
    order,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v1 → v2 migration', () => {
  beforeEach(reset);

  it('3 v1-фильтра → один v2 + удаление трёх v1', async () => {
    __filterState = [
      v1Filter(2, 'FESCO', '1', v1Sieve({ from: 'gmail.com', folder: 'INBOX/FESCO', order: 0 })),
      v1Filter(5, 'eagleway-domain', '0',
        v1Sieve({ from: '@eagleway-logistic.group', folder: 'EW', order: 1 })),
      v1Filter(7, 'nvrsk', '0', v1Sieve({ from: '@nvrsk.ru', folder: 'NV', order: 2 })),
    ];

    const ctx = await listRulesAndContext('acc-1');

    expect(ctx.rules).toHaveLength(3);
    expect(ctx.combinedFilterId).toBeGreaterThan(0);

    // На сервере остался ровно 1 v2-фильтр.
    expect(__filterState).toHaveLength(1);
    expect(adapter.detectVersion(__filterState[0].script_data)).toBe('v2');
    expect(__addCount).toBe(1);
    expect(__deleteCount).toBe(3);

    // Имена сохранились.
    const names = ctx.rules.map((r) => r.name).sort();
    expect(names).toEqual(['FESCO', 'eagleway-domain', 'nvrsk']);

    // active сохранился.
    const fesco = ctx.rules.find((r) => r.name === 'FESCO');
    expect(fesco.active).toBe(true);
    const ew = ctx.rules.find((r) => r.name === 'eagleway-domain');
    expect(ew.active).toBe(false);

    // mailcowId на UI = rule.id (UUID), а не numeric.
    for (const r of ctx.rules) {
      expect(r.mailcowId).toBe(r.id);
      expect(typeof r.id).toBe('string');
    }
  });

  it('1 v1-фильтр → один v2 + удаление одного v1', async () => {
    __filterState = [
      v1Filter(42, 'only-rule', '1', v1Sieve({ from: '@x.ru', folder: 'X', order: 0 })),
    ];
    const ctx = await listRulesAndContext('acc-1');
    expect(ctx.rules).toHaveLength(1);
    expect(ctx.rules[0].name).toBe('only-rule');
    expect(__filterState).toHaveLength(1);
    expect(adapter.detectVersion(__filterState[0].script_data)).toBe('v2');
    expect(__deleteCount).toBe(1);
  });

  it('0 v1, 1 v2 → миграция не выполняется, правила парсятся из v2', async () => {
    const rules = [
      {
        id: 'r-1', name: 'rule-1', active: true, matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: '@x' }],
        actions: [{ type: 'fileinto', folder: 'X' }],
        stopAfter: true, order: 0,
      },
      {
        id: 'r-2', name: 'rule-2', active: false, matchAll: true,
        conditions: [{ field: 'subject', op: 'contains', value: 'spam' }],
        actions: [{ type: 'discard' }],
        stopAfter: true, order: 1,
      },
    ];
    __filterState = [v2Filter(50, adapter.rulesToCombinedSieve(rules))];

    const ctx = await listRulesAndContext('acc-1');
    expect(ctx.rules).toHaveLength(2);
    expect(ctx.combinedFilterId).toBe(50);
    // Никакой add/delete — мы НЕ мигрировали.
    expect(__addCount).toBe(0);
    expect(__deleteCount).toBe(0);

    // Парс-семантика — поля совпадают.
    expect(ctx.rules.map((r) => r.name)).toEqual(['rule-1', 'rule-2']);
    expect(ctx.rules[1].active).toBe(false);
  });

  it('1 v2 + 2 v1 (broken state) → завершить миграцию, удалить v1, не дублировать', async () => {
    // Уже мигрированный v2 (1 правило в нём)
    const v2Rules = [
      {
        id: 'mig-1', name: 'already-migrated', active: true, matchAll: true,
        conditions: [{ field: 'from', op: 'contains', value: '@old.ru' }],
        actions: [{ type: 'fileinto', folder: 'Old' }],
        stopAfter: true, order: 0,
      },
    ];
    __filterState = [
      v2Filter(60, adapter.rulesToCombinedSieve(v2Rules)),
      // v1 с тем же name — дубль миграции, не должен попасть второй раз.
      v1Filter(2, 'already-migrated', '1', v1Sieve({ from: '@old.ru', folder: 'Old', order: 0 })),
      // v1 с уникальным name — должен добавиться.
      v1Filter(3, 'new-from-v1', '0', v1Sieve({ from: '@new.ru', folder: 'New', order: 1 })),
    ];

    const ctx = await listRulesAndContext('acc-1');

    // На сервере 1 v2, без v1.
    expect(__filterState).toHaveLength(1);
    expect(adapter.detectVersion(__filterState[0].script_data)).toBe('v2');
    expect(Number(__filterState[0].id)).toBe(60);

    // 2 правила: original + новый.
    expect(ctx.rules).toHaveLength(2);
    const names = ctx.rules.map((r) => r.name).sort();
    expect(names).toEqual(['already-migrated', 'new-from-v1']);

    // edit (не add) на существующий v2.
    expect(__addCount).toBe(0);
    expect(__editCount).toBe(1);
    expect(__deleteCount).toBe(2);
  });

  it('чужой filter без маркера → игнорируется (не мигрируется и не удаляется)', async () => {
    const foreignSieve = '# user-defined Sieve\nrequire ["fileinto"];\nfileinto "Foreign";\n';
    __filterState = [
      v1Filter(2, 'мой', '1', v1Sieve({ from: '@my.ru', folder: 'My', order: 0 })),
      {
        id: 99,
        active: '1',
        script_desc: 'foreign rule',
        script_data: foreignSieve,
        filter_type: 'prefilter',
        username: 'u@x.ru',
      },
    ];

    const ctx = await listRulesAndContext('acc-1');
    // Чужой остался; v1 удалён; v2 создан.
    expect(__filterState.find((f) => Number(f.id) === 99)).toBeTruthy();
    expect(__filterState.filter((f) => adapter.detectVersion(f.script_data) === 'v2'))
      .toHaveLength(1);
    expect(__filterState.find((f) => adapter.detectVersion(f.script_data) === 'v1'))
      .toBeUndefined();

    // У нас одно правило (чужой не парсится в наш Rule).
    expect(ctx.rules).toHaveLength(1);
    expect(ctx.rules[0].name).toBe('мой');
  });

  it('пустое состояние → пустой массив правил, без миграции', async () => {
    __filterState = [];
    const ctx = await listRulesAndContext('acc-1');
    expect(ctx.rules).toEqual([]);
    expect(ctx.combinedFilterId).toBeNull();
    expect(__addCount).toBe(0);
    expect(__deleteCount).toBe(0);
  });
});
