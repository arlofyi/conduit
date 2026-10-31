/**
 * Port mirroring, pure: which phone port a computer port appears on, and how the computer's
 * list of web ports and the mirror's own status combine into the rows the Apps tab shows.
 * See docs/superpowers/specs/2026-10-31-port-mirroring-design.md.
 */

/** One web port the computer reports (`{type:"ports"}` reply). */
export interface WebPort {
  port: number;
  /** the listening process's name, when the computer could tell */
  process: string | null;
}

export interface WebPortsView {
  /** mirroring allowed on the computer (Settings → Mobile there) */
  enabled: boolean;
  ports: WebPort[];
}

/** What the native mirror reports per port (a subset of its status, kept free of the module). */
export interface MirrorPortState {
  remote: number;
  local: number;
  listening: boolean;
  error: string | null;
}

/** Below this an Android app cannot listen without root. */
export const PRIVILEGED_LIMIT = 1024;
/** Where a privileged port is mirrored instead: 80 → 10080, 443 → 10443. */
export const PRIVILEGED_OFFSET = 10_000;

/** The phone port a computer port is mirrored on: the same one, unless Android forbids it. */
export function localPortFor(remote: number): number {
  return remote < PRIVILEGED_LIMIT ? remote + PRIVILEGED_OFFSET : remote;
}

/** Parse the `ports` frame defensively: anything malformed is dropped, never thrown. */
export function parsePortsFrame(raw: unknown): WebPortsView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "ports") return null;
  const list = Array.isArray(r.ports) ? r.ports : [];
  const seen = new Set<number>();
  const ports: WebPort[] = [];
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    const q = p as Record<string, unknown>;
    const port = q.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535 || seen.has(port)) continue;
    seen.add(port);
    ports.push({ port, process: typeof q.process === "string" && q.process.trim() ? q.process.trim() : null });
  }
  ports.sort((a, b) => a.port - b.port);
  return { enabled: r.enabled === true, ports };
}

/** The mappings to hand the mirror for a list of web ports. Two computer ports that would land
 * on the same phone port (80 and 10080) keep the first; the other is not mirrored. */
export function mirrorMappings(ports: WebPort[]): { remote: number; local: number }[] {
  const used = new Set<number>();
  const out: { remote: number; local: number }[] = [];
  for (const p of ports) {
    const local = localPortFor(p.port);
    if (used.has(local)) continue;
    used.add(local);
    out.push({ remote: p.port, local });
  }
  return out;
}

/** Same set of mappings, regardless of order: no need to touch the running mirror. */
export function sameMappings(a: { remote: number; local: number }[], b: { remote: number; local: number }[]): boolean {
  if (a.length !== b.length) return false;
  const key = (m: { remote: number; local: number }) => `${m.remote}:${m.local}`;
  const s = new Set(a.map(key));
  return b.every((m) => s.has(key(m)));
}

export type RowState = "off" | "starting" | "ready" | "inUse";

export interface PortRow {
  port: number;
  local: number;
  /** "Vite on :5173"-style title */
  title: string;
  /** "node" / "Docker" / null */
  subtitle: string | null;
  state: RowState;
  /** what to open on the phone, when it can be opened */
  url: string | null;
}

const PROCESS_LABELS: Record<string, string> = {
  "com.docker.backend": "Docker",
  "com.docker.backend.exe": "Docker",
  "docker-proxy": "Docker",
  wslrelay: "WSL",
  "wslrelay.exe": "WSL",
};

/** A readable process name: Docker/WSL relays named for what they are, `.exe` dropped. */
export function processLabel(process: string | null): string | null {
  if (!process) return null;
  const known = PROCESS_LABELS[process.toLowerCase()];
  if (known) return known;
  return process.replace(/\.exe$/i, "");
}

/** Rows for the Apps tab: every web port the computer reports, with the mirror's state. */
export function portRows(view: WebPortsView | null, mirroring: boolean, status: MirrorPortState[]): PortRow[] {
  if (!view || !view.enabled) return [];
  const byRemote = new Map(status.map((s) => [s.remote, s]));
  const mapped = new Map(mirrorMappings(view.ports).map((m) => [m.remote, m.local]));
  return view.ports.map((p) => {
    const local = mapped.get(p.port) ?? localPortFor(p.port);
    const s = byRemote.get(p.port);
    const state: RowState = !mirroring || !mapped.has(p.port)
      ? "off"
      : s?.listening
        ? "ready"
        : s?.error
          ? "inUse"
          : "starting";
    return {
      port: p.port,
      local,
      title: `localhost:${local}`,
      subtitle: [processLabel(p.process), local !== p.port ? `:${p.port} on your computer` : null]
        .filter(Boolean)
        .join(" · ") || null,
      state,
      url: state === "ready" ? `http://localhost:${local}` : null,
    };
  });
}

/** What the mirror was last started with. */
export interface AppliedMirror {
  url: string;
  token: string;
  ports: { remote: number; local: number }[];
}

export interface MirrorInputs {
  /** the user's switch is on and this platform has a mirror */
  want: boolean;
  /** the computer's answer; null until the first one */
  view: WebPortsView | null;
  /** the ws:// URL the app is connected on now (null while redialling) */
  address: string | null;
  token: string | null;
  /** the native service is running */
  running: boolean;
  applied: AppliedMirror | null;
}

export type MirrorPlan = { kind: "none" } | { kind: "stop" } | { kind: "start"; applied: AppliedMirror };

/**
 * Decide what to do with the mirror. A link that is merely redialling (no address) leaves a
 * running mirror alone: tearing it down would kill every open tab's connection for a blip.
 * Only the switch, the computer turning it off, or there being nothing to mirror stops it.
 */
export function mirrorPlan(i: MirrorInputs): MirrorPlan {
  const active = i.running || i.applied !== null;
  if (!i.want || (i.view !== null && !i.view.enabled)) return active ? { kind: "stop" } : { kind: "none" };
  if (i.view === null) return { kind: "none" };
  const ports = mirrorMappings(i.view.ports);
  if (ports.length === 0) return active ? { kind: "stop" } : { kind: "none" };
  const url = i.address ?? i.applied?.url ?? null;
  if (!url || !i.token) return { kind: "none" };
  const a = i.applied;
  if (i.running && a && a.url === url && a.token === i.token && sameMappings(a.ports, ports)) return { kind: "none" };
  return { kind: "start", applied: { url, token: i.token, ports } };
}
