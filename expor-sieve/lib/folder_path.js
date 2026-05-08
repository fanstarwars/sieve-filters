// lib/folder_path.js — единый инструмент работы с именами/путями папок.
//
// Существуют ТРИ разных формата одного и того же пути, которые встречаются
// в проекте; до этого модуля каждый файл нормализовал по-своему, что давало
// рассинхрон (видимо в форме / молча не работающие фильтры на сервере).
//
//   1. TB-canonical — то, что отдаёт `browser.folders.query()` в `f.path`.
//      Для IMAP это `/INBOX/&BCAEPgRBBEEESwQ7BDoEOA-` — IMAP modified UTF-7
//      с ведущим '/'. Для POP3/Local — `/Inbox/Sub` (декодированный URI).
//      См. mozilla/comm-central ExtensionAccounts.sys.mjs:getFolderPath.
//
//   2. Sieve-raw — то, что Dovecot/Pigeonhole принимает в `fileinto "...";`.
//      Тот же IMAP-modified-UTF-7, но БЕЗ ведущего '/'. Pigeonhole отбивает
//      имена с leading separator («Begins with hierarchy separator»).
//
//   3. Canonical (наш внутренний формат) — decoded Unicode, без leading '/'.
//      Удобно сравнивать, удобно показывать, идемпотентно: toCanonical(canon)
//      возвращает ту же строку.
//
// Контракт: ВСЕ места, где имя папки сохраняется (action.folder в Rule)
// или сравнивается, проходят через toCanonical. Сериализация в Sieve —
// через toSieve (это место единственное, где идёт mUTF7-кодирование).
//
// Импорт TB Quick Filter (см. local_filter_mapper.js) даёт `targetFolderPath`
// в виде Unicode (Experiment-API строит путь из nsIMsgFolder.name, который
// уже декодирован), — toCanonical его примет без изменений; toSieve при
// записи закодирует обратно в mUTF7. Это и есть фикс «фильтрация молча
// не работает» из bug2.

import { decodeIMAPUTF7, encodeIMAPUTF7 } from './imap_utf7.js';

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
 * Привести к виду, который кладётся в Sieve-script: IMAP modified UTF-7
 * без ведущего '/'. Если на входе уже mUTF7 — encode идемпотентен (ASCII
 * printable проходит как есть; '&' → '&-' — это РАЗОВОЕ срабатывание, его
 * мы избегаем тем что сначала декодируем, а потом кодируем).
 *
 * @param {string} path
 * @returns {string}
 */
export function toSieve(path) {
  return encodeIMAPUTF7(toCanonical(path));
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
