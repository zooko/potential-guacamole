/**
 * BLAKE3 Constants
 *
 * Here are the magic numbers BLAKE3 needs to work.
 *
 * We use the same IVs as SHA-256 (derived from square roots of primes),
 * but we only need 7 rounds of mixing instead of BLAKE2's 10-12.
 *
 * See Section 2.1 of the BLAKE3 spec if you want the math details.
 */

// Block size: 64 bytes (512 bits), same as BLAKE2s
export const BLOCK_LEN = 64;

// Chunk size: 1024 bytes (1 KiB) - basic unit for Merkle tree leaves
export const CHUNK_LEN = 1024;

// Output length: 32 bytes (256 bits) default, extendable
export const OUT_LEN = 32;

// Key length for keyed hashing mode
export const KEY_LEN = 32;

/**
 * Initialization Vector (IV)
 * The starting state. These are the first 32 bits of the fractional parts
 * of the square roots of the first 8 primes (2-19).
 * Same constants used in SHA-256.
 */
export const IV = new Uint32Array([
  0x6a09e667, // sqrt(2)
  0xbb67ae85, // sqrt(3)
  0x3c6ef372, // sqrt(5)
  0xa54ff53a, // sqrt(7)
  0x510e527f, // sqrt(11)
  0x9b05688c, // sqrt(13)
  0x1f83d9ab, // sqrt(17)
  0x5be0cd19, // sqrt(19)
]);

/**
 * Domain Separation Flags
 *
 * We combine these with the compression flags to ensure different modes
 * (like keyed hashing or key derivation) produce totally different outputs,
 * even if you feed them the same input.
 */
export const CHUNK_START = 1 << 0; // First block of a chunk
export const CHUNK_END = 1 << 1; // Last block of a chunk
export const PARENT = 1 << 2; // Compressing two child chaining values
export const ROOT = 1 << 3; // Final output extraction
export const KEYED_HASH = 1 << 4; // Keyed hashing mode
export const DERIVE_KEY_CONTEXT = 1 << 5; // Key derivation: context string
export const DERIVE_KEY_MATERIAL = 1 << 6; // Key derivation: input material

/**
 * Message Word Permutation Schedule
 *
 * This tells us how to shuffle the message words after each round.
 * By shuffling, we ensure every bit of the message affects every bit of the state.
 */
export const MSG_PERMUTATION = new Uint8Array([
  2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8,
]);

/**
 * Precomputed Message Schedule for All 7 Rounds
 *
 * Instead of calculating the permutation every time (which is slow),
 * we pre-calculate the schedule for all 7 rounds right here.
 */
export const MSG_SCHEDULE: Uint8Array[] = (() => {
  const schedule: Uint8Array[] = [];

  // Round 0: identity permutation
  let current = new Uint8Array([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  ]);
  schedule.push(current);

  // Rounds 1-6: repeatedly apply MSG_PERMUTATION
  for (let round = 1; round < 7; round++) {
    const next = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      next[i] = current[MSG_PERMUTATION[i]];
    }
    schedule.push(next);
    current = next;
  }

  return schedule;
})();
