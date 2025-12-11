
--- after-the-bounty followups:

This looks good: https://github.com/Brooooooklyn/blake3-jit

These bounty competitors seem to have added substantial improvements after the competition ended: https://github.com/lamb356/blake3-optimized

New implementation after the contest: https://github.com/HuntsmanADHD/Blake3-JavaScript



--- bountry benchmarks

(see files named "bench-w-blake3-optimized.output.txt" in the various subdirs)

These were all run on an Apple M4 Max CPU with Macos 26.1.

text
```
pre-existing:

wc sha256: WebCrypto API implementation of SHA256 (native code)
blake-has: node bindings around native BLAKE3
hash-wasm: wasm implementation of BLAKE3

Vals are throughput in MB/s. Higher is better.

           pre-existing                  candidates
           ------------                  ---------->
           
           sha256    blake3
           ------    ------>

           native              js/wasm
           ------>             ------->

input size wc sha256 blake-has hash-wasm   Bk3JS   blake3-fa blake3-js blake3-op
---------- --------- --------- --------- --------- --------- --------- ---------
64 bytes         7       116       149       196       209       251 *     213
256 bytes       28       410       500       605 *     413       617 *     605 *
1 KB           117       874       897 *     883 *     528       890 *     874 *
4 KB           425      1940      1090       940      1270 *     949       935
16 KB         1110      2330      1140      1320      1560 *     984       961
64 KB         1850      2450      1170      1540 *    1540 *     987       952
256 KB        2690      2490      1170      1580 *    1560 *     971       945
1 MB          2970      2500      1170      1510 *    1560 *     960       957

`*` marks the fastest one, as well as any others within 10% of the fastest one
```

Comments:

This is interesting -- there are no fewer than three candidates that are the fastest at at least one
size input, but there are no candidates that are the fastest, or even within 10% of the fastest, at
all input sizes.

Also: it seems like a multithreaded implementation ought to achieve about 4X the throughput for each
4X increase in the input size (starting with the 1 KB input size since that is the size of a BLAKE3
Merkle Tree leaf).

--- Log:

https://x.com/zooko/status/1998185559542657145

"I'll pay somebody 10ⓩ (that's a lot of money!) to implement BLAKE3 in JavaScript using all the optimizations described in this blog post: https://web.archive.org/web/20250320125147/https://blog.fleek.network/post/fleek-network-blake3-case-study/"

Date:   2025-12-09 00:18:00 +0000

---
https://github.com/Numi2/Blake3inJavasScript

commit:

Date:   2025-12-09 02:37:25 +0000

supply-chain-attack risks: none
tests: failed

one file

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Language              Files        Lines         Code     Comments       Blanks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 JavaScript                1          488          342           82           64
```

---
https://github.com/lamb356/blake3-optimized

sent bounty

Commit:

Date:   2025-12-09 02:37:40 +0000

supply-chain-attack risks: none
tests: passed

one file (not counting TypeScript type file)
tests
benchmarks

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Language              Files        Lines         Code     Comments       Blanks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 JavaScript                1          304          220           44           40
 TypeScript                1           47            7           33            7
```

---
https://github.com/alrightCha/blake3-js

sent bounty

commit:

Date:   2025-12-09 05:55:34 +0000

supply-chain-attack risks: none
tests: passed

one file
tests
benchmarks

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Language              Files        Lines         Code     Comments       Blanks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 TypeScript                1          453          385           23           45
```

---
https://github.com/Atamanov/blake3-fast

sent bounty

author: Alexander Atamanov

commit:

Date:   2025-12-09 10:20:02 +0000

supply-chain-attack risks: optional dev dependencies but they are not required for build, and there are no runtime dependencies
tests: passed

8 files, nice progressive/adaptive design according to the readme
tests
benchmarks

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Language              Files        Lines         Code     Comments       Blanks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 TypeScript                8         5847         4201         1073          573
```

---
https://github.com/chimmykk/Bk3JS

sent bounty

author: Rilsosing Koireng

commit:

Date:   2025-12-09 12:48:38 +0000

supply-chain-attack risks: none
tests: passed

one file
tests
benchmarks

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Language              Files        Lines         Code     Comments       Blanks
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 JavaScript                1          820          687           55           78
```

---
https://github.com/ch4r10t33r/b3js

commit:

Date: 2025-12-09 14:31:00 +0000

---
https://x.com/zooko/status/1998407780114567360

"Whoa, whoa, it's only been 14 hours and there are already two submissions that look complete. So if you're looking at doing this for the Zcash, don't start because those other folks already beat you to it. (But you can still do it for love.)"

Date:   2025-12-09 15:01:00 +0000

(Narrator voice: there were actually 5, judging by self-assigned timestamps in git commits.)
