/**
 * BLAKE3 SIMD Wrapper for blake3-optimized v1.3.0
 * Uses WASM SIMD acceleration for optimized single-threaded hashing
 */
'use strict';

const blake3 = require('../../../blake3-optimized/index.js');

let initPromise = null;

async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      if (blake3.initSimd) {
        await blake3.initSimd();
        console.log('SIMD initialized:', blake3.isSimdEnabled ? blake3.isSimdEnabled() : 'unknown');
      }
    })();
  }
  return initPromise;
}

// benchmark.js calls hash() without await on init, so init must happen here
async function hash(input) {
  await ensureInit();
  return blake3.hash(input);
}

module.exports = { hash };
