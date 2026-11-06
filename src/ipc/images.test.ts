import { describe, expect, it, vi } from "vitest";

const convertFileSrc = vi.fn((id: string, scheme: string) => `${scheme}://localhost/${id}`);
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (id: string, scheme: string) => convertFileSrc(id, scheme),
}));

import { imageUrl } from "./images";

describe("imageUrl", () => {
  it("is the desknotes-image address from convertFileSrc", () => {
    const id = "b".repeat(64);
    expect(imageUrl(id)).toBe(`desknotes-image://localhost/${id}`);
    expect(convertFileSrc).toHaveBeenCalledWith(id, "desknotes-image");
  });
});
