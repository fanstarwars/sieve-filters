// SPDX-License-Identifier: GPL-3.0-or-later
// options.js — read-only status-страница плагина (auto-derive everything).
//
// Концепция:
//   - Каждый IMAP/POP3-аккаунт рендерится карточкой со статусом одной строкой.
//   - baseUrl автоматически выводится из IMAP-host'а аккаунта (Experiment API
//     getServerInfo) → `https://${hostname}/sieve-proxy`.
//   - Пароль автоматически берётся из Login Manager TB через Experiment.
//   - Юзер вводит что-либо ТОЛЬКО когда автомеханика не сработала
//     (нестандартный middleware-host, master password в TB, и т.п.) —
//     раскрывая «▶ Дополнительно».
//
// Состояния карточки:
//   OK    — есть baseUrl AND есть password (storage или experiment).
//   Warn  — есть baseUrl, password только experiment (или ничего, но
//           experiment может выдать).
//   Err   — нет baseUrl ИЛИ ни storage ни experiment не дали password.

import { t } from '../lib/rule_form.js';

function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    } else if (v === true) node.setAttribute(k, '');
    else if (v === false || v == null) {/* skip */}
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

async function send(msg) {
  const res = await browser.runtime.sendMessage(msg);
  if (res && res.error) throw res.error;
  return res;
}

function isExperimentAvailable() {
  try {
    return !!(typeof browser !== 'undefined'
      && browser.exporSieveCredentials
      && typeof browser.exporSieveCredentials.getImapPassword === 'function');
  } catch { return false; }
}

