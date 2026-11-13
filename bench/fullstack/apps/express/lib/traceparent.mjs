// W3C Trace Context's known fields; unknown future fields are not propagated as v00.
export function traceParent(value) {
  if (typeof value !== "string" || value.includes(",")) return undefined;
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/.exec(value);
  if (!match || match[1] === "ff" || /^0+$/.test(match[2]) || /^0+$/.test(match[3])) return undefined;
  if (value.length !== 55 && (match[1] === "00" || value[55] !== "-")) return undefined;
  return `00${value.slice(2, 55)}`;
}
