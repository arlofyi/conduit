import { imageDataUri } from "./image";

describe("imageDataUri", () => {
  it("builds a data URI for allowlisted raster types", () => {
    expect(imageDataUri("image/png", "AAAA")).toBe("data:image/png;base64,AAAA");
    for (const t of ["image/jpeg", "image/gif", "image/webp"]) {
      expect(imageDataUri(t, "x")).toBe(`data:${t};base64,x`);
    }
  });
  it("refuses everything else", () => {
    expect(imageDataUri("image/svg+xml", "AAAA")).toBeNull();
    expect(imageDataUri("text/html", "AAAA")).toBeNull();
    expect(imageDataUri("image/png;foo", "AAAA")).toBeNull();
    expect(imageDataUri("image/png", null)).toBeNull();
    expect(imageDataUri("image/png", "")).toBeNull();
  });
});
