import sys, collections
rows = []
for line in open('prefixes.log'):
    p = line.split()
    if len(p) == 7 and p[1].isdigit():
        rows.append((p[0], int(p[1]), int(p[2]), int(p[3]), int(p[4]), int(p[5])))
full = {}
for name, n, *_ in rows:
    full[name] = max(full.get(name, 0), n)
print('bodies', len(full), full)
print('ld1 >= flate2-1 rows:', [(r[0], r[1]) for r in rows if r[3] >= r[4]])
print('ld1 < zstd1 rows:', len([r for r in rows if r[3] < r[5]]), 'of', len(rows))
bands = [(1024, 6144), (8192, 16384), (20480, 32768), (49152, 10**9)]
for lo, hi in bands:
    sel = [r for r in rows if lo <= r[1] <= hi and (r[1] in (1024,1536,2048,3072,4096,6144,8192,10240,12288,16384,20480,24576,32768,49152,65536,98304,131072) or True)]
    names = sorted({r[0] for r in sel})
    smaller = [(r[0], r[1], round((r[3]/r[2]-1)*100, 1), r[3]-r[2]) for r in sel if r[3] < r[2]]
    larger = [(r[0], r[1], round((r[3]/r[2]-1)*100, 1), r[3]-r[2]) for r in sel if r[3] >= r[2]]
    print(f'band {lo}-{hi}: bodies {len(names)}; rows {len(sel)}; smaller rows {len(smaller)} range {min(s[2] for s in smaller)}..{max(s[2] for s in smaller)}; larger rows {len(larger)}', (min(l[2] for l in larger), max(l[2] for l in larger), min(l[3] for l in larger), max(l[3] for l in larger)) if larger else '')
    print('   larger bodies:', sorted({l[0] for l in larger}), ' smaller-only bodies:', sorted(set(names) - {l[0] for l in larger}))
for n in (16384, 20480):
    print(n, [(r[0], round((r[3]/r[2]-1)*100, 1)) for r in rows if r[1] == n])
