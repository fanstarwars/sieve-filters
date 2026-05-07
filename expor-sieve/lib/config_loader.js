// config_loader.js — multi-account конфигурация (schema_version 2).
//
// Архитектура хранения:
//
//   browser.storage.managed (Enterprise Policy):
//     { baseUrl: "https://mail.expor.ru/sieve-proxy" }
//   - один глобальный baseUrl, идёт в baseUrl_global как дефолт.
//
//   browser.storage.local:
//     {
//       schema_version: 2,
//       accounts: {
//         "<accountId>": { baseUrl?: string, password: string }
//       },
//       selectedAccountId?: "<accountId>",
//       baseUrl_global: "https://mail.expor.ru/sieve-proxy"
//     }
//
// mailbox НИГДЕ не хранится — вычисляется через
// browser.accounts.get(accountId).identities[0].email
// docs: https://webextension-api.thunderbird.net/en/mv3/accounts.html
//
// ВАЖНО: пароль хранится в storage.local в открытом виде. Реальная защита —
// права доступа к profile-директории + full-disk-encryption.
//
// Migration: одноразовая, идемпотентная (см. migrateFromV1IfNeeded).

const SCHEMA_VERSION = 2;
const MANAGED_KEYS = ['baseUrl'];

// Кэш выполненной миграции в рамках одного SW-запуска. Это идемпотентная
// функция, но повторно ходить в storage не нужно.
let _migrationDone = false;
let _migrationFailed = null;  // { mailbox } если автомиграция не нашла match

/**
 * @typedef {Object} AccountConfigEntry
 * @property {string} [baseUrl]   per-account override (если undefined — берём global/managed)
 * @property {string} password
 *
 * @typedef {Object} StoredState
 * @property {number} schema_version
 * @property {Object<string, AccountConfigEntry>} accounts
 * @property {string} [selectedAccountId]
 * @property {string} baseUrl_global
 *
 * @typedef {Object} EffectiveConfig
 * @property {string} accountId
 * @property {string} baseUrl
 * @property {string} mailbox
 * @property {string} password
 * @property {'managed'|'manual'|'partial'|'none'} source
 */

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Возвращает полный stored state (с уже выполненной миграцией) + managed.baseUrl.
 *
 * @returns {Promise<{ schema_version: number,
 *                     accounts: Object<string, AccountConfigEntry>,
 *                     selectedAccountId: string|null,
 *                     baseUrl_global: string,
 *                     managedBaseUrl: string,
 *                     migrationFailed: {mailbox:string}|null }>}
 */
export async function loadAllConfig() {
  await migrateFromV1IfNeeded();

  let managed = {};
  try {
    // docs: https://webextension-api.thunderbird.net/en/mv3/storage.html#managed
    managed = await browser.storage.managed.get(MANAGED_KEYS);
  } catch {
    // managed недоступен — это норма для dev/manual инсталляций.
  }

  const local = await browser.storage.local.get([
    'schema_version', 'accounts', 'selectedAccountId', 'baseUrl_global',
  ]);

  const managedBaseUrl = managed.baseUrl || '';
  return {
    schema_version: local.schema_version || SCHEMA_VERSION,
    accounts: local.accounts || {},
    selectedAccountId: local.selectedAccountId || null,
    baseUrl_global: local.baseUrl_global || managedBaseUrl || '',
    managedBaseUrl,
    migrationFailed: _migrationFailed,
  };
}

/**
 * Возвращает effective config для одного аккаунта (резолвит baseUrl и mailbox).
 *
 * Приоритет baseUrl:
 *   1. accounts[id].baseUrl    (per-account override)        → source 'manual' / 'override'
 *   2. managed.baseUrl         (Enterprise Policy)           → source 'managed'
 *   3. baseUrl_global          (legacy global default)       → source 'manual' / 'global'
 *   4. tryGetServerInfoFromTB(id) → `https://${hostname}/sieve-proxy`
 *                                                            → source 'auto'
 *   5. ничего → source 'none' / 'partial'
 *
 * mailbox: accounts.get(id).identities[0].email (lowercase preserved as-is)
 * password: accounts[id].password
 * source (legacy 4-state — стабильный контракт для остальных вызывающих):
 *   - managed  — managed.baseUrl активен AND password есть
 *   - manual   — password есть (без managed) — включает override/global/auto
 *   - partial  — baseUrl есть, password нет
 *   - none     — ничего нет (даже auto-derive не сработал)
 *
 * Для UI status (5-state источник baseUrl) используйте
 * `effectiveBaseUrlSource(accountId)`.
 *
 * @param {string} accountId
 * @returns {Promise<EffectiveConfig>}
 */
