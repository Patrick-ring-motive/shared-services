'use strict';

/**
 * tests/client.test.js
 * Unit tests for client.js.
 *
 * Strategy: mock the DOM so sharedServices can be instantiated in Node/jsdom,
 * then simulate the postMessage round-trip by calling ss._onMessage() directly
 * with synthetic message events.
 */

const sharedServices = require('../client.js');

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock state (reset between tests)
// ─────────────────────────────────────────────────────────────────────────────

let mockPost;
let mockIframeCW;
let mockIframe;
let uuidSeq;

beforeEach(() => {
  uuidSeq      = 0;
  mockPost     = jest.fn();
  mockIframeCW = { postMessage: mockPost };
  mockIframe   = {
    contentWindow: mockIframeCW,
    setAttribute:  jest.fn(),
    remove:        jest.fn(),
    style:         {},
  };

  jest.spyOn(document, 'createElement').mockReturnValue(mockIframe);
  jest.spyOn(document.body, 'appendChild').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const IFRAME_URL = 'https://user.github.io/repo/shared-services.html';
const ORIGIN     = 'https://user.github.io';

/** Create a sharedServices instance and immediately signal it as ready. */
function makeSS(url = IFRAME_URL, opts = {}) {
  const ss = new sharedServices(url, {
    targetOrigin: ORIGIN,
    generateId: () => `test-uuid-${++uuidSeq}`,
    ...opts,
  });
  ss._onMessage({ source: mockIframeCW, data: { __ss: true, __ready: true } });
  return ss;
}

/** Inject a successful response into ss. */
function respond(ss, id, result) {
  ss._onMessage({
    source: mockIframeCW,
    data:   { __ss: true, id, result, error: null },
  });
}

/** Inject an error response into ss. */
function respondError(ss, id, name, message) {
  ss._onMessage({
    source: mockIframeCW,
    data:   { __ss: true, id, result: null, error: { name, message } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructor / setup
// ─────────────────────────────────────────────────────────────────────────────

describe('constructor', () => {
  test('creates a hidden iframe and appends it to body', () => {
    const ss = new sharedServices(IFRAME_URL);
    expect(ss).toBeDefined();
    expect(document.createElement).toHaveBeenCalledWith('iframe');
    expect(document.body.appendChild).toHaveBeenCalledWith(mockIframe);
  });

  test('sets sandbox and aria-hidden attributes on the iframe', () => {
    const ss = new sharedServices(IFRAME_URL);
    expect(ss).toBeDefined();
    expect(mockIframe.setAttribute).toHaveBeenCalledWith('sandbox', 'allow-scripts allow-same-origin');
    expect(mockIframe.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
  });

  test('pending map is initially empty', () => {
    const ss = new sharedServices(IFRAME_URL);
    expect(ss.pending.size).toBe(0);
  });

  test('exposes localStorage, sessionStorage, cache, websocket, sharedWorker, broadcastChannel', () => {
    const ss = new sharedServices(IFRAME_URL);
    expect(ss.localStorage).toBeDefined();
    expect(ss.sessionStorage).toBeDefined();
    expect(ss.cache).toBeDefined();
    expect(ss.websocket).toBeDefined();
    expect(ss.sharedWorker).toBeDefined();
    expect(ss.broadcastChannel).toBeDefined();
  });

  test('infers targetOrigin from iframeUrl', () => {
    const ss = makeSS();
    const promise = ss.localStorage.getItem('k');
    return Promise.resolve().then(() => {
      expect(mockPost).toHaveBeenCalledWith(
        expect.objectContaining({ __ss: true }),
        ORIGIN
      );
      respond(ss, 'test-uuid-1', null);
      return promise;
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ready promise
// ─────────────────────────────────────────────────────────────────────────────

describe('ready promise', () => {
  test('resolves when __ready message is received', async () => {
    const ss = new sharedServices(IFRAME_URL);
    let resolved = false;
    ss.ready.then(() => { resolved = true; });

    expect(resolved).toBe(false);
    ss._onMessage({ source: mockIframeCW, data: { __ss: true, __ready: true } });
    await ss.ready;
    expect(resolved).toBe(true);
  });

  test('ignores __ready messages from the wrong source', async () => {
    const ss    = new sharedServices(IFRAME_URL);
    const wrong = { postMessage: jest.fn() };

    ss._onMessage({ source: wrong, data: { __ss: true, __ready: true } });

    // ready should NOT have resolved — race with 10ms timeout
    const result = await Promise.race([
      ss.ready.then(() => 'resolved'),
      new Promise(r => setTimeout(() => r('timeout'), 10)),
    ]);
    expect(result).toBe('timeout');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _onMessage routing
// ─────────────────────────────────────────────────────────────────────────────

describe('_onMessage', () => {
  test('resolves pending promise on success response', async () => {
    const ss      = makeSS();
    const promise = ss.localStorage.getItem('key');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', 'theValue');
    expect(await promise).toBe('theValue');
  });

  test('rejects pending promise on error response', async () => {
    const ss      = makeSS();
    const promise = ss.localStorage.getItem('key');
    await Promise.resolve();
    respondError(ss, 'test-uuid-1', 'TypeError', 'something went wrong');
    await expect(promise).rejects.toMatchObject({ name: 'TypeError', message: 'something went wrong' });
  });

  test('removes fulfilled entry from pending map', async () => {
    const ss = makeSS();
    const p  = ss.localStorage.getItem('k');
    await Promise.resolve();
    expect(ss.pending.size).toBe(1);
    respond(ss, 'test-uuid-1', null);
    await p;
    expect(ss.pending.size).toBe(0);
  });

  test('dispatches __event to matching emitter', async () => {
    const ss      = makeSS();
    const emitter = { _emit: jest.fn() };
    ss._emitters.set('conn-abc', emitter);

    ss._onMessage({
      source: mockIframeCW,
      data:   { __ss: true, __event: true, connectionId: 'conn-abc', event: 'message', data: { text: 'hi' } },
    });

    expect(emitter._emit).toHaveBeenCalledWith('message', { text: 'hi' });
  });

  test('ignores __event for unknown connection id', () => {
    const ss = makeSS();
    expect(() => {
      ss._onMessage({
        source: mockIframeCW,
        data:   { __ss: true, __event: true, connectionId: 'no-such-id', event: 'message', data: {} },
      });
    }).not.toThrow();
  });

  test('ignores messages with __ss !== true', () => {
    const ss = makeSS();
    ss._onMessage({ source: mockIframeCW, data: { id: 'test-uuid-1', result: 'ignored' } });
    expect(ss.pending.size).toBe(0);
  });

  test('ignores messages from the wrong source window', async () => {
    const ss      = makeSS();
    const promise = ss.localStorage.getItem('k');
    await Promise.resolve();

    // respond from wrong source — should NOT resolve the promise
    const wrong = { postMessage: jest.fn() };
    ss._onMessage({ source: wrong, data: { __ss: true, id: 'test-uuid-1', result: 'injected', error: null } });

    const result = await Promise.race([
      promise.then(v => `resolved:${v}`),
      new Promise(r => setTimeout(() => r('timeout'), 10)),
    ]);
    expect(result).toBe('timeout');
    // clean up
    respond(ss, 'test-uuid-1', null);
    await promise;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// localStorage
// ─────────────────────────────────────────────────────────────────────────────

describe('localStorage', () => {
  const METHODS = [
    ['getItem',    [['myKey'],          ['myKey']]],
    ['setItem',    [['myKey', 'val'],   ['myKey', 'val']]],
    ['removeItem', [['myKey'],          ['myKey']]],
    ['clear',      [[],                 []]],
    ['key',        [[0],                [0]]],
    ['length',     [[],                 []]],
    ['getAll',     [[],                 []]],
  ];

  test.each(METHODS)('%s sends correct service/method/args', async (method, [callArgs, sentArgs]) => {
    const ss      = makeSS();
    const promise = ss.localStorage[method](...callArgs);
    await Promise.resolve();
    expect(mockPost).toHaveBeenCalledWith(
      { __ss: true, id: 'test-uuid-1', service: 'localStorage', method, args: sentArgs },
      ORIGIN
    );
    respond(ss, 'test-uuid-1', null);
    await promise;
  });

  test('setItem stringifies the value', async () => {
    const ss = makeSS();
    const p  = ss.localStorage.setItem('num', 42);
    await Promise.resolve();
    const { args } = mockPost.mock.calls[0][0];
    expect(args[1]).toBe('42'); // coerced to string
    respond(ss, 'test-uuid-1', null);
    await p;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sessionStorage (same contract, different service name)
// ─────────────────────────────────────────────────────────────────────────────

describe('sessionStorage', () => {
  test('uses service name "sessionStorage"', async () => {
    const ss = makeSS();
    const p  = ss.sessionStorage.getItem('k');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'sessionStorage', method: 'getItem', args: ['k'],
    });
    respond(ss, 'test-uuid-1', 'v');
    expect(await p).toBe('v');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('fetch', () => {
  test('sends fetch service/method with url and options', async () => {
    const ss = makeSS();
    const p  = ss.fetch('https://api.example.com/data', { method: 'POST', body: 'text' });
    await Promise.resolve();
    const sent = mockPost.mock.calls[0][0];
    expect(sent).toMatchObject({ service: 'fetch', method: 'fetch' });
    expect(sent.args[0]).toBe('https://api.example.com/data');
    expect(sent.args[1].method).toBe('POST');
    // clean up
    respond(ss, 'test-uuid-1', null);
    await p;
  });

  test('serializes ArrayBuffer body to number array', async () => {
    const ss  = makeSS();
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const p   = ss.fetch('https://api.example.com/', { body: buf });
    await Promise.resolve();
    const { args } = mockPost.mock.calls[0][0];
    expect(args[1].body).toEqual([1, 2, 3]);
    respond(ss, 'test-uuid-1', null);
    await p;
  });

  test('deserializes response into a Response-like object', async () => {
    const ss   = makeSS();
    const data = { ok: true, status: 200, statusText: 'OK', url: 'https://api.example.com/',
                   redirected: false, type: 'cors', headers: { 'content-type': 'application/json' },
                   body: [123, 125] }; // "{}"
    const p    = ss.fetch('https://api.example.com/');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', data);
    const res = await p;

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
    expect(await res.json()).toEqual({});
  });

  test('returns null-body Response-like when body array is empty', async () => {
    const ss   = makeSS();
    const p    = ss.fetch('https://api.example.com/');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { ok: true, status: 204, statusText: 'No Content',
                                  url: '', redirected: false, type: 'basic',
                                  headers: {}, body: [] });
    const res  = await p;
    expect(await res.text()).toBe('');
    const ab = await res.arrayBuffer();
    expect(ab.byteLength).toBe(0);
  });

  test('response.clone() returns an independent copy', async () => {
    const ss   = makeSS();
    const p    = ss.fetch('https://api.example.com/');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { ok: true, status: 200, statusText: 'OK', url: '',
                                  redirected: false, type: 'basic',
                                  headers: {}, body: [65] }); // "A"
    const res   = await p;
    const clone = res.clone();
    expect(await clone.text()).toBe('A');
    expect(await res.text()).toBe('A'); // original still readable
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// xhr
// ─────────────────────────────────────────────────────────────────────────────

describe('xhr', () => {
  test('sends correct service/method/args for a GET', async () => {
    const ss = makeSS();
    const p  = ss.xhr({ url: 'https://api.example.com/resource' });
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'xhr', method: 'xhr',
      args: [{ method: 'GET', url: 'https://api.example.com/resource', body: undefined,
              headers: undefined, responseType: undefined }],
    });
    respond(ss, 'test-uuid-1', { status: 200 });
    await p;
  });

  test('serializes ArrayBuffer body', async () => {
    const ss  = makeSS();
    const buf = new Uint8Array([10, 20]).buffer;
    const p   = ss.xhr({ method: 'POST', url: 'https://x.com/', body: buf });
    await Promise.resolve();
    const sentBody = mockPost.mock.calls[0][0].args[0].body;
    expect(sentBody).toEqual([10, 20]);
    respond(ss, 'test-uuid-1', { status: 201 });
    await p;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cache API — CacheStorage methods
// ─────────────────────────────────────────────────────────────────────────────

describe('cache storage methods', () => {
  test('keys() sends storage.keys', async () => {
    const ss = makeSS();
    const p  = ss.cache.keys();
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({ service: 'cache', method: 'storage.keys' });
    respond(ss, 'test-uuid-1', ['v1', 'v2']);
    expect(await p).toEqual(['v1', 'v2']);
  });

  test('has() sends storage.has', async () => {
    const ss = makeSS();
    const p  = ss.cache.has('v1');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({ service: 'cache', method: 'storage.has', args: ['v1'] });
    respond(ss, 'test-uuid-1', true);
    expect(await p).toBe(true);
  });

  test('delete() sends storage.delete', async () => {
    const ss = makeSS();
    const p  = ss.cache.delete('v1');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({ service: 'cache', method: 'storage.delete', args: ['v1'] });
    respond(ss, 'test-uuid-1', true);
    expect(await p).toBe(true);
  });

  test('match() deserializes response', async () => {
    const ss   = makeSS();
    const p    = ss.cache.match('/asset.js');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({ service: 'cache', method: 'storage.match' });
    respond(ss, 'test-uuid-1', { ok: true, status: 200, statusText: 'OK',
                                   url: '/asset.js', redirected: false,
                                   type: 'basic', headers: {}, body: [72] });
    const res = await p;
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('H');
  });

  test('match() returns null when result is null', async () => {
    const ss = makeSS();
    const p  = ss.cache.match('/missing');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', null);
    expect(await p).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cache API — cache.open() and Cache instance handle
// ─────────────────────────────────────────────────────────────────────────────

async function openCache(ss) {
  const pOpen = ss.cache.open('v1');
  await Promise.resolve();
  respond(ss, 'test-uuid-1', { cacheId: 'cache-remote-1' });
  return pOpen;
}

describe('cache.open() and Cache handle', () => {

  test('open() returns an object with cache instance methods', async () => {
    const ss    = makeSS();
    const cache = await openCache(ss);
    expect(typeof cache.match).toBe('function');
    expect(typeof cache.matchAll).toBe('function');
    expect(typeof cache.add).toBe('function');
    expect(typeof cache.addAll).toBe('function');
    expect(typeof cache.put).toBe('function');
    expect(typeof cache.delete).toBe('function');
    expect(typeof cache.keys).toBe('function');
  });

  test('cache.add() sends instance.add with cacheId and serialized request', async () => {
    const ss    = makeSS();
    const cache = await openCache(ss);
    mockPost.mockClear();

    const p = cache.add('/bundle.js');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'cache', method: 'instance.add',
      args:    ['cache-remote-1', '/bundle.js'],
    });
    respond(ss, 'test-uuid-2', null);
    await p;
  });

  test('cache.keys() sends instance.keys', async () => {
    const ss    = makeSS();
    const cache = await openCache(ss);
    mockPost.mockClear();

    const p = cache.keys();
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'cache', method: 'instance.keys',
      args:    ['cache-remote-1', null, undefined],
    });
    respond(ss, 'test-uuid-2', ['/bundle.js']);
    expect(await p).toEqual(['/bundle.js']);
  });

  test('cache.matchAll() with no request sends null', async () => {
    const ss    = makeSS();
    const cache = await openCache(ss);
    mockPost.mockClear();

    const p = cache.matchAll();
    await Promise.resolve();
    const [cacheId, req] = mockPost.mock.calls[0][0].args;
    expect(cacheId).toBe('cache-remote-1');
    expect(req).toBeNull();
    respond(ss, 'test-uuid-2', []);
    expect(await p).toEqual([]);
  });

  test('cache.put() serializes request URL and response body', async () => {
    const ss    = makeSS();
    const cache = await openCache(ss);
    mockPost.mockClear();

    const fakeResponse = {
      status: 200, statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      arrayBuffer: () => Promise.resolve(new Uint8Array([65, 66]).buffer),
    };
    const p = cache.put('/a.txt', fakeResponse);
    // arrayBuffer is async — use setTimeout flush
    await new Promise(r => setTimeout(r, 0));
    const sent = mockPost.mock.calls[0][0];
    expect(sent.method).toBe('instance.put');
    expect(sent.args[0]).toBe('cache-remote-1');
    expect(sent.args[2].body).toEqual([65, 66]);
    respond(ss, 'test-uuid-2', null);
    await p;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────────────────────────────────────

describe('websocket', () => {
  test('connect() sends websocket.connect and returns a handle with EventEmitter', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://echo.example.com');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'websocket', method: 'connect', args: ['wss://echo.example.com'],
    });
    respond(ss, 'test-uuid-1', { wsId: 'ws-remote-1' });
    const ws = await p;

    expect(ws.id).toBe('ws-remote-1');
    expect(typeof ws.on).toBe('function');
    expect(typeof ws.send).toBe('function');
    expect(typeof ws.close).toBe('function');
  });

  test('connect() with protocols includes them in args', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://echo.example.com', ['chat', 'binary']);
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0].args).toEqual(['wss://echo.example.com', ['chat', 'binary']]);
    respond(ss, 'test-uuid-1', { wsId: 'ws-r2' });
    await p;
  });

  test('ws.send() serializes string data', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://x.com');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { wsId: 'ws-abc' });
    const ws = await p;
    mockPost.mockClear();

    const sp = ws.send('hello');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'websocket', method: 'send', args: ['ws-abc', 'hello', false],
    });
    respond(ss, 'test-uuid-2', null);
    await sp;
  });

  test('ws.send() serializes ArrayBuffer as byte array', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://x.com');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { wsId: 'ws-bin' });
    const ws = await p;
    mockPost.mockClear();

    const buf = new Uint8Array([1, 2, 3]).buffer;
    const sp  = ws.send(buf);
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      args: ['ws-bin', [1, 2, 3], true],
    });
    respond(ss, 'test-uuid-2', null);
    await sp;
  });

  test('ws.close() removes emitter and sends websocket.close', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://x.com');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { wsId: 'ws-c' });
    const ws = await p;

    expect(ss._emitters.has('ws-c')).toBe(true);
    mockPost.mockClear();
    const cp = ws.close(1000, 'done');
    await Promise.resolve();

    expect(ss._emitters.has('ws-c')).toBe(false);
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'websocket', method: 'close', args: ['ws-c', 1000, 'done'],
    });
    respond(ss, 'test-uuid-2', null);
    await cp;
  });

  test('incoming __event messages are emitted on the ws handle', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://x.com');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { wsId: 'ws-ev' });
    const ws = await p;

    const received = [];
    ws.on('message', data => received.push(data));

    ss._onMessage({
      source: mockIframeCW,
      data:   { __ss: true, __event: true, connectionId: 'ws-ev', event: 'message', data: { data: 'ping', isBinary: false } },
    });

    expect(received).toEqual([{ data: 'ping', isBinary: false }]);
  });

  test('ws.once() fires only once', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://x.com');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { wsId: 'ws-once' });
    const ws = await p;

    const hits = [];
    ws.once('message', d => hits.push(d));

    const push = (data) => ss._onMessage({
      source: mockIframeCW,
      data:   { __ss: true, __event: true, connectionId: 'ws-once', event: 'message', data },
    });

    push({ data: 'first' });
    push({ data: 'second' });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ data: 'first' });
  });

  test('ws.off() removes a listener', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://x.com');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { wsId: 'ws-off' });
    const ws = await p;

    const hits  = [];
    const fn    = d => hits.push(d);
    ws.on('message', fn);
    ws.off('message', fn);

    ss._onMessage({
      source: mockIframeCW,
      data:   { __ss: true, __event: true, connectionId: 'ws-off', event: 'message', data: {} },
    });

    expect(hits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SharedWorker
// ─────────────────────────────────────────────────────────────────────────────

describe('sharedWorker', () => {
  test('connect() sends sharedWorker.connect and returns a handle', async () => {
    const ss = makeSS();
    const p  = ss.sharedWorker.connect('https://user.github.io/worker.js');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'sharedWorker', method: 'connect',
      args:    ['https://user.github.io/worker.js'],
    });
    respond(ss, 'test-uuid-1', { workerId: 'w-1' });
    const worker = await p;
    expect(worker.id).toBe('w-1');
    expect(typeof worker.postMessage).toBe('function');
    expect(typeof worker.disconnect).toBe('function');
  });

  test('connect() with name includes it in args', async () => {
    const ss = makeSS();
    const p  = ss.sharedWorker.connect('https://user.github.io/worker.js', 'my-worker');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0].args).toEqual([
      'https://user.github.io/worker.js', 'my-worker',
    ]);
    respond(ss, 'test-uuid-1', { workerId: 'w-2' });
    await p;
  });

  test('worker.postMessage() sends sharedWorker.postMessage', async () => {
    const ss = makeSS();
    const p  = ss.sharedWorker.connect('https://user.github.io/worker.js');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { workerId: 'w-3' });
    const worker = await p;
    mockPost.mockClear();

    const mp = worker.postMessage({ type: 'ping' });
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'sharedWorker', method: 'postMessage',
      args:    ['w-3', { type: 'ping' }],
    });
    respond(ss, 'test-uuid-2', null);
    await mp;
  });

  test('worker.disconnect() removes emitter and sends sharedWorker.disconnect', async () => {
    const ss = makeSS();
    const p  = ss.sharedWorker.connect('https://user.github.io/worker.js');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { workerId: 'w-4' });
    const worker = await p;

    expect(ss._emitters.has('w-4')).toBe(true);
    mockPost.mockClear();
    const dp = worker.disconnect();
    await Promise.resolve();

    expect(ss._emitters.has('w-4')).toBe(false);
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'sharedWorker', method: 'disconnect', args: ['w-4'],
    });
    respond(ss, 'test-uuid-2', null);
    await dp;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BroadcastChannel
// ─────────────────────────────────────────────────────────────────────────────

describe('broadcastChannel', () => {
  test('subscribe() sends broadcastChannel.subscribe and returns a handle', async () => {
    const ss = makeSS();
    const p  = ss.broadcastChannel.subscribe('app-events');
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'broadcastChannel', method: 'subscribe', args: ['app-events'],
    });
    respond(ss, 'test-uuid-1', { channelId: 'bc-1' });
    const ch = await p;
    expect(ch.id).toBe('bc-1');
    expect(typeof ch.postMessage).toBe('function');
    expect(typeof ch.close).toBe('function');
  });

  test('ch.postMessage() sends broadcastChannel.postMessage', async () => {
    const ss = makeSS();
    const p  = ss.broadcastChannel.subscribe('sync');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { channelId: 'bc-2' });
    const ch = await p;
    mockPost.mockClear();

    const mp = ch.postMessage({ action: 'reload' });
    await Promise.resolve();
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'broadcastChannel', method: 'postMessage',
      args:    ['bc-2', { action: 'reload' }],
    });
    respond(ss, 'test-uuid-2', null);
    await mp;
  });

  test('ch.close() removes emitter and sends broadcastChannel.close', async () => {
    const ss = makeSS();
    const p  = ss.broadcastChannel.subscribe('sync');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { channelId: 'bc-3' });
    const ch = await p;

    expect(ss._emitters.has('bc-3')).toBe(true);
    mockPost.mockClear();
    const cp = ch.close();
    await Promise.resolve();

    expect(ss._emitters.has('bc-3')).toBe(false);
    expect(mockPost.mock.calls[0][0]).toMatchObject({
      service: 'broadcastChannel', method: 'close', args: ['bc-3'],
    });
    respond(ss, 'test-uuid-2', null);
    await cp;
  });

  test('incoming messages are emitted as events on the handle', async () => {
    const ss = makeSS();
    const p  = ss.broadcastChannel.subscribe('tab-sync');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { channelId: 'bc-4' });
    const ch = await p;

    const got = [];
    ch.on('message', d => got.push(d));

    ss._onMessage({
      source: mockIframeCW,
      data:   { __ss: true, __event: true, connectionId: 'bc-4', event: 'message', data: { from: 'tab-B' } },
    });

    expect(got).toEqual([{ from: 'tab-B' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// destroy
// ─────────────────────────────────────────────────────────────────────────────

describe('destroy', () => {
  test('calls remove() on the iframe', () => {
    const ss = makeSS();
    ss.destroy();
    expect(mockIframe.remove).toHaveBeenCalled();
  });

  test('rejects all pending promises', async () => {
    const ss = makeSS();
    const p  = ss.localStorage.getItem('k');
    await Promise.resolve();
    expect(ss.pending.size).toBe(1);

    ss.destroy();
    await expect(p).rejects.toThrow('sharedServices destroyed');
  });

  test('clears the pending map', () => {
    const ss = makeSS();
    ss.destroy();
    expect(ss.pending.size).toBe(0);
  });

  test('clears the emitters map', async () => {
    const ss = makeSS();
    const p  = ss.websocket.connect('wss://x.com');
    await Promise.resolve();
    respond(ss, 'test-uuid-1', { wsId: 'ws-d' });
    await p;
    expect(ss._emitters.size).toBe(1);

    ss.destroy();
    expect(ss._emitters.size).toBe(0);
  });

  test('stops routing messages after destroy', async () => {
    const ss = makeSS();
    ss.destroy();

    // Send a message — should not throw
    expect(() => {
      ss._onMessage({
        source: mockIframeCW,
        data:   { __ss: true, id: 'orphan', result: 'x', error: null },
      });
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _send — concurrent requests get independent IDs
// ─────────────────────────────────────────────────────────────────────────────

describe('concurrent requests', () => {
  test('each _send call gets a unique UUID and resolves independently', async () => {
    const ss = makeSS();

    const p1 = ss.localStorage.getItem('a');
    const p2 = ss.localStorage.getItem('b');
    await Promise.resolve();

    expect(ss.pending.size).toBe(2);
    respond(ss, 'test-uuid-2', 'valB');
    respond(ss, 'test-uuid-1', 'valA');

    expect(await p1).toBe('valA');
    expect(await p2).toBe('valB');
  });
});
