/**
 * Phone app releases on GitHub: which one is newer than what is installed. Pure: the fetch and the
 * install live in data/appUpdate.ts.
 *
 * The phone ships INSIDE each Conduit release (`.github/workflows/release.yml`): a `vX.Y.Z` tag
 * carries the desktop installers and `conduit-mobile-X.Y.Z-b<build>.apk`, where <build> is the
 * APK's versionCode, read from the asset's name. Prereleases (`vX.Y.Z-rc1`) are never offered.
 * Older releases were tagged `mobile-b<build>` on their own; those are still read, so a phone on
 * one of them sees the move.
 */

/** Where releases are published. A fork changes this one line (and the workflow follows the
 * repository it runs in). */
export const UPDATE_REPO = "arlofyi/conduit";
export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`;

/** a phone-only release from before the move into Conduit releases */
const LEGACY_TAG = /^mobile-b(\d+)$/;
/** a full (not pre-) Conduit release */
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
/** the build number a Conduit release's APK carries in its name */
const APK_BUILD = /-b(\d+)\.apk$/;

export interface MobileRelease {
  build: number;
  tag: string;
  title: string;
  /** release notes (markdown, from the workflow: the commits since the last phone release) */
  notes: string;
  pageUrl: string;
  apkUrl: string;
  apkName: string;
  apkSize: number | null;
  publishedAt: number | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** Every usable phone release in a GitHub `releases` answer, newest build first. Drafts,
 * prereleases, other tags, releases without an `.apk` asset and a Conduit release whose APK names
 * no build are skipped; a GitHub-hosted asset URL is the only one accepted. */
export function parseReleases(json: unknown): MobileRelease[] {
  if (!Array.isArray(json)) return [];
  const out: MobileRelease[] = [];
  for (const r of json) {
    const o = r as Record<string, unknown> | null;
    if (!o || o.draft === true) continue;
    const tag = str(o.tag_name);
    if (!tag || o.prerelease === true) continue;
    const legacy = LEGACY_TAG.exec(tag);
    if (!legacy && !RELEASE_TAG.test(tag)) continue;
    const assets = Array.isArray(o.assets) ? (o.assets as Record<string, unknown>[]) : [];
    const apk = assets.find((a) => {
      const name = str(a?.name);
      const url = str(a?.browser_download_url);
      return !!name && name.endsWith(".apk") && !!url && url.startsWith(`https://github.com/${UPDATE_REPO}/releases/download/`);
    });
    if (!apk) continue;
    const named = APK_BUILD.exec(apk.name as string);
    const build = legacy ? Number(legacy[1]) : named ? Number(named[1]) : NaN;
    if (!Number.isSafeInteger(build) || build <= 0) continue;
    const published = str(o.published_at);
    out.push({
      build,
      tag,
      title: str(o.name) ?? tag,
      notes: str(o.body) ?? "",
      pageUrl: str(o.html_url) ?? `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`,
      apkUrl: apk.browser_download_url as string,
      apkName: apk.name as string,
      apkSize: typeof apk.size === "number" ? apk.size : null,
      publishedAt: published ? Date.parse(published) || null : null,
    });
  }
  return out.sort((a, b) => b.build - a.build);
}

/** The newest release with a higher build than `installed`, or null. */
export function newerRelease(releases: readonly MobileRelease[], installed: number): MobileRelease | null {
  const top = releases[0];
  return top && top.build > installed ? top : null;
}

/** Checked at most this often by itself (Settings' button always checks). */
export const AUTO_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function sizeLabel(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
