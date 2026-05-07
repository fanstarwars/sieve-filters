// ProxyClient — тонкая обёртка над expor-sieve-proxy (middleware).
// Спецификация: TZ.md v3 §5, TZ-middleware.md §5/§10.
// Все методы возвращают Promise. Ошибки нормализуются в Error с полем .kind.
//
// Контракт ошибок (UI-слой):
//   { kind: 'auth'|'network'|'server'|'validation'|'no_config', message }
//
// Маппинг HTTP-статусов middleware:
//   401         → kind:'auth'
//   403         → kind:'auth'   (msg: forbidden)
//   4xx прочие  → kind:'validation'
//   5xx         → kind:'server'
//   timeout/net → kind:'network'

const TIMEOUT_MS = 10_000;

function isLocalhost(url) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url);
}

function makeError(kind, message, cause) {
  const err = new Error(message);
  err.kind = kind;
  if (cause !== undefined) err.cause = cause;
  return err;
}

function basicAuth(user, password) {
  // btoa оперирует latin1; для мейлбоксов и обычных паролей этого достаточно,
  // но если в пароле есть юникод — пропустим через UTF-8 → latin1.
  const raw = `${user}:${password}`;
  let bin;
  try {
    bin = unescape(encodeURIComponent(raw)); // utf-8 → latin1
  } catch {
    bin = raw;
  }
  return `Basic ${btoa(bin)}`;
}

/**
 * Парсинг ответа middleware.
 *  - 2xx + json: ищет {type:"danger"|"error"} → validation; иначе возвращает первый элемент массива или body.
 *  - 401         → auth ('unauthorized' / msg из тела)
 *  - 403         → auth ('forbidden' / msg из тела)
 *  - 4xx прочие  → validation
 *  - 5xx         → server
 */
async function parseResponse(resp) {
  let body = null;
  const text = await resp.text();
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = text; }
  }

  if (resp.status === 401) {
    throw makeError('auth', extractMessage(body) || 'unauthorized');
  }
  if (resp.status === 403) {
    throw makeError('auth', extractMessage(body) || 'forbidden');
  }
  if (resp.status >= 500) {
    throw makeError('server', extractMessage(body) || `Сервер ответил ошибкой (${resp.status})`);
  }
  if (!resp.ok) {
    // прочие 4xx — validation
    const msg = extractMessage(body) || `HTTP ${resp.status}`;
    throw makeError('validation', msg);
  }

  // 2xx — middleware форвардит mailcow-форматированный body. Парсим как раньше.
  if (Array.isArray(body)) {
    const bad = body.find(x => x && (x.type === 'danger' || x.type === 'error'));
    if (bad) throw makeError('validation', stringifyMsg(bad.msg));
    const ok = body.find(x => x && x.type === 'success');
    return ok || body;
  }
  if (body && typeof body === 'object') {
    if (body.type === 'danger' || body.type === 'error') {
      throw makeError('validation', stringifyMsg(body.msg));
    }
  }
  return body;
}

function extractMessage(body) {
  if (!body) return null;
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) {
    const bad = body.find(x => x && (x.type === 'danger' || x.type === 'error'));
    if (bad) return stringifyMsg(bad.msg);
  }
  if (typeof body === 'object' && body.msg) return stringifyMsg(body.msg);
  return null;
}

function stringifyMsg(msg) {
  if (msg == null) return 'Неизвестная ошибка';
  if (typeof msg === 'string') return msg;
  if (Array.isArray(msg)) return msg.map(stringifyMsg).join('; ');
  try { return JSON.stringify(msg); } catch { return String(msg); }
}

export class ProxyClient {
  constructor({ baseUrl, mailbox, password } = {}) {
    if (!baseUrl || typeof baseUrl !== 'string') {
      throw new Error('ProxyClient: baseUrl обязателен');
    }
    if (!mailbox || typeof mailbox !== 'string') {
      throw new Error('ProxyClient: mailbox обязателен');
    }
    if (!password || typeof password !== 'string') {
      throw new Error('ProxyClient: password обязателен');
    }
    if (!baseUrl.startsWith('https://') && !isLocalhost(baseUrl)) {
      throw new Error('ProxyClient: baseUrl должен использовать https:// (исключение: http://localhost для dev)');
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.mailbox = mailbox;
    this.password = password;
    this._authHeader = basicAuth(mailbox, password);
  }

  async _fetch(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          'Authorization': this._authHeader,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      return await parseResponse(resp);
    } catch (err) {
      if (err && err.kind) throw err;
      const isAbort = err && (err.name === 'AbortError' || err.code === 20);
      throw makeError('network', isAbort ? 'Превышен таймаут запроса' : (err && err.message) || 'Сетевая ошибка', err);
    } finally {
      clearTimeout(timer);
    }
  }

  async _get(path) {
    try {
      return await this._fetch('GET', path);
    } catch (err) {
      if (err && err.kind === 'network') {
        return await this._fetch('GET', path); // 1 retry
      }
      throw err;
    }
  }

  // /v1/auth/check — проверка кред (для testConnection).
  // Возвращает { ok: true, user } при успехе.
  checkAuth() {
    return this._get('/v1/auth/check');
  }

  getMailbox(username) {
    return this._get(`/v1/mailbox/${encodeURIComponent(username)}`);
  }

  listFilters(username) {
    // mailcow возвращает либо массив (есть фильтры) либо {} (нет). Нормализуем
    // в массив, чтобы caller не падал на `for...of {}` ("({}) is not iterable").
    return this._get(`/v1/filters/${encodeURIComponent(username)}`).then((r) => {
      if (Array.isArray(r)) return r;
      if (r && typeof r === 'object') return Object.values(r);
      return [];
    });
  }

  addFilter(payload) {
    return this._fetch('POST', '/v1/filters', payload);
  }

  editFilter(id, payload) {
    return this._fetch('POST', '/v1/filters/edit', { items: [id], attr: payload });
  }

  deleteFilter(id) {
    return this._fetch('POST', '/v1/filters/delete', [id]);
  }
}

export default ProxyClient;
