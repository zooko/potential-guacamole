/**
 * BLAKE3 Parallel WASM wrapper for Node.js
 * Uses wasm-bindgen-rayon with worker_threads shim
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import worker shim FIRST - sets up globalThis.Worker
const shimPath = resolve(__dirname, '../../blake3-wasm-rayon/node-worker-shim.mjs');
await import(pathToFileURL(shimPath).href);

// Import the WASM package
const pkgPath = resolve(__dirname, '../../blake3-wasm-rayon/pkg/blake3_wasm_rayon.js');
const wasmPath = resolve(__dirname, '../../blake3-wasm-rayon/pkg/blake3_wasm_rayon_bg.wasm');

const mod = await import(pathToFileURL(pkgPath).href);

// Load and compile WASM
const wasmBytes = readFileSync(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);

// Initialize
await mod.default({ module_or_path: wasmModule });

// Initialize thread pool with physical cores (HT hurts compute-bound hashing)
const physicalCores = Math.max(1, Math.floor(os.cpus().length / 2));
await mod.initThreadPool(physicalCores);

// Warmup
const warmupData = new Uint8Array(1024);
for (let i = 0; i < 50; i++) mod.hash(warmupData);

// Export hash function
export function hash(inputU8) {
  return mod.hash(inputU8);
}
