"""Adds to measure/count.py, in the tree given, three cases whose Accept-Encoding line is not one
of the three the head compares whole: curl's `deflate, gzip, br, zstd`, with the other headers of
the browser cases. The same requests go to both builds."""
import sys

path = sys.argv[1] + '/bench/httparena/corten/measure/count.py'
s = open(path, newline='').read()
anchor = '    "page-browser": get(PAGES, b"/page", BROWSER),\n}\n'
assert s.count(anchor) == 1
new = (
    '    "page-browser": get(PAGES, b"/page", BROWSER),\n'
    '    # The same three with an Accept-Encoding line that is not one a browser sends (curl\'s).\n'
    '    "get-other": get(API, b"/baseline11?a=1&b=2", OTHER),\n'
    '    "text-other": get(PAGES, b"/text", OTHER),\n'
    '    "page-other": get(PAGES, b"/page", OTHER),\n'
    '}\n'
)
s = s.replace(anchor, new)
anchor = 'API, PAGES = 8080, 8082\n'
assert s.count(anchor) == 1
s = s.replace(anchor, 'OTHER = BROWSER.replace(b"gzip, deflate, br, zstd", b"deflate, gzip, br, zstd")\nassert OTHER != BROWSER\n' + anchor)
open(path, 'w', newline='\n').write(s)
print('ok', path)
