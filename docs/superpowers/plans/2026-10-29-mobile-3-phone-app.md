# Mobile 3 — The phone app (connect, pair, chats, chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Expo phone app connects to a Conduit Mac over its tailnet (or loopback in the Simulator), pairs by QR or request with the 4-digit code, remembers paired Macs in the Keychain, and shows the WhatsApp-style chat list and chat view from the approved prototype.

**Architecture:** Desktop: `bridge.rs` sends a whitelisted, typed `projects` view (profiles, colours, live status, needs-you summary) instead of dumping `Project`, a `context` frame for the attached session, and stops leaking a PTY subscription on re-attach. Phone: a pure connection state machine drives a thin `BridgeClient`; pure modules own pairing (QR parse, nonce, code), the Mac list (address order, Keychain records), the chat list (filters, grouping, sort, unread) and the chat header; screens are Connect, Pair, Chats, Chat, Settings in a stack + bottom tabs.

**Tech Stack:** Rust (serde_json); React Native 0.85 / Expo SDK 56 (`expo-camera`, `expo-secure-store`, `expo-crypto`), React Navigation 7, jest (`jest-expo`).

**Spec:** `docs/superpowers/specs/2026-10-29-mobile-over-tailscale-design.md` §3, §4, §7, §8. Prototype (approved): `.superpowers/brainstorm/92433-1793277658/content/clickthrough.html`. Wire protocol as built: `CLAUDE.md` "Where the mobile bridge lives" + `src-tauri/src/bridge.rs`/`pairing.rs`. Research notes: `/private/tmp/claude-501/-Users-uzairhayat-ooozzy-conduit--claude-worktrees-conduit-mobile-7bb875/7bb8758b-917f-45af-8d33-b83e6978ddcf/scratchpad/plan3-research.md`.

## Global Constraints

