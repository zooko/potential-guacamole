// Thanks to Claude (Opus 4.5) for writing this file.

// test_blake3.js
const fs = require('fs');
const blake3 = require('./blake3.ts');

// Load official test vectors
const testVectors = JSON.parse(fs.readFileSync('./test_vectors.json', 'utf8'));

// Generate input: repeating sequence 0, 1, 2, ..., 250, 0, 1, ...
function generateInput(length) {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    buf[i] = i % 251;
  }
  return buf;
}

// Convert Uint8Array to hex string
function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

let passed = 0;
let failed = 0;

for (const testCase of testVectors.cases) {
  const input = generateInput(testCase.input_len);

  // Test standard hash (first 32 bytes)
  const digest = blake3.hash(input);
  const expected = testCase.hash.slice(0, 64); // First 32 bytes = 64 hex chars
  const actual = toHex(digest);

  if (actual === expected) {
    passed++;
    console.log(`✓ input_len=${testCase.input_len}`);
  } else {
    failed++;
    console.log(`✗ input_len=${testCase.input_len}`);
    console.log(`  expected: ${expected}`);
    console.log(`  actual:   ${actual}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
