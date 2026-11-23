import { engine, check } from "./helpers.mjs";

export async function statusDot(orders) {
  // StatusDot: drawn beside the words, not read; Stack and Cluster: the gap is the space.
  const spacing = await orders.evaluate(() => {
    const dot = document.querySelector("[class*='status-dot__dot']");
    const stack = document.querySelector("form[class*='stack__stack']");
    return {
      dot: dot?.getAttribute("aria-hidden") === "true" && (dot.parentElement?.textContent ?? "").includes("Taking orders"),
      // Gap::Lg, 1.5rem.
      gap: stack ? parseFloat(getComputedStyle(stack).rowGap) / parseFloat(getComputedStyle(document.documentElement).fontSize) : "missing",
      // A paragraph's default margins (1em) are dropped: the form has one among its fields.
      paragraph: stack?.querySelector(":scope > p") ? 1 : 0,
      margins: stack ? [...stack.children].filter((c) => parseFloat(getComputedStyle(c).marginBlockStart) + parseFloat(getComputedStyle(c).marginBlockEnd) !== 0).length : -1,
    };
  });
  check("StatusDot and Stack: the dot is not read, and a stack's gap is its only space", spacing.dot && spacing.gap === 1.5 && spacing.paragraph === 1 && spacing.margins === 0, JSON.stringify(spacing));
  // StatusTone::Text: a dot in a badge is the badge's text color, in a soft badge and a solid one,
  // where a dot in the badge's own tone would be the color of the fill.
  const dotInBadge = await orders.evaluate(() => {
    const dot = /** @type {HTMLElement | null} */ (document.querySelector("[class*='status-dot__text']"));
    if (!dot?.parentElement) return { missing: true };
    const badge = dot.parentElement;
    const drawn = () => ({ dot: getComputedStyle(dot).backgroundColor, text: getComputedStyle(badge).color, fill: getComputedStyle(badge).backgroundColor });
    const soft = drawn();
    const was = badge.className;
    badge.className = was.replace(/badge__soft/, "badge__solid");
    const solid = drawn();
    badge.className = was;
    // Beside plain text, a dot in a status's own tone is the theme's color for it.
    const own = document.querySelector("[class*='orders__schedule'] > [class*='status-dot__success']");
    const probe = document.createElement("span");
    probe.style.setProperty("background", "var(--success)");
    document.body.append(probe);
    const success = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { soft, solid, swapped: was.includes("badge__soft"), own: own && getComputedStyle(own).backgroundColor, success };
  });
  check(
    "StatusDot: StatusTone::Text draws the dot in its badge's text color, so it shows on a solid badge's fill, and a Success dot beside text is the theme's success color",
    !("missing" in dotInBadge) &&
      dotInBadge.swapped &&
      dotInBadge.soft.dot === dotInBadge.soft.text &&
      dotInBadge.solid.dot === dotInBadge.solid.text &&
      dotInBadge.solid.dot !== dotInBadge.solid.fill &&
      dotInBadge.own === dotInBadge.success &&
      dotInBadge.own !== "rgba(0, 0, 0, 0)",
    JSON.stringify(dotInBadge),
  );
  // --status-dot-size sizes StatusDot and LiveDot through the rule they share: the theme's .5rem,
  // then a design system's .375rem set once on the root.
  const dotSize = await orders.evaluate(() => {
    const root = document.documentElement;
    const rem = parseFloat(getComputedStyle(root).fontSize);
    const dots = [...document.querySelectorAll("[class*='status-dot__dot']")];
    const still = dots.find((d) => !d.className.includes("status-dot__live"));
    const live = dots.find((d) => d.className.includes("status-dot__live"));
    if (!still || !live) return { missing: dots.length };
    const sized = () => [still, live].map((d) => { const r = d.getBoundingClientRect(); return [r.width / rem, r.height / rem]; });
    const theme = sized();
    root.style.setProperty("--status-dot-size", ".375rem");
    const set = sized();
    root.style.removeProperty("--status-dot-size");
    return { theme, set };
  });
  check(
    "StatusDot and LiveDot: --status-dot-size sizes both, .5rem in the kit's theme",
    !("missing" in dotSize) && dotSize.theme.flat().every((s) => Math.abs(s - 0.5) < 0.01) && dotSize.set.flat().every((s) => Math.abs(s - 0.375) < 0.01),
    JSON.stringify(dotSize),
  );
  // LiveDot: inside a <corten-live> whose stream is live it pulses (an opacity animation that
  // runs), and is still while the stream is not live, outside one, for a user who asks for less
  // motion; under forced colors it pulses as Progress's sweep moves. The element is made, read and
  // removed in one task, so its stream is closed before it is fetched (a 204 if it is).
  await orders.route("**/live-dot-check", (route) => route.fulfill({ status: 204 }).catch(() => {}));
  const dotPulse = () =>
    orders.evaluate(() => {
      const dot = /** @type {HTMLElement} */ (document.querySelector("[class*='status-dot__live']"));
      const running = () => dot.getAnimations().filter((a) => a instanceof CSSAnimation && a.animationName === "status-dot-live" && a.playState === "running").length;
      const badge = /** @type {HTMLElement} */ (dot.parentElement);
      const said = () => badge.innerText.trim();
      const alone = running();
      const aloneSaid = said();
      const live = document.createElement("corten-live");
      live.setAttribute("src", "/live-dot-check");
      badge.replaceWith(live);
      live.append(badge);
      /** @type {Record<string, number>} */
      const by = {};
      /** @type {Record<string, string>} */
      const words = {};
      let opacity = false;
      for (const status of ["connecting", "live", "reconnecting", "closed", "ended"]) {
        live.setAttribute("status", status);
        by[status] = running();
        words[status] = said();
        const pulse = dot.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === "status-dot-live");
        opacity ||= !!pulse?.effect && /** @type {KeyframeEffect} */ (pulse.effect).getKeyframes().some((k) => "opacity" in k);
      }
      live.replaceWith(badge);
      return { alone, by, opacity, aloneSaid, words };
    });
  // Asked for, since the default follows the machine's own setting.
  await orders.emulateMedia({ reducedMotion: "no-preference" });
  const dotMoving = await dotPulse();
  await orders.emulateMedia({ reducedMotion: "reduce" });
  const dotReduced = await dotPulse();
  await orders.emulateMedia({ reducedMotion: "no-preference" });
  const dotForced = engine === "webkit" ? null : (await orders.emulateMedia({ forcedColors: "active" }), await dotPulse());
  await orders.emulateMedia({ reducedMotion: null, forcedColors: engine === "webkit" ? undefined : "none" });
  const onlyLive = (/** @type {{ alone: number, by: Record<string, number> }} */ p) =>
    p.alone === 0 && p.by.live === 1 && ["connecting", "reconnecting", "closed", "ended"].every((s) => p.by[s] === 0);
  check(
    "LiveDot: the badge's words say Live only inside a live stream, and Not live outside one and in every other state",
    dotMoving.aloneSaid === "Not live" && Object.entries(dotMoving.words).every(([s, w]) => w === (s === "live" ? "Live" : "Not live")),
    JSON.stringify({ alone: dotMoving.aloneSaid, words: dotMoving.words }),
  );
  check(
    "LiveDot: it pulses only inside a live stream, not for reduced motion, and under forced colors as Progress does",
    dotMoving.opacity && onlyLive(dotMoving) && dotReduced.alone === 0 && Object.values(dotReduced.by).every((n) => n === 0) && (dotForced === null || onlyLive(dotForced)),
    JSON.stringify({ moving: dotMoving, reduced: dotReduced, forced: dotForced }),
  );
}
