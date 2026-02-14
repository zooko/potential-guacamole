"use strict";

const { performance } = require("node:perf_hooks");
const blake3 = require("./blake3.js");

console.log("BLAKE3 - wasm-bindgen-rayon candidate");
console.log("====================================");

(async () => {
  console.log("Warming up...");
  for (let i = 0; i < 1000; i++) {
    await blake3.hash(new Uint8Array(1024));
  }

  async function benchmark(name, data, iterations) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await blake3.hash(data);
    }
    const elapsed = performance.now() - start;
    const throughput = (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
    console.log(`${name.padEnd(12)} ${throughput.toFixed(2).padStart(8)} MB/s`);
    return throughput;
  }

  console.log("\nThroughput Benchmark:");
  console.log("─".repeat(40));

  const sizes = [
    ["64 B", 64, 100000],
    ["256 B", 256, 50000],
    ["1 KB", 1024, 20000],
    ["4 KB", 4096, 10000],
    ["16 KB", 16384, 5000],
    ["64 KB", 65536, 1000],
    ["256 KB", 262144, 500],
    ["1 MB", 1048576, 100],
  ];

  for (const [name, size, iterations] of sizes) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;
    await benchmark(name, data, iterations);
  }

  console.log("\n" + "─".repeat(40));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
