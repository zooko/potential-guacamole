/**
 * BLAKE3 Benchmark Suite
 */

const blake3 = require('./blake3.js');

console.log('BLAKE3 Optimized - Benchmark Suite');
console.log('===================================\n');

// Warmup
console.log('Warming up...');
for (let i = 0; i < 1000; i++) {
  blake3.hash(new Uint8Array(1024));
}

// Benchmark function
function benchmark(name, data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    blake3.hash(data);
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
  benchmark(name, data, iterations);
}

// Compare with reference if available
console.log('\n' + '─'.repeat(50));
console.log('Comparison Notes:');
console.log('- Fleek reports ~435 MB/s pure JS on Apple M1 Max');
console.log('- This is the same optimization level as Steps 1-8');
console.log('- WASM SIMD would add another ~1.4x speedup');
