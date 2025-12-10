/**
 * BLAKE3 4-Way Parallel SIMD (~1.17 GB/s)
 *
 * Processes 4 chunks simultaneously by interleaving them across SIMD lanes.
 * BLAKE3's Merkle tree makes chunks independent - perfect for data parallelism.
 *
 *                     ┌─────────────────────────────────────┐
 *                     │  v128 register (4 lanes × 32 bits)  │
 *                     ├─────────┬─────────┬─────────┬───────┤
 *   S[i] holds:       │ chunk0  │ chunk1  │ chunk2  │chunk3 │
 *                     │   .si   │   .si   │   .si   │  .si  │
 *                     └─────────┴─────────┴─────────┴───────┘
 *
 * One i32x4.add = 4 additions. One compression = 4 chunk compressions.
 *
 * Three implementations, progressively faster:
 *   hash()      ~1.0  GB/s  Basic 4-way parallel
 *   hashFast()  ~1.0 GB/s  + zero allocations, number counters
 *   hashHyper() ~1.2 GB/s  + 8-chunk batches, de Bruijn ctz
 *
 * WASM Memory Layout (one 64KB page):
 *   0x0000-0x0FFF  Input: 4 chunks × 1KB contiguous
 *   0x1000-0x101F  Counters: 4 × (lo32, hi32)
 *   0x1020-0x103F  Metadata: extraFlags, etc.
 *   0x1040-0x10BF  Output: 4 CVs × 32 bytes
 *   0x10C0+        Scratch for parent compression
 *
 * Message Gather: For word w at block b, chunk c:
 *   offset = c×1024 + b×64 + w×4
 * Load 4 offsets, pack into v128, feed to G function.
 *
 * Based on: https://blog.fleek.network/post/fleek-network-blake3-case-study/
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

// Detect SIMD support by validating a minimal WASM module with v128.const
export const SIMD_SUPPORTED = (() => {
  if (typeof WebAssembly === "undefined") return false;
  try {
    // Minimal module: (func (result v128) (v128.const i32x4 0 0 0 0))
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
 * Message permutation schedule for 7 BLAKE3 rounds.
 *
 * Each round permutes 16 message words into 8 pairs (mx, my) for the G function.
 * Column round: G(0,4,8,12), G(1,5,9,13), G(2,6,10,14), G(3,7,11,15)
 * Diagonal round: G(0,5,10,15), G(1,6,11,12), G(2,7,8,13), G(3,4,9,14)
 *
 * Format: [columnMx[4], columnMy[4], diagonalMx[4], diagonalMy[4]]
 * Each sub-array has 4 entries, one per G function in that phase.
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
 * Byte-shuffle patterns for 16-bit and 8-bit rotations.
 *
 * i8x16.shuffle is a single instruction that reorders bytes within a v128.
 * For 16-bit and 8-bit rotations, this is faster than shift+or.
 *
 * ROTR16: Each 32-bit word has its two 16-bit halves swapped.
 *         [b0,b1,b2,b3] -> [b2,b3,b0,b1]
 *
 * ROTR8:  Each 32-bit word is rotated right by 8 bits.
 *         [b0,b1,b2,b3] -> [b1,b2,b3,b0]
 */
const ROTR16 = [2, 3, 0, 1, 6, 7, 4, 5, 10, 11, 8, 9, 14, 15, 12, 13];
const ROTR8 = [1, 2, 3, 0, 5, 6, 7, 4, 9, 10, 11, 8, 13, 14, 15, 12];

// WASM memory offsets (see header diagram)
const OFF_CHUNKS = 0x0000; // 4 chunks × 1024 bytes
const OFF_COUNTERS = 0x1000; // 4 counters × 8 bytes
const OFF_META = 0x1020; // flags and metadata
const OFF_CVS = 0x1040; // 4 output CVs × 32 bytes
const OFF_SCRATCH = 0x10c0; // parent compression scratch

// ═══════════════════════════════════════════════════════════════
// PRE-ALLOCATED BUFFERS
// Merkle tree depth is log2(input_size), max ~64 for any practical input.
// Pre-allocating eliminates GC pressure in the hot path.
// ═══════════════════════════════════════════════════════════════

const CV_POOL = new Uint32Array(64 * 8); // 64 CVs for tree stack
const CV_VIEWS: Uint32Array[] = [];
for (let i = 0; i < 64; i++) {
  CV_VIEWS.push(CV_POOL.subarray(i * 8, i * 8 + 8));
}

const TEMP_CVS = [
  // Receive 4 CVs from compress4
  new Uint32Array(8),
  new Uint32Array(8),
  new Uint32Array(8),
  new Uint32Array(8),
];

const TEMP_LEFT = new Uint32Array(8); // Parent merge scratch
const TEMP_RIGHT = new Uint32Array(8);

/**
 * Runtime WASM bytecode emitter.
 *
 * Generates WASM at startup rather than shipping a .wasm file.
 * This adds ~1ms init time but keeps the library self-contained.
 * Each method emits raw instruction bytes to the code array.
 */
class W {
  c: number[] = [];

  emit(...b: number[]) {
    this.c.push(...b);
  }
  get(i: number) {
    this.emit(0x20, i);
  } // local.get
  set(i: number) {
    this.emit(0x21, i);
  } // local.set
  tee(i: number) {
    this.emit(0x22, i);
  } // local.tee

