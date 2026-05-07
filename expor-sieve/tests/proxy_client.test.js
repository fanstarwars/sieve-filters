// Tests for lib/proxy_client.js
//
// Все тесты используют vi.stubGlobal('fetch', ...) для подмены глобального
// fetch. Никаких реальных сетевых запросов.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProxyClient } from '../lib/proxy_client.js';

// Удобные хелперы для подделки Response-объектов, которые видит код.
function jsonResponse(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
  };
}

function emptyResponse({ status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return ''; },
  };
}

function makeAbortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

const VALID_OPTS = {
  baseUrl: 'https://mail.example.com/sieve-proxy',
  mailbox: 'user@example.com',
  password: 'secret123',
};

// Ожидаемое значение Authorization для VALID_OPTS.
const EXPECTED_BASIC = 'Basic ' + btoa('user@example.com:secret123');

describe('ProxyClient — конструктор', () => {
  it('бросает на пустом baseUrl', () => {
    expect(() => new ProxyClient({ baseUrl: '', mailbox: 'u@x', password: 'p' })).toThrow(/baseUrl/);
    expect(() => new ProxyClient({ mailbox: 'u@x', password: 'p' })).toThrow(/baseUrl/);
  });

  it('бросает на пустом mailbox', () => {
    expect(() => new ProxyClient({ baseUrl: 'https://x', mailbox: '', password: 'p' })).toThrow(/mailbox/);
    expect(() => new ProxyClient({ baseUrl: 'https://x', password: 'p' })).toThrow(/mailbox/);
  });

  it('бросает на пустом password', () => {
    expect(() => new ProxyClient({ baseUrl: 'https://x', mailbox: 'u@x', password: '' })).toThrow(/password/);
    expect(() => new ProxyClient({ baseUrl: 'https://x', mailbox: 'u@x' })).toThrow(/password/);
  });

  it('бросает на http:// (не localhost)', () => {
    expect(() => new ProxyClient({ baseUrl: 'http://mail.example.com', mailbox: 'u@x', password: 'p' }))
      .toThrow(/https/);
  });

  it('разрешает http://localhost для разработки', () => {
    expect(() => new ProxyClient({ baseUrl: 'http://localhost:8080', mailbox: 'u@x', password: 'p' }))
      .not.toThrow();
    expect(() => new ProxyClient({ baseUrl: 'http://127.0.0.1', mailbox: 'u@x', password: 'p' }))
      .not.toThrow();
  });

  it('нормализует trailing / в baseUrl', () => {
    const c1 = new ProxyClient({ baseUrl: 'https://mail.example.com/', mailbox: 'u@x', password: 'p' });
    expect(c1.baseUrl).toBe('https://mail.example.com');
    const c2 = new ProxyClient({ baseUrl: 'https://mail.example.com////', mailbox: 'u@x', password: 'p' });
    expect(c2.baseUrl).toBe('https://mail.example.com');
  });
});

describe('ProxyClient — endpoints (happy path)', () => {
  let client;
  let fetchMock;

  beforeEach(() => {
    client = new ProxyClient(VALID_OPTS);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checkAuth шлёт GET /v1/auth/check с Authorization: Basic', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, user: 'user@example.com' }));
    const body = await client.checkAuth();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/sieve-proxy/v1/auth/check');
    expect(opts.method).toBe('GET');
    expect(opts.headers['Authorization']).toBe(EXPECTED_BASIC);
    expect(opts.headers['X-API-Key']).toBeUndefined();
    expect(body).toEqual({ ok: true, user: 'user@example.com' });
  });

  it('getMailbox шлёт GET /v1/mailbox/<encoded> с Basic-auth', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ username: 'user@x' }));
    const body = await client.getMailbox('user@x');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/sieve-proxy/v1/mailbox/user%40x');
    expect(opts.method).toBe('GET');
    expect(opts.headers['Authorization']).toBe(EXPECTED_BASIC);
    expect(body).toEqual({ username: 'user@x' });
  });

  it('listFilters шлёт GET /v1/filters/<encoded> и возвращает массив', async () => {
    const filters = [{ id: 1 }, { id: 2 }];
    fetchMock.mockResolvedValueOnce(jsonResponse(filters));
    const out = await client.listFilters('u@x');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/sieve-proxy/v1/filters/u%40x');
    expect(opts.method).toBe('GET');
    expect(opts.headers['Authorization']).toBe(EXPECTED_BASIC);
    expect(out).toEqual(filters);
  });

  it('addFilter POST /v1/filters с JSON-payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'success', msg: 'added' }));
    const payload = { username: 'u@x', script_desc: 'r', script_data: 'data' };
    await client.addFilter(payload);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/sieve-proxy/v1/filters');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe(JSON.stringify(payload));
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers['Authorization']).toBe(EXPECTED_BASIC);
  });

  it('editFilter POST /v1/filters/edit как JSON { items:[id], attr } (НЕ form-encoded)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'success' }));
    await client.editFilter(123, { active: 0 });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/sieve-proxy/v1/filters/edit');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ items: [123], attr: { active: 0 } });
  });

  it('deleteFilter POST /v1/filters/delete с JSON-массивом [id]', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'success' }));
    await client.deleteFilter(7);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/sieve-proxy/v1/filters/delete');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual([7]);
  });
});

describe('ProxyClient — обработка ошибок', () => {
  let client;
  let fetchMock;

  beforeEach(() => {
    client = new ProxyClient(VALID_OPTS);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('401 → throw Error с .kind === "auth"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'error', msg: 'unauthorized' }, { status: 401 }));
    let err;
    try { await client.addFilter({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('auth');
  });

  it('403 → throw Error с .kind === "auth", message содержит "forbidden"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'error', msg: 'forbidden' }, { status: 403 }));
    let err;
    try { await client.addFilter({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('auth');
    expect(err.message).toContain('forbidden');
  });

  it('400 → throw Error с .kind === "validation"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'error', msg: 'bad payload' }, { status: 400 }));
    let err;
    try { await client.addFilter({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('validation');
    expect(err.message).toContain('bad payload');
  });

  it('500 → throw Error с .kind === "server"', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse({ status: 500 }));
    let err;
    try { await client.addFilter({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('server');
  });

  it('200 + [{type:"danger", msg:"oops"}] → .kind === "validation", message содержит "oops"', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ type: 'danger', msg: 'oops' }]));
    let err;
    try { await client.addFilter({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('validation');
    expect(err.message).toContain('oops');
  });

  it('AbortError (таймаут) → .kind === "network"', async () => {
    fetchMock.mockRejectedValueOnce(makeAbortError());
    let err;
    try { await client.addFilter({}); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('network');
  });
});

describe('ProxyClient — retry логика', () => {
  let client;
  let fetchMock;

  beforeEach(() => {
    client = new ProxyClient(VALID_OPTS);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET ретраится 1 раз при network error, вторая попытка успешна → возвращает body', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const out = await client.getMailbox('u@x');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ ok: true });
  });

  it('GET без ошибок → НЕТ лишнего retry (fetch вызвался ровно 1 раз)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const out = await client.getMailbox('u@x');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ok: true });
  });

  it('POST с network error НЕ ретраится (fetch вызвался ровно 1 раз)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    let err;
    try { await client.addFilter({ x: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET с двумя network ошибками подряд → бросает (только 1 retry)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed again'));
    let err;
    try { await client.getMailbox('u@x'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('network');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
