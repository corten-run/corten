// The parts of the Navigation API (https://html.spec.whatwg.org/multipage/nav-history-apis.html)
// the runtime uses that TypeScript 5.9's DOM library, the repository's, does not declare: it has
// `NavigationHistoryEntry` and `NavigationType`, not `window.navigation` or its events. Types
// only: it ships with the crate so the runtime's JSDoc can name them, and nothing imports it at
// run time. TypeScript 6.0's library declares the API, with `NavigateEvent.info` as `any`; once
// the repository is on it, this goes and the runtime casts `info` to its own type alone.

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
