// IMAP modified UTF-7 (RFC 3501 §5.1.3) — декодер и кодер для mailbox-имён.
//
// Зачем: Thunderbird `browser.folders.query()` возвращает path в IMAP-нотации,
// например "INBOX/&BCAEPgRBBEEESwQ7BDoEOA-" вместо "INBOX/Россылки".
// Dovecot/Pigeonhole тоже принимает имя только в этой нотации — поэтому при
// сериализации в Sieve нужна кодировка обратно (см. lib/folder_path.js).
// UI показывает декодированную версию.
//
// Алгоритм декодирования:
//   - "&-"         → "&"
//   - "&<base64>-" → base64 → UTF-16BE → строка
//     (base64 здесь модифицированный: '/' заменён на ',')
//   - всё остальное (printable ASCII 0x20-0x7E) — как есть.
//
// Алгоритм кодирования (RFC 3501 §5.1.3):
//   - ASCII printable (0x20-0x7E), кроме '&' — как есть; '&' → "&-".
//   - Любой блок non-ASCII символов: интерпретируются как UTF-16 code units,
//     записываются как UTF-16BE байты, base64 (без '=' padding, '/' → ','),
//     обёрнуто в "&…-".

/**
 * @param {string} s   IMAP modified UTF-7 строка
 * @returns {string}   читаемая Unicode строка
 */
export function decodeIMAPUTF7(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s || '';
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '&') {
      out += c;
      i++;
      continue;
    }
    // нашли '&' — ищем закрывающий '-'
    const end = s.indexOf('-', i + 1);
    if (end === -1) {
      // битая строка — оставляем как есть
      out += s.slice(i);
      break;
    }
    if (end === i + 1) {
      // "&-" → "&"
      out += '&';
      i = end + 1;
      continue;
    }
    const b64 = s.slice(i + 1, end).replace(/,/g, '/');
    try {
      const bytes = atob(padBase64(b64));
      // bytes — UTF-16 big-endian
      let str = '';
      for (let j = 0; j + 1 < bytes.length; j += 2) {
        const code = (bytes.charCodeAt(j) << 8) | bytes.charCodeAt(j + 1);
        str += String.fromCharCode(code);
      }
      out += str;
    } catch {
      // невалидный base64 — оставляем сырое значение чтобы юзер мог хоть что-то увидеть
      out += s.slice(i, end + 1);
    }
    i = end + 1;
  }
  return out;
}

function padBase64(b64) {
  const m = b64.length % 4;
  return m === 0 ? b64 : b64 + '='.repeat(4 - m);
}

/**
 * @param {string} s   читаемая Unicode строка
 * @returns {string}   IMAP modified UTF-7
 */
export function encodeIMAPUTF7(s) {
  if (typeof s !== 'string' || s.length === 0) return s || '';
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7E) {
      out += s[i] === '&' ? '&-' : s[i];
      i++;
      continue;
    }
    // Собираем максимальный блок non-ASCII подряд (§5.1.3: один shift на блок).
    let bin = '';
    while (i < s.length) {
      const cc = s.charCodeAt(i);
      if (cc >= 0x20 && cc <= 0x7E) break;
      // UTF-16BE: high byte, затем low byte. charCodeAt даёт code unit,
      // surrogates записываются как два code unit'а — это то, что и хочет mUTF7.
      bin += String.fromCharCode((cc >> 8) & 0xFF) + String.fromCharCode(cc & 0xFF);
      i++;
    }
    const b64 = btoa(bin).replace(/=+$/, '').replace(/\//g, ',');
    out += '&' + b64 + '-';
  }
  return out;
}
