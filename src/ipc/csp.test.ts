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
    expect(directives.get("img-src")?.join(" ")).toBe(
      "'self' data: desknotes-image: http://desknotes-image.localhost",
    );
  });

  it("allows no web (http: / https:) source except the two local scheme hosts", () => {
    const allowed = new Set(["http://ipc.localhost", "http://desknotes-image.localhost"]);
    for (const [name, sources] of directives) {
      for (const source of sources) {
        if (/^https?:/.test(source)) {
          expect(allowed.has(source), `${name} allows ${source}`).toBe(true);
        }
      }
    }
  });
});
