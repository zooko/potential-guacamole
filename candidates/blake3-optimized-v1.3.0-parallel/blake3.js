/**
 * BLAKE3 Parallel Wrapper for blake3-optimized v1.3.0
 * Uses worker_threads for multi-threaded hashing with SIMD fallback
 */
'use strict';

const os = require('os');
const blake3 = require('../../../blake3-optimized/index.js');

let hasherPromise = null;

async function getHasher() {
  if (hasherPromise) return hasherPromise;

  hasherPromise = (async () => {
    try {
      const { Blake3Parallel } = require('../../../blake3-optimized/blake3-parallel.js');
      const workerCount = Number(process.env.B3_WORKERS ?? Math.max(1, os.cpus().length - 1));
      console.log(`Initializing Blake3Parallel with ${workerCount} workers...`);
      const h = new Blake3Parallel(workerCount);
      await h.init();
      console.log('Parallel hasher initialized successfully');
      return h;
    } catch (err) {
      // Fallback to SIMD if parallel fails
      console.warn('Parallel init failed, falling back to SIMD:', err.message);
      if (blake3.initSimd) await blake3.initSimd();
      return null;
    }
  })();

  return hasherPromise;
}

async function hash(input) {
  const h = await getHasher();
  if (h) return h.hash(input, 32);
  return blake3.hash(input);
}

module.exports = { hash };
