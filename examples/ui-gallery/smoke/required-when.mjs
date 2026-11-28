import { check } from "./helpers.mjs";

export async function requiredWhen(page) {
  // RequiredWhen: the lowest offer applies only to offers.
  const floor = page.getByLabel("Lowest offer");
  const floorRequired = () => floor.evaluate((i) => /** @type {HTMLInputElement} */ (i).required);
  check("for a fixed price the lowest offer is disabled and not required", (await floor.isDisabled()) && !(await floorRequired()));
  return { floor, floorRequired };
}
