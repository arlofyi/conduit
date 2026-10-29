# Conduit for iPhone

A React Native (Expo) app for the Conduit mobile companion: a **per-agent chat UI
with inline status actions**, instead of mirroring the desktop terminal. See the
design in
[`docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md`](../docs/superpowers/specs/2026-06-30-conduit-mobile-chat-companion-design.md).

## Status: live over loopback (Simulator) or Tailscale (phone)

The app is the phone half of Conduit's mobile bridge (`src-tauri/src/bridge.rs`). It opens on
**Connect** until a Mac is chosen, then shows **Chats** (every session, grouped by project,
filtered by profile, anything waiting on you pinned on top) and **Settings** (connection,
notification toggles, theme). Opening a chat attaches to that session: its transcript
history renders, new turns stream in, the composer types into the real PTY, and **Stop**
interrupts the current turn.

Two ways to reach a Mac:

- **Tailscale (a real phone).** The phone and the Mac must be on the same tailnet with mobile
  access turned on in the Mac's Settings → Mobile. The bridge listens on the Mac's Tailscale
  address only while that switch is on and never on the LAN or the open internet. A paired
  phone holds a device token in the iOS Keychain; revoking it on the Mac makes the phone
  forget that Mac.
- **Loopback (the Simulator, dev builds only).** "Find Conduit on this Mac" probes
  `127.0.0.1:8455–8474` and LISTS every Conduit that answers with its port. It never picks
  one for you, because the installed Conduit answers there too. Loopback needs no pairing.

Verified end to end in the iOS Simulator against an isolated dev build (2026-10-30): connect,
chat list, history, send, reply, Stop. **Not yet verified:** a real iPhone over the tailnet
hop, App Transport Security on a device (the `ts.net` exception plus
`NSAllowsLocalNetworking` in `app.json`), and the QR camera scan.

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

## First-time pairing (a real phone)

1. Install Tailscale on the iPhone and sign in to the same tailnet as the Mac.
2. On the Mac: Conduit → Settings → Mobile → turn on mobile access, then **Pair a phone**.
   A one-time QR code appears (valid 5 minutes, single use).
3. On the phone: **Scan QR code** and point it at the Mac's screen. (Or **Enter address**
   with the Mac's Tailscale name or `100.x` address and the port shown in Settings → Mobile.)
4. The Mac shows a prompt with a 4-digit code. Check it matches the phone and approve.
5. The phone remembers the Mac. Other Macs on the same tailnet that run Conduit appear on the
   Connect screen once one Mac is paired, and can ask to pair the same way.

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

## Next

- Verify on a real iPhone: the Tailscale hop, ATS on device, and the QR camera scan.
- Answer questions and permission prompts from the phone (the cards are read-only today).
- Push notifications (APNs); in-app banners only fire while the app is open.
