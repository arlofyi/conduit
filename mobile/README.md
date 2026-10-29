# Conduit mobile — chat companion (front-end shell)

A React Native (Expo) app for the Conduit mobile companion: a **per-agent chat UI
with inline status actions**, instead of mirroring the desktop terminal. See the
design in
[`docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md`](../docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md).

## Status: wired to the desktop's live bridge

The app talks to a running Conduit desktop through `BridgeClient` (`src/bridge/`), mounted
by `LiveProvider`: it lists the desktop's projects and sessions, attaches to a session for
its transcript history and live tail, and sends prompts into the real PTY. The chat feed
renders the full transcript item set: bubbles, tool calls (status, errors, edit diffs; quiet runs fold), to-dos, approvals,
notices, dividers (compaction/interrupts), slash-command chips, images, AskUserQuestion
cards (read-only) and plans (Markdown, as on desktop). The mock data in `src/data/mock.ts` remains for
tests and offline UI work only.

Not done yet: connecting from a phone off the desktop's loopback. Reaching the bridge over
Tailscale, with pairing, is the next plan; approvals from the phone arrive with the broker.

What works:

- **Projects screen** — projects → agents triage list, live status vocabulary
  (needs-you / running + activity + `n/m` todos / done / idle), "n need you" summary.
- **Chat screen** — the live transcript described above, plus the composer.
- **Theme switcher** — the three-swatch control (top-right) cycles all **three Warm
  schemes** (Near-Black / Dim / Light), ported 1:1 from the desktop `src/themes.ts`.

## Run it

> ⚠️ **Not via App Store Expo Go.** SDK 56 isn't shipped to the App Store / Play Store
> Expo Go (frozen at SDK 54 since Expo's May 2026 change), so the QR-into-Expo-Go flow
> does **not** work here. Use a **development build** (needs Xcode, which compiles fine):

**iOS Simulator** (verified: `Build Succeeded`):
```bash
cd mobile
npx expo run:ios
```

**Physical iPhone** (development build):
```bash
npx expo run:ios --device
```
Plug in + unlock the iPhone and tap **Trust**; if signing fails, open `ios/*.xcworkspace`
in Xcode once and pick a team under Signing & Capabilities; keep phone + Mac on the same
Wi-Fi (the dev build connects to Metro). A free Apple ID "Personal Team" signature lasts
**7 days** — re-run to refresh.

**Web** (rough, instant — `react-native-web` + `react-dom` are installed):
```bash
npx expo start   # then press w
```

First native build runs prebuild + `pod install` + compile (minutes); rebuilds are fast.
Don't run two Metro instances at once — they fight over port 8081.

## Checks

```bash
npm test          # jest — pure logic (status mapping + feed reducer, bridge mapping, image allowlist)
npm run typecheck # tsc --noEmit (strict)
```

## Layout

```
App.tsx                      root: ThemeProvider + projects⇆chat navigation
src/theme/
  palettes.ts                the 3 Warm schemes as framework-neutral tokens (← src/themes.ts)
  ThemeContext.tsx           ThemeProvider + useTheme + cycle()
  layout.ts                  lightweight safe-area insets
src/data/
  types.ts                   projects view + ChatItem model (mirrors desktop status vocab)
  mock.ts                    mock projects + per-agent chat feeds  ← swap for BridgeClient (P2)
src/logic/
  status.ts (+ .test.ts)     tool→activity mapping
  chatList.ts (+ .test.ts)   Chats list: rows, chips, profiles, unread, relative time
  accent.ts (+ .test.ts)     project colour (port of the desktop's projectAccent)
  feed.ts   (+ .test.ts)     prompt/approval reducer, event grouping
src/components/atoms.tsx     NeedsPill / ThemeButton
src/screens/
  ChatsScreen.tsx            WhatsApp-style chat list (home)
  ChatScreen.tsx             timeline + bubbles + approval card + composer
```

## Next (per the spec)

- **P1** structured bridge + approval broker (Rust) + interactive-mode approval test.
- **P2** replace `src/data/mock.ts` with a live `BridgeClient` (WebSocket).
- **P3** pairing (QR + X25519 + token) + tunnel. **P4** APNs push.
