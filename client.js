/**
 * client.js — SharedServices client library
 * ==========================================
 * Include this on any parent page to communicate with a shared-services.html
 * iframe deployed to GitHub Pages.
 *
 * All services are proxied through the iframe so they execute under the
 * GitHub Pages origin, meaning localStorage, Cache API, BroadcastChannels,
 * and SharedWorkers all share a single namespace across every parent domain
 * that embeds the same hosted iframe URL.
 *
 * Quick start
 * -----------
 *   const ss = new SharedServices('https://patrick-ring-motive.github.io/shared-services/shared-services.html');
 *   await ss.ready;
 *
 *   // localStorage (keyed to the GitHub Pages origin)
 *   await ss.localStorage.setItem('theme', 'dark');
 *   const theme = await ss.localStorage.getItem('theme');
 *
 *   // fetch (issued from the GitHub Pages origin)
 *   const res  = await ss.fetch('https://api.example.com/data');
 *   const json = await res.json();
 *
 *   // Cache API
 *   const cache = await ss.cache.open('v1');
 *   await cache.add('/asset.js');
 *   const hit = await cache.match('/asset.js');
 *
 *   // XHR
 *   const xhrRes = await ss.xhr({ method: 'GET', url: 'https://api.example.com/data' });
 *
 *   // WebSocket
 *   const ws = await ss.websocket.connect('wss://echo.example.com');
 *   ws.on('message', ({ data }) => console.log('ws message:', data));
 *   ws.on('close',   ({ code }) => console.log('ws closed:', code));
 *   await ws.send('hello');
 *
 *   // SharedWorker (worker script must be fetchable from the iframe's origin)
 *   const worker = await ss.sharedWorker.connect('https://your-name.github.io/shared-services/worker.js');
 *   worker.on('message', ({ data }) => console.log('worker:', data));
 *   worker.postMessage({ type: 'ping' });
 *
 *   // BroadcastChannel (shared across ALL tabs that embed this iframe URL)
 *   const chan = await ss.broadcastChannel.subscribe('app-events');
 *   chan.on('message', ({ data }) => console.log('broadcast:', data));
 *   chan.postMessage({ action: 'refresh' });
 *
 *   // Cleanup
 *   ss.destroy();
 *
 * Pending promises map
 * --------------------
 * Every in-flight request is stored in ss.pending — a public Map keyed by
 * crypto.randomUUID() values.  You can inspect it for debugging:
 *   console.log(ss.pending.size); // number of in-flight requests
 */

"use strict";

/* =======================================================================
   EventEmitter  lightweight events for persistent connections
   ======================================================================= */

class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
    return this;
  }

  once(event, fn) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      fn(data);
    };
    return this.on(event, wrapper);
  }

  _emit(event, data) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const fn of handlers) {
      try {
        fn(data);
      } catch (e) {
        console.error("[SharedServices] listener error:", e);
      }
    }
  }
}

/* =======================================================================
   Serialization helpers
   ======================================================================= */

function serializeRequest(req) {
  if (!req || typeof req === "string") return req;
  if (typeof Request !== "undefined" && req instanceof Request) {
    return {
      url: req.url,
      method: req.method
    };
  }
  return req;
}

function deserializeResponse(data) {
  if (!data) return null;
  const bodyBytes = data.body?.length ? new Uint8Array(data.body) : null;

  return {
    ok: data.ok,
    status: data.status,
    statusText: data.statusText,
    url: data.url,
    redirected: data.redirected,
    type: data.type,
    headers: new Headers(data.headers || {}),
    bodyUsed: false,
    arrayBuffer() {
      if (!bodyBytes) return Promise.resolve(new ArrayBuffer(0));
      return Promise.resolve(
        bodyBytes.buffer.slice(
          bodyBytes.byteOffset,
          bodyBytes.byteOffset + bodyBytes.byteLength,
        ),
      );
    },
    text() {
      return Promise.resolve(
        bodyBytes ? new TextDecoder().decode(bodyBytes) : "",
      );
    },
    json() {
      return this.text().then(JSON.parse);
    },
    blob() {
      const mime = data.headers?.["content-type"] ?? "";
      return Promise.resolve(
        bodyBytes ? new Blob([bodyBytes], {
          type: mime
        }) : new Blob([]),
      );
    },
    clone() {
      return deserializeResponse(data);
    },
  };
}