  // i32.const with signed LEB128 encoding
  i32c(v: number) {
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

  i32add() {
    this.emit(0x6a);
  }
  i32sub() {
    this.emit(0x6b);
  }
  i32mul() {
    this.emit(0x6c);
  }
  i32divu() {
    this.emit(0x6d);
  }
  i32or() {
    this.emit(0x72);
  }
  i32eq() {
    this.emit(0x46);
  }
  i32ltu() {
    this.emit(0x49);
  }

  i32ld(off: number) {
    this.emit(0x28, 0x02);
    this.uleb(off);
  }
  i32st(off: number) {
    this.emit(0x36, 0x02);
    this.uleb(off);
  }

  v128c(a: number, b: number, c: number, d: number) {
    this.emit(0xfd, 0x0c);
    for (const v of [a, b, c, d])
      this.emit(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  }

  v128ld(off: number) {
    this.emit(0xfd, 0x00, 0x04);
    this.uleb(off);
  }
  v128st(off: number) {
    this.emit(0xfd, 0x0b, 0x04);
    this.uleb(off);
  }
  v128xor() {
    this.emit(0xfd, 0x51);
  }
  v128or() {
    this.emit(0xfd, 0x50);
  }
  i32x4add() {
    this.emit(0xfd, 0xae, 0x01);
  }
  i32x4shl() {
    this.emit(0xfd, 0xab, 0x01);
  }
  i32x4shru() {
    this.emit(0xfd, 0xad, 0x01);
  }
  shuffle(idx: number[]) {
    this.emit(0xfd, 0x0d, ...idx);
  }
  i32x4splat() {
    this.emit(0xfd, 0x11);
  }
  i32x4replace(l: number) {
    this.emit(0xfd, 0x1c, l);
  }
  i32x4extract(l: number) {
    this.emit(0xfd, 0x1b, l);
  }

  block(f: () => void) {
    this.emit(0x02, 0x40);
    f();
    this.emit(0x0b);
  }
  loop(f: () => void) {
    this.emit(0x03, 0x40);
    f();
    this.emit(0x0b);
  }
  brif(d: number) {
    this.emit(0x0d, d);
  }
  ifthen(f: () => void) {
    this.emit(0x04, 0x40);
    f();
    this.emit(0x0b);
  }
  end() {
    this.emit(0x0b);
  }

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
 * Build compress4: process 4 full chunks in parallel.
 *
 * This is the hot function. Each SIMD lane processes one chunk's state.
 * We use 16 v128 locals for the full 16-word state, plus 2 for message temps.
 *
 * The G function works on all 4 chunks at once:
 *   G4(0, 4, 8, 12) operates on:
 *     - chunk0's (s0, s4, s8, s12)
 *     - chunk1's (s0, s4, s8, s12)
 *     - chunk2's (s0, s4, s8, s12)
 *     - chunk3's (s0, s4, s8, s12)
 *   all in parallel across the 4 lanes of each v128.
 *
 * Input:  4 chunks at mem[0:4096], counters at mem[4096:4128]
 * Output: 4 CVs at mem[4160:4288]
 */
function buildCompress4(): number[] {
  const w = new W();

  // 16 state vectors (S0-S15), 2 message temps, 1 block counter, 1 address temp
  const S: number[] = [];
  for (let i = 0; i < 16; i++) S.push(i);
  const MX = 16,
    MY = 17;
  const BIDX = 18; // i32: block index (0-15)
  const ADDR = 19; // i32: temp address for message gather

  // Initialize state for all 4 chunks: CV = IV (splatted to all lanes)
  for (let i = 0; i < 8; i++) {
    w.i32c(IV[i]);
    w.i32x4splat();
    w.set(S[i]);
  }

  w.i32c(0);
  w.set(BIDX);

  // Process 16 blocks per chunk
  w.block(() => {
    w.loop(() => {
      // Reset S[8-11] to IV (these are constant across compressions)
      for (let i = 0; i < 4; i++) {
        w.i32c(IV[i]);
        w.i32x4splat();
        w.set(S[8 + i]);
      }

      /**
       * S[12] = counter_lo for each chunk
       *
       * We load 4 different counter values (one per chunk) and pack them
       * into the 4 lanes of S[12].
       *
       * Memory layout: [cnt0_lo, cnt0_hi, cnt1_lo, cnt1_hi, cnt2_lo, cnt2_hi, cnt3_lo, cnt3_hi]
       */
      w.i32c(OFF_COUNTERS);
      w.i32ld(0);
      w.i32x4splat();
      w.i32c(OFF_COUNTERS);
      w.i32ld(8);
      w.i32x4replace(1);
      w.i32c(OFF_COUNTERS);
      w.i32ld(16);
      w.i32x4replace(2);
      w.i32c(OFF_COUNTERS);
      w.i32ld(24);
      w.i32x4replace(3);
      w.set(S[12]);

      // S[13] = counter_hi for each chunk
      w.i32c(OFF_COUNTERS);
      w.i32ld(4);
      w.i32x4splat();
      w.i32c(OFF_COUNTERS);
      w.i32ld(12);
      w.i32x4replace(1);
      w.i32c(OFF_COUNTERS);
      w.i32ld(20);
      w.i32x4replace(2);
      w.i32c(OFF_COUNTERS);
      w.i32ld(28);
      w.i32x4replace(3);
      w.set(S[13]);

      // S[14] = blockLen = 64 (same for all chunks)
      w.i32c(64);
      w.i32x4splat();
      w.set(S[14]);

      // S[15] = flags: CHUNK_START if block 0, CHUNK_END | extra if block 15
      w.i32c(0);
      w.i32x4splat();
      w.set(S[15]);
      w.get(BIDX);
      w.i32c(0);
      w.i32eq();
      w.ifthen(() => {
        w.i32c(CHUNK_START);
        w.i32x4splat();
        w.set(S[15]);
      });
      w.get(BIDX);
      w.i32c(15);
      w.i32eq();
      w.ifthen(() => {
        w.get(S[15]);
        w.i32c(CHUNK_END);
        w.i32x4splat();
        w.v128or();
        // Add extraFlags (e.g., ROOT for single-chunk inputs)
        w.i32c(OFF_META);
        w.i32ld(4);
        w.i32x4splat();
        w.v128or();
        w.set(S[15]);
      });

      /**
       * Gather message word w from 4 chunks (TRANSPOSED).
       *
       * Input memory is pre-transposed in JS:
       * [Word0_C0, Word0_C1, Word0_C2, Word0_C3] ... [Word1_C0...]
       *
       * So we just load a v128 from:
       * Offset = (blockIdx * 16 + wordIdx) * 16 bytes
       */
      const gatherMsg = (wordIdx: number, dst: number) => {
        w.get(BIDX);
        w.i32c(256); // 16 words * 16 bytes/vec = 256 bytes per block
        w.i32mul();
        w.i32c(wordIdx * 16); // 16 bytes per word vector
        w.i32add();
        w.v128ld(0); // Load directly from transposed buffer
        w.set(dst);
      };

      /**
       * G function for all 4 chunks in parallel.
       *
       * Standard BLAKE3 quarter-round:
       *   a = a + b + mx
       *   d = rotr(d ^ a, 16)
       *   c = c + d
       *   b = rotr(b ^ c, 12)
       *   a = a + b + my
       *   d = rotr(d ^ a, 8)
       *   c = c + d
       *   b = rotr(b ^ c, 7)
       *
       * Each operation works on all 4 chunks at once via SIMD.
       */
      const G4 = (
        a: number,
        b: number,
        c: number,
        d: number,
        mx: number,
        my: number
      ) => {
        // a = a + b + mx
        w.get(S[a]);
        w.get(S[b]);
        w.i32x4add();
        w.get(mx);
        w.i32x4add();
        w.set(S[a]);

        // d = rotr(d ^ a, 16) using byte shuffle
        w.get(S[d]);
        w.get(S[a]);
        w.v128xor();
        w.tee(S[d]);
        w.get(S[d]);
        w.shuffle(ROTR16);
        w.set(S[d]);

        // c = c + d
        w.get(S[c]);
        w.get(S[d]);
        w.i32x4add();
        w.set(S[c]);

        // b = rotr(b ^ c, 12) using shift+or
        w.get(S[b]);
        w.get(S[c]);
        w.v128xor();
        w.tee(S[b]);
        w.i32c(12);
        w.i32x4shru();
        w.get(S[b]);
        w.i32c(20);
        w.i32x4shl();
        w.v128or();
        w.set(S[b]);

        // a = a + b + my
        w.get(S[a]);
        w.get(S[b]);
        w.i32x4add();
        w.get(my);
        w.i32x4add();
        w.set(S[a]);

        // d = rotr(d ^ a, 8) using byte shuffle
        w.get(S[d]);
        w.get(S[a]);
        w.v128xor();
        w.tee(S[d]);
        w.get(S[d]);
        w.shuffle(ROTR8);
        w.set(S[d]);

        // c = c + d
        w.get(S[c]);
        w.get(S[d]);
        w.i32x4add();
        w.set(S[c]);

        // b = rotr(b ^ c, 7) using shift+or
        w.get(S[b]);
        w.get(S[c]);
        w.v128xor();
        w.tee(S[b]);
        w.i32c(7);
        w.i32x4shru();
        w.get(S[b]);
        w.i32c(25);
        w.i32x4shl();
        w.v128or();
        w.set(S[b]);
      };

      // 7 compression rounds
      for (let r = 0; r < 7; r++) {
        const [colMx, colMy, diagMx, diagMy] = SCHED[r];

        // Column round: G on (0,4,8,12), (1,5,9,13), (2,6,10,14), (3,7,11,15)
        gatherMsg(colMx[0], MX);
        gatherMsg(colMy[0], MY);
        G4(0, 4, 8, 12, MX, MY);
        gatherMsg(colMx[1], MX);
        gatherMsg(colMy[1], MY);
        G4(1, 5, 9, 13, MX, MY);
        gatherMsg(colMx[2], MX);
        gatherMsg(colMy[2], MY);
        G4(2, 6, 10, 14, MX, MY);
        gatherMsg(colMx[3], MX);
        gatherMsg(colMy[3], MY);
        G4(3, 7, 11, 15, MX, MY);

        // Diagonal round: G on (0,5,10,15), (1,6,11,12), (2,7,8,13), (3,4,9,14)
        gatherMsg(diagMx[0], MX);
        gatherMsg(diagMy[0], MY);
        G4(0, 5, 10, 15, MX, MY);
        gatherMsg(diagMx[1], MX);
        gatherMsg(diagMy[1], MY);
        G4(1, 6, 11, 12, MX, MY);
        gatherMsg(diagMx[2], MX);
        gatherMsg(diagMy[2], MY);
        G4(2, 7, 8, 13, MX, MY);
        gatherMsg(diagMx[3], MX);
        gatherMsg(diagMy[3], MY);
        G4(3, 4, 9, 14, MX, MY);
      }

      // Feed-forward: new_cv[i] = state[i] ^ state[i+8]
      for (let i = 0; i < 8; i++) {
        w.get(S[i]);
        w.get(S[i + 8]);
        w.v128xor();
        w.set(S[i]);
      }

      // Next block
      w.get(BIDX);
      w.i32c(1);
      w.i32add();
      w.set(BIDX);
      w.get(BIDX);
      w.i32c(16);
      w.i32ltu();
      w.brif(0);
    });
  });

  /**
   * Extract and store 4 CVs by deinterleaving.
   *
   * Currently S[i] = [c0.cv[i], c1.cv[i], c2.cv[i], c3.cv[i]]
   *
   * We need to reorganize to:
   *   mem[OFF_CVS+0..31]   = c0.cv[0..7]
   *   mem[OFF_CVS+32..63]  = c1.cv[0..7]
   *   mem[OFF_CVS+64..95]  = c2.cv[0..7]
   *   mem[OFF_CVS+96..127] = c3.cv[0..7]
   *
   * We extract lane c from S[0..7] and pack them into a v128 for each chunk.
   */
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 8; i += 4) {
      w.i32c(OFF_CVS + c * 32 + i * 4);
      w.get(S[i]);
      w.i32x4extract(c);
      w.i32x4splat();
      w.get(S[i + 1]);
      w.i32x4extract(c);
      w.i32x4replace(1);
      w.get(S[i + 2]);
      w.i32x4extract(c);
      w.i32x4replace(2);
      w.get(S[i + 3]);
      w.i32x4extract(c);
      w.i32x4replace(3);
      w.v128st(0);
    }
  }

  w.end();
  return w.c;
}

/**
 * Build compress1: process a single full chunk.
 *
 * Used when we have 1-3 remaining chunks that can't fill a 4-way batch.
 * Uses row-parallel SIMD like simd-fast.ts.
 */
function buildCompress1(): number[] {
  const w = new W();

  const S: number[] = [];
  for (let i = 0; i < 16; i++) S.push(i);
  const MX = 16,
    MY = 17;
  const CV0 = 18,
    CV1 = 19;
  const BIDX = 20,
    MSGPTR = 21,
    FLAGS = 22;

  // Initialize CV = IV
  w.v128c(IV[0], IV[1], IV[2], IV[3]);
  w.set(CV0);
  w.v128c(IV[4], IV[5], IV[6], IV[7]);
  w.set(CV1);

  w.i32c(0);
  w.set(BIDX);
  w.i32c(0);
  w.set(MSGPTR);

  w.block(() => {
    w.loop(() => {
      w.get(CV0);
      w.set(S[0]);
      w.get(CV1);
      w.set(S[1]);
      w.v128c(IV[0], IV[1], IV[2], IV[3]);
      w.set(S[2]);

      // Flags
      w.i32c(0);
      w.set(FLAGS);
      w.get(BIDX);
      w.i32c(0);
      w.i32eq();
      w.ifthen(() => {
        w.get(FLAGS);
        w.i32c(CHUNK_START);
        w.i32or();
        w.set(FLAGS);
      });
      w.get(BIDX);
      w.i32c(15);
      w.i32eq();
      w.ifthen(() => {
        w.get(FLAGS);
        w.i32c(CHUNK_END);
        w.i32or();
        w.i32c(OFF_META);
        w.i32ld(4);
        w.i32or();
        w.set(FLAGS);
      });

      // row3 = [counter_lo, counter_hi, 64, flags]
      w.i32c(OFF_COUNTERS);
      w.i32ld(0);
      w.i32x4splat();
      w.i32c(OFF_COUNTERS);
      w.i32ld(4);
      w.i32x4replace(1);
      w.i32c(64);
      w.i32x4replace(2);
      w.get(FLAGS);
      w.i32x4replace(3);
      w.set(S[3]);

      // Row-parallel message gathering
      const gatherRow = (
        i0: number,
        i1: number,
        i2: number,
        i3: number,
        dst: number
      ) => {
        w.get(MSGPTR);
        w.i32ld(i0 * 4);
        w.i32x4splat();
        w.get(MSGPTR);
        w.i32ld(i1 * 4);
        w.i32x4replace(1);
        w.get(MSGPTR);
        w.i32ld(i2 * 4);
        w.i32x4replace(2);
        w.get(MSGPTR);
        w.i32ld(i3 * 4);
        w.i32x4replace(3);
        w.set(dst);
      };

      const gHalf = (m: number, rot1: number, rot2: number) => {
        w.get(S[0]);
        w.get(S[1]);
        w.i32x4add();
        w.get(m);
        w.i32x4add();
        w.set(S[0]);
        w.get(S[3]);
        w.get(S[0]);
        w.v128xor();
        if (rot1 === 16) {
          w.tee(S[3]);
          w.get(S[3]);
          w.shuffle(ROTR16);
        } else {
          w.tee(S[3]);
          w.get(S[3]);
          w.shuffle(ROTR8);
        }
        w.set(S[3]);
        w.get(S[2]);
        w.get(S[3]);
        w.i32x4add();
        w.set(S[2]);
        w.get(S[1]);
        w.get(S[2]);
        w.v128xor();
        w.tee(S[1]);
        w.i32c(rot2);
        w.i32x4shru();
        w.get(S[1]);
        w.i32c(32 - rot2);
        w.i32x4shl();
        w.v128or();
        w.set(S[1]);
      };

      // Row rotation patterns for diagonal mixing
      const ROT1_L = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3];
      const ROT2_L = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];
      const ROT3_L = [12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      const ROT1_R = [12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      const ROT2_R = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];
      const ROT3_R = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3];

      const rotateDiag = () => {
        w.get(S[1]);
        w.get(S[1]);
        w.shuffle(ROT1_L);
        w.set(S[1]);
        w.get(S[2]);
        w.get(S[2]);
        w.shuffle(ROT2_L);
        w.set(S[2]);
        w.get(S[3]);
        w.get(S[3]);
        w.shuffle(ROT3_L);
        w.set(S[3]);
      };
      const unrotateDiag = () => {
        w.get(S[1]);
        w.get(S[1]);
        w.shuffle(ROT1_R);
        w.set(S[1]);
        w.get(S[2]);
        w.get(S[2]);
        w.shuffle(ROT2_R);
        w.set(S[2]);
        w.get(S[3]);
        w.get(S[3]);
        w.shuffle(ROT3_R);
        w.set(S[3]);
      };

      // 7 rounds
      for (let r = 0; r < 7; r++) {
        const [colMx, colMy, diagMx, diagMy] = SCHED[r];
        gatherRow(colMx[0], colMx[1], colMx[2], colMx[3], MX);
        gatherRow(colMy[0], colMy[1], colMy[2], colMy[3], MY);
        gHalf(MX, 16, 12);
        gHalf(MY, 8, 7);
        rotateDiag();
        gatherRow(diagMx[0], diagMx[1], diagMx[2], diagMx[3], MX);
        gatherRow(diagMy[0], diagMy[1], diagMy[2], diagMy[3], MY);
        gHalf(MX, 16, 12);
        gHalf(MY, 8, 7);
        unrotateDiag();
      }

      // Feed-forward
      w.get(S[0]);
      w.get(S[2]);
      w.v128xor();
      w.set(CV0);
      w.get(S[1]);
      w.get(S[3]);
      w.v128xor();
      w.set(CV1);

      // Next block
      w.get(BIDX);
      w.i32c(1);
      w.i32add();
      w.set(BIDX);
      w.get(MSGPTR);
      w.i32c(64);
      w.i32add();
      w.set(MSGPTR);

      w.get(BIDX);
      w.i32c(16);
      w.i32ltu();
      w.brif(0);
    });
  });

  // Store output
  w.i32c(OFF_CVS);
  w.get(CV0);
  w.v128st(0);
  w.i32c(OFF_CVS);
  w.get(CV1);
  w.v128st(16);

  w.end();
  return w.c;
}

