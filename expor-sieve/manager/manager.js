// SPDX-License-Identifier: GPL-3.0-or-later
// manager.js — Filter Manager. Главное окно: список правил, toolbar, sidebar.
// Multi-account (v0.5.0):
//   - dropdown аккаунтов; при N=1 — скрывается;
//   - one-shot active-mailbox detection при bootstrap (getActiveAccountId);
//   - lazy-auth: если для accountId нет пароля, рисуем inline-form вместо
//     списка правил (LazyAuthPanel), после save — retry.
//
// Все взаимодействия с middleware идут через background.js.
// docs: https://webextension-api.thunderbird.net/en/mv3/runtime.html#sendmessage

import { newRule } from '../lib/rule_model.js';
import { t } from '../lib/rule_form.js';
import { openEditor } from '../editor/editor.js';
import { runRuleOnFolder, findFolderByPath } from '../lib/local_runner.js';
import { decodeIMAPUTF7 } from '../lib/imap_utf7.js';
import { DEFAULTS as PREF_DEFAULTS } from '../lib/wizard_prefs.js';

// ────────────────────────────────────────────────────────────────────────────
// i18n / DOM helpers
// ────────────────────────────────────────────────────────────────────────────
function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const v = t(el.dataset.i18n);
    if (v) el.textContent = v;
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const v = t(el.dataset.i18nPlaceholder);
    if (v) el.placeholder = v;
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const v = t(el.dataset.i18nTitle);
    if (v) {
      el.title = v;
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', v);
    }
  }
}

function $(id) { return document.getElementById(id); }
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

// ────────────────────────────────────────────────────────────────────────────
// Background bridge
// ────────────────────────────────────────────────────────────────────────────
async function send(cmd, payload = {}) {
  return await browser.runtime.sendMessage({ cmd, ...payload });
}
function isError(r) { return r && typeof r === 'object' && r.error; }
function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  switch (err.kind) {
    case 'no_config':   return t('err_no_managed_config');
    case 'no_password': return t('err_no_password') || 'Введите пароль для этого ящика.';
    case 'auth':        return t('err_auth_password_wrong');
    case 'network':     return t('err_no_network');
    case 'server':      return t('err_server');
    default:            return err.message || String(err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────────────────────
const state = {
  rules: [],
  filtered: [],
  folders: [],
  accounts: [],          // [{id, name, email, hasConfig, isDefault}]
  selectedAccountId: null,
  selectedRuleId: null,           // backwards-compat: zerкало state.selectedIds для случаев single-select.
  selectedIds: new Set(),         // multi-select; ключи — String(rule.id)
  lastClickedId: null,            // якорь для shift+click range
  searchQuery: '',
  busy: false,
  needsAuth: null,       // { accountId, mailbox } или null
  prefs: { ...PREF_DEFAULTS, subjectPrefixes: PREF_DEFAULTS.subjectPrefixes.slice() },
};

// Куда вставлять новое правило: 'top' (нач. списка) | 'end' (конец).
// Реализуется через draft.order: для top — на единицу меньше минимального
// существующего order'а; combinedSieveToRules при следующей загрузке
// упорядочит правила по этому полю (а writeCombined их пере-нормализует
// в [0..N-1], сохранив relative order).
function nextOrderForNew() {
  const pos = state.prefs.newRulePosition;
  if (pos === 'top') {
    let min = 0;
    for (const r of state.rules) {
      if (typeof r.order === 'number' && r.order < min) min = r.order;
    }
    return min - 1;
  }
  return state.rules.length;
}

// ────────────────────────────────────────────────────────────────────────────
// Screens
// ────────────────────────────────────────────────────────────────────────────
const SCREENS = ['mgrLoading', 'mgrEmpty', 'mgrNoConfig', 'mgrError', 'mgrLazyAuth'];
function showScreen(which) {
  for (const id of SCREENS) {
    const node = $(id);
    if (node) node.hidden = id !== which;
  }
  $('mgrTable').hidden = !!which;
}

// ────────────────────────────────────────────────────────────────────────────
// Account selector rendering
// ────────────────────────────────────────────────────────────────────────────
function renderAccounts() {
  const sel = $('mgrAccount');
  sel.replaceChildren();
  const wrap = $('mgrAccountWrap');

  if (!state.accounts.length) {
    sel.append(el('option', { value: '' }, t('mgr_no_accounts')));
    sel.disabled = true;
    if (wrap) wrap.hidden = false;
    return;
  }
  for (const a of state.accounts) {
    const label = a.email || a.name || a.id;
    sel.append(el('option', { value: a.id }, label));
  }
  if (state.selectedAccountId && state.accounts.some(a => a.id === state.selectedAccountId)) {
    sel.value = state.selectedAccountId;
  } else {
    state.selectedAccountId = sel.value || state.accounts[0].id;
    sel.value = state.selectedAccountId;
  }
  // Скрываем dropdown при N=1.
  if (wrap) wrap.hidden = state.accounts.length <= 1;
  sel.disabled = false;
}

// ────────────────────────────────────────────────────────────────────────────
// Rules list rendering
// ────────────────────────────────────────────────────────────────────────────
function applyFilter() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) {
    state.filtered = state.rules.slice();
  } else {
    state.filtered = state.rules.filter(r =>
      (r.name || '').toLowerCase().includes(q));
  }
}

