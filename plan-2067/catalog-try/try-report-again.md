# A scope's lines in one pass: the catalog's item page and item JSON, cycles a request on one build of each side

**DRY RUN: a test of the scripts on the base's image alone, standing under both sides' names. No figure below is read.**

Pairs 0 to 2 of each target (pair 0 not recorded), each invocation one run of `bench/fullstack/count.mjs <round> 1 corten <target>` on a freshly started app; base image cb-corten-base sha256:6accacb6cc1487e17fc5e9b0e4c36203c30b428c849a5c756a4c405134b26938, head image cb-corten-base sha256:6accacb6cc1487e17fc5e9b0e4c36203c30b428c849a5c756a4c405134b26938; kernel 6.8.0-149-generic; started 2026-11-25T20:46:55Z.

## `page`: no bound (too few pairs for a 95% rank)

2 of 2 recorded pairs valid. User plus kernel cycles a request, head / base - 1 per pair: least +0.54%, median +9.40%, greatest +18.27%; bound (the -th smallest of 2) none. Margin +1%, no floor.

Every pair is valid, the one not recorded included.

| per request | base median (range) | head median (range) | change: least | median | greatest | bound |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | 148,446 (142,632 to 154,259) | 161,891 (155,090 to 168,692) | +0.54% | +9.40% | +18.27% | - |
| cycles user | 77,433 (74,340 to 80,526) | 87,865 (82,476 to 93,253) | +2.42% | +13.93% | +25.44% | - |
| cycles kernel | 71,013 (68,292 to 73,733) | 74,027 (72,614 to 75,439) | -1.52% | +4.47% | +10.47% | - |
| instructions user | 75,946 (75,932 to 75,960) | 76,026 (76,007 to 76,045) | +0.10% | +0.11% | +0.11% | - |
| instructions kernel | 33,858 (33,206 to 34,509) | 33,105 (33,053 to 33,157) | -4.22% | -2.18% | -0.15% | - |
| L1 icache misses user | 5,109 (5,034 to 5,184) | 5,112 (5,087 to 5,137) | -1.87% | +0.09% | +2.05% | - |

Each side's own range across its turns, in user plus kernel cycles a request: base +7.83% of its median, head +8.40%; the sides' medians differ by +9.06%.

| pair | first | base cycles u+k | head cycles u+k | change | instructions:u | base failed, checks failed | head failed, checks failed | counters at 100% | seconds (base, head) |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 0 (not recorded) | head | 140,493 | 156,474 | +11.37% | +0.17% | 0, 0 | 0, 0 | yes; yes | 34.7, 34.6 |
| 1 | base | 142,632 | 168,692 | +18.27% | +0.11% | 0, 0 | 0, 0 | yes; yes | 34.6, 34.7 |
| 2 | head | 154,259 | 155,090 | +0.54% | +0.10% | 0, 0 | 0, 0 | yes; yes | 34.7, 34.7 |

## `json`: no bound (too few pairs for a 95% rank)

2 of 2 recorded pairs valid. User plus kernel cycles a request, head / base - 1 per pair: least +14.75%, median +18.81%, greatest +22.88%; bound (the -th smallest of 2) none. Margin +1%, no floor.

Every pair is valid, the one not recorded included.

| per request | base median (range) | head median (range) | change: least | median | greatest | bound |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cycles user+kernel | 118,378 (117,435 to 119,320) | 140,609 (136,916 to 144,302) | +14.75% | +18.81% | +22.88% | - |
| cycles user | 56,084 (55,126 to 57,041) | 72,123 (66,757 to 77,488) | +17.03% | +28.80% | +40.57% | - |
| cycles kernel | 62,294 (62,279 to 62,309) | 68,487 (66,814 to 70,159) | +7.23% | +9.94% | +12.65% | - |
| instructions user | 59,466 (59,443 to 59,489) | 59,656 (59,601 to 59,710) | +0.19% | +0.32% | +0.45% | - |
| instructions kernel | 33,375 (33,260 to 33,490) | 33,400 (33,134 to 33,666) | -1.06% | +0.08% | +1.22% | - |
| L1 icache misses user | 3,477 (3,465 to 3,488) | 3,620 (3,541 to 3,699) | +1.52% | +4.14% | +6.75% | - |

Each side's own range across its turns, in user plus kernel cycles a request: base +1.59% of its median, head +5.25%; the sides' medians differ by +18.78%.

| pair | first | base cycles u+k | head cycles u+k | change | instructions:u | base failed, checks failed | head failed, checks failed | counters at 100% | seconds (base, head) |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 0 (not recorded) | head | 120,557 | 129,554 | +7.46% | -0.03% | 0, 0 | 0, 0 | yes; yes | 34.7, 34.8 |
| 1 | base | 119,320 | 136,916 | +14.75% | +0.19% | 0, 0 | 0, 0 | yes; yes | 34.8, 34.8 |
| 2 | head | 117,435 | 144,302 | +22.88% | +0.45% | 0, 0 | 0, 0 | yes; yes | 34.7, 34.8 |

An invocation took 34.6 to 34.8 s, median 34.7 s (12 invocations).

