import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
export function usageUsec(value) {
  const match = /^usage_usec (\d+)$/m.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("cgroup v2 usage_usec missing or invalid");
  return Number(match[1]);
}
export function readCpu(id, root = "/sys/fs/cgroup") {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid container ID");
  const search = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === id || entry.name === `docker-${id}.scope`) return usageUsec(readFileSync(join(path, "cpu.stat"), "utf8"));
      if (depth > 0) {
        const found = search(path, depth - 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  const value = search(root, 3);
  if (value === null) throw new Error(`cannot find cgroup v2 for ${id}`);
  return value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(Object.fromEntries(process.argv.slice(2).map((id) => [id, readCpu(id)]))));