function renderList() {
  const tbody = $('mgrBody');
  tbody.replaceChildren();
  applyFilter();

  if (state.filtered.length === 0 && state.rules.length === 0) {
    showScreen('mgrEmpty');
    updateCount();
    updateSidebarState();
    return;
  }
  showScreen(null);

  for (const rule of state.filtered) {
    tbody.append(renderRow(rule));
  }
  updateCount();
  updateSidebarState();
}

function renderRow(rule) {
  const sid = String(rule.id);
  const tr = el('tr', {
    class: (state.selectedIds.has(sid) ? 'selected ' : '') + (rule.active ? '' : 'inactive'),
    role: 'row',
    'data-rule-id': rule.id,
    tabindex: '0',
  });
  tr.addEventListener('click', (e) => {
    if (e.target.closest('input[type=checkbox]')) return;
    selectRule(rule.id, e);
  });
  tr.addEventListener('dblclick', (e) => {
    if (e.target.closest('input[type=checkbox]')) return;
    selectRule(rule.id, null);   // dblclick — single-selection mode
    onEdit();
  });
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onEdit(); }
    if (e.key === 'Delete') { e.preventDefault(); onDelete(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  const cb = el('input', { type: 'checkbox', 'aria-label': t('rule_active') });
  cb.checked = !!rule.active;
  cb.addEventListener('change', () => onToggleActive(rule, cb));
  tr.append(el('td', { class: 'col-toggle' }, cb));

  tr.append(el('td', { class: 'col-name name-cell', title: rule.name }, rule.name || '—'));
  tr.append(el('td', { class: 'col-active' }, rule.active ? '✓' : '—'));

  return tr;
}

// Multi-select: plain click → одна строка; Ctrl/Cmd+click → toggle в наборе;
// Shift+click → range от lastClickedId до id.
function selectRule(id, event) {
  const sid = String(id);
  const ctrl = !!(event && (event.ctrlKey || event.metaKey));
  const shift = !!(event && event.shiftKey);

  if (shift && state.lastClickedId != null) {
    const ids = state.filtered.map((r) => String(r.id));
    const a = ids.indexOf(String(state.lastClickedId));
    const b = ids.indexOf(sid);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      state.selectedIds = new Set(ids.slice(lo, hi + 1));
    } else {
      state.selectedIds = new Set([sid]);
    }
  } else if (ctrl) {
    if (state.selectedIds.has(sid)) state.selectedIds.delete(sid);
    else state.selectedIds.add(sid);
    state.lastClickedId = sid;
  } else {
    state.selectedIds = new Set([sid]);
    state.lastClickedId = sid;
  }

  // Совместимость со старым полем (single-select pivot).
  state.selectedRuleId = state.selectedIds.size === 1 ? [...state.selectedIds][0] : null;

  for (const tr of $('mgrBody').children) {
    tr.classList.toggle('selected', state.selectedIds.has(tr.dataset.ruleId));
  }
  updateSidebarState();
  updateSelectionStatus();
}

function selectedRules() {
  return state.rules.filter((r) => state.selectedIds.has(String(r.id)));
}

function updateSelectionStatus() {
  const n = state.selectedIds.size;
  const el = $('mgrSelectionStatus');
  if (!el) return;
  if (n <= 1) { el.textContent = ''; return; }
  el.textContent = `Выбрано: ${n}`;
}

function moveSelection(dir) {
  if (!state.filtered.length) return;
  const idx = state.filtered.findIndex(r => state.selectedIds.has(String(r.id)));
  let next = idx + dir;
  if (idx === -1) next = 0;
  if (next < 0) next = 0;
  if (next >= state.filtered.length) next = state.filtered.length - 1;
  selectRule(state.filtered[next].id, null);
  const row = $('mgrBody').querySelector(`tr[data-rule-id="${CSS.escape(state.filtered[next].id)}"]`);
  row && row.focus();
}

function updateCount() {
  const total = state.rules.length;
  const word = pluralRu(total, ['фильтр', 'фильтра', 'фильтров']);
  $('mgrCount').textContent = `${total} ${word}`;
}

function pluralRu(n, [one, few, many]) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function selectedRule() {
  // Single-rule helper: возвращает Rule только если выделено ровно одно.
  if (state.selectedIds.size !== 1) return null;
  const id = [...state.selectedIds][0];
  return state.rules.find(r => String(r.id) === id) || null;
}

function selectedIndexInRules() {
  const r = selectedRule();
  return r ? state.rules.findIndex(x => x.id === r.id) : -1;
}

function updateSidebarState() {
  const single = !!selectedRule();
  const anySel = state.selectedIds.size >= 1;
  const idx = selectedIndexInRules();
  const last = state.rules.length - 1;
  const blocked = state.busy || !!state.needsAuth;

  // Edit/Duplicate/Move работают только при single-selection.
  $('tbEdit').disabled       = !single || blocked;
  $('tbDuplicate').disabled  = !single || blocked;
  $('sideEdit').disabled     = !single || blocked;
  $('sideTop').disabled      = !single || idx <= 0 || blocked;
  $('sideUp').disabled       = !single || idx <= 0 || blocked;
  $('sideDown').disabled     = !single || idx < 0 || idx >= last || blocked;
  $('sideBottom').disabled   = !single || idx < 0 || idx >= last || blocked;

  // Удаление работает на любом числе выделенных правил.
  $('tbDelete').disabled     = !anySel || blocked;
  $('sideDelete').disabled   = !anySel || blocked;

  $('tbReload').disabled     = state.busy;
  $('sideNew').disabled      = blocked;
  $('tbNew').disabled        = blocked;
  const tbImport = $('tbImportLocal');
  if (tbImport && !tbImport.hidden) tbImport.disabled = blocked;
  updateRunbarState();
}

