import sys
def read(p):
    d = {}
    for line in open(p):
        f = line.split()
        if f[0].startswith("cpu") and f[0] != "cpu":
            v = list(map(int, f[1:9])); d[int(f[0][3:])] = (sum(v), v[3] + v[4])
    return d
for tag in sys.argv[1:]:
    a, b = read(f"/root/pcc/raw/{tag}.stat0"), read(f"/root/pcc/raw/{tag}.stat1")
    def rng(lo, hi):
        o = []
        for c in range(lo, hi + 1):
            t = b[c][0] - a[c][0]; i = b[c][1] - a[c][1]
            o.append(100.0 * (t - i) / t if t else 0)
        return o
    s, l = rng(0, 23), rng(24, 47)
    print(tag, "server avg %.0f" % (sum(s) / 24), "load avg %.0f" % (sum(l) / 24), "load per core", " ".join("%.0f" % x for x in l))