- **Wire spellings are exact and mixed** (pinned by Rust tests): `attach`/`input`/`resize`/`git`/`kill`/`spawn` use `session_id`/`project_id`; `pair` uses `deviceName`/`nonce`/`secret`/`request`; `interrupt` uses `sessionId`. Server frames: `hello{macName,conduitVersion,protocolVersion}`, `authOk{deviceId}`, `error{message}`, `pairPending{requestId}`, `pairResult{ok:true,token,deviceId}|{ok:false,reason}`, `macs{macs:[{name,dnsName,ip,port,online,conduitVersion}]}`, plus `projects`/`size`/`history`/`chat`/`status`/`output`/`killed`/`gitresult`/`spawned`. A successful `pair` authenticates the socket with NO `authOk`. Phone tests pin every spelling.
- **4-digit code** = `sha256(utf8(input) ‖ utf8(nonce))`, first two bytes big-endian, `% 10000`, zero-padded; `input` is the QR `secret` (QR path) or the `requestId` from `pairPending` (request path). Test vector: input `secret-abc`, nonce `nonce-123` → `8754`. Nonce: 16 random bytes as 32 lowercase hex.
- **QR payload**: `{"v":1,"macName","dnsName","ip","port","secret"}`; reject anything else (wrong `v`, missing field, non-64-hex secret, port outside 8455..=8474).
- **Addresses**: a saved Mac is tried by `dnsName` first, then `ip`, then (Simulator/dev only) `127.0.0.1`; `ws://<host>:<port>`. Never send an `Origin` header (RN's WebSocket does not by default — do not add one).
- **Secrets**: the device token lives only in `expo-secure-store` (`keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), one key per Mac `mac.<deviceId>` holding a small JSON `{deviceId,token,macName,dnsName,ip,port,pairedAt}` (< 2 KB); the list of device ids in key `macs.index`. Never log tokens, secrets or nonces. An `unauthorized` reply to `auth` means the Mac revoked the phone: forget that Mac and go to Connect with a message.
- **Protocol version**: `hello.protocolVersion !== 1` → show "Update Conduit on <Mac>" (higher) / "Update the app" (lower) and do not proceed.
- **Projects view (desktop → phone)**: whitelisted fields only — never `seedMemory`, `accountId`, `path`, `worktreePath`, `layout`, `routes`, `channels`, `mcpServers`. Silo'd / local-only sessions are listed (flagged `silo: true`) but never carry a preview and cannot be opened.
- **Project colour**: the chosen `Project.color` when set, else the derived accent — port `projectAccent` + `PROJECT_PALETTE` from `src/layout.ts` into `mobile/src/logic/` with a test that pins the same outputs as the desktop's for 5 fixed ids.
- **Agents**: all seven agent ids the desktop knows (`src/agents.ts` is the authority) with their initials; unknown → `?`.
- **Feed**: virtualized (`FlatList`), keeps the reader's scroll position when not at the bottom, follows the tail when at the bottom.
- **Notifications**: in-app only (spec §9). A banner when a session newly enters "needs you", not for the chat on screen; tapping opens it. Toggles: question/permission on, finished off.
- **Expo SDK 56**: read https://docs.expo.dev/versions/v56.0.0/ for every API (`mobile/AGENTS.md`). Install native modules only with `npx expo install expo-camera expo-secure-store expo-crypto` (run in `mobile/`, one command per line). Native modules are mocked in jest; pure logic takes injected `sha256Hex`/`randomBytes`/storage so it tests without them.
- **app.json**: plugins `expo-camera` (`cameraPermission: "Conduit uses the camera to scan the pairing code shown on your Mac."`, no microphone), `expo-secure-store`; iOS `NSAppTransportSecurity: {NSAllowsLocalNetworking: true, NSExceptionDomains: {"ts.net": {NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true}}}` (never `NSAllowsArbitraryLoads`); `NSLocalNetworkUsageDescription` reworded without "same Wi-Fi"; `userInterfaceStyle: "automatic"`.
- Desktop side: Rust stays green on macOS and must remain Windows-clean (cfg arms, no unix-only APIs outside cfg). No new Rust crates.
- Conventional Commits (`feat(mobile)`, `fix(mobile)`…); NO `Co-Authored-By`/AI trailer. CHANGELOG under `## Unreleased`.
- Verification: `cd mobile && npm test && npm run typecheck`; root `pnpm test && pnpm exec tsc --noEmit`; `cargo test`/`fmt --check`/`clippy --all-targets -D warnings` (`--manifest-path src-tauri/Cargo.toml`) when Rust changes.

## Review Focus

1. A phone that was revoked on the Mac reconnects with its stored token: it must forget that Mac and land on Connect with "This Mac removed this phone", not loop reconnecting. → Task 2 test `unauthorized_auth_forgets_mac`.
2. The Mac's address changes (DNS fails, IP works): the client must fall through the address list in order on each reconnect attempt, not hammer one dead address. → Task 2 test `falls_through_addresses_in_order`.
3. A QR from a different app or a stale/forged payload must be rejected with a clear message, never sent to the bridge. → Task 3 tests `rejects_bad_qr_*`.
4. A session whose project has no chosen colour must get the SAME colour on phone and desktop. → Task 5 test `accent_matches_desktop`.
5. Scrolled up reading history while the agent streams: the list must not jump to the bottom. → Task 6 test of the pure "pinned" rule `follow_only_when_pinned`.

---

### Task 1: Desktop — typed projects view, context frame, attach leak

**Files:** Modify `src-tauri/src/bridge.rs` (+ a new pure module `src-tauri/src/bridge_view.rs` if bridge.rs would grow by > 200 lines); `lib.rs` (`mod`).

**Interfaces (produces):**
- `pub fn projects_view(projects: &[Project], profiles: &[Profile], active_profile: Option<&str>, fleet: &HashMap<String, FleetStatus>, running: &HashSet<String>, asks: &[AskView]) -> Value` → `{"type":"projects","profiles":[{"id":null,"name":"Default"},…],"activeProfileId":…|null,"projects":[{"id","name","profileId","color","sessions":[{"id","name","agent","branch","model","stopped","running","silo","status","activity","updatedAt","needs":{"kind":"ask","text":…}|null}]}]}` — `status` from fleet (`idle` when absent), `updatedAt` unix ms or null, `needs` from the first pending ask for that session (`text` = its first question, ≤ 120 chars) else `{"kind":"input","text":null}` when status is `needsInput`, else null. `silo` = `silo || local_only`. Whitelist exactly these keys.
- On `attach` success and every 15 s while attached: `{"type":"context","sessionId","used","window","fraction","model"}` from `context_window::for_transcript` (Claude only; skip when None). Never per session in `list`.
- `attach` while already attached unsubscribes the previous PTY subscription first (fix the leak).

- [ ] **Step 1: Failing tests:** `projects_view_whitelists_fields` (a project with `seedMemory`/`accountId`/`path` set → none appear), `projects_view_default_profile_first`, `status_and_needs_from_fleet_and_asks`, `silo_session_has_no_preview_fields`, `context_frame_shape`, plus a pure check for re-attach (extract the attach-state transition into a fn and assert the old subscription id is returned for unsubscribe).
- [ ] **Step 2–4:** fail → implement → `cargo test`/`fmt --check`/`clippy --all-targets -D warnings` pass.
- [ ] **Step 5: Commit** `feat(mobile): send the phone a typed projects view and session context`

### Task 2: Phone — protocol types and connection state machine

**Files:** Modify `mobile/src/bridge/protocol.ts`, `mobile/src/bridge/BridgeClient.ts`; create `mobile/src/bridge/connection.ts` (+ `connection.test.ts`), `mobile/src/bridge/protocol.test.ts`.

**Interfaces (produces):**
- `protocol.ts`: `ServerMsg` / `ClientMsg` unions covering every frame in Global Constraints (+ Task 1's `projects` and `context`), and builders `authMsg(token)`, `pairMsg({secret?|request, deviceName, nonce})`, `discoverMsg()`, `listMsg()`, `attachMsg(id)`, `inputMsg(id, data)`, `interruptMsg(id)` returning the exact wire objects. `DEFAULT_BRIDGE_URL` removed.
- `connection.ts` (pure reducer, no timers/sockets): `type ConnState = { phase: "idle"|"connecting"|"hello"|"authing"|"ready"|"pairing"|"failed"; addressIndex: number; mac?: SavedMac; error?: ConnError }`; `type ConnEvent = {t:"open"}|{t:"close"}|{t:"frame", msg: ServerMsg}|{t:"start", mac: SavedMac | null, addresses: string[]}`; `step(state, event): { state: ConnState; send: ClientMsg[]; effects: Effect[] }` where `Effect = {k:"forgetMac", deviceId}|{k:"saveToken", ...}|{k:"reconnect", addressIndex, delayMs}`. Rules: on `hello` check `protocolVersion` (Global Constraints) then send `auth` if a token is held (loopback with no Mac: `ready` directly); `authOk` → `ready`; `error:unauthorized` while authing → `forgetMac` + `failed{revoked}`; `close` → `reconnect` to `(addressIndex+1) % n` with backoff 500 ms doubling to 8 s, reset on `ready`.
- `BridgeClient`: owns the WebSocket and timers, applies `step`, exposes `send`, `onMessage`, `onState`; no query-string token.

- [ ] **Step 1: Failing tests:** `wire_spellings_pinned` (each builder's exact JSON), `hello_then_auth_then_ready`, `unauthorized_auth_forgets_mac`, `protocol_mismatch_fails_with_direction`, `falls_through_addresses_in_order`, `backoff_caps_at_8s_and_resets_on_ready`, `loopback_without_mac_is_ready_after_hello`.
- [ ] **Step 2–4:** fail → implement → `cd mobile && npm test && npm run typecheck` pass.
- [ ] **Step 5: Commit** `feat(mobile): phone speaks the authenticated bridge protocol`

### Task 3: Phone — pairing logic and the Keychain Mac list

**Files:** `mobile/package.json` (+ lock) via `npx expo install expo-camera expo-secure-store expo-crypto`; create `mobile/src/logic/pairing.ts` (+ test), `mobile/src/data/macStore.ts` (+ test), `mobile/jest.setup.ts` if mocks are needed (wire it in package.json jest config).

**Interfaces (produces):**
- `parseQr(text: string): {ok: true, qr: QrPayload} | {ok: false, reason: "notConduit"|"version"|"invalid"}`.
- `makeNonce(randomBytes: (n: number) => Uint8Array): string` (32 hex).
- `confirmCode(sha256Hex: (s: string) => Promise<string>, input: string, nonce: string): Promise<string>`.
- `type SavedMac = {deviceId, token, macName, dnsName, ip, port, pairedAt}`; `addressesFor(mac: SavedMac, opts: {simulator: boolean}): string[]` (Global Constraints order).
- `createMacStore(backend: {get(k): Promise<string|null>, set(k,v): Promise<void>, del(k): Promise<void>})` with `list()`, `save(mac)`, `forget(deviceId)`, `current()`/`setCurrent(deviceId)` (key `macs.current`); default backend = `expo-secure-store` with the Global Constraints accessibility option. Corrupt JSON in a slot → that Mac is dropped from `list()` (and its key deleted), never a crash.

- [ ] **Step 1: Failing tests:** `confirm_code_matches_rust_vector` (`8754`, using Node's `crypto` as the injected sha256), `nonce_is_32_hex`, `rejects_bad_qr_wrong_version`, `rejects_bad_qr_missing_field`, `rejects_bad_qr_bad_secret`, `rejects_bad_qr_port_out_of_range`, `accepts_real_qr_shape`, `addresses_dns_then_ip_then_loopback_in_sim`, `store_round_trip`, `forget_removes_from_index`, `corrupt_slot_is_dropped`.
- [ ] **Step 2–4:** fail → implement → mobile tests + typecheck pass.
- [ ] **Step 5: Commit** `feat(mobile): pairing codes, QR parsing and Keychain storage for Macs`

### Task 4: Phone — Connect, Pair, Settings screens and navigation; app.json

**Files:** create `mobile/src/screens/ConnectScreen.tsx`, `PairScreen.tsx`, `SettingsScreen.tsx`; modify `mobile/App.tsx`, `mobile/src/navigation.ts`, `mobile/src/bridge/LiveProvider.tsx` (drives Task 2's client from the saved current Mac; exposes `macs`, `currentMac`, `pair(…)`, `discover()`, `forget()`), `mobile/app.json`; delete `mobile/src/data/mock.ts` and the `editUrl` flow in `ProjectsScreen.tsx`.

**Behaviour (prototype screens Connect/Pair/Settings):**
- Root: no saved Mac → Connect; else a bottom-tab navigator (Chats | Settings) inside the stack (Chat pushes over tabs).
- Connect: "Connect to your Mac"; a line explaining Tailscale must be on on the phone; **Scan QR** (CameraView, `barcodeScannerSettings: {barcodeTypes: ["qr"]}`, one-shot guard, permission flow with a "camera access is off — open Settings" state); **Enter address** (dnsName or IP + port fields) which connects and sends `pair {request:true}`; when a Mac is already paired, "Macs on your tailnet" from `discover` (online/offline rows; offline not tappable) → request pairing; in the Simulator also "This Mac (simulator)" → loopback.
- Pair: Mac name, "Approve on your Mac", the 4 digits (QR path: shown immediately; request path: after `pairPending`), "Waiting for your Mac…", then on `pairResult ok` save the Mac (token once) and go to Chats; on failure show the reason (`declined` "Declined on the Mac", `expired` "No answer in 2 minutes", `off` "Mobile access is off on that Mac", `replaced` "Another request replaced this one", else "Couldn't pair") with Try again.
- Settings: current Mac (name, address in use, "Tailscale · <dnsName>" or "This Mac (simulator)"), Switch Mac (→ Connect), Forget this Mac, notification toggles (persisted in SecureStore key `prefs`), Theme (cycles the three palettes, persisted).
- app.json per Global Constraints.

- [ ] **Step 1:** implement (screens are verified by typecheck here and the Simulator in Task 7; any new pure helper gets a jest test).
- [ ] **Step 2:** `cd mobile && npm test && npm run typecheck` pass; `npx expo config --type introspect` (or `npx expo config`) shows the plugins and ATS keys.
- [ ] **Step 3: Commit** `feat(mobile): connect, pair and settings screens`

### Task 5: Phone — the WhatsApp-style chat list

**Files:** create `mobile/src/logic/chatList.ts` (+ test), `mobile/src/logic/accent.ts` (+ test), `mobile/src/screens/ChatsScreen.tsx`; modify `mobile/src/bridge/live.ts` (map Task 1's `projects` view), `mobile/src/data/types.ts`; delete `ProjectsScreen.tsx`.

**Interfaces:** `buildRows(view, {profileId, filter: "needs"|"all"|projectId, unread: Record<sessionId, number>, now}) -> Section[]` (grouped by project when `all`, flat when `needs`/project), sort needs > running > idle then newest `updatedAt`; `chipsFor(view, profileId) -> Chip[]` ("Needs you N", "All", one per project with sessions in the profile); `profileSheet(view) -> {id, name, projects, needs}[]` incl. "All profiles"; `relativeTime(ms, now)`; `previewFor(session)` ("Asks: …", "Needs your input", activity…, or empty for silo); `accentFor(project)` (chosen colour else ported `projectAccent`). Unread = chat frames received for a session since it was last opened (kept in memory per Mac).

**Behaviour:** prototype Chats screen — header "Chats" + `Profile: <name> ▾` sheet (default: the Mac's `activeProfileId`), chips, rows (avatar initials + colour + status dot, title, time, preview, unread badge amber when needs), silo rows dimmed and not openable with "Private session" preview, empty states ("Nothing needs you right now.", "No sessions here."), pull to refresh sends `list`, a slim offline bar "<Mac> offline · last seen …" when not `ready`.

- [ ] **Step 1: Failing tests:** `accent_matches_desktop` (5 ids → same hex as `src/layout.ts`'s `projectAccent`, values copied from running the desktop function in vitest — add the fixture to BOTH test suites), `needs_first_then_running_then_idle`, `profile_filter_and_all_profiles`, `needs_chip_count`, `silo_row_not_openable_no_preview`, `relative_time_buckets`.
- [ ] **Step 2–4:** fail → implement → tests + typecheck pass.
- [ ] **Step 5: Commit** `feat(mobile): WhatsApp-style chat list with projects, profiles and needs-you`

### Task 6: Phone — chat screen, Stop, banner

**Files:** modify `mobile/src/screens/ChatScreen.tsx`, `LiveProvider.tsx`; create `mobile/src/logic/chatHeader.ts` (+ test), `mobile/src/logic/follow.ts` (+ test), `mobile/src/components/Banner.tsx`.

**Behaviour:** header (back, avatar, "Project · title", sub-line `waiting on you | working… | idle · <model> · <n>% context` from `status` + Task 1's `context`), **Stop** pill while running → `interrupt`, then a local "■ Interrupted by you" divider; feed in an inverted `FlatList` (keys stable, render rows from `groupFeed`), follow rule `shouldFollow(atBottom, newItems)`; composer "Message <title>…" sends `input` with text + `\r`; opening a chat clears its unread. Banner: top-of-screen, 5 s, on a session's transition into needs-you (from `projects`/`status`), respecting the toggles, not for the chat on screen, tap → that chat.

- [ ] **Step 1: Failing tests:** `subline_states` (needs/running/idle with and without model/context), `follow_only_when_pinned`, `banner_only_on_transition_and_not_for_open_chat`, `banner_respects_toggles`.
- [ ] **Step 2–4:** fail → implement → tests + typecheck pass.
- [ ] **Step 5: Commit** `feat(mobile): chat screen with Stop, context and in-app banners`

### Task 7: Simulator build, end-to-end walk-through, docs

**Files:** `mobile/README.md`, `CHANGELOG.md`, `CLAUDE.md` (a short "phone app" paragraph under "Where the mobile bridge lives"); screenshots saved to the session scratchpad (never the repo).

- [ ] **Step 1:** `cd mobile && npx expo prebuild --platform ios --clean` then `npx expo run:ios` against an available iOS Simulator; fix build errors (do not commit `mobile/ios/` — confirm it is gitignored; add it if not).
- [ ] **Step 2:** Start the desktop dev build isolated: `CONDUIT_DATA_DIR_NAME=ConduitTauri-dev pnpm tauri dev` (NEVER plain `pnpm tauri dev`; never touch the installed Conduit). In it, add ONE project whose folder is a fresh non-git directory under the scratchpad, start one Claude session, and ask it something trivial so the transcript has content. Do not run Tailscale commands.
- [ ] **Step 3:** In the Simulator: Connect → "This Mac (simulator)" → Chats lists the dev project's session → open it → history renders, send a message, see it arrive, Stop while running. Capture `xcrun simctl io booted screenshot <scratchpad>/<n>.png` for Connect, Chats, Chat, Settings.
- [ ] **Step 4:** Docs: README (status: live over loopback or Tailscale; run instructions; first-time pairing steps; real-device ATS check outstanding); CHANGELOG bullets under `## Unreleased`:

```
- **Added — Conduit for iPhone connects over Tailscale.** Scan the pairing code shown in Settings → Mobile, approve the phone on your Mac, and the app remembers it. Your Macs on the same tailnet appear in the app once one is paired.
- **Added — WhatsApp-style chats on the phone.** Every session is a chat, grouped by project and filtered by profile, with anything waiting on you pinned on top; open one to read, reply or stop it.
```

- [ ] **Step 5:** Stop the dev build and the Simulator app; commit `docs(mobile): phone app run and pairing instructions`.
