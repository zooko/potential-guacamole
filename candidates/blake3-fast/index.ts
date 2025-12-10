/**
 * BLAKE3 Cryptographic Hash Function
 *
 * A pure JavaScript implementation that gets faster as your environment allows.
 * We start with a reference version for correctness, then move up to an optimized
 * pure JS version with unrolled loops. If your runtime supports WebAssembly,
 * we switch to SIMD acceleration—either processing parallel chunks or, for
 * maximum speed, parallelizing the compression function itself.
 *
 * The API is a drop-in replacement for the official blake3 npm package.
 *
 * Usage:
 *   import { hash, createHash } from 'blake3-fast';
 *
 *   // Simple one-shot hashing
 *   const digest = hash(data);
 *   const hexDigest = hash(data, { outputLength: 32 }).toString('hex');
 *
 *   // Streaming mode for larger data
 *   const hasher = createHash();
 *   hasher.update(chunk1);
 *   hasher.update(chunk2);
 *   const digest = hasher.digest();
 *
 * Based on the official design: https://github.com/BLAKE3-team/BLAKE3
 */

import { hash as referenceHash } from "./reference.js";
import {
  hash as optimizedHash,
  compress as optimizedCompress,
} from "./optimized.js";
import { hash as simdHash, SIMD_SUPPORTED } from "./simd.js";
import { hash as fastSimdHash, FAST_SIMD_SUPPORTED } from "./simd-fast.js";
import {
  hash as fast4SimdHash,
  hashFast as ultraSimdHash,
  hashHyper as hyperSimdHash,
  FAST_4_SIMD_SUPPORTED,
} from "./simd-4-fast.js";
import {
  IV,
  BLOCK_LEN,
  CHUNK_LEN,
  OUT_LEN,
  KEY_LEN,
  CHUNK_START,
  CHUNK_END,
  ROOT,
  PARENT,
  KEYED_HASH,
  DERIVE_KEY_CONTEXT,
  DERIVE_KEY_MATERIAL,
} from "./constants.js";
import { ctz64 } from "./utils.js";

// Re-export constants
export {
  IV,
  BLOCK_LEN,
  CHUNK_LEN,
  OUT_LEN,
  KEY_LEN,
  SIMD_SUPPORTED,
  FAST_SIMD_SUPPORTED,
  FAST_4_SIMD_SUPPORTED,
};

// Export individual implementations for testing/benchmarking
export {
  referenceHash,
  optimizedHash,
  simdHash,
  fastSimdHash,
  fast4SimdHash,
  ultraSimdHash,
  hyperSimdHash,
};

/**
 * Input types accepted by hash functions
 */
export type HashInput = Uint8Array | string;

/**
 * Hash options
 */
export interface HashOptions {
  /** Output length in bytes (default: 32) */
  outputLength?: number;
}

/**
 * Hasher interface for streaming hash computation
 * Identical to the official blake3 package so you can swap implementations easily.
 */
export interface Hasher {
  /** Add data to the hash computation */
  update(input: HashInput): Hasher;
  /** Finalize and return the hash digest */
  digest(outputLength?: number): Uint8Array;
  /** Alias for digest() - for compatibility */
  finalize(outputLength?: number): Uint8Array;
  /** Reset hasher to initial state */
  reset(): Hasher;
  /** Copy the hasher state */
  copy(): Hasher;
}

/**
 * Internal hasher state
 */
interface HasherState {
  cv: Uint32Array;
  chunk: Uint8Array;
  chunkPos: number;
  chunkCounter: bigint;
  cvStack: Uint32Array[];
  flags: number;
  key?: Uint8Array;
}

/**
 * Convert input to Uint8Array
 */
function toBytes(input: HashInput): Uint8Array {
  if (typeof input === "string") {
    return new TextEncoder().encode(input);
  }
  return input;
}

/**
 * Create streaming hasher
 *
 * Use this when you have data coming in chunks or streams.
 * It follows the standard API pattern, so it should feel familiar.
 *
 * @param key - Optional 32-byte key if you need keyed hashing (MAC)
 */
