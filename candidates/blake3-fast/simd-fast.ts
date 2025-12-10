/**
 * BLAKE3 Chunk-Level SIMD Implementation (~500 MB/s)
 *
 * This version processes entire 1024-byte chunks in WASM, which drastically
 * reduces JS<->WASM boundary crossings (16x fewer calls). The CVs stay in
 * WASM memory between blocks, so we never copy intermediate state back to JS.
 *
 * The big wins here come from:
 *
 *   1. Chunk-level WASM functions: Instead of calling compress() 16 times per
 *      chunk, we call compressChunk() once. That's 16x fewer round-trips across
 *      the JS/WASM boundary, which is expensive.
 *
 *   2. CVs kept in WASM memory: The chaining value stays in linear memory
 *      between the 16 block compressions. Zero copies until we need the result.
 *
 *   3. Byte-shuffle rotations: For 16-bit and 8-bit rotations, i8x16.shuffle
 *      is faster than shift+or because it's a single instruction. We only fall
 *      back to shift+or for 12-bit and 7-bit rotations.
 *
 *   4. Fully unrolled rounds: All 7 compression rounds are unrolled at codegen
 *      time. No loop overhead, and the message schedule is baked into the code.
 *
 * Memory Layout (single 64KB page):
 * +-----------+--------------------------------------------------+
 * | Offset    | Contents                                         |
 * +-----------+--------------------------------------------------+
 * | 0-1023    | Input chunk (1024 bytes = 16 blocks x 64 bytes)  |
 * | 1024-1039 | Metadata: [counter_lo, counter_hi, len, flags]   |
 * | 1056-1119 | Parent block scratch (64 bytes for two CVs)      |
 * | 1120-1151 | Output CV (32 bytes = 8 words)                   |
 * +-----------+--------------------------------------------------+
 *
 * The row-major state representation uses 4 v128 registers:
 *
 *   ROW0 = [s0,  s1,  s2,  s3 ]   <- CV words 0-3
 *   ROW1 = [s4,  s5,  s6,  s7 ]   <- CV words 4-7
 *   ROW2 = [s8,  s9,  s10, s11]   <- IV constants
 *   ROW3 = [s12, s13, s14, s15]   <- counter, length, flags
 *
 * This lets us do the column mixing phase with 4 parallel G functions.
 * For diagonal mixing, we shuffle the rows to align the diagonals, run G,
 * then shuffle back.
 *
 * Based on the approach described in:
 * https://web.archive.org/web/20250320125147/https://blog.fleek.network/post/fleek-network-blake3-case-study/
 *
 * (c) 2025 Alexander Atamanov - MIT License
 */

import {
  IV,
  BLOCK_LEN,
  CHUNK_LEN,
  OUT_LEN,
  CHUNK_START,
  CHUNK_END,
  ROOT,
  PARENT,
} from "./constants.js";
import { ctz64 } from "./utils.js";

// Feature detection: check if this runtime supports WASM SIMD by validating
// a minimal module that uses v128.const. If this fails, we fall back to JS.
export const SIMD_SUPPORTED = (() => {
  if (typeof WebAssembly === "undefined") return false;
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
        0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x16, 0x01, 0x14, 0x00,
        0xfd, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0b,
      ])
    );
  } catch {
    return false;
  }
})();

/**
 * Precomputed message schedule for BLAKE3's 7 rounds.
 *
 * Each round uses a permuted message order. Instead of permuting at runtime
 * (expensive), we precompute which message words go where for each round.
 *
 * Format: [colMx, colMy, diagMx, diagMy]
 *   colMx[i]  = message word index for column G function i, first half
 *   colMy[i]  = message word index for column G function i, second half
 *   diagMx[i] = message word index for diagonal G function i, first half
 *   diagMy[i] = message word index for diagonal G function i, second half
 *
 * This precomputation alone gave Fleek ~1.6x speedup over permuting at runtime.
 */
