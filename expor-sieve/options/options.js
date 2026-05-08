// SPDX-License-Identifier: GPL-3.0-or-later
// options.js — read-only status-страница плагина (auto-derive everything).
//
// Концепция:
//   - Каждый IMAP/POP3-аккаунт рендерится карточкой со статусом одной строкой.
//   - baseUrl автоматически выводится из IMAP-host'а аккаунта (Experiment API
//     getServerInfo) → `https://${hostname}/sieve-proxy`.
//   - Пароль ВСЕГДА берётся из Login Manager TB через Experiment API
//     (browser.exporSieveCredentials.getImapPassword). Никаких полей ввода
//     пароля в UI плагина нет — пользователь сохраняет пароль в стандартном
//     диалоге Account Settings TB, плагин его читает оттуда live на каждый
//     запрос.
//   - Юзер вводит что-либо ТОЛЬКО когда нужен per-account override URL
//     (нестандартный middleware-host) — раскрывая «▶ Дополнительно».
//
// Состояния карточки (v0.15.0+):
//   OK    — есть baseUrl AND password успешно прочитан из TB Login Manager.
//   Err   — нет baseUrl ИЛИ TB Login Manager не отдал пароль (master
//           password залочен / пароль не сохранён в TB / Experiment API
//           недоступен).

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
    if (Number(legacy.schema_version) !== 3 && legacy.mailbox) {
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
  // OK   — baseUrl задан И TB Login Manager отдал пароль.
  // ERR  — baseUrl=none ИЛИ TB Login Manager не отдал пароль.
  if (!st.baseUrl) return 'err';
  if (st.passwordSource === 'experiment') return 'ok';
  return 'err';
}