/**
 * Build parent: merge two child CVs into a parent CV.
 *
 * Input:  Two CVs concatenated at OFF_SCRATCH (64 bytes)
 * Output: Parent CV at OFF_CVS
 */
function buildParent(): number[] {
  const w = new W();

  const S0 = 0,
    S1 = 1,
    S2 = 2,
    S3 = 3,
    MX = 4,
    MY = 5;

  // Initialize: CV = IV
  w.v128c(IV[0], IV[1], IV[2], IV[3]);
  w.set(S0);
  w.v128c(IV[4], IV[5], IV[6], IV[7]);
  w.set(S1);
  w.v128c(IV[0], IV[1], IV[2], IV[3]);
  w.set(S2);

  // row3 = [0, 0, 64, PARENT | flags]
  w.i32c(0);
  w.i32x4splat();
  w.i32c(64);
  w.i32x4replace(2);
  w.i32c(OFF_META);
  w.i32ld(4);
  w.i32c(PARENT);
  w.i32or();
  w.i32x4replace(3);
  w.set(S3);

  // Message from OFF_SCRATCH (two CVs concatenated)
  const gatherRow = (
    i0: number,
    i1: number,
    i2: number,
    i3: number,
    dst: number
  ) => {
    w.i32c(OFF_SCRATCH);
    w.i32ld(i0 * 4);
    w.i32x4splat();
    w.i32c(OFF_SCRATCH);
    w.i32ld(i1 * 4);
    w.i32x4replace(1);
    w.i32c(OFF_SCRATCH);
    w.i32ld(i2 * 4);
    w.i32x4replace(2);
    w.i32c(OFF_SCRATCH);
    w.i32ld(i3 * 4);
    w.i32x4replace(3);
    w.set(dst);
  };

  const gHalf = (m: number, rot1: number, rot2: number) => {
    w.get(S0);
    w.get(S1);
    w.i32x4add();
    w.get(m);
    w.i32x4add();
    w.set(S0);
    w.get(S3);
    w.get(S0);
    w.v128xor();
    if (rot1 === 16) {
      w.tee(S3);
      w.get(S3);
      w.shuffle(ROTR16);
    } else {
      w.tee(S3);
      w.get(S3);
      w.shuffle(ROTR8);
    }
    w.set(S3);
    w.get(S2);
    w.get(S3);
    w.i32x4add();
    w.set(S2);
    w.get(S1);
    w.get(S2);
    w.v128xor();
    w.tee(S1);
    w.i32c(rot2);
    w.i32x4shru();
    w.get(S1);
    w.i32c(32 - rot2);
    w.i32x4shl();
    w.v128or();
    w.set(S1);
  };

  const ROT1_L = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3];
  const ROT2_L = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];
  const ROT3_L = [12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const ROT1_R = [12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const ROT2_R = [8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7];
  const ROT3_R = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3];

  const rotateDiag = () => {
    w.get(S1);
    w.get(S1);
    w.shuffle(ROT1_L);
    w.set(S1);
    w.get(S2);
    w.get(S2);
    w.shuffle(ROT2_L);
    w.set(S2);
    w.get(S3);
    w.get(S3);
    w.shuffle(ROT3_L);
    w.set(S3);
  };
  const unrotateDiag = () => {
    w.get(S1);
    w.get(S1);
    w.shuffle(ROT1_R);
    w.set(S1);
    w.get(S2);
    w.get(S2);
    w.shuffle(ROT2_R);
    w.set(S2);
    w.get(S3);
    w.get(S3);
    w.shuffle(ROT3_R);
    w.set(S3);
  };

  for (let r = 0; r < 7; r++) {
    const [colMx, colMy, diagMx, diagMy] = SCHED[r];
    gatherRow(colMx[0], colMx[1], colMx[2], colMx[3], MX);
    gatherRow(colMy[0], colMy[1], colMy[2], colMy[3], MY);
    gHalf(MX, 16, 12);
    gHalf(MY, 8, 7);
    rotateDiag();
    gatherRow(diagMx[0], diagMx[1], diagMx[2], diagMx[3], MX);
    gatherRow(diagMy[0], diagMy[1], diagMy[2], diagMy[3], MY);
    gHalf(MX, 16, 12);
    gHalf(MY, 8, 7);
    unrotateDiag();
  }

  // Store result
  w.i32c(OFF_CVS);
  w.get(S0);
  w.get(S2);
  w.v128xor();
  w.v128st(0);
  w.i32c(OFF_CVS);
  w.get(S1);
  w.get(S3);
  w.v128xor();
  w.v128st(16);

  w.end();
  return w.c;
}

