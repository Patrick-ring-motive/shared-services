'use strict';

/**
 * tests/iframe-handler.test.js
 * Unit tests for the script embedded in shared-services.html.
 *
 * Strategy:
 *   1. Before the test suite, intercept window.addEventListener to capture
 *      the 'message' listener the IIFE registers, then eval the script.
 *   2. In each test, call the captured handler directly with a synthetic
 *      event object (source, origin, data).  The source has a jest spy on
 *      postMessage so we can assert what the handler replied.
 *   3. Flush pending micro-tasks with flushAsync() before asserting.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// Flush all pending micro-tasks (and one timer round)
// ─────────────────────────────────────────────────────────────────────────────
function flushAsync() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Captured handler & test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The async 'message' event handler registered by the iframe script. */
let handleMessage;

/** Create a fake source window. */
function makeSource() {
  return { postMessage: jest.fn() };
}

/**
 * Call the handler with a synthetic message, wait for async work,
 * then return the first postMessage call payload.
 */
async function call(source, data, origin = 'https://parent.example.com') {
  handleMessage({ source, origin, data });
  await flushAsync();
  if (source.postMessage.mock.calls.length === 0) return null;
  return source.postMessage.mock.calls[0][0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock browser APIs (set up once before the suite so they exist when
// the script is eval'd and remain available for each test)
// ─────────────────────────────────────────────────────────────────────────────

let mockFetch;
let mockCaches;
let webSocketInstances;
let sharedWorkerInstances;
let broadcastChannelInstances;

function makeCacheStore() {
  return {
    match:    jest.fn().mockResolvedValue(null),
    matchAll: jest.fn().mockResolvedValue([]),
    add:      jest.fn().mockResolvedValue(undefined),
    addAll:   jest.fn().mockResolvedValue(undefined),
    put:      jest.fn().mockResolvedValue(undefined),
    delete:   jest.fn().mockResolvedValue(false),
    keys:     jest.fn().mockResolvedValue([]),
  };
}

function buildMockXHR(overrides = {}) {
  const xhr = {
    open:                jest.fn(),
    send:                jest.fn(),
    setRequestHeader:    jest.fn(),
    getAllResponseHeaders: jest.fn().mockReturnValue('content-type: application/json'),
    responseText:        '{"ok":true}',
    responseType:        '',
    status:              200,
    statusText:          'OK',
    responseURL:         'https://api.example.com/',
    onload:              null,
    onerror:             null,
    ontimeout:           null,
    ...overrides,
  };
  // Trigger onload after a microtask when send() is called
  xhr.send.mockImplementation(() => Promise.resolve().then(() => xhr.onload?.()));
  return xhr;
}

beforeAll(() => {
  // ── global state arrays ──────────────────────────────────────────────────
  webSocketInstances      = [];
  sharedWorkerInstances   = [];
  broadcastChannelInstances = [];

  // ── fetch ────────────────────────────────────────────────────────────────
  mockFetch = jest.fn().mockResolvedValue({
    ok:          true,
    status:      200,
    statusText:  'OK',
    url:         'https://api.example.com/',
    redirected:  false,
    type:        'cors',
    headers:     { entries: () => Object.entries({ 'content-type': 'application/json' }) },
    arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer),
  });
  globalThis.fetch = mockFetch;

  // ── caches ───────────────────────────────────────────────────────────────
  const cacheStores = new Map();
  mockCaches = {
    _stores: cacheStores,
    open: jest.fn((name) => {
      if (!cacheStores.has(name)) cacheStores.set(name, makeCacheStore());
      return Promise.resolve(cacheStores.get(name));
    }),
    keys:   jest.fn().mockResolvedValue([]),
    has:    jest.fn().mockResolvedValue(false),
    delete: jest.fn().mockResolvedValue(false),
    match:  jest.fn().mockResolvedValue(null),
  };
  globalThis.caches = mockCaches;

  // ── WebSocket ────────────────────────────────────────────────────────────
  globalThis.WebSocket = jest.fn().mockImplementation((url) => {
    const listeners = {};
    const ws = {
      url,
      binaryType: 'blob',
      addEventListener: (type, fn) => { listeners[type] = fn; },
      send:    jest.fn(),
      close:   jest.fn((code, reason) => listeners.close?.({ code, reason, wasClean: true })),
      _trigger: (type, ev = {}) => listeners[type]?.(ev),
    };
    webSocketInstances.push(ws);
    // Auto-open after one microtask (simulates successful connection)
    Promise.resolve().then(() => listeners.open?.());
    return ws;
  });

  // ── SharedWorker ─────────────────────────────────────────────────────────
  globalThis.SharedWorker = jest.fn().mockImplementation((url) => {
    const listeners     = {};
    const portListeners = {};
    const port = {
      start:        jest.fn(),
      close:        jest.fn(),
      postMessage:  jest.fn(),
      addEventListener: (type, fn) => { portListeners[type] = fn; },
      _trigger: (type, ev = {}) => portListeners[type]?.(ev),
    };
    const worker = {
      url,
      port,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      _trigger: (type, ev = {}) => listeners[type]?.(ev),
    };
    sharedWorkerInstances.push(worker);
    return worker;
  });

  // ── BroadcastChannel ─────────────────────────────────────────────────────
  globalThis.BroadcastChannel = jest.fn().mockImplementation((name) => {
    const listeners = {};
    const bc = {
      name,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      postMessage:  jest.fn(),
      close:        jest.fn(),
      _trigger: (type, ev = {}) => listeners[type]?.(ev),
    };
    broadcastChannelInstances.push(bc);
    return bc;
  });

  // ── window.parent ────────────────────────────────────────────────────────
  Object.defineProperty(globalThis, 'parent', {
    value:        { postMessage: jest.fn() },
    configurable: true,
  });

  // ── Intercept window.addEventListener to capture the 'message' handler ──
  const origAdd = globalThis.addEventListener.bind(globalThis);
  let captured  = false;
  const spy     = jest.spyOn(globalThis, 'addEventListener').mockImplementation((type, fn, ...rest) => {
    if (type === 'message' && !captured) {
      captured       = true;
      handleMessage  = fn;
    }
    return origAdd(type, fn, ...rest);
  });

  // ── Eval the script from the HTML ────────────────────────────────────────
  const html  = fs.readFileSync(path.join(__dirname, '../shared-services.html'), 'utf8');
  const match = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find <script> tag in shared-services.html');
  // The IIFE registers the message handler — captured via spy above
  // eslint-disable-next-line no-eval
  eval(match[1]);

  spy.mockRestore();

  if (!handleMessage) throw new Error('iframe script did not register a message listener');
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  webSocketInstances.length       = 0;
  sharedWorkerInstances.length    = 0;
  broadcastChannelInstances.length = 0;
  mockCaches._stores.clear();
  jest.clearAllMocks();

  // Re-wire mockCaches.open after clearAllMocks resets call history
  const stores = mockCaches._stores;
  mockCaches.open.mockImplementation((name) => {
    if (!stores.has(name)) stores.set(name, makeCacheStore());
    return Promise.resolve(stores.get(name));
  });
  mockCaches.keys.mockResolvedValue([]);
  mockCaches.has.mockResolvedValue(false);
  mockCaches.delete.mockResolvedValue(false);
  mockCaches.match.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Protocol validation
// ─────────────────────────────────────────────────────────────────────────────

describe('protocol validation', () => {
  test('ignores messages with __ss !== true', async () => {
    const src = makeSource();
    await call(src, { id: 'r1', service: 'localStorage', method: 'getItem', args: ['k'] });
    expect(src.postMessage).not.toHaveBeenCalled();
  });

  test('ignores outbound __event messages', async () => {
    const src = makeSource();
    await call(src, { __ss: true, __event: true, connectionId: 'x', event: 'open', data: {} });
    expect(src.postMessage).not.toHaveBeenCalled();
  });

  test('ignores messages missing required fields', async () => {
    const src = makeSource();
    await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'getItem' }); // no args
    expect(src.postMessage).not.toHaveBeenCalled();
  });

  test('replies with an error for an unknown service', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'unknown', method: 'foo', args: [] });
    expect(resp).toMatchObject({ __ss: true, id: 'r1', error: expect.objectContaining({ message: expect.stringContaining('unknown') }) });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ready signal
// ─────────────────────────────────────────────────────────────────────────────

describe('ready signal', () => {
  test('window.parent.postMessage is called with __ready on load', () => {
    // The script fires signalReady synchronously because readyState is 'complete'
    // in jsdom at the time the eval runs.
    // parent.postMessage was called in beforeAll when the script was eval'd.
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      { __ss: true, __ready: true }, '*'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// localStorage
// ─────────────────────────────────────────────────────────────────────────────

describe('localStorage', () => {
  test('setItem stores a value; getItem retrieves it', async () => {
    const src = makeSource();

    const setResp = await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'setItem', args: ['color', 'blue'] });
    expect(setResp).toMatchObject({ id: 'r1', result: null, error: null });

    src.postMessage.mockClear();
    const getResp = await call(src, { __ss: true, id: 'r2', service: 'localStorage', method: 'getItem', args: ['color'] });
    expect(getResp).toMatchObject({ id: 'r2', result: 'blue', error: null });
  });

  test('removeItem deletes the key', async () => {
    localStorage.setItem('x', '1');
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'removeItem', args: ['x'] });
    expect(resp.error).toBeNull();
    expect(localStorage.getItem('x')).toBeNull();
  });

  test('clear removes all keys', async () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'clear', args: [] });
    expect(resp.error).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  test('key returns the key at the given index', async () => {
    localStorage.setItem('hello', 'world');
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'key', args: [0] });
    expect(resp.result).toBe('hello');
  });

  test('length returns the number of keys', async () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'length', args: [] });
    expect(resp.result).toBe(2);
  });

  test('getAll returns all key-value pairs', async () => {
    localStorage.setItem('k1', 'v1');
    localStorage.setItem('k2', 'v2');
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'getAll', args: [] });
    expect(resp.result).toEqual({ k1: 'v1', k2: 'v2' });
  });

  test('unknown method replies with error', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'localStorage', method: 'badOp', args: [] });
    expect(resp.error).toMatchObject({ message: expect.stringContaining('badOp') });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sessionStorage
