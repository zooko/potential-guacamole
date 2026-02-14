"use strict";

const { performance } = require("node:perf_hooks");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Load native BLAKE3
const blakeHashPath = path.resolve(__dirname, "../../preexisting/blake-hash");
const { blake3: blake3Native } = require(blakeHashPath);

// Load WASM single-threaded BLAKE3
const wasmPkgPath = path.resolve(__dirname, "../../blake3-wasm-single/pkg");
const { hash: blake3Wasm } = require(wasmPkgPath);

console.log("BLAKE3 Comprehensive Scaling Benchmark");
console.log("======================================");
console.log("Comparing: BLAKE3 Native (Rayon) | BLAKE3 WASM (single) | SHA-256 (sync)\n");

// Extended sizes with more granularity
const SIZES = [
  ["64 B",     64,          100000],
  ["256 B",    256,         50000],
  ["1 KB",     1024,        20000],
  ["4 KB",     4096,        10000],
  ["16 KB",    16384,       5000],
  ["64 KB",    65536,       2000],
  ["256 KB",   262144,      500],
  ["1 MB",     1048576,     100],
  ["2 MB",     2097152,     30],
  ["4 MB",     4194304,     50],
  ["8 MB",     8388608,     10],
  ["16 MB",    16777216,    20],
  ["32 MB",    33554432,    3],
  ["64 MB",    67108864,    5],
  ["128 MB",   134217728,   2],
  ["256 MB",   268435456,   2],
];

// Doubling test sizes (1KB to 256MB, powers of 2)
const DOUBLING_SIZES = [];
for (let size = 1024; size <= 268435456; size *= 2) {
  let name;
  if (size < 1024) name = `${size} B`;
  else if (size < 1048576) name = `${size / 1024} KB`;
  else if (size < 1073741824) name = `${size / 1048576} MB`;
  else name = `${size / 1073741824} GB`;

  // Iterations decrease with size
  let iterations;
  if (size <= 1024) iterations = 20000;
  else if (size <= 16384) iterations = 5000;
  else if (size <= 262144) iterations = 500;
  else if (size <= 1048576) iterations = 100;
  else if (size <= 4194304) iterations = 50;
  else if (size <= 16777216) iterations = 20;
  else if (size <= 67108864) iterations = 5;
  else iterations = 2;

  DOUBLING_SIZES.push([name, size, iterations]);
}

function formatMBps(mbps) {
  if (mbps >= 1000) {
    return `${(mbps / 1000).toFixed(2)}K`.padStart(8);
  }
  return mbps.toFixed(2).padStart(8);
}

function formatMBpsPlain(mbps) {
  return mbps.toFixed(2);
}

function benchmarkBlake3Native(data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    blake3Native(data);
  }
  const elapsed = performance.now() - start;
  return (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
}

function benchmarkBlake3Wasm(data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    blake3Wasm(data);
  }
  const elapsed = performance.now() - start;
  return (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
}

function benchmarkSHA256Sync(data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    crypto.createHash("sha256").update(data).digest();
  }
  const elapsed = performance.now() - start;
  return (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
}