export function createHash(key?: Uint8Array): Hasher {
  if (key !== undefined && key.length !== KEY_LEN) {
    throw new Error(`Key must be ${KEY_LEN} bytes`);
  }

  const state: HasherState = {
    cv: key ? keyToCV(key) : IV.slice(),
    chunk: new Uint8Array(CHUNK_LEN),
    chunkPos: 0,
    chunkCounter: 0n,
    cvStack: [],
    flags: key ? KEYED_HASH : 0,
    key: key ? key.slice() : undefined,
  };

  function update(input: HashInput): Hasher {
    const bytes = toBytes(input);
    let inputPos = 0;

    while (inputPos < bytes.length) {
      const remaining = CHUNK_LEN - state.chunkPos;
      const toCopy = Math.min(remaining, bytes.length - inputPos);
      state.chunk.set(
        bytes.subarray(inputPos, inputPos + toCopy),
        state.chunkPos
      );
      state.chunkPos += toCopy;
      inputPos += toCopy;

      if (state.chunkPos === CHUNK_LEN && inputPos < bytes.length) {
        const cv = processChunk(
          state.chunk,
          state.chunkCounter,
          state.flags,
          state.cv
        );
        pushCv(cv, state);
        state.chunkCounter++;
        state.chunkPos = 0;
      }
    }

    return hasher;
  }

  function digest(outputLength: number = OUT_LEN): Uint8Array {
    // Single chunk case
    if (state.chunkCounter === 0n && state.cvStack.length === 0) {
      return hashSingleChunk(
        state.chunk,
        state.chunkPos,
        state.flags,
        state.cv,
        outputLength
      );
    }

    // Multi-chunk case
    const finalChunkLen = state.chunkPos;
    const cv = processChunk(
      state.chunk.subarray(0, Math.max(finalChunkLen, 1)),
      state.chunkCounter,
      state.flags,
      state.cv,
      finalChunkLen
    );
    const tempStack = [...state.cvStack, cv];

    while (tempStack.length > 2) {
      const right = tempStack.pop()!;
      const left = tempStack.pop()!;
      tempStack.push(parentCv(left, right, state.flags, state.cv));
    }

    if (tempStack.length === 2) {
      const right = tempStack.pop()!;
      const left = tempStack.pop()!;
      return parentCvWithRoot(left, right, state.flags, outputLength, state.cv);
    }

    return wordsToOutput(tempStack[0], outputLength);
  }

  function reset(): Hasher {
    state.cv = state.key ? keyToCV(state.key) : IV.slice();
    state.chunkPos = 0;
    state.chunkCounter = 0n;
    state.cvStack = [];
    return hasher;
  }

  function copy(): Hasher {
    const newHasher = createHash(state.key);
    // Copy internal state
    const newState = (newHasher as any)._state as HasherState;
    if (newState) {
      newState.cv = state.cv.slice();
      newState.chunk = state.chunk.slice();
      newState.chunkPos = state.chunkPos;
      newState.chunkCounter = state.chunkCounter;
      newState.cvStack = state.cvStack.map((cv) => cv.slice());
    }
    return newHasher;
  }

  const hasher: Hasher = {
    update,
    digest,
    finalize: digest, // Alias
    reset,
    copy,
  };

  // Store state reference for copy()
  (hasher as any)._state = state;

  return hasher;
}

/**
 * Alias for createHash - matches official API
 */
export const createHasher = createHash;

/**
 * Convert 32-byte key to initial CV
 */
function keyToCV(key: Uint8Array): Uint32Array {
  const cv = new Uint32Array(8);
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < 8; i++) {
    cv[i] = view.getUint32(i * 4, true);
  }
  return cv;
}

/**
 * Process single chunk into CV
 */