// ─────────────────────────────────────────────────────────────────────────────

describe('sessionStorage', () => {
  test('setItem / getItem round-trip', async () => {
    const src = makeSource();

    await call(src, { __ss: true, id: 'r1', service: 'sessionStorage', method: 'setItem', args: ['token', 'abc123'] });
    src.postMessage.mockClear();

    const resp = await call(src, { __ss: true, id: 'r2', service: 'sessionStorage', method: 'getItem', args: ['token'] });
    expect(resp.result).toBe('abc123');
  });

  test('clear removes all session keys', async () => {
    sessionStorage.setItem('s', '1');
    const src = makeSource();
    await call(src, { __ss: true, id: 'r1', service: 'sessionStorage', method: 'clear', args: [] });
    expect(sessionStorage.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('fetch', () => {
  test('calls global fetch and returns a serialized response', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'fetch', method: 'fetch',
                                   args: ['https://api.example.com/', {}] });
    expect(mockFetch).toHaveBeenCalledWith('https://api.example.com/', {});
    expect(resp.result).toMatchObject({
      ok: true, status: 200, statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: expect.any(Array),
    });
    expect(resp.error).toBeNull();
  });

  test('converts array body to Uint8Array before calling fetch', async () => {
    const src = makeSource();
    await call(src, { __ss: true, id: 'r1', service: 'fetch', method: 'fetch',
                      args: ['https://api.example.com/', { method: 'POST', body: [10, 20, 30] }] });
    const passedInit = mockFetch.mock.calls[0][1];
    expect(passedInit.body).toBeInstanceOf(Uint8Array);
    expect(Array.from(passedInit.body)).toEqual([10, 20, 30]);
  });

  test('replies with error when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network failure'));
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'fetch', method: 'fetch',
                                   args: ['https://api.example.com/', {}] });
    expect(resp.error).toMatchObject({ name: 'TypeError', message: 'Network failure' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// XHR
// ─────────────────────────────────────────────────────────────────────────────

describe('xhr', () => {
  let origXHR;

  beforeEach(() => {
    origXHR = globalThis.XMLHttpRequest;
  });

  afterEach(() => {
    globalThis.XMLHttpRequest = origXHR;
  });

  test('opens, sends and resolves with the response', async () => {
    const mockXhr = buildMockXHR();
    globalThis.XMLHttpRequest = jest.fn().mockReturnValue(mockXhr);

    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'xhr', method: 'xhr',
                                   args: [{ method: 'GET', url: 'https://api.example.com/', body: null,
                                            headers: null, responseType: '' }] });
    expect(mockXhr.open).toHaveBeenCalledWith('GET', 'https://api.example.com/', true);
    expect(mockXhr.send).toHaveBeenCalled();
    expect(resp.result).toMatchObject({ status: 200, statusText: 'OK', response: '{"ok":true}' });
    expect(resp.error).toBeNull();
  });

  test('sets request headers when provided', async () => {
    const mockXhr = buildMockXHR();
    globalThis.XMLHttpRequest = jest.fn().mockReturnValue(mockXhr);

    const src = makeSource();
    await call(src, { __ss: true, id: 'r1', service: 'xhr', method: 'xhr',
                      args: [{ method: 'POST', url: 'https://api.example.com/',
                               body: null, headers: { 'x-token': 'abc' }, responseType: '' }] });
    expect(mockXhr.setRequestHeader).toHaveBeenCalledWith('x-token', 'abc');
  });

  test('replies with error when XHR fires onerror', async () => {
    const mockXhr = buildMockXHR();
    mockXhr.send.mockImplementation(() => Promise.resolve().then(() => mockXhr.onerror?.()));
    globalThis.XMLHttpRequest = jest.fn().mockReturnValue(mockXhr);

    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'xhr', method: 'xhr',
                                   args: [{ method: 'GET', url: 'https://api.example.com/',
                                            body: null, headers: null, responseType: '' }] });
    expect(resp.error).toMatchObject({ message: 'XHR network error' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache API — CacheStorage
// ─────────────────────────────────────────────────────────────────────────────

describe('cache storage', () => {
  test('storage.keys returns array of cache names', async () => {
    mockCaches.keys.mockResolvedValueOnce(['v1', 'v2']);
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'cache', method: 'storage.keys', args: [] });
    expect(resp.result).toEqual(['v1', 'v2']);
  });

  test('storage.has returns true when cache exists', async () => {
    mockCaches.has.mockResolvedValueOnce(true);
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'cache', method: 'storage.has', args: ['v1'] });
    expect(resp.result).toBe(true);
  });

  test('storage.delete returns true', async () => {
    mockCaches.delete.mockResolvedValueOnce(true);
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'cache', method: 'storage.delete', args: ['v1'] });
    expect(resp.result).toBe(true);
  });

  test('storage.open returns a cacheId', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'cache', method: 'storage.open', args: ['v1'] });
    expect(resp.result).toMatchObject({ cacheId: expect.any(String) });
    expect(resp.error).toBeNull();
  });

  test('storage.match calls caches.match and serializes the response', async () => {
    const mockRes = {
      ok: true, status: 200, statusText: 'OK', url: '/asset.js',
      redirected: false, type: 'basic',
      headers: { entries: () => Object.entries({ 'content-type': 'text/javascript' }) },
      arrayBuffer: jest.fn().mockResolvedValue(new Uint8Array([42]).buffer),
    };
    mockCaches.match.mockResolvedValueOnce(mockRes);

    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'cache', method: 'storage.match', args: ['/asset.js'] });
    expect(resp.result).toMatchObject({ ok: true, status: 200, body: [42] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache API — instance methods
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: open a named cache and return its remote id. */
async function openCacheAndGetId(src) {
  const resp = await call(src, { __ss: true, id: 'open-1', service: 'cache', method: 'storage.open', args: ['test-cache'] });
  src.postMessage.mockClear();
  return resp.result.cacheId;
}

describe('cache instance methods', () => {
  test('instance.add calls cache.add', async () => {
    const src     = makeSource();
    const cacheId = await openCacheAndGetId(src);
    const store   = mockCaches._stores.get('test-cache');

    const resp = await call(src, { __ss: true, id: 'r2', service: 'cache', method: 'instance.add',
                                   args: [cacheId, '/bundle.js'] });
    expect(store.add).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('/bundle.js') }));
    expect(resp.error).toBeNull();
  });

  test('instance.delete calls cache.delete', async () => {
    const src     = makeSource();
    const cacheId = await openCacheAndGetId(src);
    const store   = mockCaches._stores.get('test-cache');
    store.delete.mockResolvedValueOnce(true);

    const resp = await call(src, { __ss: true, id: 'r2', service: 'cache', method: 'instance.delete',
                                   args: [cacheId, '/bundle.js', undefined] });
    expect(resp.result).toBe(true);
  });

  test('instance.keys returns array of request URLs', async () => {
    const src     = makeSource();
    const cacheId = await openCacheAndGetId(src);
    const store   = mockCaches._stores.get('test-cache');
    store.keys.mockResolvedValueOnce([
      { url: '/a.js' },
      { url: '/b.js' },
    ]);

    const resp = await call(src, { __ss: true, id: 'r2', service: 'cache', method: 'instance.keys',
                                   args: [cacheId, null, undefined] });
    expect(resp.result).toEqual(['/a.js', '/b.js']);
  });

  test('instance.put calls cache.put with a reconstructed Response', async () => {
    const src     = makeSource();
    const cacheId = await openCacheAndGetId(src);
    const store   = mockCaches._stores.get('test-cache');

    const resp = await call(src, {
      __ss: true, id: 'r2', service: 'cache', method: 'instance.put',
      args: [cacheId, '/a.txt',
             { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: [72, 105] }],
    });
    expect(store.put).toHaveBeenCalled();
    expect(resp.error).toBeNull();
  });

  test('instance methods reply with error for unknown cacheId', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'cache', method: 'instance.add',
                                   args: ['no-such-cache', '/x.js'] });
    expect(resp.error).toMatchObject({ message: expect.stringContaining('not found') });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────────────────────────────────────

