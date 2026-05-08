// SieveAdapter — конвертер между нашей моделью Rule (см. rule_model.js) и
// текстом Sieve-скрипта.
//
// ВАЖНО про ProtonMail/sieve.js: после изучения исходников выяснилось, что
// эта библиотека НЕ генерирует Sieve-текст — она конвертирует только между
// двумя JS-объектами (simple representation <-> filter tree). Финальную
// сериализацию tree -> текст у ProtonMail делает их собственный backend.
// Поэтому мы строим Sieve-скрипт вручную (см. ruleToSieve ниже). Vendored
// файл vendor/sieve.js остаётся как референс/заготовка на будущее, но в
// рантайме адаптера не используется.
//
// Round-trip: sieveToRule опознаёт скрипт по маркеру в первой строке и
// парсит только наш диалект. Произвольный Sieve не поддерживается.
//
// ── Версии формата ────────────────────────────────────────────────────────
//
// v1 (legacy):  один Rule == один mailcow filter; sieve-скрипт начинается
//               с `# expor-sieve v1 managed`, далее опциональный `# order:`
//               и единственный if-блок. Сохранён для миграции.
//
// v2:           ВСЕ правила пользователя сериализуются в один combined
//               sieve-скрипт, который кладётся в один mailcow filter с
//               active=1. Формат:
//
//                 # expor-sieve v2 managed
//                 require ["fileinto","imap4flags",...];   # агрегированные
//
//                 # >>> rule: <uuid> active=1 order=0 matchAll=1 stopAfter=1
//                 # name: <имя правила>
//                 if anyof ( ... ) { ... }
//                 # <<< rule: <uuid>
//
//                 # >>> rule: <uuid2> active=0 order=1 matchAll=0 stopAfter=0
//                 # name: <имя 2>
//                 if false {                                # активность
//                   ...                                     # хранится через
//                 }                                         # обёртку if false
//                 # <<< rule: <uuid2>
//
// Маппинг см. в TZ.md §8.

import { toSieve, toCanonical } from './folder_path.js';

export const RULE_MARKER_V1 = '# expor-sieve v1 managed';
export const RULE_MARKER_V2 = '# expor-sieve v2 managed';

// Backward-compat: старый код импортирует RULE_MARKER (== v1).
export const RULE_MARKER = RULE_MARKER_V1;

// Compromise on attachment detection.
// Полноценная проверка вложений в Sieve требует расширения `body` (RFC 5173)
// или `mime` — оба тяжёлые и не всегда включены в mailcow по умолчанию.
// Для MVP детектируем простым `header :contains "content-type" "multipart/"`,
// что покрывает multipart/mixed и multipart/related (большинство писем с
// аттачментами). Это false-positive дружественный (письма без вложений с
// inline-картинками тоже попадут), но безопасный по false-negative.
// Расширение в этап 2: переключиться на `body :raw :contains "Content-Disposition: attachment"`.
const ATTACHMENT_HEADER = 'content-type';
const ATTACHMENT_VALUE = 'multipart/';

// ---------------------------------------------------------------------------
// Sieve string escaping (RFC 5228 §2.4.2)
// ---------------------------------------------------------------------------

function quoteSieveString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function quoteList(values) {
  if (values.length === 1) return quoteSieveString(values[0]);
  return '[' + values.map(quoteSieveString).join(', ') + ']';
}

// ---------------------------------------------------------------------------
// Header name normalisation for `header` test
// ---------------------------------------------------------------------------

function headerForField(cond) {
  switch (cond.field) {
    case 'subject':
      return 'subject';
    case 'header':
      return cond.headerName || '';
    default:
      return null;
  }
}

