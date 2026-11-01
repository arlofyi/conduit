/**
 * Local diagnostics: the file backend for logic/diagLog.ts, plus the global error hooks.
 * Native module (expo-file-system): never imported by anything under jest.
 *
 * Where: `<cache>/conduit-logs/` -- `app.log` (+ `app.1.log`, `app.2.log`, 1 MB each) and
 * `counters.json`; on Android the native services (bg-watch and port-mirror) write `native.log`
 * into the same folder (modules/bg-watch NativeLog). The CACHE folder on purpose: iCloud backup and Android
 * Auto Backup both skip it, so a log never leaves the phone that way either. The OS may purge it
 * when storage runs low, which costs a diagnostic, not data.
 *
 * Every write is synchronous (expo-file-system's File API is), so the global handler's line is
 * on disk before React Native's own handler takes a fatal error down. Nothing here ever throws:
 * diagnostics must not become the failure.
 */
import { Directory, File, Paths } from "expo-file-system";
import { AppState, Platform } from "react-native";
import { BgWatch } from "../../modules/bg-watch";
import {
  bump,
  countersReport,
  errorDetail,
  formatLine,
  LOG_KEEP,
  LOG_MAX_BYTES,
  parseCounters,
  recordError,
  rotatedNames,
  rotationPlan,
  shouldRotate,
  startRun,
  utf8Bytes,
  type CounterKey,
  type Counters,
  type DiagEntry,
  type DiagLevel,
} from "../logic/diagLog";

const DIR = "conduit-logs";
const COUNTERS = "counters.json";
/** counters are written at most this often (and at once on an error or going to background) */
const COUNTERS_DEBOUNCE_MS = 2_000;

const dir = () => new Directory(Paths.cache, DIR);

let ready = false;
let logSize = 0;
let counters: Counters = parseCounters(null, Date.now());
let countersTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function ensureDir(): Directory {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
}

function readCountersFile(): string | null {
  try {
    const f = new File(dir(), COUNTERS);
    return f.exists ? f.textSync() : null;
  } catch {
    return null;
  }
}

function writeCountersNow() {
  if (countersTimer) clearTimeout(countersTimer);
  countersTimer = null;
  try {
    const f = new File(ensureDir(), COUNTERS);
    if (!f.exists) f.create({ overwrite: true });
    f.write(JSON.stringify(counters));
  } catch {
    // next time
  }
}

function scheduleCounters() {
  if (countersTimer) return;
  countersTimer = setTimeout(writeCountersNow, COUNTERS_DEBOUNCE_MS);
}

function notify() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // a listener's problem
    }
  }
}

function init() {
  if (ready) return;
  ready = true;
  try {
    const f = new File(ensureDir(), rotatedNames()[0]);
    logSize = f.exists ? (f.info().size ?? 0) : 0;
  } catch {
    logSize = 0;
  }
  counters = startRun(parseCounters(readCountersFile(), Date.now()), Date.now());
  writeCountersNow();
}

function rotate(d: Directory) {
  const plan = rotationPlan("app", LOG_KEEP);
  const old = new File(d, plan.remove);
  if (old.exists) old.delete();
  for (const [from, to] of plan.moves) {
    const f = new File(d, from);
    if (f.exists) f.moveSync(new File(d, to));
  }
  logSize = 0;
}

function append(line: string) {
  try {
    const d = ensureDir();
    const bytes = utf8Bytes(line);
    if (shouldRotate(logSize, bytes, LOG_MAX_BYTES)) rotate(d);
    const f = new File(d, rotatedNames()[0]);
    if (!f.exists) {
      f.create({ overwrite: true });
      logSize = 0;
    }
    f.write(line, { append: true });
    logSize += bytes;
  } catch {
    // a full disk or a revoked folder: drop the line rather than fail the caller
  }
}

/** Log one event. `err` (anything thrown) becomes the detail; `detail` is appended to it. */
export function diagLog(level: DiagLevel, source: string, event: string, err?: unknown, detail?: string) {
  try {
    init();
    const parts: string[] = [];
    if (err !== undefined) parts.push(errorDetail(err, level === "error" ? 6 : 0));
    if (detail) parts.push(detail);
    const entry: DiagEntry = { at: Date.now(), level, source, event, detail: parts.join(" -- ") || undefined };
    append(formatLine(entry));
    if (level === "error") {
      counters = recordError(counters, entry);
      writeCountersNow();
      notify();
    }
  } catch {
    // never
  }
}

