/**
 * BLAKE3 - Optimized Pure JavaScript Implementation
 * 
 * ALL 9 optimizations from the Fleek Network blog post applied.
 * https://blog.fleek.network/post/fleek-network-blake3-case-study/
 * 
 * No external dependencies. Works in Node.js, Deno, and browsers.
 * 
 * @author Implementation for Zooko's bounty
 * @see https://x.com/zooko/status/1998185559542657145
 */

(function(exports) {
  'use strict';

  // Constants - IV from SHA-256 (first 32 bits of fractional parts of square roots of first 8 primes)
  const IV = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const BLOCK_LEN = 64;
  const CHUNK_LEN = 1024;

  // Flags
  const CHUNK_START = 1;
  const CHUNK_END = 2;
  const PARENT = 4;
  const ROOT = 8;

  // Optimization #8: Detect endianness
  const IsBigEndian = !new Uint8Array(new Uint32Array([1]).buffer)[0];

  // Optimization #7: Reusable buffers
  const blockWords = new Uint32Array(16);
  let cvStack = null;

  function getCvStack(maxDepth) {
    const depth = Math.max(maxDepth, 10);
    const length = depth * 8;
    if (cvStack === null || cvStack.length < length) {
      cvStack = new Uint32Array(length);
    }
    return cvStack;
  }

  /**
   * FULLY OPTIMIZED compress function
   * All g() calls inlined, all permutations hardcoded
   */
  function compress(cv, cvOffset, m, mOffset, out, outOffset, truncateOutput, counter, blockLen, flags) {
    // Load message into local variables (Optimization #6)
    let m_0 = m[mOffset + 0] | 0;
    let m_1 = m[mOffset + 1] | 0;
    let m_2 = m[mOffset + 2] | 0;
    let m_3 = m[mOffset + 3] | 0;
    let m_4 = m[mOffset + 4] | 0;
    let m_5 = m[mOffset + 5] | 0;
    let m_6 = m[mOffset + 6] | 0;
    let m_7 = m[mOffset + 7] | 0;
    let m_8 = m[mOffset + 8] | 0;
    let m_9 = m[mOffset + 9] | 0;
    let m_10 = m[mOffset + 10] | 0;
    let m_11 = m[mOffset + 11] | 0;
    let m_12 = m[mOffset + 12] | 0;
    let m_13 = m[mOffset + 13] | 0;
    let m_14 = m[mOffset + 14] | 0;
    let m_15 = m[mOffset + 15] | 0;

    // Load state into local variables (Optimization #4)
    let s_0 = cv[cvOffset + 0] | 0;
    let s_1 = cv[cvOffset + 1] | 0;
    let s_2 = cv[cvOffset + 2] | 0;
    let s_3 = cv[cvOffset + 3] | 0;
    let s_4 = cv[cvOffset + 4] | 0;
    let s_5 = cv[cvOffset + 5] | 0;
    let s_6 = cv[cvOffset + 6] | 0;
    let s_7 = cv[cvOffset + 7] | 0;
    let s_8 = 0x6a09e667 | 0;
    let s_9 = 0xbb67ae85 | 0;
    let s_10 = 0x3c6ef372 | 0;
    let s_11 = 0xa54ff53a | 0;
    let s_12 = counter | 0;
    let s_13 = (counter / 0x100000000) | 0;
    let s_14 = blockLen | 0;
    let s_15 = flags | 0;

    // 7 rounds with fully inlined g function calls
    for (let r = 0; r < 7; r++) {
      // Column mixing
      s_0 = (((s_0 + s_4) | 0) + m_0) | 0; s_12 ^= s_0; s_12 = (s_12 >>> 16) | (s_12 << 16);
      s_8 = (s_8 + s_12) | 0; s_4 ^= s_8; s_4 = (s_4 >>> 12) | (s_4 << 20);
      s_0 = (((s_0 + s_4) | 0) + m_1) | 0; s_12 ^= s_0; s_12 = (s_12 >>> 8) | (s_12 << 24);
      s_8 = (s_8 + s_12) | 0; s_4 ^= s_8; s_4 = (s_4 >>> 7) | (s_4 << 25);

      s_1 = (((s_1 + s_5) | 0) + m_2) | 0; s_13 ^= s_1; s_13 = (s_13 >>> 16) | (s_13 << 16);
      s_9 = (s_9 + s_13) | 0; s_5 ^= s_9; s_5 = (s_5 >>> 12) | (s_5 << 20);
      s_1 = (((s_1 + s_5) | 0) + m_3) | 0; s_13 ^= s_1; s_13 = (s_13 >>> 8) | (s_13 << 24);
      s_9 = (s_9 + s_13) | 0; s_5 ^= s_9; s_5 = (s_5 >>> 7) | (s_5 << 25);

      s_2 = (((s_2 + s_6) | 0) + m_4) | 0; s_14 ^= s_2; s_14 = (s_14 >>> 16) | (s_14 << 16);
      s_10 = (s_10 + s_14) | 0; s_6 ^= s_10; s_6 = (s_6 >>> 12) | (s_6 << 20);
      s_2 = (((s_2 + s_6) | 0) + m_5) | 0; s_14 ^= s_2; s_14 = (s_14 >>> 8) | (s_14 << 24);
      s_10 = (s_10 + s_14) | 0; s_6 ^= s_10; s_6 = (s_6 >>> 7) | (s_6 << 25);

      s_3 = (((s_3 + s_7) | 0) + m_6) | 0; s_15 ^= s_3; s_15 = (s_15 >>> 16) | (s_15 << 16);
      s_11 = (s_11 + s_15) | 0; s_7 ^= s_11; s_7 = (s_7 >>> 12) | (s_7 << 20);
      s_3 = (((s_3 + s_7) | 0) + m_7) | 0; s_15 ^= s_3; s_15 = (s_15 >>> 8) | (s_15 << 24);
      s_11 = (s_11 + s_15) | 0; s_7 ^= s_11; s_7 = (s_7 >>> 7) | (s_7 << 25);

      // Diagonal mixing
      s_0 = (((s_0 + s_5) | 0) + m_8) | 0; s_15 ^= s_0; s_15 = (s_15 >>> 16) | (s_15 << 16);
      s_10 = (s_10 + s_15) | 0; s_5 ^= s_10; s_5 = (s_5 >>> 12) | (s_5 << 20);
      s_0 = (((s_0 + s_5) | 0) + m_9) | 0; s_15 ^= s_0; s_15 = (s_15 >>> 8) | (s_15 << 24);
      s_10 = (s_10 + s_15) | 0; s_5 ^= s_10; s_5 = (s_5 >>> 7) | (s_5 << 25);

      s_1 = (((s_1 + s_6) | 0) + m_10) | 0; s_12 ^= s_1; s_12 = (s_12 >>> 16) | (s_12 << 16);
      s_11 = (s_11 + s_12) | 0; s_6 ^= s_11; s_6 = (s_6 >>> 12) | (s_6 << 20);
      s_1 = (((s_1 + s_6) | 0) + m_11) | 0; s_12 ^= s_1; s_12 = (s_12 >>> 8) | (s_12 << 24);
      s_11 = (s_11 + s_12) | 0; s_6 ^= s_11; s_6 = (s_6 >>> 7) | (s_6 << 25);

      s_2 = (((s_2 + s_7) | 0) + m_12) | 0; s_13 ^= s_2; s_13 = (s_13 >>> 16) | (s_13 << 16);
      s_8 = (s_8 + s_13) | 0; s_7 ^= s_8; s_7 = (s_7 >>> 12) | (s_7 << 20);
      s_2 = (((s_2 + s_7) | 0) + m_13) | 0; s_13 ^= s_2; s_13 = (s_13 >>> 8) | (s_13 << 24);
      s_8 = (s_8 + s_13) | 0; s_7 ^= s_8; s_7 = (s_7 >>> 7) | (s_7 << 25);

      s_3 = (((s_3 + s_4) | 0) + m_14) | 0; s_14 ^= s_3; s_14 = (s_14 >>> 16) | (s_14 << 16);
      s_9 = (s_9 + s_14) | 0; s_4 ^= s_9; s_4 = (s_4 >>> 12) | (s_4 << 20);
      s_3 = (((s_3 + s_4) | 0) + m_15) | 0; s_14 ^= s_3; s_14 = (s_14 >>> 8) | (s_14 << 24);
      s_9 = (s_9 + s_14) | 0; s_4 ^= s_9; s_4 = (s_4 >>> 7) | (s_4 << 25);

      // Permute message for next round (skip on last round)
      if (r < 6) {
        const t0 = m_0, t1 = m_1;
        m_0 = m_2; m_2 = m_3; m_3 = m_10; m_10 = m_12; m_12 = m_9; m_9 = m_11; m_11 = m_5; m_5 = t0;
        m_1 = m_6; m_6 = m_4; m_4 = m_7; m_7 = m_13; m_13 = m_14; m_14 = m_15; m_15 = m_8; m_8 = t1;
      }
    }

    // Output
    if (!truncateOutput) {
      out[outOffset + 8] = s_8 ^ cv[cvOffset + 0];
      out[outOffset + 9] = s_9 ^ cv[cvOffset + 1];
      out[outOffset + 10] = s_10 ^ cv[cvOffset + 2];
      out[outOffset + 11] = s_11 ^ cv[cvOffset + 3];
      out[outOffset + 12] = s_12 ^ cv[cvOffset + 4];
      out[outOffset + 13] = s_13 ^ cv[cvOffset + 5];
      out[outOffset + 14] = s_14 ^ cv[cvOffset + 6];
      out[outOffset + 15] = s_15 ^ cv[cvOffset + 7];
    }
    out[outOffset + 0] = s_0 ^ s_8;
    out[outOffset + 1] = s_1 ^ s_9;
    out[outOffset + 2] = s_2 ^ s_10;
    out[outOffset + 3] = s_3 ^ s_11;
    out[outOffset + 4] = s_4 ^ s_12;
    out[outOffset + 5] = s_5 ^ s_13;
    out[outOffset + 6] = s_6 ^ s_14;
    out[outOffset + 7] = s_7 ^ s_15;
  }

  function wordsToBytes(words) {
    const result = new Uint8Array(words.length * 4);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      result[i * 4] = word & 0xff;
      result[i * 4 + 1] = (word >> 8) & 0xff;
      result[i * 4 + 2] = (word >> 16) & 0xff;
      result[i * 4 + 3] = (word >> 24) & 0xff;
    }
    return result;
  }

  /**
   * Hash arbitrary data
   * @param {Uint8Array} input 
   * @returns {Uint8Array} 32-byte hash
   */
  function hash(input) {
    const flags = 0;
    const out = new Uint32Array(8);

    if (input.length === 0) {
      const cv = new Uint32Array(IV);
      blockWords.fill(0);
      compress(cv, 0, blockWords, 0, out, 0, true, 0, 0, flags | CHUNK_START | CHUNK_END | ROOT);
      return wordsToBytes(out);
    }

    const maxCvDepth = Math.ceil(Math.log2(1 + Math.ceil(input.length / CHUNK_LEN))) + 2;
    const stack = getCvStack(maxCvDepth);
    let stackPos = 0;

    // Optimization #8: Direct Uint32Array view for aligned little-endian
    let inputWords = null;
    if (!IsBigEndian && input.byteOffset % 4 === 0) {
      inputWords = new Uint32Array(input.buffer, input.byteOffset, input.byteLength >> 2);
    }

    let chunkCounter = 0;
    let offset = 0;
    const totalLen = input.length;

    while (offset < totalLen) {
      const chunkStart = offset;
      const chunkEnd = Math.min(offset + CHUNK_LEN, totalLen);
      const chunkLen = chunkEnd - chunkStart;
      const isLastChunk = chunkEnd === totalLen;

      // Initialize CV
      stack.set(IV, stackPos);

      const numBlocks = Math.ceil(chunkLen / BLOCK_LEN);

      for (let block = 0; block < numBlocks; block++) {
        const blockStart = chunkStart + block * BLOCK_LEN;
        const blockEnd = Math.min(blockStart + BLOCK_LEN, chunkEnd);
        const blockLen = blockEnd - blockStart;
        const isFirstBlock = block === 0;
        const isLastBlockOfChunk = block === numBlocks - 1;

        let blockFlags = flags;
        if (isFirstBlock) blockFlags |= CHUNK_START;
        if (isLastBlockOfChunk) blockFlags |= CHUNK_END;
        // For single chunk, the last block also gets ROOT flag
        if (isLastBlockOfChunk && isLastChunk && chunkCounter === 0) {
          blockFlags |= ROOT;
        }

        if (blockLen === BLOCK_LEN && inputWords && blockStart % 4 === 0) {
          compress(stack, stackPos, inputWords, blockStart >> 2, stack, stackPos, true, chunkCounter, BLOCK_LEN, blockFlags);
        } else {
          blockWords.fill(0);
          for (let i = 0; i < blockLen; i++) {
            blockWords[i >> 2] |= input[blockStart + i] << ((i & 3) * 8);
          }
          compress(stack, stackPos, blockWords, 0, stack, stackPos, true, chunkCounter, blockLen, blockFlags);
        }
      }

      stackPos += 8;
      chunkCounter++;
      offset = chunkEnd;

      if (!isLastChunk) {
        let totalChunks = chunkCounter;
        while ((totalChunks & 1) === 0) {
          stackPos -= 16;
          compress(IV, 0, stack, stackPos, stack, stackPos, true, 0, BLOCK_LEN, flags | PARENT);
          stackPos += 8;
          totalChunks >>= 1;
        }
      }
    }

    // Final output
    if (chunkCounter === 1) {
      // Single chunk - CV is already the output with ROOT applied
      out.set(new Uint32Array(stack.buffer, 0, 8));
    } else {
      // Multiple chunks - merge remaining stack
      while (stackPos > 8) {
        stackPos -= 16;
        const isRoot = stackPos === 0;
        compress(IV, 0, stack, stackPos, isRoot ? out : stack, isRoot ? 0 : stackPos, true, 0, BLOCK_LEN, flags | PARENT | (isRoot ? ROOT : 0));
        if (!isRoot) stackPos += 8;
      }
    }

    return wordsToBytes(out);
  }

  /**
   * Hash to hex string
   */
  function hashHex(input) {
    const bytes = hash(input);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  /**
   * Hash a string (UTF-8)
   */
  function hashString(str) {
    return hash(new TextEncoder().encode(str));
  }

  function hashStringHex(str) {
    return hashHex(new TextEncoder().encode(str));
  }

  // Exports
  exports.hash = hash;
  exports.hashHex = hashHex;
  exports.hashString = hashString;
  exports.hashStringHex = hashStringHex;
  exports.IV = IV;
  exports.BLOCK_LEN = BLOCK_LEN;
  exports.CHUNK_LEN = CHUNK_LEN;

})(typeof exports !== 'undefined' ? exports : (this.blake3 = {}));