function badgeFor(level) {
  if (level === 'ok')  return el('span', { class: 'acc-badge ok'   }, '✓ ', t('options_status_ok'));
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
      // Перерендер: на случай если что-то на стороне TB поменялось,
      // освежаем passwordSource/baseUrlSource.
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

  // Кнопки в actions.
  const actions = el('div', { class: 'acc-actions' });
  actions.append(advToggle, testBtn);
  // Кнопка импорта фильтров — показываем только при OK (когда есть конфиг
  // подключения к middleware; иначе импортировать некуда).
  if (level === 'ok' && !importLocalBtn.hidden) {
    actions.append(importLocalBtn);
  }
  actions.append(testStatus);
  card.append(actions);

  // Если статус ERR из-за отсутствия пароля — показываем явную инструкцию,
  // что делать. baseUrl ошибки рулятся через advanced/override.
  if (level === 'err' && st.baseUrl && st.passwordSource === 'none') {
    const apiOk = isExperimentAvailable();
    const hint = el('div', { class: 'acc-hint err-hint' },
      apiOk
        ? (t('options_pwd_tb_unavailable_long')
           || 'Откройте Account Settings Thunderbird → Server Settings, введите пароль и поставьте «Remember password». Если у вас задан мастер-пароль TB, разблокируйте его.')
        : (t('options_pwd_experiment_unavailable')
           || 'Эта версия Thunderbird не поддерживает чтение пароля из настроек (нет Experiment API). Обновите Thunderbird или используйте сборку с поддержкой Experiment API.')
    );
    card.append(hint);
  }

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

  // Подсказка про пароль — пароль больше не вводится здесь.
  advWrap.append(el('div', { class: 'acc-hint' },
    t('options_pwd_managed_by_tb')
      || 'Пароль читается напрямую из настроек Thunderbird (Account Settings → Server Settings). В плагине пароль не сохраняется.'));

  // Actions: save / reset / status. Сохраняется только URL override.
  const advStatus = el('div', { class: 'adv-status' });
  const saveBtn = el('button', { type: 'button', class: 'primary' },
    t('options_save_override'));
  const resetBtn = el('button', { type: 'button' },
    t('options_reset_override'));

  saveBtn.addEventListener('click', async () => {
    advStatus.className = 'adv-status'; advStatus.textContent = '';
    try {
      const trimmedUrl = urlInput.value.trim();
      // Пустой URL → значит юзер хочет вернуть auto (resetOverride эффективно).
      await send({ cmd: 'saveAccountConfig', accountId: account.id, baseUrl: trimmedUrl });
      advStatus.classList.add('ok');
      advStatus.textContent = t('options_saved_ok');
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

// ── Уведомления о подпапках ──────────────────────────────────────────
// Два уровня контроля (Этап 1 и Этап 2):
//   * Per-server `mail.server.<key>.check_all_folders_for_new` — общий
//     toggle «проверять все подпапки этого аккаунта». При on перекрывает
//     пер-папочные настройки: TB всё равно ходит STATUS по всем папкам.
//   * Per-folder `nsMsgFolderFlags.CheckNew` — точечный контроль для
//     отдельных папок (включая Junk). Имеет смысл когда per-server toggle
//     выключен; иначе индивидуальные галки disabled.

const i18n = (k, fallback) => browser.i18n.getMessage(k) || fallback;

async function renderNotifySection() {
  const list = document.getElementById('notifyList');
  if (!list) return;
  list.replaceChildren();

  if (!isExperimentAvailable()) {
    const sec = document.getElementById('section-notify');
    if (sec) sec.hidden = true;
    return;
  }

  const imapAccounts = (state.accounts || []).filter(a => a.type === 'imap' || !a.type);
  if (imapAccounts.length === 0) {
    list.append(el('p', { class: 'section-hint' },
      i18n('options_notify_no_accounts', 'Нет IMAP-аккаунтов.')));
    return;
  }

  for (const a of imapAccounts) {
    list.append(await renderAccountNotifyBlock(a));
  }
}

async function renderAccountNotifyBlock(account) {
  const block = el('div', { class: 'notify-block' });

  // Per-server toggle row.
  const headerRow = el('label', { class: 'notify-row' });
  const headerCb = el('input', { type: 'checkbox' });
  headerCb.disabled = true;
  const headerLabel = el('span', { class: 'notify-label' },
    account.email || account.name || account.id);
  const headerStatus = el('span', { class: 'notify-status' });
  headerRow.append(headerCb, headerLabel, headerStatus);
  block.append(headerRow);

  // Per-folder details (initially collapsed).
  const details = el('details', { class: 'notify-details' });
  const summary = el('summary', { class: 'notify-summary' },
    i18n('options_notify_per_folder_summary', 'Настроить отдельные папки'));
  details.append(summary);
  const inner = el('div', { class: 'notify-inner' });
  details.append(inner);
  block.append(details);

  // Загружаем per-server pref.
  let serverState;
  try {
    serverState = await send({ cmd: 'getCheckAllFolders', accountId: account.id });
  } catch (_e) { serverState = { supported: false, enabled: null }; }

  if (!serverState || !serverState.supported) {
    headerCb.disabled = true;
    headerStatus.textContent = i18n('options_notify_unsupported',
      '(не поддерживается этим аккаунтом)');
    details.hidden = true;
    return block;
  }

  headerCb.checked = !!serverState.enabled;
  headerCb.disabled = false;

  // Lazy-render per-folder list только когда юзер раскрыл details.
  let foldersLoaded = false;
  const ensureFoldersLoaded = async () => {
    if (foldersLoaded) return;
    foldersLoaded = true;
    inner.replaceChildren(el('p', { class: 'section-hint' },
      i18n('options_notify_loading', 'Загрузка списка папок…')));
    let folders = [];
    try {
      folders = await send({ cmd: 'listCheckNewFolders', accountId: account.id }) || [];
    } catch (_e) { folders = []; }
    renderFolderList(inner, account.id, folders, () => headerCb.checked);
  };
  details.addEventListener('toggle', () => {
    if (details.open) ensureFoldersLoaded();
  });

  // Headerstoggle меняет server-pref.
  headerCb.addEventListener('change', async () => {
    const wanted = headerCb.checked;
    headerCb.disabled = true;
    headerStatus.textContent = '…';
    try {
      const r = await send({ cmd: 'setCheckAllFolders', accountId: account.id, enabled: wanted });
      if (r && r.error) {
        headerCb.checked = !wanted;
        headerStatus.classList.add('err');
        headerStatus.textContent = errorText(r.error);
        return;
      }
      if (r && typeof r.enabled === 'boolean') headerCb.checked = r.enabled;
      headerStatus.classList.remove('err');
      headerStatus.textContent = i18n('options_notify_saved', '✓');
      setTimeout(() => { headerStatus.textContent = ''; }, 2000);
      // При смене per-server toggle нужно пересчитать disabled-state у
      // per-folder чекбоксов.
      if (foldersLoaded) {
        for (const cb of inner.querySelectorAll('input[type=checkbox][data-folder-path]')) {
          cb.disabled = headerCb.checked;
        }
      }
    } finally {
      headerCb.disabled = false;
    }
  });

  return block;
}

function renderFolderList(host, accountId, folders, isServerToggleOn) {
  host.replaceChildren();
  if (!folders.length) {
    host.append(el('p', { class: 'section-hint' },
      i18n('options_notify_no_folders', 'Папок не найдено.')));
    return;
  }

  // Хедер: счётчик отмеченных + bulk-кнопки + bulk-toast рядом.
  const counter = el('span', { class: 'notify-counter' });
  const updateCounter = () => {
    const n = ul.querySelectorAll('input[type=checkbox]:checked').length;
    const tmpl = i18n('options_notify_counter', 'Отмечено {0} из {1}');
    counter.textContent = tmpl.replace('{0}', String(n)).replace('{1}', String(folders.length));
  };

  const tools = el('div', { class: 'notify-tools' });
  const btnAll = el('button', { type: 'button', class: 'notify-bulk-btn' },
    i18n('options_notify_btn_all', 'Все'));
  const btnInboxJunk = el('button', { type: 'button', class: 'notify-bulk-btn' },
    i18n('options_notify_btn_inbox_junk', 'Только Inbox + Junk'));
  const btnNone = el('button', { type: 'button', class: 'notify-bulk-btn' },
    i18n('options_notify_btn_none', 'Сбросить'));
  const bulkToast = el('span', { class: 'notify-bulk-toast' });

  const header = el('div', { class: 'notify-header' });
  header.append(counter, tools, bulkToast);
  tools.append(btnAll, btnInboxJunk, btnNone);
  host.append(header);

  if (isServerToggleOn()) {
    host.append(el('p', { class: 'section-hint notify-overridden' },
      i18n('options_notify_server_overrides',
        'Включён общий тоггл выше — TB опрашивает все подпапки. Индивидуальные галки сейчас не влияют.')));
  }

  // Список папок. Каждая строка — <label>, чтобы клик в любое место строки
  // (имя, бейджи) переключал чекбокс, как в нативных диалогах.
  const ul = el('ul', { class: 'notify-folders' });
  for (const f of folders) {
    const row = el('label', { class: 'notify-folder-row', tabindex: '0' });
    const cb = el('input', { type: 'checkbox', 'data-folder-path': f.path });
    cb.checked = !!f.checkNew;
    cb.disabled = isServerToggleOn();
    const name = el('span', { class: 'notify-folder-name' }, f.name || f.path);
    const badges = el('span', { class: 'notify-badges' });
    if (f.isInbox) {
      badges.append(el('span', { class: 'notify-badge inbox' },
        i18n('options_notify_badge_inbox', 'Входящие')));
    }
    if ((f.specialUse || []).includes('junk')) {
      badges.append(el('span', { class: 'notify-badge junk' },
        i18n('options_notify_badge_junk', 'Спам')));
    }
    if (f.isSubscribed === false) {
      badges.append(el('span', { class: 'notify-badge warn', title:
        i18n('options_notify_unsubscribed_hint',
          'Папка не подписана — TB её не опрашивает. Подпишите через Edit → Subscribe.')
      }, i18n('options_notify_badge_unsubscribed', 'не подписана')));
    }
    const status = el('span', { class: 'notify-status' });

    // Один общий handler — используется и при ручном клике, и при bulk.
    // bulkInProgress=true выключает индивидуальные toast'ы и анимацию,
    // чтобы после массовой операции не было каскада «✓ ✓ ✓ …».
    let pending = null;
    const persist = async (wanted, { bulkInProgress = false } = {}) => {
      if (pending) await pending;
      pending = (async () => {
        if (!bulkInProgress) status.textContent = '…';
        try {
          const r = await send({
            cmd: 'setFolderCheckNew',
            accountId,
            path: f.path,
            enabled: wanted,
          });
          if (r && r.error) {
            cb.checked = !wanted;
            if (!bulkInProgress) {
              status.classList.add('err');
              status.textContent = errorText(r.error);
            }
            return { ok: false };
          }
          if (r && typeof r.enabled === 'boolean') cb.checked = r.enabled;
          if (!bulkInProgress) {
            status.classList.remove('err');
            status.classList.add('saved');
            status.textContent = '✓';
            setTimeout(() => {
              status.classList.remove('saved');
              status.textContent = '';
            }, 1200);
          }
          return { ok: true };
        } finally {
          updateCounter();
        }
      })();
      const r = await pending; pending = null; return r;
    };

    cb.addEventListener('change', () => {
      // Юзер сам кликнул чекбокс — нормальный путь с toast.
      persist(cb.checked);
    });
    // Enter / Space на label для keyboard-friendly режима.
    row.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (cb.disabled) return;
        cb.checked = !cb.checked;
        persist(cb.checked);
      }
    });

    row.append(cb, name, badges, status);
    row._persist = persist;
    row._folder = f;
    ul.append(row);
  }
  host.append(ul);
  updateCounter();

  // Bulk-операции — последовательно, чтобы Pigeonhole / Services.prefs не
  // получили N запросов одновременно. Кнопки disabled на время работы,
  // показываем краткий toast «Отмечено N» / «Сброшено» рядом.
  const showBulkToast = (changed, mode) => {
    bulkToast.classList.remove('saved'); // re-trigger animation
    void bulkToast.offsetWidth;
    let msg;
    if (changed === 0) {
      msg = i18n('options_notify_bulk_nochange', 'Уже применено');
    } else if (mode === 'clear') {
      msg = (i18n('options_notify_bulk_cleared', 'Сброшено: {0}') || 'Сброшено: {0}')
        .replace('{0}', String(changed));
    } else {
      msg = (i18n('options_notify_bulk_set', 'Отмечено: {0}') || 'Отмечено: {0}')
        .replace('{0}', String(changed));
    }
    bulkToast.textContent = msg;
    bulkToast.classList.add('saved');
    setTimeout(() => {
      bulkToast.classList.remove('saved');
      bulkToast.textContent = '';
    }, 2200);
  };

  const bulkApply = async (predicate, mode) => {
    if (isServerToggleOn()) return;
    btnAll.disabled = btnInboxJunk.disabled = btnNone.disabled = true;
    bulkToast.textContent = i18n('options_notify_bulk_applying', 'Применяю…');
    bulkToast.classList.add('busy');
    try {
      let changed = 0;
      for (const row of ul.children) {
        const cb = row.querySelector('input[type=checkbox]');
        const folder = row._folder;
        const want = predicate(folder);
        if (cb.checked === want) continue;
        cb.checked = want;
        const res = await row._persist(want, { bulkInProgress: true });
        if (res && res.ok) changed++;
      }
      bulkToast.classList.remove('busy');
      showBulkToast(changed, mode);
    } finally {
      btnAll.disabled = btnInboxJunk.disabled = btnNone.disabled = isServerToggleOn();
    }
  };
  btnAll.addEventListener('click', () => bulkApply(() => true, 'set'));
  btnInboxJunk.addEventListener('click', () => bulkApply(f =>
    f.isInbox || (f.specialUse || []).includes('junk'), 'set'));
  btnNone.addEventListener('click', () => bulkApply(() => false, 'clear'));
}

async function init() {
  applyI18n();
  renderAbout();
  await loadAll();
  renderAccounts();
  await bindBehaviorSection();
  await renderNotifySection();
}

init().catch((e) => {
  console.error('[options]', e);
});
