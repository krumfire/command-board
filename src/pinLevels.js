// The board's access levels and how a PIN maps to one. Pure (no React,
// no Firebase) so PinGate, the Admin PIN screens, and tests all share
// exactly one definition.
//
// Each level's PIN is stored as a hash under its own key in the pin
// config. The order below is the order PinGate checks them in, which
// matters: if two levels ever had the same PIN, the earlier one wins —
// so a lower-access PIN that matched a higher one would silently grant
// the higher level. pinHashCollides is what the Admin screens use to
// refuse that when a PIN is set.
export const PIN_KEYS = {
  full: "pinHash",
  limited: "limitedPinHash",
  icsForms: "icsFormsPinHash",
  emtf: "emtfPinHash",
};

// Which level a PIN hash unlocks, or null if it matches none.
export function levelForPinHash(cfg, hash) {
  if (!cfg || !hash) return null;
  for (const level of Object.keys(PIN_KEYS)) {
    const stored = cfg[PIN_KEYS[level]];
    if (stored && stored === hash) return level;
  }
  return null;
}

// The stored hash for a level (unknown levels fall back to the main
// PIN, same as before this was split out).
export function hashForLevel(cfg, level) {
  return cfg?.[PIN_KEYS[level] || PIN_KEYS.full];
}

// True if `hash` already belongs to a different level than ownKey
// (the config key being set, e.g. "emtfPinHash").
export function pinHashCollides(cfg, hash, ownKey) {
  return Object.values(PIN_KEYS).some(k => k !== ownKey && cfg?.[k] && cfg[k] === hash);
}
