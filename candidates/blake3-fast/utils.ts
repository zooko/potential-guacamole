/**
 * BLAKE3 Utility Functions
 *
 * Shared primitives: rotation, byte conversion, trailing zeros.
 * These are used across reference, optimized, and SIMD implementations.
 */

/**
 * Rotate right 32-bit unsigned integer
 * @param x - Input value (treated as u32)
 * @param n - Rotation amount (0-31)
 */
export function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Count trailing zero bits in a 64-bit integer.
 * We use this to decide when to merge nodes in the Merkle tree.
 * For example, ctz64(8) = 3 because 8 is 1000 in binary.
 */
export function ctz64(x: bigint): number {
  if (x === 0n) return 64;
  let count = 0;
  while ((x & 1n) === 0n) {
    x >>= 1n;
    count++;
  }
  return count;
}

/**
 * Read 32-bit little-endian word from byte array
 * BLAKE3 uses little-endian byte order (same as BLAKE2)
 */
export function loadLE32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Write 32-bit little-endian word to byte array
 */
export function storeLE32(
  data: Uint8Array,
  offset: number,
  value: number
): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >>> 8) & 0xff;
  data[offset + 2] = (value >>> 16) & 0xff;
  data[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * Convert Uint32Array to Uint8Array (little-endian)
 */
export function wordsToBytes(
  words: Uint32Array,
  byteLength: number
): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i += 4) {
    const word = words[i >>> 2];
    bytes[i] = word & 0xff;
    bytes[i + 1] = (word >>> 8) & 0xff;
    bytes[i + 2] = (word >>> 16) & 0xff;
    bytes[i + 3] = (word >>> 24) & 0xff;
  }
  return bytes;
}

/**
 * Convert byte array to Uint32Array (little-endian)
 * Pads with zeros if input length not multiple of 4
 */
export function bytesToWords(
  bytes: Uint8Array,
  wordCount: number
): Uint32Array {
  const words = new Uint32Array(wordCount);
  for (let i = 0; i < wordCount; i++) {
    const offset = i * 4;
    words[i] = loadLE32(bytes, offset);
  }
  return words;
}
