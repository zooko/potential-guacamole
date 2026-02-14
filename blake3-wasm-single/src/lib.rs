use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn hash(input: &[u8]) -> Vec<u8> {
    let h = blake3::hash(input);
    h.as_bytes().to_vec()
}
