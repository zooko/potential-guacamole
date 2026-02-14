/**
 * BLAKE3 WASM Rayon Benchmark for Node.js
 *
 * Uses worker shim to run browser-targeted wasm-bindgen-rayon in Node.js.
 */

// MUST import shim first - sets up globalThis.Worker
import "./node-worker-shim.mjs";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

// Dynamic import of --target web output
const pkgPath = join(here, "pkg", "blake3_wasm_rayon.js");
const mod = await import(pathToFileURL(pkgPath).href);

// Load and compile WASM as Module (not bytes)
const wasmPath = join(here, "pkg", "blake3_wasm_rayon_bg.wasm");
const wasmBytes = await readFile(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);

// Initialize with Module object (workers can instantiate from shared Module)
await mod.default({ module_or_path: wasmModule });

// Allow specifying thread count via CLI arg
// Default to physical cores (logical / 2) - hyperthreading hurts compute-bound hashing
const requestedThreads = parseInt(process.argv[2], 10);
const physicalCores = Math.max(1, Math.floor(os.cpus().length / 2));
const threads = requestedThreads > 0 ? requestedThreads : physicalCores;
console.log(`Initializing thread pool with ${threads} threads...`);
await mod.initThreadPool(threads);

// Warmup
console.log("Warming up...");
const warmupData = new Uint8Array(1024);
for (let i = 0; i < 50; i++) mod.hash(warmupData);

// Benchmark
const sizes = [
  ["64 bytes", 64, 100000],
  ["256 bytes", 256, 50000],
  ["1 KB", 1024, 20000],
  ["4 KB", 4096, 10000],
  ["16 KB", 16384, 5000],
  ["64 KB", 65536, 2000],
  ["256 KB", 262144, 500],
  ["1 MB", 1048576, 200],
];

console.log("\nBLAKE3 WASM Rayon (Node.js via Worker Shim) Benchmark");
console.log("=".repeat(55));

for (const [name, size, iterations] of sizes) {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i & 0xff;

  const start = performance.now();
  for (let i = 0; i < iterations; i++) mod.hash(data);
  const elapsed = performance.now() - start;

  const throughput = (size * iterations / 1024 / 1024) / (elapsed / 1000);
  console.log(`${name.padEnd(12)} ${throughput.toFixed(0).padStart(8)} MB/s  (${iterations} iters, ${elapsed.toFixed(0)}ms)`);
}

console.log("\nDone!");
process.exit(0);
