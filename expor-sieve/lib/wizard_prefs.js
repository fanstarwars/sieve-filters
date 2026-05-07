// lib/wizard_prefs.js — поведенческие preferences для Wizard'а и Editor'а.
//
// Хранение: browser.storage.local.wizardPrefs (объект с полями).
// Ключ существует начиная с v0.10.0; при отсутствии используются DEFAULTS.
//
// Поля:
//   stripSubjectPrefixes: boolean   — удалять "Re:", "Fwd:" и т.п. при
//                                     создании фильтра «По теме».
//   subjectPrefixes:      string[]  — список префиксов (без CR, без trailing
//                                     ":" — двоеточие добавляется при матче).
//   hideSystemFolders:    boolean   — скрывать Trash/Junk/Drafts/… в picker'ах.
//   excludeOwnAddresses:  boolean   — отключать шаблон «По адресату» если
//                                     обнаружен собственный email юзера.
//   newRulePosition:      'end' | 'top' — куда вставлять новое правило
//                                          в Manager'е (умолчание: 'end').
//
// Нормализация (saveWizardPrefs):
//   * subjectPrefixes — массив непустых строк (trim, фильтр пустых);
//   * newRulePosition — только 'top' или 'end' (всё остальное → 'end');
//   * остальные поля — bool (boolean coercion).

export const DEFAULTS = Object.freeze({
  stripSubjectPrefixes: true,
  subjectPrefixes: ['Re:', 'Fwd:', 'Aw:', 'Wg:', 'Antw:'],
  hideSystemFolders: true,
  excludeOwnAddresses: true,
  newRulePosition: 'end',
});

// Возвращает объект с дефолтами, проставленными для отсутствующих полей.
// Не мутирует raw.
function applyDefaults(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.stripSubjectPrefixes === 'boolean') {
      out.stripSubjectPrefixes = raw.stripSubjectPrefixes;
    }
    if (Array.isArray(raw.subjectPrefixes)) {
      const cleaned = raw.subjectPrefixes
        .map((s) => String(s == null ? '' : s).trim())
        .filter(Boolean);
      out.subjectPrefixes = cleaned.length ? cleaned : DEFAULTS.subjectPrefixes.slice();
    }
    if (typeof raw.hideSystemFolders === 'boolean') {
      out.hideSystemFolders = raw.hideSystemFolders;
    }
    if (typeof raw.excludeOwnAddresses === 'boolean') {
      out.excludeOwnAddresses = raw.excludeOwnAddresses;
    }
    if (raw.newRulePosition === 'top' || raw.newRulePosition === 'end') {
      out.newRulePosition = raw.newRulePosition;
    }
  }
  // subjectPrefixes — всегда новая копия (защита от внешних мутаций).
  out.subjectPrefixes = out.subjectPrefixes.slice();
  return out;
}

/**
 * Загрузить wizardPrefs из storage с применением дефолтов.
 * Никогда не бросает: при отсутствии storage возвращает чистые DEFAULTS.
 */
export async function loadWizardPrefs() {
  try {
    if (typeof browser === 'undefined' || !browser.storage || !browser.storage.local) {
      return applyDefaults(null);
    }
    const raw = await browser.storage.local.get('wizardPrefs');
    return applyDefaults(raw && raw.wizardPrefs);
  } catch {
    return applyDefaults(null);
  }
}

/**
 * Сохранить partial-patch в wizardPrefs. Слияние с текущим состоянием +
 * валидация. Возвращает финальный объект (после санитизации).
 */
export async function saveWizardPrefs(patch) {
  const cur = await loadWizardPrefs();
  const merged = { ...cur, ...(patch || {}) };
  // Через applyDefaults — единый путь нормализации.
  const next = applyDefaults(merged);
  if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
    await browser.storage.local.set({ wizardPrefs: next });
  }
  return next;
}

// ─── helpers (pure) ─────────────────────────────────────────────────────────

/**
 * Удаляет повторяющиеся префиксы из начала subject'а.
 * - Регистр игнорируется ("Re:", "RE:", "re:").
 * - Допускает любое кол-во whitespace между префиксами.
 * - Префиксы могут быть указаны без trailing ":" — оба варианта поддерживаются.
 * - Если после очистки строка пустая (или содержала только префиксы) —
 *   возвращает оригинал (trimmed), чтобы не сломать фильтр на пустом subject.
 *
 * @param {string} subject
 * @param {string[]} [prefixes]
 * @returns {string}
 */
export function cleanSubjectForName(subject, prefixes) {
  const original = String(subject == null ? '' : subject);
  let s = original.trim();
  if (!s) return original;

  const list = (Array.isArray(prefixes) ? prefixes : DEFAULTS.subjectPrefixes)
    .map((p) => String(p == null ? '' : p).trim())
    .filter(Boolean)
    // Удаляем trailing ":" — у нас он добавляется в regexp как опциональный.
    .map((p) => p.replace(/:+$/, ''))
    .filter(Boolean);

  if (list.length === 0) return s;

  // Сортировка по длине (descending) чтобы более длинные префиксы матчились
  // первыми (например "Antw" раньше "An", если кто-то добавит).
  list.sort((a, b) => b.length - a.length);

  const escaped = list.map(escapeRegex).join('|');
  // Один префикс с двоеточием и whitespace вокруг.
  // Двоеточие обязательно — иначе мы съедим обычные слова, начинающиеся с "Re".
  const re = new RegExp('^\\s*(?:' + escaped + ')\\s*:\\s*', 'i');

  let prev;
  do {
    prev = s;
    s = s.replace(re, '');
  } while (s !== prev);

  s = s.trim();
  if (!s) return original.trim();
  return s;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
