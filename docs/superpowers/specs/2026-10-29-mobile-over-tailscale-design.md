# Conduit Mobile over Tailscale — design

Date: 2026-10-29
Status: draft, awaiting founder approval
Prototype: `.superpowers/brainstorm/92433-1793277658/content/clickthrough.html` (throwaway,
gitignored — the founder clicked through it and said "Looks right")

## Why

The founder leaves the laptop running at home with several sessions going and goes out with
the phone. From the phone they want to read what each session is doing, steer it, and catch
anything waiting on them — a question, a permission prompt — before it stalls for hours.

Today none of that works away from home:

- The desktop bridge (`src-tauri/src/bridge.rs`) binds loopback by default. The only remote
  mode is `CONDUIT_BRIDGE_TOKEN`, which binds **every interface** with a shared token sent in
  plaintext. It is a dev shortcut, it is configured from a terminal, and it only reaches a
  phone on the same Wi-Fi.
- The phone app (`mobile/`) has a live read channel (projects, history, chat tail, status,
  prompts typed into the PTY), but connects to a hard-coded `ws://127.0.0.1:8456` with a
  hand-typed token, knows one Mac, and its Approve/Deny card is cosmetic — the broker behind
  it (`broker.rs`) is dormant.
- The chat itself is wrong on both desktop and phone: `transcript.rs` turns every plain-string
  user line into a "you said" bubble, so Claude's own injected text — `<task-notification>`
  blocks, `<agent-message>`s from other sessions, slash-command echoes, skill bodies — renders
  as if the founder typed it (screenshots in the conversation that produced this spec).

## The founder's rulings

These are the founder's words, not inferences:

1. **Tailscale is required.** "We HAVE to use tailscale."
2. **Never assume same Wi-Fi.** "I often have my laptop running at home while I'm outside with
   my phone. Conduit should support this."
3. **Native, in-app.** "Conduit needs native support for Tailscale with in-app configurations
   and no terminal envs or configs."
4. **The phone gets the desktop's chat mode.** "Chat mode is already available in the Conduit
   Desktop app. Same UI should be available on the mobile app too."
5. **Claude's message types must be handled.** Conduit's chat mode does not account for them.
6. **WhatsApp-like.** "I would like to see my chat view, steer conversations and keep an eye
   on what needs me. I'd like a WhatsApp like experience for this."
7. **Filters are project-based by default, profiles are supported, "Needs you" stays.**
8. The click-through prototype (connect → pair → chats → chat → settings) "looks right".
9. **Notifications are in-app only** for this release ("In-app only").

## Goals

1. **Reach the Mac from anywhere over Tailscale.** The phone connects to the Mac's tailnet
   address. It works on cellular, on someone else's Wi-Fi, anywhere both devices are on the
   same tailnet.
2. **Zero terminal setup.** Everything — turning mobile access on, seeing Tailscale's state,
   pairing a phone, revoking a phone — lives in the desktop app's Settings. No env vars, no
   config files, no CLI commands for the user.
3. **WhatsApp-style chat list** (prototype screen "Chats"):
   - One row per session: avatar in the project colour (via `resolveProjectColor`) with agent
     initials, a status dot (amber = needs you, green = working, dim = idle), title, last
     activity time, a one-line preview, and an unread count.
   - Rows that need the founder carry an amber wash and their preview names what is asked
     ("Asks: …", "Permission: …").
   - Sorted needs-you first, then working, then idle; within each, latest activity first.
   - Grouped under project headers (project colour swatch + session count) when the filter is
     All.
   - Filter chips: **Needs you (n)** first, **All**, then one chip per project in the
     current profile.
   - A **Profile** pill in the header opens a bottom sheet listing the desktop's profiles plus
     "All profiles", each with its project count and how many of its sessions need the
     founder (so a hidden profile can never be silently waiting). Changing the profile resets
     the project filter to All.
4. **WhatsApp-style chat view** (prototype screen "Chat"):
   - Header: back, avatar, "Project · session title", and a sub-line with state
     (waiting on you / working… / idle), model, context %. A **Stop** button appears while
     the session is working.
   - Founder's prompts are right-aligned accent bubbles; the agent's replies are left bubbles
     with markdown.
   - Tool use collapses into one quiet monospace line per run of tool calls
     ("searched … · read 4 files · edited 3 files"), tap to expand the list.
   - Housekeeping renders as small centred notes, tap to expand (see "Message types").
   - **Questions** (`AskUserQuestion`) render as a card with numbered options, a
     "(Recommended)" tag, and "Something else…" free text. One tap answers. The card then
     collapses into "Answered <question> → <choice>".
   - **Permission prompts** render as a card showing the tool and its command/input with
     Deny / Allow. The card then collapses into "Allowed/Denied · tool · command".
   - Composer at the bottom: typing and sending steers the session.