describe('websocket', () => {
  test('connect resolves with a wsId after ws opens', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'websocket', method: 'connect',
                                   args: ['wss://echo.example.com'] });
    expect(globalThis.WebSocket).toHaveBeenCalledWith('wss://echo.example.com');
    expect(resp.result).toMatchObject({ wsId: expect.any(String) });
    expect(resp.error).toBeNull();
  });

  test('send forwards data to ws.send', async () => {
    const src      = makeSource();
    const connResp = await call(src, { __ss: true, id: 'r1', service: 'websocket', method: 'connect',
                                       args: ['wss://echo.example.com'] });
    const { wsId } = connResp.result;
    const ws       = webSocketInstances[0];
    src.postMessage.mockClear();

    const resp = await call(src, { __ss: true, id: 'r2', service: 'websocket', method: 'send',
                                   args: [wsId, 'hello world', false] });
    expect(ws.send).toHaveBeenCalledWith('hello world');
    expect(resp.error).toBeNull();
  });

  test('send with isBinary:true delivers a Uint8Array', async () => {
    const src      = makeSource();
    const connResp = await call(src, { __ss: true, id: 'r1', service: 'websocket', method: 'connect',
                                       args: ['wss://echo.example.com'] });
    const ws       = webSocketInstances[0];
    src.postMessage.mockClear();

    await call(src, { __ss: true, id: 'r2', service: 'websocket', method: 'send',
                      args: [connResp.result.wsId, [1, 2, 3], true] });
    expect(ws.send).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(Array.from(ws.send.mock.calls[0][0])).toEqual([1, 2, 3]);
  });

  test('close calls ws.close and removes registry entry', async () => {
    const src      = makeSource();
    const connResp = await call(src, { __ss: true, id: 'r1', service: 'websocket', method: 'connect',
                                       args: ['wss://echo.example.com'] });
    const { wsId } = connResp.result;
    const ws       = webSocketInstances[0];
    src.postMessage.mockClear();

    await call(src, { __ss: true, id: 'r2', service: 'websocket', method: 'close',
                      args: [wsId, 1000, 'done'] });
    expect(ws.close).toHaveBeenCalledWith(1000, 'done');
  });

  test('incoming ws message is emitted back to the source', async () => {
    const src      = makeSource();
    const connResp = await call(src, { __ss: true, id: 'r1', service: 'websocket', method: 'connect',
                                       args: ['wss://echo.example.com'] });
    const { wsId } = connResp.result;
    const ws       = webSocketInstances[0];
    src.postMessage.mockClear();

    ws._trigger('message', { data: 'pong' });

    expect(src.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __event: true, connectionId: wsId, event: 'message',
                                 data: { data: 'pong', isBinary: false } }),
      expect.any(String)
    );
  });

  test('connect fails for an unknown host — replies with error', async () => {
    // Simulate WebSocket opening failing
    globalThis.WebSocket.mockImplementationOnce(() => {
      const listeners = {};
      const ws = {
        binaryType: 'blob',
        addEventListener: (type, fn) => { listeners[type] = fn; },
        send: jest.fn(), close: jest.fn(),
      };
      // Fire error then close (no open) after a microtask
      Promise.resolve().then(() => {
        listeners.error?.({});
      });
      return ws;
    });
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'websocket', method: 'connect',
                                   args: ['wss://bad.invalid'] });
    expect(resp.error).toMatchObject({ message: expect.stringContaining('failed') });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SharedWorker
