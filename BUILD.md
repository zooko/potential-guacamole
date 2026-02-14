# Build & Verify BLAKE3 WASM Modules

Reproduce the shipped `.wasm` files from source and verify they match.

## Prerequisites

- **Rust nightly-2025-11-15** (pinned in `blake3-wasm-rayon/rust-toolchain.toml`)
- **wasm-pack** — install with `cargo install wasm-pack`
- **rust-src** component — `rustup component add rust-src --toolchain nightly-2025-11-15`

## Build blake3-wasm-single

```bash
cd blake3-wasm-single
wasm-pack build --release --target web --out-dir pkg
```

## Build blake3-wasm-rayon

This variant requires nightly Rust with `build-std` (configured in `.cargo/config.toml`):

```bash
cd blake3-wasm-rayon
wasm-pack build --release --target web --out-dir pkg
```

## Verify shipped WASM matches build output

SHA256 hashes of the currently shipped `.wasm` files:

| File | SHA256 |
|------|--------|
| `blake3-wasm-single/pkg/blake3_wasm_single_bg.wasm` | `1d1620e3b02cd0921bd896bbe5687e452fffff402cfbb156b336033ecdd58ef7` |
| `blake3-wasm-rayon/pkg/blake3_wasm_rayon_bg.wasm` | `3ba84a6c9b9010915cde0b8804ed40968265f147acaf41cc04237d901a7d27b2` |

After building, compare:

```bash
sha256sum blake3-wasm-single/pkg/blake3_wasm_single_bg.wasm
sha256sum blake3-wasm-rayon/pkg/blake3_wasm_rayon_bg.wasm
```

### Note on reproducibility

Exact binary reproducibility depends on using the same Rust nightly version and wasm-pack version. If hashes differ, the source can still be audited by reading the Rust files directly — the entire codebase is ~30 lines total.

## Auditing the source

The Rust source is intentionally minimal:

- **Single-threaded** (`blake3-wasm-single/src/lib.rs`): 7 lines — calls `blake3::hash()` and returns the result
- **Parallel** (`blake3-wasm-rayon/src/lib.rs`): 22 lines — adds a 16 KB threshold for parallel hashing via Rayon

See [blake3-wasm-source/README.md](blake3-wasm-source/README.md) for a complete file map with descriptions.