/** Build the complete WASM module. */
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

  // Type: () -> ()
  section(0x01, [0x01, 0x60, 0x00, 0x00]);

  // Functions: 3
  section(0x03, [0x03, 0x00, 0x00, 0x00]);

  // Memory: 1 page (64KB)
  section(0x05, [0x01, 0x00, 0x01]);

  // Exports
  const exports: number[] = [0x04];
  const addExp = (name: string, kind: number, idx: number) => {
    exports.push(
      name.length,
      ...Array.from(name).map((c) => c.charCodeAt(0)),
      kind,
      idx
    );
  };
  addExp("compress4", 0x00, 0);
  addExp("compress1", 0x00, 1);
  addExp("parent", 0x00, 2);
  addExp("mem", 0x02, 0);
  section(0x07, exports);

  // Build function bodies
  const code4 = buildCompress4();
  const code1 = buildCompress1();
  const codeP = buildParent();

  const encodeFunc = (code: number[], nV128: number, nI32: number) => {
    const locals: number[] = [];
    let groups = 0;
    if (nV128 > 0) {
      locals.push(nV128, 0x7b);
      groups++;
    }
    if (nI32 > 0) {
      locals.push(nI32, 0x7f);
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

  const f0 = encodeFunc(code4, 18, 2); // compress4: 18 v128, 2 i32
  const f1 = encodeFunc(code1, 20, 3); // compress1: 20 v128, 3 i32
  const f2 = encodeFunc(codeP, 6, 0); // parent: 6 v128

  section(0x0a, [0x03, ...f0, ...f1, ...f2]);

  return new Uint8Array(mod);
}

// ============================================================================
// RUNTIME
// ============================================================================

let instance: WebAssembly.Instance | null = null;
let compress4Fn: (() => void) | null = null;
let compress1Fn: (() => void) | null = null;
let parentFn: (() => void) | null = null;
let mem: Uint8Array | null = null;
let mem32: Uint32Array | null = null;

/**
 * Transpose 4 chunks from interleaved to word-major layout.
 * Input: [Chunk0][Chunk1][Chunk2][Chunk3] (4KB total)
 * Output: [W0_C0,W0_C1,W0_C2,W0_C3][W1_C0,W1_C1,...]
 *
 * This allows WASM to load entire vectors with v128.load instead of
 * gathering from 4 separate memory locations.
 */
function transpose4Chunks(
  src32: Uint32Array,
  srcOffset: number,
  dst32: Uint32Array,
  dstOffset: number
): void {
  let s = srcOffset;
  let d = dstOffset;

  for (let i = 0; i < 64; i++) {
    dst32[d] = src32[s];
    dst32[d + 1] = src32[s + 256];
    dst32[d + 2] = src32[s + 512];
    dst32[d + 3] = src32[s + 768];

    dst32[d + 4] = src32[s + 1];
    dst32[d + 5] = src32[s + 257];
    dst32[d + 6] = src32[s + 513];
    dst32[d + 7] = src32[s + 769];

    dst32[d + 8] = src32[s + 2];
    dst32[d + 9] = src32[s + 258];
    dst32[d + 10] = src32[s + 514];
    dst32[d + 11] = src32[s + 770];

    dst32[d + 12] = src32[s + 3];
    dst32[d + 13] = src32[s + 259];
    dst32[d + 14] = src32[s + 515];
    dst32[d + 15] = src32[s + 771];

    d += 16;
    s += 4;
  }
}

function initWasm(): boolean {
  if (instance) return true;
  if (!SIMD_SUPPORTED) return false;
  try {
    const module = new WebAssembly.Module(generateModule() as BufferSource);
    instance = new WebAssembly.Instance(module);
    const wasmMem = instance.exports.mem as WebAssembly.Memory;
    compress4Fn = instance.exports.compress4 as () => void;
    compress1Fn = instance.exports.compress1 as () => void;
    parentFn = instance.exports.parent as () => void;
    mem = new Uint8Array(wasmMem.buffer);
    mem32 = new Uint32Array(wasmMem.buffer);
    return true;
  } catch (e) {
    console.warn("4-Fast SIMD init failed:", e);
    return false;
  }
}

/**
 * Process 4 full chunks in parallel (OPTIMIZED - no allocations).
 *
 * Uses number-based counters (safe for inputs up to 8 petabytes).
 * Writes results to TEMP_CVS to avoid array allocation.
 */
function process4Fast(
  input: Uint8Array,
  inputOffset: number,
  counter: number,
  extraFlags: number = 0
): void {
  // Transpose 4 chunks for efficient SIMD gather
  const inputBase = inputOffset + (input.byteOffset || 0);
  if (inputBase % 4 === 0) {
    // Aligned: create view directly
    const src32 = new Uint32Array(input.buffer, inputBase, CHUNK_LEN);
    transpose4Chunks(src32, 0, mem32!, OFF_CHUNKS / 4);
  } else {
    // Unaligned: copy to temp buffer first
    const tmp = new Uint8Array(4 * CHUNK_LEN);
    tmp.set(input.subarray(inputOffset, inputOffset + 4 * CHUNK_LEN));
    const src32 = new Uint32Array(tmp.buffer);
    transpose4Chunks(src32, 0, mem32!, OFF_CHUNKS / 4);
  }

  // Set counters (number-based, no bigint)
  const counterBase = OFF_COUNTERS / 4;
  mem32![counterBase] = counter;
  mem32![counterBase + 1] = 0;
  mem32![counterBase + 2] = counter + 1;
  mem32![counterBase + 3] = 0;
  mem32![counterBase + 4] = counter + 2;
  mem32![counterBase + 5] = 0;
  mem32![counterBase + 6] = counter + 3;
  mem32![counterBase + 7] = 0;

  mem32![OFF_META / 4 + 1] = extraFlags;

  compress4Fn!();

  // Copy to temp CVs (no allocation, reuse buffers)
  TEMP_CVS[0].set(new Uint32Array(mem32!.buffer, OFF_CVS, 8));
  TEMP_CVS[1].set(new Uint32Array(mem32!.buffer, OFF_CVS + 32, 8));
  TEMP_CVS[2].set(new Uint32Array(mem32!.buffer, OFF_CVS + 64, 8));
  TEMP_CVS[3].set(new Uint32Array(mem32!.buffer, OFF_CVS + 96, 8));
}

// Scratch buffer for process4 transposition
const PROCESS4_SCRATCH = new Uint8Array(4 * CHUNK_LEN);
const PROCESS4_SCRATCH32 = new Uint32Array(PROCESS4_SCRATCH.buffer);

/** Process 4 full chunks in parallel. Returns 4 CVs (legacy API). */
function process4(
  c0: Uint8Array,
  c1: Uint8Array,
  c2: Uint8Array,
  c3: Uint8Array,
  cnt0: bigint,
  cnt1: bigint,
  cnt2: bigint,
  cnt3: bigint,
  extraFlags: number = 0
): Uint32Array[] {
  // Copy to scratch buffer, then transpose
  PROCESS4_SCRATCH.set(c0, 0);
  PROCESS4_SCRATCH.set(c1, 1024);
  PROCESS4_SCRATCH.set(c2, 2048);
  PROCESS4_SCRATCH.set(c3, 3072);
  transpose4Chunks(PROCESS4_SCRATCH32, 0, mem32!, OFF_CHUNKS / 4);

  mem32![OFF_COUNTERS / 4] = Number(cnt0 & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 1] = Number((cnt0 >> 32n) & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 2] = Number(cnt1 & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 3] = Number((cnt1 >> 32n) & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 4] = Number(cnt2 & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 5] = Number((cnt2 >> 32n) & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 6] = Number(cnt3 & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 7] = Number((cnt3 >> 32n) & 0xffffffffn);

  mem32![OFF_META / 4 + 1] = extraFlags;

  compress4Fn!();

  return [
    new Uint32Array(mem32!.buffer, OFF_CVS, 8).slice(),
    new Uint32Array(mem32!.buffer, OFF_CVS + 32, 8).slice(),
    new Uint32Array(mem32!.buffer, OFF_CVS + 64, 8).slice(),
    new Uint32Array(mem32!.buffer, OFF_CVS + 96, 8).slice(),
  ];
}

/**
 * Process 1 full chunk (OPTIMIZED - writes to dest buffer).
 */
function process1Fast(
  input: Uint8Array,
  inputOffset: number,
  counter: number,
  extraFlags: number,
  dest: Uint32Array
): void {
  mem!.set(input.subarray(inputOffset, inputOffset + CHUNK_LEN), OFF_CHUNKS);
  mem32![OFF_COUNTERS / 4] = counter;
  mem32![OFF_COUNTERS / 4 + 1] = 0;
  mem32![OFF_META / 4 + 1] = extraFlags;
  compress1Fn!();
  dest.set(new Uint32Array(mem32!.buffer, OFF_CVS, 8));
}

/** Process 1 full chunk (legacy API). */
function process1(
  chunk: Uint8Array,
  counter: bigint,
  extraFlags: number = 0
): Uint32Array {
  mem!.fill(0, OFF_CHUNKS, OFF_CHUNKS + CHUNK_LEN);
  mem!.set(chunk, OFF_CHUNKS);
  mem32![OFF_COUNTERS / 4] = Number(counter & 0xffffffffn);
  mem32![OFF_COUNTERS / 4 + 1] = Number((counter >> 32n) & 0xffffffffn);
  mem32![OFF_META / 4 + 1] = extraFlags;
  compress1Fn!();
  return new Uint32Array(mem32!.buffer, OFF_CVS, 8).slice();
}

/**
 * Process partial chunk (< 1024 bytes) using JS compress.
 * Handles variable block counts correctly.
 */
function processPartialChunk(
  chunk: Uint8Array,
  counter: bigint,
  extraFlags: number = 0
): Uint32Array {
  const cv = new Uint32Array(IV);
  const numBlocks = Math.ceil(chunk.length / BLOCK_LEN) || 1;

  for (let b = 0; b < numBlocks; b++) {
    const blockStart = b * BLOCK_LEN;
    const blockEnd = Math.min(blockStart + BLOCK_LEN, chunk.length);
    const blockLen = blockEnd - blockStart;

    // Prepare block in memory
    mem!.fill(0, OFF_SCRATCH, OFF_SCRATCH + BLOCK_LEN);
    if (blockLen > 0) {
      mem!.set(chunk.subarray(blockStart, blockEnd), OFF_SCRATCH);
    }

    let flags = 0;
    if (b === 0) flags |= CHUNK_START;
    if (b === numBlocks - 1) {
      flags |= CHUNK_END;
      flags |= extraFlags;
    }

    // Use JS compress for partial blocks
    const state = compressBlockJS(
      cv,
      mem!.subarray(OFF_SCRATCH, OFF_SCRATCH + BLOCK_LEN),
      counter,
      blockLen,
      flags
    );
    cv.set(state.subarray(0, 8));
  }
  return cv;
}

/**
 * Pure JS single-block compress (fallback for partial chunks).
 * Same algorithm as the WASM version, just in JS.
 */
function compressBlockJS(
  cv: Uint32Array,
  block: Uint8Array,
  counter: bigint,
  blockLen: number,
  flags: number
): Uint32Array {
  const m = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    m[i] =
      block[i * 4] |
      (block[i * 4 + 1] << 8) |
      (block[i * 4 + 2] << 16) |
      (block[i * 4 + 3] << 24);
  }

  const s = new Uint32Array([
    cv[0],
    cv[1],
    cv[2],
    cv[3],
    cv[4],
    cv[5],
    cv[6],
    cv[7],
    IV[0],
    IV[1],
    IV[2],
    IV[3],
    Number(counter & 0xffffffffn),
    Number((counter >> 32n) & 0xffffffffn),
    blockLen,
    flags,
  ]);

  const schedules = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8],
    [3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1],
    [10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6],
    [12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4],
    [9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7],
    [11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13],
  ];

  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

  const g = (
    a: number,
    b: number,
    c: number,
    d: number,
    mx: number,
    my: number
  ) => {
    s[a] = (s[a] + s[b] + mx) >>> 0;
    s[d] = rotr(s[d] ^ s[a], 16);
    s[c] = (s[c] + s[d]) >>> 0;
    s[b] = rotr(s[b] ^ s[c], 12);
    s[a] = (s[a] + s[b] + my) >>> 0;
    s[d] = rotr(s[d] ^ s[a], 8);
    s[c] = (s[c] + s[d]) >>> 0;
    s[b] = rotr(s[b] ^ s[c], 7);
  };

  for (let round = 0; round < 7; round++) {
    const sched = schedules[round];
    g(0, 4, 8, 12, m[sched[0]], m[sched[1]]);
    g(1, 5, 9, 13, m[sched[2]], m[sched[3]]);
    g(2, 6, 10, 14, m[sched[4]], m[sched[5]]);
    g(3, 7, 11, 15, m[sched[6]], m[sched[7]]);
    g(0, 5, 10, 15, m[sched[8]], m[sched[9]]);
    g(1, 6, 11, 12, m[sched[10]], m[sched[11]]);
    g(2, 7, 8, 13, m[sched[12]], m[sched[13]]);
    g(3, 4, 9, 14, m[sched[14]], m[sched[15]]);
  }

  for (let i = 0; i < 8; i++) {
    s[i] ^= s[i + 8];
  }

  return s;
}

