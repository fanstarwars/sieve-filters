// SPDX-License-Identifier: GPL-3.0-or-later
// Background service worker — единственный модуль, который ходит в middleware.
// UI-страницы (manager/editor/wizard/options) общаются с ним через runtime.sendMessage.
//
// Контракт сообщений (multi-account, v0.5.0):
//
//   { cmd: 'getConfig' }                                      -> EffectiveConfig (для selectedAccountId)
//   { cmd: 'getAccountConfig', accountId }                    -> { baseUrl, mailbox, hasPassword, source }
//   { cmd: 'saveAccountConfig', accountId, baseUrl?, password? } -> { ok: true }
//   { cmd: 'getActiveAccountId' }                             -> string|null
//   { cmd: 'getSelectedAccountId' }                           -> string|null
//   { cmd: 'setSelectedAccountId', accountId }                -> { ok: true }
//   { cmd: 'setBaseUrlGlobal', baseUrl }                      -> { ok: true }
//   { cmd: 'testConnection', accountId? }                     -> { ok: true, user } | { error }
//   { cmd: 'listRules', accountId? }                          -> Rule[] | { error: { kind:'no_password', accountId, mailbox } }
//   { cmd: 'saveRule', accountId?, rule }                     -> Rule (с mailcowId) | { error }
//   { cmd: 'deleteRule', accountId?, mailcowId }              -> { ok: true } | { error }
//   { cmd: 'setRuleActive', accountId?, mailcowId, active }   -> { ok: true } | { error }
//   { cmd: 'previewSieve', rule }                             -> { sieve }
//   { cmd: 'listFolders', accountId? }                        -> { id, name, path }[]
//   { cmd: 'listAccounts' }                                   -> { id, name, email, hasConfig, isDefault }[]
//   { cmd: 'getMessageMeta', id }                             -> { ..., accountId }
//   { cmd: 'openManager' } / { cmd: 'openWizard', messageId } -> { ok: true }
//
// Deprecated (оставлены для совместимости):
//   savePassword, savePartialConfig, saveManualConfig — выполняют best-effort
//   маппинг на saveAccountConfig.
//
// ── ВАЖНО про хранение (v2 architecture, см. TZ.md §8) ────────────────────
// Все правила одного пользователя хранятся в ОДНОМ mailcow-фильтре с
// active=1. script_data — combined sieve-script v2 (см. sieve_adapter.js).
// Per-rule active реализуется обёрткой `if false { ... }` в combined-script.
//
// Multi-account:
//   ProxyClient инстанциируется per-accountId. Кэш Map<accountId, Promise<ProxyClient>>.
//   Mutex (in-flight) тоже per-accountId — concurrent saveRule в разных
//   ящиках идут параллельно, в одном — сериализованы.
//   Middleware stateless — разные ящики просто разные Basic-auth пары.

import {
  loadConfig,
  loadConfigFor,
  loadAllConfig,
  saveAccountConfig,
  setSelectedAccountId,
  getSelectedAccountId,
  setBaseUrlGlobal,
  deleteAccountConfig,
  saveManualConfig,
  savePassword,
  savePartialConfig,
  tryGetPasswordFromTB,
  tryGetServerInfoFromTB,
  tryListLocalFiltersFromTB,
  effectiveBaseUrlSource,
} from './lib/config_loader.js';
import { ProxyClient } from './lib/proxy_client.js';
import { mapLocalToRules } from './lib/local_filter_mapper.js';
import {
  ruleToSieve,
  sieveToRule,
  rulesToCombinedSieve,
  combinedSieveToRules,
  detectVersion,
  RULE_MARKER_V1,
  RULE_MARKER_V2,
} from './lib/sieve_adapter.js';
import { loadWizardPrefs, saveWizardPrefs } from './lib/wizard_prefs.js';

// ────────────────────────────────────────────────────────────────────────────
// Per-accountId ProxyClient cache.
// ────────────────────────────────────────────────────────────────────────────
const _clientCache = new Map();   // Map<accountId, Promise<{client, mailbox}>>

