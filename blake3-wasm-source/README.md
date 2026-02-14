# BLAKE3 WASM Source — Auditor's Guide

This document maps every Rust source file used to build the shipped `.wasm` modules.
The entire Rust codebase is ~30 lines. All source lives in this repository — nothing is generated or fetched at build time beyond crates.io dependencies.

## Source File Map

### Single-threaded module (`blake3-wasm-single/`)

| File | Description |
|------|-------------|
| [`blake3-wasm-single/src/lib.rs`](../blake3-wasm-single/src/lib.rs) | 7-line wrapper — calls `blake3::hash(input)` and returns bytes |
| [`blake3-wasm-single/Cargo.toml`](../blake3-wasm-single/Cargo.toml) | Dependencies: `blake3` (with `wasm32_simd` feature), `wasm-bindgen` |
| [`blake3-wasm-single/.cargo/config.toml`](../blake3-wasm-single/.cargo/config.toml) | Enables SIMD128 for the wasm32 target |

### Parallel module (`blake3-wasm-rayon/`)

| File | Description |
|------|-------------|
| [`blake3-wasm-rayon/src/lib.rs`](../blake3-wasm-rayon/src/lib.rs) | 22-line wrapper — uses `update_rayon()` for inputs >= 16 KB |
| [`blake3-wasm-rayon/Cargo.toml`](../blake3-wasm-rayon/Cargo.toml) | Dependencies: `blake3` (with `rayon` + `wasm32_simd`), `wasm-bindgen-rayon`, `rayon` |
| [`blake3-wasm-rayon/.cargo/config.toml`](../blake3-wasm-rayon/.cargo/config.toml) | Enables atomics, bulk-memory, simd128, and shared memory linking |
| [`blake3-wasm-rayon/rust-toolchain.toml`](../blake3-wasm-rayon/rust-toolchain.toml) | Pins Rust nightly-2025-11-15 with `rust-src` component |

## Dependencies

All dependencies come from [crates.io](https://crates.io):

- **blake3** — the BLAKE3 hash implementation
- **wasm-bindgen** — Rust/JS interop for WebAssembly
- **rayon** — work-stealing parallelism (rayon variant only)
- **wasm-bindgen-rayon** — bridges Rayon threads to Web Workers (rayon variant only)

## Build & Verify

See [BUILD.md](../BUILD.md) for step-by-step instructions to reproduce the `.wasm` binaries and verify them against the shipped files.
