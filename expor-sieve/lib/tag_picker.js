// lib/tag_picker.js — общий UI-хелпер для выбора Thunderbird-меток
// (IMAP keywords с префиксом '$').
//
// Используется из:
//   - editor/editor.js   (action 'tag' внутри Filter Editor)
//   - lib/rule_form.js   (action 'tag' внутри popup/options renderRuleForm)
//   - wizard/wizard.js   (опциональный "Добавить метки" чекбокс)
//
// API:
//   listAvailableTags()           → Promise<MessageTag[]>
//                                   { key, tag, color, ordinal } — ровно
//                                   тот формат, что отдаёт
//                                   browser.messages.tags.list().
//                                   Возвращает [] если API недоступно.
//
//   buildTagChips(opts) → HTMLElement
//     opts.selected: string[]       начальный набор keys (мутируется
//                                   через onChange — caller должен
//                                   синхронизировать с моделью).
//     opts.allTags:  MessageTag[]   из listAvailableTags()
//     opts.onChange: (keys) => void колбэк после toggle / fallback-input
//     opts.t:        (key) => string i18n-функция (передаём, чтобы lib
//                                   не зависела от lib/rule_form.js,
//                                   которая в свою очередь зависит от
//                                   browser.i18n).
//
// Граничные случаи:
//   * allTags пуст → fallback на текстовый input (через запятую).
//   * keyword из selected, которого нет в allTags → "orphan" чип
//     (выводится без цвета, серый, чтобы юзер увидел и решил).

/**
 * @returns {Promise<Array<{key:string, tag:string, color:string, ordinal:string}>>}
 */
export async function listAvailableTags() {
  try {
    if (typeof browser !== 'undefined'
        && browser.messages
        && browser.messages.tags
        && typeof browser.messages.tags.list === 'function') {
      const arr = await browser.messages.tags.list();
      return Array.isArray(arr) ? arr : [];
    }
  } catch (_e) {
    // ignore — fallback на пустой список (UI покажет text-input).
  }
  return [];
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
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

/**
 * @param {object} opts
 * @param {string[]} opts.selected
 * @param {Array<{key:string, tag:string, color:string}>} opts.allTags
 * @param {(keys: string[]) => void} opts.onChange
 * @param {(key: string) => string} [opts.t]
 * @returns {HTMLElement}
 */
export function buildTagChips({ selected, allTags, onChange, t }) {
  const tt = typeof t === 'function' ? t : (k) => k;

  const wrap = el('div', { class: 'tag-picker' });

  // Fallback: API недоступен ИЛИ у пользователя 0 меток — показываем
  // текстовый input, в котором юзер пишет keywords через запятую.
  if (!Array.isArray(allTags) || allTags.length === 0) {
    const hint = el('div', { class: 'tag-picker-hint' },
      tt('tag_picker_no_tags') || 'В Thunderbird не найдено меток. Введите ключи через запятую (каждый начинается с $):');
    const input = el('input', {
      type: 'text',
      class: 'tag-picker-fallback',
      placeholder: '$label1, $label3',
      value: (selected || []).join(', '),
    });
    input.addEventListener('input', () => {
      const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      onChange(parts);
    });
    wrap.append(hint, input);
    return wrap;
  }

  // Нормальный путь: список chips.
  // Ключи, которые в selected, но отсутствуют в allTags, — orphan.
  const keysInTb = new Set(allTags.map((tg) => tg.key));
  const orphans = (selected || []).filter((k) => !keysInTb.has(k));

  const chipsRow = el('div', { class: 'tag-chips' });

  function isSelected(key) {
    return (selected || []).includes(key);
  }

  function toggle(key) {
    const idx = selected.indexOf(key);
    if (idx >= 0) selected.splice(idx, 1);
    else selected.push(key);
    onChange(selected.slice());
    // Перерендерим визуальные состояния не пересоздавая весь wrap —
    // просто пометим chip'ы заново.
    for (const node of chipsRow.querySelectorAll('[data-chip-key]')) {
      const k = node.getAttribute('data-chip-key');
      const sel = isSelected(k);
      node.classList.toggle('is-selected', sel);
      node.setAttribute('aria-pressed', sel ? 'true' : 'false');
    }
  }

  for (const tg of allTags) {
    const sel = isSelected(tg.key);
    const chip = el('button', {
      type: 'button',
      class: 'tag-chip' + (sel ? ' is-selected' : ''),
      'data-chip-key': tg.key,
      'aria-pressed': sel ? 'true' : 'false',
      title: tg.key,
      style: `--chip-color: ${tg.color || '#888'}`,
      on: { click: () => toggle(tg.key) },
    },
      el('span', { class: 'tag-chip-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'tag-chip-label' }, tg.tag || tg.key),
    );
    chipsRow.append(chip);
  }

  for (const orphanKey of orphans) {
    const chip = el('button', {
      type: 'button',
      class: 'tag-chip is-orphan is-selected',
      'data-chip-key': orphanKey,
      'aria-pressed': 'true',
      title: (tt('tag_picker_orphan_title') || 'Метка отсутствует в Thunderbird') + ': ' + orphanKey,
      on: { click: () => toggle(orphanKey) },
    },
      el('span', { class: 'tag-chip-dot tag-chip-dot-orphan', 'aria-hidden': 'true' }),
      el('span', { class: 'tag-chip-label' }, orphanKey),
    );
    chipsRow.append(chip);
  }

  wrap.append(chipsRow);
  return wrap;
}

/**
 * Дефолтный keywords для нового tag-action. Берём первый доступный ключ
 * (или $label1 как заглушку, если allTags пуст). Caller отвечает за то,
 * чтобы validateRule прошёл (минимум один keyword).
 */
export function defaultTagKeywords(allTags) {
  if (Array.isArray(allTags) && allTags.length > 0 && allTags[0].key) {
    return [allTags[0].key];
  }
  return [];
}
