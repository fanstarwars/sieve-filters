// SPDX-License-Identifier: GPL-3.0-or-later
// wizard.js — Filter Wizard. Открывается из контекстного меню письма.
// Принимает ?messageId=<id> в URL → запрашивает meta у background → заполняет
// preview → собирает draft Rule по выбранному шаблону + actions.

import { newRule } from '../lib/rule_model.js';
import { t } from '../lib/rule_form.js';
import { TEMPLATES, applyActionsToRule } from './templates.js';
import { openEditor } from '../editor/editor.js';
import { toDisplay, toCanonical } from '../lib/folder_path.js';
import { DEFAULTS as PREF_DEFAULTS } from '../lib/wizard_prefs.js';
import { filterUsableFolders } from '../lib/folder_filter.js';
import { buildTagChips, listAvailableTags } from '../lib/tag_picker.js';

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

function applyI18n() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const v = t(node.dataset.i18n);
    if (v) node.textContent = v;
  }
  for (const node of document.querySelectorAll('[data-i18n-title]')) {
    const v = t(node.dataset.i18nTitle);
    if (v) {
      node.title = v;
      if (!node.getAttribute('aria-label')) node.setAttribute('aria-label', v);
    }
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    const v = t(node.dataset.i18nPlaceholder);
    if (v) node.placeholder = v;
  }
}

async function send(cmd, payload = {}) {
  return await browser.runtime.sendMessage({ cmd, ...payload });
}
function isError(r) { return r && typeof r === 'object' && r.error; }

// ────────────────────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────────────────────
const state = {
  meta: null,           // {author, recipients, subject, date, size, listId, replyTo, accountId}
  folders: [],          // полный список папок аккаунта (для action'ов)
  visibleFolders: [],   // папки после фильтра hideSystemFolders — для picker'ов
  accountId: null,      // accountId письма (берём из meta)
  email: '',            // email привязанного к accountId ящика — для editor.badge
  needsAuth: null,      // {accountId, mailbox} | null
  selectedTemplateId: 'sender',
  prefs: { ...PREF_DEFAULTS, subjectPrefixes: PREF_DEFAULTS.subjectPrefixes.slice() },
  ownEmails: [],        // string[] (lowercase) — все мои identity emails
  availableTags: [],    // MessageTag[] — берётся из browser.messages.tags.list()
  selectedTags: [],     // string[] — keys выбранных меток (для action 'tag')
};

function templateOpts() {
  return { prefs: state.prefs, ownEmails: state.ownEmails };
}

