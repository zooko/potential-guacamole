import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let wasmPkg = null;

function ensureInit() {
  if (wasmPkg) return;
  const pkgPath = resolve(__dirname, "../../blake3-wasm-single/pkg");
  wasmPkg = require(pkgPath);
}

export function hash(inputU8) {
  ensureInit();
  return wasmPkg.hash(inputU8);
}
