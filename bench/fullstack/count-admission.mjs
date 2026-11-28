import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const COUNT_RECEIPT = "count-admission.json";
export const COUNT_OUTPUT = "instructions.json";
export const COUNT_OUTPUT_ARG = "--count-output=";
const idPattern = "[0-9a-f]{32}";
const idOf = new RegExp(`^${idPattern}$`);
const digestOf = (/** @type {Buffer} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const bad = { id: null, digest: null, rows: null };

/** A missing receipt is legacy, not permission to accept a malformed or contradicted receipt. */
export function readCount(/** @type {string} */ dir) {
  const file = join(dir, COUNT_RECEIPT);
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return null;
  if (!entry.isFile()) return bad;
  try {
    const { id, digest } = JSON.parse(readFileSync(file, "utf8"));
    if (typeof id !== "string" || !idOf.test(id)) return bad;
    if (digest === null) return { id, digest, rows: null };
    const output = join(dir, COUNT_OUTPUT);
    if (!lstatSync(output, { throwIfNoEntry: false })?.isFile()) return bad;
    const bytes = readFileSync(output);
    if (digestOf(bytes) !== digest) return bad;
    const rows = JSON.parse(bytes.toString("utf8"));
    return rows && typeof rows === "object" && !Array.isArray(rows) ? { id, digest, rows } : bad;
  } catch {
    return bad;
  }
}

export const countIdentity = (/** @type {ReturnType<typeof readCount>} */ count) =>
  count?.id ? `${count.id}:${count.digest ?? "-"}` : null;

export function syncDirectory(/** @type {string} */ dir) {
  // Directory fsync is used on the Linux guest. Windows does not open directories this way.
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function syncFile(/** @type {string} */ file) {
  const fd = openSync(file, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function replace(/** @type {string} */ dir, /** @type {string} */ name, /** @type {string | Buffer} */ bytes) {
  const stage = mkdtempSync(join(dirname(dir), ".count-"));
  try {
    const file = join(stage, name);
    writeFileSync(file, bytes, { flush: true });
    renameSync(file, join(dir, name));
    syncDirectory(dir);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function beginCount(/** @type {string} */ dir) {
  const id = randomUUID().replaceAll("-", "");
  mkdirSync(dir, { recursive: true });
  replace(dir, COUNT_RECEIPT, JSON.stringify({ id, digest: null }));
  syncDirectory(dirname(dir));
  syncDirectory(dirname(dirname(dir)));
  return id;
}

export function admitCount(/** @type {string} */ dir, /** @type {string} */ id, /** @type {string} */ staged,
  /** @type {string[]} */ expected, /** @type {number} */ repeats) {
  const pending = readCount(dir);
  if (pending?.id !== id || pending.digest !== null) throw new Error("count receipt changed during the count");
  if (!lstatSync(staged, { throwIfNoEntry: false })?.isFile()) throw new Error("count did not write its private output");
  const bytes = readFileSync(staged);
  const rows = JSON.parse(bytes.toString("utf8"));
  const numeric = (/** @type {unknown} */ value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!rows || typeof rows !== "object" || Array.isArray(rows) || expected.length === 0
    || Object.keys(rows).length !== expected.length || !expected.every((key) => Object.hasOwn(rows, key))
    || !Object.values(rows).every((runs) => Array.isArray(runs)
      ? runs.length === repeats && runs.every((row) => row && numeric(row.userPerRequest)
        && numeric(row.kernelPerRequest) && numeric(row.failed) && (row.kernelPass == null || numeric(row.kernelPass.failed)))
      : typeof runs?.failed === "string" && runs.failed.trim().length > 0)) {
    throw new Error("count output does not cover each requested target and repeat");
  }
  // Until the receipt changes, even an interruption after replacing the rows cannot admit them.
  replace(dir, COUNT_OUTPUT, bytes);
  replace(dir, COUNT_RECEIPT, JSON.stringify({ id, digest: digestOf(bytes) }));
}

const finished = new RegExp(`^\\S+ finished (${idPattern})$`);
const boot = new RegExp(`^\\S+ boot (${idPattern})$`);
export const countFinish = (/** @type {string} */ line) => finished.exec(line)?.[1] ?? null;
export const countBoot = (/** @type {string} */ progress) => boot.exec(progress.split("\n").findLast((line) => /^\S+ boot(?: |$)/.test(line)) ?? "")?.[1] ?? null;

export function checkCountCollection(/** @type {string} */ dir, /** @type {string} */ id) {
  const count = readCount(dir);
  if (!count || count.id !== id) return null;
  try {
    const file = join(dir, "summary.json");
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
    const { countAdmission, instructions } = JSON.parse(readFileSync(file, "utf8"));
    return countAdmission === countIdentity(count) && instructions && typeof instructions === "object"
      && !Array.isArray(instructions) && (count.rows !== null || Object.keys(instructions).length === 0) ? count : null;
  } catch {
    return null;
  }
}
