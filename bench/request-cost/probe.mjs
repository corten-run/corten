// Starts the probe held to one CPU, under callgrind or not, and talks HTTP/1.1 to it.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { instructions } from "./allocations.mjs";
import { COUNTED, WARM, alone } from "./figures.mjs";
import { Answers, cases, masked, unexpected } from "./requests.mjs";

/**
 * The allocator every reading runs with: jemalloc preloaded with the thread cache the image
 * `corten new` writes sets (512 KiB). That image also turns jemalloc's background thread on; here
 * it is off, so whatever the allocator does is done by the thread that asked, which is the one
 * a count reads.
 */
const ALLOCATOR = { LD_PRELOAD: "libjemalloc.so.2", MALLOC_CONF: "background_thread:false,tcache_max:524288", PROBE_ALLOCATOR: "jemalloc" };

/**
 * The probe, serving `configuration` on 127.0.0.1:`port` on CPU `cpu`, with `HOSTS` set to
 * `hosts` or, without it, not set, whatever this process's environment holds. With `callgrind`,
 * under callgrind writing its profiles to `callgrind.out`, with `callgrind.options` more.
 * @param {string} binary @param {"api" | "pages"} configuration
 * @param {{ cpu: string, port: number, hosts?: string, callgrind?: { out: string, options?: string[] } }} how
 */
export async function start(binary, configuration, { cpu, port, hosts, callgrind }) {
  const under = callgrind ? ["valgrind", "--tool=callgrind", `--callgrind-out-file=${callgrind.out}`, ...(callgrind.options ?? [])] : [];
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ...ALLOCATOR };
  delete env.HOSTS;
  if (hosts !== undefined) env.HOSTS = hosts;
  const child = spawn("taskset", ["-c", cpu, ...under, binary, String(port), configuration], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let said = "";
  child.stderr.setEncoding("latin1");
  const ready = new Promise((resolve, reject) => {
    const late = setTimeout(() => reject(new Error(`the probe did not say READY in 120 s:\n${said}`)), 120_000);
    child.stderr.on("data", (text) => {
      said += text;
      if (/^READY /m.test(said)) resolve(clearTimeout(late));
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error(`the probe stopped before it was ready:\n${said}`)));
  });
  try {
    await ready;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    pid: /** @type {number} */ (child.pid),
    /** Stops the probe and waits until it has. */
    async stop() {
      const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
      const late = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.kill("SIGTERM");
      await exited;
      clearTimeout(late);
    },
  };
}

/** One connection to the probe: requests written, answers read one at a time. */
export class Connection {
  #answers = new Answers();
  /** @type {Buffer[]} */
  #whole = [];
  /** @type {(() => void) | null} */
  #wake = null;
  /** @type {Error | null} */
  #failed = null;
  /** Whether the probe has closed its side, or the connection failed. */
  closed = false;
  /** How long `answer` waits with nothing read, in milliseconds: as long as Corten waits for a request. */
  patience = 30_000;

  /** @param {net.Socket} socket @param {number} port */
  constructor(socket, port) {
    this.socket = socket;
    this.port = port;
    socket.on("data", (chunk) => {
      try {
        this.#whole.push(...this.#answers.push(chunk));
      } catch (error) {
        this.#failed = /** @type {Error} */ (error);
      }
      this.#wake?.();
    });
    const end = () => {
      this.closed = true;
      this.#wake?.();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", (error) => {
      this.#failed ??= error;
      end();
    });
  }

  /** @param {number} port @param {string} [from] the client's own address, another of 127.0.0.0/8 */
  static async open(port, from) {
    const socket = net.connect({ host: "127.0.0.1", port, localAddress: from, noDelay: true });
    await once(socket, "connect");
    return new Connection(socket, port);
  }

  /** @param {Buffer} bytes */
  write(bytes) {
    this.socket.write(bytes);
  }

  /**
   * The next answer, or an error when nothing has come for `patience`: a request sent on a
   * connection the probe has not accepted is never answered. @returns {Promise<Buffer>}
   */
  async answer() {
    for (;;) {
      if (this.#failed) throw this.#failed;
      const next = this.#whole.shift();
      if (next) return next;
      if (this.closed) throw new Error("the probe closed the connection");
      /** @type {NodeJS.Timeout | undefined} */
      let late;
      const came = await new Promise((resolve) => {
        this.#wake = () => resolve(true);
        late = setTimeout(() => resolve(false), this.patience);
      });
      clearTimeout(late);
      if (!came) throw new Error(`no answer from the probe in ${this.patience / 1000} s`);
    }
  }

  /** Closes the client's side and waits for the probe to close its own. */
  async close() {
    if (this.socket.destroyed) return;
    const gone = once(this.socket, "close");
    this.socket.end();
    await gone;
  }
}