async function getClientFor(accountId) {
  if (!accountId) throw makeKindError('no_config', 'accountId required');
  if (_clientCache.has(accountId)) return _clientCache.get(accountId);

  const promise = (async () => {
    let cfg = await loadConfigFor(accountId);
    if (!cfg.mailbox) {
      throw makeKindError('no_config', `mailbox not detected for accountId=${accountId}`);
    }
    if (!cfg.baseUrl) {
      throw makeKindError('no_config', `baseUrl not set for accountId=${accountId}`);
    }
    // Lazy bootstrap: если пароль ещё не сохранён в storage — пробуем
    // подсосать его из Login Manager TB через Experiment API. Юзеру не
    // придётся вводить пароль вручную в options-странице, если TB его
    // уже знает (типичный кейс после стандартной IMAP-настройки).
    if (!cfg.password) {
      const fromTB = await tryGetPasswordFromTB(accountId);
      if (fromTB) {
        try {
          await saveAccountConfig(accountId, { password: fromTB });
          cfg = await loadConfigFor(accountId);
        } catch (e) {
          // Сохранить не вышло — всё равно используем подсосанный пароль для
          // текущего запроса, но лог об этом оставляем.
          console.warn('[expor-sieve] saveAccountConfig after TB-import failed:', e?.message || e);
          cfg = { ...cfg, password: fromTB };
        }
      }
    }
    if (!cfg.password) {
      const err = makeKindError('no_password', 'password not set');
      err.accountId = accountId;
      err.mailbox = cfg.mailbox;
      throw err;
    }
    const client = new ProxyClient({
      baseUrl: cfg.baseUrl,
      mailbox: cfg.mailbox,
      password: cfg.password,
    });
    return { client, mailbox: cfg.mailbox, accountId };
  })();
  _clientCache.set(accountId, promise);
  // Если promise зареджектился — сбрасываем кэш, чтобы следующий вызов
  // прошёл заново (особенно важно для no_password — после save password'а).
  promise.catch(() => { _clientCache.delete(accountId); });
  return promise;
}

function resetClient(accountId) {
  if (accountId) _clientCache.delete(accountId);
  else _clientCache.clear();
}

