use wasm_bindgen::prelude::*;

pub use wasm_bindgen_rayon::init_thread_pool;

const OUT_LEN: usize = 32;
const PAR_THRESHOLD: usize = 16 * 1024;

#[wasm_bindgen]
pub fn hash(input: &[u8]) -> Vec<u8> {
    let mut hasher = blake3::Hasher::new();

    if input.len() >= PAR_THRESHOLD {
        hasher.update_rayon(input);
    } else {
        hasher.update(input);
    }

    let h = hasher.finalize();
    let mut out = Vec::with_capacity(OUT_LEN);
    out.extend_from_slice(h.as_bytes());
    out
}
