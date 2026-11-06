// Tests for outline.mjs: node --test bench/fullstack/outline.test.mjs (npm run check runs it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { firstDifference, outline } from "./outline.mjs";

test("an outline is the body's elements with their classes, indented by depth", () => {
  const html = '<!DOCTYPE html><html><head><title>t</title><link rel="stylesheet" href="/a.css"></head><body><header class="bar"><a href="/">Home</a></header><main><h1 class="a b">Hi</h1></main></body></html>';
  assert.deepEqual(outline(html), ["header.bar", '  a [href="/"]', "main", "  h1.a.b"]);
});

test("a div without a class or role and a custom element stand for their children", () => {
  assert.deepEqual(outline('<div><astro-island uid="1"><p class="x">a</p></astro-island></div><div role="img" aria-label="i"></div>'), ["p.x", 'div [role="img" aria-label="i"]']);
});

test("scripts, templates, comments, hidden elements and hidden inputs are left out", () => {
  const html = '<p>a<!-- c --></p><script>x</script><template><tr><td>1</td></tr></template><button type="button"><span>Up</span><span hidden><b>Down</b></span></button><form method="post"><input type="hidden" name="_token" value="z"><input type="email" name="email" required></form><form method="GET"><button name="offers" value="all">Show all</button></form>';
  assert.deepEqual(outline(html), ["p", 'button [type="button"]', "  span", 'form [method="post"]', '  input [type="email" name="email"]', 'form [method="get"]', '  button [name="offers" value="all"]']);
});

test("framework attributes are ignored, and quoted > or entities do not confuse it", () => {
  const a = outline('<form method="post" hx-post="/x" wire:submit="save" phx-submit="s" data-x="a>b"><label>E<input type="email" name="email"></label></form><a href="/items/a&amp;b">x</a>');
  const b = outline('<form method="post" action="/x"><label>E<input name="email" type="email" value=""></label></form><a href="/items/a&b">x</a>');
  assert.deepEqual(a, b);
});

test("LiveView's state classes are ignored, and a method is compared in lower case", () => {
  assert.deepEqual(outline('<div class="phx-connected"><p class="x phx-click-loading">a</p></div><form method="POST"></form>'), ["p.x", 'form [method="post"]']);
});

test("an end tag left out closes with its parent", () => {
  assert.deepEqual(outline("<ul><li>a<li>b</ul><p>c"), ["ul", "  li", "  li", "p"]);
});

test("firstDifference names the first line that differs, with its neighbors", () => {
  assert.equal(firstDifference(["a", "b"], ["a", "b"]), null);
  assert.deepEqual(firstDifference(["a", "b", "c"], ["a", "x", "c"]), { line: 2, expected: ["a", "b", "c"], actual: ["a", "x", "c"] });
  assert.equal(firstDifference(["a"], ["a", "b"])?.line, 2);
});
