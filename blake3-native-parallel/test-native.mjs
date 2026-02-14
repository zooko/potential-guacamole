import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import os from 'os';

const require = createRequire(import.meta.url);
const { hash } = require('./index.js');

console.log('Native BLAKE3 with Rayon (update_rayon)');
console.log('='.repeat(50));
console.log(`Platform: ${process.platform} ${process.arch}`);
console.log(`CPUs: ${os.cpus().length} logical cores`);
console.log('');

// 1MB benchmark
const size = 1048576;
const iterations = 200;
const data = Buffer.alloc(size);
for (let i = 0; i < size; i++) data[i] = i & 0xff;

// Warmup
for (let i = 0; i < 50; i++) hash(data);

// Benchmark
const start = performance.now();
for (let i = 0; i < iterations; i++) hash(data);
const elapsed = performance.now() - start;

const throughput = (size * iterations / 1024 / 1024) / (elapsed / 1000);
console.log(`1 MB: ${throughput.toFixed(0)} MB/s (${iterations} iters, ${elapsed.toFixed(0)}ms)`);
