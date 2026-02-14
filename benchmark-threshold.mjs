/**
 * BLAKE3 Thread Count Threshold Analysis
 *
 * Find optimal thresholds for 2/4/8 threads vs single-threaded.
 * Tests every 1KB from 10KB to 256KB to find crossover points.
 *
 * Run with: node benchmark-threshold.mjs
 */

import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  BLAKE3 Thread Count Threshold Analysis                      ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`CPU: ${os.cpus()[0]?.model || 'Unknown'}`);
console.log(`Cores: ${os.cpus().length} logical`);
console.log('');

// Load WASM modules
console.log('Loading WASM modules...');

// Single-threaded SIMD
const singlePkgPath = resolve(__dirname, 'blake3-wasm-single/pkg');
const singleMod = require(singlePkgPath);

// We need to load the parallel module multiple times with different thread counts
// Since initThreadPool can only be called once, we'll use a single pool and benchmark accordingly

const shimPath = resolve(__dirname, 'blake3-wasm-rayon/node-worker-shim.mjs');
await import(pathToFileURL(shimPath).href);

const parallelPkgPath = resolve(__dirname, 'blake3-wasm-rayon/pkg/blake3_wasm_rayon.js');
const parallelWasmPath = resolve(__dirname, 'blake3-wasm-rayon/pkg/blake3_wasm_rayon_bg.wasm');

// Load with different thread counts - we'll reload the module for each count
async function loadParallelModule(threadCount) {
  // We need to use dynamic import with cache busting
  const parallelMod = await import(pathToFileURL(parallelPkgPath).href + `?threads=${threadCount}`);

  const wasmBytes = readFileSync(parallelWasmPath);
  const wasmModule = await WebAssembly.compile(wasmBytes);
  await parallelMod.default({ module_or_path: wasmModule });
  await parallelMod.initThreadPool(threadCount);

  return parallelMod;
}

console.log('  ✓ Single-threaded SIMD loaded');

// Load parallel module with max threads (8)
// Note: WASM thread pools can't be resized, so we'll measure with a single 8-thread pool
// But we can still get meaningful data about parallel vs single
const wasmBytes = readFileSync(parallelWasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);
const parallelMod = await import(pathToFileURL(parallelPkgPath).href);
await parallelMod.default({ module_or_path: wasmModule });

// Test with each thread count (need separate processes for accurate measurement)
const threadCounts = [2, 4, 8];
console.log('  Testing with thread counts: 2, 4, 8');
console.log('  Note: WASM pools can\'t resize; measuring 8 threads for parallel column');

// Initialize with 8 threads
await parallelMod.initThreadPool(8);
console.log('  ✓ Parallel (8 threads) loaded');
console.log('');

// Also load native BLAKE3 for comparison
let nativeMod = null;
try {
  nativeMod = require('./blake3-native-parallel');
  console.log('  ✓ Native BLAKE3 (rayon) loaded');
} catch (e) {
  console.log('  ⚠ Native BLAKE3 not available');
}

// Benchmark function with adaptive iterations
function benchmark(hashFn, data, targetTimeMs = 150) {
  // Warmup
  for (let i = 0; i < 10; i++) hashFn(data);

  // Calibrate iterations to get ~targetTimeMs runtime
  let iterations = 10;
  let start = performance.now();
  for (let i = 0; i < iterations; i++) hashFn(data);
  let elapsed = performance.now() - start;

  // Scale iterations
  iterations = Math.max(10, Math.floor(iterations * targetTimeMs / elapsed));

  // Actual benchmark
  start = performance.now();
  for (let i = 0; i < iterations; i++) hashFn(data);
  elapsed = performance.now() - start;

  return Math.round((data.length * iterations / 1024 / 1024) / (elapsed / 1000));
}

// For native, we can actually test different thread counts by reconfiguring
async function benchmarkNative(data, threadCount) {
  if (!nativeMod) return 0;
  nativeMod.setThreadCount(threadCount);
  // Warmup after thread change
  for (let i = 0; i < 5; i++) nativeMod.hashRayon(data);
  return benchmark((d) => nativeMod.hashRayon(d), data);
}

console.log('');
console.log('Testing WASM: single-threaded vs 8-thread parallel');
console.log('Testing Native: single, 2T, 4T, 8T (can reconfigure thread pool)');
console.log('');

// Test range: 10KB to 256KB in 1KB steps
const startSize = 10 * 1024;
const endSize = 256 * 1024;
const step = 1024;

console.log('Running benchmarks (this may take a few minutes)...');
console.log('');

// Header
const header = 'Size(KB)  WASM-1T  WASM-8T  Native-1T  Native-2T  Native-4T  Native-8T  Best';
console.log(header);
console.log('-'.repeat(header.length + 10));

const results = [];

