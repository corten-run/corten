// Starts the probe held to one CPU, under callgrind or not, and talks HTTP/1.1 to it.
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { Answers, cases, masked } from "./requests.mjs";

/**
 * The allocator every count runs with: the one the image `corten new` writes preloads, with its
 * background thread off, so the process has the one thread whose work is counted.
 */
const ALLOCATOR = { LD_PRELOAD: "libjemalloc.so.2", MALLOC_CONF: "background_thread:false,tcache_max:65536", PROBE_ALLOCATOR: "jemalloc" };

/**
 * The probe, serving `configuration` on 127.0.0.1:`port` on CPU `cpu`. With `callgrind`, under
 * callgrind writing its profile to `callgrind.out`, with `callgrind.options` more.
 * @param {string} binary @param {"api" | "pages"} configuration
 * @param {{ cpu: string, port: number, callgrind?: { out: string, options?: string[] } }} how
 */
export async function start(binary, configuration, { cpu, port, callgrind }) {
  const under = callgrind ? ["valgrind", "--tool=callgrind", `--callgrind-out-file=${callgrind.out}`, ...(callgrind.options ?? [])] : [];
  const child = spawn("taskset", ["-c", cpu, ...under, binary, String(port), configuration], {
    env: { ...process.env, ...ALLOCATOR },
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
    /** Stops the probe; under callgrind, resolves to the instructions it collected. */
    async stop() {
      const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve();
      const late = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.kill("SIGTERM");
      await exited;
      clearTimeout(late);
      if (!callgrind) return 0;
      const collected = /Collected : (\d+)/.exec(said);
      if (!collected) throw new Error(`no count in callgrind's output:\n${said}`);
      return Number(collected[1]);
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

  /** @param {net.Socket} socket */
  constructor(socket) {
    this.socket = socket;
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
    return new Connection(socket);
  }

  /** @param {Buffer} bytes */
  write(bytes) {
    this.socket.write(bytes);
  }

  /** The next answer. @returns {Promise<Buffer>} */
  async answer() {
    for (;;) {
      if (this.#failed) throw this.#failed;
      const next = this.#whole.shift();
      if (next) return next;
      if (this.closed) throw new Error("the probe closed the connection");
      await new Promise((resolve) => (this.#wake = () => resolve(undefined)));
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
 * `count` requests of a case on one connection, `depth` written at a time, each batch after the
 * answers to the one before it; a `count` that `depth` does not divide sends whole batches only.
 * Every answer must be a 200 as long as the first. Resolves to the first answer, masked.
 * @param {string} name @param {number} port @param {number} count @param {number} [depth]
 */
export async function send(name, port, count, depth = 1) {
  const request = /** @type {typeof cases[string]} */ (cases[name]).request(port);
  const batch = Buffer.concat(Array(depth).fill(request));
  const connection = await Connection.open(port);
  /** @type {Buffer | undefined} */
  let first;
  for (let sent = 0; sent + depth <= count; sent += depth) {
    connection.write(batch);
    for (let read = 0; read < depth; read += 1) {
      const answer = await connection.answer();
      if (!answer.subarray(0, 12).equals(Buffer.from("HTTP/1.1 200"))) throw new Error(`${name} was answered:\n${answer.latin1Slice(0, 400)}`);
      // A compressed body may differ between answers; an answer's length does not.
      const same = masked(answer);
      first ??= same;
      if (same.length !== first.length) throw new Error(`${name}: an answer of another length than the first`);
    }
  }
  await connection.close();
  return /** @type {Buffer} */ (first);
}

/** How many requests `send` writes for a count and a depth. @param {number} count @param {number} depth */
export const sent = (count, depth) => Math.floor(count / depth) * depth;
