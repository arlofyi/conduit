import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Notice, SettingRow } from "./ui";
import {
  lastSeenLabel,
  qrSvg,
  secondsLeft,
  tailscaleRow,
  type MobileSettings,
  type QrPayload,
  type TailscaleState,
} from "../mobilePairing";

const nowSecs = () => Math.floor(Date.now() / 1000);
const PAIR_TTL_SECS = 300;

/** Settings → Mobile: Tailscale status, the access switch, QR pairing and paired phones. */
export function MobilePanel() {
  const [ts, setTs] = useState<TailscaleState | null>(null);
  const [cfg, setCfg] = useState<MobileSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [now, setNow] = useState(nowSecs());

  const refreshCfg = useCallback(() => {
    void invoke<MobileSettings>("mobile_settings").then(setCfg).catch(() => {});
  }, []);

  useEffect(() => {
    const tick = () => void invoke<TailscaleState>("tailscale_status").then(setTs).catch(() => {});
    tick();
    refreshCfg();
    const t = setInterval(tick, 5000);
    const c = setInterval(refreshCfg, 5000); // keeps "last seen" and new devices fresh
    return () => {
      clearInterval(t);
      clearInterval(c);
    };
  }, [refreshCfg]);

  useEffect(() => {
    const t = setInterval(() => setNow(nowSecs()), 1000);
    return () => clearInterval(t);
  }, []);

  const running = ts?.state === "running";
  const row = ts ? tailscaleRow(ts) : null;

  const setEnabled = (on: boolean) => {
    setError(null);
    invoke("mobile_set_enabled", { on })
      .then(refreshCfg)
      .catch((e) => setError(String(e)));
  };

  const revoke = (id: string) => {
    setError(null);
    setRevoking(null);
    invoke<boolean>("mobile_revoke_device", { id })
      .then(refreshCfg)
      .catch((e) => setError(String(e)));
  };

  return (
    <>
      <SettingRow
        id="mobile-tailscale"
        title="Tailscale"
        detail="Conduit reaches your phone over your private Tailscale network. It only reads Tailscale's status; it never changes your Tailscale settings."
        status={row ? row.label : "Checking Tailscale…"}
        control={
          row?.action ? (
            row.action === "install" ? (
              <Button variant="secondary" onClick={() => void invoke("open_external", { url: "https://tailscale.com/download" })}>
                Install Tailscale
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => void invoke("tailscale_open_app")}>
                Open Tailscale
              </Button>
            )
          ) : undefined
        }
      />
      <SettingRow
        id="mobile-access"
        title="Mobile access"
        detail="Lets paired phones on your tailnet read and drive your sessions. Off by default; turning it off disconnects every phone and cancels pairing."
        status={!running && !cfg?.enabled ? "Needs Tailscale connected on this Mac." : undefined}
        checked={!!cfg?.enabled}
        disabled={!cfg || (!running && !cfg.enabled)}
        onChange={setEnabled}
      />
      {error && <Notice tone="error">{error}</Notice>}
      {cfg?.enabled && <PairCard now={now} running={running} />}
      <div className="mobile-devices">
        <div className="section-label">Paired phones</div>
        {cfg && cfg.devices.length === 0 && <div className="mobile-empty">No phones paired yet.</div>}
        {cfg?.devices.map((d) => (
          <div className="mobile-device" key={d.id}>
            <div className="mobile-device-main">
              <div className="mobile-device-name">{d.name}</div>
              <div className="mobile-device-meta">
                {d.tailscaleLogin ?? "unknown account"} · last seen {lastSeenLabel(d.lastSeen, now)}
              </div>
            </div>
            {revoking === d.id ? (
              <span className="mobile-device-confirm">
                Revoke {d.name}?{" "}
                <Button variant="ghost" size="sm" onClick={() => setRevoking(null)}>
                  Keep
                </Button>{" "}
                <Button variant="danger" size="sm" onClick={() => revoke(d.id)}>
                  Revoke
                </Button>
              </span>
            ) : (
              <Button variant="danger" onClick={() => setRevoking(d.id)}>
                Revoke
              </Button>
            )}
          </div>
        ))}
      </div>
      {cfg?.port != null && <div className="mobile-port">Listening on port {cfg.port}</div>}
    </>
  );
}

function PairCard({ now, running }: { now: number; running: boolean }) {
  const [payload, setPayload] = useState<QrPayload | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const start = () => {
    setErr(null);
    invoke<QrPayload>("pair_start")
      .then((p) => {
        setPayload(p);
        setStartedAt(nowSecs());
      })
      .catch((e) => setErr(String(e)));
  };

  // Kill the QR secret on the Mac whenever the card stops showing it.
  const secretRef = useRef<string | null>(null);
  const cancelOnMac = () => {
    if (secretRef.current) invoke("pair_cancel", { secret: secretRef.current }).catch(() => {});
  };
  const cancel = () => {
    cancelOnMac();
    setPayload(null);
  };

  const left = payload ? secondsLeft(startedAt + PAIR_TTL_SECS, now) : 0;
  // The secret is single-use with a 5-minute TTL; once it lapses the QR is dead, so drop it.
  const live = payload && left > 0;
  secretRef.current = payload?.secret ?? null;
  const expired = !!payload && left <= 0;
  useEffect(() => {
    if (expired) cancelOnMac();
  }, [expired]);
  useEffect(
    () => () => {
      cancelOnMac();
    },
    [],
  );

  return (
    <div className="mobile-pair">
      {!live && (
        <Button variant="primary" disabled={!running} onClick={start}>
          Pair a phone
        </Button>
      )}
      {err && <Notice tone="error">{err}</Notice>}
      {payload && !live && <div className="mobile-empty">That code expired. Start again.</div>}
      {live && payload && (
        <div className="mobile-qr-card">
          <div className="mobile-qr" dangerouslySetInnerHTML={{ __html: qrSvg(JSON.stringify(payload)) }} />
          <div className="mobile-qr-side">
            <div>Scan with the Conduit app on your phone.</div>
            <div className="mobile-device-meta">
              {payload.dnsName || payload.ip}:{payload.port}
            </div>
            <div className="mobile-device-meta">
              Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </div>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
