// The parts of the Navigation API (https://html.spec.whatwg.org/multipage/nav-history-apis.html)
// the runtime uses, which TypeScript's DOM library (5.9) does not declare yet. Types only: it
// ships with the crate so the runtime's JSDoc can name them, and nothing imports it at run time.
// Remove it once the DOM library declares the API.

export type NavigationType = "push" | "replace" | "reload" | "traverse";

export interface NavigationResult {
  committed: Promise<NavigationHistoryEntry>;
  finished: Promise<NavigationHistoryEntry>;
}

/** `window.navigation`. `I` is the `info` its navigations carry (see NavigateEvent.info). */
export interface Navigation<I = unknown> extends EventTarget {
  readonly currentEntry: NavigationHistoryEntry | null;
  readonly transition: { readonly navigationType: NavigationType } | null;
  entries(): NavigationHistoryEntry[];
  navigate(url: string, options?: { history?: "auto" | "push" | "replace"; info?: I }): NavigationResult;
  back(): NavigationResult;
  addEventListener(type: "navigate", listener: (event: NavigateEvent<I>) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

export interface NavigationPrecommitController {
  redirect(url: string): void;
}

export interface NavigationInterceptOptions {
  handler?: () => Promise<void>;
  precommitHandler?: (controller: NavigationPrecommitController) => Promise<void>;
  scroll?: "after-transition" | "manual";
  focusReset?: "after-transition" | "manual";
}

export interface NavigateEvent<I = unknown> extends Event {
  readonly navigationType: NavigationType;
  readonly destination: { readonly url: string; readonly sameDocument: boolean };
  readonly canIntercept: boolean;
  readonly hashChange: boolean;
  readonly downloadRequest: string | null;
  readonly formData: FormData | null;
  readonly sourceElement: Element | null;
  readonly signal: AbortSignal;
  /**
   * What `navigate(url, { info })` passed, from any script on the page. Typed as the runtime's
   * own (`I`), whose keys are symbols of its module: another script's value has none of them, so
   * each read (`info?.[KEY]`) gives undefined there, as the type allows.
   */
  readonly info: I | undefined;
  intercept(options?: NavigationInterceptOptions): void;
}
