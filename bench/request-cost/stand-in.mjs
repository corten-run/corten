// What run.test.mjs runs in place of the probe, of valgrind running it and of callgrind_control:
// a server that answers the kit's GET cases as the probe does and writes dumps that say what it
// was asked to do since the dump before, so a test can tell which dump a count read and what
// was in its window. Nothing here counts anything.
//
//   node stand-in.mjs [valgrind's options] [<binary>] <port> <configuration>   the probe, or valgrind running it
//   node stand-in.mjs control -d <pid>                                         callgrind_control
//
// Both keep their notes in the directory $STAND_IN: `started.json` (the options and the
// allocator's settings the server was last started with), `control-<pid>` (the port a dump is
// asked for on), `controls` (how often the control was run) and `parts.json` (what each dump of
// the last server held). A dump is callgrind's in name and shape: with `--separate-threads=yes`
// a file a thread, `<out>.<part>-01` and `-02`, and `<out>-01` and `-02` when the server is
// stopped. The thread that serves "ran" 1,000 instructions a request and 600 more, a hundred
// million for a connection opened and ten million for one closed; the other thread ran what the
// clock runs in a tick.
//
// What a test can ask for, each by a variable:
//   STAND_IN_THREAD=2            the second thread serves, the first runs nothing
//   STAND_IN_OTHERS=<n>          what the thread that does not serve ran in each part (243)
//   STAND_IN_FEWER_MALLOCS=1     a part holds one call to malloc fewer than its requests (16 each)
//   STAND_IN_NOT_FOUND_FROM=<n>  the server's nth request and those after it are answered 404
//   STAND_IN_DEAF_AFTER=<n>      after its nth run the control exits 0 and asks for nothing
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

const state = process.env.STAND_IN;
if (!state) throw new Error("STAND_IN names no directory");
const argv = process.argv.slice(2);

if (argv[0] === "control") {
  const controls = join(state, "controls");
  const run = (existsSync(controls) ? Number(readFileSync(controls, "utf8")) : 0) + 1;
  writeFileSync(controls, String(run));
  if (run > Number(process.env.STAND_IN_DEAF_AFTER ?? Infinity)) process.exit(0);
  const pid = argv[argv.indexOf("-d") + 1];
  const socket = net.connect(Number(readFileSync(join(state, `control-${pid}`), "utf8")), "127.0.0.1");
  socket.end("dump\n");
  socket.resume();
  socket.on("close", () => process.exit(0));
} else {
  serve();
}

function serve() {
  const options = argv.filter((arg) => arg.startsWith("--"));
  const rest = argv.filter((arg) => !arg.startsWith("--"));
  const [port, configuration] = /** @type {[string, string]} */ (rest.slice(-2));
  const out = options.find((option) => option.startsWith("--callgrind-out-file="))?.slice("--callgrind-out-file=".length);
  writeFileSync(
    join(/** @type {string} */ (state), "started.json"),
    JSON.stringify({ options, binary: rest.length === 3 ? rest[0] : null, port, configuration, LD_PRELOAD: process.env.LD_PRELOAD, MALLOC_CONF: process.env.MALLOC_CONF, PROBE_ALLOCATOR: process.env.PROBE_ALLOCATOR }),
  );
  /** @type {Record<string, Record<string, string>>} */
  const bodies = { api: { "GET /baseline11?a=1&b=2": "3", "GET /unstaged11?a=1&b=2": "3", "GET /pipeline": "ok" }, pages: { "GET /text": "ok" } };
  const notFoundFrom = Number(process.env.STAND_IN_NOT_FOUND_FROM ?? Infinity);

  const fresh = () => ({ requests: 0, opened: 0, closed: 0, mostInARead: 0 });
  let part = fresh();
  /** @type {ReturnType<typeof fresh>[]} */
  const parts = [];
  /** Writes what was done since the last dump: a part's files, or the files of the server's end. */
  function dump(end = false) {
    const n = parts.length + 1;
    const named = end ? "" : `.${n}`;
    const serving = part.requests * 1000 + 600 + part.opened * 100_000_000 + part.closed * 10_000_000;
    const others = Number(process.env.STAND_IN_OTHERS ?? 243);
    const mallocs = process.env.STAND_IN_FEWER_MALLOCS ? part.requests - 1 : part.requests * 16;
    // Without --compress-strings=no callgrind names a function by a number after its first use.
    const malloc = options.includes("--compress-strings=no") ? "malloc" : "(7)";
    const profile = (/** @type {number} */ thread, /** @type {number} */ total, /** @type {number} */ calls) =>
      `# callgrind format\nversion: 1\ncreator: stand-in\npart: ${n}\nthread: ${thread}\nevents: Ir\nsummary: ${total}\n\nob=/stand-in/probe\nfn=serve\n` +
      (calls > 0 ? `cob=/usr/lib/libjemalloc.so.2\ncfn=${malloc}\ncalls=${calls} 0\n1 ${calls}\n` : "") +
      `\ntotals: ${total}\n`;
    const serves = Number(process.env.STAND_IN_THREAD ?? 1);
    if (out && options.includes("--separate-threads=yes")) {
      for (const thread of [1, 2]) writeFileSync(`${out}${named}-0${thread}`, thread === serves ? profile(thread, serving, mallocs) : profile(thread, thread === 1 ? 0 : others, 0));
    } else if (out) {
      writeFileSync(`${out}${named}`, profile(1, serving + others, mallocs));
    }
    parts.push(part);
    part = fresh();
    writeFileSync(join(/** @type {string} */ (state), "parts.json"), JSON.stringify(parts));
  }

  let requests = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    part.opened += 1;
    let unread = "";
    socket.on("data", (chunk) => {
      unread += chunk.latin1Slice();
      const heads = unread.split("\r\n\r\n");
      unread = /** @type {string} */ (heads.pop());
      part.mostInARead = Math.max(part.mostInARead, heads.length);
      for (const head of heads) {
        part.requests += 1;
        requests += 1;
        const line = /** @type {string} */ (head.split("\r\n")[0]).replace(/ HTTP\/1\.1$/, "");
        const body = requests >= notFoundFrom ? undefined : bodies[configuration]?.[line];
        const [status, sent] = body === undefined ? ["404 Not Found", ""] : ["200 OK", body];
        socket.write(`HTTP/1.1 ${status}\r\ncontent-length: ${sent.length}\r\ndate: ${new Date().toUTCString()}\r\n\r\n${sent}`, "latin1");
      }
    });
    socket.on("end", () => {
      part.closed += 1;
      socket.end();
    });
    socket.on("error", () => {});
  });
  const control = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", () => {
      dump();
      socket.end("done\n");
    });
    socket.on("error", () => {});
  });
  process.on("SIGTERM", () => {
    dump(true);
    process.exit(0);
  });
  // The port asked for first: the control's own, which the system picks, could otherwise be it.
  server.listen(Number(port), "127.0.0.1", () => {
    control.listen(0, "127.0.0.1", () => {
      writeFileSync(join(/** @type {string} */ (state), `control-${process.pid}`), String(/** @type {net.AddressInfo} */ (control.address()).port));
      process.stderr.write(`READY ${configuration} on ${port}\n`);
    });
  });
}
