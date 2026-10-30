/**
 * Cards for what the Mac is holding for a human: Claude's questions (AskUserQuestion) and tool
 * permissions. Which state a card is in -- live, sending, settled, private -- is decided in
 * logic/pending.ts (`cardView`); this file only draws it, in the desktop's chat-mode language
 * (`.hq-question` + the desktop AskCard's answer model: numbered options, a Recommended tag,
 * checkboxes and "Send N" for multi-select, "Something else…" free text).
 */
import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { WireQuestion } from "../bridge/protocol";
import { splitRecommended } from "../logic/chatView";
import { mix } from "../logic/color";
import {
  answerSummary,
  buildAnswers,
  type CardView,
  type PendingAsk,
  type PendingPermission,
} from "../logic/pending";
import type { Palette } from "../theme/palettes";
import { hq } from "../theme/hq";
import { useTheme } from "../theme/ThemeContext";
import { MIN_TOUCH, MONO, TYPE } from "../theme/type";
import { Icon } from "./Glass";

export type OnAnswer = (askId: string, answers: Record<string, string>, summary: string) => void;
export type OnApprove = (id: string, allow: boolean) => void;

/** `.hq-question-header` / `.hq-plan-title`: small uppercase accent tag. */
export function Tag({ text, color }: { text: string; color?: string }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  const ink = color ?? p.accent;
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: color ? mix(color, p.panelBg, 0.18) : h.roseSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text maxFontSizeMultiplier={1.6} style={{ color: ink, fontSize: 11, letterSpacing: 0.66, fontWeight: "600" }}>
        {text.toUpperCase()}
      </Text>
    </View>
  );
}

/** The quiet history card: a hairline box on the warm selection tier. */
export function cardStyle(p: Palette) {
  return {
    marginHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: p.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: mix(p.selectionBg, p.panelBg, 0.35),
  } as const;
}

/** A card waiting on the reader: the same box, warmed toward amber the way a needs-you row is. */
function liveCardStyle(p: Palette) {
  return {
    ...cardStyle(p),
    borderWidth: 1,
    borderColor: mix(p.amber, p.panelBg, 0.55),
    backgroundColor: mix(p.amber, mix(p.selectionBg, p.panelBg, 0.35), 0.06),
  } as const;
}

/** How a card ended, or why it cannot be answered here: one line under (or instead of) it. */
function OutcomeLine({ card }: { card: Extract<CardView, { mode: "done" | "private" }> }) {
  const { palette: p } = useTheme();
  const tone = card.mode === "private" ? "info" : card.tone;
  const icon = card.mode === "private" ? "lock.fill" : tone === "ok" ? "checkmark.circle.fill" : tone === "bad" ? "xmark.circle.fill" : "info.circle";
  const color = tone === "ok" ? p.green : tone === "bad" ? p.red : p.textMid;
  return (
    <View accessible accessibilityRole="text" style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
      <View style={{ marginTop: 2 }}>
        <Icon name={icon} size={14} color={color} />
      </View>
      <Text style={{ flex: 1, color: tone === "info" ? p.textMid : p.textBright, fontSize: TYPE.footnote, lineHeight: 18 }}>
        <Text style={{ fontWeight: "600", color: tone === "info" ? p.textMid : color }}>{card.text}</Text>
        {card.mode === "done" && card.detail ? <Text style={{ color: p.textMid }}>{` · ${card.detail}`}</Text> : null}
      </Text>
    </View>
  );
}

/**
 * VoiceOver hears how a card ended at the moment it ends (a sighted reader sees the outcome line
 * replace the buttons). Only on the transition: a card that mounts already settled is history.
 */
function useAnnounceSettle(card: CardView | undefined) {
  const prevMode = useRef(card?.mode);
  const text = card?.mode === "done" ? (card.detail ? `${card.text}, ${card.detail}` : card.text) : null;
  useEffect(() => {
    const was = prevMode.current;
    prevMode.current = card?.mode;
    if (text && was !== undefined && was !== "done") AccessibilityInfo.announceForAccessibility(text);
  }, [card?.mode, text]);
}

/** Why a tap did nothing (no open socket): the card stays live so the reader can try again. */
function Notice({ text }: { text: string }) {
  const { palette: p } = useTheme();
  return (
    <View accessible accessibilityRole="alert" accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon name="wifi.slash" size={14} color={p.amber} />
      <Text style={{ flex: 1, color: p.textMid, fontSize: TYPE.footnote }}>{text}</Text>
    </View>
  );
}

