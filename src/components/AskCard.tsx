import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildAnswers, type PendingAsk } from "../asks";

/** One AskUserQuestion. Answering resolves the blocked hook in Rust; "Answer in terminal"
 *  hands it back so Claude's own menu appears. `false` from ask_answer = it already
 *  resolved elsewhere (terminal, another window, the 600 s ceiling). */
export function AskCard({ ask, sessionName, className = "" }: { ask: PendingAsk; sessionName: string; className?: string }) {
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "gone" | "error">("idle");
  const q = ask.questions[page];
  if (!q) return null;
  const answers = buildAnswers(ask.questions, picks, typed);
  const last = page === ask.questions.length - 1;

  const pick = (label: string) =>
    setPicks((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });

  const submit = async (payload: Record<string, string>) => {
    setState("sending");
    try {
      const ok = await invoke<boolean>("ask_answer", { id: ask.id, answers: payload });
      setState(ok ? "idle" : "gone");
    } catch {
      setState("error");
    }
  };

  const send = async () => {
    if (!answers) return;
    await submit(answers);
  };

  // A single-select single-question card answers on click, like the TUI menu.
  const oneShot = ask.questions.length === 1 && !q.multiSelect;

  return (
    <div
      className={`ask-card ${className}`}
      role="dialog"
      aria-label={`${sessionName} asks`}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="ask-card-hd">{sessionName} asks{q.header ? ` · ${q.header}` : ""}</div>
      <div className="ask-card-q">{q.question}</div>
      {state === "gone" ? (
        <div className="ask-card-note">Already answered in the terminal.</div>
      ) : (
        <>
          {q.options.map((o) => {
            const on = (picks[q.question] ?? []).includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                className={`ask-card-opt ${on ? "on" : ""}`}
                disabled={state === "sending"}
                onClick={() => {
                  pick(o.label);
                  if (oneShot) void submit({ [q.question]: o.label });
                }}
              >
                {o.label}
                {o.description && <small>{o.description}</small>}
              </button>
            );
          })}
          <input
            className="ask-card-text"
            placeholder="Type an answer…"
            value={typed[q.question] ?? ""}
            onChange={(e) => setTyped((t) => ({ ...t, [q.question]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!last) setPage(page + 1);
                else void send();
              }
            }}
          />
          <div className="ask-card-ft">
            <button type="button" className="ask-card-link" onClick={() => void invoke("ask_handoff", { id: ask.id })}>
              Answer in terminal ↗
            </button>
            {ask.questions.length > 1 && (
              <span className="ask-card-pages">
                {ask.questions.map((_, i) => (
                  <i key={i} className={i === page ? "on" : ""} />
                ))}
              </span>
            )}
            {!oneShot &&
              (last ? (
                <button
                  type="button"
                  className="ask-card-send"
                  disabled={!answers || state === "sending"}
                  onClick={() => void send()}
                >
                  Send
                </button>
              ) : (
                <button type="button" className="ask-card-send" onClick={() => setPage(page + 1)}>
                  Next
                </button>
              ))}
          </div>
          {state === "error" && <div className="ask-card-note">Couldn't send — try again or answer in the terminal.</div>}
        </>
      )}
    </div>
  );
}
