/** Raster types the phone will render inline. Same allowlist as desktop's
 * SessionChat: anything else (SVG, HTML, a type with parameters) is refused. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A `data:` URI for an inline image, or null when it must show as a pill. */
export function imageDataUri(mediaType: string, data: string | null): string | null {
  if (!data || !RASTER.has(mediaType)) return null;
  return `data:${mediaType};base64,${data}`;
}