// Main benchmark
(async () => {
  // Warmup
  console.log("Warming up all implementations...");
  const warmupData = new Uint8Array(1024);
  for (let i = 0; i < 1000; i++) {
    blake3Native(warmupData);
    blake3Wasm(warmupData);
    crypto.createHash("sha256").update(warmupData).digest();
  }
  console.log("Warmup complete.\n");

  // ============================================
  // PART 1: Full benchmark table
  // ============================================
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("PART 1: Full Throughput Comparison");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  const results = [];

  console.log("┌──────────┬────────────────┬────────────────┬────────────────┬──────────┐");
  console.log("│   Size   │ BLAKE3 Native  │  BLAKE3 WASM   │  SHA-256 sync  │  Winner  │");
  console.log("├──────────┼────────────────┼────────────────┼────────────────┼──────────┤");

  for (const [name, size, iterations] of SIZES) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;

    const blake3NativeMbps = benchmarkBlake3Native(data, iterations);
    const blake3WasmMbps = benchmarkBlake3Wasm(data, iterations);
    const sha256Mbps = benchmarkSHA256Sync(data, iterations);

    const ratio = blake3NativeMbps / sha256Mbps;
    let winner = ratio > 1.1 ? "BLAKE3" : ratio < 0.9 ? "SHA-256" : "~tie~";

    // Calculate projected WASM parallel performance (browser with SharedArrayBuffer)
    const NUM_CORES = 8; // i9-9900K
    const EFFICIENCY = 0.75; // 75% parallel efficiency
    const CHUNK_SIZE = 1024; // BLAKE3 1KB chunks
    const PARALLEL_THRESHOLD = 16384; // 16KB minimum for parallelism benefit

    let blake3WasmProjected;
    if (size < PARALLEL_THRESHOLD) {
      // No parallel benefit for small inputs
      blake3WasmProjected = blake3WasmMbps;
    } else {
      // Calculate parallel scaling
      const inputChunks = size / CHUNK_SIZE;
      const effectiveCores = Math.min(NUM_CORES, inputChunks / 4);
      const maxScaling = NUM_CORES * EFFICIENCY; // 8 * 0.75 = 6x max
      const scaling = Math.min(effectiveCores * EFFICIENCY, maxScaling);
      blake3WasmProjected = blake3WasmMbps * scaling;
    }

    results.push({
      name,
      size,
      blake3Native: blake3NativeMbps,
      blake3Wasm: blake3WasmMbps,
      blake3WasmProjected: blake3WasmProjected,
      sha256: sha256Mbps,
      ratio
    });

    console.log(`│ ${name.padEnd(8)} │ ${formatMBps(blake3NativeMbps)} MB/s │ ${formatMBps(blake3WasmMbps)} MB/s │ ${formatMBps(sha256Mbps)} MB/s │ ${winner.padEnd(8)} │`);
  }

  console.log("└──────────┴────────────────┴────────────────┴────────────────┴──────────┘");

  // ============================================
  // PART 2: Doubling Test
  // ============================================
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("PART 2: Doubling Test (Does 2x input = 2x throughput?)");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  console.log("When BLAKE3 parallelism kicks in, doubling input should maintain throughput.");
  console.log("Constant throughput means processing time doubles with input (ideal scaling).\n");

  const doublingResults = [];

  console.log("┌──────────┬────────────────┬────────────────┬──────────────────┬──────────────────┐");
  console.log("│   Size   │ BLAKE3 Native  │  SHA-256 sync  │ BLAKE3 Δ vs prev │ SHA-256 Δ vs prev│");
  console.log("├──────────┼────────────────┼────────────────┼──────────────────┼──────────────────┤");

  let prevBlake3 = null;
  let prevSha256 = null;

  for (const [name, size, iterations] of DOUBLING_SIZES) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;

    const blake3Mbps = benchmarkBlake3Native(data, iterations);
    const sha256Mbps = benchmarkSHA256Sync(data, iterations);

    let blake3Delta = "  (baseline)  ";
    let sha256Delta = "  (baseline)  ";

    if (prevBlake3 !== null) {
      const blake3Change = ((blake3Mbps / prevBlake3) - 1) * 100;
      const sha256Change = ((sha256Mbps / prevSha256) - 1) * 100;
      blake3Delta = `${blake3Change >= 0 ? "+" : ""}${blake3Change.toFixed(1)}%`.padStart(14);
      sha256Delta = `${sha256Change >= 0 ? "+" : ""}${sha256Change.toFixed(1)}%`.padStart(14);
    }

    doublingResults.push({ name, size, blake3Mbps, sha256Mbps });

    console.log(`│ ${name.padEnd(8)} │ ${formatMBps(blake3Mbps)} MB/s │ ${formatMBps(sha256Mbps)} MB/s │ ${blake3Delta}   │ ${sha256Delta}   │`);

    prevBlake3 = blake3Mbps;
    prevSha256 = sha256Mbps;
  }

  console.log("└──────────┴────────────────┴────────────────┴──────────────────┴──────────────────┘");

  console.log("\nInterpretation:");
  console.log("  • Small % changes = constant throughput (ideal - processing scales linearly)");
  console.log("  • Large negative % = throughput dropping (memory bandwidth limited)");
  console.log("  • BLAKE3 maintains high throughput much longer than SHA-256");

  // ============================================
  // PART 3: Summary Statistics
  // ============================================
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("PART 3: Summary Statistics");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  const blake3NativeMax = Math.max(...results.map(r => r.blake3Native));
  const blake3WasmMax = Math.max(...results.map(r => r.blake3Wasm));
  const sha256Max = Math.max(...results.map(r => r.sha256));

  console.log(`Peak Throughput:`);
  console.log(`  BLAKE3 Native (Rayon): ${blake3NativeMax.toFixed(0)} MB/s (${(blake3NativeMax/1000).toFixed(2)} GB/s)`);
  console.log(`  BLAKE3 WASM (single):  ${blake3WasmMax.toFixed(0)} MB/s`);
  console.log(`  SHA-256 (sync):        ${sha256Max.toFixed(0)} MB/s`);

  console.log(`\nSpeedup Ratios:`);
  console.log(`  BLAKE3 Native vs SHA-256: ${(blake3NativeMax / sha256Max).toFixed(2)}x faster`);
  console.log(`  BLAKE3 Native vs WASM:    ${(blake3NativeMax / blake3WasmMax).toFixed(2)}x faster (Rayon parallelism)`);
  console.log(`  BLAKE3 WASM vs SHA-256:   ${(blake3WasmMax / sha256Max).toFixed(2)}x faster`);

  // ============================================
  // PART 4: Generate Chart Data and HTML
  // ============================================
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("PART 4: Generating Chart");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  const chartData = {
    labels: results.map(r => r.name),
    sizes: results.map(r => r.size),
    blake3Native: results.map(r => r.blake3Native),
    blake3Wasm: results.map(r => r.blake3Wasm),
    blake3WasmProjected: results.map(r => r.blake3WasmProjected),
    sha256: results.map(r => r.sha256),
    generated: new Date().toISOString()
  };

  // Save JSON data
  const jsonPath = path.join(__dirname, "benchmark-data.json");
  fs.writeFileSync(jsonPath, JSON.stringify(chartData, null, 2));
  console.log(`Saved benchmark data to: ${jsonPath}`);

  // Generate HTML chart
  const htmlContent = generateChartHTML(chartData);
  const htmlPath = path.join(__dirname, "chart.html");
  fs.writeFileSync(htmlPath, htmlContent);
  console.log(`Saved interactive chart to: ${htmlPath}`);

  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("Benchmark Complete!");
  console.log("═══════════════════════════════════════════════════════════════════════════════");

})().catch(e => {
  console.error("Error:", e);
  process.exitCode = 1;
});


