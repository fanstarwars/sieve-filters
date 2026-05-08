// Tests for lib/config_loader.js — multi-account v3 storage.
//
// v0.15.0+: пароль НЕ хранится в storage.local. password в EffectiveConfig
// — это live read из Experiment API (browser.exporSieveCredentials.getImapPassword).
// Поэтому source=manual/managed возможен только когда Experiment API задеплоен
// и в нём есть пароль.

import { beforeEach, describe, it, expect, vi } from 'vitest';

// ───────── Storage mock ─────────────────────────────────────────────────────
class FakeStorage {
  constructor(initial = {}) { this.data = { ...initial }; }
  async get(keys) {
    if (keys == null) return { ...this.data };
    if (typeof keys === 'string') return { [keys]: this.data[keys] };
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in this.data) out[k] = this.data[k];
      return out;
    }
    // object: defaults
    const out = {};
    for (const [k, v] of Object.entries(keys)) {
      out[k] = (k in this.data) ? this.data[k] : v;
    }
    return out;
  }
  async set(patch) { Object.assign(this.data, patch); }
  async remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) delete this.data[k];
  }
}

let fakeLocal, fakeManaged, fakeAccountsList;

function setupBrowser({ local = {}, managed = {}, accounts = [],
                        experiment = undefined, serverInfo = undefined,
                        deleteFilters = undefined } = {}) {
  fakeLocal = new FakeStorage(local);
  fakeManaged = new FakeStorage(managed);
  fakeAccountsList = accounts;
  const browserStub = {
    storage: {
      local: fakeLocal,
      managed: fakeManaged,
      onChanged: { addListener: vi.fn() },
    },
    accounts: {
      list: async (_includeSubFolders) =>
        JSON.parse(JSON.stringify(fakeAccountsList)),
      get: async (id, _includeSubFolders) =>
        JSON.parse(JSON.stringify(fakeAccountsList.find(a => a.id === id) || null)),
    },
  };
  // experiment===undefined → Experiment-API не задеплоен (старый TB).
  // experiment===null      → API задеплоен, но getImapPassword вернёт null
  //                          (например, в Login Manager пароля нет).
  // experiment===<string>  → API возвращает эту строку.
  // experiment===Function  → используется как реализация getImapPassword.
  // serverInfo: аналогично — undefined → нет namespace вообще; null → есть, но
  //             вернёт null; object → возвращается as-is; function → impl.
  // deleteFilters: undefined → метода нет в namespace (старая Experiment-сборка);
  //                Function → используется как impl deleteLocalFilters; object
  //                → возвращается as-is.
  if (experiment !== undefined || serverInfo !== undefined || deleteFilters !== undefined) {
    browserStub.exporSieveCredentials = {};
    if (experiment !== undefined) {
      let impl;
      if (typeof experiment === 'function') impl = experiment;
      else if (experiment === null)         impl = async () => null;
      else                                  impl = async () => String(experiment);
      browserStub.exporSieveCredentials.getImapPassword = vi.fn(impl);
    }
    if (serverInfo !== undefined) {
      let impl;
      if (typeof serverInfo === 'function') impl = serverInfo;
      else if (serverInfo === null)         impl = async () => null;
      else                                  impl = async () => serverInfo;
      browserStub.exporSieveCredentials.getServerInfo = vi.fn(impl);
    }
    if (deleteFilters !== undefined) {
      let impl;
      if (typeof deleteFilters === 'function') impl = deleteFilters;
      else                                     impl = async () => deleteFilters;
      browserStub.exporSieveCredentials.deleteLocalFilters = vi.fn(impl);
    }
  }
  vi.stubGlobal('browser', browserStub);
}

// Загружаем модуль динамически после setupBrowser.
async function loadModule() {
  // Сбрасываем module cache между тестами.
  vi.resetModules();
  const mod = await import('../lib/config_loader.js');
  mod.__resetMigrationStateForTests();
  return mod;
}