const SCHED = [
  [
    [0, 2, 4, 6],
    [1, 3, 5, 7],
    [8, 10, 12, 14],
    [9, 11, 13, 15],
  ],
  [
    [2, 3, 7, 4],
    [6, 10, 0, 13],
    [1, 12, 9, 15],
    [11, 5, 14, 8],
  ],
  [
    [3, 10, 13, 7],
    [4, 12, 2, 14],
    [6, 9, 11, 8],
    [5, 0, 15, 1],
  ],
  [
    [10, 12, 14, 13],
    [7, 9, 3, 15],
    [4, 11, 5, 1],
    [0, 2, 8, 6],
  ],
  [
    [12, 9, 15, 14],
    [13, 11, 10, 8],
    [7, 5, 0, 6],
    [2, 3, 1, 4],
  ],
  [
    [9, 11, 8, 15],
    [14, 5, 12, 1],
    [13, 0, 2, 4],
    [3, 10, 6, 7],
  ],
  [
    [11, 5, 1, 8],
    [15, 0, 9, 6],
    [14, 2, 3, 7],
    [10, 12, 4, 13],
  ],
];

/**
 * Byte-shuffle patterns for lane rotations.
 *
 * i8x16.shuffle reorders bytes within a 128-bit vector. We use it for:
 *   - Row rotations (moving 32-bit lanes around for diagonal mixing)
 *   - Bit rotations (16-bit and 8-bit rotations are free with shuffle)
 *
 * ROT1_L: rotate lanes left by 1  -> [1,2,3,0] from [0,1,2,3]
 * ROT2_L: rotate lanes left by 2  -> [2,3,0,1] from [0,1,2,3]
 * ROT3_L: rotate lanes left by 3  -> [3,0,1,2] from [0,1,2,3]
 *
 * ROTR16: rotate each 32-bit word right by 16 bits (swap halves)
 * ROTR8:  rotate each 32-bit word right by 8 bits (byte rotate)
 */
const ROT1_L = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3];
const ROT2_L = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];
const ROT3_L = [12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const ROT1_R = [12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const ROT2_R = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];
const ROT3_R = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3];
const ROTR16 = [2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13];
const ROTR8 = [1, 2, 3, 0, 5, 6, 7, 4, 9, 10, 11, 8, 13, 14, 15, 12];

// Memory offsets
const OFF_INPUT = 0;
const OFF_META = 1024; // [counter_lo, counter_hi, chunkLen, extraFlags]
const OFF_PARENT = 1056; // Parent block (64 bytes for parent compression)
const OFF_OUTPUT = 1120; // Output CV (32 bytes)

/**
 * WASM bytecode builder.
 *
 * We generate WASM bytecode programmatically instead of shipping a .wasm file.
 * This keeps the bundle smaller and avoids loading/fetching issues.
 *
 * Each method emits the corresponding WASM instruction bytes.
 * The instruction encoding follows the WASM binary spec.
 */
class WasmBuilder {
  code: number[] = [];

  emit(...b: number[]) {
    this.code.push(...b);
  }
  localGet(i: number) {
    this.emit(0x20, i);
  }
  localSet(i: number) {
    this.emit(0x21, i);
  }
  localTee(i: number) {
    this.emit(0x22, i);
  }

  // i32.const with LEB128 signed encoding
  i32Const(v: number) {
    this.emit(0x41);
    let val = v,
      more = true;
    while (more) {
      let b = val & 0x7f;
      val >>= 7;
      more = !((val === 0 && !(b & 0x40)) || (val === -1 && b & 0x40));
      if (more) b |= 0x80;
      this.emit(b);
    }
  }

  i32Add() {
    this.emit(0x6a);
  }
  i32Sub() {
    this.emit(0x6b);
  }
  i32Mul() {
    this.emit(0x6c);
  }
  i32DivU() {
    this.emit(0x6d);
  }
  i32And() {
    this.emit(0x71);
  }
  i32Or() {
    this.emit(0x72);
  }
  i32Eq() {
    this.emit(0x46);
  }
  i32LtU() {
    this.emit(0x49);
  }

  i32Load(off: number) {
    this.emit(0x28, 0x02);
    this.uleb(off);
  }
  i32Store(off: number) {
    this.emit(0x36, 0x02);
    this.uleb(off);
  }

