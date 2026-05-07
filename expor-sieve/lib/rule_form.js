// lib/rule_form.js — общая форма правила для popup/popup.js и options/options.js.
//
// Раньше форма (поля + условия + действия + сериализация / валидация на сабмит)
// дублировалась в обоих UI. Теперь оба сценария используют один
// `renderRuleForm(container, rule, opts)`.
//
// API:
//   * `el(tag, attrs, ...children)`  — DOM-хелпер, как в popup.js.
//   * `t(key, ...subs)`              — обёртка над browser.i18n.getMessage.
//   * `FIELDS` / `ACTIONS`           — каталоги полей и действий с i18n-ключами.
//   * `opsForField(field)`           — список валидных операторов для поля.
//   * `defaultCondition()`           — фабрика дефолтного условия.
//   * `defaultAction(folders)`       — фабрика дефолтного действия (берёт первую папку).
//   * `describeRule(rule)`           — однострочное описание для карточки.
//   * `describeCondition(c)` / `describeAction(a)` — кусочные описания.
//   * `renderRuleForm(container, rule, { folders, onSave, onCancel })`
//       — рендерит форму в переданный контейнер, мутирует rule на месте,
//         не открывает/не закрывает <dialog> — это делает caller.
//         Возвращает { destroy(), refresh() }.
//
// Стили:
//   Узлы получают сразу два набора классов (`rf-* cond-row|act-row|...`),
//   чтобы оба существующих stylesheet'а (popup.css / options.css) продолжали
//   работать без правок.

import { validateRule } from './rule_model.js';
import { decodeIMAPUTF7 } from './imap_utf7.js';
import { filterUsableFolders } from './folder_filter.js';

// ── i18n ─────────────────────────────────────────────────────────────────────
export const t = (key, ...subs) => {
  // browser.i18n.getMessage принимает либо строку, либо массив подстановок.
  const args = subs.length === 1 && Array.isArray(subs[0]) ? subs[0] : subs;
  return browser.i18n.getMessage(key, args) || key;
};

// ── DOM helper ───────────────────────────────────────────────────────────────
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    } else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

