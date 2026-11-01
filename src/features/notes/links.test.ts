import cases from "../../../tests/fixtures/links.json";
import { isSafeLink, normalizeLink } from "./links";

describe("links", () => {
  it.each(cases)("shared case $href -> $safe (same answer as Rust)", ({ href, safe }) => {
    expect(isSafeLink(href)).toBe(safe);
  });

  it("accepts only http, https and mailto", () => {
    expect(isSafeLink("https://example.org")).toBe(true);
    expect(isSafeLink("HTTP://EXAMPLE.ORG")).toBe(true);
    expect(isSafeLink("mailto:a@b.c")).toBe(true);
    expect(isSafeLink("javascript:alert(1)")).toBe(false);
    expect(isSafeLink(" javascript:alert(1)")).toBe(false);
    expect(isSafeLink("java\tscript:alert(1)")).toBe(false);
    expect(isSafeLink("file:///etc/passwd")).toBe(false);
    expect(isSafeLink("data:text/html,x")).toBe(false);
  });

  it("normalizes typed input", () => {
    expect(normalizeLink("example.org/path")).toBe("https://example.org/path");
    expect(normalizeLink("me@example.org")).toBe("mailto:me@example.org");
    expect(normalizeLink("https://x.y")).toBe("https://x.y");
    expect(normalizeLink("javascript:alert(1)")).toBeNull();
    expect(normalizeLink("   ")).toBeNull();
    expect(normalizeLink("a\u0085b.org")).toBeNull();
  });
});
