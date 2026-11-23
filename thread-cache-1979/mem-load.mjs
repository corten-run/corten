// node mem-load.mjs <base> <encoding> <requests> <connections>: item pages; prints failures.
const [base, encoding, count, connections] = process.argv.slice(2);
let left = Number(count), failed = 0;
const worker = async () => {
  while (left-- > 0) {
    const r = await fetch(`${base}/items/item_5`, { headers: { "accept-encoding": encoding } });
    await r.arrayBuffer();
    if (r.status !== 200) failed++;
  }
};
await Promise.all(Array.from({ length: Number(connections) }, worker));
process.stdout.write(String(failed));
