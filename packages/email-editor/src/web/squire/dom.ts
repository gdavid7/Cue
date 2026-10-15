/** The nearest element matching selector around node, if it is in root. */
export function closestWithin(node: Node, selector: string, root: Element) {
  const element = node instanceof Element ? node : node.parentElement;
  const match = element?.closest(selector);
  return match && root.contains(match) ? match : null;
}