function Sending() {
  const { palette: p } = useTheme();
  return (
    <View accessible accessibilityLabel="Sending" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <ActivityIndicator size="small" color={p.textMid} />
      <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>Sending…</Text>
    </View>
  );
}

/** The options of one question, read-only (history, or a settled card). */
function StaticQuestion({ q }: { q: WireQuestion }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  return (
    <View style={{ gap: 7 }}>
      {q.header ? <Tag text={q.header} /> : null}
      <Text style={{ color: p.textBright, fontSize: TYPE.callout, fontWeight: "600", lineHeight: 21 }}>{q.question}</Text>
      {q.options.map((o, j) => {
        const { label, recommended } = splitRecommended(o.label);
        return (
          <View key={j} style={{ flexDirection: "row", gap: 10 }}>
            <Text style={{ color: p.textDim, fontSize: 12, fontFamily: MONO, width: 14, marginTop: 2 }}>{j + 1}</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <Text style={{ color: p.textBright, fontSize: TYPE.subhead }}>{label}</Text>
                {recommended ? (
                  <View style={{ borderWidth: 1, borderColor: h.roseLine, borderRadius: 999, paddingHorizontal: 6 }}>
                    <Text style={{ color: p.accent, fontSize: 11 }}>Recommended</Text>
                  </View>
                ) : null}
              </View>
              {o.description ? <Text style={{ color: p.textMid, fontSize: TYPE.footnote, lineHeight: 18 }}>{o.description}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/**
 * A question card. With no `card` it is history (a question nobody is waiting on); otherwise
 * it is live, sending, settled or private, as `cardView` decided.
 */
export function QuestionCard({ questions, card, onAnswer }: { questions: WireQuestion[]; card?: CardView; onAnswer: OnAnswer }) {
  const { palette: p } = useTheme();
  useAnnounceSettle(card);
  if (card && (card.mode === "live" || card.mode === "sending") && card.item.kind === "ask") {
    return (
      <LiveQuestion
        ask={card.item}
        sending={card.mode === "sending"}
        notice={card.mode === "live" ? card.notice : undefined}
        onAnswer={onAnswer}
      />
    );
  }
  const qs = card && card.item.kind === "ask" && !card.item.private ? card.item.questions : questions;
  return (
    <View style={[cardStyle(p), { gap: 12 }]}>
      {qs.map((q, i) => (
        <StaticQuestion key={i} q={q} />
      ))}
      {card && (card.mode === "done" || card.mode === "private") ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border, paddingTop: 10 }}>
          <OutcomeLine card={card} />
        </View>
      ) : null}
    </View>
  );
}

/** The interactive card: the desktop AskCard's model, sized for a thumb. */
function LiveQuestion({ ask, sending, notice, onAnswer }: { ask: PendingAsk; sending: boolean; notice?: string; onAnswer: OnAnswer }) {
  const { palette: p } = useTheme();
  const h = hq(p);
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState(false);

  const total = ask.questions.length;
  const q = ask.questions[Math.min(page, total - 1)];
  if (!q) return null;
  const last = page >= total - 1;
  const multi = !!q.multiSelect;
  const chosen = picks[q.question] ?? [];
  const draft = typed[q.question] ?? "";
  const busy = sending;

  const submit = (a: Record<string, string> | null) => {
    if (a) onAnswer(ask.id, a, answerSummary(a));
  };
  /** Last page sends everything; earlier pages move on. */
  const advance = (nextPicks: Record<string, string[]>, nextTyped: Record<string, string>) => {
    if (!last) {
      setPage(page + 1);
      setOtherOpen(false);
      return;
    }
    submit(buildAnswers(ask.questions, nextPicks, nextTyped));
  };

  const choose = (label: string) => {
    if (busy) return;
    if (multi) {
      setPicks((cur) => {
        const c = cur[q.question] ?? [];
        return { ...cur, [q.question]: c.includes(label) ? c.filter((l) => l !== label) : [...c, label] };
      });
      return;
    }
    // A pick replaces earlier free text for this question (free text wins in buildAnswers).
    const nextPicks = { ...picks, [q.question]: [label] };
    const nextTyped = { ...typed, [q.question]: "" };
    setPicks(nextPicks);
    setTyped(nextTyped);
    setOtherOpen(false);
    advance(nextPicks, nextTyped);
  };

  const sendOther = () => {
    if (busy || !draft.trim()) return;
    advance(picks, typed);
  };

  return (
    // The container is not an accessibility element (its rows must stay individually
    // reachable), so it carries no label; the question itself is the header VoiceOver reads.
    <View style={[liveCardStyle(p), { gap: 10 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Tag text={q.header?.trim() ? q.header : "Question"} color={p.amber} />
        {total > 1 ? (
          <Text maxFontSizeMultiplier={1.6} style={{ color: p.textMid, fontSize: TYPE.caption, fontVariant: ["tabular-nums"] }}>
            Question {page + 1} of {total}
          </Text>
        ) : null}
      </View>
      <Text
        accessibilityRole="header"
        accessibilityLabel={`Question${total > 1 ? ` ${page + 1} of ${total}` : ""}: ${q.question}`}
        style={{ color: p.textBright, fontSize: TYPE.callout, fontWeight: "600", lineHeight: 21 }}
      >
        {q.question}
      </Text>

      <View style={{ gap: 4 }}>
        {q.options.map((o, i) => {
          const { label, recommended } = splitRecommended(o.label);
          const desc = (o.description ?? "").trim();
          const on = chosen.includes(o.label);
          return (
            <Pressable
              key={`${i}:${o.label}`}
              disabled={busy}
              onPress={() => choose(o.label)}
              accessibilityRole={multi ? "checkbox" : "button"}
              accessibilityState={multi ? { checked: on, disabled: busy } : { disabled: busy }}
              accessibilityLabel={`${i + 1}. ${label}${recommended ? ", recommended" : ""}${desc && desc !== label ? `. ${desc}` : ""}`}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                minHeight: MIN_TOUCH,
                paddingHorizontal: 10,
                paddingVertical: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: on ? h.roseLine : "transparent",
                backgroundColor: on ? h.roseSoft : pressed ? p.selectionBg : "transparent",
                opacity: busy ? 0.55 : 1,
              })}
            >
              <View style={{ width: 22, height: 22, alignItems: "center", justifyContent: "center" }}>
                {multi ? (
                  <Icon name={on ? "checkmark.square.fill" : "square"} size={18} color={on ? p.accent : p.textDim} />
                ) : (
                  <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: h.line2, alignItems: "center", justifyContent: "center" }}>
                    <Text maxFontSizeMultiplier={1.3} style={{ color: p.textMid, fontSize: 12, fontFamily: MONO }}>
                      {i + 1}
                    </Text>
                  </View>
                )}
              </View>
              <View style={{ flex: 1, gap: 2, paddingTop: 1 }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                  <Text style={{ color: p.textBright, fontSize: TYPE.subhead }}>{label}</Text>
                  {recommended ? (
                    <View style={{ borderWidth: 1, borderColor: h.roseLine, borderRadius: 999, paddingHorizontal: 6 }}>
                      <Text maxFontSizeMultiplier={1.6} style={{ color: p.accent, fontSize: 11 }}>Recommended</Text>
                    </View>
                  ) : null}
                </View>
                {desc && desc !== label && desc !== o.label ? (
                  <Text style={{ color: p.textMid, fontSize: TYPE.footnote, lineHeight: 18 }}>{desc}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}

        {/* "Something else…": the free-text answer, the last row as on the desktop */}
        {otherOpen ? (
          <View style={{ gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: h.roseLine }}>
            <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>Something else…</Text>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
              <TextInput
                autoFocus
                value={draft}
                editable={!busy}
                onChangeText={(t) => setTyped((cur) => ({ ...cur, [q.question]: t }))}
                onSubmitEditing={sendOther}
                returnKeyType={last ? "send" : "next"}
                submitBehavior="submit"
                placeholder="Type your answer"
                placeholderTextColor={p.textMid}
                selectionColor={p.accent}
                keyboardAppearance={p.appearance}
                accessibilityLabel="Your own answer"
                // The Mac refuses an answer over 4096 bytes (MAX_ANSWER_BYTES) and keeps the
                // question; 1000 characters is under that at UTF-8's worst case of 4 bytes each.
                maxLength={1000}
                multiline
                style={{
                  flex: 1,
                  minHeight: 38,
                  maxHeight: 120,
                  paddingHorizontal: 12,
                  paddingTop: 9,
                  paddingBottom: 9,
                  borderRadius: 10,
                  backgroundColor: p.panelBg,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: p.border,
                  color: p.textBright,
                  fontSize: TYPE.subhead,
                }}
              />
              <PillButton label={last ? "Send" : "Next"} disabled={busy || !draft.trim()} onPress={sendOther} />
            </View>
            <Pressable
              onPress={() => {
                setOtherOpen(false);
                setTyped((cur) => ({ ...cur, [q.question]: "" }));
              }}
              disabled={busy}
              hitSlop={8}
              accessibilityRole="button"
              style={{ alignSelf: "flex-start" }}
            >
              <Text style={{ color: p.textMid, fontSize: TYPE.footnote }}>Back to the options</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable
            disabled={busy}
            onPress={() => setOtherOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Something else: type your own answer"
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: MIN_TOUCH,
              paddingHorizontal: 10,
              borderRadius: 10,
              backgroundColor: pressed ? p.selectionBg : "transparent",
              opacity: busy ? 0.55 : 1,
            })}
          >
            <View style={{ width: 22, alignItems: "center" }}>
              <Icon name="pencil" size={14} color={p.textMid} />
            </View>
            <Text style={{ color: p.textMid, fontSize: TYPE.subhead }}>Something else…</Text>
          </Pressable>
        )}
      </View>

      {notice && !sending ? <Notice text={notice} /> : null}
      {sending ? (
        <Sending />
      ) : multi && !otherOpen ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <PillButton
            label={!last ? "Next" : chosen.length ? `Send ${chosen.length}` : "Send"}
            disabled={chosen.length === 0}
            onPress={() => advance(picks, typed)}
          />
        </View>
      ) : null}
    </View>
  );
}

/** The accent capsule (the composer's send treatment). */
function PillButton({
  label,
  onPress,
  disabled,
  tone = "accent",
  hint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "accent" | "green" | "quiet";
  hint?: string;
}) {
  const { palette: p } = useTheme();
  const bg = tone === "green" ? p.green : tone === "quiet" ? p.selectionBg : p.accent;
  const ink = tone === "green" ? p.onGreen : tone === "quiet" ? p.red : p.meText;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={hint}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 38,
        paddingHorizontal: 16,
        borderRadius: 19,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
        opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      <Text maxFontSizeMultiplier={1.4} style={{ color: ink, fontWeight: "600", fontSize: TYPE.subhead, fontVariant: ["tabular-nums"] }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A tool permission: what it wants to run, then Deny / Allow. Standalone, never joined to the transcript. */
export function PermissionCard({ card, onApprove }: { card: CardView; onApprove: OnApprove }) {
  const { palette: p } = useTheme();
  useAnnounceSettle(card);
  if (card.mode === "private") {
    return (
      <View style={[cardStyle(p), { gap: 8 }]}>
        <Tag text="Permission" color={p.amber} />
        <OutcomeLine card={card} />
      </View>
    );
  }
  const item = card.item as PendingPermission;
  const summary = item.summary && item.summary !== item.toolName ? item.summary : null;
  const live = card.mode === "live";
  // Deny/Allow alone say nothing about WHAT: VoiceOver hears the tool and its command.
  const hint = summary ? `${item.toolName}: ${summary}` : item.toolName;
  return (
    <View style={[card.mode === "done" ? cardStyle(p) : liveCardStyle(p), { gap: 10 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Tag text="Permission" color={p.amber} />
        <Text maxFontSizeMultiplier={1.6} style={{ color: p.textMid, fontSize: TYPE.footnote }} numberOfLines={1}>
          {item.toolName}
        </Text>
      </View>
      {summary ? (
        <View style={{ backgroundColor: p.panelBg, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: p.border, paddingHorizontal: 11, paddingVertical: 9 }}>
          <Text selectable style={{ color: p.textBright, fontFamily: MONO, fontSize: 13, lineHeight: 18 }}>
            {summary}
          </Text>
        </View>
      ) : (
        <Text style={{ color: p.textBright, fontSize: TYPE.callout, fontWeight: "600" }}>Allow {item.toolName}?</Text>
      )}
      {live ? (
        <>
          {card.notice ? <Notice text={card.notice} /> : null}
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <PillButton label="Deny" tone="quiet" hint={hint} onPress={() => onApprove(item.id, false)} />
            </View>
            <View style={{ flex: 1 }}>
              <PillButton label="Allow" tone="green" hint={hint} onPress={() => onApprove(item.id, true)} />
            </View>
          </View>
        </>
      ) : card.mode === "sending" ? (
        <Sending />
      ) : card.mode === "done" ? (
        <OutcomeLine card={card} />
      ) : null}
    </View>
  );
}

/** A card at the end of the feed: a permission, or a question whose transcript card has not arrived. */
export function TrailingCard({ card, onAnswer, onApprove }: { card: CardView; onAnswer: OnAnswer; onApprove: OnApprove }) {
  if (card.item.kind === "permission") return <PermissionCard card={card} onApprove={onApprove} />;
  return <QuestionCard questions={[]} card={card} onAnswer={onAnswer} />;
}