function processChunk(
  chunk: Uint8Array,
  chunkCounter: bigint,
  flags: number,
  initialCv: Uint32Array,
  actualLen?: number
): Uint32Array {
  const cv = initialCv.slice();
  const chunkLen = actualLen !== undefined ? actualLen : chunk.length;
  const numBlocks = Math.max(Math.ceil(chunkLen / BLOCK_LEN), 1);

  for (let i = 0; i < numBlocks; i++) {
    const blockStart = i * BLOCK_LEN;
    const blockEnd = Math.min(blockStart + BLOCK_LEN, chunkLen);
    const blockLen = blockEnd > blockStart ? blockEnd - blockStart : 0;

    const block = new Uint8Array(BLOCK_LEN);
    if (blockLen > 0) {
      block.set(chunk.subarray(blockStart, blockEnd));
    }

    let blockFlags = flags;
    if (i === 0) blockFlags |= CHUNK_START;
    if (i === numBlocks - 1) blockFlags |= CHUNK_END;

    const state = optimizedCompress(
      cv,
      block,
      chunkCounter,
      blockLen,
      blockFlags
    );
    for (let j = 0; j < 8; j++) cv[j] = state[j];
  }

  return cv;
}

/**
 * Hash single chunk with ROOT flag
 */
function hashSingleChunk(
  chunkBuffer: Uint8Array,
  actualLen: number,
  flags: number,
  initialCv: Uint32Array,
  outputLength: number
): Uint8Array {
  const cv = initialCv.slice();
  const numBlocks = Math.max(Math.ceil(actualLen / BLOCK_LEN), 1);

  for (let i = 0; i < numBlocks; i++) {
    const blockStart = i * BLOCK_LEN;
    const blockEnd = Math.min(blockStart + BLOCK_LEN, actualLen);
    const blockLen = blockEnd > blockStart ? blockEnd - blockStart : 0;

    const block = new Uint8Array(BLOCK_LEN);
    if (blockLen > 0) {
      block.set(chunkBuffer.subarray(blockStart, blockEnd));
    }

    let blockFlags = flags;
    if (i === 0) blockFlags |= CHUNK_START;
    if (i === numBlocks - 1) blockFlags |= CHUNK_END | ROOT;

    const state = optimizedCompress(cv, block, 0n, blockLen, blockFlags);

    if (blockFlags & ROOT) {
      return wordsToOutput(state, outputLength);
    }

    for (let j = 0; j < 8; j++) cv[j] = state[j];
  }

  return new Uint8Array(outputLength);
}

/**
 * Push CV to stack with parent merging
 */
function pushCv(cv: Uint32Array, state: HasherState): void {
  state.cvStack.push(cv);

  let mergeCount = ctz64(state.chunkCounter + 1n);
  while (mergeCount > 0 && state.cvStack.length >= 2) {
    const right = state.cvStack.pop()!;
    const left = state.cvStack.pop()!;
    state.cvStack.push(parentCv(left, right, state.flags, state.cv));
    mergeCount--;
  }
}

/**
 * Compress two CVs into parent.
 *
 * For standard hashing, keyCv is IV. For keyed hashing, keyCv is the key.
 */
function parentCv(
  left: Uint32Array,
  right: Uint32Array,
  flags: number,
  keyCv: Uint32Array = IV
): Uint32Array {
  const block = new Uint8Array(BLOCK_LEN);
  const view = new DataView(block.buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint32(i * 4, left[i], true);
    view.setUint32(32 + i * 4, right[i], true);
  }

  const state = optimizedCompress(keyCv, block, 0n, BLOCK_LEN, flags | PARENT);
  return new Uint32Array([
    state[0],
    state[1],
    state[2],
    state[3],
    state[4],
    state[5],
    state[6],
    state[7],
  ]);
}

/**
 * Compress two CVs into root parent with ROOT flag.
 *
 * For standard hashing, keyCv is IV. For keyed hashing, keyCv is the key.
 */
function parentCvWithRoot(
  left: Uint32Array,
  right: Uint32Array,
  flags: number,
  outputLength: number,
  keyCv: Uint32Array = IV
): Uint8Array {
  const block = new Uint8Array(BLOCK_LEN);
  const view = new DataView(block.buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint32(i * 4, left[i], true);
    view.setUint32(32 + i * 4, right[i], true);
  }

  const state = optimizedCompress(
    keyCv,
    block,
    0n,
    BLOCK_LEN,
    flags | PARENT | ROOT
  );
  return wordsToOutput(state, outputLength);
}

