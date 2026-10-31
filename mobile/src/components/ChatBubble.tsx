/**
 * One message, messenger-shaped and Conduit-dressed.
 *
 * Shape (WhatsApp): a tail on the FIRST bubble of a run only, at the top outer corner; the
 * time small and dim INSIDE the bubble at the bottom right, sharing the last line when it
 * fits (an invisible spacer the width of the time reserves the room); tight spacing inside a
 * run. Dress (the desktop's chat mode): "me" is `.hq-bubble-user` — a soft accent wash with an
 * accent hairline, ink text — not a slab of salmon; the agent's reply is markdown prose on
 * the warm selection tier. Long-press copies the text (plain words, not asterisks).
 */
import { hasBlocks } from "../logic/chatView";
import * as Clipboard from "expo-clipboard";
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { plainText } from "../logic/markdown";
import { hq } from "../theme/hq";
import { useTheme } from "../theme/ThemeContext";
import { TYPE } from "../theme/type";
import { AssistantMarkdown } from "./AssistantMarkdown";
import { useReduceMotion } from "./AgentAvatar";

const RADIUS = 16;
const TAIL_W = 8;

function Tail({ side, fill, stroke }: { side: "left" | "right"; fill: string; stroke?: string }) {
  // Drawn for the left side; the right one is its mirror. One column overlaps the bubble so the
  // bubble's own border under the join is painted over.
  return (
    <Svg
      width={TAIL_W + 1}
      height={13}
      viewBox="0 0 9 13"
      style={{
        position: "absolute",
        top: 0,
        [side]: -TAIL_W,
        transform: side === "right" ? [{ scaleX: -1 }] : undefined,
      }}
    >
      <Path d="M9 0 H1.6 Q-0.2 0 1 1.6 L9 12.6 Z" fill={fill} />
      {stroke ? <Path d="M9 0.5 H1.6 Q0.3 0.5 1.3 1.8 L8.6 12" fill="none" stroke={stroke} strokeWidth={1} /> : null}
    </Svg>
  );
}

export function ChatBubble({
  role,
  text,
  time,
  first,
  animateIn,
  onCopied,
}: {
  role: "user" | "assistant";
  text: string;
  time: string;
  /** first of a same-role run: carries the tail and the wider gap above */
  first: boolean;
  /** a message that arrived while the chat was open (history renders still) */
  animateIn: boolean;
  onCopied: () => void;
}) {
  const { palette: p } = useTheme();
  const h = hq(p);
  const reduce = useReduceMotion();
  const me = role === "user";

  const enter = useRef(new Animated.Value(animateIn && !reduce ? 0 : 1)).current;
  useEffect(() => {
    if (!animateIn || reduce) return;
    Animated.timing(enter, { toValue: 1, duration: 260, easing: Easing.out(Easing.exp), useNativeDriver: true }).start();
  }, [animateIn, reduce, enter]);

  const copy = () => {
    Clipboard.setStringAsync(me ? text : plainText(text))
      .then(onCopied)
      .catch(() => undefined);
  };

  const fill = me ? h.roseSoft : h.them;
  const timeStyle = { fontSize: 11, color: me ? h.ink2 : p.textMid, fontVariant: ["tabular-nums" as const] };

  return (
    <Animated.View
      style={{
        alignSelf: me ? "flex-end" : "flex-start",
        // A reply with a list, table, code block or heading takes the full width rather than
        // shrinking to fit: markdown's list rows are flex rows, and in a shrink-to-fit bubble
        // Android measured the bubble from its first line, so the list spilled out below it
        // over the next rows (seen on a vivo X200 Pro).
        ...(me || !hasBlocks(text) ? { maxWidth: me ? "82%" : "90%" } : { width: "90%" }),
        marginTop: first ? 8 : 2,
        marginLeft: me ? 0 : TAIL_W,
        marginRight: me ? TAIL_W : 0,
        opacity: enter,
        transform: [
          { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) },
        ],
      }}
    >
      <Pressable
        onLongPress={copy}
        delayLongPress={350}
        accessibilityRole="text"
        accessibilityLabel={`${me ? "You" : "Agent"}${time ? `, ${time}` : ""}: ${me ? text : plainText(text)}`}
        accessibilityHint="Long press to copy"
        style={({ pressed }) => ({
          backgroundColor: fill,
          borderRadius: RADIUS,
          borderTopLeftRadius: !me && first ? 0 : RADIUS,
          borderTopRightRadius: me && first ? 0 : RADIUS,
          borderWidth: me ? 1 : 0,
          borderColor: h.roseLine,
          paddingHorizontal: 12,
          paddingTop: 7,
          paddingBottom: me ? 7 : 6,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        })}
      >
        {first ? <Tail side={me ? "right" : "left"} fill={fill} stroke={me ? h.roseLine : undefined} /> : null}
        {me ? (
          <View>
            <Text selectable style={{ color: p.textBright, fontSize: TYPE.callout, lineHeight: 21 }}>
              {text}
              {/* reserves the time's room on the last line, WhatsApp's trick. Blank figure
                  spaces, not the time in a transparent colour: Android ignores `transparent` on
                  a span inside selectable text and drew the time twice. */}
              {time ? <Text style={timeStyle}>{" ".repeat(time.length + 4)}</Text> : null}
            </Text>
            {time ? <Text style={[timeStyle, { position: "absolute", right: 0, bottom: -1 }]}>{time}</Text> : null}
          </View>
        ) : (
          <View>
            <AssistantMarkdown text={text} />
            {time ? <Text style={[timeStyle, { alignSelf: "flex-end", marginTop: -6 }]}>{time}</Text> : null}
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}