// ────────────────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function formatDate(s) {
  if (!s) return '—';
  try {
    const d = s instanceof Date ? s : new Date(s);
    if (isNaN(+d)) return String(s);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, `
         + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch { return String(s); }
}

function renderMessage(meta) {
  $('msgAuthor').textContent     = meta?.author || '—';
  $('msgRecipients').textContent = meta?.recipients || '—';
  $('msgSubject').textContent    = meta?.subject || '—';
  $('msgDate').textContent       = formatDate(meta?.date);
  $('msgSize').textContent       = formatSize(meta?.size);
}

function showMessageError(text) {
  $('msgError').hidden = false;
  $('msgError').textContent = text;
  // Очистить таблицу.
  for (const id of ['msgAuthor','msgRecipients','msgSubject','msgDate','msgSize']) {
    $(id).textContent = '—';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Templates rendering
// ────────────────────────────────────────────────────────────────────────────
function renderTemplates() {
  const ul = $('wizTemplates');
  ul.replaceChildren();
  let firstEnabled = null;
  for (const tpl of TEMPLATES) {
    const ok = state.meta ? tpl.supports(state.meta, templateOpts()) : tpl.canApplyWithoutMessage;
    const disabled = tpl.disabled || !ok;
    const li = el('li', { class: disabled ? 'disabled' : '' });
    const r = el('input', {
      type: 'radio', name: 'wiz-tpl', value: tpl.id,
    });
    if (disabled) r.disabled = true;
    if (!disabled && firstEnabled == null) firstEnabled = tpl.id;
    r.checked = state.selectedTemplateId === tpl.id;
    r.addEventListener('change', () => {
      if (r.checked) { state.selectedTemplateId = tpl.id; renderDescription(); }
    });
    const label = el('label', {
      title: disabled ? (tpl.disabledKey ? t(tpl.disabledKey) : '') : '',
    }, r, ' ', t(tpl.titleKey));
    li.append(label);
    ul.append(li);
  }
  // Если выбранный шаблон оказался недоступен — выбрать первый доступный.
  const sel = TEMPLATES.find(t => t.id === state.selectedTemplateId);
  const selOk = sel
    && (state.meta ? sel.supports(state.meta, templateOpts()) : sel.canApplyWithoutMessage)
    && !sel.disabled;
  if (!selOk && firstEnabled) {
    state.selectedTemplateId = firstEnabled;
    const radio = ul.querySelector(`input[value="${firstEnabled}"]`);
    if (radio) radio.checked = true;
  }
  renderDescription();
}

function renderDescription() {
  const tpl = TEMPLATES.find(t => t.id === state.selectedTemplateId);
  if (!tpl) { $('wizDesc').textContent = ''; return; }
  $('wizDesc').textContent = t(tpl.descKey) || '';
}

// ────────────────────────────────────────────────────────────────────────────
// Folder picker
// ────────────────────────────────────────────────────────────────────────────
function renderFolders() {
  // Folder picker для action 'fileinto' — показываем только пользовательские
  // папки (Trash/Junk/Drafts/Sent/Templates/Archives скрыты, если включён
  // hideSystemFolders). Это согласуется с UX Quick Filters: папки-«системные»
  // адресуются специальными actions (act_trash, act_discard и т.п.).
  state.visibleFolders = filterUsableFolders(state.folders, state.prefs);

  // Если письмо открыто из подпапки (не Inbox/system) — гарантируем что
  // именно эта папка попадает в visibleFolders, даже если она в норме
  // была бы скрыта (например, помечена как Junk). Юзер делает фильтр из
  // конкретного письма, ему нужна именно та папка по умолчанию.
  const meta = state.meta;
  const messageFolderPath = meta && typeof meta.folderPath === 'string' ? meta.folderPath : '';
  if (messageFolderPath && !state.visibleFolders.some(f => f.path === messageFolderPath)) {
    const found = state.folders.find(f => f.path === messageFolderPath);
    if (found) state.visibleFolders = [found, ...state.visibleFolders];
  }

  const sel = $('actFolderSel');
  sel.replaceChildren();
  if (!state.visibleFolders.length) {
    sel.append(el('option', { value: '' }, t('wiz_no_folders')));
    sel.disabled = true;
    return;
  }
  for (const f of state.visibleFolders) {
    // value — canonical (decoded Unicode без leading '/'). Дальше в
    // applyActionsToRule оно попадёт в a.folder; sieve_adapter.toSieve
    // закодирует обратно в mUTF7 при записи в скрипт.
    sel.append(el('option', { value: toCanonical(f.path) }, toDisplay(f.path) || '/'));
  }

  // Pre-selection: если письмо лежит в подпапке (НЕ inbox), подставляем её
  // как target. Это самый ожидаемый сценарий «сделать фильтр из письма,
  // которое я уже руками положил куда надо».
  if (messageFolderPath) {
    const isInbox = Array.isArray(meta?.folderSpecialUse)
      && meta.folderSpecialUse.includes('inbox');
    if (!isInbox) {
      const target = toCanonical(messageFolderPath);
      // Авто-включаем fileinto-чекбокс — без этого <select> остаётся disabled
      // и juzer не увидит подставленную папку.
      const fileintoChk = $('actFileinto');
      if (fileintoChk && !fileintoChk.checked) fileintoChk.checked = true;
      sel.value = target;
    }
  }
  sel.disabled = !$('actFileinto').checked;
}

// ────────────────────────────────────────────────────────────────────────────
// Build draft & submit
// ────────────────────────────────────────────────────────────────────────────
function buildDraft() {
  const tpl = TEMPLATES.find(x => x.id === state.selectedTemplateId);
  if (!tpl) return null;
  const draft = newRule();
  draft.active = true;
  draft.matchAll = true;
  // Применяем шаблон → conditions + name. Передаём prefs/ownEmails.
  tpl.apply(draft, state.meta, state.visibleFolders, templateOpts());
  // Применяем actions. Folder picker уже показывает только visibleFolders,
  // поэтому fallback берём из них же.
  applyActionsToRule(draft, {
    fileinto: $('actFileinto').checked,
    folder: $('actFolderSel').value || toCanonical(state.visibleFolders[0]?.path),
    star: $('actStar').checked,
    tags: ($('actTags') && $('actTags').checked) ? state.selectedTags.slice() : [],
  }, state.visibleFolders);
  return draft;
}

async function onCreate() {
  const draft = buildDraft();
  if (!draft) {
    alert(t('wiz_no_template_selected'));
    return;
  }

  if ($('nextOpenEditor').checked) {
    // Открываем Editor для подтверждения; после save → опционально открыть Manager.
    const dlg = $('editorDialog');
    $('edTitle').textContent = t('ed_title_new');
    await openEditor({
      dialog: dlg,
      host: $('edBody'),
      draft,
      folders: state.visibleFolders,
      email: state.email,
      prefs: state.prefs,
      onCancel: () => dlg.close('cancel'),
      onSave: async (rule) => {
        const res = await send('saveRule', { accountId: state.accountId, rule });
        if (isError(res)) {
          if (res.error.kind === 'no_password') {
            dlg.close('cancel');
            renderLazyAuth(res.error);
            return null;
          }
          return res.error.message || t('err_server');
        }
        dlg.close('ok');
        if ($('nextOpenManager').checked) {
          await send('openManager');
        }
        setTimeout(() => window.close(), 200);
        return null;
      },
    });
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  } else {
    const res = await send('saveRule', { accountId: state.accountId, rule: draft });
    if (isError(res)) {
      if (res.error.kind === 'no_password') {
        renderLazyAuth(res.error);
        return;
      }
      alert(res.error.message || t('err_server'));
      return;
    }
    if ($('nextOpenManager').checked) {
      await send('openManager');
    }
    window.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lazy-auth panel — инструкция открыть TB Account Settings и сохранить
// пароль; кнопка «Повторить» делает probe и retry'ит создание правила.
// (v0.15.0+: пароль больше не вводится в плагине.)
// ────────────────────────────────────────────────────────────────────────────
function renderLazyAuth({ accountId, mailbox }) {
  state.needsAuth = { accountId, mailbox };
  const host = $('wizLazyAuth');
  host.replaceChildren();

  const head = document.createElement('h3');
  head.textContent = t('mgr_lazy_auth_title') || 'Нужен пароль почты';
  host.append(head);

  const info = document.createElement('p');
  info.className = 'lazy-auth-info';
  info.textContent = (t('mgr_lazy_auth_info')
    || 'Для ящика {0} плагин не смог получить пароль из настроек Thunderbird.')
    .replace('{0}', mailbox);
  host.append(info);

  const steps = document.createElement('ol');
  steps.className = 'lazy-auth-steps';
  for (const key of ['mgr_lazy_auth_step_open', 'mgr_lazy_auth_step_save', 'mgr_lazy_auth_step_master']) {
    const li = document.createElement('li');
    li.textContent = t(key) || '';
    steps.append(li);
  }
  host.append(steps);

  const errorBox = document.createElement('p'); errorBox.className = 'lazy-auth-error'; errorBox.hidden = true;
  const actions = document.createElement('div'); actions.className = 'lazy-auth-actions';
  const retryBtn = document.createElement('button'); retryBtn.type = 'button'; retryBtn.className = 'primary';
  retryBtn.textContent = t('mgr_retry') || 'Повторить';
  const cancelBtn = document.createElement('button'); cancelBtn.type = 'button';
  cancelBtn.textContent = t('btn_cancel');
  actions.append(retryBtn, cancelBtn);
  host.append(errorBox, actions);

  retryBtn.addEventListener('click', async () => {
    retryBtn.disabled = true; cancelBtn.disabled = true;
    errorBox.hidden = true;
    try {
      const r = await send('checkPasswordAvailable', { accountId });
      if (isError(r)) {
        errorBox.hidden = false;
        errorBox.textContent = r.error.message || t('err_server');
        return;
      }
      if (!r.available) {
        errorBox.hidden = false;
        errorBox.textContent = t('options_import_unavailable')
          || 'В этой версии Thunderbird не поддерживается чтение пароля из настроек.';
        return;
      }
      if (!r.hasPassword) {
        errorBox.hidden = false;
        errorBox.textContent = t('mgr_lazy_auth_still_missing')
          || 'Пароль всё ещё недоступен. Проверьте, что он сохранён в Account Settings и мастер-пароль разблокирован.';
        return;
      }
      state.needsAuth = null;
      host.hidden = true;
      // Retry — кликаем «Создать» ещё раз.
      onCreate();
    } finally {
      retryBtn.disabled = false; cancelBtn.disabled = false;
    }
  });
  cancelBtn.addEventListener('click', () => { host.hidden = true; });

  host.hidden = false;
  setTimeout(() => retryBtn.focus(), 50);
}

// ────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────────────────
function getQueryMessageId() {
  try {
    const params = new URLSearchParams(location.search);
    const v = params.get('messageId');
    return v ? Number(v) : null;
  } catch { return null; }
}

async function bootstrap() {
  applyI18n();
  document.title = t('wiz_title');

  // 0. Параллельно — wizard prefs + список собственных email'ов (для шаблона
  //    «По адресату»). Не блокируем UI, если что-то упало — fallback дефолты.
  try {
    const [prefsRes, ownRes] = await Promise.all([
      send('getWizardPrefs'),
      send('getOwnEmails'),
    ]);
    if (prefsRes && !isError(prefsRes)) state.prefs = prefsRes;
    if (Array.isArray(ownRes)) state.ownEmails = ownRes;
  } catch {}

  // 1. meta — отсюда берём accountId письма.
  const id = getQueryMessageId();
  if (id != null && Number.isFinite(id)) {
    const m = await send('getMessageMeta', { id });
    if (isError(m)) {
      showMessageError(t('wiz_msg_error'));
      state.meta = null;
    } else {
      state.meta = m;
      state.accountId = m.accountId || null;
      renderMessage(m);
    }
  } else {
    showMessageError(t('wiz_no_message'));
    state.meta = null;
  }

  // 2. Папки для accountId (или fallback на default).
  const fRes = await send('listFolders', { accountId: state.accountId });
  state.folders = isError(fRes) ? [] : (fRes || []);
  renderFolders();

  // 3. email для editor-badge.
  if (state.accountId) {
    try {
      const accs = await send('listAccounts');
      const acc = (accs || []).find(a => a.id === state.accountId);
      if (acc) state.email = acc.email || '';
    } catch {}
  }

  renderTemplates();

  // Bind events.
  $('btnCancel').addEventListener('click', () => window.close());
  $('btnCreate').addEventListener('click', onCreate);
  $('actFileinto').addEventListener('change', () => {
    $('actFolderSel').disabled = !$('actFileinto').checked;
  });

  // ── Tag chips (опциональный action 'tag') ──────────────────────────────
  // Загружаем список TB-меток (browser.messages.tags.list()) в фоне; пока
  // юзер не включит чекбокс «Добавить метки», слот скрыт. При первом
  // включении — рендерим chips. Если меток у юзера нет совсем (или API
  // недоступно) — buildTagChips сам покажет fallback с текстовым input.
  try {
    state.availableTags = await listAvailableTags();
  } catch { state.availableTags = []; }
  const tagsChk = $('actTags');
  const tagsSlot = $('actTagsSlot');
  function renderTagChips() {
    tagsSlot.replaceChildren(buildTagChips({
      selected: state.selectedTags,
      allTags: state.availableTags,
      onChange: (keys) => { state.selectedTags = keys; },
      t,
    }));
  }
  if (tagsChk && tagsSlot) {
    tagsChk.addEventListener('change', () => {
      tagsSlot.hidden = !tagsChk.checked;
      if (tagsChk.checked) renderTagChips();
    });
  }
  $('wizHelp').addEventListener('click', () => {
    const url = browser.runtime.getURL('README.md');
    browser.tabs?.create?.({ url }).catch(() => window.open(url));
  });

  // Esc — закрыть.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('editorDialog').open) window.close();
  });
}

bootstrap().catch((e) => {
  console.error('[wizard]', e);
  showMessageError(String(e?.message || e));
});