  // v128.const - embed 4 i32 values directly in the bytecode
  v128Const(a: number, b: number, c: number, d: number) {
    this.emit(0xfd, 0x0c);
    for (const v of [a, b, c, d])
      this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  v128Load(off: number) {
    this.emit(0xfd, 0x00, 0x04);
    this.uleb(off);
  }
  v128Store(off: number) {
    this.emit(0xfd, 0x0b, 0x04);
    this.uleb(off);
  }
  v128Xor() {
    this.emit(0xfd, 0x51);
  }
  v128Or() {
    this.emit(0xfd, 0x50);
  }
  i32x4Add() {
    this.emit(0xfd, 0xae, 0x01);
  }
  i32x4Shl() {
    this.emit(0xfd, 0xab, 0x01);
  }
  i32x4ShrU() {
    this.emit(0xfd, 0xad, 0x01);
  }
  i8x16Shuffle(idx: number[]) {
    this.emit(0xfd, 0x0d, ...idx);
  }
  i32x4Splat() {
    this.emit(0xfd, 0x11);
  }
  i32x4ReplaceLane(l: number) {
    this.emit(0xfd, 0x1c, l);
  }

  block(code: () => void) {
    this.emit(0x02, 0x40);
    code();
    this.emit(0x0b);
  }
  loop(code: () => void) {
    this.emit(0x03, 0x40);
    code();
    this.emit(0x0b);
  }
  br(d: number) {
    this.emit(0x0c, d);
  }
  brIf(d: number) {
    this.emit(0x0d, d);
  }
  ifThen(code: () => void) {
    this.emit(0x04, 0x40);
    code();
    this.emit(0x0b);
  }
  ifElse(thenCode: () => void, elseCode: () => void) {
    this.emit(0x04, 0x40);
    thenCode();
    this.emit(0x05);
    elseCode();
    this.emit(0x0b);
  }
  end() {
    this.emit(0x0b);
  }

  // Unsigned LEB128 encoding for offsets
  uleb(v: number) {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      this.emit(b);
    } while (v);
  }
}

/**
 * Emit the compression of a single 64-byte block.
 *
 * This is the inner loop that gets called 16 times per chunk (or 7 times
 * for parent compression). We inline everything and use row-parallel SIMD.
 *
 * The G function is split into two halves (gHalf):
 *   First half:  a += b + mx; d = rotr(d^a, 16); c += d; b = rotr(b^c, 12)
 *   Second half: a += b + my; d = rotr(d^a, 8);  c += d; b = rotr(b^c, 7)
 *
 * We run all 4 columns in parallel using SIMD. For the diagonal round,
 * we rotate the rows so diagonals become columns, run G, then rotate back.
 */
