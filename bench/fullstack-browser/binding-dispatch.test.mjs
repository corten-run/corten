// Safe local controls: candidate effects are never executed by discovery.
import test from "node:test";
import assert from "node:assert/strict";
import { discoverReactEndpoint } from "./bindings.mjs";
import { denseBindingEntries } from "./binding-links.mjs";

const endpoint = '"/api/marketplace/"+r.id+"?locale="+l';
function candidate(expression, prefix = "", componentPrefix = "") {
  const handlerSource = `async e=>{${prefix}return ${expression}}`, base = "http://local";
  return { handlerSource, componentSource: `function M({record:r,locale:l}){${componentPrefix}const submit=${handlerSource};return null}`,
    base, action: base + "/marketplace/fr-FR/item_2", recordId: "item_2", locale: "fr-FR" };
}

test("dispatch evaluation: every fetch argument and option must be supported", async (t) => {
  for (const [name, options, extra = "", prefix = "", componentPrefix = ""] of [
    ["body call", '{method:"POST",body:unknown()}'],
    ["body await", '{method:"POST",body:await unknown()}'],
    ["body accessor", '{method:"POST",body:unknown.value}'],
    ["body comma", '{method:"POST",body:(unknown(),"safe")}'],
    ["body throwing coercion", '{method:"POST",body:String(unknown)}'],
    ["nested field call", '{method:"POST",body:new URLSearchParams({email:unknown()})}'],
    ["nested field await", '{method:"POST",body:new URLSearchParams({email:await unknown()})}'],
    ["nested field accessor", '{method:"POST",body:new URLSearchParams({email:unknown.value})}'],
    ["nested field spread", '{method:"POST",body:new URLSearchParams({...unknown})}'],
    ["nested field getter", '{method:"POST",body:new URLSearchParams({get email(){return "safe"}})}'],
    ["nested computed key", '{method:"POST",body:new URLSearchParams({[unknown()]:"safe"})}'],
    ["duplicate body", '{method:"POST",body:unknown(),body:"safe"}'],
    ["unknown header call", '{method:"POST",headers:unknown()}'],
    ["unknown option getter", '{method:"POST",get headers(){return "safe"}}'],
    ["unknown signal", '{method:"POST",signal:unknown}'],
    ["extra call", '{method:"POST"}', ',unknown()'],
    ["extra await", '{method:"POST"}', ',await unknown()'],
    ["extra accessor", '{method:"POST"}', ',unknown.value'],
    ["spread arguments", '{method:"POST"}', ',...unknown'],
    ["optional dispatch", '{method:"POST"}'],
    ["unproved form receiver", '{method:"POST",body:new URLSearchParams({email:String(form.get("email")??"")})}'],
    ["String shadow", '{method:"POST",body:String("safe")}', "", "", 'const String=unknown;'],
    ["URLSearchParams shadow", '{method:"POST",body:new URLSearchParams({email:"safe"})}', "", "", 'const URLSearchParams=unknown;'],
    ["FormData extra arguments", '{method:"POST",body:new FormData(e.currentTarget,unknown())}'],
    ["FormData wrong event", '{method:"POST",body:new FormData(unknown.currentTarget)}'],
    ["form get extra arguments", '{method:"POST",body:String(form.get("email",unknown()))}', "", 'const form=new FormData(e.currentTarget);'],
    ["String extra arguments", '{method:"POST",body:String("safe",unknown())}'],
    ["search extra arguments", '{method:"POST",body:new URLSearchParams({email:"safe"},unknown())}'],
    ["form field unresolved", '{method:"POST",body:String(form.get("unproved"))}', "", 'const form=new FormData(e.currentTarget);'],
  ]) await t.test(name, () => {
    const c = candidate(`fetch${name === "optional dispatch" ? "?." : ""}(${endpoint},${options}${extra})`, prefix, componentPrefix);
    assert.equal(discoverReactEndpoint([c]), null);
  });
  await t.test("form receiver shadow", () => {
    const handlerSource = `async e=>{const form=new FormData(e.currentTarget);{const form="safe";return fetch(${endpoint},{method:"POST",body:String(form.get("email"))})}}`;
    const c = candidate("null"); c.handlerSource = handlerSource;
    c.componentSource = `function M({record:r,locale:l}){const submit=${handlerSource};return null}`;
    assert.equal(discoverReactEndpoint([c]), null);
  });
  for (const [name, body, prefix = ""] of [
    ["literal body", '"safe"'],
    ["scalar local", 'value', 'const value="safe";'],
    ["native form", 'form', 'const form=new FormData(e.currentTarget);'],
    ["native search record", 'new URLSearchParams({email:String(form.get("email")??""),target_price:String(form.get("target_price")??"")})', 'e.preventDefault();const form=new FormData(e.currentTarget);'],
    ["native search literal", 'new URLSearchParams("email=safe")'],
  ]) await t.test(name, () => assert.equal(discoverReactEndpoint([candidate(`fetch(${endpoint},{method:"POST",body:${body}})`, prefix)])?.path, "/api/marketplace/item_2"));
});

const length = (value) => ({ name: "length", isOwn: true, value: { type: "number", value } });
const entry = (name, value = "safe") => ({ name: String(name), isOwn: true, value: { type: "string", value } });
test("native array descriptors require complete bounded own indexes", async (t) => {
  assert.deepEqual(denseBindingEntries([entry(1), length(2), entry(0)]).map((p) => p.name), ["0", "1"]);
  assert.deepEqual(denseBindingEntries([length(0)]), []);
  for (const [name, descriptors] of [
    ["all holes", [length(2)]], ["leading hole", [length(2), entry(1)]], ["trailing hole", [length(2), entry(0)]],
    ["middle hole", [length(3), entry(0), entry(2)]], ["missing length", [entry(0)]],
    ["duplicate index", [length(2), entry(0), entry(0)]], ["out of bounds", [length(1), entry(1)]],
    ["inherited index", [length(1), { ...entry(0), isOwn: false }]],
    ["accessor index", [length(1), { ...entry(0), get: {} }]],
    ["huge length", [length(2 ** 32 - 1)]], ["fractional length", [length(1.5)]],
    ["unproved length", [{ ...length(0), isOwn: false }]], ["named property", [length(1), entry("extra")]],
  ]) await t.test(name, () => assert.throws(() => denseBindingEntries(descriptors)));
});
