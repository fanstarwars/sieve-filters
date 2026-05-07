// SPDX-License-Identifier: GPL-3.0-or-later
// editor.js — Filter Editor: модал редактирования правила.
// Использует общий каталог полей/действий и валидатор из lib/rule_form.js,
// но рендерит UI «по-новому» (по образу Quick Filters editor — скрин #2).
//
// API: openEditor({ dialog, host, draft, folders, onSave, onCancel })
//   — рендерит форму в host (внутри dialog), отдаёт фокус первому полю.
//   — onSave(rule) → возвращает строку с ошибкой (или null/undefined).

import {
  FIELDS, ACTIONS, opsForField, t,
} from '../lib/rule_form.js';
import { validateRule } from '../lib/rule_model.js';
import { decodeIMAPUTF7 } from '../lib/imap_utf7.js';
import { filterUsableFolders } from '../lib/folder_filter.js';

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

function makeSelect(items, selected, onChange) {
  const s = el('select');
  for (const it of items) {
    const opt = el('option', { value: it.v }, t(it.k));
    if (it.v === selected) opt.selected = true;
    s.append(opt);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function defaultCondition() {
  return { field: 'from', op: 'contains', value: '' };
}
function defaultAction(folders) {
  return { type: 'fileinto', folder: folders?.[0]?.path || '' };
}

/**
 * @param {object} opts
 * @param {HTMLDialogElement} opts.dialog
 * @param {HTMLElement} opts.host
 * @param {import('../lib/rule_model.js').Rule} opts.draft
 * @param {Array} [opts.folders]
 * @param {string} [opts.email]   — email текущего ящика (для бэйджа в шапке).
 * @param {object} [opts.prefs]   — wizardPrefs (для filterUsableFolders).
 *                                   Если не передан — papkи показываются как есть.
 * @param {(rule)=>Promise<string|null>} [opts.onSave]
 * @param {() => void} [opts.onCancel]
 */
export async function openEditor({ dialog, host, draft, folders = [], email = '', prefs = null, onSave, onCancel }) {
  host.replaceChildren();
  // Фильтрация системных папок — только если caller прокинул prefs (Manager
  // передаёт их явно; legacy-callers без prefs получают исходный список).
  if (prefs && prefs.hideSystemFolders) {
    folders = filterUsableFolders(folders, prefs);
  }

  let dirty = false;
  const markDirty = () => { dirty = true; };

  // ─── Account badge (для какого ящика правило) ───────────────
  if (email) {
    host.append(
      el('div', { class: 'ed-account-badge', title: t('ed_for_mailbox') || 'Ящик' },
        (t('ed_for_mailbox') || 'Для') + ': ',
        el('span', { class: 'ed-account-email' }, email),
      ),
    );
  }

  // Гарантируем хотя бы одно условие и одно действие.
  if (!draft.conditions || draft.conditions.length === 0) {
    draft.conditions = [defaultCondition()];
  }
  if (!draft.actions || draft.actions.length === 0) {
    draft.actions = [defaultAction(folders)];
  }

  // ─── Имя ─────────────────────────────────────────────────────
  const nameInput = el('input', {
    type: 'text', class: 'ed-name-input', required: true, autocomplete: 'off',
    placeholder: t('ed_name_placeholder'),
    value: draft.name || '',
  });
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; markDirty(); });
  host.append(
    el('div', { class: 'ed-row' },
      el('label', { for: 'ed-name' }, t('rule_name')),
      nameInput,
    ),
  );

  // ─── Активно ─────────────────────────────────────────────────
  const activeChk = el('input', { type: 'checkbox' });
  activeChk.checked = draft.active !== false;
  activeChk.addEventListener('change', () => { draft.active = activeChk.checked; markDirty(); });
  host.append(
    el('div', { class: 'ed-checkrow' },
      activeChk,
      el('label', {}, t('rule_active')),
    ),
  );

  // ─── Применять при: ──────────────────────────────────────────
  host.append(
    el('div', { class: 'ed-row' },
      el('label', {}, t('ed_apply_when')),
      el('span', { class: 'ed-info', title: t('ed_apply_when_info') },
        t('ed_apply_when_value')),
    ),
  );

  // ─── matchAll/Any радио ──────────────────────────────────────
  const radioAll = el('input', { type: 'radio', name: 'ed-match', value: 'all' });
  radioAll.checked = draft.matchAll !== false;
  const radioAny = el('input', { type: 'radio', name: 'ed-match', value: 'any' });
  radioAny.checked = draft.matchAll === false;
  radioAll.addEventListener('change', () => { if (radioAll.checked) { draft.matchAll = true; markDirty(); } });
  radioAny.addEventListener('change', () => { if (radioAny.checked) { draft.matchAll = false; markDirty(); } });
  host.append(
    el('div', { class: 'ed-radios' },
      el('label', {}, radioAll, ' ', t('rule_match_all')),
      el('label', {}, radioAny, ' ', t('rule_match_any')),
    ),
  );

  // ─── Условия ─────────────────────────────────────────────────
  const condList = el('div', { class: 'ed-rows' });
  function redrawConditions() {
    condList.replaceChildren();
    draft.conditions.forEach((c, i) => condList.append(condLine(c, i)));
  }
  function condLine(c, idx) {
    const line = el('div', { class: 'ed-row-line' });

    const fieldSel = makeSelect(FIELDS, c.field, (v) => {
      c.field = v;
      const ops = opsForField(v);
      if (!ops.includes(c.op)) c.op = ops[0];
      if (v === 'attachment') { delete c.value; delete c.unit; }
      if (v === 'size') { c.value = Number(c.value) || 0; c.unit = c.unit || 'KB'; }
      if (v !== 'header') delete c.headerName;
      markDirty();
      redrawConditions();
    });
    line.append(fieldSel);

    const opSel = el('select');
    for (const op of opsForField(c.field)) {
      const o = el('option', { value: op }, t('op_' + op));
      if (op === c.op) o.selected = true;
      opSel.append(o);
    }
    opSel.addEventListener('change', () => { c.op = opSel.value; markDirty(); });
    line.append(opSel);

    if (c.field === 'header') {
      // Для header — два инпута: имя заголовка + значение. Размещаем в третьей колонке.
      const wrap = el('div', { class: 'ed-row-line', style: 'grid-column:3/4;display:grid;grid-template-columns:1fr 1fr;gap:6px' });
      const hdr = el('input', { type: 'text', placeholder: t('rule_header_name_placeholder'), value: c.headerName || '' });
      hdr.addEventListener('input', () => { c.headerName = hdr.value; markDirty(); });
      const val = el('input', { type: 'text', placeholder: t('rule_value_placeholder'), value: Array.isArray(c.value) ? c.value.join(', ') : (c.value || '') });
      val.addEventListener('input', () => { c.value = val.value; markDirty(); });
      wrap.append(hdr, val);
      line.append(wrap);
    } else if (c.field === 'size') {
      const wrap = el('div', { style: 'grid-column:3/4;display:grid;grid-template-columns:1fr 70px;gap:6px' });
      const inp = el('input', { type: 'number', min: '0', value: c.value ?? '' });
      inp.addEventListener('input', () => { c.value = Number(inp.value) || 0; markDirty(); });
      const unit = el('select');
      for (const u of ['KB', 'MB']) {
        const o = el('option', { value: u }, t(u === 'KB' ? 'size_kb' : 'size_mb'));
        if ((c.unit || 'KB') === u) o.selected = true;
        unit.append(o);
      }
      unit.addEventListener('change', () => { c.unit = unit.value; markDirty(); });
      wrap.append(inp, unit);
      line.append(wrap);
    } else if (c.field === 'attachment') {
      // оператор уже в opSel — значения не нужны.
      line.append(el('span'));
    } else {
      const inp = el('input', {
        type: 'text', placeholder: t('rule_value_placeholder'),
        value: Array.isArray(c.value) ? c.value.join(', ') : (c.value || ''),
      });
      inp.addEventListener('input', () => {
        c.value = c.op === 'contains_any'
          ? inp.value.split(',').map(s => s.trim()).filter(Boolean)
          : inp.value;
        markDirty();
      });
      line.append(inp);
    }

    const addBtn = el('button', { type: 'button', class: 'ed-mini-btn', title: t('rule_add_condition') }, '+');
    addBtn.addEventListener('click', () => {
      draft.conditions.splice(idx + 1, 0, defaultCondition());
      markDirty();
      redrawConditions();
    });
    const remBtn = el('button', { type: 'button', class: 'ed-mini-btn', title: t('rule_remove_condition') }, '−');
    remBtn.disabled = draft.conditions.length === 1;
    remBtn.addEventListener('click', () => {
      if (draft.conditions.length === 1) return;
      draft.conditions.splice(idx, 1);
      markDirty();
      redrawConditions();
    });
    line.append(addBtn, remBtn);
    return line;
  }
  redrawConditions();

  host.append(
    el('div', { class: 'ed-section' },
      el('div', { class: 'ed-section-title' }, t('rule_section_conditions')),
      condList,
    ),
  );

  // ─── Действия ─────────────────────────────────────────────────
  const actList = el('div', { class: 'ed-rows' });
  function redrawActions() {
    actList.replaceChildren();
    draft.actions.forEach((a, i) => actList.append(actionLine(a, i)));
  }
  function actionLine(a, idx) {
    const line = el('div', { class: 'ed-action-line' });

    const typeSel = makeSelect(ACTIONS, a.type, (v) => {
      a.type = v;
      delete a.folder; delete a.address;
      if (v === 'fileinto' || v === 'copy') a.folder = folders[0]?.path || '';
      if (v === 'redirect') a.address = '';
      markDirty();
      redrawActions();
    });
    line.append(typeSel);

    if (a.type === 'fileinto' || a.type === 'copy') {
      if (folders && folders.length) {
        // value — raw IMAP-path (Sieve/Dovecot хотят его как есть);
        // текст option — декодированный modified-UTF-7 для читаемости (кириллица).
        const renderLabel = (f) => {
          const raw = (f.path || f.name || '').replace(/^\//, '');
          return decodeIMAPUTF7(raw) || '/';
        };
        const sel = el('select');
        for (const f of folders) {
          const o = el('option', { value: f.path }, renderLabel(f));
          if (f.path === a.folder) o.selected = true;
          sel.append(o);
        }
        if (!a.folder && folders[0]) a.folder = folders[0].path;
        sel.value = a.folder;
        sel.addEventListener('change', () => { a.folder = sel.value; markDirty(); });
        line.append(sel);
      } else {
        const inp = el('input', { type: 'text', placeholder: 'INBOX/Folder', value: a.folder || '' });
        inp.addEventListener('input', () => { a.folder = inp.value; markDirty(); });
        line.append(inp);
      }
    } else if (a.type === 'redirect') {
      const inp = el('input', { type: 'email', placeholder: t('rule_email_placeholder'), value: a.address || '' });
      inp.addEventListener('input', () => { a.address = inp.value; markDirty(); });
      line.append(inp);
    } else {
      line.append(el('span'));
    }

    const addBtn = el('button', { type: 'button', class: 'ed-mini-btn', title: t('rule_add_action') }, '+');
    addBtn.addEventListener('click', () => {
      draft.actions.splice(idx + 1, 0, defaultAction(folders));
      markDirty();
      redrawActions();
    });
    const remBtn = el('button', { type: 'button', class: 'ed-mini-btn', title: t('rule_remove_action') }, '−');
    remBtn.disabled = draft.actions.length === 1;
    remBtn.addEventListener('click', () => {
      if (draft.actions.length === 1) return;
      draft.actions.splice(idx, 1);
      markDirty();
      redrawActions();
    });
    line.append(addBtn, remBtn);

    if (a.type === 'redirect') {
      line.append(el('div', { class: 'ed-warn' }, t('warn_redirect')));
    } else if (a.type === 'discard') {
      line.append(el('div', { class: 'ed-warn' }, t('warn_discard')));
    }
    return line;
  }
  redrawActions();

  host.append(
    el('div', { class: 'ed-section' },
      el('div', { class: 'ed-section-title' }, t('ed_actions_label')),
      actList,
    ),
  );

  // ─── stop after ───────────────────────────────────────────────
  // sieve `stop;` — после срабатывания этого правила остальные правила
  // НЕ применяются к этому письму. Без stop пройдут все matching-правила
  // подряд, что обычно даёт двойную фильтровку (письмо отнесли в папку,
  // а потом ещё пометили звёздочкой и т.д.). По умолчанию включено.
  const stopChk = el('input', { type: 'checkbox' });
  stopChk.checked = draft.stopAfter !== false;
  stopChk.addEventListener('change', () => { draft.stopAfter = stopChk.checked; markDirty(); });
  const stopHelp = el('span', {
    class: 'ed-help',
    title: t('rule_stop_after_help'),
  }, '(?)');
  host.append(
    el('div', { class: 'ed-checkrow' },
      stopChk,
      el('label', {}, t('rule_stop_after')),
      stopHelp,
    ),
  );

  // ─── Sieve-preview ───────────────────────────────────────────
  const sievePre = el('pre', { class: 'ed-sieve-pre', 'aria-live': 'polite' });
  const sieveDetails = el('details', { class: 'ed-sieve-details' },
    el('summary', {}, t('ed_show_sieve')),
    sievePre,
  );
  sieveDetails.addEventListener('toggle', async () => {
    if (!sieveDetails.open) return;
    try {
      const res = await browser.runtime.sendMessage({ cmd: 'previewSieve', rule: draft });
      sievePre.textContent = res?.sieve || '';
    } catch (e) {
      sievePre.textContent = String(e?.message || e);
    }
  });
  host.append(sieveDetails);

  // ─── Ошибка ──────────────────────────────────────────────────
  const errBanner = el('p', { class: 'ed-error', hidden: true });
  host.append(errBanner);

  function showError(text) {
    errBanner.textContent = text || '';
    errBanner.hidden = !text;
  }

  // ─── Footer ──────────────────────────────────────────────────
  const cancelBtn = el('button', { type: 'button' }, t('btn_cancel'));
  const saveBtn = el('button', { type: 'button', class: 'primary' }, t('btn_ok'));
  const footer = el('div', { class: 'ed-footer' }, cancelBtn, saveBtn);
  host.append(footer);

  cancelBtn.addEventListener('click', () => {
    if (dirty && !confirm(t('ed_confirm_discard'))) return;
    onCancel ? onCancel() : dialog.close('cancel');
  });

  saveBtn.addEventListener('click', async () => {
    // подтянуть имя на случай, если input-event не сработал
    draft.name = nameInput.value.trim();
    draft.active = activeChk.checked;
    draft.matchAll = radioAll.checked;
    draft.stopAfter = stopChk.checked;
    const localErr = validateRule(draft);
    if (localErr) { showError(localErr); return; }
    showError('');
    if (!onSave) { dialog.close('ok'); return; }
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const res = await onSave(draft);
      if (res) showError(typeof res === 'string' ? res : (res.message || String(res)));
    } catch (e) {
      showError(e?.message || String(e));
    } finally {
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  // ─── Esc-handler с dirty-warning ─────────────────────────────
  dialog.addEventListener('cancel', (e) => {
    if (dirty) {
      e.preventDefault();
      if (confirm(t('ed_confirm_discard'))) {
        dialog.close('cancel');
      }
    }
  });

  // Enter в name-инпут — submit.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
  });

  // Фокус на имя.
  setTimeout(() => nameInput.focus(), 50);
}
