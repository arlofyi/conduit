import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { answerSummary, buildAnswers, splitRecommended, waitingClock, type AskQuestion, type PendingAsk } from "../asks";
import { blocksGlobalShortcut } from "../keyboardGuards";

/** How long the done state stays up if `ask-resolved` never arrives to remove it. */
const DONE_FALLBACK_MS = 4000;
/** How long "already answered" stays up before the card drops itself. */
const GONE_MS = 2500;

/** The row the keyboard highlight starts on: Claude's recommended option, else the first. */
function initialHi(q: AskQuestion | undefined): number {
  const i = q ? q.options.findIndex((o) => splitRecommended(o.label).recommended) : -1;
  return i < 0 ? 0 : i;
}

/** One AskUserQuestion. Answering resolves the blocked hook in Rust; "Answer in terminal"
 *  hands it back so Claude's own menu appears. `false` from ask_answer = it already
 *  resolved elsewhere (terminal, another window, the 600 s ceiling).
 *
 *  Keys (when the card has focus, or — with `keyboard` — when it is the only card on
 *  screen and the keystroke is not aimed at a terminal or a field): 1..N pick a row,
 *  ↑/↓ move the highlight, Enter picks it (multi-select: sends), Space toggles. */
export function AskCard({
  ask,
  sessionName,
  className = "",
  side,
  keyboard = false,
}: {
  ask: PendingAsk;
  sessionName: string;
  className?: string;
  /** Anchored cards open on one side of their avatar; the tail points back at it. */
  side?: "right" | "left";
  /** Also answer keys sent to the window, while this is the only card visible. */
  keyboard?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState(false);
  const [hi, setHi] = useState(() => initialHi(ask.questions[0]));
  const [state, setState] = useState<"idle" | "sending" | "gone" | "error" | "done">("idle");
  const [sent, setSent] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Synchronous guard: a second Enter/click lands before React re-renders "sending".
  const inFlight = useRef(false);

  // `false` from ask_answer means it resolved elsewhere; a sent answer normally ends with
  // the store's `ask-resolved` removal. Either way drop it locally after a moment, so a
  // missed event cannot leave a stuck card hiding later asks.
  useEffect(() => {
    if (state !== "gone" && state !== "done") return;
    const t = setTimeout(() => useStore.getState().removeAsk(ask.id), state === "gone" ? GONE_MS : DONE_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [state, ask.id]);

  const ticking = state !== "done" && state !== "gone";
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const q = ask.questions[page];
  const total = ask.questions.length;
  const last = page === total - 1;
  const multi = !!q?.multiSelect;
  const otherIdx = q ? q.options.length : 0;
  const rowCount = otherIdx + 1;
  const chosen = q ? (picks[q.question] ?? []) : [];
  const busy = state === "sending" || state === "done" || state === "gone";

  const submit = async (payload: Record<string, string>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("sending");
    try {
      const ok = await invoke<boolean>("ask_answer", { id: ask.id, answers: payload });
      if (ok) setSent(answerSummary(payload));
      setState(ok ? "done" : "gone");
    } catch {
      setState("error");
    } finally {
      inFlight.current = false;
    }
  };

  const goTo = (p: number) => {
    setPage(p);
    setOtherOpen(false);
    setHi(initialHi(ask.questions[p]));
  };

  /** Last page: send everything. Earlier pages: move on. */
  const advance = (nextPicks: Record<string, string[]>, nextTyped: Record<string, string>) => {
    if (!last) return goTo(page + 1);
    const a = buildAnswers(ask.questions, nextPicks, nextTyped);
    if (a) void submit(a);
  };

  const choose = (i: number) => {
    if (!q || busy) return;
    setHi(i);
    if (i === otherIdx) {
      setOtherOpen(true);
      return;
    }
    const label = q.options[i]?.label;
    if (label == null) return;
    if (multi) {
      setPicks((p) => {
        const cur = p[q.question] ?? [];
        return { ...p, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      });
      return;
    }
    // A pick replaces any earlier free text for this question (free text wins in buildAnswers).
    const nextPicks = { ...picks, [q.question]: [label] };
    const nextTyped = { ...typed, [q.question]: "" };
    setPicks(nextPicks);
    setTyped(nextTyped);
    // The ORIGINAL label goes back: Claude matches its own option text, marker and all.
    if (total === 1) void submit({ [q.question]: label });
    else advance(nextPicks, nextTyped);
  };

  const sendOther = () => {
    if (!q || busy || !(typed[q.question] ?? "").trim()) return;
    advance(picks, typed);
  };

  const closeOther = () => {
    if (!q) return;
    setOtherOpen(false);
    setTyped((t) => ({ ...t, [q.question]: "" }));
    rootRef.current?.focus();
  };

  const sendMulti = () => {
    if (busy || chosen.length === 0) return;
    advance(picks, typed);
  };

  /** True when the key was the card's. The free-text field handles its own keys. */
  const handleKey = (e: KeyboardEvent | ReactKeyboardEvent): boolean => {
    if (!q || busy || otherOpen) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (/^[1-9]$/.test(e.key)) {
      const d = Number(e.key) - 1;
      if (d >= rowCount) return false;
      choose(d);
      return true;
    }
    switch (e.key) {
      case "ArrowDown":
        setHi((h) => (h + 1) % rowCount);
        return true;
      case "ArrowUp":
        setHi((h) => (h - 1 + rowCount) % rowCount);
        return true;
      case "Enter":
        if (multi && hi !== otherIdx) sendMulti();
        else choose(hi);
        return true;
      case " ":
        if (!multi) return false;
        choose(hi);
        return true;
      default:
        return false;
    }
  };
  const keyRef = useRef(handleKey);
  keyRef.current = handleKey;

  useEffect(() => {
    if (!keyboard) return;
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (rootRef.current?.contains(e.target as Node)) return; // the card's own handler has it
      if (blocksGlobalShortcut(e.target)) return;
      if (document.querySelectorAll(".ask-card").length !== 1) return;
      if (keyRef.current(e)) e.preventDefault();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [keyboard]);

  if (!q) return null;

  const meta = (
    <div className="ask-card-who">
      <span className="ask-card-dot" aria-hidden />
      <span className="ask-card-name">{sessionName}</span>
      <span className="ask-card-sep" aria-hidden>·</span>
      <span className="ask-card-t">waiting {waitingClock(ask.createdMs, now)}</span>
      {q.header?.trim() && (
        <>
          <span className="ask-card-sep" aria-hidden>·</span>
          <span>{q.header}</span>
        </>
      )}
      {total > 1 && (
        <>
          <span className="ask-card-sep" aria-hidden>·</span>
          <span className="ask-card-step">
            Question {page + 1} of {total}
          </span>
        </>
      )}
    </div>
  );

  const rows = [...q.options.map((o) => o.label), "Something else…"].map((raw, i) => {
    const isOther = i === otherIdx;
    const { label, recommended } = isOther ? { label: raw, recommended: false } : splitRecommended(raw);
    const descRaw = isOther ? "" : (q.options[i].description ?? "").trim();
    const desc = !otherOpen && descRaw && descRaw !== label && descRaw !== raw ? descRaw : "";
    const on = !isOther && chosen.includes(raw);
    const lead = multi ? (
      <span className={`ask-card-chk ${on ? "on" : ""}`} aria-hidden />
    ) : (
      <span className="ask-card-key" aria-hidden>
        {i + 1}
      </span>
    );
    const cls = `ask-card-opt ${hi === i ? "hi" : ""} ${on ? "on" : ""} ${isOther ? "other" : ""}`;
    if (isOther && otherOpen) {
      return (
        <div key="__other" className={`${cls} open`}>
          {lead}
          <span className="ask-card-ol">{label}</span>
          <span />
          <div className="ask-card-field">
            <input
              className="ask-card-text"
              autoFocus
              aria-label="Your own answer"
              placeholder="Type your answer"
              value={typed[q.question] ?? ""}
              disabled={busy}
              onChange={(e) => setTyped((t) => ({ ...t, [q.question]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  sendOther();
                } else if (e.key === "Escape") {
                  // Esc belongs to the field: it must not close the drawer or anything else.
                  e.preventDefault();
                  e.stopPropagation();
                  closeOther();
                }
              }}
            />
            <button
              type="button"
              className="ask-card-send"
              disabled={busy || !(typed[q.question] ?? "").trim()}
              onClick={sendOther}
            >
              Send
            </button>
          </div>
        </div>
      );
    }
    return (
      <button
        key={isOther ? "__other" : raw}
        type="button"
        tabIndex={-1}
        className={cls}
        disabled={busy}
        role={multi && !isOther ? "checkbox" : undefined}
        aria-checked={multi && !isOther ? on : undefined}
        aria-keyshortcuts={!multi && i < 9 ? String(i + 1) : undefined}
        onClick={() => choose(i)}
      >
        {lead}
        <span className="ask-card-ol">
          {label}
          {desc && <span className="ask-card-od">{desc}</span>}
        </span>
        {recommended ? <span className="ask-card-rec">Recommended</span> : <span />}
      </button>
    );
  });

  const lastKey = Math.min(rowCount, 9);
  const footerRight = otherOpen ? (
    <span className="ask-card-hint">Enter sends · Esc goes back</span>
  ) : multi ? (
    <button type="button" className="ask-card-send" disabled={busy || chosen.length === 0} onClick={sendMulti}>
      {!last ? "Next" : chosen.length ? `Send ${chosen.length}` : "Send"}
    </button>
  ) : (
    <span className="ask-card-hint">
      <kbd className="ask-card-kb">1</kbd>–<kbd className="ask-card-kb">{lastKey}</kbd> to answer
    </span>
  );

  return (
    <div
      ref={rootRef}
      className={`ask-card ${className} ${side ?? ""} ${state === "done" ? "done" : ""}`}
      role="group"
      aria-label={`${sessionName} asks: ${q.question}`}
      tabIndex={0}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest(".ask-card-field")) return;
        // Enter/Space on a focused footer button ("Answer in terminal", Send) is that button's.
        if ((e.key === "Enter" || e.key === " ") && t.closest("button") && !t.closest(".ask-card-opt")) return;
        if (handleKey(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onKeyUp={(e) => {
        // Space activates a focused button on keyup; the keydown already handled it.
        if (e.key === " " && (e.target as HTMLElement).closest(".ask-card-opt")) e.preventDefault();
      }}
    >
      {state === "done" ? (
        <div className="ask-card-done" role="status">
          <span className="ask-card-ck" aria-hidden />
          <div>
            Sent to {sessionName}: “{sent}”
            <small>It's carrying on. This card closes in a moment.</small>
          </div>
        </div>
      ) : (
        <>
          <p className="ask-card-q">{q.question}</p>
          {meta}
          {state === "gone" ? (
            <div className="ask-card-note">Already answered in the terminal.</div>
          ) : (
            <>
              <div className="ask-card-opts">{rows}</div>
              <div className="ask-card-ft">
                <button
                  type="button"
                  className="ask-card-link"
                  onClick={() => void invoke("ask_handoff", { id: ask.id }).catch(() => setState("error"))}
                >
                  Answer in terminal ↗
                </button>
                <span className="ask-card-grow" />
                {footerRight}
              </div>
              {state === "error" && (
                <div className="ask-card-note">Couldn't send — try again or answer in the terminal.</div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