function addressHeaderForField(field) {
  switch (field) {
    case 'from':
      return 'from';
    case 'to':
      return 'to';
    case 'cc':
      return 'cc';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Build a single Sieve test from a Condition
// ---------------------------------------------------------------------------

function buildTest(cond /* , requires */) {
  // size
  if (cond.field === 'size') {
    const unit = cond.unit === 'MB' ? 'M' : 'K';
    const op = cond.op === 'lt' ? ':under' : ':over';
    const n = Number(cond.value) || 0;
    return `size ${op} ${n}${unit}`;
  }

  // attachment
  if (cond.field === 'attachment') {
    const test = `header :contains ${quoteSieveString(ATTACHMENT_HEADER)} ${quoteSieveString(ATTACHMENT_VALUE)}`;
    return cond.op === 'no_attachment' ? `not ${test}` : test;
  }

  // text-like fields: from/to/cc/subject/header
  const addressHdr = addressHeaderForField(cond.field);
  const headerHdr = headerForField(cond);

  let testKind, headerArg;
  if (addressHdr) {
    testKind = 'address';
    headerArg = addressHdr;
  } else if (headerHdr) {
    testKind = 'header';
    headerArg = headerHdr;
  } else {
    throw new Error(`Unsupported condition field: ${cond.field}`);
  }

  // Operator -> match-type and value transform
  let matchType = ':contains';
  let negate = false;
  let values;

  switch (cond.op) {
    case 'contains':
      matchType = ':contains';
      values = [String(cond.value ?? '')];
      break;
    case 'not_contains':
      matchType = ':contains';
      negate = true;
      values = [String(cond.value ?? '')];
      break;
    case 'is':
      matchType = ':is';
      values = [String(cond.value ?? '')];
      break;
    case 'starts':
      matchType = ':matches';
      values = [String(cond.value ?? '') + '*'];
      break;
    case 'ends':
      matchType = ':matches';
      values = ['*' + String(cond.value ?? '')];
      break;
    case 'contains_any':
      matchType = ':contains';
      values = (Array.isArray(cond.value) ? cond.value : [cond.value]).map(String);
      break;
    default:
      throw new Error(`Unsupported operator: ${cond.op}`);
  }

  const test = `${testKind} ${matchType} ${quoteSieveString(headerArg)} ${quoteList(values)}`;
  return negate ? `not ${test}` : test;
}

// ---------------------------------------------------------------------------
// Build Sieve action lines from an Action
// ---------------------------------------------------------------------------

// Сериализуем имя папки через единый folder_path.toSieve:
//   - снимает leading '/' (Dovecot Pigeonhole иначе отбивает: «Begins with
//     hierarchy separator»);
//   - кодирует не-ASCII в IMAP modified UTF-7 (RFC 3501 §5.1.3).
//     Без этого fileinto "INBOX/Россылки" не сматчит реальную серверную
//     папку, у которой имя на сервере хранится как mUTF7.
function buildAction(action, requires) {
  switch (action.type) {
    case 'fileinto':
      requires.add('fileinto');
      return `fileinto ${quoteSieveString(toSieve(action.folder))};`;
    case 'copy':
      requires.add('fileinto');
      requires.add('copy');
      return `fileinto :copy ${quoteSieveString(toSieve(action.folder))};`;
    case 'mark_read':
      requires.add('imap4flags');
      return `addflag "\\\\Seen";`;
    case 'flag':
      requires.add('imap4flags');
      return `addflag "\\\\Flagged";`;
    case 'redirect':
      // RFC 5228 §4.2: «redirect» отменяет implicit keep — без `:copy`
      // письмо ТОЛЬКО уходит на адрес, локальной копии не остаётся.
      // Это стандартное поведение Sieve и одновременно стандартное
      // непонимание пользователей: «перенаправил → не вижу у себя».
      // Используем `:copy` (RFC 3894) → пересылаем И оставляем копию
      // в Inbox через implicit keep. Если кому-то нужно «уйди и забудь»
      // — он явно сочетает с `discard` через отдельное правило.
      requires.add('copy');
      return `redirect :copy ${quoteSieveString(action.address)};`;
    case 'discard':
      return 'discard;';
    case 'trash':
      requires.add('fileinto');
      return `fileinto "Trash";`;
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

// ---------------------------------------------------------------------------
// Internal: build the if-block (without RULE_MARKER, without require) for
// a single Rule. Returns { ifBlock, requires } — used by both v1
// ruleToSieve() and v2 rulesToCombinedSieve().
// ---------------------------------------------------------------------------

function buildRuleBody(rule) {
  const requires = new Set();

  const tests = (rule.conditions || []).map((c) => buildTest(c, requires));

  const actions = (rule.actions || []).map((a) => buildAction(a, requires));
  if (rule.stopAfter) actions.push('stop;');

  const op = rule.matchAll ? 'allof' : 'anyof';
  let ifBlock;
  if (tests.length === 0) {
    // Defensive — validateRule should prevent this, but produce a always-false guard
    ifBlock = 'if false {\n  ' + actions.join('\n  ') + '\n}\n';
  } else if (tests.length === 1) {
    ifBlock = `if ${tests[0]} {\n  ${actions.join('\n  ')}\n}\n`;
  } else {
    const indented = tests.map((t) => '  ' + t).join(',\n');
    ifBlock = `if ${op} (\n${indented}\n) {\n  ${actions.join('\n  ')}\n}\n`;
  }

  return { ifBlock, requires };
}

// ---------------------------------------------------------------------------
// Public: Rule -> Sieve text (v1 single-rule format, used for previewSieve UI
// и для парсинга legacy v1-фильтров при миграции)
// ---------------------------------------------------------------------------

/**
 * @param {import('./rule_model.js').Rule} rule
 * @returns {string}
 */
export function ruleToSieve(rule) {
  const { ifBlock, requires } = buildRuleBody(rule);

  const requireLine =
    requires.size > 0 ? `require [${[...requires].map(quoteSieveString).join(', ')}];\n\n` : '';

  // order persisted as second-line comment so ↑/↓ survives reload
  // (mailcow has no native order field for filters).
  const orderLine = Number.isFinite(rule.order) ? `# order: ${rule.order}\n` : '';

  return `${RULE_MARKER_V1}\n${orderLine}${requireLine}${ifBlock}`;
}

// ---------------------------------------------------------------------------
// Public: Rule[] -> combined Sieve script (v2)
// ---------------------------------------------------------------------------

/**
 * Сериализует все правила в один combined-script v2.
 *
 * @param {import('./rule_model.js').Rule[]} rules
 * @returns {string}
 */
export function rulesToCombinedSieve(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('rulesToCombinedSieve: rules must be an array');
  }

  // Стабильный порядок: по rule.order (если есть), затем по позиции в массиве.
  const indexed = rules.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const oa = Number.isFinite(a.r.order) ? a.r.order : a.i;
    const ob = Number.isFinite(b.r.order) ? b.r.order : b.i;
    if (oa !== ob) return oa - ob;
    return a.i - b.i;
  });

  const aggRequires = new Set();
  const blocks = [];

  for (const { r } of indexed) {
    const { ifBlock, requires } = buildRuleBody(r);
    for (const q of requires) aggRequires.add(q);

    const id = r.id || (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `rule-${Math.random().toString(36).slice(2)}`);
    const active = r.active !== false ? 1 : 0;
    const order = Number.isFinite(r.order) ? r.order : 0;
    const matchAll = r.matchAll ? 1 : 0;
    const stopAfter = r.stopAfter ? 1 : 0;
    const name = String(r.name || '');

    let body = ifBlock;
    if (active === 0) {
      // Оборачиваем в `if false { ... }`. Внутрь кладём оригинальный if-блок
      // как есть: Pigeonhole допускает любой Sieve внутри блока, но никогда
      // его не выполнит (см. RFC 5228 §5.4 — `false` test всегда не выполняется).
      const indentedBody = ifBlock.split('\n').map((ln) => ln ? '  ' + ln : ln).join('\n');
      body = `if false {\n${indentedBody}}\n`;
    }

    const headerLine = `# >>> rule: ${id} active=${active} order=${order} matchAll=${matchAll} stopAfter=${stopAfter}`;
    const nameLine = `# name: ${name}`;
    const footerLine = `# <<< rule: ${id}`;

    blocks.push(`${headerLine}\n${nameLine}\n${body}${footerLine}\n`);
  }

  const requireLine =
    aggRequires.size > 0
      ? `require [${[...aggRequires].sort().map(quoteSieveString).join(', ')}];\n\n`
      : '';

  const blocksText = blocks.join('\n');

  return `${RULE_MARKER_V2}\n${requireLine}${blocksText}`;
}

// ---------------------------------------------------------------------------
// Public: detectVersion
// ---------------------------------------------------------------------------

export function detectVersion(text) {
  if (typeof text !== 'string') return null;
  const firstLine = (text.split('\n', 1)[0] || '').trim();
  if (firstLine === RULE_MARKER_V2) return 'v2';
  if (firstLine === RULE_MARKER_V1) return 'v1';
  return null;
}

// ---------------------------------------------------------------------------
// Sieve text -> Rule (round-trip parser, single-rule v1 dialect)
// ---------------------------------------------------------------------------

// Tokeniser-lite: pulls quoted strings or string-lists from a position.
// Returns { values: string[], next: numberAfterMatch } or null.
function readStringOrList(src, pos) {
  pos = skipWs(src, pos);
  if (src[pos] === '[') {
    pos++;
    const values = [];
    while (true) {
      pos = skipWs(src, pos);
      if (src[pos] !== '"') return null;
      const r = readQuoted(src, pos);
      if (!r) return null;
      values.push(r.value);
      pos = r.next;
      pos = skipWs(src, pos);
      if (src[pos] === ',') {
        pos++;
        continue;
      }
      if (src[pos] === ']') {
        pos++;
        return { values, next: pos };
      }
      return null;
    }
  }
  if (src[pos] === '"') {
    const r = readQuoted(src, pos);
    if (!r) return null;
    return { values: [r.value], next: r.next };
  }
  return null;
}

function readQuoted(src, pos) {
  if (src[pos] !== '"') return null;
  let i = pos + 1;
  let out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1];
      if (n === '"' || n === '\\') {
        out += n;
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      return { value: out, next: i + 1 };
    }
    out += c;
    i++;
  }
  return null;
}

