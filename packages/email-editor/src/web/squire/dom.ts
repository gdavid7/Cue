/** The closest element matching the selector, if it is inside root. */
export function closestWithin(node: Node, selector: string, root: Node) {
  const element = node instanceof Element ? node : node.parentElement;
  const match = element?.closest(selector);
  return match && root.contains(match) ? match : null;
}