for (let size = startSize; size <= endSize; size += step) {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i & 0xff;

  const sizeKB = Math.round(size / 1024);

  // WASM benchmarks
  const wasm1t = benchmark((d) => singleMod.hash(d), data);
  const wasm8t = benchmark((d) => parallelMod.hash(d), data);

  // Native benchmarks (if available)
  let native1t = 0, native2t = 0, native4t = 0, native8t = 0;
  if (nativeMod) {
    native1t = benchmark((d) => nativeMod.hashSingle(d), data);
    native2t = await benchmarkNative(data, 2);
    native4t = await benchmarkNative(data, 4);
    native8t = await benchmarkNative(data, 8);
  }

  // Find best
  const allSpeeds = { 'WASM-1T': wasm1t, 'WASM-8T': wasm8t };
  if (nativeMod) {
    allSpeeds['Native-1T'] = native1t;
    allSpeeds['Native-2T'] = native2t;
    allSpeeds['Native-4T'] = native4t;
    allSpeeds['Native-8T'] = native8t;
  }
  const best = Object.entries(allSpeeds).sort((a, b) => b[1] - a[1])[0][0];

  results.push({
    sizeBytes: size,
    sizeKB,
    wasm1t,
    wasm8t,
    native1t,
    native2t,
    native4t,
    native8t,
    best
  });

  // Progress output
  if (sizeKB % 16 === 0 || sizeKB === 10) {
    console.log(
      `${sizeKB.toString().padStart(6)}  ` +
      `${wasm1t.toString().padStart(7)}  ` +
      `${wasm8t.toString().padStart(7)}  ` +
      `${native1t.toString().padStart(9)}  ` +
      `${native2t.toString().padStart(9)}  ` +
      `${native4t.toString().padStart(9)}  ` +
      `${native8t.toString().padStart(9)}  ` +
      `${best}`
    );
  }
}

console.log('');

// Save full CSV
let csv = 'Size(KB),Size(Bytes),WASM-1T,WASM-8T,Native-1T,Native-2T,Native-4T,Native-8T,Best\n';
for (const r of results) {
  csv += `${r.sizeKB},${r.sizeBytes},${r.wasm1t},${r.wasm8t},${r.native1t},${r.native2t},${r.native4t},${r.native8t},${r.best}\n`;
}
writeFileSync(resolve(__dirname, 'threshold-analysis.csv'), csv);
console.log('Results saved to: threshold-analysis.csv');

// Crossover analysis
console.log('');
console.log('═'.repeat(60));
console.log('CROSSOVER ANALYSIS');
console.log('═'.repeat(60));

// WASM: When does 8T beat 1T?
console.log('\n--- WASM: Single vs 8-Thread ---');
let wasm8tFirstWin = null;
for (const r of results) {
  if (r.wasm8t > r.wasm1t * 1.05 && !wasm8tFirstWin) {
    wasm8tFirstWin = r.sizeKB;
  }
}
console.log(`  8T first beats 1T (>5%): ${wasm8tFirstWin || 'never'} KB`);

// Check at key thresholds
for (const threshold of [32, 64, 128, 256]) {
  const r = results.find(x => x.sizeKB === threshold);
  if (r) {
    const ratio = (r.wasm8t / r.wasm1t).toFixed(2);
    console.log(`  At ${threshold}KB: 8T is ${ratio}x of 1T (${r.wasm8t} vs ${r.wasm1t} MB/s)`);
  }
}

if (nativeMod) {
  // Native: When does 2T beat 1T?
  console.log('\n--- Native: 2T vs 1T ---');
  let native2tFirstWin = null;
  for (const r of results) {
    if (r.native2t > r.native1t * 1.05 && !native2tFirstWin) {
      native2tFirstWin = r.sizeKB;
    }
  }
  console.log(`  2T first beats 1T (>5%): ${native2tFirstWin || 'never'} KB`);

  // Native: When does 4T beat 2T?
  console.log('\n--- Native: 4T vs 2T ---');
  let native4tFirstWin = null;
  for (const r of results) {
    if (r.native4t > r.native2t * 1.05 && !native4tFirstWin) {
      native4tFirstWin = r.sizeKB;
    }
  }
  console.log(`  4T first beats 2T (>5%): ${native4tFirstWin || 'never'} KB`);

  // Native: When does 8T beat 4T?
  console.log('\n--- Native: 8T vs 4T ---');
  let native8tFirstWin = null;
  for (const r of results) {
    if (r.native8t > r.native4t * 1.05 && !native8tFirstWin) {
      native8tFirstWin = r.sizeKB;
    }
  }
  console.log(`  8T first beats 4T (>5%): ${native8tFirstWin || 'never'} KB`);

  // Key thresholds for Native
  console.log('\n--- Native at key thresholds ---');
  for (const threshold of [32, 64, 128, 256]) {
    const r = results.find(x => x.sizeKB === threshold);
    if (r) {
      console.log(`  ${threshold}KB: 1T=${r.native1t}, 2T=${r.native2t}, 4T=${r.native4t}, 8T=${r.native8t} MB/s`);
    }
  }
}