// ────────────────────────────────────────────────────────────────────────────
// Run-on-folder bar
// ────────────────────────────────────────────────────────────────────────────
function renderRunFolders() {
  const sel = $('runFolder');
  if (!sel) return;
  const prevValue = sel.value;
  sel.replaceChildren();
  const opt0 = el('option', { value: '' }, t('mgr_run_pick_folder'));
  sel.append(opt0);
  for (const f of (state.folders || [])) {
    const display = decodeIMAPUTF7(f.path || f.name || '') || '—';
    sel.append(el('option', { value: f.path }, display));
  }
  // Сохраняем предыдущий выбор, если папка ещё в списке.
  if (prevValue && (state.folders || []).some(f => f.path === prevValue)) {
    sel.value = prevValue;
  } else {
    sel.value = '';
  }
}

function updateRunbarState() {
  const btn = $('runRule');
  const sel = $('runFolder');
  if (!btn || !sel) return;
  const blocked = state.busy || !!state.needsAuth;
  btn.disabled = blocked || !selectedRule() || !sel.value;
}

async function onRunClick() {
  const rule = selectedRule();
  const folderPath = $('runFolder').value;
  if (!rule) { alert(t('run_no_selection') || 'Сначала выберите правило в списке.'); return; }
  if (!folderPath) { alert(t('run_no_folder') || 'Выберите папку.'); return; }

  // Резолвим folderId из state.folders (заполнено через listFolders, тот
  // возвращает {id, name, path}). Не идём в background — вся операция
  // локальная (нет нужды в proxy_client/middleware).
  const target = findFolderByPath(state.folders, folderPath);
  if (!target || !target.id) {
    alert(`Папка не найдена: ${folderPath}`);
    return;
  }

  await openRunDialog(rule, target);
}

async function openRunDialog(rule, target) {
  const dlg = $('runDialog');
  const titleEl = $('runTitle');
  const progEl = $('runProg');
  const statusEl = $('runStatus');
  const summaryEl = $('runSummary');
  const warnEl = $('runWarn');
  const cancelBtn = $('runCancel');
  const closeBtn = $('runClose');

  titleEl.textContent = t('run_title') || 'Применение правила…';
  progEl.value = 0;
  progEl.removeAttribute('value'); // indeterminate сначала
  statusEl.textContent = t('run_status_init') || 'Готовлю…';
  summaryEl.hidden = true;
  summaryEl.textContent = '';
  warnEl.hidden = true;
  warnEl.textContent = '';
  closeBtn.hidden = true;
  cancelBtn.hidden = false;
  cancelBtn.disabled = false;

  const ctrl = new AbortController();
  cancelBtn.onclick = () => { ctrl.abort(); cancelBtn.disabled = true; };
  closeBtn.onclick = () => dlg.close('ok');

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');

  const onProgress = (sum) => {
    if (sum.total != null && sum.total > 0) {
      progEl.max = sum.total;
      progEl.value = sum.processed;
      statusEl.textContent = t('run_status_progress',
        [String(sum.processed), String(sum.total), String(sum.matched)])
        || `Обработано ${sum.processed} из ${sum.total}, изменено ${sum.matched}`;
    } else {
      progEl.removeAttribute('value');
      statusEl.textContent = t('run_status_progress_unknown',
        [String(sum.processed), String(sum.matched)])
        || `Обработано ${sum.processed}, изменено ${sum.matched}`;
    }
  };

  let summary;
  try {
    summary = await runRuleOnFolder(rule, target.id, {
      folders: state.folders,
      signal: ctrl.signal,
      onProgress,
    });
  } catch (e) {
    summary = {
      processed: 0, total: 0, matched: 0, applied: 0,
      errors: [String(e && e.message || e)], skipped: [], aborted: false,
    };
  }

  // Финал
  if (summary.total != null && summary.total > 0) {
    progEl.max = summary.total;
    progEl.value = summary.processed;
  } else if (summary.processed > 0) {
    progEl.max = summary.processed;
    progEl.value = summary.processed;
  } else {
    progEl.max = 1;
    progEl.value = 1;
  }

  let statusText;
  if (summary.aborted) {
    statusText = t('run_canceled') || 'Прервано пользователем.';
  } else if (summary.processed === 0) {
    statusText = t('run_no_messages') || 'В папке нет писем для обработки.';
  } else if (summary.matched === 0) {
    statusText = t('run_no_match') || 'Ни одно письмо не подошло под условия.';
  } else {
    statusText = t('run_done') || 'Готово.';
  }
  statusEl.textContent = statusText;

  summaryEl.textContent = t('run_summary',
    [String(summary.processed), String(summary.matched), String(summary.applied)])
    || `Готово. Обработано: ${summary.processed}. Совпало: ${summary.matched}. Изменено: ${summary.applied}.`;
  summaryEl.hidden = false;

  const warnings = [];
  if (summary.skipped && summary.skipped.includes('redirect')) {
    warnings.push(t('run_skipped_redirect')
      || 'Действие «перенаправить» не выполнено: оно работает только при доставке (на сервере).');
  }
  if (summary.errors && summary.errors.length) {
    const filtered = summary.errors.filter(e => e !== 'aborted');
    if (filtered.length) {
      warnings.push(t('run_errors', [String(filtered.length)]) || `Ошибки: ${filtered.length}.`);
    }
  }
  if (warnings.length) {
    warnEl.textContent = warnings.join(' ');
    warnEl.hidden = false;
  }

  cancelBtn.hidden = true;
  closeBtn.hidden = false;
  closeBtn.focus();
}

