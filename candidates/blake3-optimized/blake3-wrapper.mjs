// ESM wrapper for CommonJS blake3-optimized
// The UMD pattern uses (function(exports){...})(exports || this.blake3)
// We provide an exports object and re-export

const exports = {};

// Inline the UMD immediately-invoked function
(function(exports) {
  'use strict';

  const IV = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const BLOCK_LEN = 64;
  const CHUNK_LEN = 1024;
  const CHUNK_START = 1;
  const CHUNK_END = 2;
  const PARENT = 4;
  const ROOT = 8;
  const IsBigEndian = !new Uint8Array(new Uint32Array([1]).buffer)[0];
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

  function compress(cv, cvOffset, m, mOffset, out, outOffset, truncateOutput, counter, blockLen, flags) {
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

    for (let r = 0; r < 7; r++) {
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

      const t_0 = m_2; const t_1 = m_6; const t_2 = m_3; const t_3 = m_10;
      const t_4 = m_7; const t_5 = m_0; const t_6 = m_4; const t_7 = m_13;
      const t_8 = m_1; const t_9 = m_11; const t_10 = m_12; const t_11 = m_5;
      const t_12 = m_9; const t_13 = m_14; const t_14 = m_15; const t_15 = m_8;
      m_0 = t_0; m_1 = t_1; m_2 = t_2; m_3 = t_3;
      m_4 = t_4; m_5 = t_5; m_6 = t_6; m_7 = t_7;
      m_8 = t_8; m_9 = t_9; m_10 = t_10; m_11 = t_11;
      m_12 = t_12; m_13 = t_13; m_14 = t_14; m_15 = t_15;
    }

    if (truncateOutput) {
      out[outOffset + 0] = s_0 ^ s_8;
      out[outOffset + 1] = s_1 ^ s_9;
      out[outOffset + 2] = s_2 ^ s_10;
      out[outOffset + 3] = s_3 ^ s_11;
      out[outOffset + 4] = s_4 ^ s_12;
      out[outOffset + 5] = s_5 ^ s_13;
      out[outOffset + 6] = s_6 ^ s_14;
      out[outOffset + 7] = s_7 ^ s_15;
    } else {
      out[outOffset + 0] = s_0 ^ s_8;
      out[outOffset + 1] = s_1 ^ s_9;
      out[outOffset + 2] = s_2 ^ s_10;
      out[outOffset + 3] = s_3 ^ s_11;
      out[outOffset + 4] = s_4 ^ s_12;
      out[outOffset + 5] = s_5 ^ s_13;
      out[outOffset + 6] = s_6 ^ s_14;
      out[outOffset + 7] = s_7 ^ s_15;
      out[outOffset + 8] = s_8 ^ cv[cvOffset + 0];
      out[outOffset + 9] = s_9 ^ cv[cvOffset + 1];
      out[outOffset + 10] = s_10 ^ cv[cvOffset + 2];
      out[outOffset + 11] = s_11 ^ cv[cvOffset + 3];
      out[outOffset + 12] = s_12 ^ cv[cvOffset + 4];
      out[outOffset + 13] = s_13 ^ cv[cvOffset + 5];
      out[outOffset + 14] = s_14 ^ cv[cvOffset + 6];
      out[outOffset + 15] = s_15 ^ cv[cvOffset + 7];
    }
  }

  function wordsToBytes(words, bytes, wordOffset, byteOffset, wordCount) {
    if (IsBigEndian) {
      for (let i = 0; i < wordCount; i++) {
        const w = words[wordOffset + i];
        bytes[byteOffset + i * 4 + 0] = w & 0xff;
        bytes[byteOffset + i * 4 + 1] = (w >> 8) & 0xff;
        bytes[byteOffset + i * 4 + 2] = (w >> 16) & 0xff;
        bytes[byteOffset + i * 4 + 3] = (w >> 24) & 0xff;
      }
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      for (let i = 0; i < wordCount; i++) {
        view.setUint32(byteOffset + i * 4, words[wordOffset + i], true);
      }
    }
  }

  function bytesToWords(bytes, words, byteOffset, wordOffset) {
    if (IsBigEndian) {
      for (let i = 0; i < 16; i++) {
        words[wordOffset + i] =
          bytes[byteOffset + i * 4] |
          (bytes[byteOffset + i * 4 + 1] << 8) |
          (bytes[byteOffset + i * 4 + 2] << 16) |
          (bytes[byteOffset + i * 4 + 3] << 24);
      }
    } else {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      for (let i = 0; i < 16; i++) {
        words[wordOffset + i] = view.getUint32(byteOffset + i * 4, true);
      }
    }
  }

  function hash(input, outputLength = 32) {
    const inputLen = input.length;
    if (inputLen === 0) {
      const cv = new Uint32Array(8);
      cv.set(IV);
      compress(cv, 0, blockWords, 0, cv, 0, true, 0, 0, CHUNK_START | CHUNK_END | ROOT);
      const out = new Uint8Array(outputLength);
      wordsToBytes(cv, out, 0, 0, Math.min(8, Math.ceil(outputLength / 4)));
      return out;
    }

    const numChunks = Math.ceil(inputLen / CHUNK_LEN);
    const maxStackDepth = Math.ceil(Math.log2(numChunks)) + 2;
    const stack = getCvStack(maxStackDepth);
    let stackSize = 0;

    let chunkCounter = 0;
    let offset = 0;

    while (offset < inputLen) {
      const chunkStart = offset;
      const chunkEnd = Math.min(offset + CHUNK_LEN, inputLen);
      const chunkLen = chunkEnd - chunkStart;

      const cv = new Uint32Array(8);
      cv.set(IV);

      let blockOffset = 0;
      while (blockOffset < chunkLen) {
        const blockStart = chunkStart + blockOffset;
        const blockEnd = Math.min(blockStart + BLOCK_LEN, chunkEnd);
        const blockLen = blockEnd - blockStart;

        if (blockLen < BLOCK_LEN) {
          blockWords.fill(0);
        }

        if (blockLen >= BLOCK_LEN) {
          bytesToWords(input, blockWords, blockStart, 0);
        } else {
          const padded = new Uint8Array(BLOCK_LEN);
          padded.set(input.subarray(blockStart, blockEnd));
          bytesToWords(padded, blockWords, 0, 0);
        }

        let flags = 0;
        if (blockOffset === 0) flags |= CHUNK_START;
        if (blockOffset + BLOCK_LEN >= chunkLen) flags |= CHUNK_END;

        compress(cv, 0, blockWords, 0, cv, 0, true, chunkCounter, blockLen, flags);
        blockOffset += BLOCK_LEN;
      }

      let cvToMerge = cv;
      let totalChunks = chunkCounter + 1;

      while ((totalChunks & 1) === 0 && stackSize > 0) {
        stackSize--;
        const leftCv = stack.subarray(stackSize * 8, stackSize * 8 + 8);
        const parentCv = new Uint32Array(8);
        parentCv.set(IV);

        const parentWords = new Uint32Array(16);
        parentWords.set(leftCv, 0);
        parentWords.set(cvToMerge, 8);

        compress(parentCv, 0, parentWords, 0, parentCv, 0, true, 0, BLOCK_LEN, PARENT);
        cvToMerge = parentCv;
        totalChunks = totalChunks >> 1;
      }

      stack.set(cvToMerge, stackSize * 8);
      stackSize++;

      chunkCounter++;
      offset = chunkEnd;
    }

    while (stackSize > 1) {
      stackSize--;
      const rightCv = stack.subarray(stackSize * 8, stackSize * 8 + 8);
      stackSize--;
      const leftCv = stack.subarray(stackSize * 8, stackSize * 8 + 8);

      const parentCv = new Uint32Array(8);
      parentCv.set(IV);

      const parentWords = new Uint32Array(16);
      parentWords.set(leftCv, 0);
      parentWords.set(rightCv, 8);

      let flags = PARENT;
      if (stackSize === 0) flags |= ROOT;

      compress(parentCv, 0, parentWords, 0, parentCv, 0, true, 0, BLOCK_LEN, flags);
      stack.set(parentCv, stackSize * 8);
      stackSize++;
    }

    const finalCv = stack.subarray(0, 8);
    if (numChunks === 1) {
      const singleCv = new Uint32Array(8);
      singleCv.set(IV);

      let blockOffset = 0;
      while (blockOffset < inputLen) {
        const blockEnd = Math.min(blockOffset + BLOCK_LEN, inputLen);
        const blockLen = blockEnd - blockOffset;

        if (blockLen < BLOCK_LEN) {
          blockWords.fill(0);
        }

        if (blockLen >= BLOCK_LEN) {
          bytesToWords(input, blockWords, blockOffset, 0);
        } else {
          const padded = new Uint8Array(BLOCK_LEN);
          padded.set(input.subarray(blockOffset, blockEnd));
          bytesToWords(padded, blockWords, 0, 0);
        }

        let flags = 0;
        if (blockOffset === 0) flags |= CHUNK_START;
        if (blockOffset + BLOCK_LEN >= inputLen) flags |= CHUNK_END | ROOT;

        compress(singleCv, 0, blockWords, 0, singleCv, 0, true, 0, blockLen, flags);
        blockOffset += BLOCK_LEN;
      }

      const out = new Uint8Array(outputLength);
      wordsToBytes(singleCv, out, 0, 0, Math.min(8, Math.ceil(outputLength / 4)));
      return out;
    }

    const out = new Uint8Array(outputLength);
    wordsToBytes(finalCv, out, 0, 0, Math.min(8, Math.ceil(outputLength / 4)));
    return out;
  }

  function hashHex(input, outputLength = 32) {
    const bytes = hash(input, outputLength);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function hashString(str) {
    return hash(new TextEncoder().encode(str));
  }

  function hashStringHex(str) {
    return hashHex(new TextEncoder().encode(str));
  }

  exports.hash = hash;
  exports.hashHex = hashHex;
  exports.hashString = hashString;
  exports.hashStringHex = hashStringHex;
  exports.IV = IV;
  exports.BLOCK_LEN = BLOCK_LEN;
  exports.CHUNK_LEN = CHUNK_LEN;

})(exports);

export const { hash, hashHex, hashString, hashStringHex, IV, BLOCK_LEN, CHUNK_LEN } = exports;