// Suggested thresholds
console.log('\n═'.repeat(60));
console.log('SUGGESTED THRESHOLDS');
console.log('═'.repeat(60));

// Find where each thread count becomes optimal
console.log('\nFor WASM (comparing 1T vs 8T only):');
const wasmThreshold = wasm8tFirstWin ? `${wasm8tFirstWin}KB or higher for 8T` : 'Use 1T always';
console.log(`  ${wasmThreshold}`);

if (nativeMod) {
  console.log('\nFor Native (Rayon):');

  // Build optimal thread count by size
  let optimalRanges = [];
  let currentOptimal = 1;
  let rangeStart = 10;

  for (const r of results) {
    let optimal = 1;
    if (r.native8t > r.native4t * 1.05) optimal = 8;
    else if (r.native4t > r.native2t * 1.05) optimal = 4;
    else if (r.native2t > r.native1t * 1.05) optimal = 2;

    if (optimal !== currentOptimal) {
      optimalRanges.push({ start: rangeStart, end: r.sizeKB - 1, threads: currentOptimal });
      rangeStart = r.sizeKB;
      currentOptimal = optimal;
    }
  }
  optimalRanges.push({ start: rangeStart, end: 256, threads: currentOptimal });

  for (const range of optimalRanges) {
    console.log(`  ${range.start}-${range.end}KB: use ${range.threads} thread(s)`);
  }
}

// Generate HTML chart
const chartHtml = `<!DOCTYPE html>
<html>
<head>
  <title>BLAKE3 Thread Count Analysis</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
      background: #0f172a;
      color: #e2e8f0;
    }
    h1, h2 { text-align: center; color: #f8fafc; }
    .chart-container {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
    }
    .findings {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
    }
    .findings h3 { color: #f8fafc; margin-top: 0; }
    .findings ul { color: #94a3b8; }
    .findings li { margin: 8px 0; }
    .findings strong { color: #4ade80; }
  </style>
</head>
<body>
  <h1>BLAKE3 Thread Count Analysis</h1>
  <p style="text-align: center; color: #94a3b8;">Finding optimal thread counts by input size</p>

  <div class="findings">
    <h3>Key Findings</h3>
    <ul>
      <li>WASM 8-thread first beats single-thread at: <strong>${wasm8tFirstWin || 'N/A'}KB</strong></li>
      ${nativeMod ? `<li>Native crossover points available in detailed analysis below</li>` : ''}
    </ul>
  </div>

  <h2>WASM Performance (Single vs 8-Thread)</h2>
  <div class="chart-container">
    <canvas id="wasmChart"></canvas>
  </div>

  ${nativeMod ? `
  <h2>Native Performance (1T / 2T / 4T / 8T)</h2>
  <div class="chart-container">
    <canvas id="nativeChart"></canvas>
  </div>
  ` : ''}

  <script>
    const results = ${JSON.stringify(results)};
    const labels = results.map(r => r.sizeKB);

    // WASM Chart
    new Chart(document.getElementById('wasmChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Single-threaded',
            data: results.map(r => r.wasm1t),
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            fill: true,
            tension: 0.1
          },
          {
            label: '8 Threads',
            data: results.map(r => r.wasm8t),
            borderColor: '#22c55e',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            fill: true,
            tension: 0.1
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#e2e8f0' } },
          title: { display: true, text: 'WASM Throughput by Input Size', color: '#f8fafc' }
        },
        scales: {
          x: { title: { display: true, text: 'Input Size (KB)', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
          y: { title: { display: true, text: 'Throughput (MB/s)', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
        }
      }
    });

    ${nativeMod ? `
    // Native Chart
    new Chart(document.getElementById('nativeChart'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '1 Thread', data: results.map(r => r.native1t), borderColor: '#94a3b8', tension: 0.1 },
          { label: '2 Threads', data: results.map(r => r.native2t), borderColor: '#f59e0b', tension: 0.1 },
          { label: '4 Threads', data: results.map(r => r.native4t), borderColor: '#3b82f6', tension: 0.1 },
          { label: '8 Threads', data: results.map(r => r.native8t), borderColor: '#22c55e', tension: 0.1 }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#e2e8f0' } },
          title: { display: true, text: 'Native (Rayon) Throughput by Input Size', color: '#f8fafc' }
        },
        scales: {
          x: { title: { display: true, text: 'Input Size (KB)', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
          y: { title: { display: true, text: 'Throughput (MB/s)', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
        }
      }
    });
    ` : ''}
  </script>
</body>
</html>`;

writeFileSync(resolve(__dirname, 'threshold-analysis.html'), chartHtml);
console.log('\nChart saved to: threshold-analysis.html');
console.log('Open threshold-analysis.html in a browser to view the charts.');