// ────────────────────────────────────────────────────────────────────────────
// Lazy-auth panel
// ────────────────────────────────────────────────────────────────────────────
function renderLazyAuth({ accountId, mailbox }) {
  state.needsAuth = { accountId, mailbox };
  const panel = $('mgrLazyAuth');
  panel.replaceChildren();
  panel.append(
    el('h3', {}, t('mgr_lazy_auth_title') || 'Введите пароль'),
    el('p', { class: 'lazy-auth-info' },
      (t('mgr_lazy_auth_info') || 'Для ящика {0} ещё не задан пароль.')
        .replace('{0}', mailbox)),
  );
  const pwInput = el('input', {
    type: 'password',
    autocomplete: 'current-password',
    placeholder: t('options_field_password_placeholder'),
    'aria-label': t('options_field_password'),
  });
  const errorBox = el('p', { class: 'lazy-auth-error', hidden: true });
  const saveBtn = el('button', { type: 'button', class: 'primary' },
    t('options_save_config'));
  const cancelBtn = el('button', { type: 'button' }, t('btn_cancel'));

  saveBtn.addEventListener('click', async () => {
    const pw = pwInput.value;
    if (!pw) {
      errorBox.hidden = false;
      errorBox.textContent = t('err_password_required') || 'Пароль обязателен.';
      return;
    }
    saveBtn.disabled = true; cancelBtn.disabled = true;
    const r = await send('saveAccountConfig', { accountId, password: pw });
    saveBtn.disabled = false; cancelBtn.disabled = false;
    if (isError(r)) {
      errorBox.hidden = false;
      errorBox.textContent = errorText(r.error);
      return;
    }
    state.needsAuth = null;
    await reloadAll();
  });
  cancelBtn.addEventListener('click', () => {
    // Откатываем dropdown на другой аккаунт, если возможно.
    const other = state.accounts.find(a => a.id !== accountId && a.hasConfig);
    if (other) {
      state.selectedAccountId = other.id;
      $('mgrAccount').value = other.id;
      reloadAll();
    } else {
      window.close();
    }
  });

  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
  });

  const form = el('div', { class: 'lazy-auth-form' },
    el('label', {}, t('options_field_mailbox')),
    el('div', { class: 'lazy-auth-mailbox' }, mailbox),
    el('label', {}, t('options_field_password')),
    pwInput,
    errorBox,
    el('div', { class: 'lazy-auth-actions' }, saveBtn, cancelBtn),
  );
  panel.append(form);

  showScreen('mgrLazyAuth');
  updateSidebarState();
  setTimeout(() => pwInput.focus(), 50);
}

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────────────────
async function bootstrap() {
  showScreen('mgrLoading');

  // 0. Поведенческие preferences (best-effort; при ошибке остаются дефолты).
  try {
    const prefs = await send('getWizardPrefs');
    if (prefs && !isError(prefs)) state.prefs = prefs;
  } catch {}

  // 1. Аккаунты.
  const accRes = await send('listAccounts');
  state.accounts = isError(accRes) ? [] : (accRes || []);

  if (state.accounts.length === 0) {
    return showError(t('mgr_no_imap_accounts')
      || 'Нет IMAP/POP3-аккаунтов в Thunderbird.');
  }

  // 2. Active-mailbox detection (one-shot).
  let activeId = null;
  if (state.accounts.length > 1) {
    const r = await send('getActiveAccountId');
    activeId = (typeof r === 'string') ? r : null;
  }
  state.selectedAccountId = (activeId && state.accounts.some(a => a.id === activeId))
    ? activeId
    : state.accounts[0].id;

  renderAccounts();

  // 3. Грузим правила/папки.
  await reloadAll();
}

function showError(text) {
  $('mgrErrorText').textContent = text;
  showScreen('mgrError');
}