function emitCompressBlock(
  w: WasmBuilder,
  getMsgPtr: () => void,
  ROW0: number,
  ROW1: number,
  ROW2: number,
  ROW3: number,
  MX: number,
  MY: number
) {
  /**
   * Gather 4 message words into a v128 for parallel G functions.
   * We load m[i0], m[i1], m[i2], m[i3] into lanes 0-3 of the destination.
   */
  const gatherMsg = (
    i0: number,
    i1: number,
    i2: number,
    i3: number,
    dst: number
  ) => {
    getMsgPtr();
    w.i32Load(i0 * 4);
    w.i32x4Splat();
    getMsgPtr();
    w.i32Load(i1 * 4);
    w.i32x4ReplaceLane(1);
    getMsgPtr();
    w.i32Load(i2 * 4);
    w.i32x4ReplaceLane(2);
    getMsgPtr();
    w.i32Load(i3 * 4);
    w.i32x4ReplaceLane(3);
    w.localSet(dst);
  };

  /**
   * Half of the G function for all 4 columns in parallel.
   *
   * rot1 is either 16 or 8 (we use shuffle for these)
   * rot2 is either 12 or 7 (we use shift+or for these)
   */
  const gHalf = (mLoc: number, rot1: number, rot2: number) => {
    // a = a + b + m
    w.localGet(ROW0);
    w.localGet(ROW1);
    w.i32x4Add();
    w.localGet(mLoc);
    w.i32x4Add();
    w.localSet(ROW0);

    // d = rotr(d ^ a, rot1)
    // For rot1=16 or rot1=8, we use byte shuffle (faster than shift+or)
    w.localGet(ROW3);
    w.localGet(ROW0);
    w.v128Xor();
    if (rot1 === 16) {
      w.localTee(ROW3);
      w.localGet(ROW3);
      w.i8x16Shuffle(ROTR16);
    } else {
      w.localTee(ROW3);
      w.localGet(ROW3);
      w.i8x16Shuffle(ROTR8);
    }
    w.localSet(ROW3);

    // c = c + d
    w.localGet(ROW2);
    w.localGet(ROW3);
    w.i32x4Add();
    w.localSet(ROW2);

    // b = rotr(b ^ c, rot2)
    // For rot2=12 or rot2=7, we use shift + or
    w.localGet(ROW1);
    w.localGet(ROW2);
    w.v128Xor();
    w.localTee(ROW1);
    w.i32Const(rot2);
    w.i32x4ShrU();
    w.localGet(ROW1);
    w.i32Const(32 - rot2);
    w.i32x4Shl();
    w.v128Or();
    w.localSet(ROW1);
  };

  /**
   * Rotate rows for diagonal mixing.
   *
   * Before:  [a0,a1,a2,a3]  [b0,b1,b2,b3]  [c0,c1,c2,c3]  [d0,d1,d2,d3]
   * After:   [a0,a1,a2,a3]  [b1,b2,b3,b0]  [c2,c3,c0,c1]  [d3,d0,d1,d2]
   *
   * Now the diagonals (a0,b1,c2,d3), (a1,b2,c3,d0), etc. are in column positions.
   */
  const rotateDiag = () => {
    w.localGet(ROW1);
    w.localGet(ROW1);
    w.i8x16Shuffle(ROT1_L);
    w.localSet(ROW1);
    w.localGet(ROW2);
    w.localGet(ROW2);
    w.i8x16Shuffle(ROT2_L);
    w.localSet(ROW2);
    w.localGet(ROW3);
    w.localGet(ROW3);
    w.i8x16Shuffle(ROT3_L);
    w.localSet(ROW3);
  };

  /** Undo the diagonal rotation after diagonal mixing. */
  const unrotateDiag = () => {
    w.localGet(ROW1);
    w.localGet(ROW1);
    w.i8x16Shuffle(ROT1_R);
    w.localSet(ROW1);
    w.localGet(ROW2);
    w.localGet(ROW2);
    w.i8x16Shuffle(ROT2_R);
    w.localSet(ROW2);
    w.localGet(ROW3);
    w.localGet(ROW3);
    w.i8x16Shuffle(ROT3_R);
    w.localSet(ROW3);
  };

  // All 7 rounds unrolled. Each round = column mixing + diagonal mixing.
  for (let r = 0; r < 7; r++) {
    const [colMx, colMy, diagMx, diagMy] = SCHED[r];

    // Column mixing: G on columns 0,1,2,3
    gatherMsg(colMx[0], colMx[1], colMx[2], colMx[3], MX);
    gatherMsg(colMy[0], colMy[1], colMy[2], colMy[3], MY);
    gHalf(MX, 16, 12);
    gHalf(MY, 8, 7);

    // Diagonal mixing: rotate rows, G, unrotate
    rotateDiag();
    gatherMsg(diagMx[0], diagMx[1], diagMx[2], diagMx[3], MX);
    gatherMsg(diagMy[0], diagMy[1], diagMy[2], diagMy[3], MY);
    gHalf(MX, 16, 12);
    gHalf(MY, 8, 7);
    unrotateDiag();
  }

  // Feed-forward XOR (Davies-Meyer construction)
  // out[0..3] = state[0..3] ^ state[8..11]
  // out[4..7] = state[4..7] ^ state[12..15]
  w.localGet(ROW0);
  w.localGet(ROW2);
  w.v128Xor();
  w.localSet(ROW0);
  w.localGet(ROW1);
  w.localGet(ROW3);
  w.v128Xor();
  w.localSet(ROW1);
}

/**
 * Build compressChunk: process all 16 blocks of a full 1024-byte chunk.
 *
 * This runs entirely in WASM. The CV stays in registers between blocks,
 * avoiding 16 round-trips to JS. Only the final CV is written to memory.
 *
 * Input:  Chunk at mem[0:1024], counter at mem[1024:1032], flags at mem[1036]
 * Output: CV at mem[1120:1152]
 */
