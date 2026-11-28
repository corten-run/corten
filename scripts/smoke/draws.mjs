/** @typedef {(selector: string, matches: (element: Element) => boolean, capture: (element: Element) => () => void) => void} Appeared */
/** @typedef {{ tree: Document, target: Node, attribute: string | null, at: number, added: (selector: string) => Element[], appeared: Appeared }} Draw */

/**
 * @param {string[]} attributes
 * @param {(draw: Draw) => void} read
 * @param {(observer: MutationObserver) => void} [finish]
 */
function watchDraws(attributes, read, finish = () => {}) {
  /** @param {MutationRecord[]} records @param {MutationObserver} observer */
  const replay = (records, observer) => {
    if (!records.length) return;
    const at = performance.now();
    // The inert copy starts at delivery. Before undoing each record it is the tree just after
    // that record; readers copy out values, not nodes. Mutations not reported while detached
    // cannot be recovered. Never rewind the live page (or run its lifecycle hooks).
    const tree = /** @type {Document} */ (document.cloneNode(false));
    /** @type {Map<Node, Node>} */
    const copies = new Map([[document, tree]]);
    const children = /** @type {() => NodeListOf<ChildNode>} */ (Object.getOwnPropertyDescriptor(Node.prototype, "childNodes")?.get);
    /** @param {Node} node @returns {Node} */
    const copy = (node) => {
      const known = copies.get(node);
      if (known) return known;
      /** @type {Node} */
      let clone;
      if (node instanceof DocumentType) {
        clone = tree.implementation.createDocumentType(node.name, node.publicId, node.systemId);
      } else if (node instanceof Element && node.localName === "script") {
        // Even detached script elements are TrustedScript sinks. Keep their tag,
        // attributes and children as data, not as an HTML or SVG scripting element.
        const script = tree.createElementNS("urn:corten:smoke", "script");
        for (const attr of node.attributes) {
          if (attr.namespaceURI === null) script.setAttribute(attr.name, attr.value);
          else script.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
        }
        clone = script;
      } else {
        clone = tree.importNode(node, false);
      }
      copies.set(node, clone);
      for (const child of children.call(node)) Node.prototype.appendChild.call(clone, copy(child));
      return clone;
    };
    for (const child of children.call(document)) tree.appendChild(copy(child));
    for (const record of records) {
      copy(record.target);
      for (const node of record.addedNodes) copy(node);
      for (const node of record.removedNodes) copy(node);
    }
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      const target = copy(record.target);
      const added = Array.from(record.addedNodes, copy);
      /** @type {Array<() => void>} */
      const confirmations = [];
      if (tree.contains(target)) read({
        tree, target, attribute: record.attributeName, at,
        added: (selector) => added.flatMap((node) => {
          if (!(node instanceof Element)) return [];
          const descendants = Array.from(Element.prototype.querySelectorAll.call(node, selector));
          if (Element.prototype.matches.call(node, selector)) descendants.unshift(node);
          return descendants;
        }),
        appeared: (selector, matches, capture) => {
          const after = Array.from(tree.querySelectorAll(selector)).filter(matches);
          if (!after.length) return;
          const notes = after.map(capture);
          confirmations.push(() => {
            const index = after.findIndex((node) => !tree.contains(node) ||
              !Element.prototype.matches.call(node, selector) || !matches(node));
            if (index !== -1) notes[index]();
          });
        },
      });
      if (record.type === "childList") {
        for (const node of added) Node.prototype.removeChild.call(target, node);
        const next = record.nextSibling && copy(record.nextSibling);
        for (const node of record.removedNodes) Node.prototype.insertBefore.call(target, copy(node), next);
      } else if (record.type === "characterData") {
        (/** @type {CharacterData} */ (target)).data = record.oldValue ?? "";
      } else if (record.attributeName !== null) {
        if (record.oldValue === null) Element.prototype.removeAttribute.call(target, record.attributeName);
        else Element.prototype.setAttribute.call(target, record.attributeName, record.oldValue);
      }
      for (const confirm of confirmations) confirm();
    }
    finish(observer);
  };
  const observer = new MutationObserver(replay);
  observer.observe(document, {
    subtree: true, childList: true, characterData: true, characterDataOldValue: true,
    ...(attributes.length ? { attributes: true, attributeOldValue: true, attributeFilter: attributes } : {}),
  });
  return {
    disconnect: () => observer.disconnect(),
    take: () => replay(observer.takeRecords(), observer),
  };
}

/**
 * Playwright evaluates the observer without the Node module's scope.
 * @template T
 * @param {(watch: typeof watchDraws, arg: T) => unknown} observe @param {T} arg
 */
export const drawScript = (observe, arg) => `(${observe})(${watchDraws}, ${JSON.stringify(arg)})`;
