import "@testing-library/jest-dom/vitest";

// jsdom has no layout engine. ProseMirror asks for client rects when it
// scrolls the selection into view, so give it empty ones in tests.
const emptyRects = () => {
  const list = [] as unknown as DOMRectList;
  (list as unknown as { item: () => null }).item = () => null;
  return list;
};
const zeroRect = () => new DOMRect(0, 0, 0, 0);
for (const proto of [Range.prototype, Element.prototype, Text.prototype as unknown as Element]) {
  const p = proto as unknown as { getClientRects?: unknown; getBoundingClientRect?: unknown };
  p.getClientRects ??= emptyRects;
  p.getBoundingClientRect ??= zeroRect;
}
document.elementFromPoint ??= () => null;
