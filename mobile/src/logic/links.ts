/**
 * Which links in an agent's reply the phone will open. An agent's markdown is text a model
 * wrote — possibly after reading a hostile web page — so a link is only followed for the
 * ordinary web and mail schemes, and only after the reader has seen where it goes. Anything
 * else (`tel:`, `sms:`, app schemes, `javascript:`, `file:`, relative paths) stays plain text.
 */

export type LinkVerdict = { ok: true; url: string; host: string } | { ok: false };

const ALLOWED = new Set(["https:", "http:", "mailto:"]);

export function safeLink(raw: string | undefined | null): LinkVerdict {
  if (typeof raw !== "string") return { ok: false };
  const url = raw.trim();
  // A scheme is required: a bare or relative path has no meaning on the phone.
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!m) return { ok: false };
  const scheme = `${m[1].toLowerCase()}:`;
  if (!ALLOWED.has(scheme)) return { ok: false };
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return { ok: false };
  if (scheme === "mailto:") {
    const addr = url.slice(m[0].length).split("?")[0];
    const at = addr.lastIndexOf("@");
    if (at <= 0 || at === addr.length - 1) return { ok: false };
    return { ok: true, url, host: addr.slice(at + 1).toLowerCase() };
  }
  const rest = url.slice(m[0].length);
  if (!rest.startsWith("//")) return { ok: false };
  // authority = up to the first / ? #; drop any userinfo (a classic way to disguise a host)
  const authority = rest.slice(2).split(/[/?#]/)[0];
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "").toLowerCase();
  if (!host) return { ok: false };
  return { ok: true, url, host };
}