/**
 * Merge two child CVs (OPTIMIZED - writes to dest buffer).
 */
function computeParentFast(
  left: Uint32Array,
  right: Uint32Array,
  flags: number,
  dest: Uint32Array
): void {
  const base = OFF_SCRATCH / 4;
  for (let i = 0; i < 8; i++) {
    mem32![base + i] = left[i];
    mem32![base + 8 + i] = right[i];
  }
  mem32![OFF_META / 4 + 1] = flags;
  parentFn!();
  dest.set(new Uint32Array(mem32!.buffer, OFF_CVS, 8));
}

/** Merge two child CVs into a parent CV (legacy API). */
function computeParent(
  left: Uint32Array,
  right: Uint32Array,
  flags: number
): Uint32Array {
  for (let i = 0; i < 8; i++) {
    mem32![OFF_SCRATCH / 4 + i] = left[i];
    mem32![OFF_SCRATCH / 4 + 8 + i] = right[i];
  }
  mem32![OFF_META / 4 + 1] = flags;
  parentFn!();
  return new Uint32Array(mem32!.buffer, OFF_CVS, 8).slice();
}

function cvToBytes(cv: Uint32Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (cv[i >>> 2] >>> ((i & 3) << 3)) & 0xff;
  }
  return out;
}

/**
 * BLAKE3 hash with 4-way parallel SIMD.
 *
 * Strategy:
 *   - Empty/small inputs: JS compress with proper partial handling
 *   - 1-3 full chunks: WASM single-chunk compress
 *   - 4+ chunks: 4-way parallel WASM (the fast path)
 */
