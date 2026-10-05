// Per-incident PINs for the ICS-214 EMTF form in the standalone
// workspace. Pure (no React/Firebase) so the rules can be tested on
// their own. This guards against mix-ups — a crew opening the wrong
// incident and adding logs to it — it is not security: the incident's
// data is still readable by anyone who can reach the workspace.
import { sha256 } from "./pin";

export const INCIDENT_PIN_RE = /^\d{4}$/;

// Salted with the incident's own id, so two incidents that happen to
// use the same PIN don't end up storing the same hash.
export function hashIncidentPin(incidentId, pin) {
  return sha256(`${incidentId}:${pin}`);
}

// Open = no PIN set (incidents from before this existed), PINs not in
// force at all (the full app), or already unlocked this session.
export function isIncidentOpen(incident, unlocked, pinsEnabled = true) {
  if (!pinsEnabled || !incident || !incident.pinHash) return true;
  return !!(unlocked && unlocked[incident.id]);
}

// The incident to show by default: the first one that's open, so a
// locked one is never displayed just because it comes first in the list.
export function firstOpenIncidentId(incidents, unlocked, pinsEnabled = true) {
  const found = (incidents || []).find(i => isIncidentOpen(i, unlocked, pinsEnabled));
  return found ? found.id : null;
}

// Returns an error message, or "" when the form is fine.
export function validateIncidentSetup({ name, pin, confirm, requireName }) {
  if (requireName && !String(name || "").trim()) return "Give the incident a name.";
  if (!INCIDENT_PIN_RE.test(pin || "")) return "PIN must be exactly 4 digits.";
  if (pin !== confirm) return "PINs don't match.";
  return "";
}
