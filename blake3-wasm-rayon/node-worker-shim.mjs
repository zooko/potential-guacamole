/**
 * Node.js Worker Shim for wasm-bindgen-rayon
 *
 * Maps browser Worker API to node:worker_threads so that
 * --target web WASM modules using wasm-bindgen-rayon can run in Node.js.
 */

import { Worker as NodeWorker, isMainThread, parentPort } from "node:worker_threads";

if (!isMainThread) {
  // Worker context - nothing to do here
  // Bootstrap code sets up browser-like globals
} else {
  // Main thread: set up self with addEventListener so workerHelpers.js doesn't crash
  // The waitForMsgType listener will just never fire in main thread (harmless)
  globalThis.self = globalThis;
  const _mainListeners = [];
  globalThis.addEventListener = (type, cb) => {
    if (type === "message") _mainListeners.push(cb);
  };
  globalThis.removeEventListener = (type, cb) => {
    if (type === "message") {
      const idx = _mainListeners.indexOf(cb);
      if (idx >= 0) _mainListeners.splice(idx, 1);
    }
  };

  // Main thread: polyfill globalThis.Worker
  globalThis.Worker = class Worker {
    constructor(specifier, options = {}) {
      const href = specifier instanceof URL ? specifier.href : String(specifier);

      // Bootstrap script sets up browser-like worker globals then imports the actual script
      const bootstrap = `
        import { parentPort } from "node:worker_threads";

        // Make it look like a browser worker
        globalThis.self = globalThis;
        globalThis.WorkerGlobalScope = class WorkerGlobalScope {};
        globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
        globalThis.close = () => process.exit(0);

        const listeners = new Map();
        globalThis.addEventListener = (type, cb) => {
          if (type !== "message") return;
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(cb);
          parentPort.on("message", (data) => cb({ data }));
        };
        globalThis.removeEventListener = (type, cb) => {
          if (type !== "message") return;
          const cbs = listeners.get(type);
          if (cbs) {
            const idx = cbs.indexOf(cb);
            if (idx >= 0) cbs.splice(idx, 1);
          }
        };

        parentPort.on("message", (data) => {
          if (typeof globalThis.onmessage === "function") {
            globalThis.onmessage({ data });
          }
        });

        await import(${JSON.stringify(href)});
      `;

      this._w = new NodeWorker(bootstrap, { eval: true, type: "module" });
      this._w.on("message", (data) => this.onmessage?.({ data }));
      this._w.on("error", (err) => this.onerror?.(err));
      this._w.on("exit", (code) => {
        if (code !== 0) this.onerror?.(new Error("Worker exited with code " + code));
      });
      this._msgListeners = new Map();

      // Initialize callback properties
      this.onmessage = null;
      this.onerror = null;
    }

    postMessage(msg, transfer) {
      this._w.postMessage(msg, transfer);
    }

    terminate() {
      return this._w.terminate();
    }

    addEventListener(type, cb) {
      if (type !== "message") return;
      const fn = (data) => cb({ data });
      this._msgListeners.set(cb, fn);
      this._w.on("message", fn);
    }

    removeEventListener(type, cb) {
      if (type !== "message") return;
      const fn = this._msgListeners.get(cb);
      if (fn) {
        this._w.off("message", fn);
        this._msgListeners.delete(cb);
      }
    }
  };
}