export function hash(input: Uint8Array, outLen: number = OUT_LEN): Uint8Array {
  if (!initWasm()) {
    throw new Error("4-Fast SIMD not available");
  }

  // Empty input
  if (input.length === 0) {
    const cv = processPartialChunk(new Uint8Array(0), 0n, ROOT);
    return cvToBytes(cv, outLen);
  }

  // Single chunk
  if (input.length <= CHUNK_LEN) {
    if (input.length === CHUNK_LEN) {
      const cv = process1(input, 0n, ROOT);
      return cvToBytes(cv, outLen);
    } else {
      const cv = processPartialChunk(input, 0n, ROOT);
      return cvToBytes(cv, outLen);
    }
  }

  // Multi-chunk: Merkle tree construction
  const cvStack: Uint32Array[] = [];
  const totalChunks = Math.ceil(input.length / CHUNK_LEN);
  let chunkCounter = 0n;
  let pos = 0;

  // Process in batches of 4 full chunks (the fast path)
  while (pos + 4 * CHUNK_LEN <= input.length) {
    const cvs = process4(
      input.subarray(pos, pos + CHUNK_LEN),
      input.subarray(pos + CHUNK_LEN, pos + 2 * CHUNK_LEN),
      input.subarray(pos + 2 * CHUNK_LEN, pos + 3 * CHUNK_LEN),
      input.subarray(pos + 3 * CHUNK_LEN, pos + 4 * CHUNK_LEN),
      chunkCounter,
      chunkCounter + 1n,
      chunkCounter + 2n,
      chunkCounter + 3n
    );

    for (let i = 0; i < 4; i++) {
      cvStack.push(cvs[i]);
      chunkCounter++;

      // Merge parents based on trailing zeros (standard BLAKE3 tree merge)
      const isLast = Number(chunkCounter) === totalChunks;
      let merge = ctz64(chunkCounter);
      while (merge > 0 && cvStack.length >= 2) {
        if (isLast && cvStack.length === 2) break;
        const r = cvStack.pop()!,
          l = cvStack.pop()!;
        cvStack.push(computeParent(l, r, 0));
        merge--;
      }
    }
    pos += 4 * CHUNK_LEN;
  }

  // Remaining full chunks (1-3)
  while (pos + CHUNK_LEN <= input.length) {
    cvStack.push(process1(input.subarray(pos, pos + CHUNK_LEN), chunkCounter));
    chunkCounter++;

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
    const partial = input.subarray(pos);
    cvStack.push(processPartialChunk(partial, chunkCounter, 0));
  }

  // Final merges with ROOT flag on the last one
  while (cvStack.length > 1) {
    const r = cvStack.pop()!,
      l = cvStack.pop()!;
    const flags = cvStack.length === 0 ? ROOT : 0;
    cvStack.push(computeParent(l, r, flags));
  }

  return cvToBytes(cvStack[0], outLen);
}

