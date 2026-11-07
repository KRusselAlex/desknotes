import { describe, expect, it } from "vitest";
import conf from "../../src-tauri/tauri.conf.json";

const csp = String(conf.app.security.csp);
const directives = new Map(
  csp.split(";").map((part) => {
    const [name = "", ...sources] = part.trim().split(/\s+/);
    return [name, sources] as const;
  }),
);

describe("content security policy", () => {
  it("lets images come from the app, data URLs and the desknotes-image scheme only", () => {
    // No http(s) host here: the Windows port (WebView2 serves the scheme as
    // http://desknotes-image.localhost) adds its own CSP when it is built.
    expect(directives.get("img-src")?.join(" ")).toBe("'self' data: desknotes-image:");
  });

  it("allows no web (http: / https:) source except http://ipc.localhost in connect-src", () => {
    const allowed = new Set(["http://ipc.localhost"]);
    for (const [name, sources] of directives) {
      for (const source of sources) {
        if (/^https?:/.test(source)) {
          expect(allowed.has(source), `${name} allows ${source}`).toBe(true);
        }
      }
    }
  });
});
