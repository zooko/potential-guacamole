/**
 * BLAKE3 SIMD Implementation via Runtime WASM Generation
 *
 * This version generates WebAssembly bytecode right in the browser (or Node)
 * to access SIMD instructions. `compress4x` handles 4 chunks at a time using
 * 128-bit vectors.
 *
 * It's a cool trick: we don't ship a .wasm file. Instead, we build the bytecode
 * array programmatically. This keeps the bundle small and lets us use a single
 * 64KB memory page for everything.
 *
 * It's about twice as fast as the baseline WASM implementation.
 *
 * See the case study: https://web.archive.org/web/20250320125147/https://blog.fleek.network/post/fleek-network-blake3-case-study/
 */

import {
  IV,
  BLOCK_LEN,
  CHUNK_LEN,
  OUT_LEN,
  MSG_SCHEDULE,
  CHUNK_START,
  CHUNK_END,
  ROOT,
  PARENT,
} from "./constants.js";
import { ctz64 } from "./utils.js";
import { compress as jsCompress } from "./optimized.js";

// WASM SIMD feature detection
export const SIMD_SUPPORTED = (() => {
  if (typeof WebAssembly === "undefined") return false;
  try {
    // Minimal WASM module testing v128.const instruction
    return WebAssembly.validate(
      new Uint8Array([
        0x00,
        0x61,
        0x73,
        0x6d, // Magic: \0asm
        0x01,
        0x00,
        0x00,
        0x00, // Version: 1
        0x01,
        0x05,
        0x01,
        0x60,
        0x00,
        0x01,
        0x7b, // Type: () -> v128
        0x03,
        0x02,
        0x01,
        0x00, // Func: index 0
        0x0a,
        0x16,
        0x01,
        0x14,
        0x00, // Code section
        0xfd,
        0x0c, // v128.const
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x0b, // end
      ])
    );
  } catch {
    return false;
  }
})();

/**
 * WASM Memory Layout (we fit everything into one 64KB page):
 *
 * 0x0000-0x0FFF: Input buffer for 4 chunks (4096 bytes)
 * 0x1000-0x101F: Chaining value input (duplicated for 4 lanes)
 * 0x1020-0x103F: Output buffer (where the results land)
 * 0x1100-0x110F: Metadata: counter, block length, flags
 *
 * Each 128-bit vector holds 4 parallel values—one for each chunk we're processing.
 */

// WASM bytecode builder
class WasmBuilder {
  private bytes: number[] = [];

  put(...data: number[]): void {
    this.bytes.push(...data);
  }

