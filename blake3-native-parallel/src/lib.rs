use napi::bindgen_prelude::*;
use napi_derive::napi;

/// Single-threaded hash using regular update()
#[napi]
pub fn hash_single(data: Buffer) -> Buffer {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&data);
    Buffer::from(hasher.finalize().as_bytes().to_vec())
}

/// Multi-threaded hash using update_rayon()
#[napi]
pub fn hash_rayon(data: Buffer) -> Buffer {
    let mut hasher = blake3::Hasher::new();
    hasher.update_rayon(&data);
    Buffer::from(hasher.finalize().as_bytes().to_vec())
}

/// Configure the Rayon thread pool size
/// Call this before any hash_rayon() calls
#[napi]
pub fn set_thread_count(count: u32) {
    rayon::ThreadPoolBuilder::new()
        .num_threads(count as usize)
        .build_global()
        .ok();
}
