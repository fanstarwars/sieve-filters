// lib/folder_path.js — единый инструмент работы с именами/путями папок.
//
// Форматы, встречающиеся в проекте:
//
//   1. TB-canonical — `browser.folders.query()` в `f.path`. Для IMAP это
//      `/INBOX/&BCAEPgRBBEEESwQ7BDoEOA-` (mUTF7 с ведущим '/'). Для POP3/Local —
//      `/Inbox/Sub`. См. mozilla/comm-central ExtensionAccounts.sys.mjs:getFolderPath.
//
//   2. Sieve и Pigeonhole принимают имя в `fileinto "..."` в **UTF-8 / Unicode**.
//      mUTF7 — это формат IMAP-протокола НА ПРОВОДЕ; Sieve работает уровнем выше,
//      на уже декодированных именах. Подтверждено вживую: на нашем Dovecot
//      `doveadm mailbox status "INBOX/&BBAELQQcBBc-"` → "Mailbox doesn't exist",
//      а `doveadm mailbox status "INBOX/АЭМЗ"` → exists. Поэтому в Sieve пишем
//      Unicode, без leading '/'. Pigeonhole сам конвертирует в IMAP-уровень
//      при необходимости.
//
//   3. Canonical (наш внутренний формат) — decoded Unicode без leading '/'.
//      Идемпотентно: toCanonical(canon) === canon.
//
// Контракт: action.folder в Rule всегда хранится в canonical-форме. Сериализация
// в Sieve — через toSieve (= тот же canonical). Сравнения с f.path из TB —
// через findMatch (нормализует обе стороны).

import { decodeIMAPUTF7 } from './imap_utf7.js';

const stripLeadingSlash = (s) => String(s ?? '').replace(/^\/+/, '');

/**
 * Привести к каноническому виду: decoded Unicode, без leading '/'.
 * Идемпотентно. Используется как ключ для сравнения и как форма хранения
 * в `action.folder`.
 *
 * @param {string} path
 * @returns {string}
 */
export function toCanonical(path) {
  const stripped = stripLeadingSlash(path);
  if (!stripped) return '';
  return decodeIMAPUTF7(stripped);
}

/**
 * Привести к виду, который кладётся в Sieve-script: Unicode/UTF-8 без
 * ведущего '/'. Pigeonhole принимает fileinto-аргумент в Unicode (см.
 * хедер модуля). Совпадает с canonical.
 *
 * @param {string} path
 * @returns {string}
 */
export function toSieve(path) {
  return toCanonical(path);
}

/**
 * Привести к виду для UI (читаемая Unicode-строка без leading '/').
 * Сейчас совпадает с canonical, но контракт отдельный — если в будущем
 * захотим разные правила (например, обрезать namespace prefix) — менять
 * нужно будет только тут.
 *
 * @param {string} path
 * @returns {string}
 */
export function toDisplay(path) {
  return toCanonical(path);
}

/**
 * Сравнение двух путей в каноне.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function equals(a, b) {
  return toCanonical(a) === toCanonical(b);
}

/**
 * Найти папку в массиве `folders` (как у `browser.folders.query()`),
 * соответствующую `wanted`. Возвращает folder-объект или null.
 *
 * Сначала канонически (decoded Unicode без слэша). Если не нашлось —
 * пробует case-insensitive: на ряде серверов IMAP-имена нечувствительны
 * к регистру (INBOX vs Inbox vs inbox).
 *
 * @param {string} wanted
 * @param {Array<{path?: string, name?: string}>} folders
 * @returns {object|null}
 */
export function findMatch(wanted, folders) {
  if (!wanted || !Array.isArray(folders) || folders.length === 0) return null;
  const w = toCanonical(wanted);
  if (!w) return null;
  for (const f of folders) {
    if (toCanonical(f && f.path) === w) return f;
  }
  const wLower = w.toLowerCase();
  for (const f of folders) {
    if (toCanonical(f && f.path).toLowerCase() === wLower) return f;
  }
  return null;
}
