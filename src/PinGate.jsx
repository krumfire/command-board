import React, { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { COLORS, KFD_PATCH_DATA_URI } from "./theme";
import { loadPinConfig, savePinConfig } from "./store";
import { sha256 } from "./pin";
import { unlockAudioContext } from "./audio";

const UNLOCK_KEY = "cb_unlock_session";
// Deliberately short — long enough to tolerate an incidental reload
// (an accidental refresh, or iPad Safari discarding this tab under
// memory pressure and reloading it when switched back to) without
// forcing a re-entry, but short enough that leaving the board
// actually closed or unattended for a while still re-locks it.
const GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

function readUnlockRecord() {
  try {
    const raw = localStorage.getItem(UNLOCK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
// Exported so ChangePinModal (in App.jsx) can refresh the record with
// the new hash immediately after a PIN change — otherwise the old
// hash would no longer match on the very next reload, breaking the
// grace period right after a legitimate change.
export function refreshUnlockRecord(hash) {
  try { localStorage.setItem(UNLOCK_KEY, JSON.stringify({ hash, at: Date.now() })); } catch { /* private browsing, etc. */ }
}
function clearUnlockRecord() {
  try { localStorage.removeItem(UNLOCK_KEY); } catch { /* ignore */ }
}

const wrap = {
  minHeight: "100vh", background: COLORS.bg, color: COLORS.text,
  display: "flex", alignItems: "center", justifyContent: "center",
  fontFamily: "'IBM Plex Sans', sans-serif", padding: 20,
};
const card = {
  width: 340, background: COLORS.panel, border: `1px solid ${COLORS.line}`,
  borderRadius: 8, padding: 28,
};
const input = {
  width: "100%", background: COLORS.panel2, border: `1px solid ${COLORS.line}`,
  borderRadius: 4, color: COLORS.text, padding: "10px 12px", fontSize: 18,
  letterSpacing: "0.3em", textAlign: "center", fontFamily: "'IBM Plex Mono', monospace",
  outline: "none", boxSizing: "border-box",
};
const btn = {
  width: "100%", marginTop: 14, padding: "10px 14px", borderRadius: 4,
  background: COLORS.red, color: "#fff", border: "none", fontWeight: 600,
  fontSize: 14, cursor: "pointer",
};

// Renders children once unlocked. Handles first-run PIN setup and
// later PIN entry. The unlock persists across a reload only within a
// short grace period (see GRACE_PERIOD_MS) — an incidental reload
// (accidental refresh, or iPad Safari discarding a backgrounded tab
// under memory pressure) won't force re-entry, but the board still
// locks itself out after being closed or left alone for a while, or
// immediately on an explicit Lock.
export default function PinGate({ children }) {
  const [phase, setPhase] = useState("loading"); // loading | setup | locked | unlocked
  const [config, setConfig] = useState(null);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const cfg = await loadPinConfig();
      setConfig(cfg);
      if (!cfg || !cfg.pinHash) {
        setPhase("setup");
        return;
      }
      const record = readUnlockRecord();
      const withinGrace = record && record.hash === cfg.pinHash && (Date.now() - record.at) < GRACE_PERIOD_MS;
      if (withinGrace) {
        refreshUnlockRecord(cfg.pinHash); // sliding window — still-active use keeps extending it
        setPhase("unlocked");
      } else {
        clearUnlockRecord();
        setPhase("locked");
      }
    })();
  }, []);

  // Keeps the grace-period timestamp fresh while the board stays open
  // and unlocked, not just at the moment of reload — without this, a
  // session active for longer than GRACE_PERIOD_MS with no reload in
  // between would have a stale timestamp, and an incidental reload
  // right then would wrongly lock someone out despite continuous use.
  useEffect(() => {
    if (phase !== "unlocked" || !config) return;
    const interval = setInterval(() => refreshUnlockRecord(config.pinHash), 60 * 1000);
    return () => clearInterval(interval);
  }, [phase, config]);

  const doSetup = async () => {
    unlockAudioContext(); // must happen synchronously, before any await, to count as "within the gesture"
    setError("");
    if (pin.length < 4) return setError("PIN must be at least 4 digits.");
    if (pin !== pin2) return setError("PINs don't match.");
    const pinHash = await sha256(pin);
    await savePinConfig({ pinHash });
    refreshUnlockRecord(pinHash);
    setPhase("unlocked");
  };

  const doUnlock = async () => {
    unlockAudioContext();
    setError("");
    const hash = await sha256(pin);
    if (hash === config.pinHash) {
      refreshUnlockRecord(hash);
      setPhase("unlocked");
    } else {
      setError("Incorrect PIN.");
      setPin("");
    }
  };

  if (phase === "loading") {
    return <div style={wrap}><div style={{ color: COLORS.muted }}>Loading…</div></div>;
  }

  const lock = () => {
    clearUnlockRecord();
    setPin("");
    setError("");
    setPhase("locked");
  };

  if (phase === "unlocked") return typeof children === "function" ? children(lock) : children;

  const isSetup = phase === "setup";

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
          <img src={KFD_PATCH_DATA_URI} alt="KFD Patch" style={{ width: 34, height: 44, objectFit: "contain", flexShrink: 0 }} />
          <div>
            <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 17, letterSpacing: "0.03em" }}>COMMAND BOARD</div>
            <div style={{ fontSize: 10.5, color: COLORS.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {isSetup ? "Set a PIN for this board" : "Enter PIN to continue"}
            </div>
          </div>
        </div>

        {isSetup ? (
          <>
            <p style={{ fontSize: 12.5, color: COLORS.muted, lineHeight: 1.5, marginTop: 0 }}>
              No PIN is set yet. Choose one now — everyone who accesses this board will need it.
              Anyone who already has this link can set the first PIN, so do this before sharing the URL.
            </p>
            <input id="new-pin" name="new-pin" autoComplete="off" style={{ ...input, marginTop: 6 }} type="password" inputMode="numeric" placeholder="New PIN" value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ""))} maxLength={12} />
            <input id="confirm-pin" name="confirm-pin" autoComplete="off" style={{ ...input, marginTop: 10 }} type="password" inputMode="numeric" placeholder="Confirm PIN" value={pin2}
              onChange={e => setPin2(e.target.value.replace(/\D/g, ""))} maxLength={12}
              onKeyDown={e => e.key === "Enter" && doSetup()} />
            <button style={btn} onClick={doSetup}>Set PIN & Continue</button>
          </>
        ) : (
          <>
            <input id="board-pin" name="board-pin" autoComplete="off" style={input} type="password" inputMode="numeric" autoFocus placeholder="PIN" value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ""))} maxLength={12}
              onKeyDown={e => e.key === "Enter" && doUnlock()} />
            <button style={btn} onClick={doUnlock}><Lock size={13} style={{ marginRight: 6, verticalAlign: -2 }} />Unlock</button>
          </>
        )}
        {error && <div style={{ color: "#E4796B", fontSize: 12.5, marginTop: 10, textAlign: "center" }}>{error}</div>}
      </div>
    </div>
  );
}
