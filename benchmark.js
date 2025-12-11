import { blake3 } from './index.js';
import fs from 'fs';

console.log('BLAKE3/SHA-256 - Benchmarks');
console.log('===========================');

// Warmup
console.log('Warming up...');
for (let i = 0; i < 1000; i++) {
  await blake3(new Uint8Array(1024));
}

// Benchmark function
async function benchmark(name, data, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await blake3(data);
  }
  const elapsed = performance.now() - start;
  const throughput = (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
  const opsPerSec = (iterations / elapsed) * 1000;

  console.log(`${name.padEnd(20)} ${throughput.toFixed(2).padStart(8)} MB/s`);
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
  ['10 MB', 1048576 * 10, 10],
  ['100 MB', 1048576 * 100, 1],
  ['1000 MB', 1048576 * 1000, 1],
];

for (const [name, size, iterations] of sizes) {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i & 0xff;
  await benchmark(name, data, iterations);
}

console.log('\n' + '─'.repeat(50));
