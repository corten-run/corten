import { closeSync, openSync, writeSync } from "node:fs";

// Retain bounded diagnostics without repeatedly copying a growing multi-MiB string.
// Raw artifacts are written independently and never truncated to the diagnostic tail.
export function commandOutput({ file, capture = true } = {}) {
  const fd = file === undefined ? null : openSync(file, "a");
  const tail = (limit) => {
    let chunks = [], bytes = 0;
    return {
      add(chunk) {
        if (chunk.length >= limit) { chunks = [chunk.subarray(chunk.length - limit)]; bytes = limit; return; }
        chunks.push(chunk); bytes += chunk.length;
        while (bytes > limit) {
          const extra = bytes - limit;
          if (chunks[0].length <= extra) bytes -= chunks.shift().length;
          else { chunks[0] = chunks[0].subarray(extra); bytes -= extra; }
        }
      },
      text: () => Buffer.concat(chunks, bytes).toString("utf8"),
    };
  };
  const stdout = tail(capture ? 8 * 1024 * 1024 : 65536), stderr = tail(65536);
  let closed = false;
  const append = (chunk, buffer) => {
    if (closed) throw new Error("command output already closed");
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (fd !== null) {
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    }
    buffer.add(data);
  };
  return {
    stdout: (chunk) => append(chunk, stdout),
    stderr: (chunk) => append(chunk, stderr),
    result: () => capture ? stdout.text().trim() : "",
    diagnostic: () => stderr.text() || stdout.text(),
    close() { if (!closed) { closed = true; if (fd !== null) closeSync(fd); } },
  };
}
