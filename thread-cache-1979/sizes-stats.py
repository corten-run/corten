import collections, statistics, sys
rows = collections.defaultdict(list)
for line in open(sys.argv[1]):
    p = [x.strip() for x in line.split('|')]
    if len(p) < 8: continue
    key = (int(p[2].split()[1]), p[1])
    rows[key].append((float(p[4].split()[0]), float(p[5].split()[0]), int(p[6].split()[1]), int(p[3].split()[1]), int(p[7].split()[1])))
confs = ['65536', '131072', '262144', '524288', '1048576', '4194304', 'glibc']
print('page  br   | ' + ' | '.join(f'{c:>16}' for c in confs))
for size in sorted({k[0] for k in rows}):
    cells = []
    for c in confs:
        v = rows[(size, c)]
        f = statistics.median(x[0] for x in v); t = statistics.median(x[1] for x in v); r = statistics.median(x[2] for x in v)
        cells.append(f'{f:6.2f} {t:5.0f} {r/1024:5.1f}')
    print(f'{size:6} {rows[(size, confs[0])][0][3]:5} | ' + ' | '.join(cells))
print('n per cell', {len(v) for v in rows.values()}, 'failed', sum(x[4] for v in rows.values() for x in v))
print('fault ranges where nonzero:')
for k, v in sorted(rows.items()):
    fs = [x[0] for x in v]; ts = [x[1] for x in v]
    if max(fs) > 0.05: print(k, min(fs), max(fs), 'cpu', min(ts), max(ts))
print('cpu ranges:', {k: (min(x[1] for x in v), max(x[1] for x in v)) for k, v in sorted(rows.items()) if k[1] in ('65536', '1048576', 'glibc')})
