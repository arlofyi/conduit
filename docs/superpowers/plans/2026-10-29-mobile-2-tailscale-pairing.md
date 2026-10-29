# Mobile 2 — Tailscale and pairing (desktop side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Mac's mobile bridge is reachable from anywhere on the user's tailnet and nowhere else, turned on and paired entirely from Settings → Mobile, with every phone approved once on the Mac and revocable.

**Architecture:** A new `tailscale.rs` reads the installed Tailscale app's state by shelling out to its CLI (pure parsers, tested on fixture JSON). A new `mobile_devices.rs` owns a side file of paired devices (hashed tokens) plus the "mobile access" switch and persisted port. `bridge.rs` gains a managed controller that binds loopback always and the Mac's Tailscale IPv4 only while mobile access is on, filters peers to tailnet ranges, sends a `hello` frame first, and requires a first-frame `auth` from every non-loopback peer. A `pairing.rs` registry mints one-time QR secrets and holds pair requests until the user allows or declines them on the Mac (same shape as `asks.rs`/`ask-request`). The desktop gets a Settings → Mobile panel and a pair-prompt card. The phone side (scan, Keychain, Connect/Pair screens) is plan 3; the phone keeps working over loopback meanwhile.

**Tech Stack:** Rust (std::process, serde_json, sha2, uuid, tungstenite 0.23), React 19 + TS (vitest), one new pure-JS dependency for QR rendering.

**Spec:** `docs/superpowers/specs/2026-10-29-mobile-over-tailscale-design.md` §1–4 and §7 (bridge protocol). Read the spec's anti-goals before starting.

## Global Constraints

