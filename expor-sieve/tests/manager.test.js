// Manager LazyAuthPanel test — bootstrap with N>1 accounts where selected
// has no_password → LazyAuthPanel rendered.
//
// Полностью смоделировать DOM-flow manager.js без TB browser невозможно
// (он требует HTMLDialogElement.showModal и runtime.sendMessage). Тут мы
// тестируем ЛОГИКУ через прямой вызов хелпера: проверяем что обработчик
// listRules возвращает no_password для аккаунта без пароля, а listAccounts
// видит этот ящик.
//
// v0.15.0+: пароль читается из TB Login Manager (Experiment API), а не из
// storage. Чтобы сэмулировать «есть пароль» — отдаём строку в getImapPassword;
// чтобы «нет пароля» — отдаём null.

import { describe, it, expect, vi } from 'vitest';

const noopListener = { addListener: vi.fn() };

vi.stubGlobal('browser', {
  storage: {
    onChanged: noopListener,
    local: {
      data: {
        schema_version: 3,
        accounts: {
          // baseUrl override указан для обоих, но реально нужен — будет из global.
        },
        selectedAccountId: 'a-2',
        baseUrl_global: 'https://x/p',
      },
      get(keys) {
        if (keys == null) return Promise.resolve({ ...this.data });
        if (typeof keys === 'string') return Promise.resolve({ [keys]: this.data[keys] });
        if (Array.isArray(keys)) {
          const o = {};
          for (const k of keys) if (k in this.data) o[k] = this.data[k];
          return Promise.resolve(o);
        }
        return Promise.resolve({ ...this.data });
      },
      set(p) { Object.assign(this.data, p); return Promise.resolve(); },
      remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) delete this.data[k];
        return Promise.resolve();
      },
    },
    managed: {
      get: async () => ({}),
    },
  },
  action: { onClicked: noopListener },
  windows: { onRemoved: noopListener, create: vi.fn(), update: vi.fn() },
  menus: { create: vi.fn(), onClicked: noopListener },
  runtime: { onMessage: noopListener },
  i18n: { getMessage: () => '' },
  accounts: {
    list: async () => [
      { id: 'a-1', name: 'Work', type: 'imap', identities: [{ email: 'alice@x.ru' }] },
      { id: 'a-2', name: 'Home', type: 'imap', identities: [{ email: 'bob@y.ru' }] },
    ],
    get: async (id) => ({
      id,
      identities: id === 'a-1'
        ? [{ email: 'alice@x.ru' }]
        : [{ email: 'bob@y.ru' }],
    }),
    onDeleted: noopListener,
  },
  mailTabs: { query: async () => [] },
  folders: { query: async () => [] },
  messages: { get: async () => ({}), getFull: async () => ({}) },
  exporSieveCredentials: {
    // a-1 → пароль есть в TB Login Manager; a-2 → нет.
    getImapPassword: async (id) => (id === 'a-1' ? 'pw' : null),
  },
});

// Mock proxy_client — для a-1 успех, для a-2 (no password) тут не дойдёт.
vi.mock('../lib/proxy_client.js', () => {
  return {
    ProxyClient: class {
      constructor() {}
      async listFilters() { return []; }
      async addFilter() { return { type: 'success' }; }
      async editFilter() { return { type: 'success' }; }
      async deleteFilter() { return { type: 'success' }; }
      async checkAuth() { return { ok: true, user: 'x' }; }
    },
  };
});

const bg = await import('../background.js');

describe('manager bootstrap: N=2 accounts, selected has no password', () => {
  it('getActiveAccountId fallback = selectedAccountId', async () => {
    const id = await bg.getActiveAccountId();
    expect(id).toBe('a-2');
  });

  it('listRulesAndContext для a-2 → no_password ошибка', async () => {
    let caught = null;
    try {
      await bg.listRulesAndContext('a-2');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.kind).toBe('no_password');
    expect(caught.accountId).toBe('a-2');
    expect(caught.mailbox).toBe('bob@y.ru');
  });

  it('listRulesAndContext для a-1 (есть password) → пустой массив правил', async () => {
    const ctx = await bg.listRulesAndContext('a-1');
    expect(ctx.rules).toEqual([]);
    expect(ctx.mailbox).toBe('alice@x.ru');
  });
});
