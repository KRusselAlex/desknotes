import { isSafeLink, normalizeLink } from "./links";

describe("links", () => {
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
  });
});