function isLocalImportAvailable() {
  try {
    return !!(typeof browser !== 'undefined'
      && browser.exporSieveCredentials
      && typeof browser.exporSieveCredentials.listLocalFilters === 'function');
  } catch { return false; }
}

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  switch (err.kind) {
    case 'network':     return t('err_no_network');
    case 'auth':        return t('err_auth_password_wrong');
    case 'server':      return t('err_server');
    case 'no_config':   return t('err_no_managed_config');
    case 'no_password': return t('err_no_password') || 'Введите пароль для этого ящика.';
    default:            return err.message || String(err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────────────────────
const state = {
  accounts: [],            // [{id, name, email}]
  statuses: new Map(),     // accountId → { baseUrl, baseUrlSource, hasPassword, passwordSource, mailbox }
  serverInfo: new Map(),   // accountId → ServerInfo|null   (для placeholder hint в advanced)
  migrationFailed: null,   // {mailbox} | null
};

// ────────────────────────────────────────────────────────────────────────────
// Loaders
// ────────────────────────────────────────────────────────────────────────────
async function loadAll() {
  let accounts = [];
  try {
    accounts = await send({ cmd: 'listAccounts' }) || [];
  } catch {
    accounts = [];
  }
  state.accounts = accounts;

  state.statuses.clear();
  state.serverInfo.clear();
  for (const a of accounts) {
    try {
      const st = await send({ cmd: 'getAccountStatus', accountId: a.id });
      state.statuses.set(a.id, st);
    } catch {
      state.statuses.set(a.id, {
        accountId: a.id, mailbox: a.email, baseUrl: '',
        baseUrlSource: 'none', hasPassword: false, passwordSource: 'none',
      });
    }
    try {
      const info = await send({ cmd: 'getServerInfo', accountId: a.id });
      state.serverInfo.set(a.id, info || null);
    } catch {
      state.serverInfo.set(a.id, null);
    }
  }

  // Migration failure baner — legacy keys остались в storage.local если
  // схема не успела апгрейднуться.
  try {
    const legacy = await browser.storage.local.get(['schema_version', 'mailbox']);
    if (Number(legacy.schema_version) !== 2 && legacy.mailbox) {
      state.migrationFailed = { mailbox: legacy.mailbox };
    } else {
      state.migrationFailed = null;
    }
  } catch { state.migrationFailed = null; }
}

// ────────────────────────────────────────────────────────────────────────────
// Card helpers
// ────────────────────────────────────────────────────────────────────────────
function classifyStatus(st) {
  // OK    — baseUrl И (storage|experiment). Password будет либо уже задан,
  //         либо будет автоматически импортирован при первом обращении.
  // WARN  — baseUrl есть, password только experiment (auto-import доступен,
  //         но storage пусто) ИЛИ в storage есть password но baseUrl только
  //         auto и Experiment показывает что есть. Стараемся подсветить
  //         «нужен пароль» отдельно.
  // ERR   — baseUrl=none ИЛИ password=none.
  if (!st.baseUrl) return 'err';
  if (st.passwordSource === 'storage') return 'ok';
  if (st.passwordSource === 'experiment') return 'warn';
  return 'err';
}

function badgeFor(level) {
  if (level === 'ok')  return el('span', { class: 'acc-badge ok'   }, '✓ ', t('options_status_ok'));
  if (level === 'warn') return el('span', { class: 'acc-badge warn' }, '⚠ ', t('options_status_need_password'));
  return el('span', { class: 'acc-badge err' }, '⚙ ', t('options_status_need_setup'));
}

function urlSourceTag(source) {
  switch (source) {
    case 'auto':     return t('options_url_auto');
    case 'managed':  return t('options_url_managed');
    case 'override': return t('options_url_override');
    case 'global':   return t('options_url_global');
    default:         return t('options_url_none');
  }
}

function pwdSourceText(source) {
  switch (source) {
    case 'storage':    return t('options_pwd_storage');
    case 'experiment': return t('options_pwd_experiment');
    default:           return t('options_pwd_none');
  }
}

function defaultBaseUrlForAccount(accountId) {
  const info = state.serverInfo.get(accountId);
  if (info && info.hostname) return `https://${info.hostname}/sieve-proxy`;
  return '';
}

// ────────────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────────────
function renderAccounts() {
  const host = document.getElementById('accountsHost');
  host.replaceChildren();

  if (state.migrationFailed) {
    const msg = (t('options_migration_failed') ||
      'Старая конфигурация для {0} не была мигрирована автоматически.')
      .replace('{0}', state.migrationFailed.mailbox);
    host.append(el('div', { class: 'banner err' }, msg));
  }

  if (state.accounts.length === 0) {
    host.append(el('p', { class: 'banner warn' },
      t('options_no_accounts') || 'В Thunderbird не найдено IMAP/POP3 аккаунтов.'));
    return;
  }

  const list = el('div', { class: 'acc-list' });
  for (const a of state.accounts) {
    list.append(renderAccountCard(a));
  }
  host.append(list);
}

function renderAccountCard(account) {
  const st = state.statuses.get(account.id) || {
    baseUrl: '', baseUrlSource: 'none', hasPassword: false, passwordSource: 'none',
  };
  const level = classifyStatus(st);

  const card = el('div', { class: 'acc-card', 'data-account-id': account.id });

  // Head: icon, mailbox, status badge.
  card.append(el('div', { class: 'acc-head' },
    el('span', { class: 'acc-icon' }, '📨'),
    el('span', { class: 'acc-mail' }, account.email || account.name),
    badgeFor(level),
  ));

  // Info rows: server + password.
  const info = el('div', { class: 'acc-info' });
  info.append(el('div', { class: 'acc-row' },
    el('span', { class: 'acc-key' }, t('options_url_label')),
    el('span', { class: 'acc-val' }, st.baseUrl || t('options_url_none')),
    el('span', { class: 'acc-sub' }, '(', urlSourceTag(st.baseUrlSource), ')'),
  ));
  info.append(el('div', { class: 'acc-row' },
    el('span', { class: 'acc-key' }, t('options_pwd_label')),
    el('span', { class: 'acc-val' }, pwdSourceText(st.passwordSource)),
  ));
  card.append(info);

  // Actions row.
  const testStatus = el('span', { class: 'status' });
  const testBtn = el('button', { type: 'button' }, t('options_test_btn'));
  testBtn.addEventListener('click', async () => {
    testStatus.className = 'status'; testStatus.textContent = '…';
    try {
      await send({ cmd: 'testConnection', accountId: account.id });
      testStatus.classList.add('ok');
      testStatus.textContent = t('options_test_inline_ok');
      // Перерендер: после успешного test, password мог автоматически
      // импортироваться через background → status может стать 'storage'.
      await loadAll();
      renderAccounts();
    } catch (e) {
      testStatus.classList.add('err');
      testStatus.textContent = t('options_test_inline_fail', [errorText(e)])
        || ('Ошибка: ' + errorText(e));
    }
  });

  // «Импортировать фильтры из Thunderbird» — отдельная кнопка, ходит в
  // Manager dialog при возможности (полноценный preview), а в options
  // ограничивается коротким confirm() с количеством совместимых правил.
  const importLocalBtn = el('button', { type: 'button' },
    t('options_import_local_btn') || 'Импортировать фильтры из Thunderbird');
  if (!isLocalImportAvailable()) importLocalBtn.hidden = true;
  importLocalBtn.addEventListener('click', async () => {
    testStatus.className = 'status'; testStatus.textContent = '…';
    try {
      const r = await send({ cmd: 'listLocalFilters', accountId: account.id });
      if (r.error) {
        testStatus.classList.add('err');
        testStatus.textContent = (r.error.kind === 'no_experiment')
          ? (t('options_import_local_unavailable') || 'Импорт недоступен в этой версии TB.')
          : errorText(r.error);
        return;
      }
      const raw = r.rawFilters || [];
      const mapped = r.mapped || [];
      if (raw.length === 0) {
        testStatus.classList.add('err');
        testStatus.textContent = t('options_import_local_empty')
          || 'Локальные фильтры для этого аккаунта не найдены.';
        return;
      }
      if (mapped.length === 0) {
        testStatus.classList.add('err');
        testStatus.textContent = (t('options_import_local_no_compat',
          [String(raw.length)]) ||
          `Найдено ${raw.length} фильтров, ни один не совместим — импорт невозможен.`);
        return;
      }
      const ok = window.confirm((t('options_import_local_confirm',
        [String(mapped.length), String(raw.length)]) ||
        `Импортировать ${mapped.length} из ${raw.length} локальных фильтров?`));
      if (!ok) {
        testStatus.textContent = '';
        return;
      }
      const r2 = await send({ cmd: 'importLocalFilters', accountId: account.id, rules: mapped });
      if (r2.error) {
        testStatus.classList.add('err');
        testStatus.textContent = errorText(r2.error);
        return;
      }
      const saved = (r2 && r2.saved) || 0;
      testStatus.classList.add('ok');
      testStatus.textContent = (t('options_import_local_done', [String(saved)])
        || `Импортировано ${saved} фильтров.`);
    } catch (e) {
      testStatus.classList.add('err');
      testStatus.textContent = errorText(e);
    }
  });

  const importBtn = el('button', { type: 'button' }, t('options_import_btn'));
  if (!isExperimentAvailable()) importBtn.hidden = true;
  importBtn.addEventListener('click', async () => {
    testStatus.className = 'status'; testStatus.textContent = '…';
    try {
      const r = await send({ cmd: 'importPasswordFromTB', accountId: account.id });
      if (!r.available) {
        testStatus.classList.add('err');
        testStatus.textContent = t('options_import_unavailable');
        return;
      }
      if (!r.hasPassword) {
        testStatus.classList.add('err');
        testStatus.textContent = t('options_import_not_found');
        return;
      }
      testStatus.classList.add('ok');
      testStatus.textContent = t('options_import_ok');
      await loadAll();
      renderAccounts();
    } catch (e) {
      testStatus.classList.add('err');
      testStatus.textContent = errorText(e);
    }
  });

  // Toggle advanced.
  const advWrap = el('div', { class: 'acc-advanced', hidden: true });
  const advToggle = el('button', { type: 'button', class: 'link' }, '▶ ', t('options_advanced'));
  advToggle.addEventListener('click', () => {
    if (advWrap.hidden) {
      advWrap.hidden = false;
      advToggle.textContent = '';
      advToggle.append(document.createTextNode('▼ ' + t('options_advanced_hide')));
    } else {
      advWrap.hidden = true;
      advToggle.textContent = '';
      advToggle.append(document.createTextNode('▶ ' + t('options_advanced')));
    }
  });

  // Кнопки в actions меняются в зависимости от уровня.
  const actions = el('div', { class: 'acc-actions' });
  if (level === 'ok' || level === 'warn') {
    actions.append(advToggle, testBtn);
    if (level === 'warn' && !importBtn.hidden) actions.append(importBtn);
  } else {
    // ERR: показываем «Импортировать» (если доступно) + «Указать вручную»
    // (раскрывает advanced + фокус на password).
    if (!importBtn.hidden) actions.append(importBtn);
    const setManuallyBtn = el('button', { type: 'button', class: 'primary' },
      t('options_set_manually_btn'));
    setManuallyBtn.addEventListener('click', () => {
      if (advWrap.hidden) {
        advWrap.hidden = false;
        advToggle.textContent = '';
        advToggle.append(document.createTextNode('▼ ' + t('options_advanced_hide')));
      }
      const pwInp = advWrap.querySelector('input[type=password], input.pw-input');
      if (pwInp) setTimeout(() => pwInp.focus(), 30);
    });
    actions.append(setManuallyBtn, advToggle, testBtn);
  }
  // Кнопка импорта фильтров — показываем для OK/Warn (когда есть конфиг
  // подключения к middleware; иначе импортировать некуда).
  if ((level === 'ok' || level === 'warn') && !importLocalBtn.hidden) {
    actions.append(importLocalBtn);
  }
  actions.append(testStatus);
  card.append(actions);

  // Advanced section — рендерится сразу (но скрыт), чтобы фокус сразу работал.
  renderAdvanced(advWrap, account, st);
  card.append(advToggle.nextSibling ? null : null); // no-op
  card.append(advWrap);

  return card;
}

function renderAdvanced(advWrap, account, st) {
  advWrap.replaceChildren();

  const defaultUrl = defaultBaseUrlForAccount(account.id);
  const urlInput = el('input', {
    type: 'url',
    value: st.baseUrlSource === 'override' ? st.baseUrl : '',
    placeholder: defaultUrl || t('options_field_baseurl_placeholder'),
    class: 'url-input',
  });
  const pwInput = el('input', {
    type: 'password',
    autocomplete: 'current-password',
    placeholder: t('options_field_password_placeholder')
      || 'Введите пароль mailcow или app-password',
    class: 'pw-input',
  });
  const showPwBtn = el('button', { type: 'button' }, t('options_apikey_show'));
  showPwBtn.addEventListener('click', () => {
    if (pwInput.type === 'password') {
      pwInput.type = 'text';
      showPwBtn.textContent = t('options_apikey_hide');
    } else {
      pwInput.type = 'password';
      showPwBtn.textContent = t('options_apikey_show');
    }
  });

  // URL row.
  advWrap.append(
    el('label', {}, t('options_url_override_label')),
    el('div', { class: 'row' }, urlInput),
  );
  if (defaultUrl) {
    const hint = (t('options_url_default_hint', [defaultUrl])
                  || `По умолчанию = ${defaultUrl}`);
    advWrap.append(el('div', { class: 'acc-hint' }, hint));
  }

  // Password row.
  advWrap.append(
    el('label', {}, t('options_pwd_override_label')),
    el('div', { class: 'row' }, pwInput, showPwBtn),
  );

  // Actions: save / reset / status.
  const advStatus = el('div', { class: 'adv-status' });
  const saveBtn = el('button', { type: 'button', class: 'primary' },
    t('options_save_override'));
  const resetBtn = el('button', { type: 'button' },
    t('options_reset_override'));

  saveBtn.addEventListener('click', async () => {
    advStatus.className = 'adv-status'; advStatus.textContent = '';
    try {
      const patch = {};
      const trimmedUrl = urlInput.value.trim();
      // Пустой URL → значит юзер хочет вернуть auto (resetOverride эффективно).
      patch.baseUrl = trimmedUrl;
      if (pwInput.value) patch.password = pwInput.value;
      await send({ cmd: 'saveAccountConfig', accountId: account.id, ...patch });
      advStatus.classList.add('ok');
      advStatus.textContent = t('options_saved_ok');
      pwInput.value = '';
      await loadAll();
      renderAccounts();
    } catch (e) {
      advStatus.classList.add('err');
      advStatus.textContent = errorText(e);
    }
  });

  resetBtn.addEventListener('click', async () => {
    advStatus.className = 'adv-status'; advStatus.textContent = '';
    try {
      await send({ cmd: 'resetAccountOverride', accountId: account.id });
      advStatus.classList.add('ok');
      advStatus.textContent = t('options_saved_ok');
      await loadAll();
      renderAccounts();
    } catch (e) {
      advStatus.classList.add('err');
      advStatus.textContent = errorText(e);
    }
  });

  advWrap.append(el('div', { class: 'adv-actions' }, resetBtn, saveBtn));
  advWrap.append(advStatus);
}

function renderAbout() {
  const ver = browser.runtime.getManifest?.()?.version || '?';
  document.getElementById('aboutVersion').textContent = ver;
}

// ────────────────────────────────────────────────────────────────────────────
// Behavior section (wizard/editor preferences)
// ────────────────────────────────────────────────────────────────────────────
async function loadBehaviorPrefs() {
  try {
    const prefs = await send({ cmd: 'getWizardPrefs' });
    return prefs || {};
  } catch {
    return {};
  }
}

function applyBehaviorPrefsToUI(prefs) {
  const stripChk = document.getElementById('behStripPrefixes');
  const subjectIn = document.getElementById('behSubjectPrefixes');
  const hideChk = document.getElementById('behHideSystemFolders');
  const excludeChk = document.getElementById('behExcludeOwn');
  const radios = document.querySelectorAll('input[name="behNewPosition"]');
  if (!stripChk) return;

  stripChk.checked = prefs.stripSubjectPrefixes !== false;
  subjectIn.value = Array.isArray(prefs.subjectPrefixes)
    ? prefs.subjectPrefixes.join(', ')
    : '';
  hideChk.checked = prefs.hideSystemFolders !== false;
  excludeChk.checked = prefs.excludeOwnAddresses !== false;
  const pos = prefs.newRulePosition === 'top' ? 'top' : 'end';
  for (const r of radios) r.checked = (r.value === pos);
}

function readBehaviorFromUI() {
  const stripChk = document.getElementById('behStripPrefixes');
  const subjectIn = document.getElementById('behSubjectPrefixes');
  const hideChk = document.getElementById('behHideSystemFolders');
  const excludeChk = document.getElementById('behExcludeOwn');
  const radios = document.querySelectorAll('input[name="behNewPosition"]');
  let pos = 'end';
  for (const r of radios) if (r.checked) pos = r.value;
  const prefixes = String(subjectIn.value || '')
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    stripSubjectPrefixes: !!stripChk.checked,
    subjectPrefixes: prefixes,
    hideSystemFolders: !!hideChk.checked,
    excludeOwnAddresses: !!excludeChk.checked,
    newRulePosition: pos === 'top' ? 'top' : 'end',
  };
}

async function bindBehaviorSection() {
  const prefs = await loadBehaviorPrefs();
  applyBehaviorPrefsToUI(prefs);

  const saveBtn = document.getElementById('behSaveBtn');
  const toast = document.getElementById('behToast');
  if (!saveBtn) return;
  saveBtn.addEventListener('click', async () => {
    const patch = readBehaviorFromUI();
    saveBtn.disabled = true;
    toast.hidden = true;
    toast.classList.remove('err');
    try {
      const next = await send({ cmd: 'saveWizardPrefs', patch });
      // Перерендер UI с финальным (нормализованным) состоянием — например,
      // если юзер ввёл "Re:, , Fwd:" — вернётся ["Re:", "Fwd:"].
      applyBehaviorPrefsToUI(next || {});
      toast.textContent = t('options_saved_ok') || 'Сохранено.';
      toast.hidden = false;
      // Auto-hide через 2.5 сек.
      setTimeout(() => { if (toast) toast.hidden = true; }, 2500);
    } catch (e) {
      toast.classList.add('err');
      toast.textContent = errorText(e);
      toast.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });
}

async function init() {
  applyI18n();
  renderAbout();
  await loadAll();
  renderAccounts();
  await bindBehaviorSection();
}

init().catch((e) => {
  console.error('[options]', e);
});