function buildCompressChunk(): number[] {
  const w = new WasmBuilder();

  // Local variable indices (v128 registers)
  const ROW0 = 0,
    ROW1 = 1,
    ROW2 = 2,
    ROW3 = 3,
    MX = 4,
    MY = 5;
  const CV0 = 6,
    CV1 = 7; // Persistent CV across blocks
  const BLOCK_IDX = 8,
    MSG_PTR = 9,
    FLAGS = 10; // i32 locals

  // Initialize CV = IV (standard BLAKE3 starting state)
  w.v128Const(IV[0], IV[1], IV[2], IV[3]);
  w.localSet(CV0);
  w.v128Const(IV[4], IV[5], IV[6], IV[7]);
  w.localSet(CV1);

  w.i32Const(0);
  w.localSet(BLOCK_IDX);
  w.i32Const(0);
  w.localSet(MSG_PTR);

  // Loop over 16 blocks
  w.block(() => {
    w.loop(() => {
      // Load CV into state rows 0-1
      w.localGet(CV0);
      w.localSet(ROW0);
      w.localGet(CV1);
      w.localSet(ROW1);
      // Row 2 = first 4 IV words (constant)
      w.v128Const(IV[0], IV[1], IV[2], IV[3]);
      w.localSet(ROW2);

      // Compute flags: CHUNK_START on block 0, CHUNK_END | extraFlags on block 15
      w.i32Const(0);
      w.localSet(FLAGS);
      w.localGet(BLOCK_IDX);
      w.i32Const(0);
      w.i32Eq();
      w.ifThen(() => {
        w.localGet(FLAGS);
        w.i32Const(CHUNK_START);
        w.i32Or();
        w.localSet(FLAGS);
      });
      w.localGet(BLOCK_IDX);
      w.i32Const(15);
      w.i32Eq();
      w.ifThen(() => {
        w.localGet(FLAGS);
        w.i32Const(CHUNK_END);
        w.i32Or();
        w.i32Const(OFF_META);
        w.i32Load(12); // extraFlags (e.g., ROOT)
        w.i32Or();
        w.localSet(FLAGS);
      });

      // Row 3 = [counter_lo, counter_hi, blockLen=64, flags]
      w.i32Const(OFF_META);
      w.i32Load(0);
      w.i32x4Splat();
      w.i32Const(OFF_META);
      w.i32Load(4);
      w.i32x4ReplaceLane(1);
      w.i32Const(64);
      w.i32x4ReplaceLane(2);
      w.localGet(FLAGS);
      w.i32x4ReplaceLane(3);
      w.localSet(ROW3);

      // Compress this block
      emitCompressBlock(
        w,
        () => w.localGet(MSG_PTR),
        ROW0,
        ROW1,
        ROW2,
        ROW3,
        MX,
        MY
      );

      // Save CV for next block
      w.localGet(ROW0);
      w.localSet(CV0);
      w.localGet(ROW1);
      w.localSet(CV1);

      // Advance to next block
      w.localGet(BLOCK_IDX);
      w.i32Const(1);
      w.i32Add();
      w.localSet(BLOCK_IDX);
      w.localGet(MSG_PTR);
      w.i32Const(64);
      w.i32Add();
      w.localSet(MSG_PTR);

      // Continue if blockIdx < 16
      w.localGet(BLOCK_IDX);
      w.i32Const(16);
      w.i32LtU();
      w.brIf(0);
    });
  });

  // Store output CV to memory
  w.i32Const(OFF_OUTPUT);
  w.localGet(CV0);
  w.v128Store(0);
  w.i32Const(OFF_OUTPUT);
  w.localGet(CV1);
  w.v128Store(16);

  w.end();
  return w.code;
}

/**
 * Build compressPartial: process a partial chunk (< 1024 bytes).
 *
 * Same as compressChunk but handles variable block count and lengths.
 * The last block may be less than 64 bytes (padded with zeros).
 */