export async function loadConfigFor(accountId) {
  if (!accountId) {
    return { accountId: '', baseUrl: '', mailbox: '', password: '', source: 'none' };
  }
  const all = await loadAllConfig();
  const entry = all.accounts[accountId] || {};
  let baseUrl = entry.baseUrl || all.managedBaseUrl || all.baseUrl_global || '';
  // Lazy auto-derive из IMAP-настроек TB (Experiment API). Никуда не пишем —
  // если юзер позже сменит IMAP-host или поставит middleware на отдельную
  // машину, derived URL должен пересчитаться сам.
  if (!baseUrl) {
    const auto = await tryDeriveBaseUrlFromTB(accountId);
    if (auto) baseUrl = auto;
  }
  const password = entry.password || '';
  const mailbox = await mailboxForAccountId(accountId);

  let source = 'none';
  if (baseUrl && password) {
    source = (all.managedBaseUrl && !entry.baseUrl) ? 'managed' : 'manual';
  } else if (baseUrl && !password) {
    source = 'partial';
  }

  return { accountId, baseUrl, mailbox, password, source };
}

/**
 * Уточнённый источник baseUrl (5 веток) — для status-страницы options.
 *
 * @param {string} accountId
 * @returns {Promise<{source:'override'|'managed'|'global'|'auto'|'none', baseUrl:string}>}
 */
export async function effectiveBaseUrlSource(accountId) {
  if (!accountId) return { source: 'none', baseUrl: '' };
  const all = await loadAllConfig();
  const entry = all.accounts[accountId] || {};
  if (entry.baseUrl) return { source: 'override', baseUrl: entry.baseUrl };
  if (all.managedBaseUrl) return { source: 'managed', baseUrl: all.managedBaseUrl };
  if (all.baseUrl_global) return { source: 'global', baseUrl: all.baseUrl_global };
  const auto = await tryDeriveBaseUrlFromTB(accountId);
  if (auto) return { source: 'auto', baseUrl: auto };
  return { source: 'none', baseUrl: '' };
}

/**
 * Wrapper для обратной совместимости. Возвращает effective config либо для
 * selectedAccountId, либо для первого IMAP-аккаунта, если ничего не выбрано.
 *
 * @returns {Promise<EffectiveConfig>}
 */
export async function loadConfig() {
  const all = await loadAllConfig();
  let accountId = all.selectedAccountId;
  if (!accountId) {
    accountId = await firstImapAccountId();
  }
  if (!accountId) {
    return { accountId: '', baseUrl: '', mailbox: '', password: '', source: 'none' };
  }
  return await loadConfigFor(accountId);
}

/**
 * Сохраняет (мерджит) конфиг для одного аккаунта.
 * Если baseUrl undefined — не трогаем (оставляем существующий или fallback).
 * Если password undefined — не трогаем.
 *
 * @param {string} accountId
 * @param {{baseUrl?: string, password?: string}} patch
 */
export async function saveAccountConfig(accountId, patch = {}) {
  if (!accountId) throw new Error('saveAccountConfig: accountId required');
  const all = await loadAllConfig();
  const accounts = { ...all.accounts };
  const prev = accounts[accountId] || {};
  const next = { ...prev };
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl === '' || patch.baseUrl === null) {
      delete next.baseUrl;
    } else {
      next.baseUrl = String(patch.baseUrl);
    }
  }
  if (patch.password !== undefined) {
    next.password = String(patch.password || '');
  }
  accounts[accountId] = next;
  await browser.storage.local.set({
    schema_version: SCHEMA_VERSION,
    accounts,
  });
}

/**
 * Удаляет конфиг аккаунта (используется когда юзер удалил аккаунт в TB).
 * @param {string} accountId
 */
export async function deleteAccountConfig(accountId) {
  if (!accountId) return;
  const all = await loadAllConfig();
  const accounts = { ...all.accounts };
  if (!(accountId in accounts)) return;
  delete accounts[accountId];
  const patch = { accounts };
  if (all.selectedAccountId === accountId) {
    patch.selectedAccountId = null;
  }
  await browser.storage.local.set(patch);
}

/**
 * Сохраняет «активный» (по выбору пользователя) accountId.
 */
export async function setSelectedAccountId(accountId) {
  await browser.storage.local.set({
    schema_version: SCHEMA_VERSION,
    selectedAccountId: accountId || null,
  });
}

export async function getSelectedAccountId() {
  const all = await loadAllConfig();
  return all.selectedAccountId || null;
}

/**
 * Сохраняет глобальный baseUrl-default (fallback для всех аккаунтов без override).
 */
