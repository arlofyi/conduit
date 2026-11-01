# Conduit mobile (iPhone and Android)

A React Native (Expo) app for the Conduit mobile companion: a **per-agent chat UI
with inline status actions**, instead of mirroring the desktop terminal. See the
design in
[`docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md`](../docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md).

## What it does

The app is the phone half of Conduit's mobile bridge (`src-tauri/src/bridge.rs`). It opens on
**Connect** until a computer is chosen, then shows four tabs:

- **Sessions**: every session, grouped by project and filtered by profile, with anything
  waiting on you pinned on top. Long-press to select several, then Stop or Delete. "+"
  starts a new Claude or Antigravity session. Opening one attaches to it: the transcript
  renders as a chat, new turns stream in, the composer types into the real terminal, and
  attachments (photos, camera, files) upload into the session's folder.
- **Chats**: the computer's general (root) chat. Ask across your projects without a coding
  session, on Claude or Antigravity, with the chat's model, effort, deep research, MCP
  servers and attached profiles/projects set from its settings.
- **Apps** (Android): your computer's `localhost` web apps, opened on the phone at the same
  `http://localhost:<port>` (port mirroring).
- **Settings**: connection, notifications, plan usage per account, theme.

**The session sheet** (the header's tune button) holds every session action: interrupt,
model and effort, rename, keep running, auto-approve (Antigravity), slash commands and
skills, Compact/Clear, the session's files, and Stop session. **Files** browses the session's
folder: read (Markdown rendered), view images, edit and save text files (a file changed on
the computer since you opened it is never overwritten), and save any file to the phone.

**Offline.** The sessions list, opened chats and general chats are saved on the phone
(`src/logic/offlineCache.ts`, bounded, never private sessions) and shown read-only while the
computer is unreachable. Coming back to the app reconnects at once, and Sessions shows a one-time
"Since 2:05 PM: ..." summary of what changed. The copy is never part of a phone backup: on iOS it
lives in the cache folder (the document folder goes to iCloud, and expo-file-system cannot exclude
a file from that), so iOS may clear it when storage runs low; on Android it lives in the app's
files folder, which stays out of Auto Backup only because expo-secure-store's backup rules include
nothing but its own preferences (`src/data/offlineFs.ts` says so too). Writes are spaced out: the
chat on screen is saved when it closes, when its turn ends, on background or disconnect (and at
least every minute), the lists at most every 5 minutes outside those.

**Answering from the phone.** When a session asks a question (AskUserQuestion) or needs
permission to run a tool (Claude, or Antigravity's "Run this command?"), the computer pushes
it to every connected phone at once: a banner, a "Needs you" row, and a live card in the chat
(numbered options, multi-select, "Something else…"; Allow / Deny for a permission). The first
answer anywhere wins and every other screen clears the card and says where it went ("Answered
on your computer", "Moved to the terminal", "Handled in the terminal"). A private session
never shows its question on the phone. A Deny after the terminal already said Yes cannot stop
the tool, and the card says so. Logic: `src/logic/pending.ts` (tested); cards:
`src/components/PendingCards.tsx`.

**Notifications.** In the foreground the app shows in-app banners. On Android a light
foreground service (`modules/bg-watch`) keeps one connection open while the app is in the
background or the screen is off, and posts system notifications when a session needs you,
finishes (after 20 s of quiet), fails or is stopped, when a general chat replies, and optionally
when the computer has been unreachable for 10 minutes. Its rules are a Kotlin port of
`src/logic/watch.ts`; change one, change the other (both have tests). While that service
is connected it counts as a phone, so questions wait for an answer from the phone rather
than falling straight back to the terminal; turn the question/permission notifications off
to stop that. iOS has in-app banners only (no push service yet).

Two ways to reach a computer:

- **Tailscale (a real phone).** The phone and the computer must be on the same tailnet with mobile
  access turned on in the computer's Settings → Mobile. The bridge listens on the computer's Tailscale
  address only while that switch is on and never on the LAN or the open internet. A paired
  phone holds a device token in the iOS Keychain or Android Keystore; revoking it on the
  computer makes the phone forget that computer.
- **Loopback (the Simulator, dev builds only).** "Find Conduit on this Mac" probes
  `127.0.0.1:8455–8474` and LISTS every Conduit that answers with its port. It never picks
  one for you, because the installed Conduit answers there too. Loopback needs no pairing.

Verified end to end in the iOS Simulator against an isolated dev build (2026-10-30): connect,
chat list, history, send, reply, Stop; and over the tailnet address with a device token:
answering a question, Allow and Deny, Esc / "No" in the terminal clearing the phone's card,
hand-off when the app is backgrounded or frozen, and a private session's question staying
on the computer. Verified on a real Android phone (vivo, Android 16) over Tailscale
(2026-10-31 to 11-01): pairing, chats, answering, files, general chat, port mirroring and
background notifications. **Not yet verified:** a real iPhone over the tailnet hop, App Transport Security on a device (the `ts.net` exception plus
`NSAllowsLocalNetworking` in `app.json`), and the QR camera scan.

**Diagnostics (local only).** `src/logic/diagLog.ts` (pure: redaction, line format, rotation,
counters) + `src/data/diagnostics.ts` (expo-file-system backend; global `ErrorUtils` handler and
Hermes rejection tracker, both chaining the previous handler) + `components/ErrorBoundary.tsx`
(outermost, uses no provider) + Settings → Diagnostics (`DiagnosticsCard.tsx`). Logs live in the
CACHE folder, `conduit-logs/` (`app.log` 1 MB x3, `counters.json`; on Android also `native.log`
from `modules/bg-watch` `NativeLog`, shared with port-mirror), because iCloud and Android Auto
Backup skip it. Nothing is sent anywhere; Share log is the only way out. Log event kinds and error
messages only, never a token, secret, prompt, chat text or file contents; `redact` is a second
line of defence. Its rules exist twice (`diagLog.ts`, `NativeLogRules.kt`), pinned by both test
suites. Diagnostics code must never throw.

## Run it

> **Not via App Store Expo Go.** SDK 56 isn't shipped to the store Expo Go, so use a
> **development build** (needs Xcode).

**iOS Simulator:**
```bash
cd mobile
npx expo prebuild --platform ios --clean   # regenerates ios/ (gitignored, never commit it)
npx expo run:ios --device "iPhone 17 Pro"
```

To try it against a desktop without touching your real sessions, run the desktop as an
isolated dev build (see the repo's CLAUDE.md) and pick **its** port in the scan list:
```bash
CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev   # from the repo root
```
The dev build prints `conduit: mobile bridge on ws://127.0.0.1:<port>`; the same port is in
`~/Library/Application Support/ConduitTauri-dev/mobile-devices.json`. The installed Conduit
usually holds 8455, so the dev build usually lands on 8456.

**Physical iPhone** (development build):
```bash
npx expo run:ios --device
```
Plug in, unlock and tap **Trust**; if signing fails, open `ios/*.xcworkspace` in Xcode once
and pick a team under Signing & Capabilities. A free "Personal Team" signature lasts 7 days.
The dev build loads its JavaScript from Metro on the Mac, so the phone must reach the Mac
on the same Wi-Fi for that, separately from the Tailscale link to the bridge.

First native build runs prebuild + `pod install` + compile (minutes); rebuilds are fast.
Don't run two Metro instances at once; they fight over port 8081.

**Android** (development or release build; needs JDK 17 and the Android SDK, `ANDROID_HOME`
set). Turn on Developer options and USB debugging on the phone (some vendors, e.g. vivo, also
need "Install via USB"), plug in and allow the computer:
```bash
npx expo prebuild --platform android --clean   # regenerates android/ (gitignored)
npx expo run:android --device                  # debug build, JS from Metro
# or a standalone release APK (JS bundled, no Metro needed), for one phone's ABI:
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
adb install -r app/build/outputs/apk/release/app-release.apk
```
Android has no SF Symbols: every icon goes through `src/components/androidSymbols.ts`, whose
keys are the only type `Icon` accepts, so an icon with no Material equivalent fails `tsc`.
The bridge is plain `ws://` inside the Tailscale tunnel, so release builds set
`usesCleartextTraffic` (via `expo-build-properties`).

On Windows, the computer's firewall must let the phone in: allow Conduit inbound on TCP
8455-8474 from `100.64.0.0/10` on the Private profile (Tailscale's network is Private).

## First-time pairing (a real phone)

1. Install Tailscale on the phone and sign in to the same tailnet as the computer.
2. On the computer: Conduit → Settings → Mobile → turn on mobile access, then **Pair a phone**.
   A one-time QR code appears (valid 5 minutes, single use).
3. On the phone: **Scan QR code** and point it at the computer's screen. (Or **Enter address**
   with the computer's Tailscale name or `100.x` address and the port shown in Settings → Mobile.)
4. The computer shows a prompt with a 4-digit code. Check it matches the phone and approve.
5. The phone remembers the computer. Other computers on the same tailnet that run Conduit
   appear on the Connect screen once one is paired, and can ask to pair the same way.

## Attachments, session actions and port mirroring

- **"+" attaches** a photo, a camera shot or any file. Each uploads when picked (chunked
  `upload` frames; photos re-encoded to 2048 px JPEG first) into the session's
  `.conduit-uploads/` on the computer, and the message names it as `@<path>`. Up to 6 per
  message, 10 MB each. Steering (compact, clear) is in the session sheet.
- **Long-press a chat** to select it, tap others, then Stop or Delete. One `sessionaction`
  frame; the desktop runs its own stop/delete per session and skips private ones. A delete
  keeps the history and any worktree on the computer.
- **Port mirroring (Android).** `modules/port-mirror` is a foreground service that listens on
  the phone's `127.0.0.1:<port>` for every web app the computer's scan found and carries each
  connection through an authenticated tunnel to the same port on the computer. Only ports the
  scan found are reachable; debugger and Docker endpoints are never offered. While it is on,
  other apps and web pages on the phone can reach the mirrored ports too.

## Checks

```bash
npm test          # jest: pure logic (feed, pending cards, watch rules, files, ports, usage, ...)
npm run typecheck # tsc --noEmit (strict)
```

CI runs both on every PR (the `mobile` job in `.github/workflows/ci.yml`). The Kotlin
watcher's rules have JVM unit tests in `modules/bg-watch/android/src/test`. CI's `kotlin-rules`
job compiles `WatchRules.kt` + `NativeLogRules.kt` and their tests with plain `kotlinc` (they use
nothing Android, only `org.json`) and runs them with JUnit, no Android SDK needed. Locally they
also run through the Android build (`./gradlew :bg-watch:testDebugUnitTest` after `expo prebuild`).

## Layout

```
App.tsx                      root: providers, tabs (Sessions, Chats, Apps, Settings), stacks
src/bridge/                  BridgeClient (one socket), LiveProvider (state), protocol, probe
src/data/                    prefs, paired computers (Keychain/Keystore), BgWatch + PortMirror providers
src/logic/                   pure, jest-tested logic: feed, pending, banner, watch, files,
                             ports, usage, general chat, session header/options, pairing...
src/components/              chat bubbles, composer, pending cards, usage meters, glass UI
src/screens/                 Connect, Pair, Chats (sessions), Chat, Sheets, Files, FileView,
                             General (chats), GeneralChat, GeneralOptions, NewChat, Apps, Settings
src/theme/                   Warm palettes, type scale, tab-bar clearance
modules/bg-watch/            Android foreground service: background notifications (Kotlin)
modules/port-mirror/         Android foreground service: localhost port mirroring (Kotlin)
```

The two `modules/` are local Expo native modules, linked by `expo prebuild`. They are
Android-only; on iOS `requireOptionalNativeModule` returns null and the app hides or explains
the feature.

## Next

- iOS: push notifications (APNs) and port mirroring have no iOS counterpart yet.
- Verify on a real iPhone: the Tailscale hop, ATS on device, and the QR camera scan.