function skipWs(src, pos) {
  while (pos < src.length && /\s/.test(src[pos])) pos++;
  return pos;
}

// Parse a single test fragment (without trailing comma/paren).
// Returns a Condition or throws.
function parseTest(testStr) {
  const trimmed = testStr.trim();

  // not <test>
  if (/^not\s+/.test(trimmed)) {
    const inner = parseTest(trimmed.replace(/^not\s+/, ''));
    return negateCondition(inner);
  }

  // size :over|:under <n>K|M
  let m = trimmed.match(/^size\s+:(over|under)\s+(\d+)([KM])$/i);
  if (m) {
    return {
      field: 'size',
      op: m[1].toLowerCase() === 'over' ? 'gt' : 'lt',
      value: Number(m[2]),
      unit: m[3].toUpperCase() === 'M' ? 'MB' : 'KB',
    };
  }

  // address|header :match "header" ("v"|[..])
  m = trimmed.match(/^(address|header)\s+:(\w+)\s+(.*)$/i);
  if (!m) throw new Error(`Cannot parse test: ${testStr}`);

  const kind = m[1].toLowerCase();
  const matchType = m[2].toLowerCase();
  const rest = m[3];

  // pull header arg (single quoted string)
  const hdr = readQuoted(rest, 0);
  if (!hdr) throw new Error(`Cannot parse header in test: ${testStr}`);
  const headerName = hdr.value;

  // pull values (string or list)
  const vals = readStringOrList(rest, hdr.next);
  if (!vals) throw new Error(`Cannot parse values in test: ${testStr}`);
  const values = vals.values;

  // attachment marker shortcut: header :contains "content-type" "multipart/"
  if (
    kind === 'header' &&
    matchType === 'contains' &&
    headerName.toLowerCase() === ATTACHMENT_HEADER &&
    values.length === 1 &&
    values[0] === ATTACHMENT_VALUE
  ) {
    return { field: 'attachment', op: 'has_attachment' };
  }

  // map kind+headerName -> field
  let field;
  if (kind === 'address') {
    const n = headerName.toLowerCase();
    if (n === 'from') field = 'from';
    else if (n === 'to') field = 'to';
    else if (n === 'cc') field = 'cc';
    else throw new Error(`Unsupported address header: ${headerName}`);
  } else {
    if (headerName.toLowerCase() === 'subject') field = 'subject';
    else {
      field = 'header';
    }
  }

  // map matchType+values -> op + value
  let op, value;
  if (matchType === 'contains') {
    if (values.length > 1) {
      op = 'contains_any';
      value = values;
    } else {
      op = 'contains';
      value = values[0];
    }
  } else if (matchType === 'is') {
    op = 'is';
    value = values[0];
  } else if (matchType === 'matches') {
    const v = values[0] || '';
    if (v.endsWith('*') && !v.startsWith('*')) {
      op = 'starts';
      value = v.slice(0, -1);
    } else if (v.startsWith('*') && !v.endsWith('*')) {
      op = 'ends';
      value = v.slice(1);
    } else {
      // Fallback: treat as contains for our limited dialect
      op = 'contains';
      value = v.replace(/^\*|\*$/g, '');
    }
  } else {
    throw new Error(`Unsupported match type: :${matchType}`);
  }

  const condition =
    field === 'header'
      ? { field, headerName, op, value }
      : { field, op, value };
  return condition;
}