if (browser.storage && browser.storage.onChanged) {
  // docs: https://webextension-api.thunderbird.net/en/mv3/storage.html#onchanged
  browser.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local' || area === 'managed') resetClient();
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Per-account mutex.
// ────────────────────────────────────────────────────────────────────────────
const _inflight = new Map();      // Map<accountId, Promise>
function withLockFor(accountId, fn) {
  const prev = _inflight.get(accountId) || Promise.resolve();
  let resolveMe;
  const next = new Promise((r) => { resolveMe = r; });
  _inflight.set(accountId, next);
  return prev.then(fn, fn).finally(() => {
    resolveMe();
    if (_inflight.get(accountId) === next) _inflight.delete(accountId);
  });
}

// ────────────────────────────────────────────────────────────────────────────
// resolveAccountId — где искать accountId, если UI не передал.
//
// Порядок: явный accountId → selectedAccountId (storage) → первый IMAP/POP3.
// ────────────────────────────────────────────────────────────────────────────
async function resolveAccountId(explicit) {
  if (explicit) return String(explicit);
  const sel = await getSelectedAccountId();
  if (sel) return sel;
  try {
    // docs: https://webextension-api.thunderbird.net/en/mv3/accounts.html#list-includesubfolders
    const accounts = await browser.accounts.list(false);
    const imap = (accounts || []).filter(a => a.type === 'imap' || a.type === 'pop3');
    return imap[0]?.id || null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// getActiveAccountId — one-shot, вызывается только при bootstrap Manager'а.
//
// 1. mailTabs.query({active:true, lastFocusedWindow:true}) → MailTab.
//    docs: https://webextension-api.thunderbird.net/en/mv3/mailTabs.html#query-queryinfo
// 2. Берём первый MailTab с displayedFolder?.accountId
//    (для unified inbox / virtual tag это может быть undefined — fallback).
// 3. selectedAccountId из storage.
// 4. Первый IMAP-аккаунт.
// 5. null.
// ────────────────────────────────────────────────────────────────────────────
async function getActiveAccountId() {
  // Шаг 1: пробуем mailTabs.
  try {
    if (browser.mailTabs && typeof browser.mailTabs.query === 'function') {
      const tabs = await browser.mailTabs.query({ active: true, lastFocusedWindow: true });
      for (const t of (tabs || [])) {
        // displayedFolder в TB 128 — всё ещё MailFolder с accountId.
        // В будущих версиях может быть только displayedFolderId — тогда
        // надо будет folders.get(displayedFolderId) и читать accountId из него.
        const accId = t?.displayedFolder?.accountId;
        if (accId) return accId;
      }
    }
  } catch {
    // mailTabs API доступен через accountsRead — но если не сработал, идём дальше.
  }

  // Шаг 2: storage.selectedAccountId.
  const sel = await getSelectedAccountId();
  if (sel) {
    // Сверим что аккаунт ещё существует.
    try {
      const acc = await browser.accounts.get(sel, false);
      if (acc) return sel;
    } catch {}
  }

  // Шаг 3: первый IMAP/POP3.
  try {
    const accounts = await browser.accounts.list(false);
    const imap = (accounts || []).filter(a => a.type === 'imap' || a.type === 'pop3');
    if (imap[0]) return imap[0].id;
  } catch {}

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// action.onClicked → открыть Filter Manager как single-instance popup-window.
// ────────────────────────────────────────────────────────────────────────────
let managerWindowId = null;

async function openManager() {
  if (managerWindowId !== null) {
    try {
      await browser.windows.update(managerWindowId, { focused: true });
      return;
    } catch {
      managerWindowId = null;
    }
  }
  const w = await browser.windows.create({
    url: 'manager/manager.html',
    type: 'popup',
    width: 900,
    height: 600,
    allowScriptsToClose: true,
  });
  managerWindowId = w.id ?? null;
}

if (browser.action && browser.action.onClicked) {
  browser.action.onClicked.addListener(() => {
    openManager().catch((e) => console.error('[expor-sieve] openManager failed:', e));
  });
}

if (browser.windows && browser.windows.onRemoved) {
  browser.windows.onRemoved.addListener((id) => {
    if (id === managerWindowId) managerWindowId = null;
  });
}

// При удалении IMAP-аккаунта в TB — чистим конфиг.
// docs: https://webextension-api.thunderbird.net/en/mv3/accounts.html#ondeleted
if (browser.accounts && browser.accounts.onDeleted) {
  browser.accounts.onDeleted.addListener(async (accountId) => {
    try {
      await deleteAccountConfig(accountId);
      resetClient(accountId);
    } catch (e) {
      console.warn('[expor-sieve] cleanup on accounts.onDeleted failed:', e?.message || e);
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Контекстное меню «Создать фильтр из этого письма…» в message_list.
// ────────────────────────────────────────────────────────────────────────────
const MENU_ID_CREATE_FROM_MSG = 'expor-sieve-create-from-message';

try {
  browser.menus.create({
    id: MENU_ID_CREATE_FROM_MSG,
    contexts: ['message_list'],
    title: browser.i18n.getMessage('ctx_create_filter_from_message')
            || 'Создать фильтр из этого письма…',
  });
} catch (e) {
  console.warn('[expor-sieve] menus.create:', e?.message || e);
}

if (browser.menus && browser.menus.onClicked) {
  browser.menus.onClicked.addListener(async (info /* , tab */) => {
    if (info.menuItemId !== MENU_ID_CREATE_FROM_MSG) return;
    const messages = info.selectedMessages?.messages;
    if (!messages || !messages.length) return;
    const id = messages[0].id;
    try {
      await browser.windows.create({
        url: `wizard/wizard.html?messageId=${encodeURIComponent(id)}`,
        type: 'popup',
        width: 820,
        height: 620,
        allowScriptsToClose: true,
      });
    } catch (e) {
      console.error('[expor-sieve] open wizard:', e);
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Combined-filter persistence: load + save helpers.
// ────────────────────────────────────────────────────────────────────────────

const COMBINED_DESC = 'EXPOR sieve filters';

/**
 * Прочитать текущее состояние и (если нужно) выполнить миграцию v1→v2 для
 * заданного accountId.
 *
 * Возвращает: { rules, combinedFilterId, accountId, mailbox }
 *
 * Логика идентична v0.4.0, но изолирована per-accountId через getClientFor.
 */
async function listRulesAndContext(accountId) {
  const { client: c, mailbox } = await getClientFor(accountId);

  const filters = await c.listFilters(mailbox);

  const v1Filters = [];
  const v2Filters = [];
  for (const f of (filters || [])) {
    if (typeof f.script_data !== 'string') continue;
    const ver = detectVersion(f.script_data);
    if (ver === 'v1') v1Filters.push(f);
    else if (ver === 'v2') v2Filters.push(f);
  }

  if (v1Filters.length === 0) {
    if (v2Filters.length === 0) {
      return { rules: [], combinedFilterId: null, accountId, mailbox };
    }
    v2Filters.sort((a, b) => Number(a.id) - Number(b.id));
    const canon = v2Filters[0];
    let parsed;
    try {
      parsed = combinedSieveToRules(canon.script_data);
    } catch (e) {
      console.error('[expor-sieve] failed to parse v2 combined script:', e);
      return { rules: [], combinedFilterId: Number(canon.id), accountId, mailbox };
    }
    const combinedId = Number(canon.id);
    const rules = parsed.map((r) => ({ ...r, mailcowId: r.id }));
    rules.sort((a, b) => (a.order || 0) - (b.order || 0));
    return { rules, combinedFilterId: combinedId, accountId, mailbox };
  }

  // Migration path.
  console.info('[expor-sieve] migrating v1 → v2:', v1Filters.length, 'filter(s)');
  const v1Rules = [];
  for (const f of v1Filters) {
    try {
      const parsed = sieveToRule(f.script_data);
      const rule = {
        id: (typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `mig-${Number(f.id)}-${Date.now()}`),
        name: f.script_desc || '(без имени)',
        active: String(f.active) === '1',
        matchAll: parsed.matchAll,
        conditions: parsed.conditions,
        actions: parsed.actions,
        stopAfter: parsed.stopAfter,
        order: Number.isFinite(parsed.order) ? parsed.order : Number(f.id),
        _legacyMailcowId: Number(f.id),
      };
      v1Rules.push(rule);
    } catch (e) {
      console.warn(`[expor-sieve] cannot parse v1 filter id=${f.id}:`, e?.message || e);
    }
  }

  let existingV2Id = null;
  let v2Rules = [];
  if (v2Filters.length > 0) {
    v2Filters.sort((a, b) => Number(a.id) - Number(b.id));
    const canon = v2Filters[0];
    existingV2Id = Number(canon.id);
    try {
      v2Rules = combinedSieveToRules(canon.script_data);
    } catch (e) {
      console.warn('[expor-sieve] cannot parse existing v2 during migration:', e?.message || e);
    }
  }

  const v2Names = new Set(v2Rules.map((r) => (r.name || '').trim()).filter(Boolean));
  const v1ToWrite = v1Rules.filter((r) => !v2Names.has((r.name || '').trim()));

  let nextOrder = v2Rules.reduce((m, r) => Math.max(m, r.order || 0), -1) + 1;
  for (const r of v1ToWrite) {
    r.order = nextOrder++;
  }

  const combined = [...v2Rules, ...v1ToWrite];
  const combinedSieve = rulesToCombinedSieve(combined);

  let combinedFilterId = existingV2Id;
  if (existingV2Id) {
    await c.editFilter(existingV2Id, {
      active: 1,
      script_desc: COMBINED_DESC,
      script_data: combinedSieve,
      filter_type: 'prefilter',
    });
  } else {
    await c.addFilter({
      active: 1,
      username: mailbox,
      script_desc: COMBINED_DESC,
      script_data: combinedSieve,
      filter_type: 'prefilter',
    });
    const fresh = await c.listFilters(mailbox);
    const found = (fresh || []).find(
      (f) => typeof f.script_data === 'string'
        && detectVersion(f.script_data) === 'v2'
        && f.script_desc === COMBINED_DESC
    );
    combinedFilterId = found ? Number(found.id) : null;
  }

  for (const f of v1Filters) {
    try {
      await c.deleteFilter(Number(f.id));
    } catch (e) {
      console.warn(`[expor-sieve] cannot delete legacy v1 filter id=${f.id}:`, e?.message || e);
    }
  }

  const finalRules = combined.map((r) => {
    const out = { ...r, mailcowId: r.id };
    delete out._legacyMailcowId;
    return out;
  });
  finalRules.sort((a, b) => (a.order || 0) - (b.order || 0));
  return { rules: finalRules, combinedFilterId, accountId, mailbox };
}

/**
 * Записать массив правил в combined v2 фильтр.
 * Если combinedFilterId === null — создаёт новый.
 */
async function writeCombined(accountId, rules, combinedFilterId) {
  const { client: c, mailbox } = await getClientFor(accountId);

  const normalized = rules.map((r, i) => ({ ...r, order: i }));
  const sieve = rulesToCombinedSieve(normalized);

  if (combinedFilterId) {
    await c.editFilter(combinedFilterId, {
      active: 1,
      script_desc: COMBINED_DESC,
      script_data: sieve,
      filter_type: 'prefilter',
    });
    return combinedFilterId;
  }
  await c.addFilter({
    active: 1,
    username: mailbox,
    script_desc: COMBINED_DESC,
    script_data: sieve,
    filter_type: 'prefilter',
  });
  const fresh = await c.listFilters(mailbox);
  const found = (fresh || []).find(
    (f) => typeof f.script_data === 'string'
      && detectVersion(f.script_data) === 'v2'
      && f.script_desc === COMBINED_DESC
  );
  return found ? Number(found.id) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// runtime.onMessage — основной API для UI.
// ────────────────────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener(async (msg) => {
  try {
    switch (msg.cmd) {
      // ── Config ─────────────────────────────────────────────────────────
      case 'getConfig':
        return await loadConfig();

      case 'getAccountConfig': {
        const accountId = msg.accountId;
        if (!accountId) return { error: { kind: 'validation', message: 'accountId required' } };
        const cfg = await loadConfigFor(accountId);
        return {
          accountId,
          baseUrl: cfg.baseUrl,
          mailbox: cfg.mailbox,
          hasPassword: !!cfg.password,
          source: cfg.source,
        };
      }

      case 'getAccountStatus': {
        // Read-only structured status for the options page.
        // Returns:
        //   { accountId, mailbox, baseUrl, baseUrlSource, hasPassword,
        //     passwordSource: 'storage'|'experiment'|'none' }
        // Не делает testConnection — только локальный snapshot.
        const accountId = msg.accountId;
        if (!accountId) return { error: { kind: 'validation', message: 'accountId required' } };
        const cfg = await loadConfigFor(accountId);
        const src = await effectiveBaseUrlSource(accountId);
        let passwordSource = 'none';
        if (cfg.password) {
          passwordSource = 'storage';
        } else {
          // Не сохраняем — только узнаём, может ли Experiment отдать пароль.
          // Это «дёшево»: один XPCOM lookup без UI.
          try {
            const pw = await tryGetPasswordFromTB(accountId);
            passwordSource = pw ? 'experiment' : 'none';
          } catch { passwordSource = 'none'; }
        }
        return {
          accountId,
          mailbox: cfg.mailbox,
          baseUrl: src.baseUrl,
          baseUrlSource: src.source,
          hasPassword: !!cfg.password,
          passwordSource,
        };
      }

      case 'getServerInfo': {
        // Прокидывает Experiment-API наружу для UI (например, чтобы показать
        // placeholder с предполагаемым URL ещё до сохранения).
        const accountId = msg.accountId;
        if (!accountId) return { error: { kind: 'validation', message: 'accountId required' } };
        const info = await tryGetServerInfoFromTB(accountId);
        return info;
      }

      case 'resetAccountOverride': {
        // Удаляет per-account baseUrl override → возврат к managed/global/auto.
        const accountId = msg.accountId;
        if (!accountId) return { error: { kind: 'validation', message: 'accountId required' } };
        await saveAccountConfig(accountId, { baseUrl: '' });
        resetClient(accountId);
        return { ok: true };
      }

      case 'saveAccountConfig': {
        const accountId = msg.accountId;
        if (!accountId) return { error: { kind: 'validation', message: 'accountId required' } };
        const patch = {};
        if (msg.baseUrl !== undefined) patch.baseUrl = msg.baseUrl;
        if (msg.password !== undefined) patch.password = msg.password;
        await saveAccountConfig(accountId, patch);
        resetClient(accountId);
        return { ok: true };
      }

      case 'importPasswordFromTB': {
        // Триггерится кнопкой «Импортировать из настроек Thunderbird» в
        // options-странице. Возвращает { ok, hasPassword, available }
        //   available=false → Experiment API вообще не задеплоен (старый TB);
        //   ok=false        → API доступен, но пароля в Login Manager нет.
        const accountId = msg.accountId;
        if (!accountId) return { error: { kind: 'validation', message: 'accountId required' } };
        const apiAvailable = !!(typeof browser !== 'undefined' && browser.exporSieveCredentials);
        if (!apiAvailable) {
          return { ok: false, available: false, hasPassword: false };
        }
        const pw = await tryGetPasswordFromTB(accountId);
        if (!pw) {
          return { ok: false, available: true, hasPassword: false };
        }
        await saveAccountConfig(accountId, { password: pw });
        resetClient(accountId);
        return { ok: true, available: true, hasPassword: true };
      }

      case 'setSelectedAccountId': {
        await setSelectedAccountId(msg.accountId || null);
        return { ok: true };
      }

      case 'getSelectedAccountId': {
        return await getSelectedAccountId();
      }

      case 'setBaseUrlGlobal': {
        await setBaseUrlGlobal(msg.baseUrl || '');
        resetClient();
        return { ok: true };
      }

      case 'getActiveAccountId': {
        return await getActiveAccountId();
      }

      // Deprecated: оставлены для совместимости с старым options.js до полной
      // миграции UI. Новый UI шлёт saveAccountConfig.
      case 'saveManualConfig':
        await saveManualConfig(msg.config);
        resetClient();
        return { ok: true };
      case 'savePartialConfig':
        await savePartialConfig(msg.config || {});
        resetClient();
        return { ok: true };
      case 'savePassword':
        await savePassword(msg.password, msg.mailbox);
        resetClient();
        return { ok: true };

      // ── Connectivity ───────────────────────────────────────────────────
      case 'testConnection': {
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) throw makeKindError('no_config', 'no account');
        const { client } = await getClientFor(accountId);
        const res = await client.checkAuth();
        return { ok: true, ...(res && typeof res === 'object' ? res : {}) };
      }

      // ── Rules CRUD ─────────────────────────────────────────────────────
      case 'listRules': {
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) throw makeKindError('no_config', 'no account');
        return withLockFor(accountId, async () => {
          const ctx = await listRulesAndContext(accountId);
          return ctx.rules;
        });
      }

      case 'saveRule': {
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) throw makeKindError('no_config', 'no account');
        return withLockFor(accountId, async () => {
          const ctx = await listRulesAndContext(accountId);
          const incoming = msg.rule;
          if (!incoming || !incoming.name) throw makeKindError('validation', 'rule name required');

          const updated = [...ctx.rules];
          let idx = -1;
          if (incoming.id) {
            idx = updated.findIndex((r) => r.id === incoming.id);
          }
          if (idx >= 0) {
            updated[idx] = { ...updated[idx], ...incoming };
          } else {
            const newRule = {
              ...incoming,
              id: incoming.id || (typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `r-${Date.now()}`),
              order: typeof incoming.order === 'number' ? incoming.order : updated.length,
            };
            // Если клиент попросил вставить в начало (order < минимального
            // существующего), кладём в начало массива; иначе — в конец.
            // writeCombined пере-нормализует order в [0..N-1] по позиции.
            const minOrder = updated.reduce(
              (m, r) => (typeof r.order === 'number' && r.order < m ? r.order : m),
              0,
            );
            if (typeof incoming.order === 'number' && incoming.order < minOrder) {
              updated.unshift(newRule);
              idx = 0;
            } else {
              updated.push(newRule);
              idx = updated.length - 1;
            }
          }

          await writeCombined(accountId, updated, ctx.combinedFilterId);

          const saved = updated[idx];
          return { ...saved, mailcowId: saved.id };
        });
      }

      case 'deleteRule': {
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) throw makeKindError('no_config', 'no account');
        return withLockFor(accountId, async () => {
          const ctx = await listRulesAndContext(accountId);
          const target = msg.ruleId || msg.mailcowId;
          if (!target) throw makeKindError('validation', 'ruleId or mailcowId required');

          const filtered = ctx.rules.filter((r) => r.id !== String(target));
          if (filtered.length === ctx.rules.length) {
            return { ok: true, removed: 0 };
          }
          await writeCombined(accountId, filtered, ctx.combinedFilterId);
          return { ok: true, removed: ctx.rules.length - filtered.length };
        });
      }

      case 'setRuleActive': {
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) throw makeKindError('no_config', 'no account');
        return withLockFor(accountId, async () => {
          const ctx = await listRulesAndContext(accountId);
          const target = msg.ruleId || msg.mailcowId;
          const active = !!msg.active;
          if (!target) throw makeKindError('validation', 'ruleId or mailcowId required');

          let found = false;
          const updated = ctx.rules.map((r) => {
            if (r.id !== String(target)) return r;
            found = true;
            return { ...r, active };
          });
          if (!found) {
            return { ok: true, changed: 0 };
          }
          await writeCombined(accountId, updated, ctx.combinedFilterId);
          return { ok: true };
        });
      }

      case 'previewSieve':
        return { sieve: ruleToSieve(msg.rule) };

      // ── Local TB filters import ────────────────────────────────────────
      case 'listLocalFilters': {
        // Возвращает rawFilters (TBFilter[]) + результат маппинга — UI сам
        // решает, какие чекбоксы отображать. Никогда не ходит в middleware
        // и не мутирует TB-фильтры. Может бросить только makeKindError.
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) throw makeKindError('no_config', 'no account');
        const raw = await tryListLocalFiltersFromTB(accountId);
        if (raw === null) {
          return { error: { kind: 'no_experiment', message: 'listLocalFilters API not available' } };
        }
        const { mapped, skipped, warnings } = mapLocalToRules(raw, { accountId });
        return {
          rawFilters: raw,
          mapped,
          skipped,
          warnings,
        };
      }

      case 'importLocalFilters': {
        // Принимает массив Rule-объектов (UI отфильтровал в preview-диалоге).
        // Идёт по ним последовательно через тот же writeCombined-сценарий,
        // что и saveRule. Возвращает { saved, errors, ids }.
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) throw makeKindError('no_config', 'no account');
        const incoming = Array.isArray(msg.rules) ? msg.rules : [];
        if (incoming.length === 0) {
          return { saved: 0, errors: [], ids: [] };
        }
        const prefs = await loadWizardPrefs();
        const insertAtTop = prefs.newRulePosition === 'top';
        return withLockFor(accountId, async () => {
          const ctx = await listRulesAndContext(accountId);
          const updated = insertAtTop ? [] : [...ctx.rules];
          const newOnes = [];
          const ids = [];
          const errors = [];
          let saved = 0;
          for (const inc of incoming) {
            try {
              if (!inc || !inc.name) {
                errors.push({ name: inc?.name || '(без имени)', msg: 'имя пустое' });
                continue;
              }
              const newRule = {
                ...inc,
                id: inc.id || (typeof crypto !== 'undefined' && crypto.randomUUID
                  ? crypto.randomUUID()
                  : `r-${Date.now()}-${Math.random()}`),
                order: 0, // финальный order всё равно простамят writeCombined.
              };
              if (insertAtTop) newOnes.push(newRule);
              else updated.push(newRule);
              ids.push(newRule.id);
              saved++;
            } catch (e) {
              errors.push({ name: inc?.name || '(без имени)', msg: e?.message || String(e) });
            }
          }
          if (insertAtTop) {
            updated.push(...newOnes, ...ctx.rules);
          }
          // Один write на весь батч — combined-script переписывается атомарно.
          if (saved > 0) {
            try {
              await writeCombined(accountId, updated, ctx.combinedFilterId);
            } catch (e) {
              // Если writeCombined упал — все накопленные правила не сохранены.
              return {
                saved: 0, ids: [],
                errors: [...errors, { name: '*', msg: e?.message || String(e) }],
              };
            }
          }
          return { saved, errors, ids };
        });
      }

      // ── Folders ────────────────────────────────────────────────────────
      case 'listFolders': {
        const accountId = await resolveAccountId(msg.accountId);
        if (!accountId) return [];
        // docs: https://webextension-api.thunderbird.net/en/mv3/folders.html#query-queryinfo
        const folders = await browser.folders.query({ accountId });
        return folders.map(f => ({ id: f.id, name: f.name, path: f.path }));
      }

      // ── Accounts ───────────────────────────────────────────────────────
      case 'listAccounts': {
        // docs: https://webextension-api.thunderbird.net/en/mv3/accounts.html#list-includesubfolders
        const accounts = await browser.accounts.list(false);
        const all = await loadAllConfig();
        const sel = all.selectedAccountId;
        return (accounts || [])
          .filter(a => a.type === 'imap' || a.type === 'pop3')
          .map(a => {
            const email = (a.identities && a.identities[0] && a.identities[0].email) || '';
            const cfg = all.accounts[a.id] || {};
            return {
              id: a.id,
              name: a.name,
              email,
              identityEmails: (a.identities || []).map(i => i.email).filter(Boolean),
              hasConfig: !!cfg.password,
              isDefault: sel ? a.id === sel : false,
            };
          });
      }

      // ── Message meta (для wizard) ──────────────────────────────────────
      case 'getMessageMeta': {
        const id = Number(msg.id);
        // docs: https://webextension-api.thunderbird.net/en/mv3/messages.html#get-messageid
        const header = await browser.messages.get(id);
        let listId = null;
        let replyTo = null;
        try {
          const full = await browser.messages.getFull(id);
          const h = full?.headers || {};
          listId = (h['list-id'] && h['list-id'][0]) || null;
          replyTo = (h['reply-to'] && h['reply-to'][0]) || null;
        } catch {}
        const date = header.date instanceof Date
          ? header.date.toISOString()
          : (header.date || null);
        // header.folder.accountId — accountsRead permission required (он есть).
        // Может быть undefined для external/attached messages.
        const accountId = header.folder?.accountId || null;
        return {
          id,
          accountId,
          author: header.author || '',
          recipients: Array.isArray(header.recipients) ? header.recipients.join(', ') : '',
          ccList: Array.isArray(header.ccList) ? header.ccList.join(', ') : '',
          subject: header.subject || '',
          date,
          size: header.size || 0,
          flagged: !!header.flagged,
          listId,
          replyTo,
        };
      }

      // ── Wizard / Editor preferences ────────────────────────────────────
      case 'getWizardPrefs': {
        return await loadWizardPrefs();
      }

      case 'saveWizardPrefs': {
        return await saveWizardPrefs(msg.patch || {});
      }

      case 'getOwnEmails': {
        // Возвращает уникальный отсортированный массив email'ов всех
        // identities всех IMAP/POP3 аккаунтов (lowercase). Для шаблона
        // wizard'а «По адресату» — чтобы не создавать фильтр на свой адрес.
        try {
          // docs: https://webextension-api.thunderbird.net/en/mv3/accounts.html#list-includesubfolders
          const accounts = await browser.accounts.list(false);
          const set = new Set();
          for (const a of (accounts || [])) {
            if (a.type !== 'imap' && a.type !== 'pop3') continue;
            const ids = a.identities || [];
            for (const i of ids) {
              const e = (i && i.email) ? String(i.email).trim().toLowerCase() : '';
              if (e) set.add(e);
            }
          }
          return [...set].sort();
        } catch {
          return [];
        }
      }

      // ── Window helpers ─────────────────────────────────────────────────
      case 'openManager': {
        await openManager();
        return { ok: true };
      }

      case 'openWizard': {
        const id = msg.messageId;
        if (!id) throw makeKindError('validation', 'messageId required');
        await browser.windows.create({
          url: `wizard/wizard.html?messageId=${encodeURIComponent(id)}`,
          type: 'popup',
          width: 820,
          height: 620,
          allowScriptsToClose: true,
        });
        return { ok: true };
      }

      default:
        return { error: { kind: 'server', message: 'unknown_cmd' } };
    }
  } catch (e) {
    return { error: normalizeError(e) };
  }
});

function normalizeError(e) {
  if (e instanceof Error) {
    if (e.kind === 'no_password') {
      return { kind: 'no_password', message: e.message,
               accountId: e.accountId, mailbox: e.mailbox };
    }
    if (e.kind) return { kind: e.kind, message: e.message };
    return { kind: 'server', message: e.message };
  }
  return { kind: 'server', message: String(e) };
}

function makeKindError(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

// Re-export для тестов миграции.
export { listRulesAndContext, writeCombined, COMBINED_DESC, getActiveAccountId };
export { RULE_MARKER_V1, RULE_MARKER_V2 };
