- A kept page or body holds its headers as a list of its own size, not a copy of the whole header map: under jemalloc a kept page of 6,124 bytes takes 536 fewer bytes of memory, and a page kept with room runs about 1% fewer instructions.
  ([#1824 A Public page asked for once costs 44% more cycles than the same page not kept](https://github.com/corten-run/corten/issues/1824))
