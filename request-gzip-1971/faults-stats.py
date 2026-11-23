import sys, re, statistics, collections
for path in sys.argv[1:]:
    rows = collections.defaultdict(list)
    failed = 0
    for line in open(path):
        p = [x.strip() for x in line.split('|')]
        if len(p) < 8: continue
        key = (p[2], p[3], p[1].replace('corten-card-market-', ''))
        sent = p[4]; faults = float(p[5].split()[0]); cpu = float(p[6].split()[0]); failed += int(p[7].split()[1])
        rows[key].append((sent, faults, cpu))
    print(path, 'failed', failed)
    for alloc in ('tuned', 'jemalloc-defaults', 'glibc'):
        for enc in dict.fromkeys(k[1] for k in rows):
            out = []
            for side in ('base', 'cand'):
                v = rows[(alloc, enc, side)]
                f = [x[1] for x in v]; c = [x[2] for x in v]
                out.append(f'{side}: {v[0][0]} | faults med {statistics.median(f):.2f} ({min(f):.2f}-{max(f):.2f}) | cpu med {statistics.median(c):.0f} ({min(c):.0f}-{max(c):.0f})')
            print(f'  {alloc:18} {enc:26} ' + '  ||  '.join(out))