/**
 * Convert state words to output bytes
 */
function wordsToOutput(state: Uint32Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    output[i] = (state[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
  }
  return output;
}

/**
 * Select the fastest implementation your environment supports.
 */
// Threshold: below this, Fast SIMD wins; above, Hyper wins
// Based on benchmarks: Fast SIMD ~500 MB/s, Hyper ~1.2 GB/s for large
const HYPER_THRESHOLD = 4 * CHUNK_LEN; // 4KB

function selectHashImpl(): (
  input: Uint8Array,
  outputLength?: number
) => Uint8Array {
  // Best combo: Fast SIMD for small inputs, Hyper for large
  if (FAST_4_SIMD_SUPPORTED && FAST_SIMD_SUPPORTED) {
    return (input, outputLength = OUT_LEN) => {
      if (input.length < HYPER_THRESHOLD) {
        return fastSimdHash(input, outputLength);
      }
      return hyperSimdHash(input, outputLength);
    };
  }
  // Chunk-level SIMD (~500 MB/s across all sizes)
  if (FAST_SIMD_SUPPORTED) {
    return fastSimdHash;
  }
  // The standard SIMD version only pays off for larger inputs (4+ chunks)
  // because of the overhead of moving data into WASM memory.
  if (SIMD_SUPPORTED) {
    return (input, outputLength = OUT_LEN) => {
      if (input.length >= CHUNK_LEN * 4) {
        return simdHash(input, outputLength);
      }
      return optimizedHash(input, outputLength);
    };
  }
  // Fallback to our best pure JS version.
  return optimizedHash;
}

const bestHash = selectHashImpl();

/**
 * BLAKE3 Hash Function
 *
 * This is the main entry point. It automatically picks the fastest
 * implementation available in your environment.
 *
 * @param input - Data to hash (Uint8Array or string)
 * @param options - Optional configuration (outputLength)
 * @returns The hash digest
 */
export function hash(
  input: HashInput,
  options?: HashOptions | number
): Uint8Array {
  const bytes = toBytes(input);
  const outputLength =
    typeof options === "number" ? options : (options?.outputLength ?? OUT_LEN);
  return bestHash(bytes, outputLength);
}

/**
 * Keyed BLAKE3 Hash (MAC)
 *
 * BLAKE3 in keyed hash mode with a 32-byte key.
 *
 * @param key - 32-byte secret key
 * @param input - Data to hash
 * @param options - Hash options
 */
export function keyedHash(
  key: Uint8Array,
  input: HashInput,
  options?: HashOptions | number
): Uint8Array {
  if (key.length !== KEY_LEN) {
    throw new Error(`Key must be ${KEY_LEN} bytes`);
  }

  const outputLength =
    typeof options === "number" ? options : (options?.outputLength ?? OUT_LEN);
  const hasher = createHash(key);
  hasher.update(input);
  return hasher.digest(outputLength);
}

/**
 * Derive key from context and key material
 *
 * BLAKE3 key derivation function (KDF).
 *
 * @param context - Context string (domain separator)
 * @param keyMaterial - Input key material
 * @param options - Hash options
 */
export function deriveKey(
  context: string,
  keyMaterial: HashInput,
  options?: HashOptions | number
): Uint8Array {
  const outputLength =
    typeof options === "number" ? options : (options?.outputLength ?? OUT_LEN);

  // First: hash the context string with DERIVE_KEY_CONTEXT flag
  const contextBytes = new TextEncoder().encode(context);
  const contextCv = deriveContextCv(contextBytes);

  // Second: hash key material with derived context CV and DERIVE_KEY_MATERIAL flag
  const hasher = createHashInternal(contextCv, DERIVE_KEY_MATERIAL);
  hasher.update(keyMaterial);
  return hasher.digest(outputLength);
}

/**
 * Derive context CV for key derivation.
 *
 * The context is treated as the first chunk with DERIVE_KEY_CONTEXT flag.
 * Unlike normal hashing, we need ROOT flag on the final block to extract
 * the full 32-byte derived key that becomes the IV for material hashing.
 */
function deriveContextCv(context: Uint8Array): Uint32Array {
  const cv = IV.slice();
  const numBlocks = Math.max(Math.ceil(context.length / BLOCK_LEN), 1);

  for (let i = 0; i < numBlocks; i++) {
    const blockStart = i * BLOCK_LEN;
    const blockEnd = Math.min(blockStart + BLOCK_LEN, context.length);
    const blockLen = blockEnd > blockStart ? blockEnd - blockStart : 0;

    const block = new Uint8Array(BLOCK_LEN);
    if (blockLen > 0) {
      block.set(context.subarray(blockStart, blockEnd));
    }

    let flags = DERIVE_KEY_CONTEXT;
    if (i === 0) flags |= CHUNK_START;
    if (i === numBlocks - 1) flags |= CHUNK_END | ROOT;

    const state = optimizedCompress(cv, block, 0n, blockLen, flags);
    for (let j = 0; j < 8; j++) cv[j] = state[j];
  }

  return cv;
}

/**
 * Internal hasher with custom CV and flags
 */
function createHashInternal(cv: Uint32Array, flags: number): Hasher {
  const state: HasherState = {
    cv: cv.slice(),
    chunk: new Uint8Array(CHUNK_LEN),
    chunkPos: 0,
    chunkCounter: 0n,
    cvStack: [],
    flags,
  };

  function update(input: HashInput): Hasher {
    const bytes = toBytes(input);
    let inputPos = 0;

    while (inputPos < bytes.length) {
      const remaining = CHUNK_LEN - state.chunkPos;
      const toCopy = Math.min(remaining, bytes.length - inputPos);
      state.chunk.set(
        bytes.subarray(inputPos, inputPos + toCopy),
        state.chunkPos
      );
      state.chunkPos += toCopy;
      inputPos += toCopy;

      if (state.chunkPos === CHUNK_LEN && inputPos < bytes.length) {
        const cv = processChunk(
          state.chunk,
          state.chunkCounter,
          state.flags,
          state.cv
        );
        pushCv(cv, state);
        state.chunkCounter++;
        state.chunkPos = 0;
      }
    }

    return hasher;
  }

  function digest(outputLength: number = OUT_LEN): Uint8Array {
    if (state.chunkCounter === 0n && state.cvStack.length === 0) {
      return hashSingleChunk(
        state.chunk,
        state.chunkPos,
        state.flags,
        state.cv,
        outputLength
      );
    }

    const finalChunkLen = state.chunkPos;
    const cv = processChunk(
      state.chunk.subarray(0, Math.max(finalChunkLen, 1)),
      state.chunkCounter,
      state.flags,
      state.cv,
      finalChunkLen
    );
    const tempStack = [...state.cvStack, cv];

    while (tempStack.length > 2) {
      const right = tempStack.pop()!;
      const left = tempStack.pop()!;
      tempStack.push(parentCv(left, right, state.flags, state.cv));
    }

    if (tempStack.length === 2) {
      const right = tempStack.pop()!;
      const left = tempStack.pop()!;
      return parentCvWithRoot(left, right, state.flags, outputLength, state.cv);
    }

    return wordsToOutput(tempStack[0], outputLength);
  }

  const hasher: Hasher = {
    update,
    digest,
    finalize: digest,
    reset: () => hasher,
    copy: () => hasher,
  };

  return hasher;
}

/**
 * Convert hash to hex string
 */
export function toHex(hash: Uint8Array): string {
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert hex string to Uint8Array
 */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Default export matching official API
export default {
  hash,
  keyedHash,
  deriveKey,
  createHash,
  createHasher,
  toHex,
  fromHex,
  OUT_LEN,
  KEY_LEN,
  BLOCK_LEN,
  CHUNK_LEN,
};
