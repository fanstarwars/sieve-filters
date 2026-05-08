// Объектная модель правила, которой обмениваются UI и SieveAdapter.
// Не путать с моделью ProtonMail/sieve.js — наша обёртка несёт UI-метаданные
// (id, name, mailcowId, order, stopAfter), а сериализацию в Sieve выполняет
// SieveAdapter поверх sieve.js.

/**
 * @typedef {Object} Condition
 * @property {'from'|'to'|'cc'|'subject'|'header'|'size'|'attachment'} field
 * @property {string} [headerName]                              // только если field === 'header'
 * @property {'contains'|'not_contains'|'is'|'starts'|'ends'|'contains_any'
 *          |'gt'|'lt'|'has_attachment'|'no_attachment'} op
 * @property {string|string[]|number} [value]                   // массив для contains_any, число для size
 * @property {'KB'|'MB'} [unit]                                 // только для size
 */

/**
 * @typedef {Object} Action
 * @property {'fileinto'|'copy'|'mark_read'|'flag'|'redirect'|'discard'|'trash'|'tag'} type
 * @property {string} [folder]                                  // для fileinto/copy
 * @property {string} [address]                                 // для redirect
 * @property {string[]} [keywords]                              // для tag (IMAP keywords c префиксом '$')
 */

/**
 * @typedef {Object} Rule
 * @property {string} id                  локальный UUID
 * @property {number} [mailcowId]         id фильтра в mailcow после первого save
 * @property {string} name                то же, что script_desc в mailcow
 * @property {boolean} active
 * @property {boolean} matchAll           true=AND (allof), false=OR (anyof)
 * @property {Condition[]} conditions
 * @property {Action[]} actions
 * @property {boolean} stopAfter
 * @property {number} order
 */

export const RULE_MARKER = '# expor-sieve v1 managed';

export function newRule() {
  return {
    id: crypto.randomUUID(),
    name: '',
    active: true,
    matchAll: true,
    conditions: [],
    actions: [],
    // По умолчанию выключено: пользователи путают «остановить на этом
    // правиле» с «выполнить это правило» и теряют последующие совпадения
    // (письмо ушло в первую папку, прочие правила не отработали). Если
    // нужно остановить — есть видимый чекбокс в Editor.
    stopAfter: false,
    order: 0,
  };
}

/**
 * @param {Rule} rule
 * @returns {string|null} текст ошибки или null если правило валидно
 */
export function validateRule(rule) {
  if (!rule.name || !rule.name.trim()) return 'Название правила обязательно';
  if (rule.conditions.length === 0) return 'Должно быть хотя бы одно условие';
  if (rule.actions.length === 0) return 'Должно быть хотя бы одно действие';
  for (const a of rule.actions) {
    if ((a.type === 'fileinto' || a.type === 'copy') && !a.folder) {
      return 'Для перемещения/копирования укажите папку';
    }
    if (a.type === 'redirect' && !a.address) {
      return 'Для перенаправления укажите адрес';
    }
    if (a.type === 'tag') {
      if (!Array.isArray(a.keywords) || a.keywords.length === 0) {
        return 'Выберите хотя бы одну метку';
      }
      // Инвариант: каждый keyword начинается с '$' (IMAP user-keyword).
      // Без '$' Pigeonhole воспримет это как fragment системного флага и
      // может конфликтовать с Sieve `imap4flags` system-флагами.
      for (const k of a.keywords) {
        if (typeof k !== 'string' || !k.startsWith('$')) {
          return 'Метка должна начинаться с символа $';
        }
      }
    }
  }
  return null;
}