export async function setBaseUrlGlobal(baseUrl) {
  await browser.storage.local.set({
    schema_version: SCHEMA_VERSION,
    baseUrl_global: String(baseUrl || ''),
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────────────

/**
 * Получить email из identities[0] для accountId.
 * docs: https://webextension-api.thunderbird.net/en/mv3/accounts.html#get-accountid-includesubfolders
 */
async function mailboxForAccountId(accountId) {
  try {
    // accounts.get с includeSubFolders=false — нам не нужны папки.
    const acc = await browser.accounts.get(accountId, false);
    if (!acc) return '';
    const ids = acc.identities || [];
    return (ids[0] && ids[0].email) || '';
  } catch {
    return '';
  }
}

/**
 * Найти id первого IMAP/POP3 аккаунта.
 * docs: https://webextension-api.thunderbird.net/en/mv3/accounts.html#list-includesubfolders
 */
async function firstImapAccountId() {
  try {
    const accounts = await browser.accounts.list(false);
    const imap = (accounts || []).filter(a => a.type === 'imap' || a.type === 'pop3');
    return imap[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * Найти accountId, чей identities[*].email совпадает (case-insensitive) с mailbox.
 */
async function findAccountIdByMailbox(mailbox) {
  if (!mailbox) return null;
  try {
    const accounts = await browser.accounts.list(false);
    const target = String(mailbox).toLowerCase();
    for (const a of (accounts || [])) {
      for (const id of (a.identities || [])) {
        if (id.email && id.email.toLowerCase() === target) return a.id;
      }
    }
  } catch {}
  return null;
}

/**
 * Идемпотентная миграция legacy-формата { baseUrl, mailbox, password } → v2.
 *
 * Логика:
 *   1. Если уже schema_version === 2 → ничего не делаем (но всё равно
 *      проставляем baseUrl_global если только-только появилась managed).
 *   2. Иначе проверяем legacy keys.
 *   3. Если есть mailbox + password → ищем accountId.
 *      - найден: переносим в accounts[id], ставим selectedAccountId,
 *        baseUrl_global = legacyBaseUrl (или managed.baseUrl), удаляем legacy.
 *      - не найден: НЕ удаляем legacy, проставляем _migrationFailed (но
 *        schema_version не пишем — попробуем мигрировать ещё раз позже).
 *   4. Если legacy нет совсем → просто помечаем schema_version = 2.
 *
 * Внимание: вызывается лениво при первом loadAllConfig().
 */
export async function migrateFromV1IfNeeded() {
  if (_migrationDone) return;

  let managed = {};
  try {
    managed = await browser.storage.managed.get(MANAGED_KEYS);
  } catch {}

  const local = await browser.storage.local.get([
    'schema_version', 'accounts', 'selectedAccountId', 'baseUrl_global',
    'baseUrl', 'mailbox', 'password',  // legacy
  ]);

  // Уже v2 — не трогаем accounts, но обеспечиваем baseUrl_global.
  if (Number(local.schema_version) === SCHEMA_VERSION) {
    if (!local.baseUrl_global && managed.baseUrl) {
      await browser.storage.local.set({ baseUrl_global: managed.baseUrl });
    }
    _migrationDone = true;
    return;
  }

  const legacyBaseUrl = local.baseUrl || '';
  const legacyMailbox = local.mailbox || '';
  const legacyPassword = local.password || '';

  // Нет legacy — просто включаем v2.
  if (!legacyMailbox && !legacyPassword && !legacyBaseUrl) {
    await browser.storage.local.set({
      schema_version: SCHEMA_VERSION,
      accounts: local.accounts || {},
      baseUrl_global: local.baseUrl_global || managed.baseUrl || '',
    });
    _migrationDone = true;
    return;
  }

  // Есть legacy — пытаемся смэтчить mailbox с TB-аккаунтом.
  const matchedId = await findAccountIdByMailbox(legacyMailbox);
  if (!matchedId) {
    // Не нашли — пометили проблему, но НЕ переходим в v2 окончательно.
    // Так юзер увидит баннер; повторный запуск в новой сессии TB снова
    // попробует мигрировать (вдруг аккаунт появится).
    _migrationFailed = { mailbox: legacyMailbox };
    _migrationDone = true;
    return;
  }

  const accounts = { ...(local.accounts || {}) };
  const entry = { ...(accounts[matchedId] || {}) };
  if (legacyBaseUrl) entry.baseUrl = legacyBaseUrl;
  if (legacyPassword) entry.password = legacyPassword;
  accounts[matchedId] = entry;

  // baseUrl_global: предпочитаем managed (если есть), иначе legacyBaseUrl.
  const baseUrlGlobal = managed.baseUrl || local.baseUrl_global || legacyBaseUrl || '';

  await browser.storage.local.set({
    schema_version: SCHEMA_VERSION,
    accounts,
    selectedAccountId: matchedId,
    baseUrl_global: baseUrlGlobal,
  });
  // Удаляем legacy keys — миграция успешна.
  await browser.storage.local.remove(['baseUrl', 'mailbox', 'password']);
  _migrationFailed = null;
  _migrationDone = true;
}

/**
 * Тестовый хук: сбросить кэш миграции (для unit-тестов).
 */
export function __resetMigrationStateForTests() {
  _migrationDone = false;
  _migrationFailed = null;
}

// ────────────────────────────────────────────────────────────────────────────
// Thunderbird Login Manager bridge.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Попытаться прочитать пароль IMAP/POP3-аккаунта из Login Manager TB через
 * Experiment API `browser.exporSieveCredentials.getImapPassword`.
 *
 * - Возвращает строку (пароль) или `null` (нечего взять / Experiment не
 *   доступен / любая ошибка). Никогда не throw.
 * - НЕ инициирует master-password prompt.
 *
 * Контракт Experiment-API см. в `experiments/credentials/schema.json`.
 *
 * @param {string} accountId
 * @returns {Promise<string|null>}
 */
export async function tryGetPasswordFromTB(accountId) {
  if (!accountId) return null;
  try {
    const api = (typeof browser !== 'undefined') ? browser.exporSieveCredentials : null;
    if (!api || typeof api.getImapPassword !== 'function') return null;
    const pw = await api.getImapPassword(String(accountId));
    if (typeof pw === 'string' && pw.length > 0) return pw;
    return null;
  } catch (e) {
    // Experiment не должен падать наружу — если что-то пошло не так,
    // молча возвращаем null чтобы caller'ы fallback'нули на manual entry.
    try { console.warn('[expor-sieve] tryGetPasswordFromTB failed:', e?.message || e); } catch (_e) {}
    return null;
  }
}

/**
 * Попытаться прочитать non-secret incomingServer attributes из TB через
 * Experiment API `browser.exporSieveCredentials.getServerInfo`.
 *
 * - Возвращает `{hostname, port, type, username, hostnameOrIp}` или `null`.
 * - Не throw'ит, не открывает master-password prompt.
 * - На старом TB / форке без experiment_apis возвращает `null`.
 *
 * Контракт см. `experiments/credentials/schema.json`.
 *
 * @param {string} accountId
 * @returns {Promise<{hostname:string,port:number,type:string,username:string,hostnameOrIp:string}|null>}
 */
export async function tryGetServerInfoFromTB(accountId) {
  if (!accountId) return null;
  try {
    const api = (typeof browser !== 'undefined') ? browser.exporSieveCredentials : null;
    if (!api || typeof api.getServerInfo !== 'function') return null;
    const info = await api.getServerInfo(String(accountId));
    if (!info || typeof info !== 'object') return null;
    if (typeof info.hostname !== 'string' || !info.hostname) return null;
    return {
      hostname: info.hostname,
      port: Number(info.port) || 0,
      type: String(info.type || '').toLowerCase(),
      username: String(info.username || ''),
      hostnameOrIp: String(info.hostnameOrIp || info.hostname),
    };
  } catch (e) {
    try { console.warn('[expor-sieve] tryGetServerInfoFromTB failed:', e?.message || e); } catch (_e) {}
    return null;
  }
}

/**
 * Попытаться прочитать локальные TB-фильтры через Experiment API
 * `browser.exporSieveCredentials.listLocalFilters`.
 *
 * - Возвращает массив TBFilter (см. `lib/local_filter_mapper.js`) или
 *   `null`, если Experiment-API не задеплоен (старый TB / форк).
 * - На любую runtime-ошибку Experiment'а сам он возвращает `[]`. Здесь мы
 *   различаем это так: если API нет совсем — `null`, если API есть и
 *   вернул что-то (включая `[]`) — возвращаем как есть. UI использует
 *   `null` чтобы показать «функция недоступна в этой версии TB».
 *
 * @param {string} accountId
 * @returns {Promise<Array|null>}
 */
export async function tryListLocalFiltersFromTB(accountId) {
  if (!accountId) return null;
  try {
    const api = (typeof browser !== 'undefined') ? browser.exporSieveCredentials : null;
    if (!api || typeof api.listLocalFilters !== 'function') return null;
    const arr = await api.listLocalFilters(String(accountId));
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch (e) {
    try { console.warn('[expor-sieve] tryListLocalFiltersFromTB failed:', e?.message || e); } catch (_e) {}
    return [];
  }
}

/**
 * Delete local TB filters by name через Experiment-API.
 *
 * Контракт:
 *   - Возвращает `null`, если Experiment-API не задеплоен (старый TB / форк
 *     / Betterbird без подписи) — UI трактует это как "функция недоступна".
 *   - Возвращает `{ deleted, errors }` иначе. Если сам Experiment-метод
 *     бросил исключение (а он не должен — он try/catch'ит всё), мы
 *     возвращаем `{ deleted: 0, errors: [{ name: null, msg }] }`, чтобы
 *     UI смог показать non-fatal error baseline и не уронил уже
 *     успешный импорт.
 *
 * @param {string} accountId
 * @param {string[]} names — имена TB-фильтров (case-insensitive match в impl).
 * @returns {Promise<{deleted:number, errors:Array<{name?:string|null,msg:string}>}|null>}
 */
export async function tryDeleteLocalFiltersFromTB(accountId, names) {
  if (!accountId) return { deleted: 0, errors: [{ name: null, msg: 'accountId required' }] };
  const arr = Array.isArray(names) ? names : [];
  try {
    const api = (typeof browser !== 'undefined') ? browser.exporSieveCredentials : null;
    if (!api || typeof api.deleteLocalFilters !== 'function') return null;
    const r = await api.deleteLocalFilters(String(accountId), arr);
    // Defensive shape-check — Experiment контракт стабилен, но если фронт
    // когда-нибудь окажется быстрее бэка, не дать UI упасть на NPE.
    if (!r || typeof r !== 'object') return { deleted: 0, errors: [] };
    const deleted = Number.isFinite(r.deleted) ? Number(r.deleted) : 0;
    const errors = Array.isArray(r.errors) ? r.errors : [];
    return { deleted, errors };
  } catch (e) {
    try { console.warn('[expor-sieve] tryDeleteLocalFiltersFromTB failed:', e?.message || e); } catch (_e) {}
    return { deleted: 0, errors: [{ name: null, msg: e?.message || String(e) }] };
  }
}

/**
 * Сконструировать baseUrl middleware из IMAP-host'а аккаунта.
 *
 * Конвенция (см. TZ.md / архитектура): middleware деплоится на том же
 * сервере, что и IMAP, и доступен по `https://${IMAP_HOST}/sieve-proxy`.
 *
 * @param {string} accountId
 * @returns {Promise<string|null>} URL без trailing slash или null если info нет.
 */
export async function tryDeriveBaseUrlFromTB(accountId) {
  const info = await tryGetServerInfoFromTB(accountId);
  if (!info || !info.hostname) return null;
  return `https://${info.hostname}/sieve-proxy`;
}

// ────────────────────────────────────────────────────────────────────────────
// Deprecated wrappers (поддержка старого UI / external callers).
// Не использовать в новом коде — они работают только для selectedAccountId.
// ────────────────────────────────────────────────────────────────────────────

/** @deprecated Используйте saveAccountConfig(accountId, {...}). */
export async function saveManualConfig({ baseUrl, mailbox, password }) {
  let id = await findAccountIdByMailbox(mailbox);
  if (!id) id = await firstImapAccountId();
  if (!id) throw new Error('saveManualConfig: cannot resolve accountId');
  await saveAccountConfig(id, { baseUrl, password });
  if (baseUrl) await setBaseUrlGlobal(baseUrl);
  await setSelectedAccountId(id);
}

/** @deprecated Используйте saveAccountConfig(accountId, { password }). */
export async function savePassword(password, mailbox) {
  let id = mailbox ? await findAccountIdByMailbox(mailbox) : null;
  if (!id) id = (await loadAllConfig()).selectedAccountId || (await firstImapAccountId());
  if (!id) throw new Error('savePassword: cannot resolve accountId');
  await saveAccountConfig(id, { password });
  await setSelectedAccountId(id);
}

/** @deprecated Используйте saveAccountConfig + setBaseUrlGlobal. */
export async function savePartialConfig({ baseUrl, mailbox, password }) {
  let id = mailbox ? await findAccountIdByMailbox(mailbox) : null;
  if (!id) id = (await loadAllConfig()).selectedAccountId || (await firstImapAccountId());
  if (id) {
    const patch = {};
    if (baseUrl !== undefined) patch.baseUrl = baseUrl;
    if (password !== undefined) patch.password = password;
    await saveAccountConfig(id, patch);
  }
  if (baseUrl !== undefined) await setBaseUrlGlobal(baseUrl);
}
