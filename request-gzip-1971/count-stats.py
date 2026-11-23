import sys, statistics, collections
rows = collections.defaultdict(list); section = 'item'
for line in open(sys.argv[1]):
    if line.startswith('===='):
        section = 'long'; continue
    if line.startswith('#'):
        print(section, line.strip()); continue
    p = [x.strip() for x in line.split('|')]
    if len(p) < 6:
        continue
    rows[(section, p[0], p[1], p[2], p[3])].append(float(p[5].split()[0]))
for k, v in rows.items():
    print(f'{k[0]:5} {k[1]:5} {k[2]:26} {k[3]:5} {k[4]:5} n={len(v)} median {statistics.median(v):>10} range {min(v)}-{max(v)}')
