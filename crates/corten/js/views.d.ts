// The runtime's half of the module of the app's view classes: rows(), view() and the types they
// take. It ships with the crate, so it changes with the app's pin and never in the app's own
// files. The app's generated declarations (corten::types, types/app.d.ts) add one class per
// #[component(view)], with its holes:
//
//   import { Row } from "corten/views";
//   new Row(el).label = "Lamp";
//
// The browser gets the classes from Corten (assets/{version}/views.js, mapped by the import map).
declare module "corten/views" {
  /** What #[component(view)] generates for a component. */
  export interface KeylessViewClass<D, V> {
    new (el: Element): V;
    fill(el: Element, data: D): void;
  }
  /** What #[component(view)] generates for a component whose root has key={..}. */
  export interface ViewClass<D, V> extends KeylessViewClass<D, V> {
    key(el: Element): string;
    /** There when the key is one of the view's holes: then scripts can make its rows. */
    keyOf?(data: D): string;
  }
  const holds: unique symbol;
  /**
   * An element `E` whose children are rows of the view `V` (or a <template> that holds one): the
   * JSDoc type of a handler parameter `rows()` reads, `@param {Holds<Row, HTMLTableSectionElement>} body`
   * (with `@import { Holds } from 'corten/views'`). Corten checks the ref passed for it is on an
   * element the markup fills with `<Row .. />` only.
   */
  export type Holds<V, E extends Element = HTMLElement> = E & { readonly [holds]: V };
  /** Show a server-rendered branch, retaining the current root when its id matches the template. */
  export function view<V extends { el: Element }>(host: Element, View: new (el: Element) => V, template: Holds<NoInfer<V>, HTMLTemplateElement>): V;
  /** The views of every child of a parent element, all made from one component without a key. */
  export interface RowList<V extends { el: Element }> {
    readonly length: number;
    /** The view of the i-th row (a negative `i` counts back from the last), as `Array.prototype.at`; none past either end. */
    at(i: number): V | undefined;
    /** The view of the row that holds `target` (an event's target), if any. */
    of(target: EventTarget | null): V | undefined;
    /** Where the view's row is, or -1. */
    indexOf(view: V): number;
    /** Takes out a row. */
    remove(view: V): void;
    /** Swaps two rows. */
    swap(i: number, j: number): void;
    clear(): void;
    [Symbol.iterator](): IterableIterator<V>;
  }
  /** The rows of a view with a key: found by it too. */
  export interface ServerRows<V extends { el: Element }> extends RowList<V> {
    /** The view of the row with this key, if any. */
    get(key: string): V | undefined;
  }
  /** The rows of a view whose key is one of its holes: scripts make rows too. */
  export interface Rows<D, V extends { el: Element }> extends ServerRows<V> {
    /** Adds rows at the end. */
    push(items: readonly D[]): void;
    /** Shows exactly `items`: rows with a key it had keep their element and are filled again, the rest are made, in `items`' order. */
    replace(items: readonly D[]): void;
  }
  /**
   * The rows under `parent`, each a `View`: the same list every time for one parent, following
   * changes made elsewhere. New rows are clones of the one row in `template`. A view whose key is
   * also shown outside its holes gets `ServerRows`, and one without a key `RowList`: the server
   * makes their rows, and only a key finds one.
   */
  export function rows<D, V extends { el: Element }>(parent: Holds<V, Element>, View: ViewClass<D, V> & { keyOf(data: D): string }, template?: Holds<V, HTMLTemplateElement>): Rows<D, V>;
  export function rows<D, V extends { el: Element }>(parent: Holds<V, Element>, View: ViewClass<D, V>): ServerRows<V>;
  export function rows<D, V extends { el: Element }>(parent: Holds<V, Element>, View: KeylessViewClass<D, V> & { key?: never }): RowList<V>;
}