export const diag = {
  info: (source: string, event: string, detail?: string) => diagLog("info", source, event, undefined, detail),
  warn: (source: string, event: string, err?: unknown, detail?: string) => diagLog("warn", source, event, err, detail),
  error: (source: string, event: string, err?: unknown, detail?: string) => diagLog("error", source, event, err, detail),
  /** a counter moved (persisted on a short debounce) */
  count(key: CounterKey, n = 1) {
    try {
      init();
      counters = bump(counters, key, n);
      scheduleCounters();
      notify();
    } catch {
      // never
    }
  },
};

export function getCounters(): Counters {
  init();
  return counters;
}

export function subscribeDiagnostics(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function readText(name: string): string {
  try {
    const f = new File(dir(), name);
    return f.exists ? f.textSync() : "";
  } catch {
    return "";
  }
}

/** The native services' log (Android); "" on iOS or when the module predates it. */
function nativeLogText(): string {
  try {
    return BgWatch?.readNativeLog?.() ?? "";
  } catch {
    return "";
  }
}

/**
 * Everything, oldest first, as one text file under the cache (for the share sheet): a header
 * with the counters, the native log, then the app log. Returns its file:// URI, or null.
 */
export function exportLog(): { uri: string; text: string } | null {
  try {
    init();
    writeCountersNow();
    const app = rotatedNames()
      .slice()
      .reverse()
      .map(readText)
      .join("");
    const native = nativeLogText();
    const header = `${countersReport(counters, Date.now())}platform ${Platform.OS} ${String(Platform.Version)}\n`;
    const text = [
      header,
      Platform.OS === "android" ? `---- native (background services) ----\n${native || "(empty)\n"}` : "",
      `---- app ----\n${app || "(empty)\n"}`,
    ].join("\n");
    const out = new File(ensureDir(), "conduit-diagnostics.txt");
    if (out.exists) out.delete();
    out.create({ overwrite: true });
    out.write(text);
    return { uri: out.uri, text };
  } catch {
    return null;
  }
}

/** Delete every log file (app + native) and reset the counters to a fresh run. */
export function clearLog() {
  try {
    for (const n of [...rotatedNames(), "conduit-diagnostics.txt"]) {
      const f = new File(dir(), n);
      if (f.exists) f.delete();
    }
    logSize = 0;
    try {
      BgWatch?.clearNativeLog?.();
    } catch {
      // native log stays
    }
    counters = startRun(parseCounters(null, Date.now()), Date.now());
    writeCountersNow();
    notify();
  } catch {
    // never
  }
}

// ---- global capture ----

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler | undefined;
  setGlobalHandler(h: GlobalHandler): void;
}
interface RejectionOptions {
  allRejections?: boolean;
  onUnhandled?: (id: number, error: unknown) => void;
  onHandled?: (id: number) => void;
}
interface HermesLike {
  enablePromiseRejectionTracker?: (o: RejectionOptions) => void;
}

let installed = false;

/**
 * Hook the global error handler (chaining React Native's, so the red box in dev and the crash in
 * release behave exactly as before) and Hermes' unhandled-rejection tracker (chaining RN's dev
 * LogBox warning). Counts the app start. Call once, before the app renders.
 */
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  init();
  diag.info("app", "start", `${Platform.OS} ${String(Platform.Version)}${__DEV__ ? " dev" : ""}`);

  const g = globalThis as unknown as { ErrorUtils?: ErrorUtilsLike; HermesInternal?: HermesLike };
  try {
    const eu = g.ErrorUtils;
    if (eu) {
      const prev = eu.getGlobalHandler();
      eu.setGlobalHandler((error, isFatal) => {
        diagLog("error", "js", isFatal ? "fatal" : "uncaught", error);
        prev?.(error, isFatal);
      });
    }
  } catch {
    // no ErrorUtils (web)
  }

  try {
    const hermes = g.HermesInternal;
    if (hermes?.enablePromiseRejectionTracker) {
      // RN installs its own tracker in dev only (LogBox warnings); keep it working.
      let rn: RejectionOptions | null = null;
      if (__DEV__) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          rn = (require("react-native/Libraries/promiseRejectionTrackingOptions") as { default?: RejectionOptions }).default ?? null;
        } catch {
          rn = null;
        }
      }
      hermes.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (id, error) => {
          diagLog("error", "js", "unhandledRejection", error);
          rn?.onUnhandled?.(id, error);
        },
        onHandled: (id) => rn?.onHandled?.(id),
      });
    }
  } catch {
    // no tracker
  }

  // Counters go to disk when the app leaves the screen (it may never come back).
  try {
    AppState.addEventListener("change", (s) => {
      if (s !== "active") writeCountersNow();
    });
  } catch {
    // web
  }
}
