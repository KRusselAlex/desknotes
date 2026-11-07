// The CSS is read from disk (tests run from the repo root): `?raw` on a .css file comes back empty under vitest's CSS handling.
// @ts-expect-error @types/node is not installed; vitest runs this file in node.
const { readFileSync } = (await import("node:fs")) as { readFileSync: (path: string, encoding: "utf8") => string };

const css = readFileSync("src/styles/settings.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const selectorsWith = (property: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[2] ?? "").includes(property))
    .flatMap((m) => (m[1] ?? "").split(","))
    .map((s) => s.trim());

describe("settings.css", () => {
  it("scopes the Automations card spacing to .dn-auto, not to every settings card (Privacy uses .dn-card-text too)", () => {
    expect(css).toContain(".dn-card-sub");
    expect(selectorsWith("line-height")).toContain(".dn-auto .dn-card-sub");
    expect(selectorsWith("margin-top")).toContain(".dn-auto .dn-card-sub");
    expect(selectorsWith("line-height")).not.toContain(".dn-card-text > .dn-card-sub");
    expect(selectorsWith("margin-top")).not.toContain(".dn-card-text > .dn-card-sub");
  });
});
