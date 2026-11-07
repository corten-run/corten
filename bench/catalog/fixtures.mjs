import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const workload = 'catalog-v1';
export const count = 500;
const titles = ['Ridge trail', 'Valley survey', 'Woodland archive', 'Harbor notes', 'Meadow route'];
const names = ['Access', 'Area', 'Archive', 'Boundary', 'Condition', 'Direction', 'Environment', 'Feature',
  'Ground', 'Habitat', 'Information', 'Journey', 'Key', 'Location', 'Material', 'Notes',
  'Origin', 'Path', 'Quality', 'Route', 'Surface', 'Terrain', 'Use', 'View'];
const probe = '<script>globalThis.catalogInjected = true</script> & "quoted" <img src=x onerror="globalThis.catalogInjected=true">';

function title(n) { return `${titles[(n - 1) % titles.length]} ${n}`; }

export function records() {
  return Object.fromEntries(Array.from({ length: count }, (_, offset) => {
    const n = offset + 1;
    const id = `record_${n}`;
    const empty = n === count;
    return [id, {
      id,
      title: title(n),
      subtitle: n === 1 ? `Survey notes ${probe}` : `Archive entry ${n}`,
      description: `A walking route through the landscape, recorded for the shared catalog. Entry ${n}. ${n === 1 ? probe : 'Read the notes and related records before setting out.'}`,
      tags: empty ? [] : ['survey', 'outdoors', n === 1 ? `caf\u00e9 ${probe}` : 'archive'],
      fields: empty ? [] : names.map((name, i) => ({ name: n === 1 && i === names.length - 1 ? 'Access' : name, value: `${name} notes for entry ${n}: ${i === 0 && n === 1 ? probe : 'North gate, woodland path and open ground.'}` })),
      related: empty ? [] : Array.from({ length: 4 }, (_, i) => {
        const next = ((n + i) % count) + 1;
        return { id: `record_${next}`, title: title(next) };
      }),
    }];
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(records())}\n`);
  console.log(`${workload}: ${count} records in ${output}`);
}
