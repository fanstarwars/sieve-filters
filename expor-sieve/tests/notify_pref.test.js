// tests/notify_pref.test.js
//
// Юнит-тесты для tryGet/tryS​etServerCheckAllFoldersFromTB — обёрток над
// browser.exporSieveCredentials.{get,set}ServerCheckAllFolders. Сама XPCOM-
// часть (Services.prefs/serverKey) живёт в experiments/credentials/implementation.js
// и в Node не запускается; мокаем browser-namespace и проверяем контракт
// обёртки: shape-defensive parsing, graceful fallback при отсутствии API,
// корректная передача аргументов.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  tryGetServerCheckAllFoldersFromTB,
  trySetServerCheckAllFoldersFromTB,
  tryListCheckNewFoldersFromTB,
  trySetFolderCheckNewFromTB,
} from '../lib/config_loader.js';

function stubBrowser({ get, set, listFolders, setFolder } = {}) {
  const ns = {};
  if (typeof get === 'function') ns.getServerCheckAllFolders = vi.fn(get);
  if (typeof set === 'function') ns.setServerCheckAllFolders = vi.fn(set);
  if (typeof listFolders === 'function') ns.listCheckNewFolders = vi.fn(listFolders);
  if (typeof setFolder === 'function') ns.setFolderCheckNew = vi.fn(setFolder);
  vi.stubGlobal('browser', { exporSieveCredentials: ns });
  return ns;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('tryGetServerCheckAllFoldersFromTB', () => {
  it('returns null when accountId is missing', async () => {
    expect(await tryGetServerCheckAllFoldersFromTB('')).toBeNull();
    expect(await tryGetServerCheckAllFoldersFromTB(null)).toBeNull();
  });

  it('returns null when Experiment API is unavailable', async () => {
    vi.stubGlobal('browser', {});
    expect(await tryGetServerCheckAllFoldersFromTB('a-1')).toBeNull();
  });

  it('returns null when method is missing on namespace', async () => {
    vi.stubGlobal('browser', { exporSieveCredentials: {} });
    expect(await tryGetServerCheckAllFoldersFromTB('a-1')).toBeNull();
  });

  it('forwards accountId and normalises shape on success', async () => {
    const ns = stubBrowser({ get: async () => ({ supported: true, enabled: true }) });
    expect(await tryGetServerCheckAllFoldersFromTB('a-1'))
      .toEqual({ supported: true, enabled: true });
    expect(ns.getServerCheckAllFolders).toHaveBeenCalledWith('a-1');
  });

  it('returns supported:false when experiment says non-IMAP / unknown', async () => {
    stubBrowser({ get: async () => ({ supported: false, enabled: null }) });
    expect(await tryGetServerCheckAllFoldersFromTB('a-1'))
      .toEqual({ supported: false, enabled: null });
  });

  it('coerces non-boolean enabled to null (defensive)', async () => {
    stubBrowser({ get: async () => ({ supported: true, enabled: 'oops' }) });
    expect(await tryGetServerCheckAllFoldersFromTB('a-1'))
      .toEqual({ supported: true, enabled: null });
  });

  it('returns supported:false when experiment returns garbage', async () => {
    stubBrowser({ get: async () => 'not-an-object' });
    expect(await tryGetServerCheckAllFoldersFromTB('a-1'))
      .toEqual({ supported: false, enabled: null });
  });

  it('returns null when experiment throws', async () => {
    stubBrowser({ get: async () => { throw new Error('XPCOM kaboom'); } });
    expect(await tryGetServerCheckAllFoldersFromTB('a-1')).toBeNull();
  });
});

describe('trySetServerCheckAllFoldersFromTB', () => {
  it('returns null when accountId is missing', async () => {
    expect(await trySetServerCheckAllFoldersFromTB('', true)).toBeNull();
  });

  it('returns null when Experiment API is unavailable', async () => {
    vi.stubGlobal('browser', {});
    expect(await trySetServerCheckAllFoldersFromTB('a-1', true)).toBeNull();
  });

  it('coerces enabled to boolean and forwards both args', async () => {
    const ns = stubBrowser({
      set: async (id, en) => ({ supported: true, enabled: en }),
    });
    const r = await trySetServerCheckAllFoldersFromTB('a-1', 1);
    expect(r).toEqual({ supported: true, enabled: true });
    expect(ns.setServerCheckAllFolders).toHaveBeenCalledWith('a-1', true);
  });

  it('echoes false correctly', async () => {
    stubBrowser({
      set: async (_id, en) => ({ supported: true, enabled: en }),
    });
    expect(await trySetServerCheckAllFoldersFromTB('a-1', false))
      .toEqual({ supported: true, enabled: false });
  });

  it('returns null when experiment throws', async () => {
    stubBrowser({ set: async () => { throw new Error('boom'); } });
    expect(await trySetServerCheckAllFoldersFromTB('a-1', true)).toBeNull();
  });
});

describe('tryListCheckNewFoldersFromTB', () => {
  it('returns null when accountId is missing', async () => {
    expect(await tryListCheckNewFoldersFromTB('')).toBeNull();
  });

  it('returns null when Experiment API is unavailable', async () => {
    vi.stubGlobal('browser', {});
    expect(await tryListCheckNewFoldersFromTB('a-1')).toBeNull();
  });

  it('forwards accountId and returns list', async () => {
    const sample = [
      { path: '/INBOX', name: 'INBOX', checkNew: false, specialUse: ['inbox'], isInbox: true, isVirtual: false, isSubscribed: true },
      { path: '/INBOX/Junk', name: 'Junk', checkNew: false, specialUse: ['junk'], isInbox: false, isVirtual: false, isSubscribed: true },
    ];
    const ns = stubBrowser({ listFolders: async () => sample });
    expect(await tryListCheckNewFoldersFromTB('a-1')).toEqual(sample);
    expect(ns.listCheckNewFolders).toHaveBeenCalledWith('a-1');
  });

  it('returns [] when experiment returns non-array', async () => {
    stubBrowser({ listFolders: async () => 'oops' });
    expect(await tryListCheckNewFoldersFromTB('a-1')).toEqual([]);
  });

  it('returns null when experiment throws', async () => {
    stubBrowser({ listFolders: async () => { throw new Error('boom'); } });
    expect(await tryListCheckNewFoldersFromTB('a-1')).toBeNull();
  });
});

describe('trySetFolderCheckNewFromTB', () => {
  it('returns null when accountId or path is missing', async () => {
    expect(await trySetFolderCheckNewFromTB('', '/x', true)).toBeNull();
    expect(await trySetFolderCheckNewFromTB('a', '', true)).toBeNull();
  });

  it('returns null when API unavailable', async () => {
    vi.stubGlobal('browser', {});
    expect(await trySetFolderCheckNewFromTB('a-1', '/INBOX/X', true)).toBeNull();
  });

  it('forwards args and normalises shape', async () => {
    const ns = stubBrowser({
      setFolder: async (id, p, en) => ({ supported: true, enabled: en }),
    });
    const r = await trySetFolderCheckNewFromTB('a-1', '/INBOX/X', 1);
    expect(r).toEqual({ supported: true, enabled: true });
    expect(ns.setFolderCheckNew).toHaveBeenCalledWith('a-1', '/INBOX/X', true);
  });

  it('coerces non-boolean enabled to null (defensive)', async () => {
    stubBrowser({
      setFolder: async () => ({ supported: true, enabled: 'oops' }),
    });
    expect(await trySetFolderCheckNewFromTB('a-1', '/x', false))
      .toEqual({ supported: true, enabled: null });
  });

  it('returns null when experiment throws', async () => {
    stubBrowser({ setFolder: async () => { throw new Error('boom'); } });
    expect(await trySetFolderCheckNewFromTB('a-1', '/x', true)).toBeNull();
  });
});