function makeSelect(items, selected, onChange, extraClass = '') {
  const s = el('select', extraClass ? { class: extraClass } : {});
  for (const it of items) {
    const opt = el('option', { value: it.v }, t(it.k));
    if (it.v === selected) opt.selected = true;
    s.append(opt);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

// ── каталоги ─────────────────────────────────────────────────────────────────
export const FIELDS = [
  { v: 'from',       k: 'field_from' },
  { v: 'to',         k: 'field_to' },
  { v: 'cc',         k: 'field_cc' },
  { v: 'subject',    k: 'field_subject' },
  { v: 'header',     k: 'field_header' },
  { v: 'size',       k: 'field_size' },
  { v: 'attachment', k: 'field_attachment' },
];

const TEXT_OPS   = ['contains', 'not_contains', 'is', 'starts', 'ends', 'contains_any'];
const HEADER_OPS = ['contains', 'not_contains', 'is', 'starts', 'ends'];
const SIZE_OPS   = ['gt', 'lt'];
const ATTACH_OPS = ['has_attachment', 'no_attachment'];

export function opsForField(field) {
  if (field === 'size')       return SIZE_OPS;
  if (field === 'attachment') return ATTACH_OPS;
  if (field === 'header')     return HEADER_OPS;
  return TEXT_OPS;
}

export const ACTIONS = [
  { v: 'fileinto',  k: 'act_fileinto' },
  { v: 'copy',      k: 'act_copy' },
  { v: 'mark_read', k: 'act_mark_read' },
  { v: 'flag',      k: 'act_flag' },
  { v: 'redirect',  k: 'act_redirect' },
  { v: 'discard',   k: 'act_discard' },
  { v: 'trash',     k: 'act_trash' },
];

// ── фабрики ──────────────────────────────────────────────────────────────────
export function defaultCondition() {
  return { field: 'from', op: 'contains', value: '' };
}

export function defaultAction(folders = []) {
  return { type: 'fileinto', folder: folders[0]?.path || '' };
}

// ── короткое описание ────────────────────────────────────────────────────────
export function describeCondition(c) {
  if (c.field === 'attachment') {
    return c.op === 'has_attachment' ? t('desc_attachment_yes') : t('desc_attachment_no');
  }
  const fieldName = t('field_' + c.field);
  const opName = t('op_' + c.op);
  let val = c.value;
  if (Array.isArray(val)) val = val.join(', ');
  if (c.field === 'size') val = (val ?? '') + ' ' + (c.unit || 'KB');
  return t('desc_field_value', fieldName, opName, String(val ?? ''));
}

export function describeAction(a) {
  switch (a.type) {
    case 'fileinto':  return t('desc_in_folder', decodeIMAPUTF7(a.folder) || '?');
    case 'copy':      return t('desc_copy_folder', decodeIMAPUTF7(a.folder) || '?');
    case 'mark_read': return t('desc_mark_read');
    case 'flag':      return t('desc_flag');
    case 'redirect':  return t('desc_redirect', a.address || '?');
    case 'discard':   return t('desc_discard');
    case 'trash':     return t('desc_trash');
    default:          return a.type;
  }
}

export function describeRule(rule) {
  const conds = rule.conditions || [];
  const acts  = rule.actions || [];
  const sep = rule.matchAll === false ? t('desc_separator_or') : t('desc_separator_and');

  const condParts = conds.slice(0, 2).map(describeCondition);
  let condText = condParts.join(sep);
  if (conds.length > 2) condText += sep + t('desc_more', String(conds.length - 2));

  const actParts = acts.slice(0, 2).map(describeAction);
  let actText = actParts.join(t('desc_separator_and'));
  if (acts.length > 2) actText += ' ' + t('desc_more', String(acts.length - 2));

  return condText + ' ' + t('desc_arrow') + ' ' + actText;
}

// ── главная функция: renderRuleForm ─────────────────────────────────────────
/**
 * Рендерит форму редактирования правила в `container`.
 * Контейнер ожидается пустой (его содержимое будет заменено).
 *
 * @param {HTMLElement} container
 * @param {import('./rule_model.js').Rule} rule  черновик правила (мутируется)
 * @param {object} opts
 * @param {Array} opts.folders                    [{ id, name, path }]
 * @param {object} [opts.prefs]                   wizardPrefs — если задан и
 *                                                hideSystemFolders=true, из
 *                                                folders убираем Trash/Junk/...
 * @param {(rule) => Promise|any} [opts.onSave]   вернёт {error} или бросит — покажем баннер
 * @param {() => void} [opts.onCancel]
 * @returns {{ destroy: () => void, refresh: () => void }}
 */
export function renderRuleForm(container, rule, { folders = [], prefs = null, onSave, onCancel } = {}) {
  container.replaceChildren();
  if (prefs && prefs.hideSystemFolders) {
    folders = filterUsableFolders(folders, prefs);
  }

  // ── Имя ────────────────────────────────────────────────────────────────
  const nameInput = el('input', {
    type: 'text', class: 'rf-name', required: true,
    value: rule.name || '',
  });
  container.append(
    el('div', { class: 'rf-block form-row' },
      el('label', {}, t('rule_name')),
      nameInput,
    ),
  );

  // ── Активность ────────────────────────────────────────────────────────
  const activeChk = el('input', { type: 'checkbox' });
  activeChk.checked = rule.active !== false;
  container.append(
    el('label', { class: 'rf-checkrow inline' },
      activeChk, ' ', t('rule_active'),
    ),
  );

  // ── matchAll/Any ──────────────────────────────────────────────────────
  const matchSel = el('select');
  matchSel.append(
    el('option', { value: 'all' }, t('rule_match_all')),
    el('option', { value: 'any' }, t('rule_match_any')),
  );
  matchSel.value = rule.matchAll === false ? 'any' : 'all';
  container.append(
    el('div', { class: 'rf-block form-row' },
      el('label', {}, t('rule_match_label') + ' '),
      matchSel,
    ),
  );

  // ── Условия ───────────────────────────────────────────────────────────
  const condList = el('div', { class: 'rows' });
  const condAdd = el('button', {
    type: 'button', class: 'link-btn',
    on: { click: () => {
      rule.conditions.push(defaultCondition());
      redrawConditions();
    } },
  }, t('rule_add_condition'));

  container.append(
    el('div', { class: 'rf-block' },
      el('h4', {}, t('rule_section_conditions')),
      condList,
      condAdd,
    ),
  );

  function redrawConditions() {
    condList.replaceChildren();
    rule.conditions.forEach((c, i) => condList.append(condRow(c, i)));
  }

  function condRow(c, idx) {
    const row = el('div', { class: 'rf-row cond-row' });

    const fieldSel = makeSelect(FIELDS, c.field, (v) => {
      c.field = v;
      // нормализуем оператор и значение под новый тип поля
      const ops = opsForField(v);
      if (!ops.includes(c.op)) c.op = ops[0];
      if (v === 'attachment') { delete c.value; delete c.unit; }
      if (v === 'size') { c.value = Number(c.value) || 0; c.unit = c.unit || 'KB'; }
      if (v !== 'header') delete c.headerName;
      redrawConditions();
    });
    row.append(fieldSel);

    if (c.field === 'header') {
      const hdr = el('input', {
        type: 'text', placeholder: t('rule_header_name_placeholder'),
        value: c.headerName || '',
      });
      hdr.addEventListener('input', () => { c.headerName = hdr.value; });
      row.append(hdr);
    }

    const opSel = el('select');
    for (const op of opsForField(c.field)) {
      const o = el('option', { value: op }, t('op_' + op));
      if (op === c.op) o.selected = true;
      opSel.append(o);
    }
    opSel.addEventListener('change', () => { c.op = opSel.value; });
    row.append(opSel);

    if (c.field === 'size') {
      const inp = el('input', {
        type: 'number', min: '0', placeholder: t('rule_size_placeholder'),
        value: c.value ?? '',
      });
      inp.addEventListener('input', () => { c.value = Number(inp.value) || 0; });
      const unitSel = el('select');
      for (const u of ['KB', 'MB']) {
        const o = el('option', { value: u }, t(u === 'KB' ? 'size_kb' : 'size_mb'));
        if ((c.unit || 'KB') === u) o.selected = true;
        unitSel.append(o);
      }
      unitSel.addEventListener('change', () => { c.unit = unitSel.value; });
      row.append(inp, unitSel);
    } else if (c.field !== 'attachment') {
      const placeholder = (c.field === 'from' || c.field === 'to' || c.field === 'cc')
        ? t('rule_email_placeholder')
        : t('rule_value_placeholder');
      const inp = el('input', {
        type: 'text', placeholder,
        value: Array.isArray(c.value) ? c.value.join(', ') : (c.value ?? ''),
      });
      inp.addEventListener('input', () => {
        c.value = c.op === 'contains_any'
          ? inp.value.split(',').map(s => s.trim()).filter(Boolean)
          : inp.value;
      });
      row.append(inp);
    }

    row.append(el('button', {
      type: 'button', class: 'icon-btn',
      'aria-label': t('rule_remove_condition'), title: t('rule_remove_condition'),
      on: { click: () => { rule.conditions.splice(idx, 1); redrawConditions(); } },
    }, '✕'));

    return row;
  }

  if (rule.conditions.length === 0) rule.conditions.push(defaultCondition());
  redrawConditions();

  // ── Действия ──────────────────────────────────────────────────────────
  const actList = el('div', { class: 'rows' });
  const actAdd = el('button', {
    type: 'button', class: 'link-btn',
    on: { click: () => {
      rule.actions.push(defaultAction(folders));
      redrawActions();
    } },
  }, t('rule_add_action'));

  container.append(
    el('div', { class: 'rf-block' },
      el('h4', {}, t('rule_section_actions')),
      actList,
      actAdd,
    ),
  );

  function redrawActions() {
    actList.replaceChildren();
    rule.actions.forEach((a, i) => actList.append(actRow(a, i)));
  }

  function actRow(a, idx) {
    const row = el('div', { class: 'rf-action-row act-row' });

    const typeSel = makeSelect(ACTIONS, a.type, (v) => {
      a.type = v;
      delete a.folder; delete a.address;
      if (v === 'fileinto' || v === 'copy') a.folder = folders[0]?.path || '';
      if (v === 'redirect') a.address = '';
      redrawActions();
    });
    row.append(typeSel);

    if (a.type === 'fileinto' || a.type === 'copy') {
      if (folders && folders.length) {
        const sel = el('select');
        for (const f of folders) {
          // value — raw IMAP-path (Sieve/Dovecot его понимают как есть);
          // текст — декодированный modified-UTF-7 для читаемости (кириллица).
          const display = decodeIMAPUTF7(f.path || f.name || '');
          const o = el('option', { value: f.path }, display || '—');
          if (f.path === a.folder) o.selected = true;
          sel.append(o);
        }
        sel.addEventListener('change', () => { a.folder = sel.value; });
        if (!a.folder && folders.length) a.folder = folders[0].path;
        row.append(sel);
      } else {
        const inp = el('input', {
          type: 'text', placeholder: 'INBOX/Folder',
          value: a.folder || '',
        });
        inp.addEventListener('input', () => { a.folder = inp.value; });
        row.append(inp);
      }
    } else if (a.type === 'redirect') {
      const inp = el('input', {
        type: 'email', placeholder: t('rule_email_placeholder'),
        value: a.address || '',
      });
      inp.addEventListener('input', () => { a.address = inp.value; });
      row.append(inp);
      row.append(el('div', { class: 'rf-warn warn' }, t('warn_redirect')));
    } else if (a.type === 'discard') {
      row.append(el('div', { class: 'rf-warn warn' }, t('warn_discard')));
    }

    row.append(el('button', {
      type: 'button', class: 'icon-btn',
      'aria-label': t('rule_remove_action'), title: t('rule_remove_action'),
      on: { click: () => { rule.actions.splice(idx, 1); redrawActions(); } },
    }, '✕'));

    return row;
  }

  if (rule.actions.length === 0) rule.actions.push(defaultAction(folders));
  redrawActions();

  // ── stop after ────────────────────────────────────────────────────────
  const stopChk = el('input', { type: 'checkbox' });
  stopChk.checked = rule.stopAfter !== false;
  container.append(
    el('label', { class: 'rf-checkrow inline' },
      stopChk, ' ', t('rule_stop_after'),
    ),
  );

  // ── Ошибка + кнопки ───────────────────────────────────────────────────
  const errBanner = el('p', { class: 'rf-error error-banner', hidden: true });
  container.append(errBanner);

  const cancelBtn = el('button', {
    type: 'button',
    on: { click: () => onCancel && onCancel() },
  }, t('btn_cancel'));

  const saveBtn = el('button', {
    type: 'button', class: 'primary',
    on: { click: onSubmit },
  }, t('btn_save'));

  container.append(
    el('div', { class: 'rf-buttons dialog-actions' }, cancelBtn, saveBtn),
  );

  function showError(text) {
    errBanner.textContent = text || '';
    errBanner.hidden = !text;
  }

  function collect() {
    rule.name = nameInput.value.trim();
    rule.active = activeChk.checked;
    rule.matchAll = matchSel.value === 'all';
    rule.stopAfter = stopChk.checked;
  }

  async function onSubmit() {
    collect();
    const localErr = validateRule(rule);
    if (localErr) { showError(localErr); return; }
    showError('');
    if (!onSave) return;
    saveBtn.disabled = true;
    try {
      const res = await onSave(rule);
      // Совместимость с двумя контрактами:
      //   * options.js: возвращает строку с ошибкой (или undefined при успехе);
      //   * popup.js:   ничего не возвращает, рассчитывает на throw из send().
      if (res && typeof res === 'object' && res.error) {
        showError(typeof res.error === 'string' ? res.error : (res.error.message || String(res.error)));
      } else if (typeof res === 'string') {
        showError(res);
      }
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
    } finally {
      saveBtn.disabled = false;
    }
  }

  return {
    destroy() { container.replaceChildren(); },
    refresh() { redrawConditions(); redrawActions(); },
  };
}
