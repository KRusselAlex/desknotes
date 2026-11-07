import { describe, expect, it, vi } from "vitest";

const convertFileSrc = vi.fn((id: string, scheme: string) => `${scheme}://localhost/${id}`);
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (id: string, scheme: string) => convertFileSrc(id, scheme),
}));

import { imageIdFromUrl, imageUrl } from "./images";

describe("imageUrl", () => {
  it("is the desknotes-image address from convertFileSrc", () => {
    const id = "b".repeat(64);
    expect(imageUrl(id)).toBe(`desknotes-image://localhost/${id}`);
    expect(convertFileSrc).toHaveBeenCalledWith(id, "desknotes-image");
  });
});

describe("imageIdFromUrl", () => {
  const id = "c".repeat(64);
  it("recovers the id from DeskNotes' own image addresses", () => {
    expect(imageIdFromUrl(`desknotes-image://localhost/${id}`)).toBe(id);
    // The form Windows and Android give the same scheme.
    expect(imageIdFromUrl(`http://desknotes-image.localhost/${id}`)).toBe(id);
    expect(imageIdFromUrl(`https://desknotes-image.localhost/${id}`)).toBe(id);
  });

  it("refuses every other address", () => {
    for (const src of [
      `https://example.com/${id}`,
      `desknotes-image://localhost/${id.toUpperCase()}`,
      `desknotes-image://localhost/${id}/x`,
      `desknotes-image://localhost/${id}?x=1`,
      `desknotes-image://evil/${id}`,
      `http://desknotes-image.localhost.example.com/${id}`,
      `desknotes-image://localhost/${"c".repeat(63)}`,
      `data:image/png;base64,${id}`,
      "",
    ]) {
      expect(imageIdFromUrl(src)).toBeNull();
    }
  });
});
