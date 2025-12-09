/**
 * BLAKE3 - Optimized JavaScript Implementation
 * Type definitions
 */

/**
 * Hash arbitrary binary data
 * @param input - Input data as Uint8Array
 * @returns 32-byte hash as Uint8Array
 */
export function hash(input: Uint8Array): Uint8Array;

/**
 * Hash binary data and return hex string
 * @param input - Input data as Uint8Array
 * @returns 64-character hex string
 */
export function hashHex(input: Uint8Array): string;

/**
 * Hash a UTF-8 string
 * @param str - Input string
 * @returns 32-byte hash as Uint8Array
 */
export function hashString(str: string): Uint8Array;

/**
 * Hash a UTF-8 string and return hex string
 * @param str - Input string
 * @returns 64-character hex string
 */
export function hashStringHex(str: string): string;

/**
 * BLAKE3 initialization vector (same as SHA-256)
 */
export const IV: Uint32Array;

/**
 * Block size in bytes (64)
 */
export const BLOCK_LEN: number;

/**
 * Chunk size in bytes (1024)
 */
export const CHUNK_LEN: number;
