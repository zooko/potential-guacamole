/**
 * Adaptive BLAKE3 - NUMA-friendly configuration
 *
 * - Uses single-threaded SIMD for inputs < 256KB
 * - Uses parallel WASM (4 threads max) for inputs >= 256KB
 * - Conservative settings to avoid NUMA overhead on multi-socket systems
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Threshold for switching from single to parallel
const PARALLEL_THRESHOLD = 262144; // 256KB - NUMA-friendly

// === Load single-threaded SIMD implementation ===
const singlePkgPath = resolve(__dirname, '../../blake3-wasm-single/pkg');
const singleMod = require(singlePkgPath);

// === Load parallel SIMD implementation ===
// Import worker shim FIRST
const shimPath = resolve(__dirname, '../../blake3-wasm-rayon/node-worker-shim.mjs');
await import(pathToFileURL(shimPath).href);

const parallelPkgPath = resolve(__dirname, '../../blake3-wasm-rayon/pkg/blake3_wasm_rayon.js');
const parallelWasmPath = resolve(__dirname, '../../blake3-wasm-rayon/pkg/blake3_wasm_rayon_bg.wasm');

const parallelMod = await import(pathToFileURL(parallelPkgPath).href);

// Initialize parallel WASM
const wasmBytes = readFileSync(parallelWasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);
await parallelMod.default({ module_or_path: wasmModule });

// Initialize thread pool with physical cores, capped at 4 for NUMA-friendly behavior
const physicalCores = Math.max(1, Math.floor(os.cpus().length / 2));
const threadCount = Math.min(physicalCores, 4);
await parallelMod.initThreadPool(threadCount);

// Warmup both implementations
const warmupData = new Uint8Array(1024);
for (let i = 0; i < 50; i++) {
  singleMod.hash(warmupData);
  parallelMod.hash(warmupData);
}

/**
 * Hash data using single-threaded SIMD (fastest for all practical sizes).
 *
 * @param {Uint8Array} inputU8 - Data to hash
 * @returns {Uint8Array} - 32-byte BLAKE3 hash
 */
export function hash(inputU8) {
  if (inputU8.length < PARALLEL_THRESHOLD) {
    return singleMod.hash(inputU8);
  } else {
    return parallelMod.hash(inputU8);
  }
}

// Export the threshold for transparency
export const THRESHOLD = PARALLEL_THRESHOLD;
