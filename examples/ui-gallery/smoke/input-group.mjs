import { check } from "./helpers.mjs";

export async function inputGroup(floor, page, floorRequired) {
  // InputGroup: the lowest offer's "$" is hidden from a screen reader, and inside the group's
  // border before the input (measured once the field is shown); the group draws the border, ring,
  // invalid and disabled states, the input inside none of them, so a disabled one is dimmed once.
  const floorGroup = () =>
    floor.evaluate((input) => {
      const box = /** @type {HTMLElement} */ (input.parentElement);
      const sign = /** @type {HTMLElement} */ (box.firstElementChild);
      // The border and ring are transitioned: read where they end.
      for (const a of box.getAnimations()) a.finish();
      const [b, s, i] = [box, sign, input].map((e) => e.getBoundingClientRect());
      const probe = document.createElement("span");
      probe.style.color = "var(--destructive)";
      box.append(probe);
      const destructive = getComputedStyle(probe).color;
      probe.remove();
      const [style, own] = [getComputedStyle(box), getComputedStyle(input)];
      return {
        inside: s.left >= b.left + 1 && s.right <= i.left + 0.5 && i.right <= b.right - 0.5 && s.top >= b.top && s.bottom <= b.bottom,
        hidden: sign.getAttribute("aria-hidden"),
        borders: `${style.borderTopWidth} ${own.borderTopWidth}`,
        opacity: `${style.opacity} ${own.opacity}`,
        ring: style.boxShadow.includes("3px"),
        ownRing: own.boxShadow,
        invalid: style.borderTopColor === destructive,
      };
    });
  const floorOff = await floorGroup();
  check(
    "InputGroup: its sign is hidden from a screen reader; disabled, the group is dimmed once and draws the border",
    floorOff.hidden === "true" && floorOff.borders === "1px 0px" && floorOff.opacity === "0.5 1" && !floorOff.invalid,
    JSON.stringify(floorOff),
  );
  await page.getByLabel("Accept offers").check();
  check("accepting offers makes the lowest offer required", (await floor.isEnabled()) && (await floorRequired()));
  await floor.focus();
  const floorFocused = await floorGroup();
  check(
    "InputGroup: its sign is inside the border before the input; the input's focus rings the group, and the input draws no ring of its own",
    floorFocused.inside && floorFocused.ring && floorFocused.ownRing === "none" && floorFocused.opacity === "1 1",
    JSON.stringify(floorFocused),
  );
  // A button inside sits within the border: a Sm one, and an Icon one, which alone is the
  // control's height.
  const floorButton = await floor.evaluate((input) => {
    const box = /** @type {HTMLElement} */ (input.parentElement);
    const small = document.querySelector("[class*='button__sm']");
    const at = (/** @type {DOMRect} */ r) => [r.left, r.top, r.right, r.bottom].map((v) => Math.round(v * 10) / 10).join();
    /** @param {string} className */
    const placed = (className) => {
      const find = document.createElement("button");
      find.type = "button";
      find.className = className;
      find.textContent = "Find";
      box.append(find);
      const [b, f, i] = [box, find, input].map((e) => e.getBoundingClientRect());
      find.remove();
      // Within the border: inside the group's padding box, after the input.
      const edge = box.clientTop;
      const inside = f.top >= b.top + edge - 0.5 && f.bottom <= b.bottom - edge + 0.5 && f.right <= b.right - edge + 0.5 && f.left >= i.right - 0.5;
      return inside ? "inside" : `${at(b)} ${at(f)}`;
    };
    const sm = small?.className ?? "";
    return { small: !!small, sm: placed(sm), icon: placed(sm.replace(/(button__)sm\b/, "$1icon")) };
  });
  check("InputGroup: a small or icon button after the input sits within the border", floorButton.small && floorButton.sm === "inside" && floorButton.icon === "inside", JSON.stringify(floorButton));
  return { floorGroup };
}
