'use strict';
// Polyfill TextDecoder / TextEncoder for jest-environment-jsdom (jsdom 20
// includes the implementation but doesn't hoist it to the global scope).
const {
  TextDecoder,
  TextEncoder
} = require('node:util');
if (globalThis.TextDecoder === undefined) globalThis.TextDecoder = TextDecoder;
if (globalThis.TextEncoder === undefined) globalThis.TextEncoder = TextEncoder;