function generateChartHTML(data) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BLAKE3 vs SHA-256: Throughput Scaling</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background: #1a1a2e;
      color: #eee;
    }
    h1 {
      text-align: center;
      color: #00d4ff;
      margin-bottom: 10px;
    }
    .subtitle {
      text-align: center;
      color: #888;
      margin-bottom: 30px;
    }
    .chart-container {
      background: #16213e;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 30px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: #16213e;
      border-radius: 12px;
      padding: 20px;
    }
    .stat-card h3 {
      margin: 0 0 15px 0;
      color: #00d4ff;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .stat-value {
      font-size: 32px;
      font-weight: bold;
      margin-bottom: 5px;
    }
    .stat-label {
      color: #888;
      font-size: 14px;
    }
    .blake3-native { color: #00d4ff; }
    .blake3-wasm { color: #ff9f43; }
    .sha256 { color: #26de81; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #16213e;
      border-radius: 12px;
      overflow: hidden;
    }
    th, td {
      padding: 12px 16px;
      text-align: right;
    }
    th {
      background: #0f3460;
      color: #00d4ff;
      font-weight: 600;
    }
    td:first-child, th:first-child {
      text-align: left;
    }
    tr:nth-child(even) {
      background: rgba(255,255,255,0.03);
    }
    .legend {
      display: flex;
      justify-content: center;
      gap: 30px;
      margin-bottom: 20px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .legend-color {
      width: 20px;
      height: 4px;
      border-radius: 2px;
    }
    .footer {
      text-align: center;
      color: #666;
      margin-top: 30px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <h1>BLAKE3 vs SHA-256: Throughput Scaling by Input Size</h1>
  <p class="subtitle">Benchmark comparing native BLAKE3 (with Rayon parallelism), WASM BLAKE3, and SHA-256</p>
  <p class="note" style="text-align: center; color: #ff9f43; font-size: 13px; margin-bottom: 20px;">
    ⚠️ Projected parallel line estimates wasm-bindgen-rayon performance in browser with SharedArrayBuffer + 8 Web Workers at 75% scaling efficiency
  </p>

  <div class="stats-grid">
    <div class="stat-card">
      <h3>BLAKE3 Native Peak</h3>
      <div class="stat-value blake3-native">${Math.max(...data.blake3Native).toFixed(0)} MB/s</div>
      <div class="stat-label">${(Math.max(...data.blake3Native)/1000).toFixed(2)} GB/s with Rayon parallelism</div>
    </div>
    <div class="stat-card">
      <h3>BLAKE3 WASM Peak</h3>
      <div class="stat-value blake3-wasm">${Math.max(...data.blake3Wasm).toFixed(0)} MB/s</div>
      <div class="stat-label">Single-threaded WebAssembly</div>
    </div>
    <div class="stat-card">
      <h3>WASM Parallel (Projected)</h3>
      <div class="stat-value" style="color: #e056fd;">${Math.max(...data.blake3WasmProjected).toFixed(0)} MB/s</div>
      <div class="stat-label">Browser 8 workers @ 75% efficiency</div>
    </div>
    <div class="stat-card">
      <h3>SHA-256 Peak</h3>
      <div class="stat-value sha256">${Math.max(...data.sha256).toFixed(0)} MB/s</div>
      <div class="stat-label">Node.js crypto (OpenSSL)</div>
    </div>
    <div class="stat-card">
      <h3>Native vs SHA-256</h3>
      <div class="stat-value" style="color: #fff;">${(Math.max(...data.blake3Native) / Math.max(...data.sha256)).toFixed(1)}x</div>
      <div class="stat-label">BLAKE3 native advantage</div>
    </div>
    <div class="stat-card">
      <h3>Projected vs SHA-256</h3>
      <div class="stat-value" style="color: #e056fd;">${(Math.max(...data.blake3WasmProjected) / Math.max(...data.sha256)).toFixed(1)}x</div>
      <div class="stat-label">Browser WASM parallel advantage</div>
    </div>
  </div>

  <div class="chart-container">
    <canvas id="throughputChart"></canvas>
  </div>

  <h2 style="color: #00d4ff; margin-top: 40px;">Raw Data</h2>
  <table>
    <thead>
      <tr>
        <th>Input Size</th>
        <th>BLAKE3 Native</th>
        <th>WASM Parallel*</th>
        <th>BLAKE3 WASM</th>
        <th>SHA-256</th>
        <th>Native vs SHA</th>
      </tr>
    </thead>
    <tbody>
      ${data.labels.map((label, i) => `
      <tr>
        <td>${label}</td>
        <td class="blake3-native">${data.blake3Native[i].toFixed(0)}</td>
        <td style="color: #e056fd;">${data.blake3WasmProjected[i].toFixed(0)}</td>
        <td class="blake3-wasm">${data.blake3Wasm[i].toFixed(0)}</td>
        <td class="sha256">${data.sha256[i].toFixed(0)}</td>
        <td>${(data.blake3Native[i] / data.sha256[i]).toFixed(1)}x</td>
      </tr>`).join('')}
    </tbody>
  </table>
  <p style="color: #888; font-size: 12px; margin-top: 10px;">* Projected: 8 Web Workers with SharedArrayBuffer at 75% parallel efficiency</p>

  <p class="footer">Generated: ${data.generated}</p>

  <script>
    const ctx = document.getElementById('throughputChart').getContext('2d');

    const data = ${JSON.stringify(data)};

    new Chart(ctx, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [
          {
            label: 'BLAKE3 Native (Rayon)',
            data: data.blake3Native,
            borderColor: '#00d4ff',
            backgroundColor: 'rgba(0, 212, 255, 0.1)',
            borderWidth: 3,
            pointRadius: 5,
            pointHoverRadius: 8,
            tension: 0.3,
            fill: false
          },
          {
            label: 'BLAKE3 WASM parallel (projected browser)',
            data: data.blake3WasmProjected,
            borderColor: '#e056fd',
            backgroundColor: 'rgba(224, 86, 253, 0.1)',
            borderWidth: 3,
            borderDash: [10, 5],
            pointRadius: 4,
            pointHoverRadius: 7,
            pointStyle: 'triangle',
            tension: 0.3,
            fill: false
          },
          {
            label: 'BLAKE3 WASM (single-thread)',
            data: data.blake3Wasm,
            borderColor: '#ff9f43',
            backgroundColor: 'rgba(255, 159, 67, 0.1)',
            borderWidth: 3,
            pointRadius: 5,
            pointHoverRadius: 8,
            tension: 0.3,
            fill: false
          },
          {
            label: 'SHA-256 (sync)',
            data: data.sha256,
            borderColor: '#26de81',
            backgroundColor: 'rgba(38, 222, 129, 0.1)',
            borderWidth: 3,
            pointRadius: 5,
            pointHoverRadius: 8,
            tension: 0.3,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 2,
        interaction: {
          intersect: false,
          mode: 'index'
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: '#eee',
              font: { size: 14 },
              padding: 20
            }
          },
          tooltip: {
            backgroundColor: 'rgba(0,0,0,0.8)',
            titleFont: { size: 14 },
            bodyFont: { size: 13 },
            padding: 12,
            callbacks: {
              label: function(context) {
                return context.dataset.label + ': ' + context.parsed.y.toFixed(2) + ' MB/s';
              }
            }
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Input Size',
              color: '#888',
              font: { size: 14 }
            },
            ticks: { color: '#888' },
            grid: { color: 'rgba(255,255,255,0.1)' }
          },
          y: {
            type: 'logarithmic',
            title: {
              display: true,
              text: 'Throughput (MB/s) - Log Scale',
              color: '#888',
              font: { size: 14 }
            },
            ticks: {
              color: '#888',
              callback: function(value) {
                if (value >= 1000) return (value/1000).toFixed(1) + 'K';
                return value;
              }
            },
            grid: { color: 'rgba(255,255,255,0.1)' }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}