function negateCondition(cond) {
  switch (cond.op) {
    case 'contains':
      return { ...cond, op: 'not_contains' };
    case 'has_attachment':
      return { ...cond, op: 'no_attachment' };
    default:
      throw new Error(`Cannot negate operator ${cond.op} in our dialect`);
  }
}

// Split a string by `sep` at depth 0 (ignoring brackets, quoted strings).
function splitTopLevel(src, sep) {
  const parts = [];
  let depth = 0;
  let inQuote = false;
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      buf += c;
      if (c === '\\' && i + 1 < src.length) {
        buf += src[i + 1];
        i++;
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      buf += c;
      continue;
    }
    if (c === '[' || c === '(') {
      depth++;
      buf += c;
      continue;
    }
    if (c === ']' || c === ')') {
      depth--;
      buf += c;
      continue;
    }
    if (c === sep && depth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.length) parts.push(buf);
  return parts;
}

// Parse an action statement (without trailing semicolon).
function parseAction(stmt) {
  const trimmed = stmt.trim();

  if (trimmed === 'stop') return { __stop: true };
  if (trimmed === 'discard') return { type: 'discard' };

  // fileinto :copy "folder"
  let m = trimmed.match(/^fileinto\s+:copy\s+(.+)$/);
  if (m) {
    const q = readQuoted(m[1].trim(), 0);
    if (!q) throw new Error(`Bad copy: ${stmt}`);
    // В Sieve-script имя в mUTF7. Кладём в Rule в canonical (decoded Unicode)
    // — это инвариант хранения: см. lib/folder_path.js.
    return { type: 'copy', folder: toCanonical(q.value) };
  }
  // fileinto "folder"
  m = trimmed.match(/^fileinto\s+(.+)$/);
  if (m) {
    const q = readQuoted(m[1].trim(), 0);
    if (!q) throw new Error(`Bad fileinto: ${stmt}`);
    if (q.value === 'Trash') return { type: 'trash' };
    return { type: 'fileinto', folder: toCanonical(q.value) };
  }
  // addflag "\\Seen" / "\\Flagged"
  m = trimmed.match(/^addflag\s+(.+)$/);
  if (m) {
    const q = readQuoted(m[1].trim(), 0);
    if (!q) throw new Error(`Bad addflag: ${stmt}`);
    if (q.value === '\\Seen') return { type: 'mark_read' };
    if (q.value === '\\Flagged') return { type: 'flag' };
    throw new Error(`Unknown flag: ${q.value}`);
  }
  // redirect [:copy] "addr"
  // Поддерживаем обе формы: старые правила (до 0.15.1) — без `:copy`,
  // новые — с `:copy` (см. buildAction). Семантика action в Rule та же:
  // type='redirect' + address. При сохранении мы всегда эмитим `:copy`,
  // так что round-trip конвертирует старые правила к новой форме.
  m = trimmed.match(/^redirect(?:\s+:copy)?\s+(.+)$/);
  if (m) {
    const q = readQuoted(m[1].trim(), 0);
    if (!q) throw new Error(`Bad redirect: ${stmt}`);
    return { type: 'redirect', address: q.value };
  }

  throw new Error(`Unsupported action statement: ${stmt}`);
}