- **Never** bind `0.0.0.0` / `::`. Listeners: `127.0.0.1:<port>` always; `<tailscale IPv4>:<port>` only while mobile access is on AND Tailscale state is `Running`. Same port on both.
- Port range **8455..=8474** (was 8455..=8475, which overlapped fleet's 8475..=8495). The chosen port is persisted in `mobile-devices.json` and reused at every launch; if taken, the next free one in range is used, persisted, and shown in Settings.
- Accepted peers: loopback, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`. Anything else is dropped before the WebSocket handshake. A handshake carrying an `Origin` header is refused (a web page must never reach the bridge).
- Loopback peers stay unauthenticated (the matrix-adapter sidecar and the simulator rely on it). Every non-loopback peer must send `{"type":"auth","token":…}` as its first frame within **5 s**, or `pair`/`discover` (allowed pre-auth); anything else pre-auth closes the socket. Pre-auth messages are capped at **4 KiB**. Failed auth/pair attempts are rate-limited per peer IP with `fleet::rate_limited` (**5 per 60 s**); failure replies are a generic `{"type":"error","message":"unauthorized"}` (no oracle).
- `hello` is the first server frame to every peer, before auth: `{"type":"hello","macName":…,"conduitVersion":…,"protocolVersion":1}`. Nothing else is sent pre-auth except replies to `pair`/`discover`.
- New wire messages use **camelCase** fields with explicit serde renames; existing ones (`session_id`) are unchanged. Pin both with tests.
- Secrets: device tokens = two v4 UUIDs concatenated (`Uuid::new_v4().simple()` ×2, the `cli_open.rs` recipe); only the SHA-256 hex of a token is stored; comparisons are constant-time (hash vs hash). Pairing secrets are ≥ 128-bit (same recipe), single-use, **5-minute** TTL. No token, secret or QR payload is ever logged (`eprintln!` included).
- Device records and the switch live in `<data_dir>/mobile-devices.json` (`{"version":1,"enabled":bool,"port":u16|null,"devices":[…]}`), never in `state.json`; read defensively (missing/unparseable → defaults, and an unparseable file is renamed to `mobile-devices.json.bak` before the next write); written atomically (`.tmp` + rename, removing the target first on Windows — `hotexit.rs` recipe).
- Tailscale CLI lookup is subprocess-free (`tmux.rs` `find_tmux` pattern): `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale`, `/usr/bin/tailscale`, then `PATH`; on Windows `C:\Program Files\Tailscale\tailscale.exe` then `PATH` with `tailscale.exe`. Every `Command` uses `.no_window()`. Every CLI call has a **3 s** deadline (spawn + `try_wait` loop, kill on timeout). Every command that spawns is `#[tauri::command(async)]`.
- Conduit only READS Tailscale state. It never runs `tailscale up/down/set/serve/funnel/login`.
- Pair requests wait **120 s** for an answer, then resolve as declined. At most one outstanding request per peer IP.
- Confirmation code: `format!("{:04}", u16::from_be_bytes(sha256(secret_or_request_id ‖ phone_nonce)[0..2]) % 10000)` — shown on the Mac's prompt and computed by the phone from the same inputs (Ruling: no curve crate exists; the code binds the prompt to the phone holding the nonce).
- Lean deps: no new Rust crates. One JS dependency, `qrcode-generator@1.4.4`, pinned exactly, lockfile updated.
- Windows CI leg compiles and lints everything; `cfg(unix)` APIs behind `cfg`; no test assumes Tailscale is installed.
- Conventional Commits (`feat(mobile)`, `fix(mobile)`…); NO `Co-Authored-By`/AI trailer. CHANGELOG under `## Unreleased`. Do not launch the desktop dev app (the founder verifies UI; see plan footer).

## Review Focus

1. Tailscale restarts or its IP changes while mobile access is on: the tailnet listener must be closed and re-bound to the new IP within one 30 s tick, and never left bound to a stale address. → Task 3 test `rebind_plan_follows_ip_change` (pure planner).
2. A revoked phone with an open socket must be disconnected immediately, not at its next reconnect. → Task 3 test `revoke_flags_live_connection`.
3. Tailscale `Stopped` with `Self.TailscaleIPs` still populated (the real state on the founder's Mac today): must read as `Stopped`, and no tailnet listener may be bound to that IP. → Task 1 test `stopped_with_ips_is_stopped`.
4. A browser page on the Mac opening `ws://127.0.0.1:8455` (loopback, unauthenticated) must be refused because it carries `Origin`. → Task 3 test `origin_header_is_refused`.
5. Two pair requests racing for the same secret (e.g. a screenshot of the QR): the secret is consumed by the first, the second gets the generic error. → Task 4 test `secret_is_single_use`.

---

### Task 1: `tailscale.rs` — locate, run, parse

**Files:** Create `src-tauri/src/tailscale.rs`; modify `src-tauri/src/lib.rs` (`mod tailscale;`, register the command).

**Interfaces (produces):**
- `#[derive(Serialize, Clone, Debug, PartialEq)] #[serde(tag = "state", rename_all = "camelCase")] pub enum TailscaleState { NotInstalled, Stopped, NeedsLogin, Running { tailnet: String, self_name: String, dns_name: String, ipv4: Option<Ipv4Addr>, ipv6: Option<Ipv6Addr>, user_id: u64 }, Unknown { reason: String } }` — fields camelCase on the wire.
- `pub fn parse_status(json: &str) -> TailscaleState` — `BackendState` `"Running"` → Running (tailnet = `CurrentTailnet.Name`, `self_name` = `Self.HostName`, `dns_name` = `Self.DNSName` without trailing `.`, first v4/v6 of `Self.TailscaleIPs`, `user_id` = `Self.UserID`); `"Stopped"` → Stopped; `"NeedsLogin"`/`"NeedsMachineAuth"` → NeedsLogin; anything else or bad JSON → Unknown.
- `#[derive(Serialize, Clone, Debug, PartialEq)] pub struct Peer { name: String, dns_name: String, ipv4: Option<Ipv4Addr>, online: bool, user_id: u64, os: String }` and `pub fn parse_peers(json: &str) -> Vec<Peer>` (from `Peer` map values).
- `pub fn parse_whois(json: &str) -> Option<WhoIs>` with `WhoIs { login_name: String, display_name: String, user_id: u64 }` (from `UserProfile.LoginName/DisplayName/ID`).
- `pub fn is_tailnet_addr(ip: IpAddr) -> bool` (100.64.0.0/10 or fd7a:115c:a1e0::/48) and `pub fn is_allowed_peer(ip: IpAddr) -> bool` (loopback or tailnet).
- `fn find_cli(exists: impl Fn(&Path) -> bool, path_env: Option<&str>) -> Option<PathBuf>` (pure, injected predicate, per the Global Constraints list), `pub fn cli_path() -> Option<PathBuf>`.
- `fn run_cli(args: &[&str]) -> Result<String, String>` (3 s deadline) and `pub fn status() -> TailscaleState` (no CLI → NotInstalled), `pub fn peers() -> Vec<Peer>`, `pub fn whois(ip: IpAddr) -> Option<WhoIs>`.
- `#[tauri::command(async)] pub fn tailscale_status() -> TailscaleState` and `#[tauri::command(async)] pub fn tailscale_open_app()` (macOS `open -a Tailscale`; Windows launch `C:\Program Files\Tailscale\tailscale-ipn.exe`; else no-op).

- [ ] **Step 1: Failing tests** with fixture JSON trimmed from the real shape below: `running_status_parses` (asserts tailnet `uziiuzair.com`, dns `uzairs-macbook-pro.tailc7b992.ts.net`, ipv4 `100.120.238.84`), `stopped_with_ips_is_stopped`, `needs_login`, `bad_json_is_unknown`, `peers_parse` (two peers, one offline), `whois_parses`, `tailnet_ranges` (100.64.0.1 ✓, 100.127.255.255 ✓, 100.128.0.1 ✗, 192.168.1.5 ✗, fd7a:115c:a1e0::1 ✓, fe80::1 ✗, 127.0.0.1 → allowed peer but not tailnet), `find_cli_prefers_app_bundle`, `find_cli_falls_back_to_path`.
  Real shape (`tailscale status --json`, Tailscale 1.102.2): `{"BackendState":"Stopped","Self":{"HostName":"Uzair’s MacBook Pro","DNSName":"uzairs-macbook-pro.tailc7b992.ts.net.","TailscaleIPs":["100.120.238.84","fd7a:115c:a1e0::5239:ee55"],"UserID":2963369091006053,"OS":"macOS","Online":false},"MagicDNSSuffix":"tailc7b992.ts.net","CurrentTailnet":{"Name":"uziiuzair.com","MagicDNSSuffix":"tailc7b992.ts.net","MagicDNSEnabled":true},"User":null,"Peer":null}` — `Peer` is a map keyed by node key when present; `whois --json` returns `{"Node":{…},"UserProfile":{"ID":…,"LoginName":"…","DisplayName":"…"}}`.
- [ ] **Step 2:** `cargo test --manifest-path src-tauri/Cargo.toml tailscale` → FAIL.
- [ ] **Step 3: Implement.** You may run `tailscale status --json` / `tailscale whois --json <ip>` locally (read-only) to confirm shapes; never `up/down/set`.
- [ ] **Step 4:** full `cargo test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit** `feat(mobile): read Tailscale state from its CLI`

### Task 2: `mobile_devices.rs` — switch, port, paired devices

**Files:** Create `src-tauri/src/mobile_devices.rs`; modify `src-tauri/src/lib.rs` (manage `Arc<MobileDevices>`, register commands); make `cli_open::secret_eq` `pub(crate)` (reuse, don't copy).

**Interfaces (produces):**
- `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")] pub struct Device { id: String, name: String, token_hash: String, tailscale_login: Option<String>, created_at: u64, last_seen: Option<u64> }` (seconds since epoch). The `token_hash` is never sent to the frontend: the list command returns `DeviceView` without it.
- `#[derive(Serialize, Deserialize, Default)] struct FileV1 { version: u32, enabled: bool, port: Option<u16>, devices: Vec<Device> }`.
- `pub struct MobileDevices { path: PathBuf, inner: Mutex<FileV1> }` with `pub fn load(path: PathBuf) -> Self`, `pub fn enabled(&self) -> bool`, `pub fn set_enabled(&self, on: bool)`, `pub fn port(&self) -> Option<u16>`, `pub fn set_port(&self, p: u16)`, `pub fn add_device(&self, name: &str, login: Option<String>) -> (Device, String /* plaintext token, returned once */)`, `pub fn verify(&self, token: &str) -> Option<String /* device id */>` (hashes the presented token, constant-time compares against each stored hash, updates `last_seen`), `pub fn revoke(&self, id: &str) -> bool`, `pub fn list(&self) -> Vec<DeviceView>`.
- `pub fn mint_secret() -> String` (two simple v4 UUIDs) and `pub fn sha256_hex(s: &str) -> String`.
- Commands: `mobile_settings() -> {enabled, port, devices}`, `mobile_set_enabled(on: bool)` (also tells the bridge controller to reconcile — Task 3 wires the call; here store only), `mobile_revoke_device(id) -> bool`.

- [ ] **Step 1: Failing tests** (temp files under `std::env::temp_dir()` with a uuid name): `missing_file_is_defaults`, `unparseable_file_is_backed_up_and_defaulted`, `round_trip_persists_enabled_port_devices`, `token_verifies_and_hash_is_stored_not_token` (file contents do not contain the token), `wrong_token_rejected`, `revoked_device_cannot_verify`, `list_omits_token_hash`, `atomic_write_leaves_no_tmp`.
- [ ] **Step 2–4:** run → FAIL; implement; full cargo test/fmt/clippy → PASS.
- [ ] **Step 5: Commit** `feat(mobile): store paired phones as hashed tokens in their own file`

### Task 3: Bridge controller — Tailscale-only bind, hello, auth, revoke

**Files:** Modify `src-tauri/src/bridge.rs` (substantially), `src-tauri/src/lib.rs` (manage controller, replace `bridge::start` call, `mobile_set_enabled` triggers reconcile), port strings in `src-tauri/src/root_mcp.rs`, `src-tauri/src/fleet_mcp.rs`, `CLAUDE.md` (port-range line), `sidecars/matrix-adapter/SETUP.md` (drop the `CONDUIT_BRIDGE_TOKEN` mention; loopback unchanged).

**Interfaces:**
- Consumes: Task 1 `status()`, `is_allowed_peer`; Task 2 `MobileDevices`.
- Produces: `pub struct BridgeController { … }` managed as `Arc<BridgeController>` with `pub fn start(self: &Arc<Self>, app: AppHandle)` (binds loopback, spawns a 30 s reconcile thread), `pub fn reconcile(&self)` (pure decision via `plan_listeners`, then apply), `pub fn disconnect_device(&self, device_id: &str)`, `pub fn current_port(&self) -> u16`.
- Pure helpers (tested): `pub fn plan_listeners(enabled: bool, ts: &TailscaleState, bound_tailnet: Option<Ipv4Addr>) -> ListenerPlan` where `ListenerPlan { bind: Option<Ipv4Addr>, close: bool }` (bind the new IP / close a stale one / no-op); `pub fn pick_port(persisted: Option<u16>, is_free: impl Fn(u16) -> bool) -> Option<u16>` (persisted first if free, else first free in 8455..=8474); `fn hello_payload(mac_name, version) -> Value`; `fn has_origin(req: &Request) -> bool`.
- Accept loop: nonblocking `accept` + 100 ms sleep checking a stop flag per listener (so a tailnet listener can be closed). Before handshake: `peer_addr()` must pass `is_allowed_peer`. Handshake via `accept_hdr` refusing any `Origin` with 403. Pre-auth size cap: the loop closes the socket when an unauthenticated peer sends a frame longer than 4 KiB (tungstenite's config cannot be changed after the handshake, so the check lives in the loop); post-auth frames are unlimited as today.
- Connection state in `handle_conn`: `authed = peer.is_loopback()`, `device_id: Option<String>`, `deadline = now + 5 s`; send `hello` immediately; pre-auth accept only `auth`, `pair`, `discover` (Task 4 fills the latter two; here they reply `error`); on `auth` call `MobileDevices::verify`, register the connection's `Arc<AtomicBool>` in the controller's live map keyed by device id; check the flag each tick and close when set (revoke).
- `ClientMsg` gains `Auth { token: String }`, `Pair { secret: Option<String>, request: Option<bool>, device_name: String, nonce: String }` (camelCase renames: `deviceName`), `Discover`, and `Interrupt { session_id }` (sends `\x1b` to the PTY — spec §6 Stop). Tests pin the wire spelling.
- Remove `bridge_token`, `bridge_host`, `extract_query_token`, `token_ok`, the `?token=` path and their tests; update the module doc.

- [ ] **Step 1: Failing tests**: `rebind_plan_follows_ip_change`, `plan_closes_when_disabled`, `plan_closes_when_tailscale_stops`, `plan_noop_when_unchanged`, `pick_port_prefers_persisted`, `pick_port_skips_taken_and_8475_is_out_of_range`, `origin_header_is_refused`, `hello_shape`, `parses_auth_pair_discover_interrupt` (exact camelCase JSON), `revoke_flags_live_connection` (controller-level: register a flag for device "d1", `disconnect_device("d1")` sets it). Plus an integration test in `src-tauri/tests/bridge_auth.rs` if feasible without an `AppHandle` (pure `handle_conn` is not; skip if it needs one and say so).
- [ ] **Step 2–4:** run → FAIL; implement; full cargo test/fmt/clippy → PASS (both `cfg` arms compile).
- [ ] **Step 5: Commit** `feat(mobile): bridge listens only on loopback and the Tailscale address, with per-device auth`

### Task 4: Pairing — QR secret, requests, confirm on the Mac, discovery

**Files:** Create `src-tauri/src/pairing.rs`; modify `bridge.rs` (`pair`/`discover` handlers), `lib.rs` (manage `Arc<Pairing>`, commands).

**Interfaces:**
- `pub struct Pairing` with `pub fn start_qr(&self, mac: &MacInfo, port: u16) -> QrPayload` (mints a secret, replaces any previous one, TTL 5 min), `pub fn consume_secret(&self, s: &str) -> bool` (single use, expiry-checked, constant-time), `pub fn register(&self, req: PairRequest) -> (String /* id */, Receiver<bool>)`, `pub fn resolve(&self, id: &str, allow: bool) -> bool` (first responder wins), `pub fn pending(&self) -> Vec<PairRequestView>`, sweep on every call.
- `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct QrPayload { v: u8 /* 1 */, mac_name: String, dns_name: String, ip: String, port: u16, secret: String }`; the frontend renders `JSON.stringify(payload)` as the QR text.
- `PairRequest { peer: IpAddr, device_name: String, nonce: String, via: Via /* Secret | Request */, login: Option<String> }`; `PairRequestView { id, deviceName, code, login, peer, via, expiresAt }` — `code` per Global Constraints (inputs: the secret for `Via::Secret`, the request id for `Via::Request`).
- Bridge `pair` handler (pre-auth allowed): rate-limit per IP; with `secret` → `consume_secret` must succeed (else generic error); with `request: true` → allowed only when mobile access is on; `whois(peer)` for the login (on this path only, never in the tick); `register`; emit `pair-request` (view); block that connection's loop (it has nothing else to do) on `recv_timeout(120 s)`; on allow → `MobileDevices::add_device` → reply `{"type":"pairResult","ok":true,"token":…,"deviceId":…}` and mark the connection authed; else `{"type":"pairResult","ok":false,"reason":"declined"|"expired"}`; always emit `pair-resolved {id, how}`.
- Bridge `discover` handler (post-auth only): `tailscale::peers()` filtered to online peers with the same `user_id` as Self, each probed with a 1.5 s WebSocket connect to `<ip>:<port candidates 8455..=8474>` — probe stops at the first port that answers with a valid `hello` (first frame) — reply `{"type":"macs","macs":[{name,dnsName,ip,port,online,conduitVersion}]}`; the probe runs on its own thread so the connection loop keeps ticking.
- Commands: `pair_start() -> QrPayload` (errors unless mobile access is on and Tailscale is Running), `pair_pending() -> Vec<PairRequestView>`, `pair_respond(id, allow) -> bool`.

- [ ] **Step 1: Failing tests** (pure, no sockets): `secret_is_single_use`, `secret_expires_after_5_minutes` (injectable clock), `new_qr_replaces_old_secret`, `code_is_4_digits_and_deterministic` (fixed inputs → fixed code), `resolve_first_responder_wins`, `request_expires_as_declined` (clock), `one_outstanding_request_per_peer`, `qr_payload_camel_case_shape`.
- [ ] **Step 2–4:** run → FAIL; implement; full cargo test/fmt/clippy → PASS.
- [ ] **Step 5: Commit** `feat(mobile): pair phones with a one-time QR and approve them on the Mac`

### Task 5: Desktop UI — Settings → Mobile and the pair prompt

**Files:** Create `src/components/MobilePanel.tsx`, `src/components/PairPrompt.tsx`, `src/mobilePairing.ts` (+ `src/mobilePairing.test.ts`); modify `src/components/Settings.tsx` (tab `mobile` in a NAV group, label "Mobile"), `src/App.tsx` (listen `pair-request`/`pair-resolved` before a `pair_pending` catch-up; mount `PairPrompt` beside `AskDock`), `src/store.ts` (pending pair requests slice), the main stylesheet, `package.json` + `pnpm-lock.yaml` (`qrcode-generator@1.4.4`).

**Interfaces:**
- Consumes: commands `tailscale_status`, `tailscale_open_app`, `open_external`, `mobile_settings`, `mobile_set_enabled`, `mobile_revoke_device`, `pair_start`, `pair_pending`, `pair_respond`; events `pair-request`, `pair-resolved`.
- `src/mobilePairing.ts` (pure, tested): `tailscaleRow(state: TailscaleState): { label: string; action: "install" | "open" | null }` (NotInstalled → "Tailscale is not installed", install; Stopped/NeedsLogin → "Tailscale is off on this Mac" / "Sign in to Tailscale", open; Running → `Connected · <tailnet> · this Mac is <dnsName>`, null; Unknown → "Couldn't read Tailscale: <reason>", open); `qrSvg(text: string): string` (wraps `qrcode-generator`, type 0 auto, error level "M", returns an SVG string); `secondsLeft(expiresAt: number, now: number): number`.
- **MobilePanel:** (1) Tailscale row (poll `tailscale_status` every 5 s while mounted) with an "Install Tailscale" (`open_external("https://tailscale.com/download")`) or "Open Tailscale" button; (2) `SettingRow` toggle "Mobile access" — disabled with the reason unless Tailscale is Running; (3) "Pair a phone" button → inline card with the QR (`qrSvg(JSON.stringify(payload))`), the Mac's address and port as text, a 5-minute countdown, and "Cancel"; (4) "Paired phones" list: name, Tailscale login, last seen ("never" / relative), "Revoke" (confirm inline, no `window.confirm`); (5) port shown in small text.
- **PairPrompt:** card stack mounted next to `AskDock`: "Pair **<deviceName>**?" + login line + big 4-digit code + "Check this code matches your phone." + Decline / Allow. Resolves via `pair_respond`; removed on `pair-resolved`. Appears even when Settings is closed.
- No native form controls; `SettingRow`/buttons only.

- [ ] **Step 1: Failing tests** in `src/mobilePairing.test.ts`: all `tailscaleRow` states; `qrSvg` returns a string starting `<svg` and is deterministic for the same input; `secondsLeft` clamps at 0.
- [ ] **Step 2–4:** run → FAIL; implement; `pnpm install` (adds the dep), `pnpm test && pnpm exec tsc --noEmit && pnpm build` → PASS.
- [ ] **Step 5: Commit** `feat(mobile): Settings → Mobile panel and pair prompt`

### Task 6: Docs

**Files:** `CHANGELOG.md`, `CLAUDE.md`.

- [ ] **Step 1: CHANGELOG** under `## Unreleased`:

```
- **Added — Mobile access over Tailscale.** Settings → Mobile shows whether Tailscale is running, turns on mobile access, and pairs a phone with a one-time QR code you approve on the Mac. The phone reaches this Mac from anywhere on your tailnet — never from the open network — and any paired phone can be revoked at once.
- **Changed — The mobile bridge no longer opens to the local network.** The old `CONDUIT_BRIDGE_TOKEN` setting is gone; the bridge listens only on this Mac and its Tailscale address.
```

- [ ] **Step 2: CLAUDE.md** — new section "## Where the mobile bridge lives" (after "Where the `conduit` CLI lives"), terse, covering: `tailscale.rs` reads only (never `up/set/serve/funnel`); listeners loopback + Tailscale IPv4 only, never 0.0.0.0, re-planned every 30 s by `plan_listeners`; peer filter + Origin refusal; loopback unauthenticated, everything else first-frame `auth`; `mobile-devices.json` holds hashed tokens, never `state.json`; pairing secret single-use 5 min, requests 120 s, approve on the Mac (`pair-request` mirrors `ask-request`); port range 8455..=8474 and why (fleet overlap).
- [ ] **Step 3: Commit** `docs(mobile): Tailscale bridge and pairing`

---

**Founder walk-through after this plan (not done by agents):** Settings → Mobile with Tailscale off (row says so, toggle disabled), turn Tailscale on, toggle mobile access on, "Pair a phone" shows a QR; from another tailnet device, `websocat ws://<mac>.ts.net:<port>` receives `hello` and is disconnected after 5 s without auth; the phone pairing flow itself arrives with plan 3.
