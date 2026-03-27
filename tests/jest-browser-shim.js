/**
 * jest-browser-shim.js
 *
 * A minimal browser-compatible implementation of the Jest APIs used by
 * client.test.js.  Exposes: jest, expect, describe, test, it,
 * beforeEach, afterEach, and __runTests (call to execute the suite).
 */
(function(root) {
  'use strict';

  // ── Mock functions ──────────────────────────────────────────────────────────

  const allMocks = [];
  const allSpies = [];

  function createMockFn(defaultImpl) {
    const calls = [];
    const onceQ = [];
    let impl = defaultImpl || null;

    function mock(...args) {
      calls.push(args);
      const fn = onceQ.length ? onceQ.shift() : impl;
      return fn ? fn(...args) : undefined;
    }

    mock._isMock = true;
    mock.mock = {
      calls
    };
    mock.mockClear = () => {
      calls.length = 0;
      return mock;
    };
    mock.mockReset = () => {
      calls.length = 0;
      onceQ.length = 0;
      impl = null;
      return mock;
    };
    mock.mockReturnValue = (v) => {
      impl = () => v;
      return mock;
    };
    mock.mockResolvedValue = (v) => {
      impl = () => Promise.resolve(v);
      return mock;
    };
    mock.mockRejectedValue = (v) => {
      impl = () => Promise.reject(v);
      return mock;
    };
    mock.mockReturnValueOnce = (v) => {
      onceQ.push(() => v);
      return mock;
    };
    mock.mockResolvedValueOnce = (v) => {
      onceQ.push(() => Promise.resolve(v));
      return mock;
    };
    mock.mockRejectedValueOnce = (v) => {
      onceQ.push(() => Promise.reject(v));
      return mock;
    };
    mock.mockImplementation = (fn) => {
      impl = fn;
      return mock;
    };
    mock.mockImplementationOnce = (fn) => {
      onceQ.push(fn);
      return mock;
    };

    allMocks.push(mock);
    return mock;
  }

  function spyOn(obj, method) {
    const original = obj[method];
    const spy = createMockFn(typeof original === 'function' ? (...a) => original.apply(obj, a) : undefined);
    spy._spyOriginal = original;
    spy._spyObj = obj;
    spy._spyMethod = method;
    Object.defineProperty(obj, method, {
      value: spy,
      configurable: true,
      writable: true
    });
    allSpies.push(spy);
    return spy;
  }

  const jest = {
    fn: createMockFn,
    spyOn,
    restoreAllMocks() {
      while (allSpies.length) {
        const spy = allSpies.pop();
        Object.defineProperty(spy._spyObj, spy._spyMethod, {
          value: spy._spyOriginal,
          configurable: true,
          writable: true,
        });
      }
    },
    clearAllMocks() {
      for (const m of allMocks) m.mockClear();
    },
  };

  // ── Asymmetric matchers ─────────────────────────────────────────────────────

  function asym(match, desc) {
    return {
      _asymmetric: true,
      _match: match,
      toString: () => desc
    };
  }

  function objectContaining(exp) {
    return asym((v) => partialMatch(v, exp), `objectContaining(${JSON.stringify(exp)})`);
  }

  function any(Ctor) {
    return asym(
      (v) => v instanceof Ctor || (Ctor === String && typeof v === 'string') ||
      (Ctor === Number && typeof v === 'number') || (Ctor === Array && Array.isArray(v)),
      `any(${Ctor.name})`
    );
  }

  function stringContaining(s) {
    return asym((v) => typeof v === 'string' && v.includes(s), `stringContaining("${s}")`);
  }

  // ── Deep equality ───────────────────────────────────────────────────────────

  function deepEquals(a, b) {
    if (b && b._asymmetric) return b._match(a);
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => deepEquals(v, b[i]));
    }
    if (typeof a === 'object') {
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every((k) => deepEquals(a[k], b[k]));
    }
    return false;
  }

  function partialMatch(actual, expected) {
    if (!expected || typeof expected !== 'object') return deepEquals(actual, expected);
    if (expected._asymmetric) return expected._match(actual);
    if (!actual || typeof actual !== 'object') return false;
    return Object.keys(expected).every((k) => {
      if (expected[k] && expected[k]._asymmetric) return expected[k]._match(actual[k]);
      if (expected[k] && typeof expected[k] === 'object' && !Array.isArray(expected[k])) {
        return partialMatch(actual[k], expected[k]);
      }
      return deepEquals(actual[k], expected[k]);
    });
  }

  // ── Expect ──────────────────────────────────────────────────────────────────

  function makeExpect(value, negated) {
    const assert = (ok, msg) => {
      if (negated ? ok : !ok) {
        const e = new Error(negated ? `Not expected: ${msg}` : msg);
        e.name = 'AssertionError';
        throw e;
      }
    };

    return {
      get not() {
        return makeExpect(value, !negated);
      },

      toBe(expected) {
        assert(value === expected, `Expected ${String(value)} to be ${String(expected)}`);
      },
      toEqual(expected) {
        assert(deepEquals(value, expected), `Expected\n  ${JSON.stringify(value)}\nto equal\n  ${JSON.stringify(expected)}`);
      },
      toBeDefined() {
        assert(value !== undefined, `Expected value to be defined`);
      },
      toBeUndefined() {
        assert(value === undefined, `Expected ${JSON.stringify(value)} to be undefined`);
      },
      toBeNull() {
        assert(value === null, `Expected ${JSON.stringify(value)} to be null`);
      },
      toBeTruthy() {
        assert(Boolean(value), `Expected ${JSON.stringify(value)} to be truthy`);
      },
      toBeFalsy() {
        assert(!value, `Expected ${JSON.stringify(value)} to be falsy`);
      },
      toBeInstanceOf(C) {
        assert(value instanceof C, `Expected value to be instance of ${C.name}`);
      },
      toHaveLength(len) {
        assert(value != null && value.length === len, `Expected length ${value?.length} to equal ${len}`);
      },
      toMatchObject(exp) {
        assert(partialMatch(value, exp), `Expected\n  ${JSON.stringify(value)}\nto match\n  ${JSON.stringify(exp)}`);
      },
      toContain(item) {
        const ok = Array.isArray(value) ? value.includes(item) : typeof value === 'string' && value.includes(item);
        assert(ok, `Expected ${JSON.stringify(value)} to contain ${JSON.stringify(item)}`);
      },
      toThrow(msg) {
        if (typeof value !== 'function') throw new Error('toThrow() requires a function');
        let caught;
        try {
          value();
        } catch (e) {
          caught = e;
        }
        if (msg !== undefined) {
          assert(caught && (caught.message === msg || caught.message.includes(msg)),
            `Expected function to throw "${msg}", got: ${caught?.message}`);
        } else {
          assert(Boolean(caught), `Expected function to throw`);
        }
      },

      // Mock matchers
      toHaveBeenCalled() {
        assert(value && value._isMock && value.mock.calls.length > 0,
          `Expected mock to have been called (called ${value?.mock?.calls?.length ?? 0} times)`);
      },
      toHaveBeenCalledWith(...args) {
        const ok = value && value._isMock && value.mock.calls.some((call) =>
          call.length === args.length &&
          args.every((a, i) => a && a._asymmetric ? a._match(call[i]) : deepEquals(call[i], a))
        );
        assert(ok,
          `Expected mock to have been called with ${JSON.stringify(args)}\nActual calls: ${JSON.stringify(value?.mock?.calls)}`);
      },

      // Async helpers
      get rejects() {
        return {
          async toThrow(msg) {
            let err;
            try {
              await value;
            } catch (e) {
              err = e;
            }
            if (!err) throw new Error('Expected promise to reject, but it resolved');
            if (msg !== undefined && !(err.message === msg || err.message.includes(msg))) {
              throw new Error(`Expected rejection to include "${msg}", got: "${err.message}"`);
            }
          },
          async toMatchObject(exp) {
            let err;
            try {
              await value;
            } catch (e) {
              err = e;
            }
            if (!err) throw new Error('Expected promise to reject, but it resolved');
            if (!partialMatch(err, exp)) {
              throw new Error(`Expected rejection\n  ${JSON.stringify(err)}\nto match\n  ${JSON.stringify(exp)}`);
            }
          },
        };
      },
    };
  }

  function expect(value) {
    return makeExpect(value, false);
  }
  expect.objectContaining = objectContaining;
  expect.any = any;
  expect.stringContaining = stringContaining;

  // ── Test runner ─────────────────────────────────────────────────────────────

  const queue = [];
  const stack = [{
    name: null,
    beforeEach: [],
    afterEach: []
  }]; // root frame

  function describe(name, fn) {
    stack.push({
      name,
      beforeEach: [],
      afterEach: []
    });
    fn();
    stack.pop();
  }

  function beforeEach(fn) {
    stack[stack.length - 1].beforeEach.push(fn);
  }

  function afterEach(fn) {
    stack[stack.length - 1].afterEach.push(fn);
  }

  function test(name, fn) {
    const prefix = stack.map((f) => f.name).filter(Boolean).join(' › ');
    const fullName = prefix ? `${prefix} › ${name}` : name;
    const befores = stack.flatMap((f) => f.beforeEach);
    const afters = stack.flatMap((f) => f.afterEach).reverse();
    queue.push({
      name: fullName,
      fn,
      befores,
      afters
    });
  }

  test.each = (cases) => (nameTpl, fn) => {
    for (const row of cases) {
      const args = Array.isArray(row) ? row : [row];
      const label = nameTpl.replace('%s', String(args[0]));
      test(label, () => fn(...args));
    }
  };

  const it = test;

  // ── Rendering ───────────────────────────────────────────────────────────────

  async function runAll() {
    const container = document.getElementById('results') || document.body;
    let passed = 0;
    let failed = 0;

    const header = document.createElement('div');
    header.style.cssText =
      'font-size:14px;font-weight:600;padding:10px 14px;border-radius:6px;' +
      'margin-bottom:16px;background:#f1f5f9;color:#334155';
    header.textContent = `Running ${queue.length} tests…`;
    container.appendChild(header);

    const list = document.createElement('ul');
    list.style.cssText = 'list-style:none;padding:0;margin:0;font-family:ui-monospace,monospace;font-size:13px';
    container.appendChild(list);

    for (const {
        name,
        fn,
        befores,
        afters
      }
      of queue) {
      const li = document.createElement('li');
      li.style.cssText = 'padding:3px 8px;border-bottom:1px solid #f1f5f9';

      try {
        for (const h of befores) await h();
        await fn();
        for (const h of afters) {
          try {
            await h();
          } catch (_) {}
        }
        li.textContent = `✓  ${name}`;
        li.style.color = '#16a34a';
        passed++;
      } catch (e) {
        for (const h of afters) {
          try {
            await h();
          } catch (_) {}
        }
        li.textContent = `✗  ${name}`;
        li.style.color = '#dc2626';
        const detail = document.createElement('pre');
        detail.style.cssText =
          'margin:2px 0 6px 20px;font-size:11px;color:#b91c1c;white-space:pre-wrap';
        detail.textContent = e.message;
        li.appendChild(detail);
        console.error(`FAIL: ${name}`, e);
        failed++;
      }

      list.appendChild(li);
    }

    const total = passed + failed;
    header.textContent =
      failed > 0 ? `${failed} failed, ${passed} passed — ${total} total` :
      `All ${passed} tests passed`;
    header.style.background = failed > 0 ? '#fee2e2' : '#dcfce7';
    header.style.color = failed > 0 ? '#991b1b' : '#166534';
  }

  // ── Globals ─────────────────────────────────────────────────────────────────

  root.jest = jest;
  root.expect = expect;
  root.describe = describe;
  root.test = test;
  root.it = it;
  root.beforeEach = beforeEach;
  root.afterEach = afterEach;
  root.__runTests = runAll;

}(typeof globalThis !== 'undefined' ? globalThis : this));