5. **Every Claude message type renders as what it is**, on desktop chat mode AND the phone,
   from one shared parser, so the two can never disagree.
6. **Pairing is explicit.** Being on the same tailnet does not grant control. A phone must be
   approved on the Mac once; the Mac lists paired phones and can revoke any of them.
7. **More than one Mac.** The phone remembers every Mac it has paired with and the founder
   switches between them (Settings → Switch Mac).
8. **The founder sees at once when something needs them while the app is open** — an in-app
   banner plus the amber rows and the Needs you chip (see Notifications). Lock-screen push is
   out of scope for this release (founder's ruling: "In-app only").

## Non-goals

- A terminal mirror on the phone. The bridge's raw PTY output stays on the wire for other
  clients but the phone never renders it.
- Files viewer, git graph, diff review, task board, canvas, Continuity view on the phone.
- Starting new sessions from the phone. (The bridge already accepts `spawn`; no UI for it in
  this release.)
- A relay that removes Tailscale (the Cloudflare Worker idea in the 2026-06-25 spec), and the
  Matrix/BadgerClaw adapter on `origin/feat/matrix-adapter`. Both are parked, not deleted.
- Android. Expo builds it, but nothing in this release is verified on it.
- Rendering non-Claude agents' transcripts. Sessions on other agents still appear in the list
  with status and can be steered, but their chat view says the conversation view is
  Claude-only for now — the same honest statement `transcript::session_transcript` makes on
  desktop.

## Anti-goals (would be a failure even if it "works")

- The bridge listening on the LAN, or on anything other than loopback and the Tailscale
  interface.
- Any part of setup requiring a terminal, an env var, or editing a file.
- Conduit changing the user's Tailscale configuration (ACLs, tags, exit nodes, `serve`/
  `funnel`). Conduit reads Tailscale's state; it never configures Tailscale.
- Anything reachable through Tailscale **Funnel** (the public internet).
- Phone and desktop chat showing the same conversation differently.
- A raw `<task-notification>` (or any other injected tag) shown as a bubble from the founder.
- A question or permission prompt answered twice, or answered on one surface while the other
  still shows it as pending.

## Constraints

- Lean dependencies (CLAUDE.md): no Rust HTTP client, no embedded networking stack. Tailscale
  state is read by shelling out to the `tailscale` CLI, the same way network calls shell out to
  `curl`.
- Any command that spawns a process is `#[tauri::command(async)]`.
- Secrets: pairing tokens are never logged, never written to `state.json`, and stored only as
  hashes on the Mac.
- `state.json` must never fail to parse (orphan sweep). Paired-device records live in their
  own file, read defensively.
- Keep-alive terminals: nothing here may remount an xterm.
- The macOS and Windows Rust legs both compile everything; Tailscale code must build on both.
- The laptop must be awake and online. Conduit does not solve sleep in this release (see
  "Left to the builder" for a possible small mitigation).
- Mobile app is Expo SDK 56 — read the versioned docs before writing mobile code
  (`mobile/AGENTS.md`).

## How it works

### 1. Tailscale on the Mac (my call: use the installed Tailscale app, don't embed one)

Conduit relies on the official Tailscale app already running on the Mac and the phone. It
does not embed its own tailnet node (`tsnet` would need a Go sidecar, its own login, and
would put a second machine for this Mac in the tailnet; it also wouldn't help the phone, which
needs the Tailscale iOS app regardless).