/**
 * Zero-allocation variant (~1.09 GB/s).
 *
 * Same algorithm as hash(), but eliminates per-call allocations:
 * - CV stack uses pre-allocated views instead of .slice()
 * - Counters use JS numbers (safe to 2^53 chunks = 8 petabytes)
 */
export function hashFast(
  input: Uint8Array,
  outLen: number = OUT_LEN
): Uint8Array {
  if (!initWasm()) {
    throw new Error("4-Fast SIMD not available");
  }

  // Empty input
  if (input.length === 0) {
    const cv = processPartialChunk(new Uint8Array(0), 0n, ROOT);
    return cvToBytes(cv, outLen);
  }

  // Single chunk
  if (input.length <= CHUNK_LEN) {
    if (input.length === CHUNK_LEN) {
      process1Fast(input, 0, 0, ROOT, CV_VIEWS[0]);
      return cvToBytes(CV_VIEWS[0], outLen);
    } else {
      const cv = processPartialChunk(input, 0n, ROOT);
      return cvToBytes(cv, outLen);
    }
  }

  // Multi-chunk with optimized processing
  const totalChunks = Math.ceil(input.length / CHUNK_LEN);
  let cvStackLen = 0;
  let chunkCounter = 0;
  let pos = 0;

  // Fast path: process 4 chunks at a time
  while (pos + 4 * CHUNK_LEN <= input.length) {
    // Single copy of 4KB, process all 4 chunks
    process4Fast(input, pos, chunkCounter, 0);

    // Push 4 CVs and merge
    for (let i = 0; i < 4; i++) {
      CV_VIEWS[cvStackLen].set(TEMP_CVS[i]);
      cvStackLen++;
      chunkCounter++;

      // Merge parents based on trailing zeros
      const isLast = chunkCounter === totalChunks;
      let merge = ctz32(chunkCounter);
      while (merge > 0 && cvStackLen >= 2) {
        if (isLast && cvStackLen === 2) break;
        cvStackLen--;
        TEMP_RIGHT.set(CV_VIEWS[cvStackLen]);
        cvStackLen--;
        TEMP_LEFT.set(CV_VIEWS[cvStackLen]);
        computeParentFast(TEMP_LEFT, TEMP_RIGHT, 0, CV_VIEWS[cvStackLen]);
        cvStackLen++;
        merge--;
      }
    }
    pos += 4 * CHUNK_LEN;
  }

  // Remaining full chunks (1-3)
  while (pos + CHUNK_LEN <= input.length) {
    process1Fast(input, pos, chunkCounter, 0, CV_VIEWS[cvStackLen]);
    cvStackLen++;
    chunkCounter++;

    const isLast = chunkCounter === totalChunks;
    let merge = ctz32(chunkCounter);
    while (merge > 0 && cvStackLen >= 2) {
      if (isLast && cvStackLen === 2) break;
      cvStackLen--;
      TEMP_RIGHT.set(CV_VIEWS[cvStackLen]);
      cvStackLen--;
      TEMP_LEFT.set(CV_VIEWS[cvStackLen]);
      computeParentFast(TEMP_LEFT, TEMP_RIGHT, 0, CV_VIEWS[cvStackLen]);
      cvStackLen++;
      merge--;
    }
    pos += CHUNK_LEN;
  }

  // Final partial chunk
  if (pos < input.length) {
    const partial = input.subarray(pos);
    const cv = processPartialChunk(partial, BigInt(chunkCounter), 0);
    CV_VIEWS[cvStackLen].set(cv);
    cvStackLen++;
  }

  // Final merges with ROOT flag
  while (cvStackLen > 1) {
    cvStackLen--;
    TEMP_RIGHT.set(CV_VIEWS[cvStackLen]);
    cvStackLen--;
    TEMP_LEFT.set(CV_VIEWS[cvStackLen]);
    const flags = cvStackLen === 0 ? ROOT : 0;
    computeParentFast(TEMP_LEFT, TEMP_RIGHT, flags, CV_VIEWS[cvStackLen]);
    cvStackLen++;
  }

  return cvToBytes(CV_VIEWS[0], outLen);
}

/**
 * Count trailing zeros via de Bruijn multiplication (O(1), branchless).
 *
 * The expression (n & -n) isolates the lowest set bit.
 * Multiplying by 0x077CB531 maps each power of 2 to a unique 5-bit index.
 */
const CTZ_TABLE = new Uint8Array([
  0, 1, 28, 2, 29, 14, 24, 3, 30, 22, 20, 15, 25, 17, 4, 8, 31, 27, 13, 23, 21,
  19, 16, 7, 26, 12, 18, 6, 11, 5, 10, 9,
]);
function ctz32(n: number): number {
  if (n === 0) return 32;
  return CTZ_TABLE[(((n & -n) * 0x077cb531) >>> 27) & 31];
}

// ═══════════════════════════════════════════════════════════════
// HYPER IMPLEMENTATION (~1.6 GB/s)
//
// Additional optimizations over hashFast():
// - Process 8 chunks per loop (two 4-way WASM calls)
// - Unrolled CV transfers (no loops, no views)
// - Pre-computed memory offsets (avoid repeated division)
// ═══════════════════════════════════════════════════════════════

const HYPER_CV_STACK = new Uint32Array(64 * 8); // Contiguous CV storage

// Pre-computed Uint32Array indices (avoid / 4 in hot path)
const SCRATCH_BASE = OFF_SCRATCH / 4;
const CVS_BASE = OFF_CVS / 4;
const META_FLAGS = OFF_META / 4 + 1;
const COUNTER_BASE = OFF_COUNTERS / 4;

/**
 * Compute parent CV from two children at stack positions.
 * Unrolled copy avoids TypedArray.set() overhead.
 */
