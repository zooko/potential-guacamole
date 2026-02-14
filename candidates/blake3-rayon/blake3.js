"use strict";

const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Set up browser globals BEFORE any imports
// wasm-bindgen-rayon expects these to exist
if (!globalThis.self) {
  globalThis.self = globalThis;
}

if (!globalThis.Worker) {
  // Use web-worker which has better support for WASM workers
  const Worker = require("web-worker");
  globalThis.Worker = Worker;
}

// Polyfill URL for Workers if needed
if (!globalThis.URL) {
  globalThis.URL = URL;
}

let initPromise = null;
let wasmHash = null;

async function ensureInit() {
  if (wasmHash) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const pkgDir = path.resolve(__dirname, "../../blake3-wasm-rayon/pkg");
    const jsEntry = path.join(pkgDir, "blake3_wasm_rayon.js");
    const wasmBin = path.join(pkgDir, "blake3_wasm_rayon_bg.wasm");

    const wasmUrl = pathToFileURL(jsEntry).href;
    const wasmPkg = await import(wasmUrl);

    const wasmBytes = await fs.readFile(wasmBin);
    await wasmPkg.default(wasmBytes);

    const cpuCount = os.cpus().length;
    const threads = Number(process.env.B3_THREADS ?? Math.min(cpuCount, 8));

    console.log(`Initializing thread pool with ${threads} threads...`);
    await wasmPkg.initThreadPool(threads);
    console.log("Thread pool initialized.");

    wasmHash = wasmPkg.hash;
  })();

  return initPromise;
}

async function hash(inputU8) {
  await ensureInit();
  return wasmHash(inputU8);
}

module.exports = { hash };
