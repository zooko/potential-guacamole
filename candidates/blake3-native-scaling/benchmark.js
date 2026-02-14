"use strict";

const { performance } = require("node:perf_hooks");
const crypto = require("node:crypto");
const { subtle } = crypto;
const path = require("node:path");

// Load native BLAKE3 from preexisting blake-hash
const blakeHashPath = path.resolve(__dirname, "../../preexisting/blake-hash");
const { blake3 } = require(blakeHashPath);

console.log("BLAKE3 (native) vs SHA-256 (sync & async) Scaling Benchmark");
console.log("============================================================\n");

const SIZES = [
  ["64 B",     64,        100000],
  ["256 B",    256,       50000],
  ["1 KB",     1024,      20000],
  ["4 KB",     4096,      10000],
  ["16 KB",    16384,     5000],
  ["64 KB",    65536,     2000],
  ["256 KB",   262144,    500],
  ["1 MB",     1048576,   100],
  ["4 MB",     4194304,   50],
  ["16 MB",    16777216,  20],
  ["64 MB",    67108864,  5],
  ["256 MB",   268435456, 2],
];

function formatMBps(mbps) {
  if (mbps >= 1000) {
    return `${(mbps / 1000).toFixed(2)}K`.padStart(8);
  }
  return mbps.toFixed(2).padStart(8);
}

function benchmarkBlake3(data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    blake3(data);
  }
  const elapsed = performance.now() - start;
  const throughput = (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
  return throughput;
}

function benchmarkSHA256Sync(data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    crypto.createHash("sha256").update(data).digest();
  }
  const elapsed = performance.now() - start;
  const throughput = (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
  return throughput;
}

async function benchmarkSHA256Async(data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await subtle.digest("SHA-256", data);
  }
  const elapsed = performance.now() - start;
  const throughput = (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
  return throughput;
}

(async () => {
  // Warmup
  console.log("Warming up...");
  const warmupData = new Uint8Array(1024);
  for (let i = 0; i < 1000; i++) {
    blake3(warmupData);
    crypto.createHash("sha256").update(warmupData).digest();
    await subtle.digest("SHA-256", warmupData);
  }
  console.log("Warmup complete.\n");

  // Results storage for crossover analysis
  const results = [];

  // Header
  console.log("┌──────────┬────────────────┬────────────────┬────────────────┬──────────┐");
  console.log("│   Size   │     BLAKE3     │ SHA-256 (sync) │ SHA-256 (async)│  Winner  │");
  console.log("├──────────┼────────────────┼────────────────┼────────────────┼──────────┤");

  for (const [name, size, iterations] of SIZES) {
    // Create test data
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;

    // Run benchmarks
    const blake3Mbps = benchmarkBlake3(data, iterations);
    const sha256SyncMbps = benchmarkSHA256Sync(data, iterations);
    const sha256AsyncMbps = await benchmarkSHA256Async(data, iterations);

    // Determine winner (compare BLAKE3 vs sync SHA-256 for fair comparison)
    const ratio = blake3Mbps / sha256SyncMbps;
    let winner;
    if (ratio > 1.1) {
      winner = "BLAKE3";
    } else if (ratio < 0.9) {
      winner = "SHA-256";
    } else {
      winner = "~tie~";
    }

    results.push({ name, size, blake3Mbps, sha256SyncMbps, sha256AsyncMbps, ratio, winner });

    // Print row
    const blake3Str = formatMBps(blake3Mbps);
    const sha256SyncStr = formatMBps(sha256SyncMbps);
    const sha256AsyncStr = formatMBps(sha256AsyncMbps);
    console.log(`│ ${name.padEnd(8)} │ ${blake3Str} MB/s │ ${sha256SyncStr} MB/s │ ${sha256AsyncStr} MB/s │ ${winner.padEnd(8)} │`);
  }

  console.log("└──────────┴────────────────┴────────────────┴────────────────┴──────────┘");

  // Find crossover point (comparing BLAKE3 vs sync SHA-256)
  console.log("\n─── Crossover Analysis (BLAKE3 vs SHA-256 sync) ──────────");

  let crossoverFound = false;
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const curr = results[i];

    // Check for BLAKE3 becoming faster than SHA-256
    if (prev.blake3Mbps <= prev.sha256SyncMbps && curr.blake3Mbps > curr.sha256SyncMbps) {
      console.log(`\nCrossover: BLAKE3 overtakes SHA-256 between ${prev.name} and ${curr.name}`);
      console.log(`  At ${prev.name}: BLAKE3 ${prev.blake3Mbps.toFixed(0)} vs SHA-256 ${prev.sha256SyncMbps.toFixed(0)} MB/s (ratio: ${prev.ratio.toFixed(2)}x)`);
      console.log(`  At ${curr.name}: BLAKE3 ${curr.blake3Mbps.toFixed(0)} vs SHA-256 ${curr.sha256SyncMbps.toFixed(0)} MB/s (ratio: ${curr.ratio.toFixed(2)}x)`);
      crossoverFound = true;
      break;
    }
  }

  if (!crossoverFound) {
    // Check if BLAKE3 is always faster or always slower
    const firstResult = results[0];
    if (firstResult.blake3Mbps > firstResult.sha256SyncMbps) {
      console.log("\nBLAKE3 is faster than SHA-256 (sync) at ALL tested sizes!");
    } else {
      console.log("\nSHA-256 (sync) is faster than BLAKE3 at ALL tested sizes.");
    }
  }

  // Summary stats
  console.log("\n─── Summary Statistics ───────────────────────────────────");

  const blake3Max = Math.max(...results.map(r => r.blake3Mbps));
  const sha256SyncMax = Math.max(...results.map(r => r.sha256SyncMbps));
  const sha256AsyncMax = Math.max(...results.map(r => r.sha256AsyncMbps));
  const blake3MaxSize = results.find(r => r.blake3Mbps === blake3Max).name;
  const sha256SyncMaxSize = results.find(r => r.sha256SyncMbps === sha256SyncMax).name;
  const sha256AsyncMaxSize = results.find(r => r.sha256AsyncMbps === sha256AsyncMax).name;

  console.log(`\nBLAKE3 peak:        ${blake3Max.toFixed(0)} MB/s at ${blake3MaxSize}`);
  console.log(`SHA-256 sync peak:  ${sha256SyncMax.toFixed(0)} MB/s at ${sha256SyncMaxSize}`);
  console.log(`SHA-256 async peak: ${sha256AsyncMax.toFixed(0)} MB/s at ${sha256AsyncMaxSize}`);
  console.log(`\nBLAKE3 / SHA-256 (sync) ratio at peak: ${(blake3Max / sha256SyncMax).toFixed(2)}x`);
  console.log(`Async overhead at peak: ${((sha256SyncMax - sha256AsyncMax) / sha256SyncMax * 100).toFixed(1)}% slower`);

  // Ratio breakdown
  console.log("\n─── Speed Ratio by Size (BLAKE3 / SHA-256 sync) ──────────");
  for (const r of results) {
    const bar = "█".repeat(Math.min(50, Math.round(r.ratio * 10)));
    const ratioStr = r.ratio.toFixed(2).padStart(5);
    console.log(`${r.name.padEnd(8)} ${ratioStr}x │${bar}`);
  }

  console.log("\n─── Done ─────────────────────────────────────────────────");
})().catch(e => {
  console.error("Error:", e);
  process.exitCode = 1;
});
