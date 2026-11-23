import { engine, skip, check, choiceTargets, choiceTargetsFit } from "./helpers.mjs";

export async function switchControl(orders, ordersErrors) {
  // A switch is drawn as one only with its role: what is drawn is what a screen reader says.
  const drawnSwitch = await orders.evaluate(() => {
    const sw = /** @type {HTMLInputElement} */ (document.querySelector('input[role="switch"]'));
    const look = () => ({ appearance: getComputedStyle(sw).appearance, width: Math.round(parseFloat(getComputedStyle(sw).width)) });
    const role = look();
    sw.removeAttribute("role");
    const plain = look();
    sw.setAttribute("role", "switch");
    return { role, plain };
  });
  // A switch is a pill wider than a checkbox's box.
  check(
    "Switch: drawn as a switch only with role=switch",
    drawnSwitch.role.appearance === "none" && drawnSwitch.role.width > 20 && drawnSwitch.plain.appearance === "auto" && drawnSwitch.plain.width < 20,
    JSON.stringify(drawnSwitch),
  );
  const switchTargets = await orders.evaluate(choiceTargets, "label[class*='switch__switch']");
  check(
    "Switch: the label, the whole target, is --control-height on one line (the kit's, a 44 px theme's, a dense theme's one line), the switch on the first line's middle when it wraps, and an app's own min-height on it adds nothing",
    switchTargets.kit.length === 1 && choiceTargetsFit(switchTargets),
    JSON.stringify(switchTargets),
  );
  await orders.getByLabel("Ship from").selectOption("toronto");
  await orders.getByRole("switch", { name: "Email me when an order ships" }).uncheck();
  await orders.getByRole("button", { name: "Save settings" }).click();
  if (engine !== "webkit") {
    await orders.locator("#ui-toast:not([hidden])").waitFor({ timeout: 5000 }).catch(() => {});
    const saved = await orders.locator("#ui-toast").textContent();
    check("Select, SegmentedRadios, Slider, Switch and Textarea post with the form", saved === "Saved: ships from Toronto, ON in 2 days on Letter labels with your note; shipping emails off.", saved ?? "");
  } else skip("Select, SegmentedRadios, Slider, Switch and Textarea post with the form", "Playwright's WebKit never sends a Secure cookie back over http");
  check("the orders page: no console errors", ordersErrors.length === 0, ordersErrors.join(" | "));
  await orders.context().close();
}
