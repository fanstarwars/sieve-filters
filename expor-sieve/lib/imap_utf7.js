// IMAP modified UTF-7 (RFC 3501 §5.1.3) — декодер для отображения mailbox-имён.
//
// Зачем: Thunderbird `browser.folders.query()` возвращает path в IMAP-нотации,
// например "INBOX/&BCAEMARBBEEESwQ7BDoEMA-" вместо "INBOX/Россылки".
// Sieve / Dovecot ожидают raw IMAP-имя; UI должен показать декодированное.
//
// Кодирование пропускаем — нам не нужно (mailcow и Dovecot работают с raw).
//
// Алгоритм декодирования:
//   - "&-"        → "&"
//   - "&<base64>-" → base64 → UTF-16BE → строка
//     (но base64 здесь модифицированный: '/' заменён на ',')
//   - всё остальное (printable ASCII) — как есть.

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