function serializeBody(body) {
  if (!body) return body;
  if (body instanceof ArrayBuffer) return Array.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Array.from(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  return body;
}

/* =======================================================================
   SharedServices  main class
   ======================================================================= */

class SharedServices {
  /**
   * @param {string} iframeUrl  Absolute URL to the hosted shared-services.html
   * @param {object} [options]
   * @param {string} [options.targetOrigin]  Restrict postMessage to this origin.
   *   Defaults to the origin of iframeUrl.  Set '*' only for local development.
   */
  constructor(iframeUrl, options = {}) {
    this._url = iframeUrl;
    this._targetOrigin = options.targetOrigin || new URL(iframeUrl).origin;
    this._iframe = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._generateId = options.generateId || null;

    /**
     * All in-flight requests, keyed by crypto.randomUUID().
     * @type {Map<string, {resolve: Function, reject: Function}>}
     */
    this.pending = new Map();

    /**
     * EventEmitters for persistent connections.
     * @type {Map<string, EventEmitter>}
     */
    this._emitters = new Map();

    this._messageHandler = (evt) => this._onMessage(evt);

    /**
     * Resolves once the iframe signals it is ready.
     * @type {Promise<void>}
     */
    this.ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    try {
      this._mountIframe(); // sync DOM mutation; readiness arrives via postMessage __ready
    } catch (err) {
      this._readyReject(err);
    }
    globalThis.addEventListener("message", this._messageHandler);

    this.localStorage = this._makeStorageAPI("localStorage");
    this.sessionStorage = this._makeStorageAPI("sessionStorage");
    this.cache = this._makeCacheAPI();
    this.websocket = this._makeWebSocketAPI();
    this.sharedWorker = this._makeSharedWorkerAPI();
    this.broadcastChannel = this._makeBroadcastChannelAPI();
  }

  /* ---- iframe mount -------------------------------------------------- */

  _mountIframe() {
    const iframe = document.createElement("iframe");
    iframe.src = this._url;
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    iframe.style.cssText = [
      "position:fixed",
      "width:0",
      "height:0",
      "border:0",
      "opacity:0",
      "pointer-events:none",
      "top:-9999px",
      "left:-9999px",
    ].join(";");
    iframe.addEventListener("error", (e) => {
      const err = new Error(
        `Failed to load SharedServices iframe from ${this._url}`,
      );
      this._readyReject(err);
    });
    iframe.addEventListener("load", () => {
      try {
        const doc = iframe.contentDocument;
        if (!doc || !doc.body.innerHTML) {
          throw new Error(
            "Iframe loaded but document is empty, likely due to cross-origin restrictions",
          );
        }
      } catch (e) {
        console.warn(
          "iframe loaded but is cross-origin; readiness will be determined by postMessage",
        );
        this._readyReject(e);
      }
    });
    document.addEventListener("securitypolicyviolation", (e) => {
      if (e.blockedURI === iframe.src) {
        const err = new Error(
          `Content Security Policy blocked loading SharedServices iframe from ${this._url}`,
        );
        this._readyReject(err);
      }
    });
    this._iframe = iframe;
    document.firstElementChild.appendChild(iframe);
  }

  /* ---- inbound messages ---------------------------------------------- */

  _onMessage(event) {
    if (event.source !== this._iframe?.contentWindow) return;
    const msg = event.data;
    if (msg?.__ss !== true) return;

    if (msg.__ready) {
      const resolve = this._readyResolve;
      this._readyResolve = null;
      if (resolve) resolve();
      return;
    }

    if (msg.__event) {
      this._emitters.get(msg.connectionId)?._emit(msg.event, msg.data);
      return;
    }

    if (msg.id && this.pending.has(msg.id)) {
      const {
        resolve,
        reject
      } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || String(msg.error));
        err.name = msg.error.name || "Error";
        reject(err);
      } else {
        resolve(msg.result);
      }
    }
  }

  /* ---- outbound requests -------------------------------------------- */

  _send(service, method, args) {
    return this.ready.then(
      () =>
      new Promise((resolve, reject) => {
        let id;
        if (this._generateId) {
          id = this._generateId();
        } else if (
          typeof crypto !== "undefined" &&
          typeof crypto.randomUUID === "function"
        ) {
          id = crypto.randomUUID();
        } else {
          id = Math.random().toString(36).slice(2);
        }
        this.pending.set(id, {
          resolve,
          reject
        });
        this._iframe.contentWindow.postMessage({
            __ss: true,
            id,
            service,
            method,
            args
          },
          this._targetOrigin,
        );
      }),
    );
  }

  /* ---- localStorage / sessionStorage --------------------------------- */

  _makeStorageAPI(type) {
    const send = (method, args) => this._send(type, method, args);
    return {
      getItem: (key) => send("getItem", [key]),
      setItem: (key, value) => send("setItem", [key, String(value)]),
      removeItem: (key) => send("removeItem", [key]),
      clear: () => send("clear", []),
      key: (index) => send("key", [index]),
      length: () => send("length", []),
      getAll: () => send("getAll", []),
    };
  }

  /* ---- fetch ---------------------------------------------------------- */

  async fetch(url, options = {}) {
    const init = {
      ...options,
      body: serializeBody(options.body)
    };
    const data = await this._send("fetch", "fetch", [url, init]);
    return deserializeResponse(data);
  }

  /* ---- XHR ------------------------------------------------------------ */

  xhr({
    method = "GET",
    url,
    body,
    headers,
    responseType
  } = {}) {
    return this._send("xhr", "xhr", [{
      method,
      url,
      body: serializeBody(body),
      headers,
      responseType
    }, ]);
  }

  /* ---- Cache API ------------------------------------------------------ */

  _makeCacheAPI() {
    const send = (method, args) => this._send("cache", method, args);

    const makeCacheHandle = (cacheId) => ({
      match: (req, opts) =>
        send("instance.match", [cacheId, serializeRequest(req), opts]).then(
          deserializeResponse,
        ),

      matchAll: async (req, opts) => {
        const arr = await send("instance.matchAll", [
          cacheId,
          req ? serializeRequest(req) : null,
          opts,
        ]);
        return (arr ?? []).map(deserializeResponse);
      },

      add: (req) => send("instance.add", [cacheId, serializeRequest(req)]),
      addAll: (reqs) =>
        send("instance.addAll", [cacheId, reqs.map(serializeRequest)]),
      delete: (req, opts) =>
        send("instance.delete", [cacheId, serializeRequest(req), opts]),
      keys: (req, opts) =>
        send("instance.keys", [
          cacheId,
          req ? serializeRequest(req) : null,
          opts,
        ]),

      put: async (req, res) => {
        const buf = await res.arrayBuffer();
        const entries =
          typeof res.headers.entries === "function" ?
          res.headers.entries() :
          Object.entries(res.headers);
        return send("instance.put", [
          cacheId,
          serializeRequest(req),
          {
            status: res.status,
            statusText: res.statusText,
            headers: Object.fromEntries(entries),
            body: Array.from(new Uint8Array(buf)),
          },
        ]);
      },
    });

    return {
      open: async (name) => {
        const {
          cacheId
        } = await send("storage.open", [name]);
        return makeCacheHandle(cacheId);
      },
      match: async (req, opts) =>
        deserializeResponse(
          await send("storage.match", [serializeRequest(req), opts]),
        ),
      has: (name) => send("storage.has", [name]),
      delete: (name) => send("storage.delete", [name]),
      keys: () => send("storage.keys", []),
    };
  }

  /* ---- WebSocket ------------------------------------------------------ */

  _makeWebSocketAPI() {
    return {
      /**
       * Open a WebSocket from the iframe's origin.
       * Returned handle extends EventEmitter.
       * Events: 'message' {data, isBinary}, 'error' {message}, 'close' {code, reason, wasClean}
       * @param {string}          url
       * @param {string|string[]} [protocols]
       * @returns {Promise<WebSocketHandle>}
       */
      connect: async (url, protocols) => {
        const {
          wsId
        } = await this._send(
          "websocket",
          "connect",
          protocols ? [url, protocols] : [url],
        );
        const emitter = new EventEmitter();
        this._emitters.set(wsId, emitter);

        return Object.assign(emitter, {
          id: wsId,
          send: (data) => {
            const isBinary =
              data instanceof ArrayBuffer || ArrayBuffer.isView(data);
            const buf = ArrayBuffer.isView(data) ? data.buffer : data;
            const payload = isBinary ? Array.from(new Uint8Array(buf)) : data;
            return this._send("websocket", "send", [wsId, payload, isBinary]);
          },
          close: (code, reason) => {
            this._emitters.delete(wsId);
            return this._send("websocket", "close", [wsId, code, reason]);
          },
        });
      },
    };
  }

  /* ---- SharedWorker -------------------------------------------------- */

  _makeSharedWorkerAPI() {
    return {
      /**
       * Connect to a SharedWorker from the iframe's origin.
       * Events: 'message' {data}, 'error' {message}
       * @param {string} url    Worker script URL
       * @param {string} [name] Optional worker name
       * @returns {Promise<SharedWorkerHandle>}
       */
      connect: async (url, name) => {
        const {
          workerId
        } = await this._send(
          "sharedWorker",
          "connect",
          name ? [url, name] : [url],
        );
        const emitter = new EventEmitter();
        this._emitters.set(workerId, emitter);

        return Object.assign(emitter, {
          id: workerId,
          postMessage: (data) =>
            this._send("sharedWorker", "postMessage", [workerId, data]),
          disconnect: () => {
            this._emitters.delete(workerId);
            return this._send("sharedWorker", "disconnect", [workerId]);
          },
        });
      },
    };
  }

  /* ---- BroadcastChannel ---------------------------------------------- */

  _makeBroadcastChannelAPI() {
    return {
      /**
       * Subscribe to a BroadcastChannel on the iframe's origin.
       * All SharedServices instances that pass the same channel name will
       * receive each other's messages (cross-domain cross-tab communication).
       * Events: 'message' {data}, 'messageerror' {}
       * @param {string} name Channel name
       * @returns {Promise<BroadcastChannelHandle>}
       */
      subscribe: async (name) => {
        const {
          channelId
        } = await this._send(
          "broadcastChannel",
          "subscribe",
          [name],
        );
        const emitter = new EventEmitter();
        this._emitters.set(channelId, emitter);

        return Object.assign(emitter, {
          id: channelId,
          postMessage: (data) =>
            this._send("broadcastChannel", "postMessage", [channelId, data]),
          close: () => {
            this._emitters.delete(channelId);
            return this._send("broadcastChannel", "close", [channelId]);
          },
        });
      },
    };
  }

  /* ---- cleanup ------------------------------------------------------- */

  /**
   * Remove the hidden iframe, reject pending promises, and detach listeners.
   */
  destroy() {
    globalThis.removeEventListener("message", this._messageHandler);
    this._iframe?.remove();
    for (const {
        reject
      }
      of this.pending.values()) {
      reject(new Error("SharedServices destroyed"));
    }
    this.pending.clear();
    this._emitters.clear();
  }
}

/* =======================================================================
   Export (UMD-compatible)
   ======================================================================= */

if (typeof module !== "undefined" && module.exports) {
  module.exports = SharedServices;
} else if (typeof define === "function" && define.amd) {
  define([], () => SharedServices);
} else {
  globalThis.SharedServices = SharedServices;
}
