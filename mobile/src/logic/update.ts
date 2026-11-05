/**
 * Phone app releases on GitHub (`.github/workflows/mobile-release.yml`): which one is newer than
 * what is installed. Pure: the fetch and the install live in data/appUpdate.ts.
 *
 * A phone release is tagged `mobile-b<build>`, where <build> is the APK's versionCode. Tags are
 * deliberately NOT `v*`: those are the desktop's, and its updater reads `releases/latest`, which
 * phone releases are never marked as.
 */

/** Where releases are published. A fork changes this one line (and the workflow follows the
 * repository it runs in). */
export const UPDATE_REPO = "arlofyi/conduit";
export const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`;

const TAG = /^mobile-b(\d+)$/;

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

/** Every usable phone release in a GitHub `releases` answer, newest build first. Drafts, other
 * tags, and releases without an `.apk` asset are skipped; a GitHub-hosted asset URL is the only
 * one accepted. */
export function parseReleases(json: unknown): MobileRelease[] {
  if (!Array.isArray(json)) return [];
  const out: MobileRelease[] = [];
  for (const r of json) {
    const o = r as Record<string, unknown> | null;
    if (!o || o.draft === true) continue;
    const tag = str(o.tag_name);
    const m = tag ? TAG.exec(tag) : null;
    if (!tag || !m) continue;
    const assets = Array.isArray(o.assets) ? (o.assets as Record<string, unknown>[]) : [];
    const apk = assets.find((a) => {
      const name = str(a?.name);
      const url = str(a?.browser_download_url);
      return !!name && name.endsWith(".apk") && !!url && url.startsWith(`https://github.com/${UPDATE_REPO}/releases/download/`);
    });
    if (!apk) continue;
    const published = str(o.published_at);
    out.push({
      build: Number(m[1]),
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