  // LEB128 encoding for unsigned integers
  putULEB128(value: number): void {
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      this.bytes.push(byte);
    } while (value !== 0);
  }

  // Section with size prefix
  section(id: number, content: number[]): void {
    this.bytes.push(id);
    this.putULEB128(content.length);
    this.bytes.push(...content);
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/**
 * Generate compress4x WASM module
 *
 * Function signature: (i32, i32, i32, i32) -> void
 * Args: counter_lo, counter_hi, block_len, flags
 *
 * Memory layout accessed:
 * - 0x0000: 4 input blocks (64 bytes each, interleaved for SIMD)
 * - 0x0100: Chaining value (32 bytes)
 * - 0x0120: Output (32 bytes)
 */
function generateCompress4xModule(): Uint8Array {
  const code: number[] = [];

  // Track message word access order across all rounds
  // Each G call consumes 2 message words
  const M_ACCESS_ORDER: number[] = [];
  for (let round = 0; round < 7; round++) {
    const schedule = MSG_SCHEDULE[round];
    // Column mixing: G(0,4,8,12), G(1,5,9,13), G(2,6,10,14), G(3,7,11,15)
    // Diagonal mixing: G(0,5,10,15), G(1,6,11,12), G(2,7,8,13), G(3,4,9,14)
    // Each G uses schedule[2*g] and schedule[2*g+1]
    for (let g = 0; g < 8; g++) {
      M_ACCESS_ORDER.push(schedule[g * 2], schedule[g * 2 + 1]);
    }
  }

  let mIndex = 0;

  /**
   * Local variable mapping (v128 type):
   * $0-$15:  Block words (loaded from memory)
   * $16-$31: State words (s0-s15)
   * $32-$39: Reserved for output/temp
   * $40-$43: Function parameters (i32)
   */

  // Emit gi() - inner G function half
  // Performs: a += b + m; d ^= a; d >>>= rot_d; c += d; b ^= c; b >>>= rot_b
  function gi(
    a: number,
    b: number,
    c: number,
    d: number,
    rotD: number,
    rotB: number
  ): void {
    const m = M_ACCESS_ORDER[mIndex++];

    // s[a] = (s[a] + s[b] + m) (i32x4.add twice)
    code.push(0x20, a); // local.get $a
    code.push(0x20, m); // local.get $m (block word)
    code.push(0xfd, 0xae, 0x01); // i32x4.add
    code.push(0x20, b); // local.get $b
    code.push(0xfd, 0xae, 0x01); // i32x4.add
    code.push(0x22, a); // local.tee $a

    // s[d] ^= s[a]; s[d] = rotr(s[d], rotD)
    code.push(0x20, d); // local.get $d
    code.push(0xfd, 0x51); // v128.xor
    code.push(0x22, d); // local.tee $d
    code.push(0x41, rotD); // i32.const rotD
    code.push(0xfd, 0xad, 0x01); // i32x4.shr_u
    code.push(0x20, d); // local.get $d
    code.push(0x41, 32 - rotD); // i32.const (32-rotD)
    code.push(0xfd, 0xab, 0x01); // i32x4.shl
    code.push(0xfd, 0x50); // v128.or
    code.push(0x22, d); // local.tee $d

    // s[c] = s[c] + s[d]
    code.push(0x20, c); // local.get $c
    code.push(0xfd, 0xae, 0x01); // i32x4.add
    code.push(0x22, c); // local.tee $c

    // s[b] ^= s[c]; s[b] = rotr(s[b], rotB)
    code.push(0x20, b); // local.get $b
    code.push(0xfd, 0x51); // v128.xor
    code.push(0x22, b); // local.tee $b
    code.push(0x41, rotB); // i32.const rotB
    code.push(0xfd, 0xad, 0x01); // i32x4.shr_u
    code.push(0x20, b); // local.get $b
    code.push(0x41, 32 - rotB); // i32.const (32-rotB)
    code.push(0xfd, 0xab, 0x01); // i32x4.shl
    code.push(0xfd, 0x50); // v128.or
  }

  /**
   * Run the G function quarter-round.
   * This handles the mixing step. We use `local.tee` to save a few bytes
   * and cycles by using the value on the stack instead of get/set.
   */
  function g(a: number, b: number, c: number, d: number): void {
    gi(a, b, c, d, 16, 12); // First half: rotations 16, 12
    code.push(0x22, b); // local.tee $b (optimization: avoid set+get)
    gi(a, b, c, d, 8, 7); // Second half: rotations 8, 7
    code.push(0x21, b); // local.set $b
  }

  // State indices offset by 16 (block words are 0-15)
  const S = (i: number) => 16 + i;

  // ===== Function body =====

  // Load 16 block words from memory (v128.load at offset i*16)
  // Memory layout: words interleaved for SIMD access
  for (let i = 0; i < 16; i++) {
    code.push(0x41, 0x00); // i32.const 0 (base address)
    code.push(0xfd, 0x00); // v128.load
    code.push(i * 16); // offset (0, 16, 32, ...)
    code.push(0x00); // align
    code.push(0x21, i); // local.set $i
  }

  // Load chaining value and initialize state
  // State layout: cv[0-7], IV[0-3], counter_lo, counter_hi, blockLen, flags

  // s[0-7] = cv[0-7] (loaded from memory offset 0x100)
  for (let i = 0; i < 8; i++) {
    code.push(0x41, 0x00); // i32.const 0
    code.push(0xfd, 0x00); // v128.load
    code.push(0x80, 0x02 + i * 16); // offset 256 + i*16 (0x100-0x17F)
    code.push(0x00); // align
    code.push(0x21, S(i)); // local.set $s[i]
  }

  // s[8-11] = IV[0-3] (v128.const with splat)
  for (let i = 0; i < 4; i++) {
    const iv = IV[i];
    code.push(0xfd, 0x0c); // v128.const
    // Splat IV value across 4 lanes
    for (let lane = 0; lane < 4; lane++) {
      code.push(
        iv & 0xff,
        (iv >> 8) & 0xff,
        (iv >> 16) & 0xff,
        (iv >> 24) & 0xff
      );
    }
    code.push(0x21, S(8 + i)); // local.set $s[8+i]
  }

  // s[12] = counter_lo (splat from parameter)
  code.push(0x20, 40); // local.get $counter_lo (param 0)
  code.push(0xfd, 0x11); // i32x4.splat
  code.push(0x21, S(12)); // local.set $s12

  // s[13] = counter_hi (splat from parameter)
  code.push(0x20, 41); // local.get $counter_hi (param 1)
  code.push(0xfd, 0x11); // i32x4.splat
  code.push(0x21, S(13)); // local.set $s13

  // s[14] = blockLen (splat from parameter)
  code.push(0x20, 42); // local.get $blockLen (param 2)
  code.push(0xfd, 0x11); // i32x4.splat
  code.push(0x21, S(14)); // local.set $s14

  // s[15] = flags (splat from parameter)
  code.push(0x20, 43); // local.get $flags (param 3)
  code.push(0xfd, 0x11); // i32x4.splat
  code.push(0x21, S(15)); // local.set $s15

  // ===== 7 Rounds of compression =====
  for (let round = 0; round < 7; round++) {
    // Column mixing: G on columns of 4x4 matrix
    g(S(0), S(4), S(8), S(12)); // Column 0
    g(S(1), S(5), S(9), S(13)); // Column 1
    g(S(2), S(6), S(10), S(14)); // Column 2
    g(S(3), S(7), S(11), S(15)); // Column 3

    // Diagonal mixing: G on diagonals
    g(S(0), S(5), S(10), S(15)); // Diagonal 0
    g(S(1), S(6), S(11), S(12)); // Diagonal 1
    g(S(2), S(7), S(8), S(13)); // Diagonal 2
    g(S(3), S(4), S(9), S(14)); // Diagonal 3
  }

  // ===== Feed-forward XOR =====
  // Output[i] = s[i] ^ s[i+8] for i in 0..7
  // Then store to memory at offset 0x200
  for (let i = 0; i < 8; i++) {
    code.push(0x41, 0x00); // i32.const 0 (base)
    code.push(0x20, S(i)); // local.get $s[i]
    code.push(0x20, S(i + 8)); // local.get $s[i+8]
    code.push(0xfd, 0x51); // v128.xor
    code.push(0xfd, 0x0b); // v128.store
    code.push(0x80, 0x04 + i * 16); // offset 512 + i*16 (0x200-0x27F)
    code.push(0x00); // align
  }

  code.push(0x0b); // end

  // Build WASM module
  const builder = new WasmBuilder();

  // Magic + version
  builder.put(0x00, 0x61, 0x73, 0x6d); // \0asm
  builder.put(0x01, 0x00, 0x00, 0x00); // version 1

  // Type section: (i32, i32, i32, i32) -> ()
  builder.section(0x01, [
    0x01, // 1 type
    0x60, // func type
    0x04,
    0x7f,
    0x7f,
    0x7f,
    0x7f, // 4 params: i32 × 4
    0x00, // 0 results
  ]);

  // Function section
  builder.section(0x03, [0x01, 0x00]); // 1 function, type 0

  // Memory section: 1 page (64KB)
  builder.section(0x05, [0x01, 0x00, 0x01]); // 1 memory, min=1 page

  // Export section
  const exportName = [0x08, ...Array.from("compress", (c) => c.charCodeAt(0))];
  const memName = [0x03, ...Array.from("mem", (c) => c.charCodeAt(0))];
  builder.section(0x07, [
    0x02, // 2 exports
    ...exportName,
    0x00,
    0x00, // "compress" -> func 0
    ...memName,
    0x02,
    0x00, // "mem" -> memory 0
  ]);

  // Code section
  const locals = [
    0x01, // 1 local group
    0x28,
    0x7b, // 40 locals of type v128
  ];
  const bodyLen = locals.length + code.length;
  const codeSectionContent = [0x01]; // 1 function

  // Function body size (LEB128)
  let size = bodyLen;
  do {
    let byte = size & 0x7f;
    size >>>= 7;
    if (size !== 0) byte |= 0x80;
    codeSectionContent.push(byte);
  } while (size !== 0);

  codeSectionContent.push(...locals, ...code);
  builder.section(0x0a, codeSectionContent);

  return builder.build();
}

// Lazy WASM module compilation
let wasmInstance: WebAssembly.Instance | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
let compress4xFn:
  | ((c0: number, c1: number, len: number, flags: number) => void)
  | null = null;

function initWasm(): boolean {
  if (wasmInstance) return true;
  if (!SIMD_SUPPORTED) return false;

  try {
    const wasmBytes = generateCompress4xModule();
    // Create a new ArrayBuffer to satisfy TypeScript's BufferSource requirement
    const buffer = new ArrayBuffer(wasmBytes.length);
    new Uint8Array(buffer).set(wasmBytes);
    const module = new WebAssembly.Module(buffer);
    wasmInstance = new WebAssembly.Instance(module);
    wasmMemory = wasmInstance.exports.mem as WebAssembly.Memory;
    compress4xFn = wasmInstance.exports.compress as (
      c0: number,
      c1: number,
      len: number,
      flags: number
    ) => void;
    return true;
  } catch {
    return false;
  }
}

/**
 * Process 4 chunks in parallel using SIMD.
 *
 * This is where the magic happens: we load 4 chunks into memory,
 * run the WASM function, and get 4 chaining values back.
 */
function compress4xChunks(
  chunks: Uint8Array[],
  chunkCounter: bigint,
  cv: Uint32Array
): Uint32Array[] {
  if (!wasmMemory || !compress4xFn) {
    throw new Error("WASM not initialized");
  }

  const mem = new Uint8Array(wasmMemory.buffer);
  const memView = new DataView(wasmMemory.buffer);

  // Write 16 blocks × 4 chunks to memory (interleaved)
  // For each block word position, write 4 values (one per chunk)
  for (let block = 0; block < 16; block++) {
    for (let word = 0; word < 16; word++) {
      const offset = (block * 16 + word) * 16; // Each word position = 16 bytes (4 × i32)
      for (let chunk = 0; chunk < 4; chunk++) {
        const chunkOffset = block * BLOCK_LEN + word * 4;
        const value =
          chunks[chunk].length > chunkOffset + 3
            ? (chunks[chunk][chunkOffset] |
                (chunks[chunk][chunkOffset + 1] << 8) |
                (chunks[chunk][chunkOffset + 2] << 16) |
                (chunks[chunk][chunkOffset + 3] << 24)) >>>
              0
            : 0;
        memView.setUint32(offset + chunk * 4, value, true);
      }
    }
  }

  // Write CV to memory (splatted to 4 lanes)
  for (let i = 0; i < 8; i++) {
    for (let lane = 0; lane < 4; lane++) {
      memView.setUint32(0x100 + i * 16 + lane * 4, cv[i], true);
    }
  }

  // Process all 16 blocks per chunk
  const results: Uint32Array[] = [
    new Uint32Array(8),
    new Uint32Array(8),
    new Uint32Array(8),
    new Uint32Array(8),
  ];

  const currentCvs = [cv.slice(), cv.slice(), cv.slice(), cv.slice()];

  for (let block = 0; block < 16; block++) {
    // Set flags for this block
    let flags = 0;
    if (block === 0) flags |= CHUNK_START;
    if (block === 15) flags |= CHUNK_END;

    compress4xFn(
      Number(chunkCounter & 0xffffffffn),
      Number((chunkCounter >> 32n) & 0xffffffffn),
      BLOCK_LEN,
      flags
    );

    // Read outputs
    for (let i = 0; i < 8; i++) {
      for (let lane = 0; lane < 4; lane++) {
        const value = memView.getUint32(0x200 + i * 16 + lane * 4, true);
        if (block === 15) {
          results[lane][i] = value;
        } else {
          currentCvs[lane][i] = value;
          memView.setUint32(0x100 + i * 16 + lane * 4, value, true);
        }
      }
    }
  }

  return results;
}

// Fallback buffers
const CV_BUFFER = new Uint32Array(8);
const PARENT_BLOCK = new Uint8Array(64);

/**
 * Process single chunk (fallback to JS when SIMD unavailable)
 */
function chainingValue(
  chunk: Uint8Array,
  chunkCounter: bigint,
  flags: number
): Uint32Array {
  CV_BUFFER.set(IV);
  let pos = 0;
  const numBlocks = Math.ceil(chunk.length / BLOCK_LEN) || 1;

  for (let i = 0; i < numBlocks; i++) {
    const blockStart = pos;
    const blockEnd = Math.min(pos + BLOCK_LEN, chunk.length);
    const blockLen = blockEnd - blockStart;

    const block = new Uint8Array(BLOCK_LEN);
    if (blockLen > 0) {
      block.set(chunk.subarray(blockStart, blockEnd));
    }

    let blockFlags = flags;
    if (i === 0) blockFlags |= CHUNK_START;
    if (i === numBlocks - 1) blockFlags |= CHUNK_END;

    const state = jsCompress(
      CV_BUFFER,
      block,
      chunkCounter,
      blockLen,
      blockFlags
    );
    for (let j = 0; j < 8; j++) CV_BUFFER[j] = state[j];
    pos += BLOCK_LEN;
  }

  return CV_BUFFER.slice();
}

/**
 * Parent CV from two children
 */
function parentCv(
  left: Uint32Array,
  right: Uint32Array,
  flags: number
): Uint32Array {
  const view = new DataView(PARENT_BLOCK.buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint32(i * 4, left[i], true);
    view.setUint32(32 + i * 4, right[i], true);
  }

  const state = jsCompress(IV, PARENT_BLOCK, 0n, BLOCK_LEN, flags | PARENT);
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
 * Convert state to output bytes
 */
function wordsToOutput(state: Uint32Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    output[i] = (state[i >>> 2] >>> ((i & 3) * 8)) & 0xff;
  }
  return output;
}

/**
 * BLAKE3 Hash with SIMD acceleration
 *
 * Uses compress4x for bulk chunk processing when available.
 * Falls back to optimized JS for single chunks and parent merging.
 */
export function hash(
  input: Uint8Array,
  outputLength: number = OUT_LEN
): Uint8Array {
  const simdAvailable = initWasm();

  // Empty input
  if (input.length === 0) {
    const block = new Uint8Array(BLOCK_LEN);
    const state = jsCompress(IV, block, 0n, 0, CHUNK_START | CHUNK_END | ROOT);
    return wordsToOutput(state, outputLength);
  }

  // Single chunk: no parallelization benefit
  if (input.length <= CHUNK_LEN) {
    CV_BUFFER.set(IV);
    let pos = 0;
    const numBlocks = Math.ceil(input.length / BLOCK_LEN);

    for (let i = 0; i < numBlocks; i++) {
      const blockStart = pos;
      const blockEnd = Math.min(pos + BLOCK_LEN, input.length);
      const blockLen = blockEnd - blockStart;

      const block = new Uint8Array(BLOCK_LEN);
      block.set(input.subarray(blockStart, blockEnd));

      let flags = 0;
      if (i === 0) flags |= CHUNK_START;
      if (i === numBlocks - 1) flags |= CHUNK_END | ROOT;

      const state = jsCompress(CV_BUFFER, block, 0n, blockLen, flags);

      if (flags & ROOT) {
        return wordsToOutput(state, outputLength);
      }

      for (let j = 0; j < 8; j++) CV_BUFFER[j] = state[j];
      pos += BLOCK_LEN;
    }
  }

  // Multi-chunk: build Merkle tree with SIMD acceleration
  const cvStack: Uint32Array[] = [];
  let chunkCounter = 0n;
  let pos = 0;
  const totalChunks = Math.ceil(input.length / CHUNK_LEN);

  // Process chunks in batches of 4 when SIMD available
  if (simdAvailable && input.length >= CHUNK_LEN * 4) {
    while (pos + CHUNK_LEN * 4 <= input.length) {
      const chunks = [
        input.subarray(pos, pos + CHUNK_LEN),
        input.subarray(pos + CHUNK_LEN, pos + CHUNK_LEN * 2),
        input.subarray(pos + CHUNK_LEN * 2, pos + CHUNK_LEN * 3),
        input.subarray(pos + CHUNK_LEN * 3, pos + CHUNK_LEN * 4),
      ];

      const cvs = compress4xChunks(chunks, chunkCounter, IV);

      for (let i = 0; i < 4; i++) {
        cvStack.push(cvs[i]);
        chunkCounter++;

        let mergeCount = ctz64(chunkCounter);
        while (mergeCount > 0 && cvStack.length > 1) {
          if (chunkCounter === BigInt(totalChunks) && cvStack.length === 2) {
            break;
          }
          const right = cvStack.pop()!;
          const left = cvStack.pop()!;
          cvStack.push(parentCv(left, right, 0));
          mergeCount--;
        }
      }

      pos += CHUNK_LEN * 4;
    }
  }

  // Process remaining complete chunks
  while (pos + CHUNK_LEN <= input.length) {
    const chunk = input.subarray(pos, pos + CHUNK_LEN);
    const cv = chainingValue(chunk, chunkCounter, 0);
    cvStack.push(cv);

    chunkCounter++;
    let mergeCount = ctz64(chunkCounter);
    while (mergeCount > 0 && cvStack.length > 1) {
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

  // Final partial chunk (if any)
  if (pos < input.length) {
    const chunk = input.subarray(pos);
    const cv = chainingValue(chunk, chunkCounter, 0);
    cvStack.push(cv);
  }

  // Merge remaining stack items from right to left
  while (cvStack.length > 2) {
    const right = cvStack.pop()!;
    const left = cvStack.pop()!;
    cvStack.push(parentCv(left, right, 0));
  }

  // Final merge with ROOT flag
  if (cvStack.length === 2) {
    const right = cvStack.pop()!;
    const left = cvStack.pop()!;
    const view = new DataView(PARENT_BLOCK.buffer);
    for (let i = 0; i < 8; i++) {
      view.setUint32(i * 4, left[i], true);
      view.setUint32(32 + i * 4, right[i], true);
    }
    const state = jsCompress(IV, PARENT_BLOCK, 0n, BLOCK_LEN, PARENT | ROOT);
    return wordsToOutput(state, outputLength);
  }

  // Shouldn't reach here for multi-chunk input
  throw new Error("Unexpected state in multi-chunk hash");
}
