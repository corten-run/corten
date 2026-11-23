// node faults-load.mjs <base> <encoding> <requests>: item pages from 8 connections; prints failures.
const [base, encoding, count] = process.argv.slice(2);
let left = Number(count), failed = 0;
const worker = async () => {
  while (left-- > 0) {
    const r = await fetch(`${base}/items/item_5`, { headers: { "accept-encoding": encoding } });
    await r.arrayBuffer();
    if (r.status !== 200) failed++;
  }
};
await Promise.all(Array.from({ length: 8 }, worker));
process.stdout.write(String(failed));
