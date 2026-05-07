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
 * @property {'fileinto'|'copy'|'mark_read'|'flag'|'redirect'|'discard'|'trash'} type
 * @property {string} [folder]                                  // для fileinto/copy
 * @property {string} [address]                                 // для redirect
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
    stopAfter: true,
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
  }
  return null;
}
