import { firstFrameLook } from "./firstFrame";

describe("firstFrameLook", () => {
  it("takes the note's colour and opacity from the page URL", () => {
    expect(firstFrameLook("?color=%23CFE3FF&opacity=85")).toEqual({ color: "#cfe3ff", appearance: { opacity: 85 } });
    expect(firstFrameLook("?color=%23cfe3ff")).toEqual({ color: "#cfe3ff", appearance: {} });
  });

  it("falls back to lemon at full opacity for anything else", () => {
    expect(firstFrameLook("")).toEqual({ color: "#fff4a3", appearance: {} });
    for (const search of ["?color=red", "?color=%23cfe3ff;x", "?color=%23cfe3ff&opacity=50", "?color=%23cfe3ff&opacity=87", "?color=%23cfe3ff&opacity=100"]) {
      const look = firstFrameLook(search);
      expect(look.appearance).toEqual({});
      if (!search.includes("%23cfe3ff")) expect(look.color).toBe("#fff4a3");
    }
  });
});