function buildCompressPartial(): number[] {
  const w = new WasmBuilder();

  const ROW0 = 0,
    ROW1 = 1,
    ROW2 = 2,
    ROW3 = 3,
    MX = 4,
    MY = 5;
  const CV0 = 6,
    CV1 = 7;
  const BLOCK_IDX = 8,
    MSG_PTR = 9,
    FLAGS = 10;
  const CHUNK_LEN_L = 11,
    NUM_BLOCKS = 12,
    BLOCK_LEN_L = 13;

  // Load chunk length, compute number of blocks
  w.i32Const(OFF_META);
  w.i32Load(8);
  w.localTee(CHUNK_LEN_L);
  w.i32Const(63);
  w.i32Add();
  w.i32Const(64);
  w.i32DivU();
  w.localSet(NUM_BLOCKS);

  // At least 1 block (even for empty input)
  w.localGet(NUM_BLOCKS);
  w.i32Const(0);
  w.i32Eq();
  w.ifThen(() => {
    w.i32Const(1);
    w.localSet(NUM_BLOCKS);
  });

  // Initialize CV = IV
  w.v128Const(IV[0], IV[1], IV[2], IV[3]);
  w.localSet(CV0);
  w.v128Const(IV[4], IV[5], IV[6], IV[7]);
  w.localSet(CV1);

  w.i32Const(0);
  w.localSet(BLOCK_IDX);
  w.i32Const(0);
  w.localSet(MSG_PTR);

  w.block(() => {
    w.loop(() => {
      w.localGet(CV0);
      w.localSet(ROW0);
      w.localGet(CV1);
      w.localSet(ROW1);
      w.v128Const(IV[0], IV[1], IV[2], IV[3]);
      w.localSet(ROW2);

      // Compute block length: min(64, chunkLen - blockIdx*64)
      w.localGet(CHUNK_LEN_L);
      w.localGet(BLOCK_IDX);
      w.i32Const(64);
      w.i32Mul();
      w.i32Sub();
      w.localTee(BLOCK_LEN_L);
      w.i32Const(64);
      w.i32LtU();
      w.ifElse(
        () => {},
        () => {
          w.i32Const(64);
          w.localSet(BLOCK_LEN_L);
        }
      );

      // Flags
      w.i32Const(0);
      w.localSet(FLAGS);
      w.localGet(BLOCK_IDX);
      w.i32Const(0);
      w.i32Eq();
      w.ifThen(() => {
        w.localGet(FLAGS);
        w.i32Const(CHUNK_START);
        w.i32Or();
        w.localSet(FLAGS);
      });
      w.localGet(BLOCK_IDX);
      w.i32Const(1);
      w.i32Add();
      w.localGet(NUM_BLOCKS);
      w.i32Eq();
      w.ifThen(() => {
        w.localGet(FLAGS);
        w.i32Const(CHUNK_END);
        w.i32Or();
        w.i32Const(OFF_META);
        w.i32Load(12);
        w.i32Or();
        w.localSet(FLAGS);
      });

      // Row 3
      w.i32Const(OFF_META);
      w.i32Load(0);
      w.i32x4Splat();
      w.i32Const(OFF_META);
      w.i32Load(4);
      w.i32x4ReplaceLane(1);
      w.localGet(BLOCK_LEN_L);
      w.i32x4ReplaceLane(2);
      w.localGet(FLAGS);
      w.i32x4ReplaceLane(3);
      w.localSet(ROW3);

      emitCompressBlock(
        w,
        () => w.localGet(MSG_PTR),
        ROW0,
        ROW1,
        ROW2,
        ROW3,
        MX,
        MY
      );

      w.localGet(ROW0);
      w.localSet(CV0);
      w.localGet(ROW1);
      w.localSet(CV1);

      w.localGet(BLOCK_IDX);
      w.i32Const(1);
      w.i32Add();
      w.localSet(BLOCK_IDX);
      w.localGet(MSG_PTR);
      w.i32Const(64);
      w.i32Add();
      w.localSet(MSG_PTR);

      w.localGet(BLOCK_IDX);
      w.localGet(NUM_BLOCKS);
      w.i32LtU();
      w.brIf(0);
    });
  });

  w.i32Const(OFF_OUTPUT);
  w.localGet(CV0);
  w.v128Store(0);
  w.i32Const(OFF_OUTPUT);
  w.localGet(CV1);
  w.v128Store(16);

  w.end();
  return w.code;
}

/**
 * Build compressParent: merge two CVs into a parent CV.
 *
 * In the BLAKE3 Merkle tree, we compress two 32-byte child CVs (64 bytes total)
 * into a single parent CV. This uses IV as the starting CV and PARENT flag.
 *
 * Input:  Left CV at mem[1056:1088], Right CV at mem[1088:1120], flags at mem[1032]
 * Output: Parent CV at mem[1120:1152]
 */
function buildCompressParent(): number[] {
  const w = new WasmBuilder();

  const ROW0 = 0,
    ROW1 = 1,
    ROW2 = 2,
    ROW3 = 3,
    MX = 4,
    MY = 5;

  // CV = IV (parent nodes always start with IV)
  w.v128Const(IV[0], IV[1], IV[2], IV[3]);
  w.localSet(ROW0);
  w.v128Const(IV[4], IV[5], IV[6], IV[7]);
  w.localSet(ROW1);
  w.v128Const(IV[0], IV[1], IV[2], IV[3]);
  w.localSet(ROW2);

  // Row 3 = [0, 0, 64, PARENT | flags]
  // Parent compressions always use counter=0 and blockLen=64
  w.i32Const(0);
  w.i32x4Splat();
  w.i32Const(64);
  w.i32x4ReplaceLane(2);
  w.i32Const(OFF_META);
  w.i32Load(8);
  w.i32Const(PARENT);
  w.i32Or();
  w.i32x4ReplaceLane(3);
  w.localSet(ROW3);

  // Message = concatenated CVs at OFF_PARENT
  emitCompressBlock(
    w,
    () => w.i32Const(OFF_PARENT),
    ROW0,
    ROW1,
    ROW2,
    ROW3,
    MX,
    MY
  );

  // Store output
  w.i32Const(OFF_OUTPUT);
  w.localGet(ROW0);
  w.v128Store(0);
  w.i32Const(OFF_OUTPUT);
  w.localGet(ROW1);
  w.v128Store(16);

  w.end();
  return w.code;
}

