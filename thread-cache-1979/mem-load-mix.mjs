// node mem-load-mix.mjs <base> <encoding> <requests> <connections> <item>...: the items' pages in
// turn; prints failures.
const [base, encoding, count, connections, ...items] = process.argv.slice(2);
let left = Number(count), failed = 0;
const worker = async () => {
  while (left-- > 0) {
    const r = await fetch(`${base}/items/${items[left % items.length]}`, { headers: { "accept-encoding": encoding } });
    await r.arrayBuffer();
    if (r.status !== 200) failed++;
  }
};
await Promise.all(Array.from({ length: Number(connections) }, worker));
process.stdout.write(String(failed));
