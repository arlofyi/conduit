import { UPDATE_REPO, newerRelease, parseReleases, sizeLabel } from "./update";

const asset = (tag: string, name = `conduit-mobile-${tag}.apk`) => ({
  name,
  size: 52_428_800,
  browser_download_url: `https://github.com/${UPDATE_REPO}/releases/download/${tag}/${name}`,
});

const releases = [
  { tag_name: "v0.51.0", name: "Conduit v0.51.0", draft: false, assets: [asset("v0.51.0", "Conduit.msi")] },
  { tag_name: "mobile-b12", name: "Phone app 1.1.0 (build 12)", body: "- feat: tablets", draft: false, html_url: "https://x/12", published_at: "2026-11-05T10:00:00Z", assets: [asset("mobile-b12")] },
  { tag_name: "mobile-b14", name: "Phone app 1.1.0 (build 14)", draft: true, assets: [asset("mobile-b14")] },
  { tag_name: "mobile-b13", name: "Phone app 1.1.0 (build 13)", draft: false, assets: [asset("mobile-b13")] },
  { tag_name: "mobile-b15", draft: false, assets: [{ name: "x.apk", browser_download_url: "https://evil.example/x.apk" }] },
  { tag_name: "mobile-bx", draft: false, assets: [asset("mobile-bx")] },
  null,
];

describe("phone app releases", () => {
  it("keeps only published mobile-b<build> releases with a GitHub-hosted apk, newest first", () => {
    const r = parseReleases(releases);
    expect(r.map((x) => x.build)).toEqual([13, 12]);
    expect(r[1]).toMatchObject({
      tag: "mobile-b12",
      title: "Phone app 1.1.0 (build 12)",
      notes: "- feat: tablets",
      pageUrl: "https://x/12",
      apkName: "conduit-mobile-mobile-b12.apk",
      apkSize: 52_428_800,
      publishedAt: Date.parse("2026-11-05T10:00:00Z"),
    });
    expect(parseReleases({ message: "rate limited" })).toEqual([]);
  });
  it("offers only a higher build than the installed one", () => {
    const r = parseReleases(releases);
    expect(newerRelease(r, 12)?.build).toBe(13);
    expect(newerRelease(r, 13)).toBeNull();
    expect(newerRelease([], 1)).toBeNull();
  });
  it("labels sizes", () => {
    expect(sizeLabel(52_428_800)).toBe("50.0 MB");
    expect(sizeLabel(null)).toBeNull();
  });
});