/**
 * Build the complete WASM module.
 *
 * Module structure:
 *   Section 1 (Types): () -> ()
 *   Section 3 (Functions): 3 functions using type 0
 *   Section 5 (Memory): 1 page (64KB)
 *   Section 7 (Exports): compressChunk, compressPartial, compressParent, mem
 *   Section 10 (Code): function bodies
 */
function generateModule(): Uint8Array {
  const mod: number[] = [];
  const put = (...b: number[]) => mod.push(...b);
  const uleb = (v: number) => {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      mod.push(b);
    } while (v);
  };
  const section = (id: number, data: number[]) => {
    mod.push(id);
    uleb(data.length);
    mod.push(...data);
  };

  // Magic + version
  put(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

  // Type section: () -> ()
  section(0x01, [0x01, 0x60, 0x00, 0x00]);

  // Function section: 3 functions
  section(0x03, [0x03, 0x00, 0x00, 0x00]);

  // Memory section: 1 page (64KB)
  section(0x05, [0x01, 0x00, 0x01]);

  // Export section
  const exports: number[] = [0x04]; // 4 exports
  const addExp = (name: string, kind: number, idx: number) => {
    exports.push(
      name.length,
      ...Array.from(name).map((c) => c.charCodeAt(0)),
      kind,
      idx
    );
  };
  addExp("compressChunk", 0x00, 0);
  addExp("compressPartial", 0x00, 1);
  addExp("compressParent", 0x00, 2);
  addExp("mem", 0x02, 0);
  section(0x07, exports);

  // Build function bodies
  const chunkCode = buildCompressChunk();
  const partialCode = buildCompressPartial();
  const parentCode = buildCompressParent();

  const encodeFunc = (code: number[], numV128: number, numI32: number) => {
    const locals: number[] = [];
    let groups = 0;
    if (numV128 > 0) {
      locals.push(numV128, 0x7b);
      groups++;
    }
    if (numI32 > 0) {
      locals.push(numI32, 0x7f);
      groups++;
    }
    const body = [groups, ...locals, ...code];
    const lenBytes: number[] = [];
    let len = body.length;
    do {
      let b = len & 0x7f;
      len >>>= 7;
      if (len) b |= 0x80;
      lenBytes.push(b);
    } while (len);
    return [...lenBytes, ...body];
  };

  const func0 = encodeFunc(chunkCode, 8, 3);
  const func1 = encodeFunc(partialCode, 8, 6);
  const func2 = encodeFunc(parentCode, 6, 0);

  section(0x0a, [0x03, ...func0, ...func1, ...func2]);

  return new Uint8Array(mod);
}

// ============================================================================
// RUNTIME
// ============================================================================

let instance: WebAssembly.Instance | null = null;
let compressChunkFn: (() => void) | null = null;
let compressPartialFn: (() => void) | null = null;
let compressParentFn: (() => void) | null = null;
let mem: Uint8Array | null = null;
let mem32: Uint32Array | null = null;

function initWasm(): boolean {
  if (instance) return true;
  if (!SIMD_SUPPORTED) return false;
  try {
    const module = new WebAssembly.Module(generateModule() as BufferSource);
    instance = new WebAssembly.Instance(module);
    const wasmMem = instance.exports.mem as WebAssembly.Memory;
    compressChunkFn = instance.exports.compressChunk as () => void;
    compressPartialFn = instance.exports.compressPartial as () => void;
    compressParentFn = instance.exports.compressParent as () => void;
    mem = new Uint8Array(wasmMem.buffer);
    mem32 = new Uint32Array(wasmMem.buffer);
    return true;
  } catch (e) {
    console.warn("Fast SIMD init failed:", e);
    return false;
  }
}

