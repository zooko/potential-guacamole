/**
 * Multi-Candidate BLAKE3 Benchmark Runner
 *
 * Produces output in Zooko's exact table format from README.md
 * Run with: node --experimental-strip-types compare-all.mjs
 */

import { createRequire } from 'module';
import { performance } from 'perf_hooks';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper to import ES modules from .js files
async function importModule(relativePath) {
  const fullPath = resolve(__dirname, relativePath);
  const fileUrl = pathToFileURL(fullPath).href;
  return import(fileUrl);
}

// Benchmark sizes from Zooko's table
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

// Implementation definitions
const implementations = [
  {
    name: 'wc sha256',
    category: 'preexisting',
    loader: async () => {
      const mod = await importModule('./preexisting/WebCryptoAPI/wca_sha256.js');
      return { hash: mod.hash, async: true };
    }
  },
  {
    name: 'Bk3JS',
    category: 'candidate',
    loader: async () => {
      const mod = await importModule('./candidates/Bk3JS/blake3.js');
      return { hash: mod.hash, async: true };
    }
  },
  {
    name: 'blake3-fa',
    category: 'candidate',
    loader: async () => {
      const mod = await importModule('./candidates/blake3-fast/index.ts');
      return { hash: mod.hash, async: false };
    }
  },
  {
    name: 'blake3-js',
    category: 'candidate',
    loader: async () => {
      const mod = await importModule('./candidates/blake3-js/blake3.ts');
      return { hash: mod.hash, async: false };
    }
  },
  {
    name: 'blake3-op',
    category: 'candidate',
    loader: async () => {
      const mod = await importModule('./candidates/blake3-optimized/blake3-wrapper.mjs');
      return { hash: mod.hash, async: false };
    }
  },
  {
    name: 'blake3-si',
    category: 'candidate',
    loader: async () => {
      const mod = await importModule('./candidates/blake3-single/blake3.js');
      return { hash: mod.hash, async: false };
    }
  },
  {
    name: 'b3-rayon',
    category: 'candidate',
    loader: async () => {
      const mod = await importModule('./candidates/blake3-rayon-node/blake3.js');
      return { hash: mod.hash, async: false };
    }
  },
  {
    name: 'b3-adapt',
    category: 'candidate',
    loader: async () => {
      const mod = await importModule('./candidates/blake3-adaptive/blake3.js');
      return { hash: mod.hash, async: false };
    }
  }
];

// Benchmark function
async function benchmark(hashFn, isAsync, data, iterations) {
  const start = performance.now();
  if (isAsync) {
    for (let i = 0; i < iterations; i++) {
      await hashFn(data);
    }
  } else {
    for (let i = 0; i < iterations; i++) {
      hashFn(data);
    }
  }
  const elapsed = performance.now() - start;
  const throughput = (data.length * iterations / 1024 / 1024) / (elapsed / 1000);
  return Math.round(throughput);
}

// Main
async function main() {
  console.log('BLAKE3/SHA-256 Multi-Candidate Benchmark');
  console.log('=========================================');
  console.log('');

  // Load all implementations
  console.log('Loading implementations...');
  const loaded = [];

  for (const impl of implementations) {
    try {
      const { hash, async: isAsync } = await impl.loader();
      // Test that it works
      const testResult = isAsync ? await hash(new Uint8Array(64)) : hash(new Uint8Array(64));
      if (testResult && testResult.length >= 32) {
        loaded.push({ name: impl.name, hash, isAsync, category: impl.category });
        console.log(`  ✓ ${impl.name}`);
      } else {
        console.log(`  ✗ ${impl.name} (invalid output)`);
      }
    } catch (err) {
      console.log(`  ✗ ${impl.name} (${err.message.split('\n')[0]})`);
    }
  }

  console.log('');
  console.log('Warming up...');

  // Warmup
  const warmupData = new Uint8Array(1024);
  for (const impl of loaded) {
    for (let i = 0; i < 1000; i++) {
      if (impl.isAsync) {
        await impl.hash(warmupData);
      } else {
        impl.hash(warmupData);
      }
    }
  }

  console.log('');
  console.log('Vals are throughput in MB/s. Higher is better.');
  console.log('');

  // Results storage
  const results = {};
  for (const impl of loaded) {
    results[impl.name] = {};
  }

  // Run benchmarks
  for (const [sizeName, size, iterations] of sizes) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = i & 0xff;

    for (const impl of loaded) {
      const throughput = await benchmark(impl.hash, impl.isAsync, data, iterations);
      results[impl.name][sizeName] = throughput;
    }
  }

  // Find winners for each size (fastest and within 10%)
  const winners = {};
  for (const [sizeName] of sizes) {
    const values = loaded
      .filter(impl => impl.name !== 'wc sha256') // SHA-256 doesn't compete with BLAKE3
      .map(impl => ({ name: impl.name, val: results[impl.name][sizeName] }));
    const maxVal = Math.max(...values.map(v => v.val));
    const threshold = maxVal * 0.9;
    winners[sizeName] = values.filter(v => v.val >= threshold).map(v => v.name);
  }

  // Print table header
  const preexisting = loaded.filter(i => i.category === 'preexisting');
  const candidates = loaded.filter(i => i.category === 'candidate');
  const allImpls = [...preexisting, ...candidates];

  // Column widths - use 10 chars per column
  const colWidth = 10;
  const sizeColWidth = 11;

  // Header row 1: categories
  let header1 = ''.padEnd(sizeColWidth);
  if (preexisting.length > 0) {
    const preWidth = preexisting.length * colWidth;
    header1 += 'pre-existing'.padStart(Math.floor(preWidth / 2) + 6).padEnd(preWidth);
  }
  if (candidates.length > 0) {
    header1 += 'candidates';
  }
  console.log(header1);

  // Header row 2: dashes
  let header2 = ''.padEnd(sizeColWidth);
  if (preexisting.length > 0) {
    header2 += '-'.repeat(preexisting.length * colWidth - 1) + ' ';
  }
  if (candidates.length > 0) {
    header2 += '-'.repeat(candidates.length * colWidth - 1);
  }
  console.log(header2);

  // Header row 3: names
  let header3 = 'input size '.padEnd(sizeColWidth);
  for (const impl of allImpls) {
    header3 += impl.name.padStart(colWidth);
  }
  console.log(header3);

  // Header row 4: dashes under names
  let header4 = '-'.repeat(sizeColWidth);
  for (let i = 0; i < allImpls.length; i++) {
    header4 += ' ' + '-'.repeat(colWidth - 1);
  }
  console.log(header4);

  // Data rows
  for (const [sizeName] of sizes) {
    let row = sizeName.padEnd(sizeColWidth);
    for (const impl of allImpls) {
      const val = results[impl.name][sizeName];
      const isWinner = winners[sizeName]?.includes(impl.name);
      const valStr = val.toString() + (isWinner ? ' *' : '');
      row += valStr.padStart(colWidth);
    }
    console.log(row);
  }

  console.log('');
  console.log("`*` marks the fastest one, as well as any others within 10% of the fastest one");
  console.log('');
  console.log('Notes:');
  console.log('- blake3-si is single-threaded WASM with SIMD');
  console.log('- b3-rayon is parallel WASM with SIMD (8 worker_threads)');
  console.log('- b3-adapt picks best: single-threaded <64KB, parallel >=64KB');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