/**
 * `count` requests of a case on a connection, `depth` written at a time, each batch after the
 * answers to the one before it; a `count` that `depth` does not divide sends whole batches only
 * (`sent` in figures.mjs). Every answer must be the one the case must get (`unexpected` in
 * requests.mjs) and as long as the first. Resolves to the first answer, masked.
 * @param {Connection} connection @param {string} name @param {number} count @param {number} [depth]
 */
export async function send(connection, name, count, depth = 1) {
  const request = /** @type {typeof cases[string]} */ (cases[name]).request(connection.port);
  const batch = Buffer.concat(Array(depth).fill(request));
  /** @type {Buffer | undefined} */
  let first;
  for (let written = 0; written + depth <= count; written += depth) {
    connection.write(batch);
    for (let read = 0; read < depth; read += 1) {
      const answer = await connection.answer();
      const wrong = unexpected(name, answer);
      if (wrong) throw new Error(`${name}: ${wrong}\n${answer.subarray(0, 400).latin1Slice()}`);
      // A compressed body may differ between answers; an answer's length does not.
      const same = masked(answer);
      first ??= same;
      if (same.length !== first.length) throw new Error(`${name}: an answer of another length than the first`);
    }
  }
  return /** @type {Buffer} */ (first);
}

/**
 * The window of a case's counted requests: the probe under callgrind answers `WARM` requests on
 * one connection, then `COUNTED` more on the same one (`depth` at a time), with a dump before
 * them and one after. A dump writes what each thread ran since the dump before it, a file a
 * thread, so the second holds those requests and nothing of the probe's start, of the
 * connection's opening and closing, or of shutdown.
 *
 * Resolves to the second dump of callgrind's thread 1, the probe's first thread, which is the
 * one its runtime serves on (`profile`, written without name compression: allocations.mjs reads
 * it), the instructions it holds (`serving`), what the other threads ran in the window together
 * (`others`, and how many `threads`), and how long the window lasted (`seconds`, from the first
 * dump asked for to the second written). Fails when the window is not a count (`alone` in
 * figures.mjs): the first thread did not serve, or another thread ran more than the clock does.
 * @param {string} binary @param {string} name
 * @param {{ cpu: string, port: number, depth: number, scratch: string }} how `scratch`: a directory for the dumps
 */
export async function counted(binary, name, { cpu, port, depth, scratch }) {
  const directory = mkdtempSync(join(scratch, "run-"));
  const out = join(directory, "callgrind");
  const options = ["--separate-threads=yes", "--compress-strings=no", "--compress-pos=no"];
  const { configuration, hosts } = /** @type {typeof cases[string]} */ (cases[name]);
  const probe = await start(binary, configuration, { cpu, port, hosts, callgrind: { out, options } });
  /** The files of a dump, one a thread: `callgrind.<part>-<thread>`. */
  const written = (/** @type {number} */ part) => readdirSync(directory).filter((file) => new RegExp(`^callgrind\\.${part}-\\d+$`).test(file));
  // callgrind_control exits 0 whether or not it reached the process: a dump is known by its files.
  const dump = (/** @type {number} */ part) => {
    execFileSync("callgrind_control", ["-d", String(probe.pid)], { stdio: "ignore" });
    if (written(part).length === 0) throw new Error(`callgrind_control did not make the probe write dump ${part}`);
  };
  let seconds = 0;
  try {
    const connection = await Connection.open(port);
    await send(connection, name, WARM, depth);
    const began = performance.now();
    dump(1);
    await send(connection, name, COUNTED, depth);
    dump(2);
    seconds = (performance.now() - began) / 1000;
    await connection.close();
  } finally {
    await probe.stop();
  }
  const read = (/** @type {string} */ file) => readFileSync(join(directory, file), "latin1");
  const first = "callgrind.2-01";
  const rest = written(2).filter((file) => file !== first);
  // A thread that ran nothing in the window may have no file: that is none of its instructions.
  const profile = existsSync(join(directory, first)) ? read(first) : "totals: 0\n";
  const window = { serving: instructions(profile), others: rest.reduce((sum, file) => sum + instructions(read(file)), 0), threads: rest.length, seconds };
  alone(window, depth);
  return { profile, ...window };
}