/** Process a full 1024-byte chunk. extraFlags is ORed into the last block. */
function processChunk(
  chunk: Uint8Array,
  counter: bigint,
  extraFlags: number = 0
): Uint32Array {
  mem!.set(chunk, OFF_INPUT);
  mem32![OFF_META / 4] = Number(counter & 0xffffffffn);
  mem32![OFF_META / 4 + 1] = Number((counter >> 32n) & 0xffffffffn);
  mem32![OFF_META / 4 + 3] = extraFlags;
  compressChunkFn!();
  return new Uint32Array(mem32!.buffer, OFF_OUTPUT, 8).slice();
}

/** Process a partial chunk (< 1024 bytes). */
function processPartial(
  chunk: Uint8Array,
  counter: bigint,
  extraFlags: number = 0
): Uint32Array {
  mem!.fill(0, OFF_INPUT, OFF_INPUT + CHUNK_LEN);
  mem!.set(chunk, OFF_INPUT);
  mem32![OFF_META / 4] = Number(counter & 0xffffffffn);
  mem32![OFF_META / 4 + 1] = Number((counter >> 32n) & 0xffffffffn);
  mem32![OFF_META / 4 + 2] = chunk.length;
  mem32![OFF_META / 4 + 3] = extraFlags;
  compressPartialFn!();
  return new Uint32Array(mem32!.buffer, OFF_OUTPUT, 8).slice();
}

/** Merge two child CVs into a parent CV. */
function computeParent(
  left: Uint32Array,
  right: Uint32Array,
  flags: number
): Uint32Array {
  for (let i = 0; i < 8; i++) {
    mem32![OFF_PARENT / 4 + i] = left[i];
    mem32![OFF_PARENT / 4 + 8 + i] = right[i];
  }
  mem32![OFF_META / 4 + 2] = flags;
  compressParentFn!();
  return new Uint32Array(mem32!.buffer, OFF_OUTPUT, 8).slice();
}

function cvToBytes(cv: Uint32Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (cv[i >>> 2] >>> ((i & 3) << 3)) & 0xff;
  }
  return out;
}

/**
 * BLAKE3 hash with chunk-level SIMD acceleration.
 * Processes entire chunks in WASM, minimizing boundary crossings.
 */
export function hash(input: Uint8Array, outLen: number = OUT_LEN): Uint8Array {
  if (!initWasm()) throw new Error("Fast SIMD not available");

  // Empty input
  if (input.length === 0) {
    const cv = processPartial(new Uint8Array(0), 0n, ROOT);
    return cvToBytes(cv, outLen);
  }

  // Single chunk: add ROOT flag
  if (input.length <= CHUNK_LEN) {
    const cv =
      input.length === CHUNK_LEN
        ? processChunk(input, 0n, ROOT)
        : processPartial(input, 0n, ROOT);
    return cvToBytes(cv, outLen);
  }

  // Multi-chunk: build Merkle tree
  const cvStack: Uint32Array[] = [];
  const totalChunks = Math.ceil(input.length / CHUNK_LEN);
  let chunkCounter = 0n;
  let pos = 0;

  while (pos + CHUNK_LEN <= input.length) {
    cvStack.push(
      processChunk(input.subarray(pos, pos + CHUNK_LEN), chunkCounter)
    );
    chunkCounter++;

    // Merge parents based on trailing zeros in chunk counter
    const isLast = Number(chunkCounter) === totalChunks;
    let merge = ctz64(chunkCounter);
    while (merge > 0 && cvStack.length >= 2) {
      if (isLast && cvStack.length === 2) break;
      const r = cvStack.pop()!,
        l = cvStack.pop()!;
      cvStack.push(computeParent(l, r, 0));
      merge--;
    }
    pos += CHUNK_LEN;
  }

  // Final partial chunk
  if (pos < input.length) {
    cvStack.push(processPartial(input.subarray(pos), chunkCounter));
  }

  // Merge remaining with ROOT flag on last merge
  while (cvStack.length > 1) {
    const r = cvStack.pop()!,
      l = cvStack.pop()!;
    const flags = cvStack.length === 0 ? ROOT : 0;
    cvStack.push(computeParent(l, r, flags));
  }

  return cvToBytes(cvStack[0], outLen);
}

export { SIMD_SUPPORTED as FAST_SIMD_SUPPORTED };
