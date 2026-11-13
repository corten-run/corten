import assert from "node:assert/strict";

export const handlerIntrinsics = ["fetch", "encodeURIComponent", "FormData", "URLSearchParams", "String"];
export const requiredBindingIdentities = [
  "Map", "Array", "URLSearchParams", "FormData", "String", "encodeURIComponent", "Intl", "fetch",
  "NumberFormat", "PluralRules", "ObjectPrototype", "ArrayPrototype", "Array.constructor", "Array.species",
  "Array.map", "Array.filter", "Array.slice", "Array.sort", "Map.get", "Map.set",
  "NumberFormat.format", "PluralRules.select", "String.startsWith", "Search.toString",
];

export function bindingRealm(objectId) {
  assert.equal(typeof objectId, "string");
  const parts = /^(-?\d+)\.([1-9]\d*)\.([1-9]\d*)$/.exec(objectId);
  assert.ok(parts, "Unsupported native object/realm identity");
  return { prefix: `${parts[1]}.${parts[2]}.`, context: Number(parts[2]) };
}

export function validateBindingIdentities(receipt, base) {
  const realm = bindingRealm(receipt.realmObjectId);
  assert.equal(receipt.executionContextId, realm.context, "Native realm/object identity differs");
  assert.ok(Array.isArray(receipt.intrinsicIdentities), "Native intrinsic identities missing");
  for (const name of requiredBindingIdentities)
    assert.ok(receipt.intrinsicIdentities.some((r) => r.label === name), `Native intrinsic identity missing: ${name}`);
  for (const row of receipt.intrinsicIdentities) {
    assert.ok(typeof row.label === "string" && row.label, "Unnamed native intrinsic identity");
    for (const key of ["observed", "snapshot"]) assert.equal(bindingRealm(row[key]).prefix, realm.prefix, "Cross-realm intrinsic identity");
  }
  for (const script of receipt.scripts) {
    assert.equal(script.executionContextId, realm.context, "Executed script/native realm differs");
    const url = new URL(script.url);
    assert.equal(url.origin, new URL(base).origin, "Foreign native script origin");
    assert.equal(url.pathname, script.path, "Native script URL/artifact path differs");
    assert.ok(!url.search && !url.hash, "Aliased native script URL");
  }
}