// ───────── Fixtures ─────────────────────────────────────────────────────────
const ACC1 = {
  id: 'account-1',
  name: 'Work',
  type: 'imap',
  identities: [{ email: 'alice@example.com' }],
};
const ACC2 = {
  id: 'account-2',
  name: 'Personal',
  type: 'imap',
  identities: [{ email: 'bob@example.org' }],
};

// ────────────────────────────────────────────────────────────────────────────
describe('migration to v3', () => {
  it('v1 legacy {baseUrl, mailbox, password}: baseUrl override переносится, password ИГНОРИРУЕТСЯ', async () => {
    setupBrowser({
      local: {
        baseUrl: 'https://x/sieve-proxy',
        mailbox: 'alice@example.com',
        password: 'secret',
      },
      accounts: [ACC1, ACC2],
    });
    const m = await loadModule();
    const all = await m.loadAllConfig();
    expect(all.schema_version).toBe(3);
    // password НЕ переносится в storage — будет читаться из TB Login Manager.
    expect(all.accounts['account-1']).toEqual({
      baseUrl: 'https://x/sieve-proxy',
    });
    expect(all.selectedAccountId).toBe('account-1');
    expect(all.baseUrl_global).toBe('https://x/sieve-proxy');
    // legacy keys удалены (включая password!).
    expect(fakeLocal.data.mailbox).toBeUndefined();
    expect(fakeLocal.data.password).toBeUndefined();
    expect(fakeLocal.data.baseUrl).toBeUndefined();
  });

  it('v1 без match по mailbox → не удаляет legacy, ставит migrationFailed', async () => {
    setupBrowser({
      local: {
        baseUrl: 'https://x/sieve-proxy',
        mailbox: 'unknown@nowhere.tld',
        password: 'secret',
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const all = await m.loadAllConfig();
    expect(all.migrationFailed).toEqual({ mailbox: 'unknown@nowhere.tld' });
    // legacy осталось — повторим попытку при следующем запуске.
    expect(fakeLocal.data.mailbox).toBe('unknown@nowhere.tld');
    expect(fakeLocal.data.password).toBe('secret');
  });

  it('v2 → v3: чистит password-поля во всех accounts.<id>', async () => {
    setupBrowser({
      local: {
        schema_version: 2,
        accounts: {
          'account-1': { baseUrl: 'https://x/p', password: 'old-pw-1' },
          'account-2': { password: 'old-pw-2' },
        },
        selectedAccountId: 'account-1',
        baseUrl_global: 'https://g/p',
      },
      accounts: [ACC1, ACC2],
    });
    const m = await loadModule();
    const all = await m.loadAllConfig();
    expect(all.schema_version).toBe(3);
    expect(all.accounts['account-1']).toEqual({ baseUrl: 'https://x/p' });
    expect(all.accounts['account-2']).toEqual({});
    // password-полей в storage больше нет.
    expect(fakeLocal.data.accounts['account-1'].password).toBeUndefined();
    expect(fakeLocal.data.accounts['account-2'].password).toBeUndefined();
  });

  it('schema_version === 3 → миграция не запускается', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://x/p' } },
        selectedAccountId: 'account-1',
        baseUrl_global: 'https://x/sieve-proxy',
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const all = await m.loadAllConfig();
    expect(all.accounts['account-1']).toEqual({ baseUrl: 'https://x/p' });
    expect(all.selectedAccountId).toBe('account-1');
  });

  it('идемпотентна: повторный вызов loadAllConfig не ломает state', async () => {
    setupBrowser({
      local: {
        baseUrl: 'https://x/sieve-proxy',
        mailbox: 'alice@example.com',
        password: 'secret',
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const a1 = await m.loadAllConfig();
    const a2 = await m.loadAllConfig();
    expect(a1).toEqual(a2);
    expect(fakeLocal.data.accounts['account-1']).toEqual({
      baseUrl: 'https://x/sieve-proxy',
    });
  });

  it('пустой storage → schema_version = 3, accounts пустой', async () => {
    setupBrowser({ accounts: [ACC1] });
    const m = await loadModule();
    const all = await m.loadAllConfig();
    expect(all.schema_version).toBe(3);
    expect(all.accounts).toEqual({});
    expect(all.selectedAccountId).toBeNull();
  });

  it('v1 legacy с managed.baseUrl → baseUrl_global = managed.baseUrl', async () => {
    setupBrowser({
      managed: { baseUrl: 'https://policy.example/sieve-proxy' },
      local: {
        baseUrl: 'https://legacy/sieve-proxy',
        mailbox: 'alice@example.com',
        password: 'p',
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const all = await m.loadAllConfig();
    expect(all.baseUrl_global).toBe('https://policy.example/sieve-proxy');
    expect(all.managedBaseUrl).toBe('https://policy.example/sieve-proxy');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('loadConfigFor', () => {
  it('source=managed: managed.baseUrl + password из TB Login Manager', async () => {
    setupBrowser({
      managed: { baseUrl: 'https://m/sieve-proxy' },
      local: {
        schema_version: 3,
        accounts: { 'account-1': {} },
      },
      accounts: [ACC1],
      experiment: 'pw',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c).toMatchObject({
      accountId: 'account-1',
      baseUrl: 'https://m/sieve-proxy',
      mailbox: 'alice@example.com',
      password: 'pw',
      source: 'managed',
    });
  });

  it('source=manual: per-account override baseUrl + password из TB Login Manager', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://override/p' } },
      },
      accounts: [ACC1],
      experiment: 'pw',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.source).toBe('manual');
    expect(c.baseUrl).toBe('https://override/p');
  });

  it('source=manual: baseUrl_global без managed', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': {} },
        baseUrl_global: 'https://global/p',
      },
      accounts: [ACC1],
      experiment: 'pw',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.source).toBe('manual');
    expect(c.baseUrl).toBe('https://global/p');
  });

  it('source=partial: baseUrl есть, TB Login Manager пароль не дал', async () => {
    setupBrowser({
      managed: { baseUrl: 'https://m/p' },
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
      experiment: null,  // API доступен, но пароля нет
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.source).toBe('partial');
    expect(c.password).toBe('');
  });

  it('source=partial: baseUrl есть, Experiment API отсутствует', async () => {
    setupBrowser({
      managed: { baseUrl: 'https://m/p' },
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
      // experiment не передан → API не задеплоен (старый TB).
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.source).toBe('partial');
    expect(c.password).toBe('');
  });

  it('source=none: ничего нет', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.source).toBe('none');
  });

  it('password — это live read из TB Login Manager на каждый вызов', async () => {
    let calls = 0;
    setupBrowser({
      local: { schema_version: 3, accounts: { 'account-1': {} } },
      accounts: [ACC1],
      experiment: async () => { calls++; return `pw-${calls}`; },
    });
    const m = await loadModule();
    const c1 = await m.loadConfigFor('account-1');
    const c2 = await m.loadConfigFor('account-1');
    expect(c1.password).toBe('pw-1');
    expect(c2.password).toBe('pw-2');
    expect(calls).toBe(2);
  });

  it('mailbox derived from accounts.get(id).identities[0].email', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: { 'account-2': {} } },
      accounts: [ACC1, ACC2],
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-2');
    expect(c.mailbox).toBe('bob@example.org');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('saveAccountConfig', () => {
  it('сохраняет baseUrl override; password в storage не пишется', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
    });
    const m = await loadModule();
    // password в патче — игнорируется (защита от регрессий).
    await m.saveAccountConfig('account-1', {
      baseUrl: 'https://x/p', password: 'pw',
    });
    expect(fakeLocal.data.accounts['account-1']).toEqual({
      baseUrl: 'https://x/p',
    });
    expect(fakeLocal.data.accounts['account-1'].password).toBeUndefined();
  });

  it('идемпотентность: повторный save с тем же baseUrl не ломает', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
    });
    const m = await loadModule();
    await m.saveAccountConfig('account-1', { baseUrl: 'https://x/p' });
    await m.saveAccountConfig('account-1', { baseUrl: 'https://x/p' });
    expect(fakeLocal.data.accounts['account-1']).toEqual({ baseUrl: 'https://x/p' });
  });

  it('partial patch: baseUrl undefined не трогает существующий', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://prev' } },
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    await m.saveAccountConfig('account-1', {});  // пустой patch
    expect(fakeLocal.data.accounts['account-1']).toEqual({
      baseUrl: 'https://prev',
    });
  });

  it('пустой baseUrl удаляет override', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://prev' } },
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    await m.saveAccountConfig('account-1', { baseUrl: '' });
    expect(fakeLocal.data.accounts['account-1'].baseUrl).toBeUndefined();
  });

  it('очищает legacy password-поле, если оно почему-то осталось в записи', async () => {
    // Скажем, миграция была на конкретного юзера, потом мы подсунули новый
    // accountId — saveAccountConfig для него должен по-прежнему гарантировать
    // отсутствие password-поля.
    setupBrowser({
      local: {
        schema_version: 3,
        // искусственно: запись с password (теоретически невозможно после
        // migrate, но защищаемся от bugs).
        accounts: { 'account-1': { baseUrl: 'https://x/p', password: 'leak' } },
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    await m.saveAccountConfig('account-1', { baseUrl: 'https://y/p' });
    expect(fakeLocal.data.accounts['account-1']).toEqual({ baseUrl: 'https://y/p' });
    expect(fakeLocal.data.accounts['account-1'].password).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('deleteAccountConfig', () => {
  it('удаляет конфиг + сбрасывает selectedAccountId если он совпадал', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://a' }, 'account-2': { baseUrl: 'https://b' } },
        selectedAccountId: 'account-1',
      },
      accounts: [ACC1, ACC2],
    });
    const m = await loadModule();
    await m.deleteAccountConfig('account-1');
    expect(fakeLocal.data.accounts['account-1']).toBeUndefined();
    expect(fakeLocal.data.accounts['account-2']).toEqual({ baseUrl: 'https://b' });
    expect(fakeLocal.data.selectedAccountId).toBeNull();
  });

  it('idempotent: удаление несуществующего accountId — no-op', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://a' } },
      },
      accounts: [ACC1],
    });
    const m = await loadModule();
    await m.deleteAccountConfig('nonexistent');
    expect(fakeLocal.data.accounts['account-1']).toEqual({ baseUrl: 'https://a' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('selectedAccountId', () => {
  it('set/get round-trip', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: { 'account-1': {} } },
      accounts: [ACC1],
    });
    const m = await loadModule();
    await m.setSelectedAccountId('account-1');
    expect(await m.getSelectedAccountId()).toBe('account-1');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('loadConfig (compat wrapper)', () => {
  it('возвращает конфиг для selectedAccountId', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-2': { baseUrl: 'https://x' } },
        selectedAccountId: 'account-2',
      },
      accounts: [ACC1, ACC2],
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfig();
    expect(c.accountId).toBe('account-2');
    expect(c.mailbox).toBe('bob@example.org');
  });

  it('fallback на первый IMAP-аккаунт если selectedAccountId не задан', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': {} },
        baseUrl_global: 'https://g/p',
      },
      accounts: [ACC1, ACC2],
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfig();
    expect(c.accountId).toBe('account-1');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('tryGetPasswordFromTB (Experiment API bridge)', () => {
  it('возвращает null если Experiment API не задеплоен (старый TB)', async () => {
    setupBrowser({ accounts: [ACC1] });
    const m = await loadModule();
    const r = await m.tryGetPasswordFromTB('account-1');
    expect(r).toBeNull();
  });

  it('возвращает null при пустом accountId без вызова API', async () => {
    let called = 0;
    setupBrowser({
      accounts: [ACC1],
      experiment: async () => { called++; return 'never'; },
    });
    const m = await loadModule();
    const r = await m.tryGetPasswordFromTB('');
    expect(r).toBeNull();
    expect(called).toBe(0);
  });

  it('возвращает пароль из Experiment API когда он есть', async () => {
    setupBrowser({
      accounts: [ACC1],
      experiment: 'tb-stored-password',
    });
    const m = await loadModule();
    const r = await m.tryGetPasswordFromTB('account-1');
    expect(r).toBe('tb-stored-password');
  });

  it('возвращает null если Experiment API вернул null (нет пароля в TB)', async () => {
    setupBrowser({
      accounts: [ACC1],
      experiment: null,
    });
    const m = await loadModule();
    const r = await m.tryGetPasswordFromTB('account-1');
    expect(r).toBeNull();
  });

  it('возвращает null если Experiment API сам бросил исключение', async () => {
    setupBrowser({
      accounts: [ACC1],
      experiment: async () => { throw new Error('XPCOM kaboom'); },
    });
    const m = await loadModule();
    const r = await m.tryGetPasswordFromTB('account-1');
    expect(r).toBeNull();
  });

  it('возвращает null когда Experiment API возвращает пустую строку', async () => {
    setupBrowser({
      accounts: [ACC1],
      experiment: async () => '',
    });
    const m = await loadModule();
    const r = await m.tryGetPasswordFromTB('account-1');
    expect(r).toBeNull();
  });

  it('передаёт accountId в Experiment API ровно как пришёл', async () => {
    const calls = [];
    setupBrowser({
      accounts: [ACC1],
      experiment: async (id) => { calls.push(id); return 'pw'; },
    });
    const m = await loadModule();
    await m.tryGetPasswordFromTB('account-XYZ');
    expect(calls).toEqual(['account-XYZ']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('tryGetServerInfoFromTB (Experiment API bridge)', () => {
  const SERVER = {
    hostname: 'mail.example.com', port: 993, type: 'imap',
    username: 'alice@example.com', hostnameOrIp: 'mail.example.com',
  };

  it('возвращает null если Experiment API не задеплоен', async () => {
    setupBrowser({ accounts: [ACC1] });
    const m = await loadModule();
    const r = await m.tryGetServerInfoFromTB('account-1');
    expect(r).toBeNull();
  });

  it('возвращает null при пустом accountId', async () => {
    setupBrowser({ accounts: [ACC1], serverInfo: SERVER });
    const m = await loadModule();
    const r = await m.tryGetServerInfoFromTB('');
    expect(r).toBeNull();
  });

  it('возвращает структурированный info когда API его отдал', async () => {
    setupBrowser({ accounts: [ACC1], serverInfo: SERVER });
    const m = await loadModule();
    const r = await m.tryGetServerInfoFromTB('account-1');
    expect(r).toEqual(SERVER);
  });

  it('возвращает null если API вернул null', async () => {
    setupBrowser({ accounts: [ACC1], serverInfo: null });
    const m = await loadModule();
    const r = await m.tryGetServerInfoFromTB('account-1');
    expect(r).toBeNull();
  });

  it('возвращает null если API бросил исключение', async () => {
    setupBrowser({
      accounts: [ACC1],
      serverInfo: async () => { throw new Error('XPCOM kaboom'); },
    });
    const m = await loadModule();
    const r = await m.tryGetServerInfoFromTB('account-1');
    expect(r).toBeNull();
  });

  it('возвращает null если hostname пустой (некорректный info)', async () => {
    setupBrowser({
      accounts: [ACC1],
      serverInfo: { hostname: '', port: 993, type: 'imap', username: '', hostnameOrIp: '' },
    });
    const m = await loadModule();
    const r = await m.tryGetServerInfoFromTB('account-1');
    expect(r).toBeNull();
  });

  it('нормализует port → number, type → lowercase', async () => {
    setupBrowser({
      accounts: [ACC1],
      serverInfo: { hostname: 'h.example', port: '143', type: 'IMAP', username: 'u', hostnameOrIp: 'h.example' },
    });
    const m = await loadModule();
    const r = await m.tryGetServerInfoFromTB('account-1');
    expect(r.port).toBe(143);
    expect(r.type).toBe('imap');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('tryDeriveBaseUrlFromTB', () => {
  it('строит URL вида https://${hostname}/sieve-proxy', async () => {
    setupBrowser({
      accounts: [ACC1],
      serverInfo: { hostname: 'mail.example.com', port: 993, type: 'imap', username: 'a', hostnameOrIp: 'mail.example.com' },
    });
    const m = await loadModule();
    const url = await m.tryDeriveBaseUrlFromTB('account-1');
    expect(url).toBe('https://mail.example.com/sieve-proxy');
  });

  it('возвращает null если info недоступен', async () => {
    setupBrowser({ accounts: [ACC1] });
    const m = await loadModule();
    const url = await m.tryDeriveBaseUrlFromTB('account-1');
    expect(url).toBeNull();
  });

  it('возвращает null если Experiment отдал null', async () => {
    setupBrowser({ accounts: [ACC1], serverInfo: null });
    const m = await loadModule();
    const url = await m.tryDeriveBaseUrlFromTB('account-1');
    expect(url).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('loadConfigFor with auto-derive (lazy baseUrl)', () => {
  const SERVER = {
    hostname: 'mail.example.com', port: 993, type: 'imap',
    username: 'alice@example.com', hostnameOrIp: 'mail.example.com',
  };

  it('storage пуст, managed нет, есть serverInfo → baseUrl автовыводится', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: { 'account-1': {} } },
      accounts: [ACC1],
      serverInfo: SERVER,
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('https://mail.example.com/sieve-proxy');
    // password есть из Experiment → source = 'manual'
    expect(c.source).toBe('manual');
  });

  it('per-account override побеждает auto-derive', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://custom/x' } },
      },
      accounts: [ACC1],
      serverInfo: SERVER,
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('https://custom/x');
  });

  it('managed побеждает auto-derive', async () => {
    setupBrowser({
      managed: { baseUrl: 'https://policy/x' },
      local: { schema_version: 3, accounts: { 'account-1': {} } },
      accounts: [ACC1],
      serverInfo: SERVER,
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('https://policy/x');
    expect(c.source).toBe('managed');
  });

  it('baseUrl_global побеждает auto-derive', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': {} },
        baseUrl_global: 'https://global/x',
      },
      accounts: [ACC1],
      serverInfo: SERVER,
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('https://global/x');
  });

  it('source=partial когда auto-derive дал URL, но TB Login Manager не отдал пароль', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
      serverInfo: SERVER,
      experiment: null,
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('https://mail.example.com/sieve-proxy');
    expect(c.source).toBe('partial');
  });

  it('source=none если ни storage, ни managed, ни Experiment не дали URL', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('');
    expect(c.source).toBe('none');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('effectiveBaseUrlSource', () => {
  const SERVER = {
    hostname: 'mail.example.com', port: 993, type: 'imap',
    username: 'alice@example.com', hostnameOrIp: 'mail.example.com',
  };

  it('override: per-account baseUrl', async () => {
    setupBrowser({
      local: { schema_version: 3,
        accounts: { 'account-1': { baseUrl: 'https://override/x' } } },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const r = await m.effectiveBaseUrlSource('account-1');
    expect(r).toEqual({ source: 'override', baseUrl: 'https://override/x' });
  });

  it('managed: Enterprise Policy baseUrl', async () => {
    setupBrowser({
      managed: { baseUrl: 'https://policy/x' },
      local: { schema_version: 3, accounts: { 'account-1': {} } },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const r = await m.effectiveBaseUrlSource('account-1');
    expect(r).toEqual({ source: 'managed', baseUrl: 'https://policy/x' });
  });

  it('global: legacy baseUrl_global default', async () => {
    setupBrowser({
      local: { schema_version: 3,
        accounts: { 'account-1': {} },
        baseUrl_global: 'https://global/x' },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const r = await m.effectiveBaseUrlSource('account-1');
    expect(r).toEqual({ source: 'global', baseUrl: 'https://global/x' });
  });

  it('auto: derived from IMAP host via Experiment', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: { 'account-1': {} } },
      accounts: [ACC1],
      serverInfo: SERVER,
    });
    const m = await loadModule();
    const r = await m.effectiveBaseUrlSource('account-1');
    expect(r).toEqual({ source: 'auto', baseUrl: 'https://mail.example.com/sieve-proxy' });
  });

  it('none: ничего не доступно', async () => {
    setupBrowser({
      local: { schema_version: 3, accounts: {} },
      accounts: [ACC1],
    });
    const m = await loadModule();
    const r = await m.effectiveBaseUrlSource('account-1');
    expect(r).toEqual({ source: 'none', baseUrl: '' });
  });

  it('возвращает {source:"none"} для пустого accountId без вызова Experiment', async () => {
    let called = 0;
    setupBrowser({
      accounts: [ACC1],
      serverInfo: async () => { called++; return SERVER; },
    });
    const m = await loadModule();
    const r = await m.effectiveBaseUrlSource('');
    expect(r).toEqual({ source: 'none', baseUrl: '' });
    expect(called).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('migration не ломается с новыми полями (schema_version=3 + serverInfo)', () => {
  it('legacy migrate + serverInfo доступен → сохранённый baseUrl всё равно побеждает auto', async () => {
    setupBrowser({
      local: {
        baseUrl: 'https://legacy/x',
        mailbox: 'alice@example.com',
        password: 'pw',
      },
      accounts: [ACC1],
      serverInfo: { hostname: 'mail.example.com', port: 993, type: 'imap',
                    username: 'a', hostnameOrIp: 'mail.example.com' },
      experiment: 'pw-from-tb',
    });
    const m = await loadModule();
    // Миграция перенесёт baseUrl→accounts[id].baseUrl как override.
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('https://legacy/x');
    expect(c.source).toBe('manual');
    // password из Experiment, не из legacy!
    expect(c.password).toBe('pw-from-tb');
  });

  it('schema_version=3 без override и без managed, но есть Experiment → auto', async () => {
    setupBrowser({
      local: {
        schema_version: 3,
        accounts: { 'account-1': {} },
      },
      accounts: [ACC1],
      serverInfo: { hostname: 'mail.example.com', port: 993, type: 'imap',
                    username: 'a', hostnameOrIp: 'mail.example.com' },
      experiment: 'p',
    });
    const m = await loadModule();
    const c = await m.loadConfigFor('account-1');
    expect(c.baseUrl).toBe('https://mail.example.com/sieve-proxy');
    const src = await m.effectiveBaseUrlSource('account-1');
    expect(src.source).toBe('auto');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// tryDeleteLocalFiltersFromTB — bridge для cmd:'deleteLocalFilters'.
//
// Контракт (см. lib/config_loader.js):
//   - Experiment-API нет совсем → null (UI трактует как "no_experiment").
//   - Пустой accountId → { deleted:0, errors:[{name:null,msg:'…'}] } БЕЗ вызова API.
//   - Пустой names → API всё равно вызывается и должен вернуть { deleted:0, errors:[] }.
//   - Experiment-метод бросил → { deleted:0, errors:[{name:null,msg}] }
//     (бэкенд НЕ должен бросать — но если когда-нибудь начнёт, мы не падаем).
//   - Нормальный ответ → возвращается «как есть» с приведением типов.
// ────────────────────────────────────────────────────────────────────────────
describe('tryDeleteLocalFiltersFromTB (Experiment API bridge)', () => {
  it('возвращает null когда Experiment-API namespace отсутствует (старый TB)', async () => {
    setupBrowser({ accounts: [ACC1] });
    const m = await loadModule();
    const r = await m.tryDeleteLocalFiltersFromTB('account-1', ['Old filter']);
    expect(r).toBeNull();
  });

  it('возвращает null когда namespace есть, но deleteLocalFilters не задеплоен', async () => {
    // experiment-key создаёт namespace, но в нём только getImapPassword —
    // имитирует промежуточные ESR-сборки между 0.11.0 и 0.12.0.
    setupBrowser({ accounts: [ACC1], experiment: 'pw' });
    const m = await loadModule();
    const r = await m.tryDeleteLocalFiltersFromTB('account-1', ['x']);
    expect(r).toBeNull();
  });

  it('возвращает structured-error при пустом accountId без вызова API', async () => {
    let called = 0;
    setupBrowser({
      accounts: [ACC1],
      deleteFilters: async () => { called++; return { deleted: 99, errors: [] }; },
    });
    const m = await loadModule();
    const r = await m.tryDeleteLocalFiltersFromTB('', ['x']);
    expect(r).toEqual({ deleted: 0, errors: [{ name: null, msg: 'accountId required' }] });
    expect(called).toBe(0);
  });

  it('пустой names → передаётся в API, ожидается { deleted:0, errors:[] }', async () => {
    const calls = [];
    setupBrowser({
      accounts: [ACC1],
      deleteFilters: async (id, names) => {
        calls.push({ id, names });
        return { deleted: 0, errors: [] };
      },
    });
    const m = await loadModule();
    const r = await m.tryDeleteLocalFiltersFromTB('account-1', []);
    expect(r).toEqual({ deleted: 0, errors: [] });
    expect(calls).toEqual([{ id: 'account-1', names: [] }]);
  });

  it('пробрасывает успешный ответ с deleted и errors', async () => {
    setupBrowser({
      accounts: [ACC1],
      deleteFilters: async () => ({
        deleted: 3,
        errors: [{ name: 'X', msg: 'busy' }],
      }),
    });
    const m = await loadModule();
    const r = await m.tryDeleteLocalFiltersFromTB('account-1', ['A', 'B', 'C', 'X']);
    expect(r.deleted).toBe(3);
    expect(r.errors).toEqual([{ name: 'X', msg: 'busy' }]);
  });

  it('исключение в Experiment-методе → graceful fallback, не падает', async () => {
    setupBrowser({
      accounts: [ACC1],
      deleteFilters: async () => { throw new Error('XPCOM kaboom'); },
    });
    const m = await loadModule();
    const r = await m.tryDeleteLocalFiltersFromTB('account-1', ['x']);
    expect(r.deleted).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].name).toBeNull();
    expect(r.errors[0].msg).toMatch(/kaboom/);
  });

  it('кривой возврат (не-объект) → defensive { deleted:0, errors:[] }', async () => {
    setupBrowser({
      accounts: [ACC1],
      deleteFilters: async () => null,
    });
    const m = await loadModule();
    const r = await m.tryDeleteLocalFiltersFromTB('account-1', ['x']);
    expect(r).toEqual({ deleted: 0, errors: [] });
  });

  it('передаёт accountId и names в API ровно как пришли', async () => {
    const calls = [];
    setupBrowser({
      accounts: [ACC1],
      deleteFilters: async (id, names) => {
        calls.push({ id, names });
        return { deleted: names.length, errors: [] };
      },
    });
    const m = await loadModule();
    await m.tryDeleteLocalFiltersFromTB('account-XYZ', ['One', 'Two']);
    expect(calls).toEqual([{ id: 'account-XYZ', names: ['One', 'Two'] }]);
  });
});
