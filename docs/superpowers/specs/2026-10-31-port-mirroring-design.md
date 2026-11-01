# Port mirroring: your computer's localhost, on your phone

## Goal

Anything served on the computer's `localhost` (a Vite/Next dev server, a Docker-published
port, nginx, a venv's Flask/FastAPI, an agent's preview) opens on a paired phone at the SAME
URL -- `http://localhost:<port>` -- with **no change to the app, the agent, or Tailscale**.

## Why not "just browse to the computer's Tailscale name"

| Breaks | Why |
|---|---|
| unreachable | most dev servers bind `127.0.0.1`; fixing it is a per-app edit |
| exposure | the per-app fix (`0.0.0.0`) also exposes the app to every LAN the laptop joins |
| API calls | a frontend calling `localhost:8000` calls the PHONE |
| host checks | Vite's `server.allowedHosts`, Next's `allowedDevOrigins` reject a foreign Host |
| secure context | `http://localhost` is one, `http://laptop:3000` is not (service workers, `crypto.subtle`, camera) |

Mirroring the phone's loopback onto the computer's loopback (SSH `-L`, `kubectl
port-forward`, VS Code "Ports") fixes all five at once: same host, same port, same origin.

## Shape

```
phone browser -> phone 127.0.0.1:P -> PortMirror service -> WS (device token) -> bridge -> computer 127.0.0.1:P
```

- **Desktop** discovers which local ports serve HTTP and lets a paired phone open a byte
  tunnel to one of them. Nothing new listens on the tailnet: the tunnel rides the existing
  bridge listener, behind the same device-token auth.
- **Phone (Android)** runs a foreground service with one loopback listener per mirrored port;
  each accepted connection becomes one tunnel WebSocket.

## Desktop

### Discovery (`local_ports.rs`)

- Listening sockets from the OS: `netstat -ano -p TCP` + `TCPv6` (Windows), `lsof -nP
  -iTCP -sTCP:LISTEN -F pcn` (macOS), `ss -ltnpH` (Linux). Parsers are pure and tested.
- Per port, the loopback **target** is `127.0.0.1` when bound to `127.0.0.1`/`0.0.0.0`, else
  `::1` when bound to `::1`/`::` (Node 17+ resolves `localhost` to `::1` on some setups). A
  socket bound only to a specific non-loopback address is not a local app and is skipped.
- Excluded: Conduit's own process (hook server, MCP servers, per-session IDE ports), the
  reserved range `8423..=8516` as a backstop, Windows' `System` (pid 4, http.sys).
- Kept only if it **answers HTTP**: a `HEAD /` with `Host: localhost:<port>`, 400 ms, and the
  reply starts `HTTP/`. Memoized per (port, pid), so a port is probed once per process.
  Probes run in parallel threads.
- Result cached; a scan is at most every 2 s however many phones ask.

### Protocol (bridge)

Control socket (authenticated):

- `{type:"ports"}` -> `{type:"ports", enabled, ports:[{port, process}]}`. Off -> empty list.

Tunnel socket (a NEW WebSocket per TCP connection, first frame pre-auth):

- `{type:"tunnel", token, port}` -> `{type:"tunnelOk", port}`, then **binary frames both
  ways are raw TCP bytes**. Refusals: `unauthorized` / `unavailable` (same rules as `auth`,
  same rate limit), `port` (not a currently discovered web port, or mirroring off), `busy`
  (64 tunnels per device). Loopback peers skip the token, as they skip `auth`.
- A tunnel is NOT a live phone: it never registers in `live`, so it never holds a question.
  It does register in `tunnels`, so revoke, access-off and mirroring-off close it at once.
- The tunnel is a validated port on loopback only -- never a host, never another address.
  That is what keeps this from being a general-purpose relay.
- One relay thread per tunnel; app->phone reads go through a bounded channel (backpressure),
  writes on both sides are bounded (`WRITE_STALL`), and a tunnel that hears nothing for
  `STALE_AFTER` is closed (pinged every `PING_EVERY`, like the control socket).

### Setting

`mobile-devices.json` gains `mirrorOff` (absent = mirroring ON once mobile access is on).
Stored inverted so every existing file reads as "on" through `#[serde(default)]`. Settings ->
Mobile shows "Let paired phones open local web apps".

## Phone

- `modules/port-mirror`: a local Expo module, **Android only** (`expo-module.config.json`).
  - `start({url, token, ports})`, `stop()`, `status()`. `ports` is `[{remote, local}]`.
  - `PortMirrorService`: foreground service (`specialUse`), ongoing notification "Mirroring N
    ports", one `ServerSocket` per port bound to `127.0.0.1` only.
  - Per accepted socket: OkHttp WebSocket to the bridge, `tunnel` frame, wait `tunnelOk`,
    then pump bytes. App->phone bytes are written to the socket on OkHttp's reader thread
    (natural backpressure); phone->app bytes wait while OkHttp's queue is over 1 MiB.
  - A port below 1024 cannot be bound without root: it is mirrored at `10000 + port`.
- JS: `logic/ports.ts` (pure: local port mapping, merge of the desktop list with mirror
  state), an **Apps** tab listing the computer's web ports with a master "Mirror" switch;
  tapping a row opens `http://localhost:<local>` in the system browser.
- iOS: suspends background apps, so Safari could never reach a mirror. The tab says so; an
  in-app browser is the follow-up.

## Security notes

- Nothing new is reachable from the tailnet: same listener, same auth, same rate limit.
- Apps stay on loopback; café Wi-Fi and other tailnet nodes see nothing.
- Trade-off, accepted: while mirroring, any app ON THE PHONE can connect to its loopback
  ports. Mitigations: off unless switched on, the ongoing notification, and the service
  stops when the switch goes off or the bridge refuses the token.
- Tunnelled bytes are never logged.
