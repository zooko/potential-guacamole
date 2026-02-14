/**
 * BLAKE3 Benchmark Suite - Async Compatible Version
 * For blake3-optimized v1.3.0 SIMD mode
 */
'use strict';

const blake3 = require('./blake3.js');

console.log('BLAKE3 Optimized v1.3.0 (SIMD) - Benchmark Suite');
console.log('=================================================\n');

async function run() {
  // Warmup
  console.log('Warming up...');
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
    const opsPerSec = (iterations / elapsed) * 1000;

    console.log(`${name.padEnd(20)} ${throughput.toFixed(2).padStart(8)} MB/s  ${opsPerSec.toFixed(0).padStart(10)} ops/sec`);
    return throughput;
  }

  console.log('\nThroughput Benchmark:');
  console.log('─'.repeat(50));

  const sizes = [
    ['64 bytes', 64, 100000],
    ['256 bytes', 256, 50000],
    ['1 KB', 1024, 20000],
    ['4 KB', 4096, 10000],
    ['16 KB', 16384, 5000],
    ['64 KB', 65536, 1000],
    ['256 KB', 262144, 500],
    ['1 MB', 1048576, 100],
  ];

  for (const [name, size, iterations] of sizes) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;
    await benchmark(name, data, iterations);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('Mode: WASM SIMD (single-threaded)');
}

run().catch(console.error);
