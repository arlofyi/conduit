import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import type { PairRequest } from "../mobilePairing";

/** A phone asking to pair must always be visible, even with Settings closed. Mounted beside
 *  AskDock (a sibling overlay, never inside the terminal tree). */
export function PairPrompt() {
  const map = useStore((s) => s.pairRequests);
  const remove = useStore((s) => s.removePairRequest);
  const list = useMemo(() => Object.values(map).sort((a, b) => a.expiresAt - b.expiresAt), [map]);
  if (list.length === 0) return null;
  return (
    <div className="pair-stack">
      {list.map((r) => (
        <PairCard key={r.id} req={r} onDone={() => remove(r.id)} />
      ))}
    </div>
  );
}

function PairCard({ req, onDone }: { req: PairRequest; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const respond = (allow: boolean) => {
    setBusy(true);
    // false = already answered elsewhere; either way the card is done.
    void invoke<boolean>("pair_respond", { id: req.id, allow })
      .catch(() => false)
      .finally(onDone);
  };
  return (
    <div className="pair-card" role="alertdialog" aria-label="Pair a phone">
      <div className="pair-title">
        Pair <strong>{req.deviceName}</strong>?
      </div>
      {req.login && <div className="pair-login">Tailscale account: {req.login}</div>}
      <div className="pair-code" aria-label={`Code ${req.code.split("").join(" ")}`}>
        {req.code}
      </div>
      <div className="pair-hint">Check this code matches your phone.</div>
      <div className="pair-actions">
        <button type="button" disabled={busy} onClick={() => respond(false)}>
          Decline
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => respond(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}
