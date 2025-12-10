/**
 * BLAKE3 Reference Implementation
 *
 * This is the readable version. It's a direct port of the official Rust
 * reference code, so it's great for understanding the algorithm, even if
 * it's not the fastest implementation we have.
 *
 * How it works:
 * 1. compress(): The core function that crunches a 64B block + 32B CV into a new CV.
 * 2. chainingValue(): Processes a 1KB chunk (16 blocks).
 * 3. hash(): Builds the Merkle tree over the chunks, merging parents as it goes.
 *
 * Based on: https://github.com/BLAKE3-team/BLAKE3/blob/master/reference_impl/reference_impl.rs
 */

import {
  IV,
  BLOCK_LEN,
  CHUNK_LEN,
  OUT_LEN,
  MSG_PERMUTATION,
  CHUNK_START,
  CHUNK_END,
  ROOT,
  PARENT,
} from "./constants.js";
import { rotr32, ctz64, wordsToBytes } from "./utils.js";

/**
 * G function: Quarter-round mixing
 *
 * This mixes 4 state words with 2 message words. It uses addition, XOR,
 * and rotation to spread information around.
 *
 * The rotation constants (16, 12, 8, 7) were chosen for speed on modern CPUs.
 */
function g(
  state: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  mx: number,
  my: number
): void {
  // First half: mix mx with rotation 16, 12
  state[a] = (state[a] + state[b] + mx) >>> 0;
  state[d] = rotr32(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr32(state[b] ^ state[c], 12);

  // Second half: mix my with rotation 8, 7
  state[a] = (state[a] + state[b] + my) >>> 0;
  state[d] = rotr32(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0;
  state[b] = rotr32(state[b] ^ state[c], 7);
}

/**
 * Single round of compression.
 *
 * Each round applies the G function to all columns, then all diagonals.
 * This ensures every part of the state affects every other part eventually.
 */
function round(state: Uint32Array, m: Uint32Array): void {
  // Column mixing - each G operates on one column of 4x4 state matrix
  g(state, 0, 4, 8, 12, m[0], m[1]);
  g(state, 1, 5, 9, 13, m[2], m[3]);
  g(state, 2, 6, 10, 14, m[4], m[5]);
  g(state, 3, 7, 11, 15, m[6], m[7]);

  // Diagonal mixing - each G operates on one diagonal
  g(state, 0, 5, 10, 15, m[8], m[9]);
  g(state, 1, 6, 11, 12, m[10], m[11]);
  g(state, 2, 7, 8, 13, m[12], m[13]);
  g(state, 3, 4, 9, 14, m[14], m[15]);
}

/**
 * Permute message words for next round
 *
 * Each round uses a different permutation of message words.
 * This ensures each word influences different state positions.
 */
function permute(m: Uint32Array): void {
  const original = m.slice();
  for (let i = 0; i < 16; i++) {
    m[i] = original[MSG_PERMUTATION[i]];
  }
}

/**
 * Compression function
 *
 * Core BLAKE3 primitive. Compresses 64-byte block with 32-byte chaining value
 * into new state. Uses 7 rounds (vs BLAKE2's 10-12).
 *
 * State initialization (16 words):
 * - [0-7]: Chaining value (CV) from previous block or IV
 * - [8-11]: First 4 IV constants
 * - [12]: Counter low bits (block position in chunk)
 * - [13]: Counter high bits
 * - [14]: Block length (always 64 for full blocks)
 * - [15]: Domain separation flags
 *
 * @param cv - 8-word chaining value
 * @param block - 64-byte input block
 * @param counter - 64-bit block counter
 * @param blockLen - Bytes in block (64 for full, less for final)
 * @param flags - Domain flags (CHUNK_START, CHUNK_END, ROOT, PARENT)
 * @returns 16-word state after compression
 */
function compress(
  cv: Uint32Array,
  block: Uint8Array,
  counter: bigint,
  blockLen: number,
  flags: number
): Uint32Array {
  // Parse block into 16 little-endian 32-bit words
  const m = new Uint32Array(16);
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  for (let i = 0; i < 16; i++) {
    m[i] = view.getUint32(i * 4, true); // true = little-endian
  }

  // Initialize 16-word state
  const state = new Uint32Array([
    cv[0],
    cv[1],
    cv[2],
    cv[3], // Chaining value
    cv[4],
    cv[5],
    cv[6],
    cv[7],
    IV[0],
    IV[1],
    IV[2],
    IV[3], // IV constants
    Number(counter & 0xffffffffn), // Counter low
    Number((counter >> 32n) & 0xffffffffn), // Counter high
    blockLen, // Block length
    flags, // Domain flags
  ]);

  // 7 rounds of mixing with message permutation between rounds
  round(state, m);
  permute(m);
  round(state, m);
  permute(m);
  round(state, m);
  permute(m);
  round(state, m);
  permute(m);
  round(state, m);
  permute(m);
  round(state, m);
  permute(m);
  round(state, m); // No permute after last round

  // XOR state halves for feed-forward (Davies-Meyer construction)
  for (let i = 0; i < 8; i++) {
    state[i] ^= state[i + 8];
  }

  return state;
}

/**
 * Extract chaining value from compression output
 * First 8 words of state after XOR feed-forward
 */
function extractChainingValue(state: Uint32Array): Uint32Array {
  return state.slice(0, 8);
}

/**
 * Process single chunk (1024 bytes) into chaining value
 *
 * A chunk contains 16 blocks of 64 bytes each.
 * First block uses IV as CV, subsequent blocks chain.
 *
 * @param chunk - Up to 1024 bytes of input
 * @param chunkCounter - Which chunk this is (0-indexed)
 * @param flags - Additional flags (0 for regular chunks)
 * @returns 8-word chaining value
 */
function chainingValue(
  chunk: Uint8Array,
  chunkCounter: bigint,
  flags: number
): Uint32Array {
  let cv: Uint32Array = new Uint32Array(IV); // Start with IV
  let pos = 0;
  const numBlocks = Math.ceil(chunk.length / BLOCK_LEN);

  for (let i = 0; i < numBlocks; i++) {
    // Determine block boundaries
    const blockStart = pos;
    const blockEnd = Math.min(pos + BLOCK_LEN, chunk.length);
    const blockLen = blockEnd - blockStart;

    // Pad partial block with zeros
    const block = new Uint8Array(BLOCK_LEN);
    block.set(chunk.subarray(blockStart, blockEnd));

    // Build flags for this block
    let blockFlags = flags;
    if (i === 0) blockFlags |= CHUNK_START;
    if (i === numBlocks - 1) blockFlags |= CHUNK_END;

    // Compress and extract new chaining value
    const state = compress(cv, block, chunkCounter, blockLen, blockFlags);
    cv = extractChainingValue(state);

    pos += BLOCK_LEN;
  }

  return cv;
}

/**
 * Compress two child chaining values into parent
 *
 * Parent node in Merkle tree: concatenate two 32-byte CVs,
 * compress with PARENT flag and counter=0.
 */
function parentCv(
  leftCv: Uint32Array,
  rightCv: Uint32Array,
  flags: number
): Uint32Array {
  // Concatenate CVs into 64-byte block
  const block = new Uint8Array(BLOCK_LEN);
  for (let i = 0; i < 8; i++) {
    const offset = i * 4;
    block[offset] = leftCv[i] & 0xff;
    block[offset + 1] = (leftCv[i] >>> 8) & 0xff;
    block[offset + 2] = (leftCv[i] >>> 16) & 0xff;
    block[offset + 3] = (leftCv[i] >>> 24) & 0xff;
  }
  for (let i = 0; i < 8; i++) {
    const offset = 32 + i * 4;
    block[offset] = rightCv[i] & 0xff;
    block[offset + 1] = (rightCv[i] >>> 8) & 0xff;
    block[offset + 2] = (rightCv[i] >>> 16) & 0xff;
    block[offset + 3] = (rightCv[i] >>> 24) & 0xff;
  }

  const state = compress(IV, block, 0n, BLOCK_LEN, flags | PARENT);
  return extractChainingValue(state);
}

/**
 * Compress two child CVs into root parent (with ROOT flag)
 * Returns full 16-word state for extendable output
 */
function parentCvWithRoot(
  leftCv: Uint32Array,
  rightCv: Uint32Array
): Uint32Array {
  const block = new Uint8Array(BLOCK_LEN);
  for (let i = 0; i < 8; i++) {
    const offset = i * 4;
    block[offset] = leftCv[i] & 0xff;
    block[offset + 1] = (leftCv[i] >>> 8) & 0xff;
    block[offset + 2] = (leftCv[i] >>> 16) & 0xff;
    block[offset + 3] = (leftCv[i] >>> 24) & 0xff;
  }
  for (let i = 0; i < 8; i++) {
    const offset = 32 + i * 4;
    block[offset] = rightCv[i] & 0xff;
    block[offset + 1] = (rightCv[i] >>> 8) & 0xff;
    block[offset + 2] = (rightCv[i] >>> 16) & 0xff;
    block[offset + 3] = (rightCv[i] >>> 24) & 0xff;
  }

  return compress(IV, block, 0n, BLOCK_LEN, PARENT | ROOT);
}

/**
 * BLAKE3 Hash Function (Reference Implementation)
 *
 * Builds Merkle tree over 1KB chunks using stack-based parent merging.
 *
 * Algorithm:
 * 1. Split input into 1KB chunks
 * 2. For each chunk, compute chaining value
 * 3. Push CV to stack, then merge parents based on trailing zeros
 * 4. After all chunks, merge remaining stack items
 * 5. Root node compressed with ROOT flag for final output
 *
 * Stack merge rule: After processing chunk N, merge top entries
 * where count = trailing zeros in binary(N+1). This builds a
 * left-leaning balanced binary tree incrementally.
 *
 * @param input - Arbitrary length input
 * @param outputLength - Desired output length (default 32)
 * @returns Hash output
 */
export function hash(
  input: Uint8Array,
  outputLength: number = OUT_LEN
): Uint8Array {
  // Handle empty input
  if (input.length === 0) {
    const block = new Uint8Array(BLOCK_LEN);
    const state = compress(IV, block, 0n, 0, CHUNK_START | CHUNK_END | ROOT);
    return wordsToBytes(state, outputLength);
  }

  // Single chunk: process directly with ROOT flag on last block
  if (input.length <= CHUNK_LEN) {
    let cv: Uint32Array = new Uint32Array(IV);
    let pos = 0;
    const numBlocks = Math.ceil(input.length / BLOCK_LEN) || 1;

    for (let i = 0; i < numBlocks; i++) {
      const blockStart = pos;
      const blockEnd = Math.min(pos + BLOCK_LEN, input.length);
      const blockLen = blockEnd - blockStart;

      const block = new Uint8Array(BLOCK_LEN);
      if (blockLen > 0) {
        block.set(input.subarray(blockStart, blockEnd));
      }

      let flags = 0;
      if (i === 0) flags |= CHUNK_START;
      if (i === numBlocks - 1) flags |= CHUNK_END | ROOT;

      const state = compress(cv, block, 0n, blockLen || 0, flags);

      if (i === numBlocks - 1) {
        // Final block with ROOT flag - return full output
        return wordsToBytes(state, outputLength);
      }

      cv = extractChainingValue(state);
      pos += BLOCK_LEN;
    }
  }

  // Multi-chunk: build Merkle tree using stack-based parent merging
  const cvStack: Uint32Array[] = [];
  let chunkCounter = 0n;
  let pos = 0;
  const totalChunks = Math.ceil(input.length / CHUNK_LEN);

  // Process all complete chunks
  while (pos + CHUNK_LEN <= input.length) {
    const chunk = input.subarray(pos, pos + CHUNK_LEN);
    const cv = chainingValue(chunk, chunkCounter, 0);
    cvStack.push(cv);

    // Merge parents based on trailing zeros in (chunkCounter + 1)
    // Keep at least 2 items on stack so final merge can use ROOT flag
    chunkCounter++;
    let mergeCount = ctz64(chunkCounter);
    while (mergeCount > 0 && cvStack.length > 1) {
      // For the last chunk, don't merge - leave for final ROOT merge
      if (chunkCounter === BigInt(totalChunks) && cvStack.length === 2) {
        break;
      }
      const right = cvStack.pop()!;
      const left = cvStack.pop()!;
      cvStack.push(parentCv(left, right, 0));
      mergeCount--;
    }

    pos += CHUNK_LEN;
  }

  // Process final partial chunk (if any)
  if (pos < input.length) {
    const chunk = input.subarray(pos);
    const cv = chainingValue(chunk, chunkCounter, 0);
    cvStack.push(cv);
  }

  // Merge remaining stack items from right to left
  // All merges except the final one use PARENT flag only
  while (cvStack.length > 2) {
    const right = cvStack.pop()!;
    const left = cvStack.pop()!;
    cvStack.push(parentCv(left, right, 0));
  }

  // Final merge with ROOT flag
  if (cvStack.length === 2) {
    const right = cvStack.pop()!;
    const left = cvStack.pop()!;
    const state = parentCvWithRoot(left, right);
    return wordsToBytes(state, outputLength);
  }

  // Shouldn't reach here for multi-chunk input
  throw new Error("Unexpected state in multi-chunk hash");
}
