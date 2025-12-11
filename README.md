https://x.com/zooko/status/1998185559542657145

"I'll pay somebody 10ⓩ (that's a lot of money!) to implement BLAKE3 in JavaScript using all the optimizations described in this blog post: https://web.archive.org/web/20250320125147/https://blog.fleek.network/post/fleek-network-blake3-case-study/"

Date:   2025-12-09 00:18:00 +0000

---
https://github.com/Numi2/Blake3inJavasScript

commit:

Date:   2025-12-09 02:37:25 +0000

supply-chain-attack risks: none
tests: failed

---
https://github.com/lamb356/blake3-optimized

Commit:

Date:   2025-12-09 02:37:40 +0000

supply-chain-attack risks: none
tests: passed

---
https://github.com/alrightCha/blake3-js

commit:

Date:   2025-12-09 05:55:34 +0000

supply-chain-attack risks: none
tests: passed

---
https://github.com/Atamanov/blake3-fast

commit:

Date:   2025-12-09 10:20:02 +0000

supply-chain-attack risks: optional dev dependencies but they are not required for build, and there are no runtime dependencies
tests: passed

---
https://github.com/chimmykk/Bk3JS

commit:

Date:   2025-12-09 12:48:38 +0000

supply-chain-attack risks: none
tests: passed

---
https://x.com/zooko/status/1998407780114567360

"Whoa, whoa, it's only been 14 hours and there are already two submissions that look complete. So if you're looking at doing this for the Zcash, don't start because those other folks already beat you to it. (But you can still do it for love.)"

Date:   2025-12-09 15:01:00 +0000

(Narrator voice: there were actually 5, judging by self-assigned timestamps in git commits.)

---

DONE: check each submission for matching the official BLAKE3 test vectors

TODO: add checks for packaging, docs, tests, benchmarks

---
benchmarks (see files named "bench-w-blake3-optimized.output.txt" in the various subdirs).

These were all run on an Apple M4 Max CPU with Macos 26.1.

Pre-existing implementation of SHA256 (for comparison):

WebCryptoAPI SHA256 (doesn't implement BLAKE3, native implementation):

```
64 bytes                 7.13 MB/s
256 bytes               28.85 MB/s
1 KB                   117.10 MB/s
4 KB                   425.12 MB/s
16 KB                 1113.45 MB/s
64 KB                 1851.31 MB/s
256 KB                2699.12 MB/s
1 MB                  2970.62 MB/s
```

All the rest below here are BLAKE3.

Pre-existing implementations of BLAKE3 (for comparison):

blake-hash node bindings to native BLAKE3 implementation (https://github.com/Brooooooklyn/blake-hash):

```
64 bytes               116.73 MB/s
256 bytes              410.47 MB/s
1 KB                   874.63 MB/s
4 KB                  1945.17 MB/s
16 KB                 2336.96 MB/s
64 KB                 2455.62 MB/s
256 KB                2493.90 MB/s
1 MB                  2505.65 MB/s
```

hash-wasm implementation of BLAKE3 (https://github.com/Daninet/hash-wasm):

```
64 bytes               149.51 MB/s
256 bytes              500.73 MB/s
1 KB                   897.75 MB/s
4 KB                  1096.10 MB/s
16 KB                 1148.57 MB/s
64 KB                 1171.03 MB/s
256 KB                1170.80 MB/s
1 MB                  1172.33 MB/s
```

Candidate new implementations of BLAKE3:

Blake3inJavasScript:

```
64 bytes                56.41 MB/s
256 bytes               93.79 MB/s
1 KB                   114.52 MB/s
4 KB                   116.07 MB/s
16 KB                  114.54 MB/s
64 KB                  114.95 MB/s
256 KB                 114.46 MB/s
1 MB                   113.60 MB/s
```

Bk3JS:

```
64 bytes               196.31 MB/s
256 bytes              605.74 MB/s
1 KB                   883.49 MB/s
4 KB                   940.26 MB/s
16 KB                 1326.95 MB/s
64 KB                 1540.94 MB/s
256 KB                1581.21 MB/s
1 MB                  1519.38 MB/s
```

blake3-fast:

```
64 bytes               209.28 MB/s
256 bytes              413.29 MB/s
1 KB                   528.66 MB/s
4 KB                  1277.22 MB/s
16 KB                 1562.90 MB/s
64 KB                 1544.95 MB/s
256 KB                1561.00 MB/s
1 MB                  1562.83 MB/s
```

blake3-js:

```
64 bytes               251.96 MB/s
256 bytes              617.32 MB/s
1 KB                   890.65 MB/s
4 KB                   949.16 MB/s
16 KB                  984.10 MB/s
64 KB                  987.81 MB/s
256 KB                 971.45 MB/s
1 MB                   960.73 MB/s
```

blake3-optimized:

```
64 bytes               213.17 MB/s
256 bytes              605.12 MB/s
1 KB                   874.28 MB/s
4 KB                   935.69 MB/s
16 KB                  961.98 MB/s
64 KB                  952.33 MB/s
256 KB                 945.63 MB/s
1 MB                   957.84 MB/s
```
