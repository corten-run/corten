"""Writes a card-market fixture whose items' pages have different lengths: nine copies of the
smoke fixture's item, each with its contents and field values repeated a different number of
times under varied names (as sizes.py does for one item). Usage: mix.py <smoke.json> <out-dir>;
prints the items it wrote."""
import copy
import json
import os
import sys

source, out = sys.argv[1], sys.argv[2]
counts = [1, 3, 5, 10, 20, 40, 80, 160, 400]
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


source_item = json.load(open(source))['item_5']
data, used = {}, []
for count in counts:
    key = f'item_{count}'
    item = copy.deepcopy(source_item)
    item['catalog_item_id'] = key
    for field in ('contents', 'field_values'):
        rows = item[field]
        item[field] = rows + [vary(copy.deepcopy(row), n) for n in range(1, count) for row in rows]
    data[key] = item
    used.append(key)
os.makedirs(out, exist_ok=True)
json.dump(data, open(os.path.join(out, 'smoke.json'), 'w'))
print(' '.join(used))
