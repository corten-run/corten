import { engine, skip, check, spacedLikeButton } from "./helpers.mjs";
import { liveRegion } from "../../../scripts/smoke/live-region.mjs";

export async function button(page, floor, lastResult, floorGroup, qty) {
  // An Icon beside a button's text: the button's gap (.5rem) before the text, its middle on the
  // text's middle.
  const buttonIcon = await page.getByRole("button", { name: "All sales" }).evaluate((b) => {
    const svg = /** @type {Element} */ (b.querySelector("svg"));
    const text = document.createRange();
    text.selectNodeContents(/** @type {Node} */ ([...b.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())));
    const [i, t] = [svg.getBoundingClientRect(), text.getBoundingClientRect()];
    return { gap: t.left - i.right, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) / 2, off: i.top + i.height / 2 - (t.top + t.height / 2) };
  });
  check("Icon: beside a button's text, the button's gap apart and on the text's middle", spacedLikeButton(buttonIcon), JSON.stringify(buttonIcon));
  // A busy Button (the runtime marks the one that sent a form, #1063): a ring after the label in
  // the text's color, turning unless the user asks for less motion, and drawn under forced colors.
  const busyButton = page.getByRole("button", { name: "List for sale" });
  const ring = () =>
    busyButton.evaluate((b) => {
      const s = getComputedStyle(b, "::after");
      return {
        content: s.content,
        border: s.borderTopStyle,
        color: s.borderTopColor,
        text: getComputedStyle(b).color,
        end: s.borderRightColor,
        animation: s.animationName,
        running: document
          .getAnimations()
          .filter((a) => /** @type {CSSAnimation} */ (a).animationName === "button-busy" && /** @type {KeyframeEffect} */ (a.effect)?.target === b && /** @type {KeyframeEffect} */ (a.effect)?.pseudoElement === "::after").length,
        cursor: getComputedStyle(b).cursor,
      };
    });
  const idleRing = await ring();
  await busyButton.evaluate((b) => b.setAttribute("aria-busy", "true"));
  const busyRing = await ring();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stillRing = await ring();
  await page.emulateMedia({ reducedMotion: null });
  /** @type {Awaited<ReturnType<typeof ring>> | null} */
  let forcedBusy = null;
  if (engine !== "webkit") {
    await page.emulateMedia({ forcedColors: "active" });
    forcedBusy = await ring();
    await page.emulateMedia({ forcedColors: "none" });
  }
  await busyButton.evaluate((b) => b.removeAttribute("aria-busy"));
  check(
    "Button: busy, a ring after its label in the text's color that turns, still under reduced motion and drawn under forced colors",
    idleRing.content === "none" &&
      busyRing.content === '""' &&
      busyRing.border === "solid" &&
      busyRing.color === busyRing.text &&
      busyRing.end === "rgba(0, 0, 0, 0)" &&
      busyRing.animation.endsWith("button-busy") &&
      busyRing.running > 0 &&
      busyRing.cursor === "progress" &&
      stillRing.animation === "none" &&
      stillRing.running === 0 &&
      (forcedBusy === null || (forcedBusy.border === "solid" && forcedBusy.color !== "rgba(0, 0, 0, 0)" && forcedBusy.end === "rgba(0, 0, 0, 0)")),
    JSON.stringify({ idleRing, busyRing, stillRing, forcedBusy }),
  );
  // A busy Icon button: the ring takes the icon's place, and a text inside it (a visually hidden
  // name) is not hidden with it.
  const busyIcon = await page.evaluate(() => {
    const icon = /** @type {HTMLElement} */ (document.querySelector("a[aria-labelledby][interestfor]")?.cloneNode(true));
    icon.removeAttribute("interestfor");
    icon.append(Object.assign(document.createElement("span"), { textContent: "Orders" }));
    icon.setAttribute("aria-busy", "true");
    document.querySelector("main")?.append(icon);
    const seen = { svg: getComputedStyle(/** @type {Element} */ (icon.querySelector("svg"))).display, name: getComputedStyle(/** @type {Element} */ (icon.querySelector("span"))).display, ring: getComputedStyle(icon, "::after").content };
    icon.remove();
    return seen;
  });
  check("Button: a busy Icon button draws the ring in its icon's place and keeps a text inside it", busyIcon.svg === "none" && busyIcon.name !== "none" && busyIcon.ring === '""', JSON.stringify(busyIcon));
  // Under forced colors the box shadow is not drawn: the group's outline is the focus ring.
  const forcedRingName = "InputGroup: under forced colors its input's focus draws the group's outline";
  if (engine === "webkit") skip(forcedRingName, "Playwright's WebKit does not emulate forced colors");
  else {
    await page.emulateMedia({ forcedColors: "active" });
    const forcedRing = await floor.evaluate((input) => {
      const style = getComputedStyle(/** @type {HTMLElement} */ (input.parentElement));
      return `${document.activeElement === input} ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
    });
    await page.emulateMedia({ forcedColors: "none" });
    check(forcedRingName, forcedRing.startsWith("true solid 2px ") && !forcedRing.endsWith("rgba(0, 0, 0, 0)"), forcedRing);
  }
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForTimeout(300);
  check("an empty lowest offer stops the form", (await floor.evaluate((i) => /** @type {HTMLInputElement} */ (i).validationMessage)) !== "" && (await page.textContent("#result")) === lastResult);
  const floorRefused = await floorGroup();
  check("InputGroup: a refused input draws the group's border in the destructive color", floorRefused.invalid, JSON.stringify(floorRefused));
  await floor.fill("5");
  await qty.fill("2");
  const { stayed: regionStayed } = await liveRegion(page, "result");
  await page.getByRole("button", { name: "List for sale" }).click();
  await page.waitForFunction(() => document.querySelector("#result")?.textContent?.startsWith("Listed 2"), null, { timeout: 5000 }).catch(() => {});
  check("with a lowest offer the listing is sent", (await page.textContent("#result")) === "Listed 2 Near Mint Ashen Drake at $12.50 each, 0.7 oz to ship.", await page.textContent("#result"));
  check("listing keeps the live region and replaces its message", await regionStayed());
  await page.getByLabel("Fixed price").check();
  check("back to a fixed price, the lowest offer is disabled again", await floor.isDisabled());
}
