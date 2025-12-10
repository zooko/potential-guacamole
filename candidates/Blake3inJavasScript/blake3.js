
const BLAKE3 = (() => {
    // --- Constants -------------------------------------------------------------
  
    const CHUNK_LEN = 1024; // bytes per chunk (16 blocks)
    const BLOCK_LEN = 64;   // bytes per block
    const OUT_LEN   = 32;   // default output size in bytes
    const ROUNDS    = 7;    // BLAKE3 uses 7 rounds in its compression function
  
    // Initialization Vector (same as SHA‑256 IV, as used by BLAKE2s/BLAKE3)
    const IV = new Uint32Array([
      0x6a09e667, 0xbb67ae85,
      0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19
    ]);
  
    // Flags (BLAKE3 specification)
    const CHUNK_START        = 1 << 0;
    const CHUNK_END          = 1 << 1;
    const PARENT             = 1 << 2;
    const ROOT               = 1 << 3;
    const KEYED_HASH         = 1 << 4; // not used here
    const DERIVE_KEY_CONTEXT = 1 << 5; // not used here
    const DERIVE_KEY_MATERIAL= 1 << 6; // not used here
  
    // Message word permutations (“sigma”) per round.
    // This is the BLAKE2s schedule; BLAKE3 uses the same schedule but only 7 rounds.
    const MSG_SCHEDULE = [
      // round 0
      [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15 ],
      // round 1
      [ 2, 6, 3,10, 7, 0, 4,13, 1,11,12, 5, 9,14,15, 8 ],
      // round 2
      [ 3, 4,10,12,13, 2, 7,14, 6, 5, 9, 0,11,15, 8, 1 ],
      // round 3
      [10, 7,12, 9,14, 3,13,15, 4, 0,11, 2, 5, 8, 1, 6 ],
      // round 4
      [ 7,12, 9,14, 3,13,15, 4, 0,11, 2, 5, 8, 1, 6,10 ],
      // round 5
      [ 9,14, 3,13,15, 4, 0,11, 2, 5, 8, 1, 6,10, 7,12 ],
      // round 6
      [ 3,13,15, 4, 0,11, 2, 5, 8, 1, 6,10, 7,12, 9,14 ]
    ];
  
    // --- Small helpers ---------------------------------------------------------
  
    function rotr32(x, n) {
      return (x >>> n) | (x << (32 - n));
    }
  
    function readUint32LE(bytes, offset) {
      return (
        (bytes[offset    ]      ) |
        (bytes[offset + 1] <<  8) |
        (bytes[offset + 2] << 16) |
        (bytes[offset + 3] << 24)
      ) >>> 0;
    }
  
    function writeUint32LE(x, out, offset) {
      out[offset    ] =  x         & 0xff;
      out[offset + 1] = (x >>> 8 ) & 0xff;
      out[offset + 2] = (x >>> 16) & 0xff;
      out[offset + 3] = (x >>> 24) & 0xff;
    }
  
    // Detect host endianness once (true => big‑endian)
    const IS_BIG_ENDIAN = (() => {
      const buf = new ArrayBuffer(4);
      const u32 = new Uint32Array(buf);
      const u8  = new Uint8Array(buf);
      u32[0] = 0x01020304;
      return u8[0] === 0x01;
    })();
  
    // --- Global scratch buffers (Step 4, 5, 7, 8 style optimizations) ----------
  
    // 16-word state buffer reused by the compression function
    const STATE = new Uint32Array(16);
  
    // 16-word temporary block buffer (used when we can't read directly from input)
    const BLOCK_WORDS = new Uint32Array(16);
  
    // 8-word temporary CV buffer for leaf/parent compression
    const CV_TEMP = new Uint32Array(8);
  
    // Global CV stack reused between calls (sized on demand)
    let CV_STACK = new Uint32Array(8 * 16); // enough for many small inputs by default
  
    function getCvStack(capacityChunks) {
      const neededWords = capacityChunks * 8;
      if (CV_STACK.length < neededWords) {
        CV_STACK = new Uint32Array(neededWords);
      }
      return CV_STACK;
    }
  
    // Load up to 64 bytes from `input` into `destWords` as 16 little‑endian u32s,
    // padding with zeros beyond `blockLen`.
    function loadBlockWordsFromBytes(input, blockStart, blockLen, destWords, destOffset) {
      let i = 0;
      let bytePos = 0;
  
      // Full 4‑byte words
      const fullWordsBytes = blockLen & ~3;
      while (bytePos < fullWordsBytes) {
        destWords[destOffset + i++] = readUint32LE(input, blockStart + bytePos);
        bytePos += 4;
      }
  
      // Tail (0..3 bytes)
      let tail = 0;
      let shift = 0;
      while (bytePos < blockLen) {
        tail |= input[blockStart + bytePos] << shift;
        bytePos++;
        shift += 8;
      }
      if (shift > 0) {
        destWords[destOffset + i++] = tail >>> 0;
      }
  
      // Zero remaining words
      while (i < 16) {
        destWords[destOffset + i++] = 0;
      }
    }
  
    // The core BLAKE3 compression function.
    //
    // Inputs:
    //   cv          : Uint32Array, chaining value (8 words)
    //   cvOff       : index of cv within cv array
    //   blockWords  : Uint32Array, 16 message words
    //   blockOff    : index of the first word of this block
    //   out         : Uint32Array, receives 16-word compression output
    //   outOff      : offset in out
    //   counterLow  : low 32 bits of chunk counter
    //   counterHigh : high 32 bits of chunk counter
    //   blockLen    : block length in bytes (0..64)
    //   flags       : BLAKE3 flags
    //
    // Output layout matches the reference: out[0..7] = v[0..7] ^ v[8..15],
    // out[8..15] = v[8..15] ^ cv[0..7].
    function compress(
      cv, cvOff,
      blockWords, blockOff,
      out, outOff,
      counterLow, counterHigh,
      blockLen,
      flags
    ) {
      const v = STATE;
  
      // Initialize state
      v[0] = cv[cvOff + 0] | 0;
      v[1] = cv[cvOff + 1] | 0;
      v[2] = cv[cvOff + 2] | 0;
      v[3] = cv[cvOff + 3] | 0;
      v[4] = cv[cvOff + 4] | 0;
      v[5] = cv[cvOff + 5] | 0;
      v[6] = cv[cvOff + 6] | 0;
      v[7] = cv[cvOff + 7] | 0;
      v[8] = IV[0];
      v[9] = IV[1];
      v[10] = IV[2];
      v[11] = IV[3];
      v[12] = counterLow | 0;
      v[13] = counterHigh | 0;
      v[14] = blockLen | 0;
      v[15] = flags | 0;
  
      // The G function, operating on indices into v
      function g(a, b, c, d, mx, my) {
        v[a] = (v[a] + v[b] + mx) | 0;
        v[d] = rotr32(v[d] ^ v[a], 16);
        v[c] = (v[c] + v[d]) | 0;
        v[b] = rotr32(v[b] ^ v[c], 12);
        v[a] = (v[a] + v[b] + my) | 0;
        v[d] = rotr32(v[d] ^ v[a], 8);
        v[c] = (v[c] + v[d]) | 0;
        v[b] = rotr32(v[b] ^ v[c], 7);
      }
  
      // 7 rounds
      for (let r = 0; r < ROUNDS; r++) {
        const s = MSG_SCHEDULE[r];
  
        // Mix columns.
        g(0, 4,  8, 12, blockWords[blockOff + s[0]], blockWords[blockOff + s[1]]);
        g(1, 5,  9, 13, blockWords[blockOff + s[2]], blockWords[blockOff + s[3]]);
        g(2, 6, 10, 14, blockWords[blockOff + s[4]], blockWords[blockOff + s[5]]);
        g(3, 7, 11, 15, blockWords[blockOff + s[6]], blockWords[blockOff + s[7]]);
  
        // Mix diagonals.
        g(0, 5, 10, 15, blockWords[blockOff + s[8]],  blockWords[blockOff + s[9]]);
        g(1, 6, 11, 12, blockWords[blockOff + s[10]], blockWords[blockOff + s[11]]);
        g(2, 7,  8, 13, blockWords[blockOff + s[12]], blockWords[blockOff + s[13]]);
        g(3, 4,  9, 14, blockWords[blockOff + s[14]], blockWords[blockOff + s[15]]);
      }
  
      // XOR with input chaining value and produce output block
      for (let i = 0; i < 8; i++) {
        out[outOff + i] = (v[i] ^ v[i + 8]) >>> 0;
      }
      for (let i = 0; i < 8; i++) {
        out[outOff + 8 + i] = (v[i + 8] ^ cv[cvOff + i]) >>> 0;
      }
    }
  
    // Compress a single 1KiB chunk to an 8-word chaining value.
    //
    // This follows the “hash chunk” logic:
    //   - Start from keyWords as initial CV
    //   - For each block in the chunk, call compress with appropriate flags
    //   - The counter is the chunk index (same for all blocks in that chunk)
    function compressChunkToCv(
      input,           // Uint8Array
      chunkOffset,     // byte offset into input
      chunkLen,        // length of this chunk in bytes
      chunkIndex,      // 0-based chunk index
      keyWords,        // Uint32Array[8]
      baseFlags,       // flags (e.g. 0 for plain hash)
      cvOut,           // Uint32Array to store output CV
      cvOutOffset,     // index in cvOut
      wordsView,       // optional Uint32Array view of input (little‑endian fast path)
      wordsByteLength  // number of bytes covered by wordsView
    ) {
      const cv = CV_TEMP;
      for (let i = 0; i < 8; i++) cv[i] = keyWords[i];
  
      const counterLow  = chunkIndex | 0;
      const counterHigh = (chunkIndex / 0x100000000) | 0;
  
      // Special case: empty chunk (only happens for empty input overall)
      if (chunkLen === 0) {
        for (let i = 0; i < 16; i++) BLOCK_WORDS[i] = 0;
        compress(
          cv, 0,
          BLOCK_WORDS, 0,
          STATE, 0,
          counterLow, counterHigh,
          0,
          baseFlags | CHUNK_START | CHUNK_END
        );
        // Reduce to CV
        for (let i = 0; i < 8; i++) {
          cv[i] = (STATE[i] ^ STATE[i + 8]) >>> 0;
          cvOut[cvOutOffset + i] = cv[i];
        }
        return;
      }
  
      const chunkEnd = chunkOffset + chunkLen;
      let blockStart = chunkOffset;
      let blockIndex = 0;
  
      while (blockStart < chunkEnd) {
        const blockLen = Math.min(BLOCK_LEN, chunkEnd - blockStart);
  
        let flags = baseFlags;
        if (blockIndex === 0) flags |= CHUNK_START;
        if (blockStart + blockLen === chunkEnd) flags |= CHUNK_END;
  
        let blockWords;
        let blockOff;
  
        // Little-endian fast path: use shared Uint32Array view if possible
        if (
          !IS_BIG_ENDIAN &&
          wordsView &&
          blockLen === BLOCK_LEN &&
          blockStart + BLOCK_LEN <= wordsByteLength &&
          (blockStart & 3) === 0
        ) {
          blockWords = wordsView;
          blockOff   = blockStart >>> 2;
        } else {
          blockWords = BLOCK_WORDS;
          blockOff   = 0;
          loadBlockWordsFromBytes(input, blockStart, blockLen, BLOCK_WORDS, 0);
        }
  
        compress(
          cv, 0,
          blockWords, blockOff,
          STATE, 0,
          counterLow, counterHigh,
          blockLen,
          flags
        );
  
        // Update CV from compression output
        for (let i = 0; i < 8; i++) {
          cv[i] = (STATE[i] ^ STATE[i + 8]) >>> 0;
        }
  
        blockStart += BLOCK_LEN;
        blockIndex++;
      }
  
      // Write final CV to cvOut
      for (let i = 0; i < 8; i++) {
        cvOut[cvOutOffset + i] = cv[i];
      }
    }
  
    // Merge two CVs (left and right) into a parent CV via the parent node function.
    function parentCv(
      keyWords,
      left, leftOff,
      right, rightOff,
      outCv, outOff
    ) {
      // Parent block: left CV || right CV, 16 words total
      for (let i = 0; i < 8; i++) {
        BLOCK_WORDS[i]     = left[leftOff + i];
        BLOCK_WORDS[8 + i] = right[rightOff + i];
      }
  
      // Counter is 0 for parent nodes; block length is always 64
      compress(
        keyWords, 0,
        BLOCK_WORDS, 0,
        STATE, 0,
        0, 0,
        BLOCK_LEN,
        PARENT
      );
  
      for (let i = 0; i < 8; i++) {
        outCv[outOff + i] = (STATE[i] ^ STATE[i + 8]) >>> 0;
      }
    }
  
    // Compute the root CV from all chunk CVs by merging them in a binary tree.
    function reduceToRootCv(keyWords, cvStack, chunkCount) {
      let numCvs = chunkCount;
  
      // Pairwise merge until a single CV remains.
      while (numCvs > 1) {
        const parentCount = (numCvs + 1) >>> 1;
        for (let i = 0; i < parentCount; i++) {
          const leftIndex  = (2 * i) * 8;
          const rightIndex = leftIndex + 8;
  
          if (rightIndex < numCvs * 8) {
            parentCv(
              keyWords,
              cvStack, leftIndex,
              cvStack, rightIndex,
              cvStack, i * 8
            );
          } else {
            // Odd CV, just move it up
            if (leftIndex !== i * 8) {
              for (let w = 0; w < 8; w++) {
                cvStack[i * 8 + w] = cvStack[leftIndex + w];
              }
            }
          }
        }
        numCvs = parentCount;
      }
  
      // Root CV is now cvStack[0..7]
      const rootCv = new Uint32Array(8);
      for (let i = 0; i < 8; i++) {
        rootCv[i] = cvStack[i];
      }
      return rootCv;
    }
  
    // Given a root CV, generate the first 32 bytes of hash output.
    //
    // This follows the BLAKE3 “output” function for the first block:
    //   compress(rootCv, zero block, counter = 0, block_len = 0, flags = ROOT)
    // and then take the first 8 words of the compression output as the hash.
    function rootOutputBytes(rootCv, outLen) {
      if (outLen !== OUT_LEN) {
        throw new RangeError("This implementation currently only supports 32-byte outputs.");
      }
  
      // Zero block
      for (let i = 0; i < 16; i++) BLOCK_WORDS[i] = 0;
  
      // counter = 0, block_len = 0, flags = ROOT
      compress(
        rootCv, 0,
        BLOCK_WORDS, 0,
        STATE, 0,
        0, 0,
        0,
        ROOT
      );
  
      const out = new Uint8Array(outLen);
      for (let i = 0; i < 8; i++) {
        writeUint32LE(STATE[i] >>> 0, out, i * 4);
      }
      return out;
    }
  
    // --- Public API ------------------------------------------------------------
  
    function hash(input) {
      // Normalize input to Uint8Array
      let bytes;
      if (input instanceof Uint8Array) {
        bytes = input;
      } else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
      } else if (typeof input === "string") {
        // UTF‑8 encode
        const enc = new TextEncoder();
        bytes = enc.encode(input);
      } else {
        throw new TypeError("blake3.hash: expected Uint8Array, ArrayBuffer, TypedArray, or string");
      }
  
      const len = bytes.length;
      const keyWords = IV;
  
      // Optional little-endian fast path: view input as Uint32Array
      let wordsView = null;
      let wordsByteLength = 0;
      if (!IS_BIG_ENDIAN && (bytes.byteOffset & 3) === 0) {
        wordsView      = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 2);
        wordsByteLength = wordsView.length << 2;
      }
  
      // Number of 1KiB chunks (at least 1, even for empty input)
      const chunkCount = Math.max(1, Math.ceil(len / CHUNK_LEN));
  
      // CV stack reused as array of chaining values
      const cvStack = getCvStack(chunkCount);
  
      // Compute CV for each chunk
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        const chunkOffset = chunkIndex * CHUNK_LEN;
        const remaining   = len - chunkOffset;
        const chunkLen    = remaining > CHUNK_LEN ? CHUNK_LEN : Math.max(0, remaining);
  
        compressChunkToCv(
          bytes,
          chunkOffset,
          chunkLen,
          chunkIndex,
          keyWords,
          0, // base flags: plain hash mode
          cvStack,
          chunkIndex * 8,
          wordsView,
          wordsByteLength
        );
      }
  
      // Reduce all chunk CVs to a single root CV
      const rootCv = reduceToRootCv(keyWords, cvStack, chunkCount);
  
      // Generate first 32 bytes of output
      return rootOutputBytes(rootCv, OUT_LEN);
    }
  
    function hashHex(input) {
      const out = hash(input);
      let hex = "";
      for (let i = 0; i < out.length; i++) {
        const v = out[i].toString(16).padStart(2, "0");
        hex += v;
      }
      return hex;
    }
  
    return { hash, hashHex };
  })();
  
  // ESM-style exports
  export const hash    = BLAKE3.hash;
  export const hashHex = BLAKE3.hashHex;
  
  // CommonJS compatibility (Node.js)
  if (typeof module !== "undefined" && module.exports) {
    module.exports = BLAKE3;
  }