// ─────────────────────────────────────────────────────────────────────────────

describe('sharedWorker', () => {
  test('connect resolves with a workerId', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'sharedWorker', method: 'connect',
                                   args: ['https://user.github.io/worker.js'] });
    expect(resp.result).toMatchObject({ workerId: expect.any(String) });
    expect(resp.error).toBeNull();
  });

  test('postMessage forwards to worker.port.postMessage', async () => {
    const src        = makeSource();
    const connResp   = await call(src, { __ss: true, id: 'r1', service: 'sharedWorker', method: 'connect',
                                         args: ['https://user.github.io/worker.js'] });
    const { workerId } = connResp.result;
    const worker     = sharedWorkerInstances[0];
    src.postMessage.mockClear();

    await call(src, { __ss: true, id: 'r2', service: 'sharedWorker', method: 'postMessage',
                      args: [workerId, { type: 'ping' }] });
    expect(worker.port.postMessage).toHaveBeenCalledWith({ type: 'ping' });
  });

  test('incoming port message is emitted back to source', async () => {
    const src      = makeSource();
    const connResp = await call(src, { __ss: true, id: 'r1', service: 'sharedWorker', method: 'connect',
                                       args: ['https://user.github.io/worker.js'] });
    const { workerId } = connResp.result;
    const worker       = sharedWorkerInstances[0];
    src.postMessage.mockClear();

    worker.port._trigger('message', { data: 'pong' });

    expect(src.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __event: true, connectionId: workerId, event: 'message',
                                 data: { data: 'pong' } }),
      expect.any(String)
    );
  });

  test('disconnect closes the port', async () => {
    const src      = makeSource();
    const connResp = await call(src, { __ss: true, id: 'r1', service: 'sharedWorker', method: 'connect',
                                       args: ['https://user.github.io/worker.js'] });
    const { workerId } = connResp.result;
    const worker       = sharedWorkerInstances[0];
    src.postMessage.mockClear();

    await call(src, { __ss: true, id: 'r2', service: 'sharedWorker', method: 'disconnect',
                      args: [workerId] });
    expect(worker.port.close).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BroadcastChannel
// ─────────────────────────────────────────────────────────────────────────────

describe('broadcastChannel', () => {
  test('subscribe resolves with a channelId', async () => {
    const src  = makeSource();
    const resp = await call(src, { __ss: true, id: 'r1', service: 'broadcastChannel', method: 'subscribe',
                                   args: ['app-events'] });
    expect(resp.result).toMatchObject({ channelId: expect.any(String) });
    expect(globalThis.BroadcastChannel).toHaveBeenCalledWith('app-events');
  });

  test('postMessage forwards to channel.postMessage', async () => {
    const src      = makeSource();
    const subResp  = await call(src, { __ss: true, id: 'r1', service: 'broadcastChannel', method: 'subscribe',
                                       args: ['sync'] });
    const { channelId } = subResp.result;
    const bc             = broadcastChannelInstances[0];
    src.postMessage.mockClear();

    await call(src, { __ss: true, id: 'r2', service: 'broadcastChannel', method: 'postMessage',
                      args: [channelId, { action: 'reload' }] });
    expect(bc.postMessage).toHaveBeenCalledWith({ action: 'reload' });
  });

  test('incoming channel message is emitted back to source', async () => {
    const src      = makeSource();
    const subResp  = await call(src, { __ss: true, id: 'r1', service: 'broadcastChannel', method: 'subscribe',
                                       args: ['sync'] });
    const { channelId } = subResp.result;
    const bc             = broadcastChannelInstances[0];
    src.postMessage.mockClear();

    bc._trigger('message', { data: { from: 'tabB' } });

    expect(src.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ __event: true, connectionId: channelId, event: 'message',
                                 data: { from: 'tabB' } }),
      expect.any(String)
    );
  });

  test('close calls channel.close', async () => {
    const src      = makeSource();
    const subResp  = await call(src, { __ss: true, id: 'r1', service: 'broadcastChannel', method: 'subscribe',
                                       args: ['sync'] });
    const { channelId } = subResp.result;
    const bc             = broadcastChannelInstances[0];
    src.postMessage.mockClear();

    await call(src, { __ss: true, id: 'r2', service: 'broadcastChannel', method: 'close',
                      args: [channelId] });
    expect(bc.close).toHaveBeenCalled();
  });

  test('unknown method replies with error', async () => {
    const src      = makeSource();
    const subResp  = await call(src, { __ss: true, id: 'r1', service: 'broadcastChannel', method: 'subscribe',
                                       args: ['sync'] });
    const { channelId } = subResp.result;
    src.postMessage.mockClear();

    const resp = await call(src, { __ss: true, id: 'r2', service: 'broadcastChannel', method: 'badOp',
                                   args: [channelId] });
    expect(resp.error).toMatchObject({ message: expect.stringContaining('BroadcastChannel') });
  });
});