async function reloadAll() {
  state.busy = true;
  state.needsAuth = null;
  updateSidebarState();
  showScreen('mgrLoading');
  try {
    const accountId = state.selectedAccountId;
    const [foldersRes, rulesRes] = await Promise.all([
      send('listFolders', { accountId }),
      send('listRules',   { accountId }),
    ]);

    if (isError(rulesRes)) {
      const err = rulesRes.error;
      if (err.kind === 'no_password') {
        state.folders = isError(foldersRes) ? [] : (foldersRes || []);
        renderLazyAuth({ accountId: err.accountId, mailbox: err.mailbox });
        return;
      }
      showError(errorText(err));
      return;
    }

    state.folders = isError(foldersRes) ? [] : (foldersRes || []);
    state.rules = (rulesRes || []).slice();
    state.rules.sort((a, b) => (a.order || 0) - (b.order || 0));
    if (state.rules.length && state.selectedIds.size === 0) {
      const firstId = String(state.rules[0].id);
      state.selectedIds = new Set([firstId]);
      state.selectedRuleId = state.rules[0].id;
      state.lastClickedId = firstId;
    }
    renderRunFolders();
    renderList();
  } finally {
    state.busy = false;
    updateSidebarState();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Toggle active (optimistic)
// ────────────────────────────────────────────────────────────────────────────
async function onToggleActive(rule, cb) {
  const wanted = cb.checked;
  cb.disabled = true;
  rule.active = wanted;
  const row = $('mgrBody').querySelector(`tr[data-rule-id="${CSS.escape(rule.id)}"]`);
  if (row) {
    row.classList.toggle('inactive', !wanted);
    const cell = row.querySelector('td.col-active');
    if (cell) cell.textContent = wanted ? '✓' : '—';
  }
  if (!rule.mailcowId) { cb.disabled = false; return; }
  const res = await send('setRuleActive', {
    accountId: state.selectedAccountId,
    mailcowId: rule.mailcowId,
    active: wanted,
  });
  cb.disabled = false;
  if (isError(res)) {
    rule.active = !wanted;
    cb.checked = !wanted;
    if (row) {
      row.classList.toggle('inactive', !rule.active);
      const cell = row.querySelector('td.col-active');
      if (cell) cell.textContent = rule.active ? '✓' : '—';
    }
    if (res.error.kind === 'no_password') {
      renderLazyAuth({ accountId: res.error.accountId, mailbox: res.error.mailbox });
    } else {
      alert(errorText(res.error));
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────────────────────
function currentEmail() {
  const acc = state.accounts.find(a => a.id === state.selectedAccountId);
  return acc?.email || '';
}

async function onNew(presetTemplate) {
  const draft = newRule();
  draft.order = nextOrderForNew();
  if (presetTemplate && typeof presetTemplate.apply === 'function') {
    presetTemplate.apply(draft, null, state.folders);
  }
  await openEditorFor(draft, /*isNew*/ true);
}

async function onEdit() {
  const r = selectedRule();
  if (!r) return;
  const copy = JSON.parse(JSON.stringify(r));
  await openEditorFor(copy, /*isNew*/ false);
}

async function onDuplicate() {
  const r = selectedRule();
  if (!r) return;
  const copy = JSON.parse(JSON.stringify(r));
  delete copy.mailcowId;
  copy.id = crypto.randomUUID();
  copy.name = `${r.name} ${t('mgr_copy_suffix') || '(копия)'}`;
  copy.order = nextOrderForNew();
  state.busy = true;
  updateSidebarState();
  const res = await send('saveRule', { accountId: state.selectedAccountId, rule: copy });
  state.busy = false;
  if (isError(res)) {
    if (res.error.kind === 'no_password') {
      renderLazyAuth({ accountId: res.error.accountId, mailbox: res.error.mailbox });
    } else {
      alert(errorText(res.error));
    }
    updateSidebarState();
    return;
  }
  state.rules.push(res);
  state.selectedIds = new Set([String(res.id)]);
  state.selectedRuleId = res.id;
  state.lastClickedId = String(res.id);
  renderList();
  updateSelectionStatus();
}

async function onDelete() {
  const targets = selectedRules();
  if (!targets.length) return;

  const promptText = targets.length === 1
    ? t('mgr_confirm_delete', [targets[0].name || '—'])
    : t('mgr_confirm_delete_many', [String(targets.length)]);
  $('confirmText').textContent = promptText;

  const dlg = $('confirmDialog');
  dlg.returnValue = '';
  const onOk = async () => {
    dlg.close('ok');
    state.busy = true; updateSidebarState();
    try {
      // Удаляем последовательно: per-account-mutex в background и так
      // сериализует одновременные мутации; явная последовательность
      // помогает корректно посчитать ошибки.
      for (const r of targets) {
        if (!r.mailcowId) {
          state.rules = state.rules.filter(x => x.id !== r.id);
          continue;
        }
        const res = await send('deleteRule', {
          accountId: state.selectedAccountId,
          mailcowId: r.mailcowId,
        });
        if (isError(res)) {
          if (res.error.kind === 'no_password') {
            renderLazyAuth({ accountId: res.error.accountId, mailbox: res.error.mailbox });
            return;
          }
          alert(errorText(res.error));
          return;
        }
        state.rules = state.rules.filter(x => x.id !== r.id);
      }
      state.selectedIds = new Set(state.rules[0] ? [String(state.rules[0].id)] : []);
      state.selectedRuleId = state.rules[0]?.id || null;
      renderList();
      updateSelectionStatus();
    } finally {
      state.busy = false;
      updateSidebarState();
    }
  };
  $('confirmOk').onclick = onOk;
  $('confirmCancel').onclick = () => dlg.close('cancel');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

async function moveRule(direction) {
  const idx = selectedIndexInRules();
  if (idx < 0) return;
  let to = idx;
  switch (direction) {
    case 'top':    to = 0; break;
    case 'bottom': to = state.rules.length - 1; break;
    case 'up':     to = idx - 1; break;
    case 'down':   to = idx + 1; break;
  }
  if (to < 0 || to >= state.rules.length || to === idx) return;
  const arr = state.rules.slice();
  const [moved] = arr.splice(idx, 1);
  arr.splice(to, 0, moved);
  const touched = [];
  arr.forEach((r, i) => {
    if (r.order !== i) { r.order = i; touched.push(r); }
  });
  state.rules = arr;
  renderList();
  state.busy = true;
  updateSidebarState();
  try {
    for (const r of touched) {
      const res = await send('saveRule', { accountId: state.selectedAccountId, rule: r });
      if (isError(res)) {
        if (res.error.kind === 'no_password') {
          renderLazyAuth({ accountId: res.error.accountId, mailbox: res.error.mailbox });
          return;
        }
        alert(errorText(res.error));
        await reloadAll();
        return;
      }
    }
  } finally {
    state.busy = false;
    updateSidebarState();
  }
}

async function openEditorFor(draft, isNew) {
  const dlg = $('editorDialog');
  $('edTitle').textContent = t(isNew ? 'ed_title_new' : 'ed_title_edit');
  await openEditor({
    dialog: dlg,
    host: $('edBody'),
    draft,
    folders: state.folders,
    email: currentEmail(),
    prefs: state.prefs,
    onCancel: () => dlg.close('cancel'),
    onSave: async (rule) => {
      const res = await send('saveRule', { accountId: state.selectedAccountId, rule });
      if (isError(res)) {
        if (res.error.kind === 'no_password') {
          dlg.close('cancel');
          renderLazyAuth({ accountId: res.error.accountId, mailbox: res.error.mailbox });
          return null;
        }
        return errorText(res.error);
      }
      const i = state.rules.findIndex(x => x.id === res.id);
      if (i >= 0) state.rules[i] = res;
      else state.rules.push(res);
      state.rules.sort((a, b) => (a.order || 0) - (b.order || 0));
      state.selectedIds = new Set([String(res.id)]);
      state.selectedRuleId = res.id;
      state.lastClickedId = String(res.id);
      renderList();
      updateSelectionStatus();
      dlg.close('ok');
      return null;
    },
  });
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

// ────────────────────────────────────────────────────────────────────────────
// Import-from-Thunderbird dialog
// ────────────────────────────────────────────────────────────────────────────
function isLocalImportAvailable() {
  try {
    return !!(typeof browser !== 'undefined'
      && browser.exporSieveCredentials
      && typeof browser.exporSieveCredentials.listLocalFilters === 'function');
  } catch { return false; }
}

// Cleanup-чекбокс (удаление TB-фильтров после импорта) включается только
// если Experiment-API задеплоен И в нём есть метод deleteLocalFilters.
// На совсем старых TB / форках без подписи второе условие может быть false
// — тогда чекбокс остаётся disabled и tooltip объясняет почему.
function isLocalDeleteAvailable() {
  try {
    return !!(typeof browser !== 'undefined'
      && browser.exporSieveCredentials
      && typeof browser.exporSieveCredentials.deleteLocalFilters === 'function');
  } catch { return false; }
}

async function openImportDialog() {
  const dlg = $('importDialog');
  const list = $('importList');
  const intro = $('importIntro');
  const summary = $('importSummary');
  const warningsBox = $('importWarnings');
  const warningsList = $('importWarningsList');
  const errorBox = $('importError');
  const confirmBtn = $('importConfirm');
  const cancelBtn = $('importCancel');
  const cleanupChk = $('importCleanup');
  const cleanupHint = $('importCleanupHint');

  list.replaceChildren();
  warningsList.replaceChildren();
  warningsBox.hidden = true;
  errorBox.hidden = true;
  errorBox.textContent = '';
  summary.textContent = '';
  intro.textContent = t('import_loading') || 'Загружаю локальные фильтры…';
  confirmBtn.disabled = true;

  // Cleanup-чекбокс: дефолт = выключен (destructive operation, opt-in only).
  // При каждом открытии диалога СНАЧАЛА сбрасываем — иначе after-error
  // повторное открытие сохранит чек прошлой попытки и создаст ложное
  // ощущение «я ничего не выбирал». Активируем только если API доступен
  // (см. isLocalDeleteAvailable) И есть совместимые правила (см. ниже).
  if (cleanupChk) {
    cleanupChk.checked = false;
    cleanupChk.disabled = true;
  }
  if (cleanupHint) {
    cleanupHint.textContent = t('import_cleanup_help')
      || 'После успешного импорта удалит выбранные фильтры из настроек Thunderbird. Действие необратимо.';
  }

  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');

  // Cancel-handler цепляем СРАЗУ, до любых early-return'ов из ошибок /
  // empty-state. Иначе кнопка «Отмена» в этих ветках перестаёт работать.
  const closeDialog = () => {
    try { dlg.close('cancel'); } catch {}
  };
  // Удаляем предыдущие listener'ы (на повторное открытие диалога).
  cancelBtn.onclick = closeDialog;
  // Native cancel event (Esc).
  dlg.addEventListener('cancel', closeDialog, { once: true });

  const accountId = state.selectedAccountId;
  const acc = state.accounts.find(a => a.id === accountId);
  const accLabel = (acc && (acc.email || acc.name)) || accountId || '';

  const res = await send('listLocalFilters', { accountId });
  if (isError(res)) {
    if (res.error.kind === 'no_experiment') {
      intro.textContent = t('import_no_experiment')
        || 'Импорт недоступен в этой версии Thunderbird (нет Experiment API).';
    } else {
      intro.textContent = errorText(res.error);
    }
    return;
  }

  const raw = res.rawFilters || [];
  const mapped = res.mapped || [];
  const skipped = res.skipped || [];
  const warnings = res.warnings || [];

  if (raw.length === 0) {
    intro.textContent = t('import_empty')
      || 'Локальные фильтры для этого аккаунта не найдены.';
    return;
  }

  intro.textContent = (t('import_intro', [String(raw.length), accLabel])
    || `Найдено ${raw.length} фильтров для аккаунта ${accLabel}:`);

  // Сопоставляем raw[i] с mapped или skipped по позиции/имени.
  // mapLocalToRules сохраняет порядок: mapped и skipped — disjoint sets.
  const skippedNames = new Set(skipped.map(s => s.name));
  const mappedByName = new Map(mapped.map(r => [r.name, r]));
  // Какие предупреждения были у каждого фильтра — для tooltip.
  const warningsByName = new Map();
  for (const w of warnings) {
    if (!warningsByName.has(w.name)) warningsByName.set(w.name, []);
    warningsByName.get(w.name).push(w.msg);
  }

  // Чекбоксы — включены по умолчанию для совместимых.
  const rowState = []; // [{ tb, mapped, checked, compatible }]
  for (const tb of raw) {
    const m = mappedByName.get(tb.name);
    const compatible = !!m && !skippedNames.has(tb.name);
    rowState.push({ tb, mapped: m, checked: compatible, compatible });
  }

  function renderRows() {
    list.replaceChildren();
    rowState.forEach((s, idx) => {
      const row = el('label', { class: 'import-row' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = s.checked;
      cb.disabled = !s.compatible;
      cb.addEventListener('change', () => {
        rowState[idx].checked = cb.checked;
        updateSummary();
      });
      row.append(cb);
      const name = el('span', { class: 'imp-name' }, s.tb.name || '(без имени)');
      row.append(name);

      let badge;
      if (s.compatible) {
        const wlist = warningsByName.get(s.tb.name) || [];
        if (wlist.length > 0) {
          badge = el('span', { class: 'imp-badge warn', title: wlist.join('\n') },
            t('import_badge_partial') || '⚠ частично');
        } else {
          badge = el('span', { class: 'imp-badge ok' },
            t('import_badge_ok') || '✓ совместим');
        }
      } else {
        const wlist = warningsByName.get(s.tb.name) || [];
        badge = el('span', { class: 'imp-badge skip', title: wlist.join('\n') },
          t('import_badge_skip') || '✕ несовместим');
      }
      row.append(badge);
      list.append(row);
    });
  }

  function updateSummary() {
    const willImport = rowState.filter(s => s.checked).length;
    const total = rowState.length;
    summary.textContent = (t('import_summary', [String(willImport), String(total)])
      || `Будет импортировано: ${willImport} из ${total}.`);
    confirmBtn.disabled = willImport === 0;
  }

  if (warnings.length > 0) {
    warningsBox.hidden = false;
    for (const w of warnings) {
      warningsList.append(el('li', {}, w.msg));
    }
  }

  renderRows();
  updateSummary();

  // Enable the cleanup checkbox iff the Experiment-API method exists AND
  // there is at least one compatible row to import. Disabled-state is the
  // safe default — destructive op never available without an explicit
  // green-light from both sides.
  const hasCompatible = rowState.some(s => s.compatible);
  const deleteApiOk = isLocalDeleteAvailable();
  if (cleanupChk) {
    cleanupChk.disabled = !(deleteApiOk && hasCompatible);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { dlg.close(val); } catch {}
      resolve(val);
    };

    const onCancel = () => finish('cancel');
    const onConfirm = async () => {
      const selected = rowState.filter(s => s.checked);
      const rules = selected.map(s => s.mapped);
      // Имена TB-фильтров для последующего cleanup. Используем оригинальное
      // s.tb.name — оно ровно то, что вернул listLocalFilters и что Experiment
      // увидит в filterName при reverse-iter (case-insensitive match).
      const importedTbNames = selected.map(s => s.tb && s.tb.name).filter(Boolean);
      if (rules.length === 0) return;

      const cleanupRequested = !!(cleanupChk && cleanupChk.checked && !cleanupChk.disabled);

      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      errorBox.hidden = true;

      // 1) Импорт в combined-script.
      const r = await send('importLocalFilters', { accountId, rules });
      cancelBtn.disabled = false;
      if (isError(r)) {
        errorBox.hidden = false;
        errorBox.textContent = errorText(r.error);
        confirmBtn.disabled = false;
        return;
      }
      const saved = (r && r.saved) || 0;
      const errors = (r && r.errors) || [];
      if (errors.length > 0) {
        // Частичный успех импорта — НЕ удаляем ничего локально (cleanup
        // должен идти ТОЛЬКО после полностью зелёного импорта, иначе
        // юзер потеряет TB-копию фильтра, который не доехал на сервер).
        errorBox.hidden = false;
        const lines = errors.slice(0, 5).map(e => `• ${e.name}: ${e.msg}`);
        if (errors.length > 5) lines.push(`… и ещё ${errors.length - 5}`);
        errorBox.textContent = (t('import_partial_errors', [String(saved), String(errors.length)])
          || `Импортировано ${saved}, с ошибками ${errors.length}.`)
          + '\n' + lines.join('\n');
        confirmBtn.disabled = false;
        return;
      }

      // 2) Импорт прошёл чисто. Если cleanup запрошен — последний confirm
      //    (impact-irreversible action — TB UI-конвенция: подтверждать
      //    непосредственно перед действием, а не «ну ты же поставил галку
      //    минуту назад»).
      if (cleanupRequested && importedTbNames.length > 0) {
        let userOk = false;
        try {
          userOk = window.confirm(
            t('import_cleanup_confirm', [String(importedTbNames.length)])
              || `Удалить ${importedTbNames.length} локальных фильтров из Thunderbird? Действие необратимо.`,
          );
        } catch { userOk = false; }
        if (userOk) {
          const del = await send('deleteLocalFilters', {
            accountId, names: importedTbNames,
          });
          if (isError(del)) {
            // Импорт уже сохранён — НЕ откатываем. Показываем banner и
            // закрываем диалог как partial-success: пользователь прочтёт,
            // что cleanup упал, и сможет вручную удалить лишнее.
            finish('ok-partial');
            reloadAll();
            const banner = (t('import_cleanup_failed')
              || 'Импорт прошёл, но удаление локальных не сработало:')
              + ' ' + errorText(del.error);
            try { alert(banner); } catch {}
            return;
          }
          finish('ok-cleaned');
          reloadAll();
          const deleted = (del && del.deleted) || 0;
          // Если deleted < importedTbNames.length — часть фильтров уже была
          // удалена кем-то ещё (race) или у них в TB-UI имя сменилось после
          // listLocalFilters. Не показываем как ошибку — это soft-skip.
          const msg = t('import_done_with_cleanup', [String(saved), String(deleted)])
            || `Импортировано ${saved} фильтров. Удалено локальных: ${deleted}.`;
          try { alert(msg); } catch {}
          return;
        }
        // Юзер передумал на последнем confirm → импорт остался, cleanup пропущен.
        finish('ok');
        reloadAll();
        const msg = t('import_done', [String(saved)])
          || `Импортировано ${saved} фильтров.`;
        try { alert(msg); } catch {}
        return;
      }

      // 3) Cleanup не запрошен — обычный happy-path.
      finish('ok');
      reloadAll();
      const msg = t('import_done', [String(saved)])
        || `Импортировано ${saved} фильтров.`;
      try { alert(msg); } catch {}
    };

    cancelBtn.onclick = onCancel;
    confirmBtn.onclick = onConfirm;
    dlg.addEventListener('close', () => {
      if (!settled) finish(dlg.returnValue || 'cancel');
    }, { once: true });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Bind events
// ────────────────────────────────────────────────────────────────────────────
function bindEvents() {
  $('tbNew').addEventListener('click', () => onNew());
  $('tbEdit').addEventListener('click', onEdit);
  $('tbDuplicate').addEventListener('click', onDuplicate);
  $('tbDelete').addEventListener('click', onDelete);
  $('tbReload').addEventListener('click', () => reloadAll());
  $('tbSettings').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('tbHelp').addEventListener('click', () => {
    const url = browser.runtime.getURL('README.md');
    browser.tabs.create({ url }).catch(() => window.open(url));
  });
  $('tbWizard').addEventListener('click', async () => {
    // docs: https://webextension-api.thunderbird.net/en/mv3/messageDisplay.html#getdisplayedmessage
    try {
      const m = await browser.messageDisplay.getDisplayedMessage();
      if (m && m.id != null) {
        await send('openWizard', { messageId: m.id });
      } else {
        alert(t('tb_wizard_no_message'));
      }
    } catch {
      alert(t('tb_wizard_no_message'));
    }
  });

  // Импорт локальных фильтров TB — кнопка показывается только если
  // Experiment-API задеплоен (на старых TB / форках без него — скрыта).
  const tbImport = $('tbImportLocal');
  if (tbImport) {
    if (isLocalImportAvailable()) {
      tbImport.hidden = false;
      tbImport.addEventListener('click', () => {
        openImportDialog().catch((e) => alert(String(e?.message || e)));
      });
    } else {
      tbImport.hidden = true;
    }
  }

  $('sideNew').addEventListener('click', () => onNew());
  $('sideEdit').addEventListener('click', onEdit);
  $('sideDelete').addEventListener('click', onDelete);
  $('sideTop').addEventListener('click', () => moveRule('top'));
  $('sideUp').addEventListener('click', () => moveRule('up'));
  $('sideDown').addEventListener('click', () => moveRule('down'));
  $('sideBottom').addEventListener('click', () => moveRule('bottom'));

  $('btnEmptyCreate').addEventListener('click', () => onNew());
  $('btnOpenSettings').addEventListener('click', () => browser.runtime.openOptionsPage());
  $('btnRetry').addEventListener('click', () => bootstrap());

  $('footerClose').addEventListener('click', () => window.close());

  // Run-on-folder bar.
  $('runFolder').addEventListener('change', () => updateRunbarState());
  $('runRule').addEventListener('click', () => {
    onRunClick().catch(e => alert(String(e?.message || e)));
  });

  // Account selector → switch + persist + reloadAll.
  $('mgrAccount').addEventListener('change', async (e) => {
    state.selectedAccountId = e.target.value;
    try { await send('setSelectedAccountId', { accountId: state.selectedAccountId }); } catch {}
    await reloadAll();
  });

  // Search (debounce 100ms)
  let dt = null;
  $('mgrSearch').addEventListener('input', (e) => {
    clearTimeout(dt);
    dt = setTimeout(() => {
      state.searchQuery = e.target.value;
      renderList();
    }, 100);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
      e.preventDefault(); reloadAll();
    } else if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault(); onDuplicate();
    }
  });
}

async function init() {
  applyI18n();
  bindEvents();
  await bootstrap();
  // Если юзер поменял prefs в options — подхватим без перезагрузки окна.
  try {
    if (browser.storage && browser.storage.onChanged) {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.wizardPrefs) return;
        const next = changes.wizardPrefs.newValue;
        if (next && typeof next === 'object') state.prefs = { ...state.prefs, ...next };
      });
    }
  } catch {}
}

init().catch((e) => {
  console.error('[manager]', e);
  showError(String(e && e.message || e));
});
