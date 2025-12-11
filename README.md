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

Pre-existing implementations of BLAKE3 and SHA256 (for comparison):

WebCryptoAPI SHA256 (doesn't implement BLAKE3, native implementation):

64 bytes                 7.40 MB/s      121302 ops/sec
256 bytes               29.98 MB/s      122799 ops/sec
1 KB                   115.00 MB/s      117755 ops/sec
4 KB                   424.92 MB/s      108779 ops/sec
16 KB                 1119.10 MB/s       71622 ops/sec
64 KB                 1852.80 MB/s       29645 ops/sec
256 KB                2694.93 MB/s       10780 ops/sec
1 MB                  2968.78 MB/s        2969 ops/sec

All the rest below are BLAKE3.

blake-hash node bindings to native BLAKE3 implementation (https://github.com/Brooooooklyn/blake-hash):

64 bytes               138.27 MB/s     2265363 ops/sec
256 bytes              486.71 MB/s     1993548 ops/sec
1 KB                   954.18 MB/s      977075 ops/sec
4 KB                  2028.40 MB/s      519269 ops/sec
16 KB                 2364.51 MB/s      151329 ops/sec
64 KB                 2459.82 MB/s       39357 ops/sec
256 KB                2494.85 MB/s        9979 ops/sec
1 MB                  2506.37 MB/s        2506 ops/sec

hash-wasm (https://github.com/Daninet/hash-wasm):

64 bytes               154.24 MB/s     2527122 ops/sec
256 bytes              495.94 MB/s     2031357 ops/sec
1 KB                   896.43 MB/s      917949 ops/sec
4 KB                  1092.28 MB/s      279623 ops/sec
16 KB                 1148.97 MB/s       73534 ops/sec
64 KB                 1170.10 MB/s       18722 ops/sec
256 KB                1160.37 MB/s        4641 ops/sec
1 MB                  1145.71 MB/s        1146 ops/sec

Blake3inJavasScript:

64 bytes                61.11 MB/s     1001153 ops/sec
256 bytes              101.59 MB/s      416104 ops/sec
1 KB                   120.26 MB/s      123143 ops/sec
4 KB                   120.48 MB/s       30844 ops/sec
16 KB                  120.20 MB/s        7693 ops/sec
64 KB                  120.12 MB/s        1922 ops/sec
256 KB                 120.65 MB/s         483 ops/sec
1 MB                   120.01 MB/s         120 ops/sec

Bk3JS:

64 bytes               255.99 MB/s     4194176 ops/sec
256 bytes              680.12 MB/s     2785755 ops/sec
1 KB                   962.04 MB/s      985131 ops/sec
4 KB                   991.04 MB/s      253706 ops/sec
16 KB                 1303.38 MB/s       83416 ops/sec
64 KB                 1507.61 MB/s       24122 ops/sec
256 KB                1570.26 MB/s        6281 ops/sec
1 MB                  1464.30 MB/s        1464 ops/sec

blake3-fast:

64 bytes               252.97 MB/s     4144584 ops/sec
256 bytes              457.73 MB/s     1874862 ops/sec
1 KB                   544.04 MB/s      557093 ops/sec
4 KB                  1281.35 MB/s      328026 ops/sec
16 KB                 1561.79 MB/s       99954 ops/sec
64 KB                 1541.74 MB/s       24668 ops/sec
256 KB                1543.03 MB/s        6172 ops/sec
1 MB                  1555.25 MB/s        1555 ops/sec

blake3-js:

64 bytes               317.39 MB/s     5200039 ops/sec
256 bytes              710.66 MB/s     2910862 ops/sec
1 KB                   958.34 MB/s      981342 ops/sec
4 KB                   988.18 MB/s      252975 ops/sec
16 KB                 1010.05 MB/s       64643 ops/sec
64 KB                 1012.18 MB/s       16195 ops/sec
256 KB                 997.37 MB/s        3989 ops/sec
1 MB                   981.93 MB/s         982 ops/sec

blake3-optimized:

64 bytes               257.29 MB/s     4215370 ops/sec
256 bytes              673.72 MB/s     2759553 ops/sec
1 KB                   942.31 MB/s      964921 ops/sec
4 KB                   971.53 MB/s      248712 ops/sec
16 KB                  985.21 MB/s       63054 ops/sec
64 KB                  988.35 MB/s       15814 ops/sec
256 KB                 964.39 MB/s        3858 ops/sec
1 MB                   973.31 MB/s         973 ops/sec
