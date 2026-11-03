// @ts-check
// corten/keys: shortcut(), for a page-wide shortcut's handler. A module of its own (built to
// js/dist/keys.js), served only to apps whose scripts import it and preloaded only with them, so a
// page without shortcuts does not pay for it.

/** Keys that move within a field or a widget. */
const MOVE = /^(Arrow|Home$|End$|Page)/;
/** Keys that edit a field, whatever is held with them. */
const EDIT = /^(Backspace|Delete)$/;
/** Inputs that do not take text. */
const NOT_TEXT = /^(checkbox|radio|button|submit|reset|image|file|color|range)$/;
/** Elements that take typed text (a select picks an option from it), besides inputs. */
const TEXT = "textarea,select,[role=textbox],[role=combobox],[role=searchbox],[role=spinbutton]";
/** Space and Enter press these. */
const PRESSED =
  "a[href],button,input,summary,[role=button],[role=link],[role=checkbox],[role=switch],[role=radio],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=tab],[role=treeitem]";
/** The arrows, Home, End and the page keys move within these, and a letter finds an item in the composite ones. */
const COMPOSITE = "[role=listbox],[role=menu],[role=menubar],[role=tree],[role=treegrid],[role=grid],[role=radiogroup],[role=tablist]";
const MOVES = `input[type=radio],input[type=range],[role=slider],[role=radio],${COMPOSITE}`;
/** What has keys of its own while focus is in it. */
const LAYER = "dialog,[popover],[role=dialog],[role=alertdialog]";

/**
 * The key a page-wide shortcut may take, or `null` when the key belongs to something else.
 *
 * It is `null` for: a key a handler already took (`defaultPrevented`); an IME composing a
 * character; a character typed with AltGr; a key pressed in a dialog or popover (native, or
 * `role=dialog`), or anywhere while a modal dialog is open, unless `scope` is inside it; a key
 * from outside `scope`, when given; in a field that takes text (an input that does, `textarea`,
 * `select`, `contenteditable`, a `textbox`, `combobox`, `searchbox` or `spinbutton`), any key
 * without Control or Meta, and the arrows, Home, End, page keys, Backspace and Delete with them;
 * Space and Enter on something they press (a link, a button, any input, `summary`, or an element
 * with a control's role); the arrows, Home, End and page keys on a radio button or a slider, or
 * in a list box, menu, tree, grid, radio group or tab list, where a letter (finding an item) is
 * the widget's too. A key pressed with nothing focused (the page's background) is the page's.
 *
 * Otherwise it is `KeyboardEvent.key` after the modifiers held, joined with `+` in the order
 * Control, Alt, Shift, Meta, so a shortcut compares one string: `"p"`, `"Control+Shift+S"`,
 * `"ArrowLeft"`, `"Shift+Space"`. The space bar is `"Space"` and the plus key `"Plus"`. A letter
 * is lowercase, or uppercase with Shift (`"Shift+P"`), whatever Caps Lock says. Another
 * character is as typed, without Shift, since layouts differ on which characters need it: `"?"`,
 * `"/"`. Ctrl on Windows and Linux is Cmd on a Mac, so a shortcut that takes either compares both
 * (`"Control+s"`, `"Meta+s"`), and Option on a Mac types another character, so a letter's
 * shortcut takes Control or Meta rather than Alt.
 * @param {KeyboardEvent} event
 * @param {Element} [scope] the element whose shortcut it is; keys from outside it are not
 * @returns {string | null}
 */
export function shortcut(event, scope) {
  // 229: Safari's keydown that ends a composition.
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  const raw = event.key;
  const char = raw.length === 1;
  const altGraph = event.getModifierState("AltGraph");
  if (altGraph && char) return null;
  const control = event.ctrlKey || event.metaKey;
  const path = event.composedPath();
  // The element focused, inside a shadow root too.
  const target = path.find((node) => node instanceof Element);
  const page = !target || target === document.body || target === document.documentElement;
  if (scope && !page && !path.includes(scope)) return null;
  const layer = /** @type {Element | undefined} */ (path.find((node) => node instanceof Element && node.matches(LAYER))) ?? document.querySelector(":modal");
  if (layer && !(scope && layer.contains(scope))) return null;
  if (!page && target) {
    const field = target instanceof HTMLInputElement ? !NOT_TEXT.test(target.type) : (target instanceof HTMLElement && target.isContentEditable) || target.matches(TEXT);
    if (field && (!control || MOVE.test(raw) || EDIT.test(raw))) return null;
    if ((raw === " " || raw === "Enter") && target.closest(PRESSED)) return null;
    if (MOVE.test(raw) && target.closest(MOVES)) return null;
    if (char && !control && target.closest(COMPOSITE)) return null;
  }
  const letter = char && raw.toLowerCase() !== raw.toUpperCase();
  const key = raw === " " ? "Space" : raw === "+" ? "Plus" : letter ? (event.shiftKey ? raw.toUpperCase() : raw.toLowerCase()) : raw;
  // A named key (Space, ArrowLeft) keeps Shift; a character other than a letter has it in its value.
  const shift = event.shiftKey && (letter || !char || raw === " ");
  return (event.ctrlKey ? "Control+" : "") + (event.altKey ? "Alt+" : "") + (shift ? "Shift+" : "") + (event.metaKey ? "Meta+" : "") + key;
}