A new Rust module `tailscale.rs` reads state via `tailscale status --json` (and
`tailscale whois --json <ip>` for peers). It locates the CLI on `PATH`, then at the macOS
app bundle path (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`), then the Windows
install path. Parsed into a pure, tested struct:

- `NotInstalled` · `Stopped` · `NeedsLogin` · `Running { tailnet, self_name, self_dns,
  self_ips, user }`

Polled while the Settings panel is open and on a slow tick (≈30 s) while mobile access is on,
so a Tailscale restart or IP change is noticed.

### 2. The bridge binds only to Tailscale

`bridge.rs` loses `CONDUIT_BRIDGE_TOKEN` and its `0.0.0.0` mode entirely.

- **Mobile access off** (default): loopback only, as today.
- **Mobile access on and Tailscale Running**: an additional listener bound to this Mac's
  Tailscale IPv4 (100.x) — never `0.0.0.0`. If Tailscale stops or the IP changes, that
  listener is closed and re-bound when it comes back.
- Defence in depth: every accepted connection's peer address must fall in the Tailscale
  ranges (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), else it is dropped before the handshake.
- The port is fixed per Mac (first free in the bridge range, then persisted) so a paired
  phone's saved address keeps working across restarts. Note: the bridge range 8455..=8475
  and fleet's 8475..=8495 overlap at 8475 today — fix that while here.
- Transport encryption is WireGuard (Tailscale). No TLS on top in this release.

### 3. Desktop Settings → Mobile (new panel)

One panel, built with the existing no-native-controls components (`Dropdown.tsx`, global
checkbox styling):

- **Tailscale status** row: one of
  - not installed → "Install Tailscale" (opens tailscale.com/download),
  - stopped / needs login → "Open Tailscale" (opens the app),
  - running → "Connected · <tailnet> · this Mac is <MagicDNS name>".
- **Mobile access** toggle (disabled with an explanation unless Tailscale is running).
- **Pair a phone** button → shows a QR code and a 4-digit confirm code (below).
- **Paired phones** list: name, last seen, Revoke.

### 4. Pairing (my call: QR first, then discovery through the Mac)

The prototype shows the phone listing Macs on the tailnet before any pairing. An iOS app can't
enumerate tailnet peers on its own (only the Tailscale app can), so the first Mac is reached
by QR:

1. Desktop "Pair a phone" shows a QR encoding `{ mac name, MagicDNS name, tailnet IP, port,
   one-time pairing secret (≥128-bit, 5-minute TTL), Mac's public key }`.
2. Phone (Connect screen) scans it, opens a WebSocket to the tailnet address, and presents the
   one-time secret plus its own device name and public key.
3. Desktop shows a confirm prompt "Pair <iPhone name>? Code 4821" — the same 4 digits shown
   on the phone (derived from both public keys, so a swapped QR shows a different code). The
   founder clicks Allow.
4. Desktop mints a long-lived per-device token, stores only its hash in
   `<dataDir>/mobile-devices.json`, and returns the token. The phone keeps it in the iOS
   Keychain (`expo-secure-store`).
5. Every later connection presents the device token in the first frame (not the URL query,
   so it doesn't land in any log). Revoking deletes the hash; an open socket for that device
   is closed at once.

**Addressing (my call).** The phone saves each Mac by MagicDNS name first and tailnet IP
second, and tries them in that order. Tailscale IPs are stable per device (they change only if
the Mac is removed from and re-added to the tailnet), so the IP is a fallback for a phone whose
MagicDNS is off, not a moving target. If both fail the Mac shows as offline; re-pairing by QR
recovers a Mac that was re-added to the tailnet.

Additional Macs (my call on the protocol):

- **Discovery.** Once paired with one Mac, the phone sends `discover`. That Mac reads
  `tailscale status --json` peers owned by the same Tailscale user, opens a WebSocket to the
  bridge port on each online peer with a 1.5 s timeout, and keeps those whose first frame is a
  valid `hello` (§7). `hello` is sent before auth precisely so this probe works; it carries
  only the Mac name, Conduit version and protocol version. The phone gets back `macs`
  {name, dnsName, ip, port, online, conduitVersion} and the Connect screen lists them as in
  the prototype.
- **Pairing a discovered Mac.** The phone connects DIRECTLY to the target Mac (never relayed
  through the first one) and sends `pair` {request, deviceName, publicKey}. The target Mac
  shows the same confirm prompt as step 3, with the 4-digit code; the founder Allows or
  Declines on that Mac. The request expires after 2 minutes. Decline or expiry answers
  `pair_result` {ok: false, reason} and the phone says so. Allow continues at step 4. At most
  one outstanding request per phone per Mac; a burst of requests from one peer is rate-limited
  (same `fleet::rate_limited` helper) so a tailnet peer cannot spam confirm prompts.
- A manual "enter address" fallback exists for when no Mac is reachable to ask; it uses the
  same request flow.

`tailscale whois` on the connecting peer is also recorded with the device so the Paired
phones list can show "Uzair's iPhone (uzair@)" and so a pairing request from a peer owned by a
**different** Tailscale user is shown with that user's name in the confirm prompt.

### 5. One shared message model (`transcript.rs`)

`transcript::parse_line` becomes the one place that decides what every transcript line is.
Both `SessionChat.tsx` and the phone render its output, and both receive the SAME items — the
phone is not a filtered subset. Every source in the table below is something Claude Code
itself writes into the session's JSONL (task notifications, other sessions' messages and
scheduled prompts arrive as injected user turns); Conduit injects nothing into transcripts
and this work does not change that. The parsing is therefore pure string/JSON work on a line,
testable without a running app. New/changed item kinds, grounded in an inventory of the
founder's last 60 transcripts:

| Source in the JSONL | Item | Rendering |
| --- | --- | --- |
| user string, plain | `bubble` user | right bubble |
| user string starting `<task-notification>` | `task` {status, summary, output path} | centred note: "✓ Background command finished (exit 0)" / "stopped" / "failed"; tap → summary |
| `<agent-message from=…>` / "Another Claude session sent a message" | `peer` {from, text} | centred note "Message from <session>", tap → text |
| scheduled task fire, `CONTINUITY RELAY TICK`, watchdog prompts, other automated prompts (`isMeta`, `system.scheduled_task_fire`) | `auto` {label, text} | centred note, tap → text |
| `<command-name>` + `<command-message>`/`<command-args>` | `command` {name, args} | small "/model opus" chip on the right |
| `<local-command-stdout>`, `<bash-input>`/`<bash-stdout>` | `command_output` | collapsed monospace block under the command |
| `<local-command-caveat>`, skill bodies ("Base directory for this skill:"), `[Image: …]` placeholders | dropped or `skill` {name} note | skill → "Loaded skill <name>"; caveat dropped |
| user `image` blocks | `image` | thumbnail |
| `system.compact_boundary` / `isCompactSummary` | `divider` "conversation compacted" | thin divider |
| `system.model_refusal_fallback`, interruptions ("[Request interrupted by user]") | `divider` with label | thin divider |
| assistant `text` | `bubble` assistant (markdown, `★ Insight` split as today) | left bubble |
| assistant `thinking` | dropped (my call — noise on a phone; revisit) | — |
| assistant `tool_use` runs | `tools` {items[]} — consecutive calls merged | one quiet line, tap to expand |
| `tool_use` `Task`/`Agent` | `subagent` {description, type} | note "⑂ subagent: <description>" |
| `tool_use` `AskUserQuestion` | `question` {id, questions, options, multiSelect} | question card (live only when pending — see §6) |
| `tool_use` `ExitPlanMode` | `plan` {markdown} | plan card |
| assistant `usage` | `usage` (unchanged) | not shown in chat |

Unknown tags degrade to a neutral collapsed note showing the tag name — never to a user
bubble. Every row of this table gets a `transcript.rs` unit test from a real (scrubbed)
fixture line. The phone's `WireChatItem` type and desktop's `TranscriptItem` are generated
from, or pinned by test against, the same list.

### 6. Answering from the phone

- **Questions.** Reuse the Continuity view's blocking `/ask` hook (`asks.rs`): it already holds
  `AskUserQuestion`, carries the answer back as `updatedInput.answers`, and hands off to the
  terminal on timeout. Two changes: the ask gate (`set_ask_gate`, currently "view open or a
  Conduit window focused") also opens while a paired phone is connected; and pending asks +
  `ask_answer` are exposed over the bridge. First answer wins (`ask_answer` returning `false`
  = already answered elsewhere), and both surfaces collapse the card on the resolution event.
- **Permission prompts.** Finish the dormant approval broker (`broker.rs` + `/approve` in
  `hooks.rs`): register pending requests, expose them over the bridge, resolve from phone or a
  desktop card, first responder wins, timeout falls back to the terminal prompt. The same
  gate rule as questions decides whether the hook holds the request at all.
- **Steering.** Unchanged mechanism: the prompt is typed into the session's PTY followed by
  Enter. **Stop** sends Esc (Claude's interrupt). A parked or hibernated session is started
  (the existing `start_session`) before the prompt is delivered.

### 7. Bridge protocol additions

Server → phone:
- `hello` {macName, conduitVersion, protocolVersion} on connect, before auth.
- `projects` grows: profiles (id, name), active profile, per-project colour (resolved),
  per-session agent id (all seven agents, not just three), status
  (`needsInput`/`running`/`idle`/`done`), last activity time, preview text, pending
  question/permission summary.
- `pending` {asks[], approvals[]} on attach/reconnect, then incremental `pending_added` and
  `resolved` {id, by: "phone" | "desktop" | "terminal" | "timeout"} events. `resolved` is
  emitted from inside `asks.rs` / `broker.rs` at the single point where an entry is resolved,
  so it fires no matter which surface answered — the desktop card, a phone, the terminal
  hand-off or the timeout. The desktop listens to the same event. The phone's answer goes
  straight to `ask_answer` / `Broker::resolve`; nothing is cached in the bridge.
- `macs` {peers[]} answering a discovery request.

Phone → server: `auth` {token}, `answer` {askId, answers}, `approve` {id, allow}, `interrupt`
{sessionId}, `discover`, `pair` {secret | request, deviceName, publicKey}.

A `protocolVersion` mismatch shows "Update Conduit on <Mac>" / "Update the app" rather than a
silently broken screen.

Unread counts are the phone's own (items arrived since it last opened that chat), stored on
the phone — the desktop has no notion of a phone's read state.

### 8. The phone app

Built on the existing `mobile/` app (Expo SDK 56, React Navigation, Warm palettes, the
`LiveProvider`/`BridgeClient` live channel), restyled to the prototype:

- **Connect** screen: Tailscale hint ("Tailscale must be on on this phone" with a link to the
  App Store app if the Mac is unreachable), Scan QR, list of discovered Macs, manual address.
- **Pair** screen: the 4-digit code and "Approve on your Mac".
- **Chats**, **Chat**, **Settings** exactly as the prototype (Settings: current Mac, route,
  Switch Mac, notification toggles, theme).
- Status bar shows the connected Mac; disconnected shows "<Mac> offline · last seen …" and
  keeps the last-known list readable.
- Remove the mock data path and the hand-typed URL/token fields; update the stale
  `mobile/README.md`.

### 9. Notifications — in-app only (founder's ruling)

While the app is open, a session newly entering "needs you" (a question or permission prompt
arrives) drops an in-app banner from the top naming the session and what it asks; tapping it
opens that chat. A banner is not shown for the chat already on screen. Settings gets toggles
for which events raise a banner (question, permission: on; session finished: off).

When the app returns to the foreground it reconnects and re-reads `projects` + `pending`, so
anything that started waiting while it was closed is on top of the list at once — no
background delivery is attempted.

Explicitly out of scope: lock-screen/background notifications. iOS drops the WebSocket seconds
after the app leaves the foreground, and waking the phone needs Apple Push, whose signing key
must live on a server and can never ship inside Conduit. The founder chose in-app only for
this release; a small push relay (e.g. a Cloudflare Worker holding the APNs key, receiving only
"session X needs you", never chat text) is the planned follow-up, and the bridge's
needs-you transition is the event it would hook.

## Left to the builder

- Exact Settings panel layout, as long as it uses the existing component vocabulary.
- `mobile-devices.json` schema (versioned, read defensively like `readCanvas`; tokens hashed
  with SHA-256 — they are high-entropy, so no slow KDF is needed).
- What happens if the persisted bridge port is taken at launch: pick the next free one, show
  it in Settings, and paired phones re-learn it through discovery or a re-scan.
- How the 4-digit confirm code is derived from the two public keys.
- Polling cadence of `tailscale status` within the bounds above.
- Whether the phone caches the last chat list for offline viewing (nice, not required).
- Whether Conduit offers "keep this Mac awake while mobile access is on and a session is
  running" (`caffeinate -i` on macOS). Small and useful for the founder's use case; build it
  only if it stays a few lines and a toggle.
- Splitting this into plans: suggested order is (1) message model in `transcript.rs` +
  desktop chat mode, which ships value on its own; (2) Tailscale detection + Settings panel +
  Tailscale-only bind + pairing; (3) phone UI to the prototype; (4) questions/permissions
  from the phone (including the in-app banner).

## Existing code this builds on

- `src-tauri/src/bridge.rs` — WebSocket server, `list`/`attach`/`input`/`git`/`kill`/`spawn`.
- `src-tauri/src/transcript.rs`, `src/components/SessionChat.tsx` — the shared parser and the
  desktop chat mode.
- `src-tauri/src/asks.rs`, `/ask` in `hooks.rs` — blocking question hook.
- `src-tauri/src/broker.rs`, `/approve` in `hooks.rs` — dormant approval broker.
- `mobile/` — Expo app, `src/bridge/*`, `src/screens/*`, `src/theme/palettes.ts`.
- Prior specs: `2026-06-25-conduit-mobile-companion-design.md` (chose Tailscale for v1, QR +
  X25519 pairing), `2026-06-30-conduit-mobile-chat-companion-design.md` (chat-not-terminal),
  `2026-07-15-mobile-multi-provider-access-design.md` (superseded on transport by this spec).
