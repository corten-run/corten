// @ts-check
// ShipForm (smoke.rs): a handler given a form's fields as its controls, which a component without
// a script draws, and one whose calls name a field their form does not have as it takes it.

/**
 * Fills the package for the service chosen, and writes what it was given into `out`: each
 * control's tag, then the size radios' values.
 * @param {HTMLSelectElement} service @param {HTMLInputElement} weight @param {HTMLTextAreaElement} note
 * @param {HTMLInputElement} gift @param {HTMLInputElement[]} sizes @param {HTMLInputElement} parcel
 * @param {HTMLOutputElement} out
 */
export function fill(service, weight, note, gift, sizes, parcel, out) {
  const air = service.value === "air";
  weight.value = air ? "2" : "9";
  note.value = `by ${service.value}`;
  gift.checked = air;
  for (const size of sizes) size.checked = size.value === (air ? "small" : "large");
  parcel.value = weight.value;
  out.value = [service, weight, note, gift, parcel].map((el) => el.localName).concat(sizes.map((size) => size.value)).join(",");
}

/** Never runs: each call gives it a field its form does not have as an input. @param {HTMLInputElement} weight */
export function weigh(weight) {
  weight.value = "0";
}