function computeParentFromStack(
  leftIdx: number,
  rightIdx: number,
  flags: number,
  destIdx: number
): void {
  const leftOff = leftIdx * 8;
  const rightOff = rightIdx * 8;
  const destOff = destIdx * 8;

  // Copy CVs to scratch (unrolled for speed)
  mem32![SCRATCH_BASE] = HYPER_CV_STACK[leftOff];
  mem32![SCRATCH_BASE + 1] = HYPER_CV_STACK[leftOff + 1];
  mem32![SCRATCH_BASE + 2] = HYPER_CV_STACK[leftOff + 2];
  mem32![SCRATCH_BASE + 3] = HYPER_CV_STACK[leftOff + 3];
  mem32![SCRATCH_BASE + 4] = HYPER_CV_STACK[leftOff + 4];
  mem32![SCRATCH_BASE + 5] = HYPER_CV_STACK[leftOff + 5];
  mem32![SCRATCH_BASE + 6] = HYPER_CV_STACK[leftOff + 6];
  mem32![SCRATCH_BASE + 7] = HYPER_CV_STACK[leftOff + 7];
  mem32![SCRATCH_BASE + 8] = HYPER_CV_STACK[rightOff];
  mem32![SCRATCH_BASE + 9] = HYPER_CV_STACK[rightOff + 1];
  mem32![SCRATCH_BASE + 10] = HYPER_CV_STACK[rightOff + 2];
  mem32![SCRATCH_BASE + 11] = HYPER_CV_STACK[rightOff + 3];
  mem32![SCRATCH_BASE + 12] = HYPER_CV_STACK[rightOff + 4];
  mem32![SCRATCH_BASE + 13] = HYPER_CV_STACK[rightOff + 5];
  mem32![SCRATCH_BASE + 14] = HYPER_CV_STACK[rightOff + 6];
  mem32![SCRATCH_BASE + 15] = HYPER_CV_STACK[rightOff + 7];

  mem32![META_FLAGS] = flags;
  parentFn!();

  // Copy result to dest (unrolled, no allocation)
  HYPER_CV_STACK[destOff] = mem32![CVS_BASE];
  HYPER_CV_STACK[destOff + 1] = mem32![CVS_BASE + 1];
  HYPER_CV_STACK[destOff + 2] = mem32![CVS_BASE + 2];
  HYPER_CV_STACK[destOff + 3] = mem32![CVS_BASE + 3];
  HYPER_CV_STACK[destOff + 4] = mem32![CVS_BASE + 4];
  HYPER_CV_STACK[destOff + 5] = mem32![CVS_BASE + 5];
  HYPER_CV_STACK[destOff + 6] = mem32![CVS_BASE + 6];
  HYPER_CV_STACK[destOff + 7] = mem32![CVS_BASE + 7];
}

/** Copy CV #cvIdx from WASM output region to JS stack position. */
function storeCVToStack(cvIdx: number, stackPos: number): void {
  const base = CVS_BASE + cvIdx * 8;
  const destOff = stackPos * 8;
  HYPER_CV_STACK[destOff] = mem32![base];
  HYPER_CV_STACK[destOff + 1] = mem32![base + 1];
  HYPER_CV_STACK[destOff + 2] = mem32![base + 2];
  HYPER_CV_STACK[destOff + 3] = mem32![base + 3];
  HYPER_CV_STACK[destOff + 4] = mem32![base + 4];
  HYPER_CV_STACK[destOff + 5] = mem32![base + 5];
  HYPER_CV_STACK[destOff + 6] = mem32![base + 6];
  HYPER_CV_STACK[destOff + 7] = mem32![base + 7];
}

/**
 * Fastest single-threaded BLAKE3 (~1.17 GB/s, 26× reference).
 *
 * Processes 8 chunks per iteration (two compress4 calls).
 * Uses contiguous CV stack for cache locality.
 * De Bruijn ctz determines Merkle tree merge points in O(1).
 */
export function hashHyper(
  input: Uint8Array,
  outLen: number = OUT_LEN
): Uint8Array {
  if (!initWasm()) {
    throw new Error("SIMD not available");
  }

  // Small inputs - use existing paths
  if (input.length <= CHUNK_LEN) {
    if (input.length === 0) {
      const cv = processPartialChunk(new Uint8Array(0), 0n, ROOT);
      return cvToBytes(cv, outLen);
    }
    if (input.length === CHUNK_LEN) {
      process1Fast(input, 0, 0, ROOT, CV_VIEWS[0]);
      return cvToBytes(CV_VIEWS[0], outLen);
    }
    const cv = processPartialChunk(input, 0n, ROOT);
    return cvToBytes(cv, outLen);
  }

  const totalChunks = Math.ceil(input.length / CHUNK_LEN);
  let cvStackLen = 0;
  let chunkCounter = 0;
  let pos = 0;

  // Pre-create view if possible
  let input32: Uint32Array | null = null;
  if (input.byteOffset % 4 === 0 && input.byteLength % 4 === 0) {
    input32 = new Uint32Array(
      input.buffer,
      input.byteOffset,
      input.byteLength / 4
    );
  }

  // Helper to process one CV and do merging
  const processCV = () => {
    chunkCounter++;
    cvStackLen++;

    const isLast = chunkCounter === totalChunks;
    let merge = ctz32(chunkCounter);
    while (merge > 0 && cvStackLen >= 2) {
      if (isLast && cvStackLen === 2) break;
      cvStackLen -= 2;
      computeParentFromStack(cvStackLen, cvStackLen + 1, 0, cvStackLen);
      cvStackLen++;
      merge--;
    }
  };

  // HYPER TRANSPOSED PATH: Process 4 chunks at a time (4KB)
  while (pos + 4 * CHUNK_LEN <= input.length) {
    // Transpose 4KB input into WASM memory
    if (input32) {
      transpose4Chunks(input32, pos / 4, mem32!, OFF_CHUNKS / 4);
    } else {
      // Slow path for unaligned
      const tmp = new Uint8Array(4 * CHUNK_LEN);
      tmp.set(input.subarray(pos, pos + 4 * CHUNK_LEN));
      const src32 = new Uint32Array(tmp.buffer);
      transpose4Chunks(src32, 0, mem32!, OFF_CHUNKS / 4);
    }

    mem32![COUNTER_BASE] = chunkCounter;
    mem32![COUNTER_BASE + 1] = 0;
    mem32![COUNTER_BASE + 2] = chunkCounter + 1;
    mem32![COUNTER_BASE + 3] = 0;
    mem32![COUNTER_BASE + 4] = chunkCounter + 2;
    mem32![COUNTER_BASE + 5] = 0;
    mem32![COUNTER_BASE + 6] = chunkCounter + 3;
    mem32![COUNTER_BASE + 7] = 0;
    mem32![META_FLAGS] = 0;
    compress4Fn!();

    // Store 4 CVs and merge - fully unrolled
    storeCVToStack(0, cvStackLen);
    processCV();
    storeCVToStack(1, cvStackLen);
    processCV();
    storeCVToStack(2, cvStackLen);
    processCV();
    storeCVToStack(3, cvStackLen);
    processCV();

    pos += 4 * CHUNK_LEN;
  }

  // Remaining full chunks (1-3)
  while (pos + CHUNK_LEN <= input.length) {
    // Normal sequential copy for single chunks
    mem!.set(input.subarray(pos, pos + CHUNK_LEN), OFF_CHUNKS);
    mem32![COUNTER_BASE] = chunkCounter;
    mem32![COUNTER_BASE + 1] = 0;
    mem32![META_FLAGS] = 0;
    compress1Fn!();
    storeCVToStack(0, cvStackLen);
    processCV();
    pos += CHUNK_LEN;
  }

  // Final partial chunk
  if (pos < input.length) {
    const cv = processPartialChunk(
      input.subarray(pos),
      BigInt(chunkCounter),
      0
    );
    HYPER_CV_STACK.set(cv, cvStackLen * 8);
    cvStackLen++;
  }

  // Final merges with ROOT
  while (cvStackLen > 1) {
    cvStackLen -= 2;
    const flags = cvStackLen === 0 ? ROOT : 0;
    computeParentFromStack(cvStackLen, cvStackLen + 1, flags, cvStackLen);
    cvStackLen++;
  }

  // Extract final CV
  const finalCV = HYPER_CV_STACK.subarray(0, 8);
  return cvToBytes(finalCV, outLen);
}

export { SIMD_SUPPORTED as FAST_4_SIMD_SUPPORTED };