// Locate the first top-level `if ... { ... }` and return the source positions
// of the test condition and the action body. Used by both parseSingleIfBlock
// (which then parses actions) and the if-false unwrapper (which doesn't).
function locateFirstIfBlock(text) {
  const ifIdx = text.search(/\bif\b/);
  if (ifIdx === -1) throw new Error('No `if` block found');

  // From `if` find first `{` at top level.
  let i = ifIdx + 2;
  let depth = 0;
  let inQuote = false;
  let braceStart = -1;
  while (i < text.length) {
    const c = text[i];
    if (inQuote) {
      if (c === '\\' && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (c === '"') inQuote = false;
      i++;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '{' && depth === 0) {
      braceStart = i;
      break;
    }
    i++;
  }
  if (braceStart === -1) throw new Error('Action block start `{` not found');

  // Find matching `}`.
  let braceEnd = -1;
  let bdepth = 1;
  inQuote = false;
  for (let j = braceStart + 1; j < text.length; j++) {
    const c = text[j];
    if (inQuote) {
      if (c === '\\' && j + 1 < text.length) {
        j++;
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      continue;
    }
    if (c === '{') bdepth++;
    else if (c === '}') {
      bdepth--;
      if (bdepth === 0) {
        braceEnd = j;
        break;
      }
    }
  }
  if (braceEnd === -1) throw new Error('Action block end `}` not found');

  return {
    ifIdx,
    condStart: ifIdx + 2,
    condEnd: braceStart,
    bodyStart: braceStart + 1,
    bodyEnd: braceEnd,
  };
}

// Parse a fragment containing exactly one if-block (and surrounding ws).
// Returns { conditions, actions, matchAll, stopAfter }.
function parseSingleIfBlock(text) {
  const loc = locateFirstIfBlock(text);

  const condStr = text.slice(loc.condStart, loc.condEnd).trim();
  const actionsStr = text.slice(loc.bodyStart, loc.bodyEnd).trim();

  // Parse condition section.
  let matchAll = true;
  let testStrings;
  const opMatch = condStr.match(/^(allof|anyof)\s*\(([\s\S]*)\)\s*$/i);
  if (opMatch) {
    matchAll = opMatch[1].toLowerCase() === 'allof';
    testStrings = splitTopLevel(opMatch[2], ',').map((s) => s.trim()).filter(Boolean);
  } else {
    testStrings = [condStr];
  }
  const conditions = testStrings.map(parseTest);

  // Parse action section. Split by top-level `;`.
  const stmts = splitTopLevel(actionsStr, ';')
    .map((s) => s.trim())
    .filter(Boolean);
  const actions = [];
  let stopAfter = false;
  for (const s of stmts) {
    const a = parseAction(s);
    if (a.__stop) {
      stopAfter = true;
      continue;
    }
    actions.push(a);
  }

  return {
    matchAll,
    conditions,
    actions,
    stopAfter,
  };
}

/**
 * @param {string} sieveText
 * @returns {Partial<import('./rule_model.js').Rule>}
 */
export function sieveToRule(sieveText) {
  if (typeof sieveText !== 'string') throw new Error('sieveText must be a string');

  const text = sieveText.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const firstLine = (lines[0] || '').trim();
  if (firstLine !== RULE_MARKER_V1) {
    throw new Error('Not an expor-sieve managed script (marker missing)');
  }
  // Optional second-line `# order: <N>` marker (ignored if missing).
  let order;
  const orderMatch = (lines[1] || '').match(/^#\s*order:\s*(-?\d+)\s*$/);
  if (orderMatch) order = Number(orderMatch[1]);

  const parsed = parseSingleIfBlock(text);
  const result = {
    matchAll: parsed.matchAll,
    conditions: parsed.conditions,
    actions: parsed.actions,
    stopAfter: parsed.stopAfter,
  };
  if (order !== undefined) result.order = order;
  return result;
}

// ---------------------------------------------------------------------------
// Public: combined Sieve script (v2) -> Rule[]
// ---------------------------------------------------------------------------

/**
 * Парсит combined v2 sieve и возвращает массив частичных Rule (без mailcowId,
 * который заполняет background.js).
 *
 * @param {string} sieveText
 * @returns {Array<Partial<import('./rule_model.js').Rule>>}
 */
export function combinedSieveToRules(sieveText) {
  if (typeof sieveText !== 'string') throw new Error('sieveText must be a string');
  const text = sieveText.replace(/\r\n/g, '\n');
  const firstLine = (text.split('\n', 1)[0] || '').trim();
  if (firstLine !== RULE_MARKER_V2) {
    throw new Error('Not a v2 combined sieve script (marker missing)');
  }

  const rules = [];

  // Find all rule blocks via the >>> ... <<< markers.
  // Header line:  # >>> rule: <id> active=N order=N matchAll=N stopAfter=N
  const headerRe = /^#\s*>>>\s*rule:\s*(\S+)\s+active=(\d+)\s+order=(-?\d+)\s+matchAll=(\d+)\s+stopAfter=(\d+)\s*$/gm;

  let match;
  while ((match = headerRe.exec(text)) !== null) {
    const [, id, activeStr, orderStr, matchAllStr, stopAfterStr] = match;
    const headerEnd = match.index + match[0].length;

    // Footer: # <<< rule: <same-id>
    const footerStr = `# <<< rule: ${id}`;
    const footerIdx = text.indexOf(footerStr, headerEnd);
    if (footerIdx === -1) {
      throw new Error(`Combined sieve: missing footer for rule ${id}`);
    }
    let blockText = text.slice(headerEnd, footerIdx);

    // Skip an optional `# name: ...` line at the top of the block.
    let name = '';
    const nameMatch = blockText.match(/^\s*\n?#\s*name:\s*([^\n]*)\n/);
    if (nameMatch) {
      name = nameMatch[1].trim();
      blockText = blockText.slice(nameMatch[0].length);
    }

    const headerActive = activeStr === '1';

    // If the block starts with `if false { ... }` wrapper (inactive rule),
    // unwrap it. We expect exactly one nested if-block inside.
    const trimmedBlock = blockText.trim();
    let inactiveByWrapper = false;
    let bodyText = blockText;

    if (/^if\s+false\s*\{/.test(trimmedBlock)) {
      // Outer test is `if false`. Skip parsing outer actions (they're
      // an if-block, not a statement) — extract the wrapped inner via
      // pure brace matching.
      const outer = locateFirstIfBlock(blockText);
      bodyText = blockText.slice(outer.bodyStart, outer.bodyEnd);
      inactiveByWrapper = true;
    }

    const parsed = parseSingleIfBlock(bodyText);

    const active = inactiveByWrapper ? false : headerActive;

    // Trust meta header as source of truth for matchAll/stopAfter — the
    // parsed body can be ambiguous (single-condition has no allof/anyof
    // marker; `stop;` could be inside or outside any wrapper). For the
    // body we trust only conditions[] and actions[] (without `stop;`).
    const rule = {
      id,
      name,
      active,
      matchAll: matchAllStr === '1',
      conditions: parsed.conditions,
      actions: parsed.actions,
      stopAfter: stopAfterStr === '1',
      order: Number(orderStr),
    };

    rules.push(rule);
  }

  return rules;
}
