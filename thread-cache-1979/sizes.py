"""Writes card-market fixtures whose item_5 page is longer: the item's contents and field values
repeated N times under varied names. Usage: sizes.py <smoke.json> <out-root> <N>..."""
import copy
import json
import os
import sys

source, root, counts = sys.argv[1], sys.argv[2], [int(n) for n in sys.argv[3:]]
words = ['Amber', 'Basalt', 'Cinder', 'Dune', 'Ember', 'Fjord', 'Garnet', 'Harbor', 'Indigo', 'Juniper',
         'Kestrel', 'Lumen', 'Marrow', 'Nimbus', 'Onyx', 'Pewter', 'Quartz', 'Russet', 'Sable', 'Tundra']


def vary(value, n):
    if isinstance(value, dict):
        return {k: vary(v, n) for k, v in value.items()}
    if isinstance(value, list):
        return [vary(v, n) for v in value]
    if isinstance(value, str) and value and not value.startswith('http'):
        return f'{value} {words[n % 20]} {n * 7919 % 1000}' if ' ' in value or value[:1].isupper() else f'{value}_{n}'
    return value


for count in counts:
    data = json.load(open(source))
    item = data['item_5']
    for key in ('contents', 'field_values'):
        rows = item[key]
        item[key] = rows + [vary(copy.deepcopy(row), n) for n in range(1, count) for row in rows]
    out = os.path.join(root, f'n{count}')
    os.makedirs(out, exist_ok=True)
    json.dump(data, open(os.path.join(out, 'smoke.json'), 'w'))
    print(out)
