import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Radio, Truck, HeartPulse, ClipboardList, Users, Save,
  Printer, Plus, X, Clock, ChevronRight, Trash2, Download,
  FolderOpen, AlertTriangle, Shield, CheckCircle2, ArrowRightLeft, Lock, GripVertical, GripHorizontal,
  Archive, RotateCcw, Layers, Star, Paperclip, FileText, Image as ImageIcon, KeyRound, Settings, Sun, Moon,
  Map as MapIcon, Crosshair, CloudSun, RefreshCw, Play, Pause, ChevronDown, ChevronLeft, Menu
} from "lucide-react";
import {
  loadIndex, saveIndex, loadIncidentBlobFresh, saveIncidentBlob,
  deleteIncidentBlob, watchIncident, loadPinConfig, savePinConfig,
  triggerMaydayAlert, clearMaydayAlert, watchMaydayAlert,
  loadPresets, savePresets,
  loadAttachments, saveAttachment, deleteAttachment, deleteAllAttachments,
} from "./store";
import { COLORS, KFD_PATCH_DATA_URI, THEME_CSS } from "./theme";
import PinGate, { refreshUnlockRecord } from "./PinGate.jsx";
import { playMaydayTone, stopMaydayTone, unlockAudioContext, setupAudioResumeListeners } from "./audio";
import { sha256 } from "./pin";
import L from "leaflet";
import "leaflet-draw";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
// Leaflet's default marker icon paths break under Vite's bundling
// (a well-known Leaflet + bundler issue — it expects to find its
// icon images relative to a script-tag URL that doesn't exist here).
// Pointing the default icon at CDN-hosted copies of the same images
// sidesteps that entirely rather than fighting Vite's asset pipeline.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/* ============================================================
   DESIGN TOKENS
   Command-board aesthetic: dark tactical ground, stencil-style
   display type (apparatus lettering), high-contrast NIMS-style
   status colors, monospace for all time/ID data.
   ============================================================ */

// "Assigned" and "Working" were removed as their own stages — once a
// resource has a specific Task set (see the Task field on check-in),
// that itself conveys "actively doing something," making a separate
// Kanban column for it redundant. See normalizeResourceStatus below
// for how any resource still saved with one of those old statuses
// gets handled so it doesn't just disappear from the board.
const STATUS_FLOW = ["Staging", "Rehab", "Out of Service", "Released"];
// The default status for a resource sitting normally in its
// division — distinct from STATUS_FLOW's four values, which are now
// all dynamic "holding" columns a resource is explicitly moved into
// and back out of (via the dropdown or by dragging). Without this
// distinction, a freshly checked-in resource — whose status starts as
// "Staging" purely as a default value — would be indistinguishable
// from one explicitly moved to the Staging column later, and would
// incorrectly land there instead of its division.
const ACTIVE_STATUS = "Active";
// A resource saved with "Assigned" or "Working" from before this
// change existed would otherwise have no matching column to render
// in at all — silently vanishing from the board is worse than
// reclassifying it, so anything in one of those retired statuses
// falls back to the normal Active state instead. Critically, this
// also covers plain "Staging" — before this feature existed, every
// resource simply defaulted to status "Staging" at check-in with no
// separate "deliberately moved to the Staging column" concept at all,
// so anything saved that way is migrated to Active rather than
// reinterpreted as an explicit move into the new Staging column,
// which would otherwise suddenly relocate every already-checked-in
// resource on an in-progress incident the instant this update loads.
function normalizeResourceStatus(status) {
  if (status === "Staging") return ACTIVE_STATUS;
  return STATUS_FLOW.includes(status) ? status : ACTIVE_STATUS;
}
const STATUS_COLOR = {
  [ACTIVE_STATUS]: COLORS.blue,
  Staging: COLORS.amber,
  Rehab: COLORS.teal,
  "Out of Service": COLORS.slate,
  Released: COLORS.faint,
};
// Deterministic color per assignment/division column, cycling by
// position — same idea as incidentTypeColor further down, since
// assignments are a user-managed, reorderable list with no fixed
// per-entry color of their own.
const ASSIGNMENT_COLOR_PALETTE = [COLORS.amber, COLORS.teal, COLORS.blue, "#8B5CF6", COLORS.orange, COLORS.red];
function assignmentColumnColor(assignment, columns) {
  // Rehab/Out of Service use their existing, already-meaningful
  // STATUS_COLOR (the same color already shown on a card's left
  // border for that status) rather than an arbitrary cycling color —
  // they're not really "just another division" visually any more
  // than they are structurally.
  if (STATUS_COLOR[assignment]) return STATUS_COLOR[assignment];
  const idx = columns.indexOf(assignment);
  return idx === -1 ? COLORS.slate : ASSIGNMENT_COLOR_PALETTE[idx % ASSIGNMENT_COLOR_PALETTE.length];
}
// Shared by the Resource Board itself and the Tactical Worksheet's
// "Resource Board Status" summary, so both always agree on exactly
// which columns exist and in what order — a new division shows up in
// both places the moment a resource uses it, and neither can drift
// out of sync with the other since they run the exact same logic.
// No catch-all "Unassigned" column — every resource must be given a
// real Assignment/Division at check-in (enforced in ResourceForm) so
// nothing can end up with nowhere to be displayed.
// customOrder is the incident's own saved column arrangement from
// dragging columns to rearrange them — anything in it that still
// corresponds to a real column keeps that position; anything new
// (e.g. a division nobody had used yet when the order was last saved)
// is appended at the end rather than silently dropped.
// Merges a set of objectives into an existing objectives list without
// destroying anything already there — each one either fills the
// first blank row (left over from "Add Objective") if one exists, or
// gets appended, and anything already present (exact text match) is
// skipped rather than duplicated. Shared by the single-objective
// "Pick Objective by Type" picker and the "select an Incident Type"
// auto-populate behavior, so both use identical, non-destructive
// merge semantics rather than two slightly different implementations.
function mergeObjectivesIntoList(current, toAdd) {
  let result = [...current];
  toAdd.forEach(obj => {
    if (result.includes(obj)) return;
    const emptyIdx = result.findIndex(o => !o.trim());
    if (emptyIdx !== -1) result[emptyIdx] = obj;
    else result.push(obj);
  });
  return result;
}

// A resource currently in Rehab or Out of Service is pulled into its
// own dedicated column instead of its assignment's column — this is
// the single source of truth for that rule, used both to decide which
// column a resource's card renders in and to decide which columns
// exist at all (see deriveAssignmentColumns below), so the two can
// never disagree with each other. All four STATUS_FLOW values behave
// this way now (not just Rehab/Out of Service) — ACTIVE_STATUS is
// deliberately excluded from STATUS_FLOW so a resource sitting
// normally in its division (the common case) is never mistaken for
// one explicitly parked in one of these holding columns.
function columnFor(r) {
  if (STATUS_FLOW.includes(r.status)) return r.status;
  return r.assignment || "Unassigned";
}
function deriveAssignmentColumns(resources, assignmentPresets, customOrder) {
  // Division columns persist for as long as ANY resource — regardless
  // of its CURRENT status — has that division as its assignment, not
  // just ones currently displayed there. A resource temporarily
  // parked in Rehab still counts toward keeping its division's column
  // alive, specifically so that column still exists to drag it back
  // into later, even if it was the only resource in that division.
  const usedAssignments = [...new Set(resources.map(r => r.assignment).filter(Boolean))];
  const defaultColumns = [
    ...assignmentPresets.filter(a => usedAssignments.includes(a)),
    ...usedAssignments.filter(a => !assignmentPresets.includes(a)),
  ];
  // Status columns are the opposite of division columns — temporary
  // holding areas that only exist while at least one resource is
  // CURRENTLY in that status, appearing the moment a unit is
  // explicitly moved there (via the dropdown or by dragging) and
  // disappearing again once the last one leaves it.
  STATUS_FLOW.forEach(status => {
    if (resources.some(r => r.status === status)) defaultColumns.push(status);
  });
  if (!customOrder || customOrder.length === 0) return defaultColumns;
  const known = customOrder.filter(c => defaultColumns.includes(c));
  const newOnes = defaultColumns.filter(c => !customOrder.includes(c));
  return [...known, ...newOnes];
}
const INCIDENT_TYPES = [
  { v: "Structure Fire", c: COLORS.red },
  { v: "Wildland Fire", c: COLORS.teal },
  { v: "Hazmat", c: "#8B5CF6" },
  { v: "MCI / EMS", c: COLORS.blue },
  { v: "All-Hazard / Other", c: COLORS.slate },
];
// Used only to seed the editable incidentTypes preset list on first
// load — once that list exists, colors come from incidentTypeColor
// below instead (cycling by position), since a custom or reordered
// list can't keep a fixed per-entry color the way this hardcoded
// array originally did.
const INCIDENT_TYPE_COLOR_PALETTE = [COLORS.red, COLORS.teal, "#8B5CF6", COLORS.blue, COLORS.slate, COLORS.amber, COLORS.orange];
// Gates the automatic PAR clock/reminder (NOT the manual Mayday/PAR
// buttons, which stay available regardless of incident type) — only
// counts toward and reminds for these incident types, per policy.
// Matches loosely (substring, case-insensitive) rather than an exact
// string, since incidentTypes is a user-editable preset list (see
// INCIDENT_TYPES above, used only to seed it) — a department may have
// renamed or reworded their "All-Hazard / Other" entry, and this
// should still recognize it rather than silently stop working the
// moment someone edits the label in Admin.
function requiresParTracking(incidentType) {
  const t = String(incidentType || "").toLowerCase();
  return t.includes("structure fire") || t.includes("hazmat") || t.includes("all-hazard") || t.includes("all hazard");
}
function incidentTypeColor(type, typeList) {
  const idx = (typeList || []).indexOf(type);
  return idx === -1 ? COLORS.slate : INCIDENT_TYPE_COLOR_PALETTE[idx % INCIDENT_TYPE_COLOR_PALETTE.length];
}
const RESOURCE_KINDS = [
  "Engine", "Ladder/Truck", "Tender/Tanker", "Brush Truck", "Rescue",
  "Ambulance/Medic", "Hazmat Unit", "Command Vehicle", "Air Unit",
  "Dozer/Heavy Equip", "Hand Crew", "Law Enforcement", "Squad", "Fire Marshall", "Other",
];
// Auto-detects a unit's resource type from its own name/designation
// letters, per department radio-designation convention, so checking
// in a preset unit needs one fewer manual selection — e.g. "C580"
// auto-fills Command Vehicle, "E581" auto-fills Engine. Two-letter
// codes are checked before any single-letter one they'd otherwise be
// mistaken for the first letter of (TK vs T, HC vs H, LE vs L, FM has
// no single-letter collision but is kept alongside the others for
// clarity) — order matters here, longest-specific-match first.
const UNIT_TYPE_PREFIX_MAP = [
  ["FM", "Fire Marshall"],
  ["TK", "Ladder/Truck"],
  ["HC", "Hand Crew"],
  ["LE", "Law Enforcement"],
  ["E", "Engine"],
  ["C", "Command Vehicle"],
  ["L", "Ladder/Truck"],
  ["T", "Tender/Tanker"],
  ["B", "Brush Truck"],
  ["M", "Ambulance/Medic"],
  ["S", "Squad"],
  ["R", "Rescue"],
  ["H", "Hazmat Unit"],
  ["A", "Air Unit"],
  ["D", "Dozer/Heavy Equip"],
];
function detectResourceKindFromLabel(label) {
  const upper = String(label || "").trim().toUpperCase();
  for (const [prefix, kind] of UNIT_TYPE_PREFIX_MAP) {
    if (upper.startsWith(prefix)) return kind;
  }
  return null;
}
const CG_POSITIONS = [
  "Incident Commander", "Deputy IC", "Safety Officer",
  "Public Information Officer", "Liaison Officer",
];
const SECTION_CHIEFS = [
  "Operations Section Chief", "Planning Section Chief",
  "Logistics Section Chief", "Finance/Admin Section Chief",
];
// Excludes an assignment/division named "Incident Command" (or a
// close variant) from being auto-synced onto the Org Chart as if it
// were a regular geographic/functional division under Operations —
// that name means something specific and reserved (the org.ic field
// at the very top of the chart), not a division to nest underneath a
// Section Chief. Someone naming a Resource Board assignment exactly
// that is describing the IC's own position, not creating a new
// division.
function isIncidentCommandName(name) {
  const n = String(name || "").trim().toLowerCase();
  return n === "incident command" || n === "incident commander" || n === "ic";
}
// Same idea, for an Operations-named assignment/division on the
// Resource Board — matched flexibly since a department might call it
// "Operations", "Operation Section", or just "Ops".
function isOperationsName(name) {
  // Exact matching only, same as isIncidentCommandName above — a
  // substring match (name.includes("operation")) was catching
  // "Water Operations" and any similar functional division name as
  // if it were the generic Operations section itself, incorrectly
  // treating it as the wrapper for every other division rather than
  // a regular division nested underneath it.
  const n = String(name || "").trim().toLowerCase();
  return n === "operations" || n === "operation section" || n === "operations section" || n === "ops";
}

/* ============================================================
   ORG CHART DATA MODEL
   A tree, matching the FEMA ICS org chart's actual shape: IC at
   the top, Command Staff (Safety/PIO/Liaison) and the four Section
   Chiefs reporting to IC, and each Section Chief able to expand
   downward into Branches -> Divisions/Groups -> further sub-units,
   arbitrarily deep. This replaced an earlier flat/fixed-position
   model (org.positions + org.divisions) that couldn't represent
   that structure or be expanded — normalizeOrg() below migrates any
   data saved under the old shape so nothing is lost.
   ============================================================ */
function blankOrg() {
  return {
    ic: "", deputyIc: "",
    commandStaff: [
      { id: uid(), title: "Safety Officer", name: "" },
      { id: uid(), title: "Public Information Officer", name: "" },
      { id: uid(), title: "Liaison Officer", name: "" },
    ],
    sections: SECTION_CHIEFS.map(title => ({ id: uid(), title, name: "", children: [] })),
    // Auto-synced from the Resource Board (see the sync effect in
    // AppInner) when "Incident Command" and "Operations" themselves
    // exist as assignments/divisions there — rendered as its own
    // standalone box above everything else, with Operations nested
    // as its child and every regular division nested under that, in
    // place of using org.sections' own Operations Section Chief slot
    // (which stays available, gated, for a department that manages
    // Operations manually instead rather than through the board).
    incidentCommand: null,
  };
}

function normalizeOrg(org) {
  if (!org) return blankOrg();
  if (org.sections) {
    // Already the current shape — fill in anything defensively missing.
    return { ic: org.ic || "", deputyIc: org.deputyIc || "", commandStaff: org.commandStaff || [], sections: org.sections || [], incidentCommand: org.incidentCommand || null };
  }
  // Old shape: { positions: { [fixedTitle]: name }, divisions: [{id,name,supervisor}] }
  const positions = org.positions || {};
  const divisions = org.divisions || [];
  return {
    ic: positions["Incident Commander"] || "",
    deputyIc: positions["Deputy IC"] || "",
    commandStaff: [
      { id: uid(), title: "Safety Officer", name: positions["Safety Officer"] || "" },
      { id: uid(), title: "Public Information Officer", name: positions["Public Information Officer"] || "" },
      { id: uid(), title: "Liaison Officer", name: positions["Liaison Officer"] || "" },
    ],
    sections: SECTION_CHIEFS.map(title => ({
      id: uid(),
      title,
      name: positions[title] || "",
      // Old divisions/groups had no section of their own — they were
      // implicitly under Operations, so that's where they land here.
      children: title === "Operations Section Chief"
        ? divisions.map(d => ({ id: d.id || uid(), title: d.name || "Division/Group", name: d.supervisor || "", children: [] }))
        : [],
    })),
    incidentCommand: null,
  };
}

// Recursive tree edits — operate on the `sections` array by node id,
// wherever that node actually lives in the nesting.
function updateOrgNode(sections, nodeId, patch) {
  return sections.map(node => {
    if (node.id === nodeId) return { ...node, ...patch };
    if (node.children && node.children.length) return { ...node, children: updateOrgNode(node.children, nodeId, patch) };
    return node;
  });
}
function deleteOrgNode(sections, nodeId) {
  return sections
    .filter(node => node.id !== nodeId)
    .map(node => node.children && node.children.length ? { ...node, children: deleteOrgNode(node.children, nodeId) } : node);
}
function addOrgChild(sections, parentId, child) {
  return sections.map(node => {
    if (node.id === parentId) return { ...node, children: [...(node.children || []), child] };
    if (node.children && node.children.length) return { ...node, children: addOrgChild(node.children, parentId, child) };
    return node;
  });
}

// Flattened views for consumers that just need a summary list, not the
// visual tree — the PDF export and the "Current Organization" summary
// on the full ICS-201 form.
function flattenOrgFilled(org) {
  const out = [];
  org.commandStaff.forEach(cs => { if (cs.name) out.push({ title: cs.title, name: cs.name }); });
  // Operations Section Chief's own {title, name} entry (in
  // org.sections) is skipped — that box was removed from the org
  // chart UI. Incident Command/Operations/every division now live
  // entirely under org.incidentCommand instead (see the sync effect
  // in AppInner), walked in separately below at normal depth since
  // it's a genuinely separate structure now, not nested under
  // org.sections at all.
  const walk = (node, depth) => {
    const isOps = node.title === "Operations Section Chief";
    if (!isOps && node.name) out.push({ title: node.title, name: node.name, depth });
    (node.children || []).forEach(c => walk(c, isOps ? depth : depth + 1));
  };
  org.sections.forEach(s => walk(s, 0));
  if (org.incidentCommand) walk(org.incidentCommand, 0);
  return out;
}
// Every node's title, at any depth — used to populate the
// Division/Group picker on ICS-215A regardless of which section a
// division was added under.
function flattenOrgTitles(org) {
  const out = [];
  const walk = (node) => { if (node.title) out.push(node.title); (node.children || []).forEach(walk); };
  org.sections.forEach(walk);
  if (org.incidentCommand) walk(org.incidentCommand);
  return out;
}


const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Builds/updates the sub-boxes (one per non-chief unit) for a
// division-style node. Shared across every level of the Org Chart
// sync (regular divisions, and Operations'/Incident Command's own
// directly-assigned units) since the same rule applies identically
// everywhere: one sub-box per unit, matched by the unit's own id
// (sourceResourceId) rather than by whatever text happens to be
// showing (so a manual rename never causes a duplicate), and an
// auto-managed sub-box for a unit that's moved on is dropped, while a
// manually-edited one never is, regardless of what happened to its
// unit.
function syncSubBoxes(existingChildren, nonChiefUnits) {
  const nextChildren = [];
  let changed = false;
  nonChiefUnits.forEach(unit => {
    const existing = existingChildren.find(c => c.sourceResourceId === unit.id);
    const kind = unit.kind || "Unit";
    if (!existing) {
      nextChildren.push({ id: uid(), title: kind, name: unit.label, children: [], autoName: true, sourceResourceId: unit.id });
      changed = true;
    } else if (existing.autoName !== false) {
      if (existing.title !== kind || existing.name !== unit.label) {
        nextChildren.push({ ...existing, title: kind, name: unit.label });
        changed = true;
      } else {
        nextChildren.push(existing);
      }
    } else {
      nextChildren.push(existing);
    }
  });
  existingChildren.forEach(c => {
    if (c.autoName === false && !nextChildren.some(n => n.id === c.id)) nextChildren.push(c);
  });
  if (existingChildren.length !== nextChildren.length) changed = true;
  return { children: nextChildren, changed };
}

// Builds/updates a single division-style node's own name (its chief —
// the first "C"-prefixed unit assigned to it) given the division
// name, an existing node to preserve manual edits on, and the current
// resources. Returns the node's non-chief units alongside it, for the
// caller to hand to syncSubBoxes — this function only ever touches
// the node's own {name}, never its children, since what belongs
// there varies by level (a regular division gets only its own unit
// sub-boxes; Operations/Incident Command get a mix of their own
// sub-boxes AND a nested division-style node underneath).
function syncDivisionChiefName(divisionName, existingNode, resources) {
  const unitsHere = resources.filter(r => columnFor(r) === divisionName);
  const chiefUnit = unitsHere.find(r => r.label && r.label.trim().toUpperCase().startsWith("C"));
  const chiefName = chiefUnit ? chiefUnit.label : "";
  const nonChiefUnits = chiefUnit ? unitsHere.filter(r => r.id !== chiefUnit.id) : unitsHere;
  let node = existingNode;
  let changed = false;
  if (!node) {
    node = { id: uid(), title: divisionName, name: chiefName, children: [], autoName: true };
    changed = true;
  } else if (node.autoName !== false && node.name !== chiefName) {
    node = { ...node, name: chiefName, autoName: true };
    changed = true;
  }
  return { node, nonChiefUnits, changed };
}

// Builds/updates a full list of division-style nodes (chief name +
// that division's own unit sub-boxes) from a list of active division
// names, reusing priorNodes by title match. A node for a name no
// longer active is dropped UNLESS it's been manually edited
// (autoName === false), which is always kept regardless.
function syncDivisionList(names, priorNodes, resources) {
  const nextNodes = [];
  let changed = false;
  names.forEach(name => {
    const existing = priorNodes.find(n => n.title === name);
    const { node, nonChiefUnits, changed: chiefChanged } = syncDivisionChiefName(name, existing, resources);
    const { children, changed: subChanged } = syncSubBoxes(node.children || [], nonChiefUnits);
    if (chiefChanged || subChanged) changed = true;
    nextNodes.push({ ...node, children });
  });
  priorNodes.forEach(n => {
    if (n.autoName === false && !nextNodes.some(x => x.id === n.id)) nextNodes.push(n);
  });
  if (priorNodes.length !== nextNodes.length) changed = true;
  return { nodes: nextNodes, changed };
}
const nowISO = () => new Date().toISOString();
// Local date/time parts (not nowISO's UTC-based output) suitable for
// an <input type="date">/<input type="time"> default value — used to
// auto-fill Date/Time Initiated when a new incident is created, so
// it reflects the department's own local time rather than potentially
// being hours off in either direction depending on time zone.
function nowLocalDateTimeParts() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return { date, time };
}
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const fmtClock = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString() : "—";
// 8-point compass, matching the format the Wind field already
// expects ("8 mph SW") rather than a finer-grained 16-point compass.
const degreesToCompass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const elapsed = (iso, now) => {
  if (!iso) return "—";
  let s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};
const fmtDuration = (ms) => {
  let s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};
// Duration of the status immediately before the current one, read from
// the resource's history — e.g. how long it was Working right before
// it was moved to Rehab.
const priorPeriod = (history) => {
  if (!history || history.length < 2) return null;
  const cur = history[history.length - 1];
  const prev = history[history.length - 2];
  return { status: prev.status, ms: new Date(cur.at).getTime() - new Date(prev.at).getTime() };
};

function blankIncident() {
  // Date/Time Initiated auto-fills to the current local date/time at
  // creation — same principle as opStart below already being set to
  // "now" automatically, just for the Tactical Worksheet's own
  // display field rather than the clock's internal baseline. Still
  // freely editable afterward if the actual initiation time needs
  // correcting (a dispatch time entered after the fact, say).
  const { date: initDate, time: initTime } = nowLocalDateTimeParts();
  return {
    id: uid(),
    name: "",
    number: "",
    type: "",
    location: "",
    icName: "",
    preparedBy: "",
    prepPosition: "",
    prepSignature: "",
    prepDateTime: "",
    dateInitiated: initDate,
    timeInitiated: initTime,
    timeTerminated: "",
    dateTerminated: "",
    opStart: nowISO(),
    pausedElapsedMs: 0,
    wind: "",
    temp: "",
    rh: "",
    conditions: "",
    situation: "",
    safetyMessage: "",
    objectives: [""],
    // Keyed by the objective's own text rather than an index or ID,
    // since objectives are plain strings everywhere else in the app
    // (Tab201, Tab201Full, the PDF export, the merge/auto-populate
    // logic) — adding completion tracking this way needed zero
    // changes to any of that already-working code. Editing an
    // objective's text is effectively treated as a new objective for
    // completion purposes, which is an acceptable, minor trade-off.
    objectivesCompleted: {},
    // parSession is the currently-active PAR or Mayday check-in event
    // (null when none is in progress); lastParAt is when the most
    // recent one was completed, used to drive the periodic PAR
    // reminder.
    parSession: null,
    lastParAt: "",
    parHistory: [],
    // Each entry records a moment the periodic PAR reminder was
    // dismissed rather than acted on — shown alongside parHistory so
    // an ignored reminder is just as visible a record as a completed
    // check, not silently invisible.
    ignoredParReminders: [],
    // Shared across every device watching this incident (via the
    // normal incident sync, not the dedicated fast Mayday channel --
    // this doesn't need instant delivery the way a Mayday does) so
    // completing a PAR or dismissing the reminder on ANY device clears
    // it everywhere at once, rather than each device independently
    // deciding for itself whether the reminder is currently showing.
    parReminderActive: false,
    actionsLog: [],
    resourceOrders: [],
    mapSketch: "",
    strategyOffensive: false,
    strategyDefensive: false,
    strategyTransitional: false,
    strategyInvestigative: false,
  };
}

// Older saved incidents may only have the single combined "weather"
// field from before it was split into Wind/Temp/RH/Conditions — carry
// that text into Conditions once, rather than silently losing it.
function normalizeIncident(inc) {
  if (!inc) return blankIncident();
  const hasNewFields = inc.wind || inc.temp || inc.rh || inc.conditions;
  const migrated = (!hasNewFields && inc.weather)
    ? { ...inc, wind: "", temp: "", rh: "", conditions: inc.weather }
    : { wind: "", temp: "", rh: "", conditions: "", ...inc };
  // Fill in fields added when ICS-201 was rebuilt to match the official
  // form exactly (Date/Time Initiated, expanded Prepared By, the
  // Actions/Tactics log, and the Resource Order-tracking table).
  return {
    prepPosition: "", prepSignature: "", prepDateTime: "",
    dateInitiated: "", timeInitiated: "", timeTerminated: "", dateTerminated: "",
    actionsLog: [], resourceOrders: [], mapSketch: "",
    strategyOffensive: false, strategyDefensive: false, strategyTransitional: false, strategyInvestigative: false,
    pausedElapsedMs: 0,
    objectivesCompleted: {},
    parSession: null,
    lastParAt: "",
    parHistory: [],
    ignoredParReminders: [],
    // Shared across every device watching this incident (via the
    // normal incident sync, not the dedicated fast Mayday channel --
    // this doesn't need instant delivery the way a Mayday does) so
    // completing a PAR or dismissing the reminder on ANY device clears
    // it everywhere at once, rather than each device independently
    // deciding for itself whether the reminder is currently showing.
    parReminderActive: false,
    ...migrated,
  };
}

// Default shapes for the newer ICS Forms (208 / 208 HM / 209 / 206) —
// factory functions so each call returns a fresh object/array, not a
// shared reference, since 206 in particular holds mutable arrays.
function defaultIcs208() {
  return { opFrom: "", opTo: "", message: "", siteSafetyPlanRequired: "No", siteSafetyPlanLocation: "", preparedBy: "", position: "", signature: "", dateTime: "" };
}
function defaultIcs208HM() {
  return {
    dateTime: "", opFrom: "", opTo: "",
    incidentLocation: "",
    orgIC: "", orgHMGroupSupervisor: "", orgTechSpecialist: "",
    orgSafetyOfficer: "", orgEntryLeader: "", orgSiteAccessControlLeader: "",
    orgAsstSafetyOfficerHM: "", orgDeconLeader: "", orgSafeRefugeAreaMgr: "",
    orgEnvironmentalHealth: "", orgOther1: "", orgOther2: "",
    entryTeam: [1, 2, 3, 4].map(n => ({ id: uid(), label: `Entry ${n}`, name: "", ppeLevel: "" })),
    deconTeam: [1, 2, 3, 4].map(n => ({ id: uid(), label: `Decon ${n}`, name: "", ppeLevel: "" })),
    materials: [], materialsComment: "",
    lelInstruments: "", o2Instruments: "", toxicityInstruments: "", radiologicalInstruments: "", monitoringComment: "",
    standardDecon: "Yes", deconComment: "",
    commandFreq: "", tacticalFreq: "", entryFreq: "",
    medicalMonitoring: "Yes", medicalTreatmentInPlace: "Yes", medicalComment: "",
    siteMapWeather: false, siteMapCommandPost: false, siteMapZones: false, siteMapAssemblyAreas: false, siteMapEscapeRoutes: false, siteMapOther: false, siteMapNotes: "",
    entryObjectives: "",
    sopModifications: "No", sopComment: "",
    emergencyProcedures: "",
    asstSafetyOfficerSignature: "", safetyBriefingTime: "",
    hmGroupSupervisorSignature: "", incidentCommanderSignature: "",
  };
}
function defaultIcs209() {
  const statusRow = () => ({ period: "", total: "" });
  return {
    reportVersion: "Initial", reportNumber: "",
    icAgency: "", icAgencyOrg: "", imTeam: "",
    startDate: "", startTime: "", startTimeZone: "CST",
    sizeArea: "", percentContained: "",
    definition: "", complexityLevel: "",
    opFrom: "", opTo: "",
    preparedByName: "", preparedByPosition: "", preparedDateTime: "",
    submittedDateTime: "", submittedTimeZone: "",
    approvedByName: "", approvedByPosition: "", approvedBySignature: "",
    sentTo: "",
    state: "", county: "", city: "", unitOther: "", jurisdiction: "", ownership: "",
    longitude: "", latitude: "", usng: "", legalDescription: "", shortLocation: "", utm: "", geospatialNote: "",
    significantEvents: "", primaryMaterials: "", damageOther: "",
    structural: {
      singleResidences: { threatened: "", damaged: "", destroyed: "" },
      nonresidential: { threatened: "", damaged: "", destroyed: "" },
      otherMinor: { threatened: "", damaged: "", destroyed: "" },
      other: { threatened: "", damaged: "", destroyed: "" },
    },
    publicStatus: Object.fromEntries(["fatalities", "injuries", "trapped", "missing", "evacuated", "shelterInPlace", "tempShelters", "massImmunizations", "requireImmunizations", "quarantine"].map(k => [k, statusRow()])),
    responderStatus: Object.fromEntries(["fatalities", "injuries", "trapped", "missing", "shelterInPlace", "receivedImmunizations", "requireImmunizations", "quarantine"].map(k => [k, statusRow()])),
    threatRemarks: "",
    threatFlags: Object.fromEntries(["noLikelyThreat", "potentialFutureThreat", "massNotificationsInProgress", "massNotificationsCompleted", "noEvacImminent", "planningForEvac", "planningForShelterInPlace", "evacInProgress", "shelterInPlaceInProgress", "repopulationInProgress", "massImmunizationInProgress", "massImmunizationComplete", "quarantineInProgress", "areaRestrictionInEffect"].map(k => [k, false])),
    weatherConcerns: "",
    projectedActivity: { h12: "", h24: "", h48: "", h72: "", after72: "" },
    strategicObjectives: "",
    threatSummaryTimeframes: { h12: "", h24: "", h48: "", h72: "", after72: "" },
    resourceNeeds: { h12: "", h24: "", h48: "", h72: "", after72: "" },
    strategicDiscussion: "",
    plannedActions: "",
    projectedFinalSize: "",
    completionDate: "",
    demobStartDate: "",
    costsToDate: "",
    finalCostEstimate: "",
    remarks: "",
    resourceCommitments: [],
    cooperatingOrgs: "",
  };
}
function defaultIcs206() {
  return { aidStations: [], ambulances: [], hospitals: [], procedures: "", aviationAssets: false, preparedBy: "", preparedSignature: "", approvedBy: "", approvedSignature: "", dateTime: "" };
}
// Drawn map annotations (fire perimeter, hazard zones, staging areas,
// points of interest, etc.) — stored as a standard GeoJSON
// FeatureCollection, the format Leaflet's draw plugin natively reads
// and writes, so no translation layer is needed between what's drawn
// and what's saved/synced.
function defaultMapData() {
  return { type: "FeatureCollection", features: [] };
}

// mapData is stored in Firestore as a JSON STRING, not as a nested
// object — Firestore rejects any field containing a directly nested
// array (an array inside another array with no object in between),
// and GeoJSON's own coordinate format is exactly that for anything
// beyond a single point: a LineString's coordinates look like
// [[lng,lat],[lng,lat],...], a Polygon's are nested one level deeper
// still. A marker's [lng,lat] is flat and saved fine, which is why
// drop-pins synced while every multi-point shape (freehand lines,
// polygons, rectangles, leaflet-draw's own polyline tool) silently
// failed to save at all — the write was throwing, uncaught, which
// left the sync indicator stuck rather than showing an error.
// Storing the whole thing as one opaque string sidesteps the
// restriction entirely; parseMapData handles a missing field, an
// already-parsed object (e.g. from startNew's blank template), or a
// JSON string, so it's safe regardless of which shape it's given.
function parseMapData(raw) {
  if (!raw) return defaultMapData();
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return defaultMapData(); }
  }
  return raw;
}

// Shared by the ICS-209's "Current Size/Area Involved" field and the
// PDF export's "Incident Perimeter" section, so both read the exact
// same figure rather than two separate implementations that could
// drift apart.
function getTotalPerimeterAcres(mapData) {
  const features = (mapData && mapData.features) || [];
  const perimeters = features.filter(f => f.properties && f.properties.isPerimeter);
  if (perimeters.length === 0) return null;
  return perimeters.reduce((sum, f) => sum + f.properties.perimeterAcres, 0);
}

// A text label on the map is a marker with a DivIcon rendering the
// text directly (styled like a sticky note, not a location pin) —
// used both when placing a new label and when reconstructing a saved
// one on load (see the pointToLayer logic in TabMapping).
// 1 acre, exactly, in square meters — used to convert the geodesic
// area L.GeometryUtil.geodesicArea() returns (leaflet-draw's own
// utility, already available since leaflet-draw is imported above)
// into the unit a US fire department actually reports perimeter size
// in.
const SQ_METERS_PER_ACRE = 4046.8564224;

function makeTextIcon(text) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return L.divIcon({
    className: "cb-map-text-label",
    html: `<div style="background:#fff;color:#191C1F;border:1.5px solid #96690F;border-radius:4px;padding:3px 7px;font:600 12px 'IBM Plex Sans',sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.4);">${esc}</div>`,
    iconSize: null, // let the content size itself rather than clipping to a fixed box
    iconAnchor: [8, 8],
  });
}

// A short, space-saving label for a division marker's square face —
// initials for a multi-word name ("Division A" -> "DA"), otherwise
// the first few letters of a single word ("Staging" -> "STA").
function shortDivisionLabel(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.map(w => w[0]).join("").toUpperCase().slice(0, 3);
  return String(name).slice(0, 3).toUpperCase();
}

// Dropped from the small draggable cards in TabMapping's Divisions
// palette — deliberately simple and mostly static (just the name),
// rather than trying to keep a live unit count baked into the icon
// itself. The current unit list is looked up fresh on hover instead
// (see bindDivisionTooltip, wired up in loadGeoJsonIntoGroup below),
// which avoids needing this map's already-intricate render/sync
// logic to also watch and react to every change in the Resource
// Board's resources array. A small, fixed-size square (rather than a
// wider pill sized to the full name) keeps the map itself
// uncluttered — the full name only appears in
// the tooltip on hover, along with the current unit list.
function makeDivisionMarkerIcon(divisionName, color) {
  const short = shortDivisionLabel(divisionName);
  return L.divIcon({
    className: "cb-map-division-marker",
    html: `<div style="width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:var(--cb-panel);color:var(--cb-text);border:2px solid ${color};border-radius:4px;font:700 10px 'Oswald',sans-serif;text-transform:uppercase;letter-spacing:0.02em;box-shadow:0 2px 6px rgba(0,0,0,0.5);cursor:pointer;">${short}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function defaultComms() {
  return {
    dateTimePrepared: "", opFrom: "", opTo: "", specialInstructions: "",
    preparedBy: "", signature: "", dateTime: "",
    rows: [],
  };
}
// Older saved incidents stored comms as a plain array of channel rows
// (before the header/footer fields were added to match the official
// ICS-205 form) — migrate that shape into the new object instead of
// letting `.rows` calls fail on an array.
function normalizeComms(raw) {
  if (!raw) return defaultComms();
  if (Array.isArray(raw)) {
    return {
      ...defaultComms(),
      rows: raw.map(r => ({
        id: r.id || uid(), zoneGroup: "", chNum: "", func: r.func || "Command",
        channelName: r.channel || "", assignment: r.assignment || "",
        rxFreq: r.rx || "", rxTone: "", txFreq: r.tx || "", txTone: "",
        mode: r.mode === "Analog" ? "A" : r.mode === "Digital" ? "D" : r.mode === "Mixed" ? "M" : (r.mode || "D"),
        remarks: r.remarks || "",
      })),
    };
  }
  return { ...defaultComms(), ...raw };
}

/* ============================================================
   SMALL UI PRIMITIVES
   ============================================================ */
function Field({ label, children, wide }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, gridColumn: wide ? "1 / -1" : undefined }}>
      {/* minHeight reserves room for two lines regardless of whether
          this particular label actually wraps — without it, a field
          with a short one-line label sits with its input higher up
          than a sibling field whose longer label wraps to two lines,
          so inputs across the same row don't line up with each
          other. display:block is required for minHeight to do
          anything at all on a span, which is inline by default. */}
      <span style={{ display: "block", minHeight: 28, lineHeight: "14px", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle = {
  background: COLORS.panel2,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 4,
  color: COLORS.text,
  padding: "8px 10px",
  fontSize: 14,
  lineHeight: "20px",
  // minHeight, not a fixed height — a fixed height forces every
  // input down to exactly this size, but iOS Safari's native
  // date/time widgets have their own enforced minimum height that a
  // smaller fixed height can't shrink them below, which made the
  // mismatch worse (plain text fields obediently shrank to the fixed
  // size; date/time fields couldn't and stayed at their own larger
  // minimum). minHeight instead gives every field the same floor
  // without capping anything — if a date/time field genuinely needs
  // to be taller on some device, plain text fields sharing the same
  // minHeight grow to match it instead of the two drifting apart.
  minHeight: 44,
  fontFamily: "'IBM Plex Sans', sans-serif",
  outline: "none",
};
function TextInput(props) {
  return <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} />;
}
function TextArea(props) {
  return <textarea {...props} style={{ ...inputStyle, height: "auto", resize: "vertical", minHeight: 70, ...(props.style || {}) }} />;
}
function Select({ children, ...props }) {
  return <select {...props} style={{ ...inputStyle, ...(props.style || {}) }}>{children}</select>;
}

function Btn({ children, onClick, kind = "ghost", icon: Icon, style, type = "button", disabled, title }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 7,
    padding: "8px 13px", borderRadius: 4, fontSize: 13, fontWeight: 600,
    fontFamily: "'IBM Plex Sans', sans-serif", cursor: disabled ? "not-allowed" : "pointer",
    border: `1px solid ${COLORS.line}`, letterSpacing: "0.02em",
    opacity: disabled ? 0.5 : 1,
  };
  const kinds = {
    ghost: { background: "transparent", color: COLORS.text },
    solid: { background: COLORS.red, color: "#fff", border: `1px solid ${COLORS.red}` },
    subtle: { background: COLORS.panel2, color: COLORS.text },
    danger: { background: "transparent", color: COLORS.dangerText, border: `1px solid ${COLORS.dangerBorder}` },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} title={title} style={{ ...base, ...kinds[kind], ...style }}>
      {Icon && <Icon size={14} />}{children}
    </button>
  );
}

function Panel({ title, icon: Icon, right, children, style }) {
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 6, overflow: "hidden", display: "flex", flexDirection: "column", ...style }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: `1px solid ${COLORS.line}`, background: COLORS.panel2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.05em", textTransform: "uppercase", fontSize: 13, color: COLORS.text }}>
            {Icon && <Icon size={15} color={COLORS.amber} />}{title}
          </div>
          {right}
        </div>
      )}
      {/* overflowX here (not shrinking every field down to fit) is
          what makes wide multi-column layouts — the Tactical
          Worksheet's field grids, ICS form tables, etc. — reachable
          by swiping sideways on a narrow phone screen instead of
          silently clipping whatever doesn't fit, or squeezing fields
          down to an unusable width. Since this is the one wrapper
          nearly every section in the app renders its content inside,
          fixing it here covers all of them at once rather than
          needing a scroll container added to each individual grid.
          flex:1 on this content area (with the outer div now a flex
          column) is what lets a Panel actually stretch to match
          taller siblings in a row with alignItems:"stretch" — without
          it, only the outer border would visually stretch while the
          content stayed pinned to the top, leaving an empty gap
          instead of the content itself filling the space. This is a
          no-op for every other Panel not sitting in a stretched row,
          since flex:1 only does anything when a parent flex container
          actually has extra space to distribute. */}
      <div style={{ padding: 16, overflowX: "auto", flex: 1 }}>{children}</div>
    </div>
  );
}

/* ============================================================
   TAB: ICS-201 INCIDENT BRIEFING
   ============================================================ */
function Tab201({ incident, setIncident, resources, incidentTypePresets, objectivesByType, onAddObjective, assignmentPresets, resourceColumnOrder }) {
  const [weatherStatus, setWeatherStatus] = useState(""); // "", "loading", or an error message
  const fetchCurrentWeather = () => {
    if (!navigator.geolocation) { setWeatherStatus("This device/browser doesn't support GPS location."); return; }
    setWeatherStatus("loading");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          // Open-Meteo — free, no API key or account required, built
          // for exactly this kind of direct browser-side use.
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph`;
          const res = await fetch(url);
          if (!res.ok) throw new Error("Weather service returned an error.");
          const data = await res.json();
          const c = data.current;
          setIncident(inc => ({
            ...inc,
            wind: `${Math.round(c.wind_speed_10m)} mph ${degreesToCompass(c.wind_direction_10m)}`,
            temp: `${Math.round(c.temperature_2m)}°F`,
            rh: `${Math.round(c.relative_humidity_2m)}%`,
          }));
          setWeatherStatus("");
        } catch (err) {
          setWeatherStatus("Couldn't fetch weather data. Check your connection and try again.");
        }
      },
      (err) => setWeatherStatus(err.code === 1 ? "Location permission denied." : "Couldn't get GPS location."),
      { enableHighAccuracy: false, maximumAge: 300000 } // weather doesn't need pinpoint accuracy, and a 5-minute-old fix is fine
    );
  };

  const updateObjective = (i, val) => {
    const next = [...incident.objectives]; next[i] = val;
    setIncident({ ...incident, objectives: next });
  };
  const addObjective = () => setIncident({ ...incident, objectives: [...incident.objectives, ""] });
  const removeObjective = (i) => setIncident({ ...incident, objectives: incident.objectives.filter((_, idx) => idx !== i) });
  // Objectives specific to the currently-selected incident type, plus
  // General ones that make sense no matter the type — General isn't
  // an incident type of its own, just a catch-all category managed
  // the same way from the Admin panel.
  const relevantObjectives = objectivesByType[incident.type] || [];
  // Quick-add fills the first blank row left over from "Add
  // Objective" if one exists, rather than always appending a new one
  // underneath it — clicking a suggestion right after adding a blank
  // row is the common case, and this avoids leaving that blank row
  // orphaned above the newly-added text.
  const addObjectiveFromPreset = (text) => setIncident({ ...incident, objectives: mergeObjectivesIntoList(incident.objectives, [text]) });
  // Selecting an Incident Type auto-populates every objective defined
  // for it (see Manage Objectives) straight into the list — merged in
  // non-destructively via the same logic as the single-objective
  // picker above, so switching types never wipes out anything already
  // typed, and re-selecting a type already populated won't duplicate
  // it either.
  const handleTypeChange = (newType) => {
    const newObjectives = objectivesByType[newType] || [];
    setIncident({ ...incident, type: newType, objectives: mergeObjectivesIntoList(incident.objectives, newObjectives) });
  };

  const addAction = () => setIncident({ ...incident, actionsLog: [...incident.actionsLog, { id: uid(), time: "", actions: "" }] });
  const updateAction = (id, patch) => setIncident({ ...incident, actionsLog: incident.actionsLog.map(a => a.id === id ? { ...a, ...patch } : a) });
  const removeAction = (id) => setIncident({ ...incident, actionsLog: incident.actionsLog.filter(a => a.id !== id) });

  // Mirrors the Resource Board's own grouping now that it organizes
  // by Assignment/Division rather than status — this summary follows
  // suit so the two never show conflicting pictures of where
  // resources currently stand.
  const assignmentColumns = deriveAssignmentColumns(resources, assignmentPresets, resourceColumnOrder);
  const counts = assignmentColumns.map(col => ({ column: col, n: resources.filter(r => columnFor(r) === col).length }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Tactical Worksheet" icon={ClipboardList}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <Field label="Incident Name"><TextInput value={incident.name} onChange={e => setIncident({ ...incident, name: e.target.value })} placeholder="e.g. County Rd 411 Structure" /></Field>
          <Field label="Incident Number"><TextInput value={incident.number} onChange={e => setIncident({ ...incident, number: e.target.value })} placeholder="Dispatch / CAD #" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginTop: 14 }}>
          <Field label="Date Initiated"><TextInput type="date" value={incident.dateInitiated} onChange={e => setIncident({ ...incident, dateInitiated: e.target.value })} /></Field>
          <Field label="Time Initiated"><TextInput type="time" value={incident.timeInitiated} onChange={e => setIncident({ ...incident, timeInitiated: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginTop: 14 }}>
          <Field label="Date Terminated"><TextInput type="date" value={incident.dateTerminated} onChange={e => setIncident({ ...incident, dateTerminated: e.target.value })} /></Field>
          <Field label="Time Terminated"><TextInput type="time" value={incident.timeTerminated} onChange={e => setIncident({ ...incident, timeTerminated: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginTop: 14 }}>
          <Field label="Incident Type">
            <Select value={incident.type} onChange={e => handleTypeChange(e.target.value)}>
              {/* Placeholder for a brand-new incident with no type
                  chosen yet — matches incident.type's own default of
                  "" in blankIncident, so the dropdown correctly shows
                  this rather than silently defaulting to whatever
                  option happens to be listed first. */}
              <option value="">Select Incident Type</option>
              {/* Covers the case where this incident's current type was
                  since deleted from the preset list (e.g. by an admin,
                  or from an older save) — rendered as an extra option
                  so the field doesn't silently show blank or jump to
                  a different value out from under whatever was saved. */}
              {incident.type && !incidentTypePresets.includes(incident.type) && <option value={incident.type}>{incident.type}</option>}
              {incidentTypePresets.map(t => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Location"><TextInput value={incident.location} onChange={e => setIncident({ ...incident, location: e.target.value })} placeholder="Address / cross streets / lat-long" /></Field>
          <Field label="Incident Commander"><TextInput value={incident.icName} onChange={e => setIncident({ ...incident, icName: e.target.value })} /></Field>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "16px 0 4px" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace" }}>Weather Conditions</div>
          <Btn kind="subtle" icon={Crosshair} onClick={fetchCurrentWeather} disabled={weatherStatus === "loading"} style={{ padding: "4px 10px", fontSize: 11.5 }}>
            {weatherStatus === "loading" ? "Fetching..." : "Get Current Weather"}
          </Btn>
        </div>
        {weatherStatus && weatherStatus !== "loading" && (
          <div style={{ fontSize: 11.5, color: COLORS.dangerText, marginBottom: 6 }}>{weatherStatus}</div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14 }}>
          <Field label="Wind"><TextInput value={incident.wind} onChange={e => setIncident({ ...incident, wind: e.target.value })} placeholder="8 mph SW" /></Field>
          <Field label="Temp"><TextInput value={incident.temp} onChange={e => setIncident({ ...incident, temp: e.target.value })} placeholder="72°F" /></Field>
          <Field label="RH"><TextInput value={incident.rh} onChange={e => setIncident({ ...incident, rh: e.target.value })} placeholder="45%" /></Field>
          <Field label="Conditions"><TextInput value={incident.conditions} onChange={e => setIncident({ ...incident, conditions: e.target.value })} placeholder="Clear, smoke visible..." /></Field>
        </div>

        <div style={{ marginTop: 14 }}>
          <Field label="Situation Summary and Health and Safety Briefing" wide>
            <TextArea value={incident.situation} onChange={e => setIncident({ ...incident, situation: e.target.value })} style={{ minHeight: 90 }}
              placeholder="Recognize potential incident health and safety hazards and note measures taken to protect responders (remove hazard, PPE, warn people)..." />
          </Field>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace" }}>Current and Planned Objectives</div>
            <ObjectivePickerDropdown incidentType={incident.type} objectivesByType={objectivesByType} onPick={addObjectiveFromPreset} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {incident.objectives.map((o, i) => {
              const isNewObjective = o.trim() && !relevantObjectives.includes(o.trim());
              return (
                <div key={i} style={{ display: "flex", gap: 8 }}>
                  <span style={{ width: 22, textAlign: "right", color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, paddingTop: 9 }}>{i + 1}.</span>
                  <TextInput list="objective-presets" value={o} onChange={e => updateObjective(i, e.target.value)} style={{ flex: 1 }} placeholder="Objective..." />
                  {isNewObjective && (
                    <button onClick={() => onAddObjective(incident.type, o.trim())} title={`Save as a quick-pick objective for ${incident.type || "this type"}`} style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 4, color: COLORS.amber, cursor: "pointer", padding: "0 8px" }}>
                      <Star size={14} />
                    </button>
                  )}
                  <Btn kind="danger" onClick={() => removeObjective(i)}><Trash2 size={14} /></Btn>
                </div>
              );
            })}
            <datalist id="objective-presets">{relevantObjectives.map(p => <option key={p} value={p} />)}</datalist>
            <Btn kind="subtle" icon={Plus} onClick={addObjective} style={{ alignSelf: "flex-start" }}>Add Objective</Btn>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 8 }}>Current and Planned Actions, Strategies, and Tactics</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 12 }}>
            {[["strategyOffensive", "Offensive"], ["strategyDefensive", "Defensive"], ["strategyTransitional", "Transitional"], ["strategyInvestigative", "Investigative"]].map(([key, label]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13 }}>
                <input type="checkbox" checked={incident[key]} onChange={e => setIncident({ ...incident, [key]: e.target.checked })} style={{ width: 16, height: 16 }} />
                {label}
              </label>
            ))}
          </div>
          {incident.actionsLog.map(a => (
            <div key={a.id} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <TextInput type="time" value={a.time} onChange={e => updateAction(a.id, { time: e.target.value })} style={{ width: 130 }} />
              <TextInput value={a.actions} onChange={e => updateAction(a.id, { actions: e.target.value })} placeholder="Actions..." style={{ flex: 1 }} />
              <button onClick={() => removeAction(a.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
            </div>
          ))}
          <Btn kind="subtle" icon={Plus} onClick={addAction} style={{ marginTop: 4 }}>Add Entry</Btn>
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>
          Current Organization — see the Org Chart tab (Incident Commander(s), Section Chiefs, Safety Officer, PIO, Liaison Officer)
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>Prepared By</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
          <Field label="Name"><TextInput value={incident.preparedBy} onChange={e => setIncident({ ...incident, preparedBy: e.target.value })} /></Field>
          <Field label="Position / Title"><TextInput value={incident.prepPosition} onChange={e => setIncident({ ...incident, prepPosition: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={incident.prepSignature} onChange={e => setIncident({ ...incident, prepSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={incident.prepDateTime} onChange={e => setIncident({ ...incident, prepDateTime: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Resource Board Status" icon={Truck}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 10 }}>
          {counts.map(c => (
            <div key={c.column} style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "10px 8px", textAlign: "center" }}>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 28, color: assignmentColumnColor(c.column, assignmentColumns) }}>{c.n}</div>
              <div style={{ fontSize: 10.5, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 2 }}>{c.column}</div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: RESOURCE STATUS BOARD
   ============================================================ */
// Rename/move/delete for the Department -> Unit hierarchy. Renaming
// uses an uncontrolled input that commits on blur/Enter rather than
// saving on every keystroke — a rename is a single deliberate edit,
// not something that needs a write per character typed.
// Reusable rename/delete/reorder/add UI for a simple flat list —
// shared by the Assignments and Types tabs below, which need
// identical behavior and differ only in their data and labels.
// Drag-to-reorder for a plain list, built on Pointer Events (not native
// HTML5 drag-and-drop, which is unreliable on touch devices) — same
// approach already used for the Resource Board columns. Reorders live
// as you drag over other rows, then commits the final order on release
// via onReorderFull(newFullArray), rather than one write per swap.
function DragReorderList({ items, keyFn, onReorderFull, renderItem, axis = "vertical" }) {
  const [dragKey, setDragKey] = useState(null);
  const [liveOrder, setLiveOrder] = useState(items);
  const itemRefs = useRef({});
  const liveOrderRef = useRef(items);

  useEffect(() => { if (!dragKey) { setLiveOrder(items); liveOrderRef.current = items; } }, [items, dragKey]);
  useEffect(() => { liveOrderRef.current = liveOrder; }, [liveOrder]);

  useEffect(() => {
    if (!dragKey) return;
    const handleMove = (e) => {
      const order = liveOrderRef.current;
      const idx = order.findIndex(it => keyFn(it) === dragKey);
      if (idx === -1) return;
      // insertBeforeIdx = the position, in the ORIGINAL (pre-removal)
      // array, before which the dragged item should land — found by
      // the first row/column whose midpoint the pointer is past.
      // Defaults to the very end if the pointer is past every one.
      // axis picks which coordinate and edge to compare against —
      // vertical (the original, default behavior) compares clientY
      // against each row's vertical midpoint; horizontal compares
      // clientX against each column's horizontal midpoint instead,
      // added specifically for reordering the Resource Board's
      // Assignment/Division columns left-to-right.
      let insertBeforeIdx = order.length;
      for (let i = 0; i < order.length; i++) {
        const el = itemRefs.current[keyFn(order[i])];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const isPastMidpoint = axis === "horizontal"
          ? e.clientX < rect.left + rect.width / 2
          : e.clientY < rect.top + rect.height / 2;
        if (isPastMidpoint) { insertBeforeIdx = i; break; }
      }
      // Removing the dragged item first shifts every index after it
      // down by one — so if the target position is after the source,
      // it must be adjusted by -1 to land correctly in the now-shorter
      // array. Skipping this produces an off-by-one: dropping into a
      // row's top half would land the item one slot too far down.
      if (insertBeforeIdx !== idx && insertBeforeIdx !== idx + 1) {
        const next = [...order];
        const [moved] = next.splice(idx, 1);
        const insertAt = insertBeforeIdx > idx ? insertBeforeIdx - 1 : insertBeforeIdx;
        next.splice(insertAt, 0, moved);
        setLiveOrder(next);
      }
    };
    const handleUp = () => {
      setDragKey(null);
      onReorderFull(liveOrderRef.current);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragKey]);

  return liveOrder.map((item, i) => {
    const k = keyFn(item);
    const dragHandleProps = {
      onPointerDown: (e) => { e.preventDefault(); setDragKey(k); },
      style: { cursor: "grab", touchAction: "none" },
    };
    return (
      <div key={k} ref={el => { itemRefs.current[k] = el; }} style={{ opacity: dragKey === k ? 0.4 : 1 }}>
        {renderItem(item, i, dragHandleProps)}
      </div>
    );
  });
}

function FlatListManager({ items, onRename, onDelete, onReorder, onAdd, addLabel, addPlaceholder, emptyLabel }) {
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const commitNew = () => {
    const name = newValue.trim();
    if (name) onAdd(name);
    setAdding(false);
    setNewValue("");
  };
  return (
    <div>
      {items.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13, marginBottom: 12 }}>{emptyLabel}</div>}
      <DragReorderList items={items} keyFn={item => item} onReorderFull={onReorder} renderItem={(item, i, dragHandleProps) => (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
          <span {...dragHandleProps} title="Drag to reorder" style={{ ...dragHandleProps.style, color: COLORS.faint, flexShrink: 0 }}><GripVertical size={15} /></span>
          <TextInput key={item} defaultValue={item}
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== item) onRename(item, v); }}
            onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
            style={{ flex: 1, fontSize: 12.5 }} />
          <button onClick={() => onDelete(item)} title="Delete" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
        </div>
      )} />
      {adding ? (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder={addPlaceholder} style={{ flex: 1 }}
            onKeyDown={e => { if (e.key === "Enter") commitNew(); if (e.key === "Escape") setAdding(false); }} />
          <Btn kind="solid" onClick={commitNew} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
          <button onClick={() => setAdding(false)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
        </div>
      ) : (
        <Btn kind="subtle" icon={Plus} onClick={() => { setAdding(true); setNewValue(""); }}>{addLabel}</Btn>
      )}
    </div>
  );
}



// Single management modal for everything the Check In Resource form
// pulls from — Departments & Units, Assignments/Divisions, and
// Resource Types — organized as tabs rather than three separate
// buttons/modals, since they're all "manage the resource picker" in
// one place.
// Shared by both the Mayday and PAR buttons — same "check off each
// unit as it reports in, with a timestamp" structure, just different
// severity styling and completion wording. Mayday additionally has an
// active cross-device alert tied to it (see triggerMaydayAlert /
// watchMaydayAlert in store.js) that this modal itself doesn't manage
// directly — that's handled at the AppInner level, since a Mayday
// needs to be visible regardless of which tab is currently open, not
// just while the Resource Board happens to be showing.
// Read-only view of past PAR/Mayday events (see completeParSession in
// AppInner, which is what populates incident.parHistory) — same
// underlying information as the PDF export's "PAR / Mayday History"
// section, just viewable in-app without needing to export anything.
function ParHistoryModal({ history, ignoredReminders, onClose, onSelectEvent }) {
  // Merged and sorted by time so ignored reminders show up in their
  // actual chronological place alongside completed checks, rather
  // than as a disconnected second list the reader has to
  // cross-reference themselves.
  const merged = [
    ...(history || []).map(p => ({ ...p, kind: p.type, sortAt: p.completedAt })),
    ...(ignoredReminders || []).map(r => ({ ...r, kind: "ignored", sortAt: r.at })),
  ].sort((a, b) => new Date(b.sortAt) - new Date(a.sortAt));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90, padding: 16 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 520, maxWidth: "100%", maxHeight: "85vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 15 }}>PAR / Mayday History</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        {merged.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>No PAR or Mayday activity recorded yet on this incident.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {merged.map(p => {
              if (p.kind === "ignored") {
                return (
                  <div key={p.id} style={{ border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${COLORS.faint}`, borderRadius: 6, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                      <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 13, fontWeight: 700, color: COLORS.muted }}>
                        PAR REMINDER IGNORED
                      </span>
                      <span style={{ fontSize: 11.5, color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace" }}>{fmtDateTimeShort(p.at)}</span>
                    </div>
                  </div>
                );
              }
              const isMayday = p.kind === "mayday";
              return (
                <div key={p.id} onClick={() => onSelectEvent(p)}
                  style={{ border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${isMayday ? COLORS.red : COLORS.amber}`, borderRadius: 6, padding: "10px 12px", cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                    <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 13, fontWeight: 700, color: isMayday ? COLORS.red : COLORS.text }}>
                      {isMayday ? "MAYDAY" : "PAR"}
                    </span>
                    <span style={{ fontSize: 11.5, color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace" }}>
                      {fmtDateTimeShort(p.startedAt)} → {fmtDateTimeShort(p.completedAt)} · {p.checkedUnits} of {p.totalUnits} units
                    </span>
                  </div>
                  {p.checkedUnitNames && p.checkedUnitNames.length > 0 && (
                    <div style={{ fontSize: 12.5, color: COLORS.text, marginBottom: p.uncheckedUnitNames?.length ? 4 : 0 }}>
                      <span style={{ color: COLORS.muted }}>Accounted for: </span>{p.checkedUnitNames.join(", ")}
                    </div>
                  )}
                  {p.uncheckedUnitNames && p.uncheckedUnitNames.length > 0 && (
                    <div style={{ fontSize: 12.5, color: COLORS.red }}>
                      <span style={{ color: COLORS.red, opacity: 0.8 }}>NOT accounted for: </span>{p.uncheckedUnitNames.join(", ")}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: COLORS.faint, marginTop: 6 }}>View full detail & export →</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// Full per-unit detail for a single PAR/Mayday event, opened by
// clicking an entry in ParHistoryModal — shows each unit's
// assignment/task exactly as they stood at the time of the event
// (see completeParSession, which snapshots this rather than looking
// it up live), plus the exact moment each one was checked, with its
// own standalone PDF export for just this one event.
function ParEventDetailModal({ event, incidentName, onClose }) {
  const isMayday = event.kind === "mayday";
  const hasDetail = event.checkedUnitDetails && event.checkedUnitDetails.length > 0;
  const [exporting, setExporting] = useState(false);
  const doExport = async () => {
    setExporting(true);
    try { await downloadParEventPdf(event, incidentName); }
    finally { setExporting(false); }
  };
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 96, padding: 16 }}>
      <div style={{ background: COLORS.panel, border: `2px solid ${isMayday ? COLORS.red : COLORS.amber}`, borderRadius: 8, width: 580, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 17, color: isMayday ? COLORS.red : COLORS.text, fontWeight: 700 }}>
            {isMayday ? "MAYDAY" : "PAR"} Detail
          </span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 14 }}>
          Started {fmtDateTimeShort(event.startedAt)} · Completed {fmtDateTimeShort(event.completedAt)} · {event.checkedUnits} of {event.totalUnits} units
        </div>
        {!hasDetail && (
          <div style={{ fontSize: 12, color: COLORS.faint, fontStyle: "italic", marginBottom: 12 }}>
            This is an older entry recorded before per-unit assignment/task/timestamp detail was captured — showing names only.
          </div>
        )}
        {hasDetail ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
                <th style={{ padding: "6px 8px", textAlign: "left" }}>Unit</th>
                <th style={{ padding: "6px 8px", textAlign: "left" }}>Assignment</th>
                <th style={{ padding: "6px 8px", textAlign: "left" }}>Task</th>
                <th style={{ padding: "6px 8px", textAlign: "left" }}>Time Checked</th>
              </tr></thead>
              <tbody>
                {event.checkedUnitDetails.map(u => (
                  <tr key={u.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{u.label}</td>
                    <td style={{ padding: "6px 8px", color: COLORS.muted }}>{u.assignment || "—"}</td>
                    <td style={{ padding: "6px 8px", color: COLORS.muted }}>{u.task || "—"}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: COLORS.teal }}>{fmtDateTimeShort(u.checkedAt)}</td>
                  </tr>
                ))}
                {(event.uncheckedUnitDetails || []).map(u => (
                  <tr key={u.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600, color: COLORS.red }}>{u.label}</td>
                    <td style={{ padding: "6px 8px", color: COLORS.muted }}>{u.assignment || "—"}</td>
                    <td style={{ padding: "6px 8px", color: COLORS.muted }}>{u.task || "—"}</td>
                    <td style={{ padding: "6px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: COLORS.red }}>NOT accounted for</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {event.checkedUnitNames && event.checkedUnitNames.length > 0 && (
              <div style={{ fontSize: 12.5 }}><span style={{ color: COLORS.muted }}>Accounted for: </span>{event.checkedUnitNames.join(", ")}</div>
            )}
            {event.uncheckedUnitNames && event.uncheckedUnitNames.length > 0 && (
              <div style={{ fontSize: 12.5, color: COLORS.red }}><span style={{ opacity: 0.8 }}>NOT accounted for: </span>{event.uncheckedUnitNames.join(", ")}</div>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Btn kind="solid" icon={Download} onClick={doExport} disabled={exporting} style={{ flex: 1, justifyContent: "center" }}>
            {exporting ? "Exporting…" : "Export PDF"}
          </Btn>
          <Btn kind="ghost" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </div>
  );
}

function ParCheckModal({ mode, resources, parSession, onCheck, onComplete, onClose, isAlarmPlaying, onSilenceAlarm }) {
  const isMayday = mode === "mayday";
  const accent = isMayday ? COLORS.red : COLORS.amber;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 95, padding: 16 }}>
      <div style={{ background: COLORS.panel, border: `2px solid ${accent}`, borderRadius: 8, width: 560, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 4 }}>
          <div style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: isMayday ? 19 : 15, color: isMayday ? COLORS.red : COLORS.text, fontWeight: 700 }}>
            {isMayday ? "MAYDAY — Personnel Accountability Report" : "PAR Check"}
          </div>
          {isMayday && isAlarmPlaying && (
            <Btn kind="ghost" onClick={onSilenceAlarm} style={{ padding: "6px 11px", fontSize: 12, flexShrink: 0 }}>Silence Alarm</Btn>
          )}
        </div>
        <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 14 }}>
          Check off each unit as it reports in — the time is recorded automatically.
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>Unit</th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>Assignment</th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>Task</th>
              <th style={{ padding: "6px 8px", textAlign: "center" }}>PAR</th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>Time</th>
            </tr></thead>
            <tbody>
              {resources.map(r => {
                const checkedAt = parSession && parSession.checks ? parSession.checks[r.id] : null;
                return (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                    <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.label}</td>
                    <td style={{ padding: "6px 8px", color: COLORS.muted }}>{r.assignment || "—"}</td>
                    <td style={{ padding: "6px 8px", color: COLORS.muted }}>{r.task || "—"}</td>
                    <td style={{ padding: "6px 8px", textAlign: "center" }}>
                      <input type="checkbox" checked={!!checkedAt} onChange={() => onCheck(r.id)} style={{ width: 18, height: 18 }} />
                    </td>
                    <td style={{ padding: "6px 8px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: checkedAt ? COLORS.teal : COLORS.faint }}>
                      {checkedAt ? new Date(checkedAt).toLocaleTimeString() : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {resources.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "14px 2px" }}>No resources checked in yet.</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <Btn kind={isMayday ? "danger" : "solid"} onClick={onComplete} style={{ flex: 1, justifyContent: "center" }}>
            {isMayday ? "All Clear — End Mayday" : "Complete PAR"}
          </Btn>
          {/* Mayday has no plain "Close" — closing it must go through
              All Clear, which is what actually updates the shared
              alert record. Without this, silencing the alarm by
              taking PAR (a separate, local-only stop) could look
              exactly like the Mayday being fully resolved, when the
              underlying alert was actually still active and would
              reopen the moment the incident was loaded again. */}
          {!isMayday && <Btn kind="ghost" onClick={onClose}>Close</Btn>}
        </div>
      </div>
    </div>
  );
}

function ManageResourcesModal({
  departments, onRenameDept, onDeleteDept, onReorderDept, onRenameUnit, onDeleteUnit, onMoveUnit, onReorderUnit, onAddDepartment, onAddUnitUnderDepartment,
  assignments, onRenameAssignment, onDeleteAssignment, onReorderAssignment, onAddAssignment,
  resourceKinds, onRenameKind, onDeleteKind, onReorderKind, onAddKind,
  tasks, onRenameTask, onDeleteTask, onReorderTask, onAddTask,
  onClose, onBack,
}) {
  const [subTab, setSubTab] = useState("departments"); // departments | assignments | kinds
  const [addingDeptFor, setAddingDeptFor] = useState(false);
  const [addingUnitFor, setAddingUnitFor] = useState(null); // deptId or null
  const [newValue, setNewValue] = useState("");

  const commitNewDept = () => {
    const name = newValue.trim();
    if (name) onAddDepartment(name);
    setAddingDeptFor(false);
    setNewValue("");
  };
  const commitNewUnit = (deptId) => {
    const name = newValue.trim();
    if (name) onAddUnitUnderDepartment(deptId, name);
    setAddingUnitFor(null);
    setNewValue("");
  };

  const SUB_TABS = [
    { k: "departments", label: "Departments & Units" },
    { k: "assignments", label: "Assignments" },
    { k: "kinds", label: "Resource Types" },
    { k: "tasks", label: "Tasks" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 65 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 560, maxHeight: "84vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 15 }}>Manage Resources</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 10 }}>
          {SUB_TABS.map(t => (
            <button key={t.k} onClick={() => setSubTab(t.k)} style={{
              background: subTab === t.k ? COLORS.panel2 : "transparent",
              border: `1px solid ${subTab === t.k ? COLORS.amber : COLORS.line}`,
              color: subTab === t.k ? COLORS.text : COLORS.muted,
              borderRadius: 5, padding: "6px 11px", fontSize: 12, cursor: "pointer",
            }}>{t.label}</button>
          ))}
        </div>

        {subTab === "departments" && (
          <>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              Edit a name and click away (or press Enter) to rename it. Drag the grip to reorder, or use the dropdown next to a unit to move it to a different department.
            </div>

            {departments.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13, marginBottom: 12 }}>No departments yet.</div>}

            <DragReorderList items={departments} keyFn={d => d.id} onReorderFull={onReorderDept} renderItem={(d, di, deptDragProps) => (
              <div style={{ marginBottom: 14, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                  <span {...deptDragProps} title="Drag to reorder" style={{ ...deptDragProps.style, color: COLORS.faint, flexShrink: 0 }}><GripVertical size={16} /></span>
                  <TextInput key={d.id + d.name} defaultValue={d.name}
                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== d.name) onRenameDept(d.id, v); }}
                    onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                    style={{ flex: 1, fontWeight: 600 }} />
                  <button onClick={() => onDeleteDept(d.id)} title="Delete department (and its units)" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={15} /></button>
                </div>

                <DragReorderList items={d.units} keyFn={u => u} onReorderFull={(newUnits) => onReorderUnit(d.id, newUnits)} renderItem={(u, ui, unitDragProps) => (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, paddingLeft: 14 }}>
                    <span {...unitDragProps} title="Drag to reorder" style={{ ...unitDragProps.style, color: COLORS.faint, flexShrink: 0 }}><GripVertical size={14} /></span>
                    <TextInput key={d.id + u} defaultValue={u}
                      onBlur={e => { const v = e.target.value.trim(); if (v && v !== u) onRenameUnit(d.id, u, v); }}
                      onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                      style={{ flex: 1, fontSize: 12.5 }} />
                    {departments.length > 1 && (
                      <Select value={d.id} onChange={e => { if (e.target.value !== d.id) onMoveUnit(d.id, u, e.target.value); }} style={{ width: 140, fontSize: 12 }} title="Move to department">
                        {departments.map(dd => <option key={dd.id} value={dd.id}>{dd.name}</option>)}
                      </Select>
                    )}
                    <button onClick={() => onDeleteUnit(d.id, u)} title="Delete unit" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={13} /></button>
                  </div>
                )} />

                {addingUnitFor === d.id ? (
                  <div style={{ display: "flex", gap: 6, paddingLeft: 14, marginTop: 6 }}>
                    <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="New unit name" style={{ flex: 1, fontSize: 12.5 }}
                      onKeyDown={e => { if (e.key === "Enter") commitNewUnit(d.id); if (e.key === "Escape") setAddingUnitFor(null); }} />
                    <Btn kind="solid" onClick={() => commitNewUnit(d.id)} style={{ padding: "5px 9px", fontSize: 12 }}>Add</Btn>
                    <button onClick={() => setAddingUnitFor(null)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={13} /></button>
                  </div>
                ) : (
                  <Btn kind="subtle" icon={Plus} onClick={() => { setAddingUnitFor(d.id); setNewValue(""); }} style={{ marginTop: 6, marginLeft: 14, padding: "4px 8px", fontSize: 11.5 }}>Add Unit</Btn>
                )}
              </div>
            )} />

            {addingDeptFor ? (
              <div style={{ display: "flex", gap: 6 }}>
                <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="New department name" style={{ flex: 1 }}
                  onKeyDown={e => { if (e.key === "Enter") commitNewDept(); if (e.key === "Escape") setAddingDeptFor(false); }} />
                <Btn kind="solid" onClick={commitNewDept} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
                <button onClick={() => setAddingDeptFor(false)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
              </div>
            ) : (
              <Btn kind="subtle" icon={Plus} onClick={() => { setAddingDeptFor(true); setNewValue(""); }}>Add Department</Btn>
            )}
          </>
        )}

        {subTab === "assignments" && (
          <>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              Edit a name and click away (or press Enter) to rename it. Use the arrows to reorder.
            </div>
            <FlatListManager
              items={assignments} onRename={onRenameAssignment} onDelete={onDeleteAssignment} onReorder={onReorderAssignment} onAdd={onAddAssignment}
              addLabel="Add Assignment" addPlaceholder="New assignment" emptyLabel="None yet." />
          </>
        )}

        {subTab === "kinds" && (
          <>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              Edit a name and click away (or press Enter) to rename it. Use the arrows to reorder.
            </div>
            <FlatListManager
              items={resourceKinds} onRename={onRenameKind} onDelete={onDeleteKind} onReorder={onReorderKind} onAdd={onAddKind}
              addLabel="Add Resource Type" addPlaceholder="New resource type" emptyLabel="None yet." />
          </>
        )}

        {subTab === "tasks" && (
          <>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              Edit a name and click away (or press Enter) to rename it. Use the arrows to reorder. This is the list shown in the Task dropdown when checking in a resource.
            </div>
            <FlatListManager
              items={tasks} onRename={onRenameTask} onDelete={onDeleteTask} onReorder={onReorderTask} onAdd={onAddTask}
              addLabel="Add Task" addPlaceholder="New task" emptyLabel="None yet." />
          </>
        )}
      </div>
    </div>
  );
}

function ResourceForm({ onAdd, departments, onAddDepartment, onAddUnitUnderDepartment, assignmentPresets, onSaveAssignmentPreset, resourceKindPresets, onAddResourceKind, taskPresets, onSaveTaskPreset, incidentType, assignmentsByType, tasksByType }) {
  const [f, setF] = useState({ label: "", kind: "", personnel: 1, assignment: "", task: "" });
  const [deptId, setDeptId] = useState("");
  const [addingField, setAddingField] = useState(null); // null | "department" | "unit" | "assignment" | "task"
  const [newValue, setNewValue] = useState("");
  const [checkInError, setCheckInError] = useState("");

  const selectedDept = departments.find(d => d.id === deptId) || null;
  // Narrows to the subset configured for the current incident type
  // under Admin -> Assignments by Incident Type, if one has actually
  // been set up for it — an empty/missing filter for a type means
  // "not configured yet", not "nothing available", so every
  // assignment still shows until someone opts a type into filtering.
  const typeFilter = assignmentsByType && incidentType ? assignmentsByType[incidentType] : null;
  const filteredAssignmentPresets = (typeFilter && typeFilter.length > 0) ? typeFilter : assignmentPresets;
  // Same filtering pattern, for the Task dropdown below.
  const taskTypeFilter = tasksByType && incidentType ? tasksByType[incidentType] : null;
  const filteredTaskPresets = (taskTypeFilter && taskTypeFilter.length > 0) ? taskTypeFilter : taskPresets;

  const submit = () => {
    // Assignment/Division is required (not just recommended) now that
    // the board has no catch-all "Unassigned" column left — a
    // resource checked in without one would have nowhere on the board
    // to actually appear, silently going unaccounted for rather than
    // just looking untidy.
    if (!f.label.trim()) { setCheckInError("Resource name is required."); return; }
    if (!f.assignment) { setCheckInError("Assignment/Division is required to check in a resource."); return; }
    // Same reasoning as Assignment/Division above — Type used to
    // always have a real value by default (the first resourceKinds
    // preset), so this case never came up before; now that it starts
    // blank and is usually filled by auto-detection instead, an
    // unrecognized unit name could otherwise slip through checked in
    // with no type at all.
    if (!f.kind) { setCheckInError("Type is required to check in a resource."); return; }
    setCheckInError("");
    onAdd({ id: uid(), label: f.label.trim(), kind: f.kind, department: selectedDept ? selectedDept.name : "", personnel: Number(f.personnel) || 1, assignment: f.assignment, task: f.task, status: ACTIVE_STATUS, statusSince: nowISO(), checkIn: nowISO(), notes: "", history: [{ status: ACTIVE_STATUS, at: nowISO() }] });
    // Resets kind to "" too, not just label — with auto-detection now
    // filling this in from the unit itself, carrying the previous
    // unit's type forward would just be a stale leftover the next
    // pick immediately overwrites anyway, and briefly showing it
    // implies a real default that isn't there.
    setF({ label: "", kind: "", personnel: 1, assignment: "", task: "" });
  };

  const startAdding = (field) => { setAddingField(field); setNewValue(""); };
  // Runs the auto-detection and, when it finds a match, ensures that
  // kind actually exists as a selectable preset (onAddResourceKind is
  // a no-op if it already does) — covers a deployment whose saved
  // resourceKinds list predates a designation like "Squad" or "Fire
  // Marshall" being added.
  const applyDetectedKind = (label) => {
    const detected = detectResourceKindFromLabel(label);
    if (detected) onAddResourceKind(detected);
    return detected;
  };
  const confirmAdd = () => {
    const name = newValue.trim();
    if (!name) return;
    if (addingField === "department") {
      const id = onAddDepartment(name);
      setDeptId(id);
      setF(prev => ({ ...prev, label: "" }));
    } else if (addingField === "unit") {
      onAddUnitUnderDepartment(deptId, name);
      const detected = applyDetectedKind(name);
      setF(prev => ({ ...prev, label: name, kind: detected || "" }));
    } else if (addingField === "task") {
      onSaveTaskPreset(name);
      setF(prev => ({ ...prev, task: name }));
    } else {
      onSaveAssignmentPreset(name);
      setF(prev => ({ ...prev, assignment: name }));
    }
    setAddingField(null);
    setNewValue("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Field label="Department">
        {addingField === "department" ? (
          <div style={{ display: "flex", gap: 4 }}>
            <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="e.g. Sanger FD" style={{ width: 150 }}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(); if (e.key === "Escape") setAddingField(null); }} />
            <Btn kind="solid" onClick={confirmAdd} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
            <button onClick={() => setAddingField(null)} title="Cancel" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ) : (
          <Select value={deptId} onChange={e => {
            if (e.target.value === "__add_new__") startAdding("department");
            else { setDeptId(e.target.value); setF(prev => ({ ...prev, label: "" })); }
          }} style={{ width: 160 }}>
            <option value="">Select department...</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value="__add_new__">+ Add Department</option>
          </Select>
        )}
      </Field>
      <Field label="Unit / Resource ID">
        {addingField === "unit" ? (
          <div style={{ display: "flex", gap: 4 }}>
            <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="e.g. Brush 581" style={{ width: 150 }}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(); if (e.key === "Escape") setAddingField(null); }} />
            <Btn kind="solid" onClick={confirmAdd} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
            <button onClick={() => setAddingField(null)} title="Cancel" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ) : (
          <Select value={f.label} disabled={!selectedDept} onChange={e => {
            if (e.target.value === "__add_new__") startAdding("unit");
            else {
              const detected = applyDetectedKind(e.target.value);
              // detected || "" here, not detected || f.kind — a fresh
              // unit selection should always reflect ONLY what that
              // specific unit's name detects (or genuinely nothing,
              // prompting a manual pick), never silently carry over a
              // different, previously-selected unit's type.
              setF({ ...f, label: e.target.value, kind: detected || "" });
            }
          }} style={{ width: 200 }} title={!selectedDept ? "Select a department first" : undefined}>
            <option value="">{selectedDept ? "Select a unit..." : "Select department first..."}</option>
            {selectedDept && selectedDept.units.map(u => <option key={u} value={u}>{u}</option>)}
            {selectedDept && <option value="__add_new__">+ Add Unit</option>}
          </Select>
        )}
      </Field>
      <Field label="Type">
        <Select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} style={{ width: 150 }}>
          <option value="">Select unit first</option>
          {resourceKindPresets.map(k => <option key={k} value={k}>{k}</option>)}
        </Select>
      </Field>
      <Field label="Personnel"><TextInput type="number" min="0" value={f.personnel} onChange={e => setF({ ...f, personnel: e.target.value })} style={{ width: 80 }} /></Field>
      <Field label="Assignment / Division">
        {addingField === "assignment" ? (
          <div style={{ display: "flex", gap: 4 }}>
            <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="New assignment" style={{ width: 150 }}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(); if (e.key === "Escape") setAddingField(null); }} />
            <Btn kind="solid" onClick={confirmAdd} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
            <button onClick={() => setAddingField(null)} title="Cancel" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ) : (
          <Select value={f.assignment} onChange={e => {
            if (e.target.value === "__add_new__") startAdding("assignment");
            else setF({ ...f, assignment: e.target.value });
          }} style={{ width: 180 }}>
            <option value="">Select assignment...</option>
            {filteredAssignmentPresets.map(a => <option key={a} value={a}>{a}</option>)}
            <option value="__add_new__">+ Add Assignment</option>
          </Select>
        )}
      </Field>
      <Field label="Task">
        {addingField === "task" ? (
          <div style={{ display: "flex", gap: 4 }}>
            <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="New task" style={{ width: 150 }}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(); if (e.key === "Escape") setAddingField(null); }} />
            <Btn kind="solid" onClick={confirmAdd} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
            <button onClick={() => setAddingField(null)} title="Cancel" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ) : (
          <Select value={f.task} onChange={e => {
            if (e.target.value === "__add_new__") startAdding("task");
            else setF({ ...f, task: e.target.value });
          }} style={{ width: 180 }}>
            <option value="">Select task...</option>
            {filteredTaskPresets.map(t => <option key={t} value={t}>{t}</option>)}
            <option value="__add_new__">+ Add Task</option>
          </Select>
        )}
      </Field>
      <Btn kind="solid" icon={Plus} onClick={submit}>Check In</Btn>
    </div>
    {checkInError && <div style={{ fontSize: 12.5, color: COLORS.dangerText }}>{checkInError}</div>}
    </div>
  );
}

function ResourceCard({ r, onMove, onUpdate, onRemove, now, dragProps, isDragging, assignmentPresets, assignmentsByType, taskPresets, tasksByType, incidentType }) {
  const [editing, setEditing] = useState(false);
  const nextOptions = STATUS_FLOW.filter(s => s !== r.status);
  // When currently parked in one of the four status columns, offer an
  // explicit way back to its division too — not just via drag, since
  // "moved out of Staging/Rehab/Out of Service/Released" should be
  // just as reachable as moving into one of them in the first place.
  const canReturnToDivision = STATUS_FLOW.includes(r.status) && r.assignment;
  // Same fallback-to-everything-if-unconfigured filtering ResourceForm
  // uses at check-in — kept in sync with it rather than reimplemented
  // slightly differently. The resource's OWN current assignment is
  // always included even if it falls outside the current type's
  // filtered subset (e.g. the incident type changed after this unit
  // checked in) — otherwise editing the card could silently make its
  // existing, valid assignment vanish from the list entirely.
  const typeFilter = assignmentsByType && incidentType ? assignmentsByType[incidentType] : null;
  const baseAssignmentOptions = (typeFilter && typeFilter.length > 0) ? typeFilter : (assignmentPresets || []);
  const cardAssignmentOptions = (r.assignment && !baseAssignmentOptions.includes(r.assignment)) ? [r.assignment, ...baseAssignmentOptions] : baseAssignmentOptions;
  // Same pattern, for the inline Task field below.
  const taskTypeFilter = tasksByType && incidentType ? tasksByType[incidentType] : null;
  const baseTaskOptions = (taskTypeFilter && taskTypeFilter.length > 0) ? taskTypeFilter : (taskPresets || []);
  const cardTaskOptions = (r.task && !baseTaskOptions.includes(r.task)) ? [r.task, ...baseTaskOptions] : baseTaskOptions;
  // Once released, the timer stops accruing — freeze it at the moment
  // of release instead of continuing to tick against real time.
  const cardNow = r.status === "Released" ? new Date(r.statusSince).getTime() : now;
  // While in Rehab, also surface how long the resource was Working
  // right before it came in — a static duration, not a live timer.
  const prior = r.status === "Rehab" ? priorPeriod(r.history) : null;
  return (
    <div style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${STATUS_COLOR[r.status]}`, borderRadius: 5, padding: 10, marginBottom: 8, opacity: isDragging ? 0.35 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <span
            {...dragProps}
            title="Drag to move"
            style={{ cursor: "grab", touchAction: "none", color: COLORS.faint, marginTop: 2, flexShrink: 0 }}
          >
            <GripVertical size={14} />
          </span>
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 14 }}>{r.label}</div>
            <div style={{ fontSize: 11.5, color: COLORS.muted }}>{r.kind} · {r.personnel} pers.</div>
            {r.department && <div style={{ fontSize: 10.5, color: COLORS.faint }}>{r.department}</div>}
          </div>
        </div>
        <button onClick={() => onRemove(r.id)} title="Remove" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={13} /></button>
      </div>
      {r.task && <div style={{ fontSize: 11.5, color: COLORS.amber, marginTop: 4 }}>→ {r.task}</div>}
      {prior && (
        <div style={{ fontSize: 10.5, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", marginTop: 6 }}>
          {prior.status} before rehab: {fmtDuration(prior.ms)}
        </div>
      )}
      <div style={{ fontSize: 10.5, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", marginTop: prior ? 2 : 6 }}>
        {r.status === "Rehab" ? "in rehab " : "in status "}{elapsed(r.statusSince, cardNow)}
      </div>
      {editing ? (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <Select value={r.assignment} onChange={e => onUpdate(r.id, { assignment: e.target.value })}>
            <option value="">Select assignment...</option>
            {cardAssignmentOptions.map(a => <option key={a} value={a}>{a}</option>)}
          </Select>
          <Select value={r.task} onChange={e => onUpdate(r.id, { task: e.target.value })}>
            <option value="">Select task...</option>
            {cardTaskOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </Select>
          <TextArea placeholder="Notes" defaultValue={r.notes} onBlur={e => onUpdate(r.id, { notes: e.target.value })} style={{ minHeight: 44 }} />
          <Btn kind="subtle" onClick={() => setEditing(false)}>Done</Btn>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <Select value="" onChange={e => { if (e.target.value) onMove(r.id, e.target.value); }} style={{ fontSize: 12, padding: "5px 7px" }}>
            <option value="">Move to...</option>
            {canReturnToDivision && <option value={r.assignment}>Return to {r.assignment}</option>}
            {nextOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Btn kind="ghost" onClick={() => setEditing(true)} style={{ padding: "5px 8px", fontSize: 12 }}>Edit</Btn>
        </div>
      )}
    </div>
  );
}

function TabResources({ resources, setResources, now, incident, setIncident, parIntervalMinutes, departments, onAddDepartment, onAddUnitUnderDepartment, onRenameDepartment, onDeleteDepartment, onReorderDepartment, onRenameUnit, onDeleteUnit, onMoveUnit, onReorderUnit, assignmentPresets, assignmentsByType, onSaveAssignmentPreset, onRenameAssignment, onDeleteAssignment, onReorderAssignment, resourceKindPresets, onAddResourceKind, onRenameResourceKind, onDeleteResourceKind, onReorderResourceKind, taskPresets, tasksByType, onSaveTaskPreset, resourceColumnOrder, setResourceColumnOrder, onTriggerMayday, onStartPar }) {
  // Drag state lives here (not per-card) since the floating preview and
  // column highlight need to render across the whole board. Built on
  // the Pointer Events API + elementFromPoint rather than native HTML5
  // drag-and-drop, because HTML5 DnD is unreliable on touch devices —
  // this app needs to work on iPads and phones, not just desktop mice.
  const [drag, setDrag] = useState(null); // { id, x, y, overColumn }
  const [showParHistory, setShowParHistory] = useState(false);
  const [selectedParEvent, setSelectedParEvent] = useState(null);

  const addResource = (r) => setResources([r, ...resources]);
  const removeResource = (id) => setResources(resources.filter(r => r.id !== id));
  const moveResourceStatus = (id, status) => setResources(resources.map(r => r.id === id ? { ...r, status, statusSince: nowISO(), history: [...r.history, { status, at: nowISO() }] } : r));
  const updateResource = (id, patch) => setResources(resources.map(r => r.id === id ? { ...r, ...patch } : r));

  // Columns are now grouped by Assignment/Division rather than
  // status — a new column appears automatically the moment a resource
  // is checked in (or edited) with an assignment value nobody's used
  // yet. See deriveAssignmentColumns for the shared ordering logic
  // (also used by the Tactical Worksheet's status summary, so both
  // stay in sync).
  const columns = deriveAssignmentColumns(resources, assignmentPresets, resourceColumnOrder);
  // "Unassigned" is no longer a special catch-all bucket — it's just
  // whatever ordinary column name a legacy resource without a real
  // division happened to get migrated to (see the load logic in
  // AppInner), so dropping a card on it sets that literal value like
  // any other column, rather than clearing the assignment back to
  // empty the way it used to when "Unassigned" meant "no division."
  // Dropping a card onto any of the four status columns (Staging,
  // Rehab, Out of Service, Released) changes its STATUS rather than
  // its assignment — the resource's actual division is preserved
  // (never overwritten with the status name itself) so it can return
  // to the exact same place once it's back. Dropping onto a real
  // division column reassigns it there, and if it was previously
  // parked in one of the four status columns, also resets its status
  // back to normal (ACTIVE_STATUS) — there's nothing else for it to
  // return to.
  const moveResourceToColumn = (id, column) => {
    if (STATUS_FLOW.includes(column)) {
      moveResourceStatus(id, column);
      return;
    }
    const current = resources.find(r => r.id === id);
    const wasInStatusColumn = current && STATUS_FLOW.includes(current.status);
    updateResource(id, {
      assignment: column,
      ...(wasInStatusColumn ? { status: ACTIVE_STATUS, statusSince: nowISO(), history: [...current.history, { status: ACTIVE_STATUS, at: nowISO() }] } : {}),
    });
  };

  const columnAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const colEl = el && el.closest("[data-column-assignment]");
    return colEl ? colEl.getAttribute("data-column-assignment") : null;
  };

  const handlePointerDown = (r, e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: r.id, x: e.clientX, y: e.clientY, overColumn: columnFor(r) });
  };
  const handlePointerMove = (e) => {
    setDrag(d => d ? { ...d, x: e.clientX, y: e.clientY, overColumn: columnAt(e.clientX, e.clientY) } : d);
  };
  const endDrag = (e, commit) => {
    setDrag(d => {
      if (d && commit) {
        const target = columnAt(e.clientX, e.clientY);
        const current = resources.find(r => r.id === d.id);
        if (target && current && target !== columnFor(current)) moveResourceToColumn(d.id, target);
      }
      return null;
    });
  };

  const draggingResource = drag ? resources.find(r => r.id === drag.id) : null;
  // Keyed by the objective's own text (see blankIncident) rather than
  // needing any change to how objectives themselves are stored.
  const toggleObjectiveComplete = (text) => setIncident({ ...incident, objectivesCompleted: { ...incident.objectivesCompleted, [text]: !incident.objectivesCompleted[text] } });
  const realObjectives = incident.objectives.filter(o => o.trim());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "stretch" }}>
        <Panel title="Check In Resource" icon={Truck} style={{ flex: "2 1 420px" }}>
          <ResourceForm onAdd={addResource} departments={departments} onAddDepartment={onAddDepartment} onAddUnitUnderDepartment={onAddUnitUnderDepartment} assignmentPresets={assignmentPresets} onSaveAssignmentPreset={onSaveAssignmentPreset} resourceKindPresets={resourceKindPresets} onAddResourceKind={onAddResourceKind} taskPresets={taskPresets} onSaveTaskPreset={onSaveTaskPreset} incidentType={incident.type} assignmentsByType={assignmentsByType} tasksByType={tasksByType} />
        </Panel>
        <Panel title="Objectives" icon={CheckCircle2} style={{ flex: "1 1 240px", maxWidth: 340 }}>
          {realObjectives.length === 0 ? (
            <div style={{ fontSize: 12.5, color: COLORS.faint }}>None set on the Tactical Worksheet yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 170, overflowY: "auto" }}>
              {realObjectives.map((o, i) => {
                const isComplete = !!incident.objectivesCompleted[o];
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <button onClick={() => toggleObjectiveComplete(o)} title={isComplete ? "Mark incomplete" : "Mark complete"}
                      style={{ width: 14, height: 14, minWidth: 14, borderRadius: "50%", background: isComplete ? COLORS.teal : COLORS.red, border: "none", cursor: "pointer", padding: 0 }} />
                    <span style={{ fontSize: 12.5, color: COLORS.text, textDecoration: isComplete ? "line-through" : "none", opacity: isComplete ? 0.6 : 1 }}>{o}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
        <Panel title="Accountability" icon={AlertTriangle} style={{ flex: "0 0 180px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%", justifyContent: "center" }}>
            {(() => {
              if (!requiresParTracking(incident.type)) {
                return (
                  <div style={{ textAlign: "center", padding: "2px 4px" }}>
                    <div style={{ fontSize: 10, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Next PAR Due</div>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: COLORS.faint }}>N/A for this incident type</div>
                  </div>
                );
              }
              // Same reasoning as the incident-type case above — while
              // the incident clock is stopped (see Stop/Resume Clock;
              // incident.opEnd is set while stopped), the reminder
              // itself won't fire (see the checkDue effect), so
              // showing a live countdown — or worse, red "OVERDUE" —
              // here would be actively misleading about whether
              // anything is actually about to happen.
              if (incident.opEnd) {
                return (
                  <div style={{ textAlign: "center", padding: "2px 4px" }}>
                    <div style={{ fontSize: 10, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Next PAR Due</div>
                    <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: COLORS.faint }}>Clock stopped</div>
                  </div>
                );
              }
              // Counts down toward when the NEXT PAR will be due,
              // rather than up from the last one — baseline is the
              // same one the 15-minute reminder itself uses (last
              // completed PAR, or the incident's own operational
              // start if none has been taken yet), so this clock and
              // when the reminder actually fires can never disagree.
              const parBaseline = incident.lastParAt || incident.opStart;
              const intervalMs = (parIntervalMinutes || 15) * 60000;
              const remainingMs = parBaseline ? intervalMs - (now - new Date(parBaseline).getTime()) : intervalMs;
              const isOverdue = remainingMs <= 0;
              return (
                <div style={{ textAlign: "center", padding: "2px 4px" }}>
                  <div style={{ fontSize: 10, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Next PAR Due</div>
                  <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 19, fontWeight: 700, color: isOverdue ? COLORS.red : COLORS.text }}>
                    {parBaseline ? (isOverdue ? "OVERDUE" : fmtDuration(remainingMs)) : "—"}
                  </div>
                </div>
              );
            })()}
            <button onClick={onTriggerMayday}
              style={{ background: COLORS.red, color: "#fff", border: "none", borderRadius: 5, padding: "8px 10px", fontFamily: "'Oswald', sans-serif", fontSize: 13, letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 700, cursor: "pointer" }}>
              Mayday
            </button>
            <button onClick={onStartPar}
              style={{ background: COLORS.amber, color: "#191C1F", border: "none", borderRadius: 5, padding: "6px 10px", fontFamily: "'Oswald', sans-serif", fontSize: 12, letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 700, cursor: "pointer" }}>
              PAR
            </button>
            <Btn kind="ghost" onClick={() => setShowParHistory(true)} style={{ width: "100%", justifyContent: "center", fontSize: 11.5, padding: "5px 10px" }}>View History</Btn>
          </div>
        </Panel>
      </div>
      {showParHistory && (
        <ParHistoryModal
          history={incident.parHistory}
          ignoredReminders={incident.ignoredParReminders}
          onClose={() => setShowParHistory(false)}
          onSelectEvent={(event) => setSelectedParEvent(event)}
        />
      )}
      {selectedParEvent && (
        <ParEventDetailModal
          event={selectedParEvent}
          incidentName={incident.name}
          onClose={() => setSelectedParEvent(null)}
        />
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns.length}, minmax(160px, 1fr))`, gap: 10, overflowX: "auto" }}>
        <DragReorderList items={columns} keyFn={col => col} onReorderFull={setResourceColumnOrder} axis="horizontal" renderItem={(col, i, colDragHandleProps) => {
          const items = resources.filter(r => columnFor(r) === col);
          const color = assignmentColumnColor(col, columns);
          const isOver = drag && drag.overColumn === col && drag.id && columnFor(resources.find(r => r.id === drag.id) || {}) !== col;
          return (
            <div data-column-assignment={col} style={{
              background: COLORS.panel, border: `1px solid ${isOver ? color : COLORS.line}`,
              borderTop: `3px solid ${color}`, borderRadius: 6, padding: 10, minHeight: 200,
              boxShadow: isOver ? `0 0 0 2px ${color}` : "none", transition: "box-shadow 0.1s",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span {...colDragHandleProps} title="Drag to reorder columns" style={{ ...colDragHandleProps.style, color: COLORS.faint, display: "flex" }}><GripHorizontal size={14} /></span>
                  <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 12.5 }}>{col}</span>
                </span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: COLORS.muted }}>{items.length}</span>
              </div>
              {items.length === 0 && <div style={{ fontSize: 12, color: COLORS.faint, padding: "10px 2px" }}>No resources</div>}
              {items.map(r => (
                <ResourceCard key={r.id} r={r} onMove={moveResourceToColumn} onUpdate={updateResource} onRemove={removeResource} now={now}
                  assignmentPresets={assignmentPresets} assignmentsByType={assignmentsByType} taskPresets={taskPresets} tasksByType={tasksByType} incidentType={incident.type}
                  isDragging={drag && drag.id === r.id}
                  dragProps={{
                    onPointerDown: (e) => handlePointerDown(r, e),
                    onPointerMove: handlePointerMove,
                    onPointerUp: (e) => endDrag(e, true),
                    onPointerCancel: (e) => endDrag(e, false),
                  }}
                />
              ))}
            </div>
          );
        }} />
      </div>
      {drag && draggingResource && (
        <div style={{
          position: "fixed", left: drag.x + 14, top: drag.y - 16, width: 150, pointerEvents: "none", zIndex: 200,
          background: COLORS.panel2, border: `2px solid ${STATUS_COLOR[draggingResource.status]}`, borderRadius: 5,
          padding: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 13 }}>{draggingResource.label}</div>
          <div style={{ fontSize: 10.5, color: COLORS.muted }}>{draggingResource.kind}</div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TAB: ORG CHART / COMMAND STRUCTURE
   ============================================================ */
// A single box in the org chart — title (usually fixed, but editable
// for command-staff and expanded nodes so new positions can be named
// anything) plus the name of whoever holds it.
// Text input + a ▾ button that opens a modal listing every option in
// full — shared by OrgBox's title field (assignments/divisions) and
// name field (units) below, rather than duplicating the same modal
// logic twice. Typing directly still always works; the button is
// purely an additional way in, not a replacement for it.
function PickerInput({ value, onChange, options, placeholder, inputStyle, modalTitle }) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <div style={{ display: "flex", gap: 3, width: "100%" }}>
      <TextInput value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
      {options && options.length > 0 && (
        <button onClick={() => setShowPicker(true)} title={`Pick from ${modalTitle}`}
          style={{ background: "none", border: `1px solid ${COLORS.line}`, borderRadius: 3, color: COLORS.muted, cursor: "pointer", padding: "0 3px", flexShrink: 0, display: "flex", alignItems: "center" }}>
          <ChevronDown size={11} />
        </button>
      )}
      {showPicker && (
        // Fixed-position modal (not an inline/relative dropdown) so
        // the full option list is always immediately visible and
        // can't get clipped by the org chart's own horizontal scroll
        // container the way a positioned-relative-to-the-box dropdown
        // could.
        <div onClick={() => setShowPicker(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, maxHeight: "70vh", overflowY: "auto", padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 13 }}>{modalTitle}</span>
              <button onClick={() => setShowPicker(false)} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {options.map(opt => (
                <button key={opt} onClick={() => { onChange(opt); setShowPicker(false); }}
                  style={{ background: "none", border: "none", textAlign: "left", padding: "7px 8px", borderRadius: 4, color: COLORS.text, fontSize: 13, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = COLORS.panel2}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  {opt}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// titleOptions/nameOptions are only ever passed for a manually-added
// box (via "+ Add Below"/"+ Add Command Staff" — see manuallyAdded,
// set at creation) — a box that mirrors the Resource Board (an
// auto-synced division, or a per-unit sub-box) already has both
// fields determined by the board itself, so a picker there would be
// redundant at best and could let someone quietly disconnect it from
// the sync without realizing that's what editing either field does.
// The top field (title) is always what DIVISION/position this box
// represents, so it picks from assignments/divisions; the field below
// it (name) is always WHO/WHAT fills that position, so it picks from
// units instead — a uniform rule regardless of how deep the box is
// nested in the tree.
function OrgBox({ title, name, onTitleChange, onNameChange, onDelete, onAddChild, titleEditable, isRoot, titleOptions, nameOptions }) {
  return (
    <div style={{
      background: isRoot ? COLORS.panel2 : COLORS.panel, border: `1.5px solid ${isRoot ? COLORS.amber : COLORS.line}`,
      borderRadius: 6, padding: "8px 10px", width: 168, textAlign: "center", position: "relative", flexShrink: 0,
    }}>
      {onDelete && (
        <button onClick={onDelete} title="Remove" style={{ position: "absolute", top: 2, right: 2, background: "none", border: "none", color: COLORS.faint, cursor: "pointer", padding: 2, lineHeight: 0 }}>
          <X size={12} />
        </button>
      )}
      {titleEditable ? (
        <div style={{ marginBottom: 5 }}>
          <PickerInput value={title} onChange={onTitleChange} options={titleOptions} modalTitle="Pick a Division/Assignment"
            inputStyle={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", textAlign: "center", padding: "3px 4px", color: COLORS.amber }} />
        </div>
      ) : (
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", color: COLORS.amber, marginBottom: 5, lineHeight: 1.3 }}>{title}</div>
      )}
      <PickerInput value={name} onChange={onNameChange} options={nameOptions} placeholder="Name" modalTitle="Pick a Unit"
        inputStyle={{ fontSize: 12.5, textAlign: "center", padding: "5px 6px" }} />
      {onAddChild && (
        <button onClick={onAddChild} title="Add sub-unit below this one" style={{ marginTop: 6, background: "none", border: `1px dashed ${COLORS.line}`, borderRadius: 4, color: COLORS.muted, cursor: "pointer", fontSize: 10, padding: "3px 7px", width: "100%" }}>
          + Add Below
        </button>
      )}
    </div>
  );
}

// Straight connector lines: a stem down from a parent, splitting into
// a horizontal bar that drops a stem into each child below it —
// the standard org-chart connector look.
function OrgConnectors({ children }) {
  if (!children || children.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
      <div style={{ width: 2, height: 14, background: COLORS.line }} />
      <div style={{ display: "flex", alignItems: "flex-start", position: "relative" }}>
        {children.length > 1 && (
          <div style={{ position: "absolute", top: 0, left: 84, right: 84, height: 2, background: COLORS.line }} />
        )}
        {children.map((child, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 10px" }}>
            <div style={{ width: 2, height: 14, background: COLORS.line }} />
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}

// Recursively renders one node and, if it has children, the connector
// + child nodes below it — this is what lets a Section Chief expand
// into Branches -> Divisions/Groups -> further sub-units arbitrarily
// deep, since each level is rendered by the same component calling
// itself on its own children.
function OrgTree({ node, onUpdate, onDelete, onAddChild, titleOptions, unitOptions }) {
  // Only a manually-added box (via "+ Add Below"/"+ Add Command
  // Staff" — see manuallyAdded, set at creation in
  // addSectionChild/addIncidentCommandChild/addCommandStaff) ever
  // gets a picker on either field at all. A box that mirrors
  // something on the Resource Board (an auto-synced division, or a
  // per-unit sub-box) already has both fields determined by the
  // board itself — offering a picker there would be redundant at
  // best, and at worst let someone quietly disconnect it from the
  // sync without realizing that's what editing either field does.
  const showPickers = !!node.manuallyAdded;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <OrgBox
        title={node.title} name={node.name} titleEditable
        titleOptions={showPickers ? titleOptions : undefined}
        nameOptions={showPickers ? unitOptions : undefined}
        onTitleChange={v => onUpdate(node.id, { title: v, autoName: false })}
        onNameChange={v => onUpdate(node.id, { name: v, autoName: false })}
        onDelete={() => onDelete(node.id)}
        onAddChild={() => onAddChild(node.id)}
      />
      {node.children && node.children.length > 0 && (
        <OrgConnectors>
          {node.children.map(child => (
            <OrgTree key={child.id} node={child} onUpdate={onUpdate} onDelete={onDelete} onAddChild={onAddChild} titleOptions={titleOptions} unitOptions={unitOptions} />
          ))}
        </OrgConnectors>
      )}
    </div>
  );
}

/* ============================================================
   TAB: MAPPING — Leaflet + OpenStreetMap (no API key/signup needed).
   Drawn shapes (fire perimeter, hazard zones, staging areas, points
   of interest) are stored as GeoJSON and synced like everything else
   in the app. Leaflet is controlled imperatively via refs (same
   pattern as the canvas-based org chart elsewhere in this file)
   rather than through a React wrapper library, since the map's own
   internal state (pan/zoom/drawn layers) doesn't need to live in
   React at all — only the saved GeoJSON does.
   ============================================================ */
// Shared between the initial load and the periodic sync poll below —
// reconstructs the right layer type for a saved Point feature: a real
// Circle (with its saved radius) if the feature has a radius
// property, a styled text label if it has a textLabel property,
// otherwise a plain marker. Both properties have to be added manually
// on save since GeoJSON's Point geometry alone can't carry them (see
// persist() inside TabMapping). makeLayerMovable is passed in from
// the component (it needs access to editingActiveRef/setIsMovingShape)
// and re-wires drag-to-move on every reconstructed layer, since that
// capability doesn't survive a save/reload cycle on its own.
// Recalculated fresh every time a perimeter polygon is saved (see
// persist() in TabMapping) rather than cached once at creation — a
// rigid move doesn't change a shape's area, but reshaping it via
// leaflet-draw's own vertex-edit mode does, and this keeps the
// displayed figure always accurate rather than stale.
function perimeterAcres(polygon) {
  return L.GeometryUtil.geodesicArea(polygon.getLatLngs()[0]) / SQ_METERS_PER_ACRE;
}
function bindOrUpdatePerimeterTooltip(layer, acres) {
  const label = `${acres.toFixed(1)} acres`;
  if (layer.getTooltip()) layer.setTooltipContent(label);
  else layer.bindTooltip(label, { permanent: true, direction: "center", className: "cb-perimeter-tooltip" });
}

function loadGeoJsonIntoGroup(featureGroup, geojson, makeLayerMovable, bindDivisionTooltip, getDivisionColor) {
  L.geoJSON(geojson, {
    pointToLayer: (feature, latlng) => {
      const props = feature.properties || {};
      if ("radius" in props) return L.circle(latlng, { radius: props.radius });
      if ("textLabel" in props) return L.marker(latlng, { icon: makeTextIcon(props.textLabel) });
      if (props.isDivisionMarker) return L.marker(latlng, { icon: makeDivisionMarkerIcon(props.divisionName, getDivisionColor(props.divisionName)) });
      return L.marker(latlng);
    },
  }).eachLayer(layer => {
    featureGroup.addLayer(layer);
    // Leaflet's own GeoJSON loader attaches the original feature
    // (including its properties) to layer.feature automatically —
    // used here to recognize a saved perimeter polygon and restore
    // both its acreage flag and its on-map label, neither of which
    // are runtime capabilities that survive a save/reload on their
    // own.
    const props = (layer.feature && layer.feature.properties) || {};
    if (props.isPerimeter) {
      layer.__isPerimeter = true;
      bindOrUpdatePerimeterTooltip(layer, perimeterAcres(layer));
    }
    if (props.isDivisionMarker) {
      // __divisionName (not just relying on layer.feature.properties)
      // is what persist() reads back out on save — toGeoJSON() only
      // serializes geometry by default, the same reason __textLabel
      // exists for text labels below.
      layer.__isDivisionMarker = true;
      layer.__divisionName = props.divisionName;
      bindDivisionTooltip(props.divisionName, layer);
    }
    makeLayerMovable(layer);
  });
}

// Layer-type-agnostic coordinate helpers for whole-shape dragging —
// a marker/circle has a single LatLng (getLatLng/setLatLng), while a
// polyline/polygon/rectangle has an array of them, possibly nested
// for multi-ring shapes (getLatLngs/setLatLngs). offsetLatLngs walks
// that structure recursively so the same translation logic works for
// every shape type without special-casing each one.
function getLayerLatLngs(layer) {
  return layer.getLatLngs ? layer.getLatLngs() : layer.getLatLng();
}
function setLayerLatLngs(layer, latlngs) {
  if (layer.setLatLngs) layer.setLatLngs(latlngs);
  else layer.setLatLng(latlngs);
}
function offsetLatLngs(latlngs, dLat, dLng) {
  if (Array.isArray(latlngs)) return latlngs.map(item => offsetLatLngs(item, dLat, dLng));
  return L.latLng(latlngs.lat + dLat, latlngs.lng + dLng);
}

function TabMapping({ mapData, setMapData, resources, assignmentPresets, resourceColumnOrder }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawnItemsRef = useRef(null);
  const persistRef = useRef(() => {});
  const gpsMarkerRef = useRef(null);
  const gpsAccuracyRef = useRef(null);
  const gpsWatchIdRef = useRef(null);
  const freehandStateRef = useRef(null); // { points, tempLine } while actively drawing
  const movingLayerRef = useRef(null); // { layer, startLatLng, originalLatLngs } while dragging an existing shape/label
  const editingActiveRef = useRef(false); // true while leaflet-draw's own edit/delete mode is active
  const latestMapDataRef = useRef(mapData); // mirrors the mapData prop for use inside the poll's setInterval closure
  const latestResourcesRef = useRef(resources); // same pattern, for looking up a division marker's current units at click time without needing to react to every resources change
  const latestAssignmentPresetsRef = useRef(assignmentPresets); // same pattern, used together with the two refs above/below so a marker's border color always reflects the CURRENT column order, not whatever existed when the map-sync effect's closures were first created
  const latestResourceColumnOrderRef = useRef(resourceColumnOrder);
  const lastSyncedMapDataRef = useRef(null); // JSON string of whatever drawnItems currently reflects
  const textPromptOpenRef = useRef(false); // mirrors textPrompt state, for the same reason as latestMapDataRef
  const perimeterPointsRef = useRef([]); // accumulated GPS fixes while tracing a perimeter
  const perimeterTempLineRef = useRef(null); // the live, growing (not yet closed) trace line
  const perimeterMarkerRef = useRef(null); // live position dot while tracing
  const perimeterWatchIdRef = useRef(null);
  const [tracking, setTracking] = useState(false);
  const [gpsCoords, setGpsCoords] = useState(null); // { lat, lng, accuracy } while tracking, null otherwise
  const [gpsCoordsCopied, setGpsCoordsCopied] = useState(false);
  const [gpsError, setGpsError] = useState("");
  const [activeTool, setActiveTool] = useState(null); // null | "text" | "freehand"
  const [textPrompt, setTextPrompt] = useState(null); // { latlng, value } while the text-label dialog is open
  const [isMovingShape, setIsMovingShape] = useState(false); // true while an existing shape/label is being dragged
  const [tracingPerimeter, setTracingPerimeter] = useState(false);
  const [perimeterMessage, setPerimeterMessage] = useState("");
  // { name, x, y } while a division card is being dragged from the
  // palette below toward the map; null otherwise.
  const [draggingDivision, setDraggingDivision] = useState(null);

  useEffect(() => { latestMapDataRef.current = mapData; }, [mapData]);
  useEffect(() => { latestResourcesRef.current = resources; }, [resources]);
  useEffect(() => { latestAssignmentPresetsRef.current = assignmentPresets; }, [assignmentPresets]);
  useEffect(() => { latestResourceColumnOrderRef.current = resourceColumnOrder; }, [resourceColumnOrder]);
  useEffect(() => { textPromptOpenRef.current = !!textPrompt; }, [textPrompt]);

  const startTracingPerimeter = () => {
    if (!navigator.geolocation) { setPerimeterMessage("This device/browser doesn't support GPS location."); return; }
    perimeterPointsRef.current = [];
    setPerimeterMessage("");
    let firstFix = true;
    perimeterWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
        const points = perimeterPointsRef.current;
        const last = points[points.length - 1];
        // Skips GPS jitter — only records a new vertex once the
        // device has actually moved a meaningful distance, so
        // standing still (or a noisy fix) doesn't add redundant
        // points that would distort the traced shape.
        if (!last || last.distanceTo(latlng) >= 3) {
          points.push(latlng);
          if (!perimeterTempLineRef.current) {
            perimeterTempLineRef.current = L.polyline(points, { color: "#C4341F", weight: 3, dashArray: "6 6" }).addTo(mapRef.current);
          } else {
            perimeterTempLineRef.current.setLatLngs(points);
          }
        }
        if (!perimeterMarkerRef.current) {
          perimeterMarkerRef.current = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 2, fillColor: "#C4341F", fillOpacity: 1 }).addTo(mapRef.current);
        } else {
          perimeterMarkerRef.current.setLatLng(latlng);
        }
        mapRef.current.panTo(latlng); // follow along while walking/driving the perimeter
        if (firstFix) { mapRef.current.setView(latlng, 17); firstFix = false; }
      },
      (err) => setPerimeterMessage(err.code === 1 ? "Location permission denied." : "Couldn't get GPS location."),
      { enableHighAccuracy: true, maximumAge: 2000 }
    );
    setTracingPerimeter(true);
  };

  const stopTracingPerimeter = () => {
    if (perimeterWatchIdRef.current != null) navigator.geolocation.clearWatch(perimeterWatchIdRef.current);
    perimeterWatchIdRef.current = null;
    if (perimeterTempLineRef.current) { mapRef.current.removeLayer(perimeterTempLineRef.current); perimeterTempLineRef.current = null; }
    if (perimeterMarkerRef.current) { mapRef.current.removeLayer(perimeterMarkerRef.current); perimeterMarkerRef.current = null; }
    setTracingPerimeter(false);

    const points = perimeterPointsRef.current;
    perimeterPointsRef.current = [];
    if (points.length < 3) {
      setPerimeterMessage("Not enough GPS points recorded to close a perimeter — try tracing a larger loop.");
      return;
    }
    // L.polygon automatically closes the shape back to its first
    // point — no need to duplicate it at the end.
    const polygon = L.polygon(points, { color: "#C4341F", weight: 3, fillOpacity: 0.15 });
    polygon.__isPerimeter = true; // read by persist() below to recalculate + save acreage
    bindOrUpdatePerimeterTooltip(polygon, perimeterAcres(polygon));
    drawnItemsRef.current.addLayer(polygon);
    makeLayerMovable(polygon);
    persistRef.current();
    setPerimeterMessage(`Perimeter traced: ${perimeterAcres(polygon).toFixed(1)} acres`);
  };

  // Wires up whole-shape drag-to-move on a layer. Built on the same
  // technique as the freehand tool below (a transparent overlay using
  // React's own pointer events) rather than the leaflet-path-drag
  // plugin an earlier version of this used — that plugin worked
  // reliably with a mouse but not on an iPhone, and since it's a
  // third-party library's own internal event handling, there was no
  // way to fix its touch behavior directly. This starts the same way
  // dragging always has to for something Leaflet already renders:
  // Leaflet's own per-layer "mousedown" event (reliable across mouse
  // and touch, since it's core Leaflet functionality, not a plugin)
  // detects which shape was grabbed and hands off to the overlay
  // below to track the rest of the gesture.
  const makeLayerMovable = (layer) => {
    layer.on("mousedown", (e) => {
      if (editingActiveRef.current) return; // don't fight leaflet-draw's own vertex-reshape mode
      // Operating on e.originalEvent (the real DOM event), not e
      // itself (Leaflet's wrapper object around it) — the wrapper
      // has no real preventDefault of its own, so stopping it doesn't
      // actually suppress the map's own pan handler starting at the
      // same time, which was exactly the bug: the shape moved AND the
      // whole map panned from the same press.
      L.DomEvent.stop(e.originalEvent);
      // Belt-and-suspenders alongside the line above, not a
      // replacement for it — explicitly disabling map dragging for
      // the duration of the move guarantees no simultaneous pan
      // regardless of any event-propagation subtlety, the same way
      // the freehand tool already disables it while sketching.
      if (mapRef.current) mapRef.current.dragging.disable();
      // startClientX/Y and moved (set as the pointer actually travels
      // in handleOverlayPointerMove below) are what let
      // handleOverlayPointerUp tell a real drag apart from a
      // stationary click — since the overlay that appears the moment
      // isMovingShape becomes true intercepts the eventual
      // pointerup/mouseup before it ever reaches the marker itself,
      // Leaflet's own click-event synthesis never gets a chance to
      // run on ANY draggable layer, not just division markers. See
      // the "if (!moved ...)" branch in handleOverlayPointerUp, which
      // manually fires the click Leaflet itself couldn't.
      movingLayerRef.current = { layer, startLatLng: e.latlng, originalLatLngs: getLayerLatLngs(layer), startClientX: e.originalEvent.clientX, startClientY: e.originalEvent.clientY, moved: false };
      setIsMovingShape(true);
    });
  };

  // Looks up the CURRENT units for a division fresh at click time,
  // rather than anything baked into the marker itself when it was
  // dropped — so the popup always reflects live Resource Board state
  // (reassignments, check-ins, releases) without this map needing to
  // watch and react to every resources change. Defined here at the
  // component-body level (not nested inside the mount-once map-setup
  // effect below) so it's usable both there and from the
  // drag-a-division-onto-the-map handler further down.
  const escHtmlMapping = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Binds a tooltip ONCE at marker creation (called from
  // loadGeoJsonIntoGroup's eachLayer loop and the drop handler below)
  // rather than a click handler — Leaflet's Tooltip automatically
  // shows/hides on the marker's own mouseover/mouseout once bound, no
  // manual event wiring needed the way the old click-driven popup
  // required. Content is refreshed on every mouseover rather than
  // fixed at bind time, since the unit list is live.
  const bindDivisionTooltip = (divisionName, layer) => {
    layer.bindTooltip("", { direction: "top", offset: [0, -14], opacity: 0.97 });
    layer.on("mouseover", () => {
      // columnFor (the same grouping the Resource Board itself uses),
      // not r.assignment directly — Staging and Rehab are status
      // values, not assignment values, so a plain assignment check
      // would never match a unit actually sitting in either of those.
      const units = (latestResourcesRef.current || []).filter(r => columnFor(r) === divisionName);
      const html = units.length === 0
        ? `<div style="font-size:12px;min-width:140px;"><b>${escHtmlMapping(divisionName)}</b><br/><span style="color:#8B939B;">No units currently assigned.</span></div>`
        : `<div style="font-size:12px;min-width:160px;"><b>${escHtmlMapping(divisionName)}</b><br/>${units.map(u => `${escHtmlMapping(u.label)}${u.task ? ` — ${escHtmlMapping(u.task)}` : ""}`).join("<br/>")}</div>`;
      layer.setTooltipContent(html);
    });
  };

  // Same color a division's palette card uses (assignmentColumnColor
  // cycles by position in the CURRENT list of active columns, the
  // same way the Resource Board itself colors things) — reads from
  // refs rather than closing directly over the resources/
  // refs rather than closing directly over the resources/
  // assignmentPresets/resourceColumnOrder props so this always
  // reflects live data even when called from a closure that was
  // itself only created once, like the sync poll's setInterval
  // callback inside the mount-once map-setup effect below.
  const getDivisionColor = (divisionName) => {
    const columns = deriveAssignmentColumns(latestResourcesRef.current || [], latestAssignmentPresetsRef.current, latestResourceColumnOrderRef.current);
    return assignmentColumnColor(divisionName, columns);
  };

  // Handles dragging a division card from the palette (rendered
  // below) onto the map. Uses window-level pointer listeners rather
  // than native HTML5 drag-and-drop — the same choice already made
  // for the whole-shape-move feature above, and for the same reason:
  // native HTML5 DnD has a history of behaving inconsistently across
  // touch devices in this app, while pointer events are normalized
  // consistently by the browser across mouse, touch, and pen.
  const startDivisionDrag = (name) => (e) => {
    e.preventDefault();
    setDraggingDivision({ name, x: e.clientX, y: e.clientY });
  };
  useEffect(() => {
    if (!draggingDivision) return;
    const divisionName = draggingDivision.name;
    const handleMove = (e) => setDraggingDivision(d => d ? { ...d, x: e.clientX, y: e.clientY } : d);
    const handleUp = (e) => {
      const rect = containerRef.current ? containerRef.current.getBoundingClientRect() : null;
      const overMap = rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (overMap && mapRef.current && drawnItemsRef.current) {
        const latlng = mapRef.current.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top));
        const marker = L.marker(latlng, { icon: makeDivisionMarkerIcon(divisionName, getDivisionColor(divisionName)) });
        marker.__isDivisionMarker = true;
        marker.__divisionName = divisionName;
        bindDivisionTooltip(divisionName, marker);
        drawnItemsRef.current.addLayer(marker);
        makeLayerMovable(marker);
        persistRef.current();
      }
      setDraggingDivision(null);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    // Deliberately keyed on just the name, not the whole
    // draggingDivision object — handleMove updates x/y on every
    // pointer move, and depending on the full object would re-run
    // this effect (tearing down and re-attaching both window
    // listeners) on every single one of those moves instead of just
    // once per drag. handleUp never needs the live x/y from state
    // anyway, since it reads clientX/clientY directly off the pointer
    // event that ended the drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingDivision?.name]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { center: [33.2635, -97.2286], zoom: 13 });
    mapRef.current = map;

    const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    // Esri World Imagery — free, no API key, no account required for
    // reasonable-volume use like a single department's internal tool.
    const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri",
      maxZoom: 19,
    });
    L.control.layers({ "Street (OpenStreetMap)": streets, "Satellite (Esri)": satellite }, null, { position: "topright" }).addTo(map);

    // The FeatureGroup leaflet-draw edits/deletes shapes within, and
    // where previously-saved shapes get loaded back in on mount.
    const drawnItems = new L.FeatureGroup();
    drawnItemsRef.current = drawnItems;
    map.addLayer(drawnItems);

    // Defined before the initial load below, since loading saved
    // shapes back in also needs to wire up drag-to-move on each one,
    // which re-saves via this same function.
    //
    // Rebuilt per-layer rather than pairing up two separate calls to
    // toGeoJSON() and eachLayer() by array index — that pairing
    // assumed both would iterate drawnItems in the exact same order,
    // which isn't guaranteed by Leaflet and could silently attach a
    // radius to the wrong feature, or throw and abort the save
    // entirely for that edit if the counts ever mismatched. Calling
    // toGeoJSON() on each layer individually and patching its own
    // result removes that assumption completely.
    const persist = () => {
      const features = [];
      drawnItems.eachLayer(layer => {
        if (layer.__isPerimeter) {
          // Recalculated fresh every save rather than reusing a value
          // cached at creation — a rigid move doesn't change area,
          // but reshaping via leaflet-draw's own vertex-edit mode
          // does, so this keeps both the stored figure and the
          // on-map label always accurate.
          const acres = perimeterAcres(layer);
          bindOrUpdatePerimeterTooltip(layer, acres);
          const feature = layer.toGeoJSON();
          feature.properties = { ...feature.properties, isPerimeter: true, perimeterAcres: acres };
          features.push(feature);
          return;
        }
        const feature = layer.toGeoJSON();
        if (layer instanceof L.Circle) feature.properties = { ...feature.properties, radius: layer.getRadius() };
        if (layer.__textLabel) feature.properties = { ...feature.properties, textLabel: layer.__textLabel };
        if (layer.__isDivisionMarker) feature.properties = { ...feature.properties, isDivisionMarker: true, divisionName: layer.__divisionName };
        features.push(feature);
      });
      const newData = { type: "FeatureCollection", features };
      // This IS the latest known state — recording it here means the
      // sync poll won't mistake the echo of our own save for an
      // incoming remote change and needlessly reload what we just
      // drew.
      lastSyncedMapDataRef.current = JSON.stringify(newData);
      setMapData(newData);
    };
    persistRef.current = persist;

    if (mapData && mapData.features && mapData.features.length > 0) {
      loadGeoJsonIntoGroup(drawnItems, mapData, makeLayerMovable, bindDivisionTooltip, getDivisionColor);
    }
    lastSyncedMapDataRef.current = JSON.stringify(mapData);

    const drawControl = new L.Control.Draw({
      position: "topleft",
      draw: {
        polygon: { shapeOptions: { color: "#C4341F" } }, // fire perimeter / hazard zones
        polyline: { shapeOptions: { color: "#3B6FA6" } }, // hose lays, access routes
        rectangle: { shapeOptions: { color: "#D9A02B" } },
        circle: { shapeOptions: { color: "#D9A02B" } }, // hazard radius
        marker: true,
        circlemarker: false,
      },
      edit: { featureGroup: drawnItems },
    });
    map.addControl(drawControl);

    // While leaflet-draw's own edit or delete mode is active,
    // makeLayerMovable's own "mousedown" handler already declines to
    // start a move (see editingActiveRef check above) — this just
    // tracks that flag and also pauses the sync poll further below
    // for the same underlying reason: don't fight an in-progress edit.
    map.on(L.Draw.Event.EDITSTART, () => { editingActiveRef.current = true; });
    map.on(L.Draw.Event.EDITSTOP, () => { editingActiveRef.current = false; });
    map.on(L.Draw.Event.DELETESTART, () => { editingActiveRef.current = true; });
    map.on(L.Draw.Event.DELETESTOP, () => { editingActiveRef.current = false; });
    map.on(L.Draw.Event.CREATED, (e) => { drawnItems.addLayer(e.layer); makeLayerMovable(e.layer); persist(); });
    map.on(L.Draw.Event.EDITED, persist);
    map.on(L.Draw.Event.DELETED, persist);

    // Fixes Leaflet's canvas sizing when the map mounts inside a tab
    // that wasn't visible (zero width/height) at the moment of init.
    // The bounds-fit below has to happen after this, not before —
    // fitBounds relies on the map's actual known pixel size, which
    // isn't correct yet until invalidateSize runs.
    setTimeout(() => {
      map.invalidateSize();
      // Jump straight to wherever the existing annotations are,
      // rather than always opening on the fixed default location —
      // getBounds() on the FeatureGroup handles markers, circles,
      // polygons, and lines uniformly. maxZoom keeps a single lone
      // marker from zooming in unreasonably far, since a single
      // point has no inherent "bounds" to fit.
      if (drawnItems.getLayers().length > 0) {
        map.fitBounds(drawnItems.getBounds(), { padding: [40, 40], maxZoom: 16 });
      }
    }, 100);

    // Picks up other devices' edits without needing to leave and
    // re-enter this tab. Checked every 5 seconds rather than reacting
    // live to every mapData prop change, specifically so a change
    // doesn't get applied mid-gesture — the guards below skip a tick
    // entirely (trying again on the next one) rather than risk
    // pulling a shape out from under an in-progress freehand stroke,
    // an open text-label prompt, a shape currently being dragged, or
    // leaflet-draw's own edit/delete mode. Comparing against
    // lastSyncedMapDataRef (rather than just "did the prop change")
    // also means this device's own edits, which already recorded
    // themselves there in persist() above, don't trigger a pointless
    // reload of what it just drew itself.
    const syncInterval = setInterval(() => {
      if (freehandStateRef.current || textPromptOpenRef.current || editingActiveRef.current || movingLayerRef.current || perimeterWatchIdRef.current != null) return;
      const incomingJson = JSON.stringify(latestMapDataRef.current);
      if (incomingJson === lastSyncedMapDataRef.current) return;
      drawnItems.clearLayers();
      if (latestMapDataRef.current && latestMapDataRef.current.features && latestMapDataRef.current.features.length > 0) {
        loadGeoJsonIntoGroup(drawnItems, latestMapDataRef.current, makeLayerMovable, bindDivisionTooltip, getDivisionColor);
      }
      lastSyncedMapDataRef.current = incomingJson;
    }, 5000);

    return () => {
      clearInterval(syncInterval);
      if (gpsWatchIdRef.current != null) navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      if (perimeterWatchIdRef.current != null) navigator.geolocation.clearWatch(perimeterWatchIdRef.current);
      map.remove();
      mapRef.current = null;
    };
    // Intentionally mount-once for the map/layers/controls themselves
    // — mapData is only read here as the initial state. Updates from
    // other devices while this tab stays open are now handled by the
    // 5-second sync poll above instead, which is deliberately
    // separate from this effect's dependencies so it can apply its
    // own guards (skip a tick rather than fight an in-progress local
    // edit) instead of naively reloading on every prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text-label, freehand, and whole-shape-move all funnel through
  // this one transparent overlay placed on top of the map — rendered
  // below, only while one of the three is active — using React's own
  // pointer event props rather than Leaflet's event system or raw DOM
  // listeners attached to the map's own container.
  //
  // Two earlier versions of text/freehand placement tried both of
  // those other approaches and each behaved inconsistently across
  // devices in a way that didn't point to a single clean cause (one
  // browser's tap/click synthesis working, another's not) — the
  // common thread was competing with Leaflet's own extensive internal
  // event handling on that same container element. A separate overlay
  // sidesteps that completely: it's a different DOM element Leaflet
  // never sees, so there's nothing for these interactions to conflict
  // with, and React's pointer event system is normalized consistently
  // across mouse, touch, and pen input by the browser itself. The
  // whole-shape-move feature below reuses the same overlay for
  // exactly this reason, after a version built on a third-party drag
  // plugin turned out reliable with a mouse but not on an iPhone —
  // a library's own internal event handling isn't something that can
  // be fixed from the outside, so this replaces it entirely with the
  // same technique already proven here.
  const overlayToLatLng = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    return mapRef.current.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top));
  };

  // Text placement uses a plain native onClick — deliberately NOT a
  // hand-rolled tap-vs-drag distance/time check. A browser's own
  // click event already only fires when there's no significant
  // movement between press and release; that's true for any ordinary
  // DOM element and has nothing to do with Leaflet, since this
  // overlay is a plain div Leaflet doesn't know exists.
  const handleOverlayClick = (e) => {
    if (activeTool !== "text") return;
    try {
      setTextPrompt({ latlng: overlayToLatLng(e), value: "" });
    } catch (err) {
      // Surfaces a concrete error in the console rather than failing
      // silently, in case something environment-specific ever breaks
      // the coordinate conversion again.
      console.error("Text label placement failed:", err);
    }
  };

  // Freehand and whole-shape-move both need real pointer tracking,
  // since each has to follow the drag continuously rather than just
  // detect its end.
  const handleOverlayPointerDown = (e) => {
    if (activeTool !== "freehand") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = overlayToLatLng(e);
    const tempLine = L.polyline([start], { color: "#2E8B72", weight: 3 }).addTo(mapRef.current);
    freehandStateRef.current = { points: [start], tempLine };
  };
  const handleOverlayPointerMove = (e) => {
    if (movingLayerRef.current) {
      const current = overlayToLatLng(e);
      const dLat = current.lat - movingLayerRef.current.startLatLng.lat;
      const dLng = current.lng - movingLayerRef.current.startLatLng.lng;
      setLayerLatLngs(movingLayerRef.current.layer, offsetLatLngs(movingLayerRef.current.originalLatLngs, dLat, dLng));
      // A real device's pointer virtually never sits at the exact
      // same pixel between press and release, so a small threshold
      // (not "moved at all") is what still recognizes an intentional
      // stationary tap as a tap rather than a drag.
      const dx = e.clientX - movingLayerRef.current.startClientX;
      const dy = e.clientY - movingLayerRef.current.startClientY;
      if (Math.hypot(dx, dy) > 6) movingLayerRef.current.moved = true;
      return;
    }
    if (activeTool === "freehand" && freehandStateRef.current) {
      const pt = overlayToLatLng(e);
      freehandStateRef.current.points.push(pt);
      freehandStateRef.current.tempLine.setLatLngs(freehandStateRef.current.points);
    }
  };
  const handleOverlayPointerUp = () => {
    if (movingLayerRef.current) {
      const { layer, moved } = movingLayerRef.current;
      movingLayerRef.current = null;
      if (mapRef.current) mapRef.current.dragging.enable();
      setIsMovingShape(false);
      if (moved) {
        persistRef.current();
      } else {
        // Never actually dragged — this overlay swallowing the
        // release is exactly what prevented Leaflet's own click
        // event from ever reaching the marker, so fire it manually
        // instead. Harmless for shape types with no click listener of
        // their own (fire() on a layer with no matching handler is a
        // no-op); currently only division markers register one.
        layer.fire("click");
      }
      return;
    }
    if (activeTool === "freehand" && freehandStateRef.current) {
      const state = freehandStateRef.current;
      mapRef.current.removeLayer(state.tempLine);
      if (state.points.length > 1) {
        // If the sketch ends back near where it started, treat it as
        // a deliberately closed perimeter (same as GPS tracing) and
        // calculate its acreage; otherwise keep it as an open line,
        // since freehand is also used for open sketches like hose
        // lays or access routes that were never meant to enclose an
        // area. The threshold scales with the sketch's own size
        // (15%, with a 15m floor) rather than a fixed distance, so it
        // works sensibly whether the sketch is small or spans a large
        // area.
        const first = state.points[0], last = state.points[state.points.length - 1];
        const boundsOfSketch = L.latLngBounds(state.points);
        const diagonal = boundsOfSketch.getNorthEast().distanceTo(boundsOfSketch.getSouthWest());
        const closureThreshold = Math.max(15, diagonal * 0.15);
        const isClosedLoop = state.points.length >= 3 && first.distanceTo(last) <= closureThreshold;

        let finalLayer;
        if (isClosedLoop) {
          finalLayer = L.polygon(state.points, { color: "#C4341F", weight: 3, fillOpacity: 0.15 });
          finalLayer.__isPerimeter = true;
          bindOrUpdatePerimeterTooltip(finalLayer, perimeterAcres(finalLayer));
        } else {
          finalLayer = L.polyline(state.points, { color: "#2E8B72", weight: 3 });
        }
        drawnItemsRef.current.addLayer(finalLayer);
        makeLayerMovable(finalLayer);
        persistRef.current();
      }
      freehandStateRef.current = null;
    }
  };

  const confirmTextLabel = () => {
    const text = textPrompt.value.trim();
    setTextPrompt(null);
    if (!text || !mapRef.current) return;
    const marker = L.marker(textPrompt.latlng, { icon: makeTextIcon(text) });
    marker.__textLabel = text; // read by persist() above to save it back out
    drawnItemsRef.current.addLayer(marker);
    makeLayerMovable(marker);
    persistRef.current();
  };

  const toggleTracking = () => {
    if (tracking) {
      if (gpsWatchIdRef.current != null) navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      gpsWatchIdRef.current = null;
      if (gpsMarkerRef.current) { mapRef.current.removeLayer(gpsMarkerRef.current); gpsMarkerRef.current = null; }
      if (gpsAccuracyRef.current) { mapRef.current.removeLayer(gpsAccuracyRef.current); gpsAccuracyRef.current = null; }
      setTracking(false);
      setGpsCoords(null);
      return;
    }
    if (!navigator.geolocation) { setGpsError("This device/browser doesn't support GPS location."); return; }
    setGpsError("");
    let firstFix = true;
    gpsWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const latlng = [latitude, longitude];
        setGpsCoords({ lat: latitude, lng: longitude, accuracy });
        if (!gpsMarkerRef.current) {
          gpsMarkerRef.current = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 2, fillColor: "#3B6FA6", fillOpacity: 1 }).addTo(mapRef.current);
          gpsAccuracyRef.current = L.circle(latlng, { radius: accuracy, color: "#3B6FA6", weight: 1, fillOpacity: 0.1 }).addTo(mapRef.current);
        } else {
          gpsMarkerRef.current.setLatLng(latlng);
          gpsAccuracyRef.current.setLatLng(latlng);
          gpsAccuracyRef.current.setRadius(accuracy);
        }
        if (firstFix) { mapRef.current.setView(latlng, 18); firstFix = false; }
      },
      (err) => setGpsError(err.code === 1 ? "Location permission denied." : "Couldn't get GPS location."),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
    setTracking(true);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Mapping" icon={MapIcon} right={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn kind={activeTool === "text" ? "solid" : "subtle"} onClick={() => setActiveTool(t => t === "text" ? null : "text")} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {activeTool === "text" ? "Tap Map to Place Text" : "Add Text Label"}
          </Btn>
          <Btn kind={activeTool === "freehand" ? "solid" : "subtle"} onClick={() => setActiveTool(t => t === "freehand" ? null : "freehand")} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {activeTool === "freehand" ? "Drawing… (tap to stop)" : "Freehand Draw"}
          </Btn>
          <Btn kind={tracking ? "solid" : "subtle"} icon={Crosshair} onClick={toggleTracking} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {tracking ? "Stop Location" : "Show My Location"}
          </Btn>
          <Btn kind={tracingPerimeter ? "solid" : "subtle"} icon={Crosshair} onClick={tracingPerimeter ? stopTracingPerimeter : startTracingPerimeter} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {tracingPerimeter ? "Stop Tracing Perimeter" : "Trace GPS Perimeter"}
          </Btn>
        </div>
      }>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Use the shape tools (top-left) to mark the fire perimeter, hazard zones, staging areas, or points of interest, or use <strong>Add Text Label</strong> / <strong>Freehand Draw</strong> above to type a note or sketch with a finger or Apple Pencil — draw a closed loop and it's treated as a perimeter with its acreage calculated automatically, same as GPS tracing below. Drag any shape or label to reposition it — all saved automatically and shared across the board. Use <strong>Trace GPS Perimeter</strong> and walk or drive the fire's boundary — stopping the trace closes it into a shape and calculates the enclosed acreage, shown on the map and included in Print/Export. While Text Label or Freehand Draw is armed, the map itself won't pan (tap the button again to release it). Switch between street and satellite view from the layer control (top-right).
          {gpsError && <span style={{ color: COLORS.dangerText, display: "block", marginTop: 4 }}>{gpsError}</span>}
          {perimeterMessage && <span style={{ color: COLORS.amber, display: "block", marginTop: 4 }}>{perimeterMessage}</span>}
        </div>
        {(() => {
          // Staging and Rehab are real physical locations worth
          // marking on a map, unlike Out of Service or Released,
          // which are unit-status designations rather than places —
          // so only those two get excluded here, not every
          // STATUS_FLOW column.
          const activeDivisions = deriveAssignmentColumns(resources, assignmentPresets, resourceColumnOrder).filter(col => col !== "Out of Service" && col !== "Released");
          if (activeDivisions.length === 0) return null;
          return (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10.5, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                Drag a division onto the map to mark where it's operating
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {activeDivisions.map(name => {
                  const count = resources.filter(r => columnFor(r) === name).length;
                  const color = assignmentColumnColor(name, activeDivisions);
                  return (
                    <div key={name} onPointerDown={startDivisionDrag(name)}
                      style={{ background: COLORS.panel2, border: `1.5px solid ${color}`, borderRadius: 5, padding: "5px 10px", fontFamily: "'Oswald', sans-serif", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.03em", cursor: "grab", touchAction: "none", userSelect: "none" }}>
                      {name} <span style={{ color: COLORS.muted, fontFamily: "'IBM Plex Sans', sans-serif", textTransform: "none", letterSpacing: 0 }}>({count})</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
        <div style={{ position: "relative" }}>
          <div ref={containerRef} style={{ width: "100%", height: "65vh", minHeight: 420, borderRadius: 6, border: `1px solid ${COLORS.line}` }} />
          {tracking && gpsCoords && (
            <div
              onClick={async () => {
                const text = `${gpsCoords.lat.toFixed(5)}, ${gpsCoords.lng.toFixed(5)}`;
                try {
                  await navigator.clipboard.writeText(text);
                  setGpsCoordsCopied(true);
                  setTimeout(() => setGpsCoordsCopied(false), 1500);
                } catch { /* clipboard unavailable — the coordinates are still visible to read/copy manually */ }
              }}
              title="Tap to copy"
              style={{
                position: "absolute", left: 10, bottom: 10, zIndex: 900,
                background: "rgba(20,23,26,0.9)", color: "#EDEFF1", border: `1px solid ${COLORS.line}`,
                borderRadius: 6, padding: "6px 10px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
                cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 8,
              }}
            >
              {gpsCoordsCopied ? "Copied!" : `${gpsCoords.lat.toFixed(5)}, ${gpsCoords.lng.toFixed(5)}`}
              {!gpsCoordsCopied && <span style={{ color: COLORS.muted, fontSize: 10.5 }}>±{Math.round(gpsCoords.accuracy)}m</span>}
            </div>
          )}
          {(activeTool === "text" || activeTool === "freehand" || isMovingShape) && (
            <div
              onClick={handleOverlayClick}
              onPointerDown={handleOverlayPointerDown}
              onPointerMove={handleOverlayPointerMove}
              onPointerUp={handleOverlayPointerUp}
              onPointerCancel={handleOverlayPointerUp}
              style={{
                position: "absolute", inset: 0,
                cursor: isMovingShape ? "grabbing" : "crosshair",
                touchAction: "none", zIndex: 1000,
                border: activeTool ? `2px solid ${COLORS.amber}` : "none",
                boxSizing: "border-box",
              }}
            />
          )}
        </div>
      </Panel>

      {textPrompt && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 2000 }}>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Text Label</span>
              <button onClick={() => setTextPrompt(null)} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
            </div>
            <TextInput autoFocus value={textPrompt.value} onChange={e => setTextPrompt({ ...textPrompt, value: e.target.value })}
              placeholder="e.g. Staging Area, Command Post..." style={{ width: "100%" }}
              onKeyDown={e => { if (e.key === "Enter") confirmTextLabel(); if (e.key === "Escape") setTextPrompt(null); }} />
            <Btn kind="solid" onClick={confirmTextLabel} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>Place on Map</Btn>
          </div>
        </div>
      )}

      {draggingDivision && (
        <div style={{
          position: "fixed", left: draggingDivision.x, top: draggingDivision.y, transform: "translate(-50%, -50%)",
          pointerEvents: "none", zIndex: 3000,
          background: COLORS.panel2, border: `2px solid ${COLORS.amber}`, borderRadius: 6, padding: "6px 12px",
          fontFamily: "'Oswald', sans-serif", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.04em",
          boxShadow: "0 3px 10px rgba(0,0,0,0.5)",
        }}>
          {draggingDivision.name}
        </div>
      )}
    </div>
  );
}

// Standard WMO weather interpretation codes (used by Open-Meteo and
// most other weather APIs) mapped to plain-language descriptions.
const WMO_WEATHER_DESCRIPTIONS = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};
const weatherCodeDescription = (code) => WMO_WEATHER_DESCRIPTIONS[code] || "Unknown";

// NWS Rothfusz regression — the standard heat index formula used by
// the National Weather Service, verified against both a documented
// worked example (96°F/65% RH -> ~121°F) and the published NWS heat
// index chart before use here, given how directly this figure feeds
// into rehab/heat-illness decisions. Below 80°F heat index isn't a
// standard/meaningful concept (no heat-stress concern at that point),
// so callers should only display it above that threshold.
function calculateHeatIndex(tempF, rh) {
  let hi = 0.5 * (tempF + 61.0 + ((tempF - 68.0) * 1.2) + (rh * 0.094));
  if ((hi + tempF) / 2 < 80) return hi;

  hi = -42.379 + 2.04901523 * tempF + 10.14333127 * rh - 0.22475541 * tempF * rh
    - 0.00683783 * tempF * tempF - 0.05481717 * rh * rh + 0.00122874 * tempF * tempF * rh
    + 0.00085282 * tempF * rh * rh - 0.00000199 * tempF * tempF * rh * rh;

  if (rh < 13 && tempF >= 80 && tempF <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tempF - 95)) / 17);
  } else if (rh > 85 && tempF >= 80 && tempF <= 87) {
    hi += ((rh - 85) / 10) * ((87 - tempF) / 5);
  }
  return hi;
}

// NWS's four official heat-index danger categories and their chart colors.
function heatIndexCategory(hi) {
  if (hi >= 125) return { label: "Extreme Danger", color: "#7A1F1F" };
  if (hi >= 103) return { label: "Danger", color: "#C4341F" };
  if (hi >= 90) return { label: "Extreme Caution", color: "#D9A02B" };
  return { label: "Caution", color: "#E8D26B" };
}

const HEAT_INDEX_MATRIX_TEMPS = [80, 85, 90, 95, 100, 105, 110];
const HEAT_INDEX_MATRIX_RH = [40, 50, 60, 70, 80, 90, 100];

function HeatIndexMatrix({ currentTemp, currentRh, exactHeatIndex }) {
  // Inserts the actual current temperature and humidity as their own
  // row/column (rounded to whole numbers) rather than snapping to the
  // nearest standard chart increment — heat index is sensitive enough
  // to small changes in either input that "nearest gridline" could
  // show a visibly different number than the exact calculation used
  // for the Heat Index figure above, which was confusing since they
  // looked like they disagreed. This way the highlighted cell always
  // shows the exact same number, not an approximation of it.
  const highlightTemp = currentTemp != null ? Math.round(currentTemp) : null;
  const highlightRh = currentRh != null ? Math.round(currentRh) : null;
  const temps = Array.from(new Set([...HEAT_INDEX_MATRIX_TEMPS, ...(highlightTemp != null ? [highlightTemp] : [])])).sort((a, b) => a - b);
  const rhs = Array.from(new Set([...HEAT_INDEX_MATRIX_RH, ...(highlightRh != null ? [highlightRh] : [])])).sort((a, b) => a - b);

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
        <thead>
          <tr>
            <th style={{ padding: "4px 8px", textAlign: "right", color: COLORS.muted, fontWeight: 600 }}>Temp \ RH</th>
            {rhs.map(rh => (
              <th key={rh} style={{
                padding: "4px 8px", textAlign: "center", color: COLORS.muted, fontWeight: 600,
                background: rh === highlightRh ? COLORS.panel2 : "transparent",
              }}>{rh}%</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {temps.map(temp => (
            <tr key={temp}>
              <td style={{
                padding: "4px 8px", textAlign: "right", fontWeight: 600, color: COLORS.text,
                background: temp === highlightTemp ? COLORS.panel2 : "transparent",
              }}>{temp}°F</td>
              {rhs.map(rh => {
                const isHighlighted = temp === highlightTemp && rh === highlightRh;
                // The highlighted cell reuses the exact already-computed
                // Heat Index figure shown above rather than recalculating
                // from rounded whole-number inputs — guarantees the two
                // can never disagree, even by a single degree at a
                // rounding boundary, rather than merely being very close.
                const hi = isHighlighted && exactHeatIndex != null ? exactHeatIndex : calculateHeatIndex(temp, rh);
                const cat = heatIndexCategory(hi);
                return (
                  <td key={rh} style={{
                    padding: "4px 8px", textAlign: "center", background: cat.color, color: "#191C1F",
                    fontWeight: isHighlighted ? 800 : 400,
                    outline: isHighlighted ? `2px solid ${COLORS.text}` : "none",
                    outlineOffset: -2,
                  }}>{Math.round(hi)}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8, fontSize: 11 }}>
        {[{ label: "Caution", color: "#E8D26B" }, { label: "Extreme Caution", color: "#D9A02B" }, { label: "Danger", color: "#C4341F" }, { label: "Extreme Danger", color: "#7A1F1F" }].map(c => (
          <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 12, height: 12, background: c.color, display: "inline-block", borderRadius: 2 }} />
            <span style={{ color: COLORS.muted }}>{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Nominatim only returns a state's full name (e.g. "Texas"), never an
// abbreviation, so this converts it for the more compact "City, ST"
// display convention most weather displays use.
const US_STATE_ABBREVIATIONS = {
  "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA",
  "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE", "Florida": "FL", "Georgia": "GA",
  "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
  "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
  "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
  "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH",
  "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT",
  "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
  "District of Columbia": "DC",
};

function TabWeather() {
  const [coords, setCoords] = useState(null); // { lat, lng }
  const [locationName, setLocationName] = useState(""); // e.g. "Denton, TX", from reverse geocoding
  const [locError, setLocError] = useState("");
  const [current, setCurrent] = useState(null);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [currentError, setCurrentError] = useState("");

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const gpsMarkerRef = useRef(null);
  const radarLayersRef = useRef({}); // frame path -> L.TileLayer, kept loaded even when not the active frame
  const radarIndexRef = useRef(0); // mirrors radarIndex for use inside the async sequential-load callback below
  const [radarFrames, setRadarFrames] = useState([]); // [{ time, path }, ...] past + nowcast
  const [radarHost, setRadarHost] = useState("");
  const [radarIndex, setRadarIndex] = useState(0);
  useEffect(() => { radarIndexRef.current = radarIndex; }, [radarIndex]);
  const [radarPlaying, setRadarPlaying] = useState(false);
  const [radarError, setRadarError] = useState("");
  // Tracks whether the map instance actually exists yet — mapRef is a
  // ref precisely so mutating it doesn't trigger re-renders, but that
  // also means nothing re-runs the radar pre-load effect once the map
  // becomes available if the radar metadata happened to finish
  // fetching first (a real race: metadata is a plain JSON fetch,
  // often faster than GPS resolving). This flag exists purely so that
  // effect has something to depend on that changes at the right
  // moment.
  const [mapReady, setMapReady] = useState(false);
  const radarTimerRef = useRef(null);

  const fetchCurrentConditions = (lat, lng) => {
    setCurrentLoading(true);
    setCurrentError("");
    // Open-Meteo — free, no API key or account required, same
    // service already used for the Tactical Worksheet's weather
    // auto-fill.
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph`)
      .then(res => { if (!res.ok) throw new Error("bad response"); return res.json(); })
      .then(data => { setCurrent(data.current); setCurrentLoading(false); })
      .catch(() => { setCurrentError("Couldn't load current conditions. Check your connection and try Refresh."); setCurrentLoading(false); });
  };

  const fetchLocationName = (lat, lng) => {
    // Nominatim (OpenStreetMap's own geocoder) — free, no API key or
    // account required, matching the tile source already used for
    // the base map. Their usage policy requires a way to identify the
    // requesting application via either a custom User-Agent (which
    // browser JS isn't allowed to set) or a valid Referer header,
    // which browsers already send automatically on a request like
    // this from a real deployed page.
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`)
      .then(res => { if (!res.ok) throw new Error("bad response"); return res.json(); })
      .then(data => {
        const a = data.address || {};
        const place = a.city || a.town || a.village || a.hamlet || a.county;
        const state = a.state ? (US_STATE_ABBREVIATIONS[a.state] || a.state) : "";
        setLocationName([place, state].filter(Boolean).join(", "));
      })
      .catch(() => setLocationName("")); // silently omit rather than showing an error for a non-essential label
  };

  const fetchRadarFrames = () => {
    setRadarError("");
    // RainViewer — free, no API key or account required, for
    // publicly-shared radar mosaic tiles compatible with Leaflet the
    // same way the street/satellite base layers already are.
    fetch("https://api.rainviewer.com/public/weather-maps.json")
      .then(res => { if (!res.ok) throw new Error("bad response: " + res.status); return res.json(); })
      .then(data => {
        // Trimmed to the most recent frames rather than every one
        // RainViewer provides (which can be 13+ past frames alone) —
        // fewer total frames means fewer tile layers ever need
        // loading at all, which matters most on mobile Safari's
        // tighter concurrent-request and memory limits.
        const past = (data.radar.past || []).slice(-6);
        const nowcast = (data.radar.nowcast || []).slice(0, 2);
        const frames = [...past, ...nowcast];
        setRadarFrames(frames);
        setRadarHost(data.host);
        setRadarIndex(Math.max(0, past.length - 1)); // start on the most recent actual (non-forecast) frame
      })
      .catch(() => setRadarError("Couldn't load radar data. Check your connection and try Refresh."));
  };

  useEffect(() => {
    if (!navigator.geolocation) { setLocError("This device/browser doesn't support GPS location."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setCoords({ lat: latitude, lng: longitude });
        fetchCurrentConditions(latitude, longitude);
        fetchLocationName(latitude, longitude);
      },
      (err) => setLocError(err.code === 1 ? "Location permission denied." : "Couldn't get GPS location."),
      { enableHighAccuracy: false, maximumAge: 300000 }
    );
    fetchRadarFrames();
    // Keeps the radar genuinely "live" while this tab stays open —
    // RainViewer publishes a new frame roughly every 10 minutes.
    const interval = setInterval(fetchRadarFrames, 5 * 60 * 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mounts the radar map once GPS location is known — mirrors the
  // Mapping tab's own mount-once pattern.
  useEffect(() => {
    if (!coords || !containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: [coords.lat, coords.lng], zoom: 8 });
    mapRef.current = map;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    gpsMarkerRef.current = L.marker([coords.lat, coords.lng]).addTo(map).bindPopup("Your location");
    setTimeout(() => map.invalidateSize(), 100);
    setMapReady(true);
    // Starts animating automatically once the map is centered on the
    // user's location, rather than requiring a manual tap on Animate
    // — the animation loop already handles radarFrames still being
    // empty at this point gracefully, so it just starts moving the
    // moment frames actually finish loading.
    setRadarPlaying(true);
    return () => { map.remove(); mapRef.current = null; radarLayersRef.current = {}; setMapReady(false); };
  }, [coords]);

  // Pre-creates a tile layer for every available frame so frame
  // switching can later become a pure opacity toggle rather than
  // destroying and recreating a layer from scratch on every tick —
  // that recreate-every-tick approach was what originally caused the
  // choppy animation and missing tiles on PC (a larger browser window
  // needs far more tiles to cover the visible map than a phone screen
  // does, and some of those requests simply hadn't finished before
  // the next frame swapped them out).
  //
  // Loaded ONE FRAME AT A TIME (waiting for each layer's "load" event
  // before starting the next) rather than adding every layer
  // simultaneously — an earlier version of this fix did load them all
  // at once, which fixed PC but broke iOS entirely: mobile Safari has
  // much tighter limits on simultaneous connections and image memory
  // than a desktop browser, and a burst of 8+ full tile layers all
  // requesting at the same instant silently exceeded that ceiling.
  // Sequential loading keeps the peak concurrent request count to
  // whatever one frame needs, matching what already worked reliably
  // before, while still arriving at every frame being cached for
  // smooth animation once loading finishes.
  useEffect(() => {
    if (!mapRef.current || !radarFrames.length || !radarHost) return;
    let cancelled = false;

    // Guards against a real timing risk: if radar metadata finishes
    // fetching before the map has resolved its true on-screen size
    // (the fix for that runs on a short delay after map creation),
    // Leaflet would compute entirely wrong tile coordinates for
    // whatever size it mistakenly still thinks it is.
    mapRef.current.invalidateSize();

    // Cached by each frame's own path, not its array position. A
    // frame's position shifts forward every refresh (RainViewer's
    // whole "past" window moves in time), so "index 0" after a
    // refresh is a genuinely different radar image than "index 0"
    // before it — caching by position meant a refresh never actually
    // replaced anything, leaving old tile layers (and their
    // "tileerror" listeners) attached to the map indefinitely. Their
    // image URLs eventually age out and start failing, which is
    // exactly the runaway tile-error count that showed up on screen.
    const currentPaths = new Set(radarFrames.map(f => f.path));
    Object.keys(radarLayersRef.current).forEach(path => {
      if (!currentPaths.has(path)) {
        mapRef.current.removeLayer(radarLayersRef.current[path]);
        delete radarLayersRef.current[path];
      }
    });

    // The initially-active frame is the most recent PAST frame, which
    // usually sits near the end of the array, not at index 0 — this
    // ordering loads that frame first so something appears on screen
    // immediately, then backfills the rest afterward for animation.
    const activeIndex = radarIndexRef.current;
    const order = [activeIndex, ...radarFrames.map((_, i) => i).filter(i => i !== activeIndex)];

    const loadNext = (pos) => {
      if (cancelled || pos >= order.length) return;
      const index = order[pos];
      const frame = radarFrames[index];
      if (radarLayersRef.current[frame.path]) { loadNext(pos + 1); return; } // already cached from a previous run
      const url = `${radarHost}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
      // Opacity set correctly right at creation, not left to the
      // separate toggle effect below — that effect only re-runs when
      // radarIndex itself changes, which won't happen again once it's
      // already set to this same value, so a layer created afterward
      // for the already-active frame would otherwise never become
      // visible until the user actually switched frames.
      // maxNativeZoom (not maxZoom alone) is what actually matters
      // here — RainViewer's own documentation states their radar
      // tiles only exist up to zoom level 7. Setting maxZoom to a
      // higher value without maxNativeZoom told Leaflet tiles existed
      // all the way up to that level, so zooming in past 7 made it
      // request tile coordinates RainViewer's server has never had —
      // exactly the tile errors that appeared. maxNativeZoom stops
      // Leaflet from ever requesting past zoom 7, while maxZoom keeps
      // the layer visible (upscaling the zoom-7 tiles, same idea as
      // zooming into a photo) at any zoom the map itself allows,
      // rather than the radar vanishing outright past that point.
      const layer = L.tileLayer(url, { opacity: index === radarIndexRef.current ? 0.75 : 0, maxNativeZoom: 7, maxZoom: 19, zIndex: 500 });
      layer.once("load", () => {
        if (!cancelled) loadNext(pos + 1);
      });
      layer.addTo(mapRef.current);
      radarLayersRef.current[frame.path] = layer;
    };
    loadNext(0);

    return () => { cancelled = true; };
  }, [radarFrames, radarHost, mapReady]);

  // Instant — every frame's tiles are already loaded by the effect
  // above, so this never triggers a network request.
  useEffect(() => {
    const activeFrame = radarFrames[radarIndex];
    if (!activeFrame) return;
    Object.entries(radarLayersRef.current).forEach(([path, layer]) => {
      layer.setOpacity(path === activeFrame.path ? 0.75 : 0);
    });
  }, [radarIndex, radarFrames]);

  // Loops through the available frames for an animated "live" radar
  // view rather than just a single static snapshot.
  useEffect(() => {
    if (!radarPlaying || radarFrames.length === 0) return;
    radarTimerRef.current = setInterval(() => {
      setRadarIndex(i => (i + 1) % radarFrames.length);
    }, 600);
    return () => clearInterval(radarTimerRef.current);
  }, [radarPlaying, radarFrames.length]);

  const refreshAll = () => {
    if (coords) {
      fetchCurrentConditions(coords.lat, coords.lng);
      fetchLocationName(coords.lat, coords.lng);
    }
    fetchRadarFrames();
  };

  const activeFrame = radarFrames[radarIndex];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Current Weather" icon={CloudSun} right={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {locationName && <span style={{ fontSize: 13, color: COLORS.muted }}>{locationName}</span>}
          <Btn kind="subtle" icon={RefreshCw} onClick={refreshAll} style={{ padding: "6px 11px", fontSize: 12.5 }}>Refresh</Btn>
        </div>
      }>
        {locError && <div style={{ fontSize: 13, color: COLORS.dangerText }}>{locError}</div>}
        {!locError && currentLoading && <div style={{ fontSize: 13, color: COLORS.faint }}>Getting your location and current conditions...</div>}
        {currentError && <div style={{ fontSize: 13, color: COLORS.dangerText }}>{currentError}</div>}
        {current && (() => {
          const temp = current.temperature_2m, rh = current.relative_humidity_2m, feelsLike = current.apparent_temperature;
          // Heat index only exists as a standard, meaningful concept
          // at 80°F and above — below that there's no heat-stress
          // concern and the figure doesn't mean much.
          const showHeatIndex = temp >= 80;
          const heatIndex = showHeatIndex ? calculateHeatIndex(temp, rh) : null;
          // Open-Meteo's own "feels like" already blends in heat
          // index-like effects for hot conditions — if the two are
          // within a couple degrees of each other, showing a
          // separate Heat Index number would just be repeating the
          // same figure twice under different names.
          const heatIndexDiffersFromFeelsLike = heatIndex != null && Math.abs(heatIndex - feelsLike) >= 2;
          return (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14 }}>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Temp</div>
                  <div style={{ fontSize: 26, fontFamily: "'Oswald', sans-serif" }}>{Math.round(temp)}°F</div>
                  <div style={{ fontSize: 11.5, color: COLORS.faint }}>Feels like {Math.round(feelsLike)}°F</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Wind</div>
                  <div style={{ fontSize: 20, fontFamily: "'Oswald', sans-serif" }}>{Math.round(current.wind_speed_10m)} mph {degreesToCompass(current.wind_direction_10m)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Humidity</div>
                  <div style={{ fontSize: 20, fontFamily: "'Oswald', sans-serif" }}>{Math.round(rh)}%</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Conditions</div>
                  <div style={{ fontSize: 16, marginTop: 4 }}>{weatherCodeDescription(current.weather_code)}</div>
                </div>
                {heatIndexDiffersFromFeelsLike && (
                  <div>
                    <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>Heat Index</div>
                    <div style={{ fontSize: 26, fontFamily: "'Oswald', sans-serif", color: heatIndexCategory(heatIndex).color }}>{Math.round(heatIndex)}°F</div>
                    <div style={{ fontSize: 11.5, color: COLORS.faint }}>{heatIndexCategory(heatIndex).label}</div>
                  </div>
                )}
              </div>
              {showHeatIndex && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 8 }}>
                    NWS Heat Index Chart
                  </div>
                  <HeatIndexMatrix currentTemp={temp} currentRh={rh} exactHeatIndex={heatIndex} />
                </div>
              )}
            </>
          );
        })()}
      </Panel>

      <Panel title="Live Radar" icon={CloudSun} right={
        radarFrames.length > 0 && (
          <Btn kind={radarPlaying ? "solid" : "subtle"} icon={radarPlaying ? Pause : Play} onClick={() => setRadarPlaying(p => !p)} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {radarPlaying ? "Pause" : "Animate"}
          </Btn>
        )
      }>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Centered on your current GPS location. Pan and zoom like any other map — the radar overlay updates automatically every 5 minutes, and animates automatically for a moving view of the storm. Use Pause to stop on a single frame.
          {radarError && <span style={{ color: COLORS.dangerText, display: "block", marginTop: 4 }}>{radarError}</span>}
          {!coords && !locError && <span style={{ display: "block", marginTop: 4 }}>Waiting for GPS location...</span>}
        </div>
        <div ref={containerRef} style={{ width: "100%", height: "60vh", minHeight: 380, borderRadius: 6, border: `1px solid ${COLORS.line}` }} />
        {activeFrame && (
          <div style={{ fontSize: 11.5, color: COLORS.faint, marginTop: 6, fontFamily: "'IBM Plex Mono', monospace" }}>
            Frame: {new Date(activeFrame.time * 1000).toLocaleTimeString()}
          </div>
        )}
      </Panel>
    </div>
  );
}

function TabOrg({ org, setOrg, resources, assignmentPresets, resourceColumnOrder, departments }) {
  // Safety Officer, PIO, Liaison Officer, and the three non-Operations
  // Section Chiefs only render if a matching assignment/division
  // actually exists on the Resource Board right now — otherwise
  // they're just empty boilerplate boxes for roles nobody's
  // necessarily staffing on this particular incident. This is
  // visibility-only: the underlying data is never touched or
  // deleted, so a box that's hidden today reappears (with whatever it
  // already had filled in) the moment a matching assignment shows up
  // again. Operations Section Chief and the Incident Commander/Deputy
  // IC boxes are never gated — Operations is where every auto-synced
  // division lives regardless of its own name, and IC/Deputy IC are
  // always-relevant top-level roles the user didn't ask to gate.
  const activeAssignments = deriveAssignmentColumns(resources || [], assignmentPresets, resourceColumnOrder).filter(col => !STATUS_FLOW.includes(col));
  // Full list of preset unit names across every department (same
  // "the full preset list, not just what's currently on the board"
  // principle as assignmentPresets above) — offered as the picker
  // options for a manually-added box nested under a division, since
  // that's presumed to represent a unit rather than another division.
  const unitOptions = [...new Set((departments || []).flatMap(d => d.units || []))];
  const hasMatchingAssignment = (positionTitle) => {
    const t = String(positionTitle || "").trim().toLowerCase();
    if (!t) return false;
    return activeAssignments.some(a => {
      const an = a.trim().toLowerCase();
      return an === t || an.includes(t) || t.includes(an);
    });
  };
  const GATED_TITLES = ["Safety Officer", "Public Information Officer", "Liaison Officer", "Planning Section Chief", "Logistics Section Chief", "Finance/Admin Section Chief"];
  const isGated = (title) => GATED_TITLES.some(g => g.toLowerCase() === String(title || "").trim().toLowerCase());
  const visibleCommandStaff = org.commandStaff.filter(cs => !isGated(cs.title) || hasMatchingAssignment(cs.title));

  const addCommandStaff = () => setOrg({ ...org, commandStaff: [...org.commandStaff, { id: uid(), title: "New Position", name: "", manuallyAdded: true }] });
  const updateCommandStaff = (id, patch) => setOrg({ ...org, commandStaff: org.commandStaff.map(c => c.id === id ? { ...c, ...patch } : c) });
  const removeCommandStaff = (id) => setOrg({ ...org, commandStaff: org.commandStaff.filter(c => c.id !== id) });

  const updateSection = (nodeId, patch) => setOrg({ ...org, sections: updateOrgNode(org.sections, nodeId, patch) });
  const deleteSection = (nodeId) => {
    // The four Section Chief nodes underneath org.sections are still
    // a permanent, non-deletable top level in the underlying data —
    // this guard is unchanged even though Operations Section Chief's
    // own box is no longer rendered at all (its children/divisions
    // are promoted to render directly instead). Only nodes actually
    // added underneath a section (divisions, and anything nested
    // further under those) can be removed via this function.
    if (org.sections.some(s => s.id === nodeId)) return;
    setOrg({ ...org, sections: deleteOrgNode(org.sections, nodeId) });
  };
  // manuallyAdded is what OrgTree/OrgBox check to decide whether to
  // show either field's picker at all — this new node's title
  // uniformly picks from divisions/assignments and its name uniformly
  // picks from units, regardless of what it's nested under.
  const addSectionChild = (parentId) => setOrg({ ...org, sections: addOrgChild(org.sections, parentId, { id: uid(), title: "Division/Group", name: "", children: [], manuallyAdded: true }) });

  const updateIncidentCommandNode = (nodeId, patch) => {
    if (!org.incidentCommand) return;
    setOrg({ ...org, incidentCommand: updateOrgNode([org.incidentCommand], nodeId, patch)[0] });
  };
  const deleteIncidentCommandNode = (nodeId) => {
    // Guards against deleting the auto-synced root itself via the UI
    // — it isn't exposed a delete button anyway (rendered manually
    // below without one), but this stays defensive in case that ever
    // changes. Only nodes actually nested underneath it (divisions,
    // and anything further under those) are removable this way.
    if (!org.incidentCommand || org.incidentCommand.id === nodeId) return;
    setOrg({ ...org, incidentCommand: deleteOrgNode([org.incidentCommand], nodeId)[0] });
  };
  // Same reasoning as addSectionChild above.
  const addIncidentCommandChild = (parentId) => {
    if (!org.incidentCommand) return;
    setOrg({ ...org, incidentCommand: addOrgChild([org.incidentCommand], parentId, { id: uid(), title: "Division/Group", name: "", children: [], manuallyAdded: true })[0] });
  };

  const otherVisibleSections = org.sections.filter(s => s.title !== "Operations Section Chief" && (!isGated(s.title) || hasMatchingAssignment(s.title)));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Organization Chart" icon={Shield}>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 18, lineHeight: 1.5 }}>
          Type a name into any box to fill that position, or use the ▾ button beside it to pick from the full list of assignments/divisions set up under Manage Resources. Use "+ Add Below" to expand into further sub-units — add as many levels as the incident needs.
        </div>
        <div style={{ overflowX: "auto", paddingBottom: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: "fit-content", margin: "0 auto" }}>
            {/* Incident Command, auto-synced from the Resource Board —
                wraps Operations, which wraps every regular division —
                shown above everything else. Rendered manually (not
                via OrgTree) specifically so this root box has no
                delete button of its own, since it's meant to mirror
                the board, not be removable by hand; its children
                still use the normal OrgTree and so are freely
                editable/removable like anything else. */}
            {org.incidentCommand && (
              <>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <OrgBox
                    title={org.incidentCommand.title} name={org.incidentCommand.name} isRoot
                    onNameChange={v => updateIncidentCommandNode(org.incidentCommand.id, { name: v, autoName: false })}
                    onAddChild={() => addIncidentCommandChild(org.incidentCommand.id)}
                  />
                  {org.incidentCommand.children && org.incidentCommand.children.length > 0 && (
                    <OrgConnectors>
                      {org.incidentCommand.children.map(child => (
                        <OrgTree key={child.id} node={child} onUpdate={updateIncidentCommandNode} onDelete={deleteIncidentCommandNode} onAddChild={addIncidentCommandChild} titleOptions={assignmentPresets} unitOptions={unitOptions} />
                      ))}
                    </OrgConnectors>
                  )}
                </div>
                <div style={{ width: 2, height: 16, background: COLORS.line }} />
              </>
            )}
            <div style={{ display: "flex", gap: 40, flexWrap: "wrap", justifyContent: "center" }}>
              {/* Command Staff cluster */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                  {visibleCommandStaff.map(cs => (
                    <OrgBox key={cs.id} title={cs.title} name={cs.name} titleEditable
                      titleOptions={cs.manuallyAdded ? assignmentPresets : undefined}
                      nameOptions={cs.manuallyAdded ? unitOptions : undefined}
                      onTitleChange={v => updateCommandStaff(cs.id, { title: v })}
                      onNameChange={v => updateCommandStaff(cs.id, { name: v })}
                      onDelete={() => removeCommandStaff(cs.id)} />
                  ))}
                </div>
                <button onClick={addCommandStaff} style={{ marginTop: 8, background: "none", border: `1px dashed ${COLORS.line}`, borderRadius: 4, color: COLORS.muted, cursor: "pointer", fontSize: 10.5, padding: "4px 10px" }}>
                  + Add Command Staff
                </button>
              </div>
              {/* Non-Operations Section Chiefs (gated) — Operations
                  itself and all divisions now live under
                  org.incidentCommand above instead of here. */}
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
                {otherVisibleSections.map(section => (
                  <OrgTree key={section.id} node={section} onUpdate={updateSection} onDelete={deleteSection} onAddChild={addSectionChild} titleOptions={assignmentPresets} unitOptions={unitOptions} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: COMMUNICATIONS PLAN (ICS-205)
   ============================================================ */
function TabComms({ comms, setComms, incident }) {
  const addRow = () => setComms({ ...comms, rows: [...comms.rows, { id: uid(), zoneGroup: "", chNum: "", func: "Command", channelName: "", assignment: "", rxFreq: "", rxTone: "", txFreq: "", txTone: "", mode: "D", remarks: "" }] });
  const update = (id, patch) => setComms({ ...comms, rows: comms.rows.map(c => c.id === id ? { ...c, ...patch } : c) });
  const remove = (id) => setComms({ ...comms, rows: comms.rows.filter(c => c.id !== id) });
  const set = (patch) => setComms({ ...comms, ...patch });
  const cell = { padding: "6px 6px", fontSize: 12.5 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-205 · Incident Radio Communications Plan" icon={Radio}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Date / Time Prepared"><TextInput type="datetime-local" value={comms.dateTimePrepared} onChange={e => set({ dateTimePrepared: e.target.value })} /></Field>
          <Field label="Operational Period From"><TextInput type="datetime-local" value={comms.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
          <Field label="Operational Period To"><TextInput type="datetime-local" value={comms.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="4. Basic Radio Channel Use" icon={Radio} right={<Btn kind="subtle" icon={Plus} onClick={addRow}>Add Channel</Btn>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5, letterSpacing: "0.05em" }}>
                <th style={cell}>Zone/Grp</th><th style={cell}>Ch#</th><th style={cell}>Function</th><th style={cell}>Channel Name / Talkgroup</th>
                <th style={cell}>Assignment</th><th style={cell}>RX Freq (N/W)</th><th style={cell}>RX Tone/NAC</th>
                <th style={cell}>TX Freq (N/W)</th><th style={cell}>TX Tone/NAC</th><th style={cell}>Mode</th><th style={cell}>Remarks</th><th style={cell}></th>
              </tr>
            </thead>
            <tbody>
              {comms.rows.map(c => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}><TextInput value={c.zoneGroup} onChange={e => update(c.id, { zoneGroup: e.target.value })} style={{ width: 65 }} /></td>
                  <td style={cell}><TextInput value={c.chNum} onChange={e => update(c.id, { chNum: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}>
                    <Select value={c.func} onChange={e => update(c.id, { func: e.target.value })} style={{ width: 110 }}>
                      {["Command", "Tactical", "Ground-to-Air", "Air-to-Air", "Support", "Dispatch"].map(f => <option key={f}>{f}</option>)}
                    </Select>
                  </td>
                  <td style={cell}><TextInput value={c.channelName} onChange={e => update(c.id, { channelName: e.target.value })} style={{ width: 130 }} placeholder="TAC-3 / Talkgroup" /></td>
                  <td style={cell}><TextInput value={c.assignment} onChange={e => update(c.id, { assignment: e.target.value })} style={{ width: 100 }} /></td>
                  <td style={cell}><TextInput value={c.rxFreq} onChange={e => update(c.id, { rxFreq: e.target.value })} style={{ width: 85 }} placeholder="xxx.xxxx N/W" /></td>
                  <td style={cell}><TextInput value={c.rxTone} onChange={e => update(c.id, { rxTone: e.target.value })} style={{ width: 75 }} /></td>
                  <td style={cell}><TextInput value={c.txFreq} onChange={e => update(c.id, { txFreq: e.target.value })} style={{ width: 85 }} placeholder="xxx.xxxx N/W" /></td>
                  <td style={cell}><TextInput value={c.txTone} onChange={e => update(c.id, { txTone: e.target.value })} style={{ width: 75 }} /></td>
                  <td style={cell}>
                    <Select value={c.mode} onChange={e => update(c.id, { mode: e.target.value })} style={{ width: 70 }}>
                      <option value="A">A</option><option value="D">D</option><option value="M">M</option>
                    </Select>
                  </td>
                  <td style={cell}><TextInput value={c.remarks} onChange={e => update(c.id, { remarks: e.target.value })} style={{ width: 130 }} /></td>
                  <td style={cell}><button onClick={() => remove(c.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {comms.rows.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>No channels assigned yet.</div>}
        </div>
      </Panel>

      <Panel title="5. Special Instructions & 6. Prepared By" icon={Radio}>
        <Field label="Special Instructions" wide>
          <TextArea value={comms.specialInstructions} onChange={e => set({ specialInstructions: e.target.value })} style={{ minHeight: 60 }}
            placeholder="Cross-band repeaters, secure voice, encoders, PL tones, incident-within-an-incident handling..." />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 12 }}>
          <Field label="Prepared By (Communications Unit Leader)"><TextInput value={comms.preparedBy} onChange={e => set({ preparedBy: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={comms.signature} onChange={e => set({ signature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={comms.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: REHAB TRACKING
   ============================================================ */
function TabRehab({ rehab, setRehab, resources, now }) {
  const [openId, setOpenId] = useState(null); // which entry's detail view is open

  const addEntry = () => {
    // Two separate vitals sets (In/Out suffix) rather than one shared
    // set — captured at check-in and again at check-out, so a
    // meaningful before/after comparison is actually possible rather
    // than only ever having one snapshot per person.
    const entry = {
      id: uid(), name: "", unit: "", timeIn: nowISO(),
      bpIn: "", pulseIn: "", rrIn: "", spo2In: "", tempIn: "",
      bpOut: "", pulseOut: "", rrOut: "", spo2Out: "", tempOut: "",
      fluidBolus: "", nutrientIntake: "",
      status: "In Rehab", timeCleared: "", notes: "",
    };
    setRehab([entry, ...rehab]);
    setOpenId(entry.id); // open it immediately so the compact card isn't the only way to fill it in
  };
  const update = (id, patch) => setRehab(rehab.map(r => r.id === id ? { ...r, ...patch } : r));
  const remove = (id) => { setRehab(rehab.filter(r => r.id !== id)); if (openId === id) setOpenId(null); };
  const clear = (id) => update(id, { status: "Cleared", timeCleared: nowISO() });

  const openEntry = rehab.find(r => r.id === openId);
  const statusColor = (status) => status === "Cleared" ? COLORS.teal : status === "Transported" ? COLORS.red : COLORS.amber;

  return (
    <Panel title="Rehab / Medical Monitoring" icon={HeartPulse} right={<Btn kind="subtle" icon={Plus} onClick={addEntry}>Add Entry</Btn>}>
      {rehab.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No personnel currently logged in rehab.</div>}
      {/* Compact — just enough to scan a whole list of people at a
          glance on a narrow screen. Tap a card for everything else
          (vitals, status, notes) in a single-column detail view,
          rather than trying to fit every field into this row, which
          is what made this hard to read on an iPhone before. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rehab.map(r => (
          <div key={r.id} onClick={() => setOpenId(r.id)}
            style={{
              background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${statusColor(r.status)}`,
              borderRadius: 5, padding: "10px 12px", cursor: "pointer",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap",
            }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{r.name || "(unnamed)"}</div>
              <div style={{ fontSize: 12, color: COLORS.muted }}>{r.unit || "-"}</div>
            </div>
            <div style={{ textAlign: "right", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, color: COLORS.faint, lineHeight: 1.5 }}>
              <div>In: {fmtTime(r.timeIn)}</div>
              <div>{elapsed(r.timeIn, r.timeCleared ? new Date(r.timeCleared).getTime() : now)} elapsed</div>
              {r.timeCleared && <div>Cleared: {fmtTime(r.timeCleared)}</div>}
            </div>
          </div>
        ))}
      </div>

      {openEntry && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 80 }}
          onClick={() => setOpenId(null)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 360, maxWidth: "90vw", maxHeight: "85vh", overflowY: "auto", padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Rehab Entry</span>
              <button onClick={() => setOpenId(null)} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Field label="Name"><TextInput autoFocus value={openEntry.name} onChange={e => update(openEntry.id, { name: e.target.value })} /></Field>
              <Field label="Unit"><TextInput value={openEntry.unit} onChange={e => update(openEntry.id, { unit: e.target.value })} /></Field>

              <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 4, borderTop: `1px solid ${COLORS.line}`, paddingTop: 10 }}>
                Check-In Vitals — {fmtTime(openEntry.timeIn)}
              </div>
              <Field label="BP"><TextInput value={openEntry.bpIn} onChange={e => update(openEntry.id, { bpIn: e.target.value })} placeholder="120/80" /></Field>
              <Field label="Pulse"><TextInput value={openEntry.pulseIn} onChange={e => update(openEntry.id, { pulseIn: e.target.value })} /></Field>
              <Field label="Resp"><TextInput value={openEntry.rrIn} onChange={e => update(openEntry.id, { rrIn: e.target.value })} /></Field>
              <Field label="SpO2"><TextInput value={openEntry.spo2In} onChange={e => update(openEntry.id, { spo2In: e.target.value })} /></Field>
              <Field label="Temp"><TextInput value={openEntry.tempIn} onChange={e => update(openEntry.id, { tempIn: e.target.value })} /></Field>

              <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 4, borderTop: `1px solid ${COLORS.line}`, paddingTop: 10 }}>
                During Rehab
              </div>
              <Field label="Fluid Bolus"><TextInput value={openEntry.fluidBolus} onChange={e => update(openEntry.id, { fluidBolus: e.target.value })} placeholder="1L IV NS, or 32oz PO water" /></Field>
              <Field label="Nutrient Intake"><TextInput value={openEntry.nutrientIntake} onChange={e => update(openEntry.id, { nutrientIntake: e.target.value })} placeholder="Sandwich, sports drink" /></Field>

              {/* Check-Out vitals are fillable any time (not gated
                  behind clicking Clear first) — the natural workflow
                  is taking these vitals AS the reason to decide
                  someone's ready to clear, not something recorded
                  only after the fact. */}
              <div style={{ fontSize: 11, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.05em", marginTop: 4, borderTop: `1px solid ${COLORS.line}`, paddingTop: 10 }}>
                Check-Out Vitals{openEntry.timeCleared ? ` — ${fmtTime(openEntry.timeCleared)}` : ""}
              </div>
              <Field label="BP"><TextInput value={openEntry.bpOut} onChange={e => update(openEntry.id, { bpOut: e.target.value })} placeholder="120/80" /></Field>
              <Field label="Pulse"><TextInput value={openEntry.pulseOut} onChange={e => update(openEntry.id, { pulseOut: e.target.value })} /></Field>
              <Field label="Resp"><TextInput value={openEntry.rrOut} onChange={e => update(openEntry.id, { rrOut: e.target.value })} /></Field>
              <Field label="SpO2"><TextInput value={openEntry.spo2Out} onChange={e => update(openEntry.id, { spo2Out: e.target.value })} /></Field>
              <Field label="Temp"><TextInput value={openEntry.tempOut} onChange={e => update(openEntry.id, { tempOut: e.target.value })} /></Field>

              <Field label="Status">
                <Select value={openEntry.status} onChange={e => update(openEntry.id, { status: e.target.value })}>
                  {["In Rehab", "Cleared", "Transported"].map(s => <option key={s}>{s}</option>)}
                </Select>
              </Field>
              <div style={{ fontSize: 12, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace" }}>
                Check-In: {fmtTime(openEntry.timeIn)} · {elapsed(openEntry.timeIn, openEntry.timeCleared ? new Date(openEntry.timeCleared).getTime() : now)} elapsed
              </div>
              {openEntry.timeCleared && (
                <div style={{ fontSize: 12, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace" }}>Check-Out: {fmtTime(openEntry.timeCleared)}</div>
              )}
              {openEntry.status === "In Rehab" && (
                <Btn kind="subtle" icon={CheckCircle2} onClick={() => clear(openEntry.id)} style={{ justifyContent: "center" }}>Clear</Btn>
              )}
              <Field label="Notes"><TextInput value={openEntry.notes} onChange={e => update(openEntry.id, { notes: e.target.value })} placeholder="Notes" /></Field>
              <Btn kind="danger" icon={Trash2} onClick={() => remove(openEntry.id)} style={{ justifyContent: "center", marginTop: 4 }}>Delete Entry</Btn>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ============================================================
   TAB: ICS-214 ACTIVITY LOG
   ============================================================ */
/* ============================================================
   TAB: ICS-208 · SAFETY MESSAGE/PLAN
   ============================================================ */
function Tab208({ ics208, setIcs208, incident }) {
  const set = (patch) => setIcs208({ ...ics208, ...patch });
  return (
    <Panel title="ICS-208 · Safety Message / Plan" icon={AlertTriangle}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
        <Field label="Date / Time Prepared"><TextInput type="datetime-local" value={ics208.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 14 }}>
        <Field label="Operational Period From"><TextInput type="datetime-local" value={ics208.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
        <Field label="Operational Period To"><TextInput type="datetime-local" value={ics208.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <Field label="3. Safety Message/Expanded Safety Message, Safety Plan, Site Safety Plan" wide>
          <TextArea value={ics208.message} onChange={e => set({ message: e.target.value })} style={{ minHeight: 140 }}
            placeholder="Clear, concise statements for safety message(s), priorities, and key command emphasis/decisions/directions. Known safety hazards and specific precautions for this operational period..." />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 14, alignItems: "end" }}>
        <Field label="4. Site Safety Plan Required?">
          <Select value={ics208.siteSafetyPlanRequired} onChange={e => set({ siteSafetyPlanRequired: e.target.value })}>
            <option>Yes</option><option>No</option>
          </Select>
        </Field>
        <Field label="Approved Site Safety Plan(s) Located At"><TextInput value={ics208.siteSafetyPlanLocation} onChange={e => set({ siteSafetyPlanLocation: e.target.value })} /></Field>
      </div>
      <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>5. Prepared By</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
        <Field label="Name"><TextInput value={ics208.preparedBy} onChange={e => set({ preparedBy: e.target.value })} /></Field>
        <Field label="Position / Title"><TextInput value={ics208.position} onChange={e => set({ position: e.target.value })} placeholder="Safety Officer" /></Field>
        <Field label="Signature"><TextInput value={ics208.signature} onChange={e => set({ signature: e.target.value })} placeholder="Type name to sign" /></Field>
        <Field label="Date / Time"><TextInput type="datetime-local" value={ics208.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
      </div>
    </Panel>
  );
}

/* ============================================================
   TAB: ICS-208 HM · SITE SAFETY PLAN (HAZMAT)
   ============================================================ */
// Shared by ICS-208 HM and ICS-209 — a consistent, read-only strip of
// whatever's already been entered on the Tactical Worksheet and
// Mapping tab, so it doesn't need retyping on either form. Acreage
// comes from getTotalPerimeterAcres, the same figure the PDF export's
// "Incident Perimeter" section uses.
function IncidentSummaryStrip({ incident, mapData }) {
  const totalAcres = getTotalPerimeterAcres(mapData);
  const started = [incident.dateInitiated, incident.timeInitiated].filter(Boolean).join(" ");
  const roStyle = { opacity: 0.65 };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16, paddingBottom: 16, borderBottom: `1px solid ${COLORS.line}` }}>
      <Field label="Incident Name"><TextInput value={incident.name} disabled style={roStyle} /></Field>
      <Field label="Incident Number"><TextInput value={incident.number} disabled style={roStyle} /></Field>
      <Field label="Incident Type"><TextInput value={incident.type} disabled style={roStyle} /></Field>
      <Field label="Location"><TextInput value={incident.location} disabled style={roStyle} /></Field>
      <Field label="Incident Commander"><TextInput value={incident.icName} disabled style={roStyle} /></Field>
      <Field label="Started"><TextInput value={started || "—"} disabled style={roStyle} /></Field>
      <Field label="Area Involved"><TextInput value={totalAcres != null ? `${totalAcres.toFixed(1)} acres` : "—"} disabled style={roStyle} /></Field>
    </div>
  );
}

function Tab208HM({ ics208hm, setIcs208hm, incident, mapData }) {
  const set = (patch) => setIcs208hm({ ...ics208hm, ...patch });
  const cell = { padding: "6px 6px", fontSize: 12.5 };
  const checkRow = { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 };
  const chk = (label, key) => (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="checkbox" checked={ics208hm[key]} onChange={e => set({ [key]: e.target.checked })} style={{ width: 16, height: 16 }} />
      {label}
    </label>
  );

  const updateTeam = (teamKey, id, patch) => set({ [teamKey]: ics208hm[teamKey].map(m => m.id === id ? { ...m, ...patch } : m) });

  const addMaterial = () => set({ materials: [...ics208hm.materials, { id: uid(), material: "", containerType: "", qty: "", physState: "", ph: "", idlh: "", fp: "", it: "", vp: "", vd: "", sg: "", lel: "", uel: "" }] });
  const updateMaterial = (id, patch) => set({ materials: ics208hm.materials.map(m => m.id === id ? { ...m, ...patch } : m) });
  const removeMaterial = (id) => set({ materials: ics208hm.materials.filter(m => m.id !== id) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-208 HM · Site Safety and Control Plan" icon={AlertTriangle}>
        <IncidentSummaryStrip incident={incident} mapData={mapData} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Field label="Date Prepared"><TextInput type="datetime-local" value={ics208hm.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
          <Field label="Op. Period From"><TextInput type="datetime-local" value={ics208hm.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
          <Field label="Op. Period To"><TextInput type="datetime-local" value={ics208hm.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Section I — Incident Location" wide><TextInput value={ics208hm.incidentLocation} onChange={e => set({ incidentLocation: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Section II · Organization" icon={Users}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Field label="Incident Commander"><TextInput value={ics208hm.orgIC} onChange={e => set({ orgIC: e.target.value })} /></Field>
          <Field label="HM Group Supervisor"><TextInput value={ics208hm.orgHMGroupSupervisor} onChange={e => set({ orgHMGroupSupervisor: e.target.value })} /></Field>
          <Field label="Tech. Specialist – HM Reference"><TextInput value={ics208hm.orgTechSpecialist} onChange={e => set({ orgTechSpecialist: e.target.value })} /></Field>
          <Field label="Safety Officer"><TextInput value={ics208hm.orgSafetyOfficer} onChange={e => set({ orgSafetyOfficer: e.target.value })} /></Field>
          <Field label="Entry Leader"><TextInput value={ics208hm.orgEntryLeader} onChange={e => set({ orgEntryLeader: e.target.value })} /></Field>
          <Field label="Site Access Control Leader"><TextInput value={ics208hm.orgSiteAccessControlLeader} onChange={e => set({ orgSiteAccessControlLeader: e.target.value })} /></Field>
          <Field label="Asst. Safety Officer – HM"><TextInput value={ics208hm.orgAsstSafetyOfficerHM} onChange={e => set({ orgAsstSafetyOfficerHM: e.target.value })} /></Field>
          <Field label="Decontamination Leader"><TextInput value={ics208hm.orgDeconLeader} onChange={e => set({ orgDeconLeader: e.target.value })} /></Field>
          <Field label="Safe Refuge Area Mgr"><TextInput value={ics208hm.orgSafeRefugeAreaMgr} onChange={e => set({ orgSafeRefugeAreaMgr: e.target.value })} /></Field>
          <Field label="Environmental Health"><TextInput value={ics208hm.orgEnvironmentalHealth} onChange={e => set({ orgEnvironmentalHealth: e.target.value })} /></Field>
          <Field label="Other"><TextInput value={ics208hm.orgOther1} onChange={e => set({ orgOther1: e.target.value })} /></Field>
          <Field label="Other"><TextInput value={ics208hm.orgOther2} onChange={e => set({ orgOther2: e.target.value })} /></Field>
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Entry Team (Buddy System)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {ics208hm.entryTeam.map(m => (
            <div key={m.id}>
              <Field label={m.label}><TextInput value={m.name} onChange={e => updateTeam("entryTeam", m.id, { name: e.target.value })} placeholder="Name" /></Field>
              <TextInput value={m.ppeLevel} onChange={e => updateTeam("entryTeam", m.id, { ppeLevel: e.target.value })} placeholder="PPE Level" style={{ marginTop: 6 }} />
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Decontamination Element</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {ics208hm.deconTeam.map(m => (
            <div key={m.id}>
              <Field label={m.label}><TextInput value={m.name} onChange={e => updateTeam("deconTeam", m.id, { name: e.target.value })} placeholder="Name" /></Field>
              <TextInput value={m.ppeLevel} onChange={e => updateTeam("deconTeam", m.id, { ppeLevel: e.target.value })} placeholder="PPE Level" style={{ marginTop: 6 }} />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Section III · Hazard/Risk Analysis" icon={AlertTriangle} right={<Btn kind="subtle" icon={Plus} onClick={addMaterial}>Add Material</Btn>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10 }}>
              {/* Each header's width matches its column's input width
                  exactly, with nowrap so header text can't wrap and
                  force the column wider than its data cells — that
                  mismatch was the main source of columns not lining
                  up with the fields below them. */}
              <th style={{ ...cell, width: 110, whiteSpace: "nowrap" }}>Material</th>
              <th style={{ ...cell, width: 90, whiteSpace: "nowrap" }}>Container</th>
              <th style={{ ...cell, width: 60, whiteSpace: "nowrap" }}>Qty</th>
              <th style={{ ...cell, width: 70, whiteSpace: "nowrap" }}>Phys. State</th>
              <th style={{ ...cell, width: 45, whiteSpace: "nowrap" }}>pH</th>
              <th style={{ ...cell, width: 60, whiteSpace: "nowrap" }}>IDLH</th>
              <th style={{ ...cell, width: 50, whiteSpace: "nowrap" }}>F.P.</th>
              <th style={{ ...cell, width: 50, whiteSpace: "nowrap" }}>I.T.</th>
              <th style={{ ...cell, width: 50, whiteSpace: "nowrap" }}>V.P.</th>
              <th style={{ ...cell, width: 50, whiteSpace: "nowrap" }}>V.D.</th>
              <th style={{ ...cell, width: 50, whiteSpace: "nowrap" }}>S.G.</th>
              <th style={{ ...cell, width: 50, whiteSpace: "nowrap" }}>LEL</th>
              <th style={{ ...cell, width: 50, whiteSpace: "nowrap" }}>UEL</th>
              <th style={{ ...cell, width: 30 }}></th>
            </tr></thead>
            <tbody>
              {ics208hm.materials.map(m => (
                <tr key={m.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}><TextInput value={m.material} onChange={e => updateMaterial(m.id, { material: e.target.value })} style={{ width: 110 }} placeholder="UNK if unknown" /></td>
                  <td style={cell}><TextInput value={m.containerType} onChange={e => updateMaterial(m.id, { containerType: e.target.value })} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={m.qty} onChange={e => updateMaterial(m.id, { qty: e.target.value })} style={{ width: 60 }} /></td>
                  <td style={cell}><TextInput value={m.physState} onChange={e => updateMaterial(m.id, { physState: e.target.value })} style={{ width: 70 }} /></td>
                  <td style={cell}><TextInput value={m.ph} onChange={e => updateMaterial(m.id, { ph: e.target.value })} style={{ width: 45 }} /></td>
                  <td style={cell}><TextInput value={m.idlh} onChange={e => updateMaterial(m.id, { idlh: e.target.value })} style={{ width: 60 }} /></td>
                  <td style={cell}><TextInput value={m.fp} onChange={e => updateMaterial(m.id, { fp: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.it} onChange={e => updateMaterial(m.id, { it: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.vp} onChange={e => updateMaterial(m.id, { vp: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.vd} onChange={e => updateMaterial(m.id, { vd: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.sg} onChange={e => updateMaterial(m.id, { sg: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.lel} onChange={e => updateMaterial(m.id, { lel: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.uel} onChange={e => updateMaterial(m.id, { uel: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><button onClick={() => removeMaterial(m.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ics208hm.materials.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
        <Field label="Comment" wide><TextInput value={ics208hm.materialsComment} onChange={e => set({ materialsComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section IV · Hazard Monitoring" icon={AlertTriangle}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Field label="LEL Instrument(s)"><TextInput value={ics208hm.lelInstruments} onChange={e => set({ lelInstruments: e.target.value })} /></Field>
          <Field label="O2 Instrument(s)"><TextInput value={ics208hm.o2Instruments} onChange={e => set({ o2Instruments: e.target.value })} /></Field>
          <Field label="Toxicity/PPM Instrument(s)"><TextInput value={ics208hm.toxicityInstruments} onChange={e => set({ toxicityInstruments: e.target.value })} /></Field>
          <Field label="Radiological Instrument(s)"><TextInput value={ics208hm.radiologicalInstruments} onChange={e => set({ radiologicalInstruments: e.target.value })} /></Field>
        </div>
        <Field label="Comment" wide><TextInput value={ics208hm.monitoringComment} onChange={e => set({ monitoringComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section V · Decontamination Procedures" icon={AlertTriangle}>
        <Field label="Standard Decontamination Procedures?">
          <Select value={ics208hm.standardDecon} onChange={e => set({ standardDecon: e.target.value })} style={{ width: 140 }}>
            <option>Yes</option><option>No</option>
          </Select>
        </Field>
        <Field label="Comment" wide><TextInput value={ics208hm.deconComment} onChange={e => set({ deconComment: e.target.value })} style={{ marginTop: 10 }} placeholder="If No, note modifications and solutions used" /></Field>
      </Panel>

      <Panel title="Section VI · Site Communications" icon={Radio}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Field label="Command Frequency"><TextInput value={ics208hm.commandFreq} onChange={e => set({ commandFreq: e.target.value })} /></Field>
          <Field label="Tactical Frequency"><TextInput value={ics208hm.tacticalFreq} onChange={e => set({ tacticalFreq: e.target.value })} /></Field>
          <Field label="Entry Frequency"><TextInput value={ics208hm.entryFreq} onChange={e => set({ entryFreq: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Section VII · Medical Assistance" icon={HeartPulse}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Field label="Medical Monitoring?">
            <Select value={ics208hm.medicalMonitoring} onChange={e => set({ medicalMonitoring: e.target.value })}>
              <option>Yes</option><option>No</option>
            </Select>
          </Field>
          <Field label="Medical Treatment and Transport In-Place?">
            <Select value={ics208hm.medicalTreatmentInPlace} onChange={e => set({ medicalTreatmentInPlace: e.target.value })}>
              <option>Yes</option><option>No</option>
            </Select>
          </Field>
        </div>
        <Field label="Comment" wide><TextInput value={ics208hm.medicalComment} onChange={e => set({ medicalComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section VIII · Site Map" icon={ClipboardList}>
        <div style={checkRow}>
          {chk("Weather", "siteMapWeather")}
          {chk("Command Post", "siteMapCommandPost")}
          {chk("Zones", "siteMapZones")}
          {chk("Assembly Areas", "siteMapAssemblyAreas")}
          {chk("Escape Routes", "siteMapEscapeRoutes")}
          {chk("Other", "siteMapOther")}
        </div>
        <Field label="Site Map Notes (sketch or attach separately)" wide><TextArea value={ics208hm.siteMapNotes} onChange={e => set({ siteMapNotes: e.target.value })} style={{ minHeight: 60, marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section IX · Entry Objectives" icon={ClipboardList}>
        <Field label="Entry Objectives (and parameters that will alter or stop entry operations)" wide>
          <TextArea value={ics208hm.entryObjectives} onChange={e => set({ entryObjectives: e.target.value })} style={{ minHeight: 70 }} />
        </Field>
      </Panel>

      <Panel title="Section X · SOPs and Safe Work Practices" icon={ClipboardList}>
        <Field label="Modifications to Documented SOPs or Work Practices?">
          <Select value={ics208hm.sopModifications} onChange={e => set({ sopModifications: e.target.value })} style={{ width: 140 }}>
            <option>Yes</option><option>No</option>
          </Select>
        </Field>
        <Field label="Comment" wide><TextInput value={ics208hm.sopComment} onChange={e => set({ sopComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section XI · Emergency Procedures" icon={AlertTriangle}>
        <Field label="Emergency Procedures" wide>
          <TextArea value={ics208hm.emergencyProcedures} onChange={e => set({ emergencyProcedures: e.target.value })} style={{ minHeight: 70 }} />
        </Field>
      </Panel>

      <Panel title="Section XII · Safety Briefing" icon={CheckCircle2}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <Field label="Asst. Safety Officer – HM Signature"><TextInput value={ics208hm.asstSafetyOfficerSignature} onChange={e => set({ asstSafetyOfficerSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Safety Briefing Completed (Time)"><TextInput type="time" value={ics208hm.safetyBriefingTime} onChange={e => set({ safetyBriefingTime: e.target.value })} /></Field>
          <Field label="HM Group Supervisor Signature"><TextInput value={ics208hm.hmGroupSupervisorSignature} onChange={e => set({ hmGroupSupervisorSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Incident Commander Signature"><TextInput value={ics208hm.incidentCommanderSignature} onChange={e => set({ incidentCommanderSignature: e.target.value })} placeholder="Type name to sign" /></Field>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: ICS-209 · INCIDENT STATUS SUMMARY
   ============================================================ */
const THREAT_FLAG_OPTIONS = [
  ["noLikelyThreat", "No Likely Threat"], ["potentialFutureThreat", "Potential Future Threat"],
  ["massNotificationsInProgress", "Mass Notifications in Progress"], ["massNotificationsCompleted", "Mass Notifications Completed"],
  ["noEvacImminent", "No Evacuation(s) Imminent"], ["planningForEvac", "Planning for Evacuation"],
  ["planningForShelterInPlace", "Planning for Shelter-in-Place"], ["evacInProgress", "Evacuation(s) in Progress"],
  ["shelterInPlaceInProgress", "Shelter-in-Place in Progress"], ["repopulationInProgress", "Repopulation in Progress"],
  ["massImmunizationInProgress", "Mass Immunization in Progress"], ["massImmunizationComplete", "Mass Immunization Complete"],
  ["quarantineInProgress", "Quarantine in Progress"], ["areaRestrictionInEffect", "Area Restriction in Effect"],
];
const PUBLIC_STATUS_ROWS = [
  ["fatalities", "Fatalities"], ["injuries", "With Injuries/Illness"], ["trapped", "Trapped/In Need of Rescue"],
  ["missing", "Missing"], ["evacuated", "Evacuated"], ["shelterInPlace", "Sheltering in Place"],
  ["tempShelters", "In Temporary Shelters"], ["massImmunizations", "Have Received Mass Immunizations"],
  ["requireImmunizations", "Require Immunizations"], ["quarantine", "In Quarantine"],
];
const RESPONDER_STATUS_ROWS = [
  ["fatalities", "Fatalities"], ["injuries", "With Injuries/Illness"], ["trapped", "Trapped/In Need of Rescue"],
  ["missing", "Missing"], ["shelterInPlace", "Sheltering in Place"], ["receivedImmunizations", "Have Received Immunizations"],
  ["requireImmunizations", "Require Immunizations"], ["quarantine", "In Quarantine"],
];
const STRUCTURAL_ROWS = [
  ["singleResidences", "Single Residences"], ["nonresidential", "Nonresidential Commercial Property"],
  ["otherMinor", "Other Minor Structures"], ["other", "Other"],
];
const TIMEFRAME_KEYS = [["h12", "12 Hours"], ["h24", "24 Hours"], ["h48", "48 Hours"], ["h72", "72 Hours"], ["after72", "Anticipated After 72 Hours"]];

function Tab209({ ics209, setIcs209, incident, mapData }) {
  const set = (patch) => setIcs209({ ...ics209, ...patch });
  const setNested = (group, key, field, val) => setIcs209({ ...ics209, [group]: { ...ics209[group], [key]: { ...ics209[group][key], [field]: val } } });
  const setTimeframe = (group, key, val) => setIcs209({ ...ics209, [group]: { ...ics209[group], [key]: val } });
  const toggleFlag = (key) => setIcs209({ ...ics209, threatFlags: { ...ics209.threatFlags, [key]: !ics209.threatFlags[key] } });
  const cell = { padding: "5px 6px", fontSize: 12.5 };
  const totalAcres = getTotalPerimeterAcres(mapData);

  const addCommitment = () => set({ resourceCommitments: [...ics209.resourceCommitments, { id: uid(), agency: "", resources: "", additionalPersonnel: "", totalPersonnel: "", totalResources: "" }] });
  const updateCommitment = (id, patch) => set({ resourceCommitments: ics209.resourceCommitments.map(r => r.id === id ? { ...r, ...patch } : r) });
  const removeCommitment = (id) => set({ resourceCommitments: ics209.resourceCommitments.filter(r => r.id !== id) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-209 · Incident Status Summary — Page 1" icon={ClipboardList}>
        <IncidentSummaryStrip incident={incident} mapData={mapData} />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Field label="Report Version">
            <Select value={ics209.reportVersion} onChange={e => set({ reportVersion: e.target.value })}>
              <option>Initial</option><option>Update</option><option>Final</option>
            </Select>
          </Field>
          <Field label="Report # (if used)"><TextInput value={ics209.reportNumber} onChange={e => set({ reportNumber: e.target.value })} /></Field>
          <Field label="Agency/Organization (optional)"><TextInput value={ics209.icAgencyOrg} onChange={e => set({ icAgencyOrg: e.target.value })} placeholder="KFD, or list for Unified Command" /></Field>
          <Field label="Incident Management Organization"><TextInput value={ics209.imTeam} onChange={e => set({ imTeam: e.target.value })} placeholder="Type 1/2/3 IMT, Unified Command..." /></Field>
          <Field label="Time Zone"><TextInput value="CST" disabled style={{ opacity: 0.65 }} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 14 }}>
          <Field label="Current Size/Area Involved">
            <TextInput value={ics209.sizeArea} onChange={e => set({ sizeArea: e.target.value })} placeholder="sq mi, acres..." />
            {totalAcres != null && (
              <button onClick={() => set({ sizeArea: `${totalAcres.toFixed(1)} acres` })}
                style={{ background: "none", border: "none", color: COLORS.amber, fontSize: 11, cursor: "pointer", textAlign: "left", padding: "3px 0 0" }}>
                Use mapped acreage ({totalAcres.toFixed(1)})
              </button>
            )}
          </Field>
          <Field label="% Contained/Completed"><TextInput value={ics209.percentContained} onChange={e => set({ percentContained: e.target.value })} /></Field>
          <Field label="Incident Definition"><TextInput value={ics209.definition} onChange={e => set({ definition: e.target.value })} placeholder={incident.type || "wildfire, structure fire..."} /></Field>
          <Field label="Complexity Level"><TextInput value={ics209.complexityLevel} onChange={e => set({ complexityLevel: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 14 }}>
          <Field label="For Time Period From"><TextInput type="datetime-local" value={ics209.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
          <Field label="To"><TextInput type="datetime-local" value={ics209.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Approval & Routing Information" icon={CheckCircle2}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Field label="Prepared By — Print Name"><TextInput value={ics209.preparedByName} onChange={e => set({ preparedByName: e.target.value })} /></Field>
          <Field label="ICS Position"><TextInput value={ics209.preparedByPosition} onChange={e => set({ preparedByPosition: e.target.value })} /></Field>
          <Field label="Date/Time Prepared"><TextInput type="datetime-local" value={ics209.preparedDateTime} onChange={e => set({ preparedDateTime: e.target.value })} /></Field>
          <Field label="Date/Time Submitted"><TextInput type="datetime-local" value={ics209.submittedDateTime} onChange={e => set({ submittedDateTime: e.target.value })} /></Field>
          <Field label="Time Zone"><TextInput value={ics209.submittedTimeZone} onChange={e => set({ submittedTimeZone: e.target.value })} /></Field>
          <Field label="Primary Location/Org/Agency"><TextInput value={ics209.sentTo} onChange={e => set({ sentTo: e.target.value })} /></Field>
          <Field label="Approved By — Print Name"><TextInput value={ics209.approvedByName} onChange={e => set({ approvedByName: e.target.value })} /></Field>
          <Field label="ICS Position"><TextInput value={ics209.approvedByPosition} onChange={e => set({ approvedByPosition: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={ics209.approvedBySignature} onChange={e => set({ approvedBySignature: e.target.value })} placeholder="Type name to sign" /></Field>
        </div>
      </Panel>

      <Panel title="Incident Location Information" icon={ClipboardList}>
        <div style={{ fontSize: 12, color: COLORS.faint, marginBottom: 12 }}>
          Location from the Tactical Worksheet: <strong style={{ color: COLORS.text }}>{incident.location || "—"}</strong>. Add more specific detail below if needed.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <Field label="State"><TextInput value={ics209.state} onChange={e => set({ state: e.target.value })} /></Field>
          <Field label="County/Parish/Borough"><TextInput value={ics209.county} onChange={e => set({ county: e.target.value })} /></Field>
          <Field label="City"><TextInput value={ics209.city} onChange={e => set({ city: e.target.value })} /></Field>
          <Field label="Unit or Other"><TextInput value={ics209.unitOther} onChange={e => set({ unitOther: e.target.value })} /></Field>
          <Field label="Incident Jurisdiction"><TextInput value={ics209.jurisdiction} onChange={e => set({ jurisdiction: e.target.value })} /></Field>
          <Field label="Location Ownership (if different)"><TextInput value={ics209.ownership} onChange={e => set({ ownership: e.target.value })} /></Field>
          <Field label="Longitude"><TextInput value={ics209.longitude} onChange={e => set({ longitude: e.target.value })} /></Field>
          <Field label="Latitude"><TextInput value={ics209.latitude} onChange={e => set({ latitude: e.target.value })} /></Field>
          <Field label="US National Grid Reference"><TextInput value={ics209.usng} onChange={e => set({ usng: e.target.value })} /></Field>
          <Field label="Legal Description"><TextInput value={ics209.legalDescription} onChange={e => set({ legalDescription: e.target.value })} placeholder="Twp/Section/Range" /></Field>
          <Field label="UTM Coordinates"><TextInput value={ics209.utm} onChange={e => set({ utm: e.target.value })} /></Field>
        </div>
        <Field label="Short Location or Area Description" wide><TextInput value={ics209.shortLocation} onChange={e => set({ shortLocation: e.target.value })} style={{ marginTop: 12 }} /></Field>
        <Field label="Geospatial Data Note" wide><TextInput value={ics209.geospatialNote} onChange={e => set({ geospatialNote: e.target.value })} style={{ marginTop: 12 }} /></Field>
      </Panel>

      <Panel title="Incident Summary" icon={ClipboardList}>
        <Field label="Significant Events for the Time Period Reported" wide><TextArea value={ics209.significantEvents} onChange={e => set({ significantEvents: e.target.value })} style={{ minHeight: 70 }} /></Field>
        <Field label="Primary Materials or Hazards Involved" wide><TextInput value={ics209.primaryMaterials} onChange={e => set({ primaryMaterials: e.target.value })} style={{ marginTop: 12 }} /></Field>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Damage Assessment — Structural Summary</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
              <th style={{ ...cell, textAlign: "left" }}>Category</th>
              <th style={{ ...cell, width: 100, whiteSpace: "nowrap" }}># Threatened (72hr)</th>
              <th style={{ ...cell, width: 100, whiteSpace: "nowrap" }}># Damaged</th>
              <th style={{ ...cell, width: 100, whiteSpace: "nowrap" }}># Destroyed</th>
            </tr></thead>
            <tbody>
              {STRUCTURAL_ROWS.map(([key, label]) => (
                <tr key={key} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}>{label}</td>
                  <td style={cell}><TextInput value={ics209.structural[key].threatened} onChange={e => setNested("structural", key, "threatened", e.target.value)} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={ics209.structural[key].damaged} onChange={e => setNested("structural", key, "damaged", e.target.value)} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={ics209.structural[key].destroyed} onChange={e => setNested("structural", key, "destroyed", e.target.value)} style={{ width: 90 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Field label="Other Damage Notes" wide><TextInput value={ics209.damageOther} onChange={e => set({ damageOther: e.target.value })} style={{ marginTop: 12 }} /></Field>
      </Panel>

      <Panel title="Page 2 · Public Status Summary" icon={ClipboardList}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
              <th style={{ ...cell, textAlign: "left" }}>Category</th>
              <th style={{ ...cell, width: 100, whiteSpace: "nowrap" }}># This Period</th>
              <th style={{ ...cell, width: 110, whiteSpace: "nowrap" }}>Total # to Date</th>
            </tr></thead>
            <tbody>
              {PUBLIC_STATUS_ROWS.map(([key, label]) => (
                <tr key={key} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}>{label}</td>
                  <td style={cell}><TextInput value={ics209.publicStatus[key].period} onChange={e => setNested("publicStatus", key, "period", e.target.value)} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={ics209.publicStatus[key].total} onChange={e => setNested("publicStatus", key, "total", e.target.value)} style={{ width: 90 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Responder Status Summary" icon={ClipboardList}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
              <th style={{ ...cell, textAlign: "left" }}>Category</th>
              <th style={{ ...cell, width: 100, whiteSpace: "nowrap" }}># This Period</th>
              <th style={{ ...cell, width: 110, whiteSpace: "nowrap" }}>Total # to Date</th>
            </tr></thead>
            <tbody>
              {RESPONDER_STATUS_ROWS.map(([key, label]) => (
                <tr key={key} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}>{label}</td>
                  <td style={cell}><TextInput value={ics209.responderStatus[key].period} onChange={e => setNested("responderStatus", key, "period", e.target.value)} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={ics209.responderStatus[key].total} onChange={e => setNested("responderStatus", key, "total", e.target.value)} style={{ width: 90 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Life, Safety, and Health" icon={AlertTriangle}>
        <Field label="Status/Threat Remarks" wide><TextArea value={ics209.threatRemarks} onChange={e => set({ threatRemarks: e.target.value })} style={{ minHeight: 60 }} /></Field>
        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Threat Management (check if active)</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
          {THREAT_FLAG_OPTIONS.map(([key, label]) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={ics209.threatFlags[key]} onChange={() => toggleFlag(key)} style={{ width: 16, height: 16 }} />
              {label}
            </label>
          ))}
        </div>
        <Field label="Weather Concerns" wide><TextArea value={ics209.weatherConcerns} onChange={e => set({ weatherConcerns: e.target.value })} style={{ minHeight: 60, marginTop: 14 }} /></Field>
      </Panel>

      <Panel title="Projected Incident Activity / Movement / Escalation" icon={ClipboardList}>
        {TIMEFRAME_KEYS.map(([key, label]) => (
          <Field key={key} label={label} wide><TextInput value={ics209.projectedActivity[key]} onChange={e => setTimeframe("projectedActivity", key, e.target.value)} style={{ marginBottom: 8 }} /></Field>
        ))}
        <Field label="Strategic Objectives (planned end-state)" wide><TextArea value={ics209.strategicObjectives} onChange={e => set({ strategicObjectives: e.target.value })} style={{ minHeight: 60 }} /></Field>
      </Panel>

      <Panel title="Page 3 · Current Incident Threat Summary" icon={AlertTriangle}>
        {TIMEFRAME_KEYS.map(([key, label]) => (
          <Field key={key} label={label} wide><TextInput value={ics209.threatSummaryTimeframes[key]} onChange={e => setTimeframe("threatSummaryTimeframes", key, e.target.value)} style={{ marginBottom: 8 }} /></Field>
        ))}
      </Panel>

      <Panel title="Critical Resource Needs" icon={Truck}>
        {TIMEFRAME_KEYS.map(([key, label]) => (
          <Field key={key} label={label} wide><TextInput value={ics209.resourceNeeds[key]} onChange={e => setTimeframe("resourceNeeds", key, e.target.value)} style={{ marginBottom: 8 }} /></Field>
        ))}
      </Panel>

      <Panel title="Strategic Discussion & Planning" icon={ClipboardList}>
        <Field label="Strategic Discussion" wide><TextArea value={ics209.strategicDiscussion} onChange={e => set({ strategicDiscussion: e.target.value })} style={{ minHeight: 70 }} /></Field>
        <Field label="Planned Actions for Next Operational Period" wide><TextArea value={ics209.plannedActions} onChange={e => set({ plannedActions: e.target.value })} style={{ minHeight: 60, marginTop: 12 }} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
          <Field label="Projected Final Incident Size/Area"><TextInput value={ics209.projectedFinalSize} onChange={e => set({ projectedFinalSize: e.target.value })} /></Field>
          <Field label="Anticipated Management Completion Date"><TextInput type="date" value={ics209.completionDate} onChange={e => set({ completionDate: e.target.value })} /></Field>
          <Field label="Projected Demob Start Date"><TextInput type="date" value={ics209.demobStartDate} onChange={e => set({ demobStartDate: e.target.value })} /></Field>
          <Field label="Estimated Incident Costs to Date"><TextInput value={ics209.costsToDate} onChange={e => set({ costsToDate: e.target.value })} /></Field>
          <Field label="Projected Final Incident Cost Estimate"><TextInput value={ics209.finalCostEstimate} onChange={e => set({ finalCostEstimate: e.target.value })} /></Field>
        </div>
        <Field label="Remarks" wide><TextArea value={ics209.remarks} onChange={e => set({ remarks: e.target.value })} style={{ minHeight: 60, marginTop: 12 }} /></Field>
      </Panel>

      <Panel title="Page 4 · Incident Resource Commitment Summary" icon={Truck} right={<Btn kind="subtle" icon={Plus} onClick={addCommitment}>Add Row</Btn>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
              <th style={{ ...cell, width: 140, whiteSpace: "nowrap" }}>Agency/Organization</th>
              <th style={{ ...cell, width: 200, whiteSpace: "nowrap" }}>Resources (category/kind/type)</th>
              <th style={{ ...cell, width: 90, whiteSpace: "nowrap" }}>Additional Personnel</th>
              <th style={{ ...cell, width: 90, whiteSpace: "nowrap" }}>Total Personnel</th>
              <th style={{ ...cell, width: 90, whiteSpace: "nowrap" }}>Total Resources</th>
              <th style={{ ...cell, width: 30 }}></th>
            </tr></thead>
            <tbody>
              {ics209.resourceCommitments.map(r => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}><TextInput value={r.agency} onChange={e => updateCommitment(r.id, { agency: e.target.value })} style={{ width: 140 }} /></td>
                  <td style={cell}><TextInput value={r.resources} onChange={e => updateCommitment(r.id, { resources: e.target.value })} style={{ width: 200 }} placeholder="e.g. Type 1 Engines 3/12" /></td>
                  <td style={cell}><TextInput value={r.additionalPersonnel} onChange={e => updateCommitment(r.id, { additionalPersonnel: e.target.value })} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={r.totalPersonnel} onChange={e => updateCommitment(r.id, { totalPersonnel: e.target.value })} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={r.totalResources} onChange={e => updateCommitment(r.id, { totalResources: e.target.value })} style={{ width: 90 }} /></td>
                  <td style={cell}><button onClick={() => removeCommitment(r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ics209.resourceCommitments.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
        <Field label="Additional Cooperating and Assisting Organizations Not Listed Above" wide><TextArea value={ics209.cooperatingOrgs} onChange={e => set({ cooperatingOrgs: e.target.value })} style={{ minHeight: 50, marginTop: 12 }} /></Field>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: ICS-206 · MEDICAL PLAN
   ============================================================ */
function Tab206({ ics206, setIcs206, incident }) {
  const cell = { padding: "6px 6px", fontSize: 12.5 };
  const addRow = (key, row) => setIcs206({ ...ics206, [key]: [...ics206[key], row] });
  const updateRow = (key, id, patch) => setIcs206({ ...ics206, [key]: ics206[key].map(r => r.id === id ? { ...r, ...patch } : r) });
  const removeRow = (key, id) => setIcs206({ ...ics206, [key]: ics206[key].filter(r => r.id !== id) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-206 · Medical Plan" icon={HeartPulse}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
            <Field label="Operational Period From"><TextInput type="datetime-local" value={ics206.opFrom} onChange={e => setIcs206({ ...ics206, opFrom: e.target.value })} /></Field>
            <Field label="Operational Period To"><TextInput type="datetime-local" value={ics206.opTo} onChange={e => setIcs206({ ...ics206, opTo: e.target.value })} /></Field>
          </div>
        </div>
      </Panel>

      <Panel title="3. Medical Aid Stations" icon={HeartPulse}
        right={<Btn kind="subtle" icon={Plus} onClick={() => addRow("aidStations", { id: uid(), name: "", location: "", contact: "", paramedic: "No" })}>Add Station</Btn>}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Name</th><th style={cell}>Location</th><th style={cell}>Contact Number(s)/Frequency</th><th style={cell}>Paramedics On Site?</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {ics206.aidStations.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.name} onChange={e => updateRow("aidStations", r.id, { name: e.target.value })} style={{ width: 130 }} /></td>
                <td style={cell}><TextInput value={r.location} onChange={e => updateRow("aidStations", r.id, { location: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}><TextInput value={r.contact} onChange={e => updateRow("aidStations", r.id, { contact: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}>
                  <Select value={r.paramedic} onChange={e => updateRow("aidStations", r.id, { paramedic: e.target.value })} style={{ width: 90 }}>
                    <option>Yes</option><option>No</option>
                  </Select>
                </td>
                <td style={cell}><button onClick={() => removeRow("aidStations", r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {ics206.aidStations.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="4. Transportation (Ambulance Services)" icon={Truck}
        right={<Btn kind="subtle" icon={Plus} onClick={() => addRow("ambulances", { id: uid(), name: "", location: "", contact: "", level: "ALS" })}>Add Service</Btn>}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Ambulance Service</th><th style={cell}>Location</th><th style={cell}>Contact Number(s)/Frequency</th><th style={cell}>Level of Service</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {ics206.ambulances.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.name} onChange={e => updateRow("ambulances", r.id, { name: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}><TextInput value={r.location} onChange={e => updateRow("ambulances", r.id, { location: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}><TextInput value={r.contact} onChange={e => updateRow("ambulances", r.id, { contact: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}>
                  <Select value={r.level} onChange={e => updateRow("ambulances", r.id, { level: e.target.value })} style={{ width: 90 }}>
                    <option>ALS</option><option>BLS</option>
                  </Select>
                </td>
                <td style={cell}><button onClick={() => removeRow("ambulances", r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {ics206.ambulances.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="5. Hospitals" icon={Shield}
        right={<Btn kind="subtle" icon={Plus} onClick={() => addRow("hospitals", { id: uid(), name: "", address: "", contact: "", travelAir: "", travelGround: "", trauma: "No", traumaLevel: "", burn: "No", helipad: "No" })}>Add Hospital</Btn>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
              <th style={cell}>Hospital Name</th><th style={cell}>Address / Lat-Long if Helipad</th><th style={cell}>Contact</th>
              <th style={cell}>Travel (Air)</th><th style={cell}>Travel (Ground)</th><th style={cell}>Trauma Ctr</th><th style={cell}>Burn Ctr</th><th style={cell}>Helipad</th><th style={cell}></th>
            </tr></thead>
            <tbody>
              {ics206.hospitals.map(r => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}><TextInput value={r.name} onChange={e => updateRow("hospitals", r.id, { name: e.target.value })} style={{ width: 130 }} /></td>
                  <td style={cell}><TextInput value={r.address} onChange={e => updateRow("hospitals", r.id, { address: e.target.value })} style={{ width: 160 }} /></td>
                  <td style={cell}><TextInput value={r.contact} onChange={e => updateRow("hospitals", r.id, { contact: e.target.value })} style={{ width: 110 }} /></td>
                  <td style={cell}><TextInput value={r.travelAir} onChange={e => updateRow("hospitals", r.id, { travelAir: e.target.value })} style={{ width: 80 }} placeholder="12 min" /></td>
                  <td style={cell}><TextInput value={r.travelGround} onChange={e => updateRow("hospitals", r.id, { travelGround: e.target.value })} style={{ width: 80 }} placeholder="20 min" /></td>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: 4 }}>
                      <Select value={r.trauma} onChange={e => updateRow("hospitals", r.id, { trauma: e.target.value })} style={{ width: 65 }}>
                        <option>Yes</option><option>No</option>
                      </Select>
                      {r.trauma === "Yes" && <TextInput value={r.traumaLevel} onChange={e => updateRow("hospitals", r.id, { traumaLevel: e.target.value })} style={{ width: 55 }} placeholder="Lvl" />}
                    </div>
                  </td>
                  <td style={cell}>
                    <Select value={r.burn} onChange={e => updateRow("hospitals", r.id, { burn: e.target.value })} style={{ width: 75 }}>
                      <option>Yes</option><option>No</option>
                    </Select>
                  </td>
                  <td style={cell}>
                    <Select value={r.helipad} onChange={e => updateRow("hospitals", r.id, { helipad: e.target.value })} style={{ width: 75 }}>
                      <option>Yes</option><option>No</option>
                    </Select>
                  </td>
                  <td style={cell}><button onClick={() => removeRow("hospitals", r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ics206.hospitals.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="6. Special Medical Emergency Procedures" icon={HeartPulse}>
        <Field label="Special Medical Emergency Procedures" wide>
          <TextArea value={ics206.procedures} onChange={e => setIcs206({ ...ics206, procedures: e.target.value })} style={{ minHeight: 70 }}
            placeholder="Who to contact, how to contact them, who manages an incident-within-an-incident (rescue, accident, etc.)..." />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={ics206.aviationAssets} onChange={e => setIcs206({ ...ics206, aviationAssets: e.target.checked })} style={{ width: 18, height: 18 }} />
          Check if aviation assets are utilized for rescue (coordinate with Air Operations)
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginTop: 16 }}>
          <Field label="7. Prepared By (Medical Unit Leader)"><TextInput value={ics206.preparedBy} onChange={e => setIcs206({ ...ics206, preparedBy: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={ics206.preparedSignature} onChange={e => setIcs206({ ...ics206, preparedSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={ics206.dateTime} onChange={e => setIcs206({ ...ics206, dateTime: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginTop: 12 }}>
          <Field label="8. Approved By (Safety Officer)"><TextInput value={ics206.approvedBy} onChange={e => setIcs206({ ...ics206, approvedBy: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={ics206.approvedSignature} onChange={e => setIcs206({ ...ics206, approvedSignature: e.target.value })} placeholder="Type name to sign" /></Field>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: ICS FORMS — dropdown selector wrapping 205 / 215A / 208 /
   208 HM / 209 / 206 / 214 so they share one tab slot instead of
   six separate tabs across the header.
   ============================================================ */
// Full, officially-numbered ICS-201 (blocks 1-10 per the FEMA form),
// as distinct from the streamlined "Tactical Worksheet" tab — both
// read/write the same underlying incident fields, so filling in one
// updates the other. This is the one that includes the Resource
// Summary table (Block 10), matching the official form exactly.
function Tab201Full({ incident, setIncident, org, objectivesByType, onAddObjective, incidentTypePresets }) {
  const updateObjective = (i, val) => {
    const next = [...incident.objectives]; next[i] = val;
    setIncident({ ...incident, objectives: next });
  };
  const addObjective = () => setIncident({ ...incident, objectives: [...incident.objectives, ""] });
  const removeObjective = (i) => setIncident({ ...incident, objectives: incident.objectives.filter((_, idx) => idx !== i) });
  const relevantObjectives = objectivesByType[incident.type] || [];
  const addObjectiveFromPreset = (text) => setIncident({ ...incident, objectives: mergeObjectivesIntoList(incident.objectives, [text]) });

  const addAction = () => setIncident({ ...incident, actionsLog: [...incident.actionsLog, { id: uid(), time: "", actions: "" }] });
  const updateAction = (id, patch) => setIncident({ ...incident, actionsLog: incident.actionsLog.map(a => a.id === id ? { ...a, ...patch } : a) });
  const removeAction = (id) => setIncident({ ...incident, actionsLog: incident.actionsLog.filter(a => a.id !== id) });

  const addOrder = () => setIncident({ ...incident, resourceOrders: [...incident.resourceOrders, { id: uid(), resource: "", identifier: "", ordered: "", eta: "", arrived: false, notes: "" }] });
  const updateOrder = (id, patch) => setIncident({ ...incident, resourceOrders: incident.resourceOrders.map(r => r.id === id ? { ...r, ...patch } : r) });
  const removeOrder = (id) => setIncident({ ...incident, resourceOrders: incident.resourceOrders.filter(r => r.id !== id) });

  const cell = { padding: "6px 6px", fontSize: 12.5, verticalAlign: "top" };
  const orgLines = flattenOrgFilled(org).map(item => `${"  ".repeat(item.depth || 0)}${item.title}: ${item.name}`);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-201 · Incident Briefing (Official Form)" icon={ClipboardList}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          <Field label="1. Incident Name"><TextInput value={incident.name} onChange={e => setIncident({ ...incident, name: e.target.value })} /></Field>
          <Field label="2. Incident Number"><TextInput value={incident.number} onChange={e => setIncident({ ...incident, number: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginTop: 14 }}>
          <Field label="3. Date Initiated"><TextInput type="date" value={incident.dateInitiated} onChange={e => setIncident({ ...incident, dateInitiated: e.target.value })} /></Field>
          <Field label="Time Initiated"><TextInput type="time" value={incident.timeInitiated} onChange={e => setIncident({ ...incident, timeInitiated: e.target.value })} /></Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="4. Map/Sketch (perimeter, resource assignments, incident facilities — attach separately or describe here)" wide>
            <TextArea value={incident.mapSketch || ""} onChange={e => setIncident({ ...incident, mapSketch: e.target.value })} style={{ minHeight: 70 }} />
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="5. Situation Summary and Health and Safety Briefing" wide>
            <TextArea value={incident.situation} onChange={e => setIncident({ ...incident, situation: e.target.value })} style={{ minHeight: 90 }} />
          </Field>
        </div>
        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>6. Prepared By</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
          <Field label="Name"><TextInput value={incident.preparedBy} onChange={e => setIncident({ ...incident, preparedBy: e.target.value })} /></Field>
          <Field label="Position / Title"><TextInput value={incident.prepPosition} onChange={e => setIncident({ ...incident, prepPosition: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={incident.prepSignature} onChange={e => setIncident({ ...incident, prepSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={incident.prepDateTime} onChange={e => setIncident({ ...incident, prepDateTime: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="7. Current and Planned Objectives" icon={ClipboardList} right={
        <ObjectivePickerDropdown incidentType={incident.type} objectivesByType={objectivesByType} onPick={addObjectiveFromPreset} />
      }>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {incident.objectives.map((o, i) => {
            const isNewObjective = o.trim() && !relevantObjectives.includes(o.trim());
            return (
              <div key={i} style={{ display: "flex", gap: 8 }}>
                <span style={{ width: 22, textAlign: "right", color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, paddingTop: 9 }}>{i + 1}.</span>
                <TextInput list="objective-presets" value={o} onChange={e => updateObjective(i, e.target.value)} style={{ flex: 1 }} placeholder="Objective..." />
                {isNewObjective && (
                  <button onClick={() => onAddObjective(incident.type, o.trim())} title={`Save as a quick-pick objective for ${incident.type || "this type"}`} style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 4, color: COLORS.amber, cursor: "pointer", padding: "0 8px" }}>
                    <Star size={14} />
                  </button>
                )}
                <Btn kind="danger" onClick={() => removeObjective(i)}><Trash2 size={14} /></Btn>
              </div>
            );
          })}
          <datalist id="objective-presets">{relevantObjectives.map(p => <option key={p} value={p} />)}</datalist>
          <Btn kind="subtle" icon={Plus} onClick={addObjective} style={{ alignSelf: "flex-start" }}>Add Objective</Btn>
        </div>
      </Panel>

      <Panel title="8. Current and Planned Actions, Strategies, and Tactics" icon={ClipboardList} right={<Btn kind="subtle" icon={Plus} onClick={addAction}>Add Entry</Btn>}>
        {incident.actionsLog.map(a => (
          <div key={a.id} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <TextInput type="time" value={a.time} onChange={e => updateAction(a.id, { time: e.target.value })} style={{ width: 130 }} />
            <TextInput value={a.actions} onChange={e => updateAction(a.id, { actions: e.target.value })} placeholder="Actions..." style={{ flex: 1 }} />
            <button onClick={() => removeAction(a.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
          </div>
        ))}
        {incident.actionsLog.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="9. Current Organization" icon={Users}>
        {orgLines.length === 0
          ? <div style={{ fontSize: 13, color: COLORS.faint }}>None entered — fill in on the Org Chart tab.</div>
          : <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>{orgLines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </Panel>

      <Panel title="10. Resource Summary" icon={Truck} right={<Btn kind="subtle" icon={Plus} onClick={addOrder}>Add Resource</Btn>}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Resource</th><th style={cell}>Resource Identifier</th><th style={cell}>Date/Time Ordered</th>
            <th style={cell}>ETA</th><th style={cell}>Arrived</th><th style={cell}>Notes (location/assignment/status)</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {incident.resourceOrders.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.resource} onChange={e => updateOrder(r.id, { resource: e.target.value })} style={{ width: 130 }} /></td>
                <td style={cell}><TextInput value={r.identifier} onChange={e => updateOrder(r.id, { identifier: e.target.value })} style={{ width: 110 }} /></td>
                <td style={cell}><TextInput type="datetime-local" value={r.ordered} onChange={e => updateOrder(r.id, { ordered: e.target.value })} style={{ width: 170 }} /></td>
                <td style={cell}><TextInput type="time" value={r.eta} onChange={e => updateOrder(r.id, { eta: e.target.value })} style={{ width: 110 }} /></td>
                <td style={cell}>
                  <input type="checkbox" checked={r.arrived} onChange={e => updateOrder(r.id, { arrived: e.target.checked })} style={{ width: 18, height: 18 }} />
                </td>
                <td style={cell}><TextInput value={r.notes} onChange={e => updateOrder(r.id, { notes: e.target.value })} style={{ width: 180 }} /></td>
                <td style={cell}><button onClick={() => removeOrder(r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {incident.resourceOrders.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>
    </div>
  );
}

const ICS_FORM_OPTIONS = [
  { k: "201full", label: "ICS-201 · Incident Briefing" },
  { k: "205", label: "ICS-205 · Communications Plan" },
  { k: "215a", label: "ICS-215A · Safety Analysis" },
  { k: "208", label: "ICS-208 · Safety Message/Plan" },
  { k: "208hm", label: "ICS-208 HM · Site Safety Plan (HazMat)" },
  { k: "209", label: "ICS-209 · Incident Status Summary" },
  { k: "206", label: "ICS-206 · Medical Plan" },
  { k: "214", label: "ICS-214 · Activity Logs" },
];

function TabICSForms(props) {
  const [selected, setSelected] = useState("201full");
  const { formsUsed, toggleFormUsed } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Forms in Use" icon={CheckCircle2}>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Check the additional forms this incident is using — they're included in Print/Export alongside the always-included Tactical Worksheet info. Click a form's name to open and edit it below.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ICS_FORM_OPTIONS.map(o => {
            const isSelected = selected === o.k;
            const isUsed = !!formsUsed[o.k];
            const alwaysIncluded = o.k === "201full";
            return (
              <div key={o.k} style={{
                display: "flex", alignItems: "center", gap: 7, padding: "7px 11px", borderRadius: 5,
                background: isSelected ? COLORS.panel2 : "transparent",
                border: `1px solid ${isSelected ? COLORS.amber : COLORS.line}`,
              }}>
                {alwaysIncluded
                  ? <CheckCircle2 size={16} color={COLORS.muted} style={{ flexShrink: 0 }} />
                  : <input type="checkbox" checked={isUsed} onChange={() => toggleFormUsed(o.k)} style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }} />}
                <span onClick={() => setSelected(o.k)} style={{ fontSize: 12.5, cursor: "pointer", color: alwaysIncluded || isUsed ? COLORS.text : COLORS.muted, whiteSpace: "nowrap" }}>
                  {o.label}{alwaysIncluded && <span style={{ color: COLORS.faint, fontSize: 11 }}> (always included)</span>}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      {selected === "201full" && <Tab201Full incident={props.incident} setIncident={props.setIncident} org={props.org} objectivesByType={props.objectivesByType} onAddObjective={props.onAddObjective} incidentTypePresets={props.incidentTypePresets} />}
      {selected === "205" && <TabComms comms={props.comms} setComms={props.setComms} incident={props.incident} />}
      {selected === "215a" && <Tab215A safety={props.safety} setSafety={props.setSafety} org={props.org} incident={props.incident} />}
      {selected === "208" && <Tab208 ics208={props.ics208} setIcs208={props.setIcs208} incident={props.incident} />}
      {selected === "208hm" && <Tab208HM ics208hm={props.ics208hm} setIcs208hm={props.setIcs208hm} incident={props.incident} mapData={props.mapData} />}
      {selected === "209" && <Tab209 ics209={props.ics209} setIcs209={props.setIcs209} incident={props.incident} mapData={props.mapData} />}
      {selected === "206" && <Tab206 ics206={props.ics206} setIcs206={props.setIcs206} incident={props.incident} />}
      {selected === "214" && <Tab214 logs={props.logs} setLogs={props.setLogs} />}
    </div>
  );
}

const MAX_ATTACHMENT_BYTES = 700 * 1024; // ~700KB raw — base64 inflates
// this ~33%, keeping each attachment document safely under Firestore's
// 1MB-per-document cap with room for metadata overhead.

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function downloadAttachmentFile(a) {
  const byteChars = atob(a.dataBase64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], { type: a.type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = a.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function TabAttachments({ attachments, onUpload, onDelete }) {
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const handleFiles = async (files) => {
    setError("");
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_ATTACHMENT_BYTES)}. Try a smaller photo or a compressed file.`);
        continue;
      }
      setUploading(true);
      try {
        await onUpload(file);
      } catch {
        setError(`Failed to upload "${file.name}".`);
      }
      setUploading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Attachments" icon={Paperclip}
        right={
          <>
            <input ref={fileInputRef} type="file" multiple style={{ display: "none" }}
              onChange={e => { handleFiles(Array.from(e.target.files)); e.target.value = ""; }} />
            <Btn kind="subtle" icon={Plus} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Add File"}
            </Btn>
          </>
        }>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 12, lineHeight: 1.5 }}>
          Photos and documents attached to this incident — included in Print/Export (photos embed directly as pages; other file types are listed by name). Limit {fmtBytes(MAX_ATTACHMENT_BYTES)} per file.
        </div>
        {error && <div style={{ color: COLORS.dangerText, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        {attachments.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No attachments yet.</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
          {attachments.map(a => {
            const isImage = (a.type || "").startsWith("image/");
            return (
              <div key={a.id} style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {isImage ? (
                  <img src={`data:${a.type};base64,${a.dataBase64}`} alt={a.name} style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 4 }} />
                ) : (
                  <div style={{ width: "100%", height: 100, display: "flex", alignItems: "center", justifyContent: "center", background: COLORS.panel, borderRadius: 4 }}>
                    <FileText size={32} color={COLORS.muted} />
                  </div>
                )}
                <div style={{ fontSize: 12, fontWeight: 600, wordBreak: "break-word" }}>{a.name}</div>
                <div style={{ fontSize: 10.5, color: COLORS.muted }}>{fmtBytes(a.size || 0)} · {fmtDate(a.uploadedAt)}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn kind="subtle" onClick={() => downloadAttachmentFile(a)} style={{ flex: 1, justifyContent: "center", padding: "5px 8px", fontSize: 11.5 }}>Download</Btn>
                  <button onClick={() => onDelete(a.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function Tab214({ logs, setLogs }) {
  const [activeLog, setActiveLog] = useState(logs[0]?.id || null);
  useEffect(() => { if (!logs.find(l => l.id === activeLog)) setActiveLog(logs[0]?.id || null); }, [logs]);

  const addLog = () => {
    const l = { id: uid(), name: "", position: "", agency: "", entries: [] };
    setLogs([...logs, l]); setActiveLog(l.id);
  };
  const updateLog = (id, patch) => setLogs(logs.map(l => l.id === id ? { ...l, ...patch } : l));
  const removeLog = (id) => setLogs(logs.filter(l => l.id !== id));
  const addEntry = (id) => updateLog(id, { entries: [{ id: uid(), time: nowISO(), text: "" }, ...(logs.find(l => l.id === id)?.entries || [])] });
  const updateEntry = (logId, entryId, patch) => {
    const log = logs.find(l => l.id === logId);
    updateLog(logId, { entries: log.entries.map(e => e.id === entryId ? { ...e, ...patch } : e) });
  };
  const removeEntry = (logId, entryId) => {
    const log = logs.find(l => l.id === logId);
    updateLog(logId, { entries: log.entries.filter(e => e.id !== entryId) });
  };

  const log = logs.find(l => l.id === activeLog);

  return (
    <Panel title="ICS-214 · Unit / Activity Log" icon={ClipboardList} right={<Btn kind="subtle" icon={Plus} onClick={addLog}>New Log</Btn>}>
      {logs.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No activity logs yet. Add one per unit, position, or individual.</div>}
      {logs.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {logs.map(l => (
              <button key={l.id} onClick={() => setActiveLog(l.id)} style={{
                padding: "6px 11px", borderRadius: 4, fontSize: 12.5, cursor: "pointer",
                background: activeLog === l.id ? COLORS.red : COLORS.panel2,
                color: activeLog === l.id ? "#fff" : COLORS.text,
                border: `1px solid ${activeLog === l.id ? COLORS.red : COLORS.line}`,
              }}>{l.name || l.position || "Untitled Log"}</button>
            ))}
          </div>
          {log && (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr)) auto", gap: 10, marginBottom: 14 }}>
                <Field label="Name"><TextInput value={log.name} onChange={e => updateLog(log.id, { name: e.target.value })} /></Field>
                <Field label="ICS Position"><TextInput value={log.position} onChange={e => updateLog(log.id, { position: e.target.value })} /></Field>
                <Field label="Home Agency"><TextInput value={log.agency} onChange={e => updateLog(log.id, { agency: e.target.value })} /></Field>
                <div style={{ display: "flex", alignItems: "end" }}><Btn kind="danger" icon={Trash2} onClick={() => removeLog(log.id)}>Delete Log</Btn></div>
              </div>
              <Btn kind="subtle" icon={Plus} onClick={() => addEntry(log.id)} style={{ marginBottom: 10 }}>Add Entry</Btn>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {log.entries.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No entries logged.</div>}
                {log.entries.map(e => (
                  <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "start" }}>
                    <TextInput type="time" step="1" value={new Date(e.time).toTimeString().slice(0, 8)}
                      onChange={ev => {
                        const [h, m, s] = ev.target.value.split(":").map(Number);
                        const d = new Date(e.time); d.setHours(h || 0, m || 0, s || 0);
                        updateEntry(log.id, e.id, { time: d.toISOString() });
                      }}
                      style={{ width: 110, fontFamily: "'IBM Plex Mono', monospace" }} />
                    <TextInput value={e.text} onChange={ev => updateEntry(log.id, e.id, { text: ev.target.value })} placeholder="Notable activity..." style={{ flex: 1 }} />
                    <button onClick={() => removeEntry(log.id, e.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer", paddingTop: 8 }}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/* ============================================================
   TAB: ICS-215A INCIDENT SAFETY ANALYSIS
   ============================================================ */
function Tab215A({ safety, setSafety, org, incident }) {
  const addRow = () => setSafety({ ...safety, rows: [{ id: uid(), branch: "", division: "", hazards: "", mitigations: "" }, ...safety.rows] });
  const update = (id, patch) => setSafety({ ...safety, rows: safety.rows.map(r => r.id === id ? { ...r, ...patch } : r) });
  const remove = (id) => setSafety({ ...safety, rows: safety.rows.filter(r => r.id !== id) });
  const divisionOptions = flattenOrgTitles(org);
  const cell = { padding: "6px 6px", fontSize: 12.5, verticalAlign: "top" };

  return (
    <Panel title="ICS-215A · Incident Action Plan Safety Analysis" icon={AlertTriangle} right={<Btn kind="subtle" icon={Plus} onClick={addRow}>Add Hazard</Btn>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
        <Field label="Incident Number"><TextInput value={incident.number} disabled style={{ opacity: 0.65 }} /></Field>
      </div>

      <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Operational Period</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 18 }}>
        <Field label="Date / Time From"><TextInput type="datetime-local" value={safety.opFrom} onChange={e => setSafety({ ...safety, opFrom: e.target.value })} /></Field>
        <Field label="Date / Time To"><TextInput type="datetime-local" value={safety.opTo} onChange={e => setSafety({ ...safety, opTo: e.target.value })} /></Field>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5, letterSpacing: "0.05em" }}>
              <th style={cell}>Branch</th>
              <th style={cell}>Division / Group</th>
              <th style={cell}>Hazards / Risks</th>
              <th style={cell}>Mitigations for Identified Hazards</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {safety.rows.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.branch} onChange={e => update(r.id, { branch: e.target.value })} style={{ width: 95 }} placeholder="Branch I" /></td>
                <td style={cell}>
                  <input list="cb-div-options" value={r.division} onChange={e => update(r.id, { division: e.target.value })}
                    style={{ ...inputStyle, width: 115 }} placeholder="Div A" />
                </td>
                <td style={cell}><TextArea value={r.hazards} onChange={e => update(r.id, { hazards: e.target.value })} style={{ minHeight: 50, width: 205 }} placeholder="Falling debris, flashover potential, unstable structure..." /></td>
                <td style={cell}><TextArea value={r.mitigations} onChange={e => update(r.id, { mitigations: e.target.value })} style={{ minHeight: 50, width: 205 }} placeholder="Full PPE, RIC in place, 2-in/2-out, monitor radio traffic..." /></td>
                <td style={cell}><button onClick={() => remove(r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="cb-div-options">{divisionOptions.map(d => <option key={d} value={d} />)}</datalist>
        {safety.rows.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>No hazards logged yet. Add one per Division/Group as the risk assessment develops.</div>}
      </div>

      <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "20px 0 8px" }}>Prepared By (Safety Officer)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
        <Field label="Name"><TextInput value={safety.preparedBy} onChange={e => setSafety({ ...safety, preparedBy: e.target.value })} placeholder={org.commandStaff.find(c => c.title === "Safety Officer")?.name || "Name"} /></Field>
        <Field label="Position / Title"><TextInput value={safety.position} onChange={e => setSafety({ ...safety, position: e.target.value })} placeholder="Safety Officer" /></Field>
        <Field label="Signature"><TextInput value={safety.signature} onChange={e => setSafety({ ...safety, signature: e.target.value })} placeholder="Type name to sign" /></Field>
        <Field label="Date / Time"><TextInput type="datetime-local" value={safety.dateTime} onChange={e => setSafety({ ...safety, dateTime: e.target.value })} /></Field>
      </div>
    </Panel>
  );
}

/* ============================================================
   PRINT VIEWS
   ============================================================ */
/* ============================================================
   EXPORT — builds a self-contained HTML packet and downloads it.
   window.print() is unreliable from inside the sandboxed frame
   artifacts run in, so this sidesteps that: the file opens and
   prints normally in any regular browser tab.
   ============================================================ */
function pdfEscape(str) {
  return String(str ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00B7\u2022]/g, "-")
    // A true "°" glyph isn't safely achievable here — this hand-built
    // PDF's fonts declare no /Encoding, and the byte-assembly path
    // below would UTF-8-encode the character into two bytes rather
    // than the single WinAnsiEncoding byte a real degree sign would
    // need, risking garbled output rather than fixing it. Dropped
    // entirely rather than substituted — "98.6°F" becomes "98.6F",
    // which reads cleanly on its own without needing a stand-in
    // character in its place.
    .replace(/\u00B0/g, "")
    .replace(/\t/g, "  ")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}
const AVG_CHAR_W = { H: 0.5, HB: 0.54 };
function fitText(str, font, size, maxWidth) {
  let s = String(str ?? "").replace(/\s+/g, " ").trim();
  const w = AVG_CHAR_W[font] || 0.5;
  const maxChars = Math.max(1, Math.floor(maxWidth / (size * w)));
  if (s.length > maxChars) s = s.slice(0, Math.max(1, maxChars - 3)) + "...";
  return s;
}
function wrapPush(L, text, width = 100) {
  const words = String(text || "-").split(/\s+/);
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      L.push({ kind: "text", text: line, font: "H", size: 9 });
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) L.push({ kind: "text", text: line, font: "H", size: 9 });
}
function tableLines(headers, colWidths, rows, title) {
  const lines = [];
  if (title) lines.push({ kind: "heading", text: title });
  const xOffsets = [];
  let acc = 0;
  colWidths.forEach(w => { xOffsets.push(acc); acc += w; });
  const totalWidth = acc;
  const toRow = (cells, font, size) => ({
    kind: "row", font, size,
    // A cell is normally a plain string (truncated to fit via
    // fitText, as before). It can also be an array of {text, bold}
    // segments for mixed-weight text within one cell (e.g. bold
    // vitals labels with regular-weight values) — segmented cells
    // skip fitText, since truncating mid-segment isn't meaningful;
    // callers using this are expected to size the column generously.
    cells: cells.map((c, i) => Array.isArray(c)
      ? { segments: c, x: xOffsets[i] }
      : { text: fitText(c, font, size, colWidths[i] - 6), x: xOffsets[i] }),
  });
  lines.push(toRow(headers, "HB", 9));
  lines.push({ kind: "rule", width: totalWidth, color: "light" });
  if (rows.length === 0) {
    lines.push({ kind: "text", text: "(none entered)", font: "H", size: 9 });
  } else {
    rows.forEach(cells => lines.push(toRow(cells, "H", 9)));
  }
  lines.push({ kind: "text", text: "", font: "H", size: 9 });
  return lines;
}

// A "heading" line renders bold + a full-width light rule beneath it,
// giving the report real section breaks instead of plain bold text.
function heading(L, text) {
  L.push({ kind: "heading", text });
}

// Compact time formatters for the PDF specifically — the on-screen
// fmtTime() includes seconds (e.g. "10:58:32 PM", 11 chars), which is
// fine in the app's flexible UI but too wide for several fixed-width
// table columns in the hand-built PDF (fitText truncates rather than
// wrapping/overflowing, so a too-narrow column silently clips the
// timestamp — e.g. down to "10:58:..."). Dropping to minute precision
// here keeps every timestamp fully visible without needing every
// column sized to the exact worst case down to the pixel.
const fmtTimeShort = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
// The Resource Summary's "Date/Time Ordered" field is a raw
// datetime-local input value ("YYYY-MM-DDTHH:MM", 16 characters) —
// reformatted to "MM/DD HH:MM" (11 characters), which is both shorter
// and more readable in a table cell than the ISO-ish raw string.
const fmtDateTimeShort = (raw) => {
  if (!raw) return "-";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw; // not a parseable datetime-local value — show as-is rather than hide it
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

function buildPacketLines({ incident, resources, comms, org, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, attachments, orgChartImage, mapData, mapSnapshotImage }) {
  // Older saved/archived incidents predate these forms (or, in the
  // archive-export path, skip the normal load/normalize step
  // entirely) — fall back to blank defaults rather than throwing on
  // a missing field.
  incident = incident || blankIncident();
  resources = resources || [];
  comms = normalizeComms(comms);
  org = normalizeOrg(org);
  safety = safety || { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] };
  ics208 = { ...defaultIcs208(), ...(ics208 || {}) };
  ics208hm = { ...defaultIcs208HM(), ...(ics208hm || {}) };
  ics209 = { ...defaultIcs209(), ...(ics209 || {}) };
  ics206 = { ...defaultIcs206(), ...(ics206 || {}) };
  logs = logs || [];
  rehab = rehab || [];
  attachments = attachments || [];
  // Older saved incidents (or a first export before any form was
  // checked) won't have this — fall back to "everything included"
  // rather than silently producing an empty packet.
  // Strict: a form is included only if its checkbox is actually
  // checked. No "include everything" fallback when nothing's been
  // checked — an untouched checklist means only the always-on
  // Tactical Worksheet / Resource Board / Org Chart content exports,
  // not every optional ICS form by default.
  const include = (key) => !!(formsUsed && formsUsed[key]);
  const L = [];
  const push = (text, font = "H", size = 9) => L.push({ kind: "text", text, font, size });
  const blank = () => push("");

  push(`Incident #: ${incident.number || "-"}   Type: ${incident.type || "-"}`, "H", 10);
  push(`Location: ${incident.location || "-"}`, "H", 10);
  push(`IC: ${incident.icName || "-"}   Prepared By: ${incident.preparedBy || "-"}`, "H", 10);
  push(`Wind: ${incident.wind || "-"}   Temp: ${incident.temp || "-"}   RH: ${incident.rh || "-"}`, "H", 10);
  push(`Conditions: ${incident.conditions || "-"}`, "H", 10);
  blank();

  // Always included, not gated by a checkbox — this is the Tactical
  // Worksheet's own data (same underlying incident fields as the full
  // ICS-201 form), not an optional add-on form like HazMat or Medical.
  heading(L, "ICS-201 · Incident Briefing");
  push(`Date/Time Initiated: ${incident.dateInitiated || "-"} ${incident.timeInitiated || ""}`, "H", 9);
  blank();
  push("Situation Summary and Health/Safety Briefing:", "HB", 9);
  wrapPush(L, incident.situation);
  blank();
  push("Objectives:", "HB", 9);
  const objs = incident.objectives.filter(Boolean);
  if (objs.length === 0) push("(none entered)");
  else objs.forEach((o, i) => wrapPush(L, `${i + 1}. ${o}`));
  blank();
  push("Current and Planned Actions, Strategies, and Tactics:", "HB", 9);
  const strategyLabels = [["strategyOffensive", "Offensive"], ["strategyDefensive", "Defensive"], ["strategyTransitional", "Transitional"], ["strategyInvestigative", "Investigative"]]
    .filter(([key]) => incident[key]).map(([, label]) => label);
  push(`Strategy: ${strategyLabels.length ? strategyLabels.join(", ") : "(none checked)"}`, "H", 9);
  const actionsWithText = (incident.actionsLog || []).filter(a => a.time || a.actions);
  if (actionsWithText.length === 0) push("(none entered)");
  else actionsWithText.forEach(a => wrapPush(L, `${a.time || "-"}: ${a.actions}`));
  blank();
  push(`Prepared By: ${incident.preparedBy || "-"}   Position: ${incident.prepPosition || "-"}`, "H", 9);
  push(`Signature: ${incident.prepSignature || "-"}   Date/Time: ${incident.prepDateTime || "-"}`, "H", 9);
  blank();

  L.push(...tableLines(["RESOURCE", "IDENTIFIER", "ORDERED", "ETA", "ARRIVED", "NOTES"], [80, 80, 70, 60, 55, 220],
    (incident.resourceOrders || []).map(r => [r.resource, r.identifier, fmtDateTimeShort(r.ordered), r.eta, r.arrived ? "X" : "", r.notes]), "10. Resource Summary"));

  L.push(...tableLines(["UNIT", "TYPE", "PERS", "STATUS", "ASSIGNMENT"], [70, 110, 45, 80, 220],
    resources.map(r => [r.label, r.kind, String(r.personnel), r.status, r.assignment]), "Resource Board Status"));

  // parHistory is stored as part of the incident's own saved data
  // (same place as resources, logs, etc.) — one entry per completed
  // PAR or Mayday check, recorded when that session is closed out via
  // "Complete PAR" / "All Clear — End Mayday". Shown as wrapped text
  // rather than a rigid table specifically so the actual unit names
  // can be listed in full rather than truncated to fit a column —
  // and critically, which units were NOT accounted for is called out
  // just as clearly as which ones were, since for a Mayday record
  // specifically that's the more safety-relevant half of the record.
  // Ignored PAR reminders are merged in by actual time rather than
  // listed separately, so a dismissed notification shows up exactly
  // where it happened relative to the checks that were (or weren't)
  // actually taken — matching the same merge the in-app history view
  // uses, so the two never tell a different story.
  L.push({ kind: "heading", text: "PAR / Mayday History" });
  const mergedParHistory = [
    ...(incident.parHistory || []).map(p => ({ ...p, kind: p.type, sortAt: p.completedAt })),
    ...(incident.ignoredParReminders || []).map(r => ({ ...r, kind: "ignored", sortAt: r.at })),
  ].sort((a, b) => new Date(b.sortAt) - new Date(a.sortAt));
  if (mergedParHistory.length === 0) {
    push("(none recorded)");
  } else {
    mergedParHistory.forEach(p => {
      if (p.kind === "ignored") {
        push(`PAR REMINDER IGNORED — ${fmtDateTimeShort(p.at)}`, "HB", 9);
        blank();
        return;
      }
      const label = p.kind === "mayday" ? "MAYDAY" : "PAR";
      push(`${label} — Started ${fmtDateTimeShort(p.startedAt)}, Completed ${fmtDateTimeShort(p.completedAt)} (${p.checkedUnits} of ${p.totalUnits} units)`, "HB", 9);
      if (p.checkedUnitNames && p.checkedUnitNames.length > 0) {
        wrapPush(L, `Accounted for: ${p.checkedUnitNames.join(", ")}`);
      }
      if (p.uncheckedUnitNames && p.uncheckedUnitNames.length > 0) {
        wrapPush(L, `NOT accounted for: ${p.uncheckedUnitNames.join(", ")}`);
      }
      blank();
    });
  }

  // phase: "In" or "Out" — reads bpIn/pulseIn/... or bpOut/pulseOut/...
  // accordingly, since check-in and check-out vitals are now two
  // separate sets rather than one shared one.
  const vitalsSegments = (r, phase) => {
    const segs = [];
    const bp = r[`bp${phase}`], pulse = r[`pulse${phase}`], rr = r[`rr${phase}`], spo2 = r[`spo2${phase}`], temp = r[`temp${phase}`];
    if (bp) segs.push({ text: "BP ", bold: true }, { text: `${bp} `, bold: false });
    if (pulse) segs.push({ text: "P ", bold: true }, { text: `${pulse} `, bold: false });
    if (rr) segs.push({ text: "R ", bold: true }, { text: `${rr} `, bold: false });
    if (spo2) segs.push({ text: "SpO2 ", bold: true }, { text: `${spo2} `, bold: false });
    if (temp) segs.push({ text: "T ", bold: true }, { text: `${temp}`, bold: false });
    return segs;
  };
  // Frozen duration for cleared entries (time-in to time-cleared,
  // matching the on-screen clock's freeze behavior) — for anyone
  // still in rehab at export time, this is elapsed-so-far as of the
  // moment the report was generated, since a PDF is a snapshot.
  const rehabDuration = (r) => r.timeIn ? elapsed(r.timeIn, r.timeCleared ? new Date(r.timeCleared).getTime() : Date.now()) : "-";
  // Time in/out/duration combined into one compact cell (a table cell
  // is a single line — see tableLines above — so this keeps three
  // related, short values readable together instead of needing three
  // separate narrow columns) — frees up column width for the two new
  // vitals sets and the fluid/nutrient intake below.
  const rehabTimes = (r) => `${fmtTimeShort(r.timeIn)} → ${r.timeCleared ? fmtTimeShort(r.timeCleared) : "—"} (${rehabDuration(r)})`;
  const fluidNutrient = (r) => [r.fluidBolus, r.nutrientIntake].filter(Boolean).join(" / ") || "-";
  L.push(...tableLines(["NAME", "UNIT", "TIMES (IN → OUT · DUR)", "VITALS — CHECK-IN", "VITALS — CHECK-OUT", "FLUID / NUTRIENT", "STATUS", "NOTES"], [100, 32, 90, 135, 135, 85, 40, 90],
    rehab.map(r => [r.name, r.unit, rehabTimes(r), vitalsSegments(r, "In"), vitalsSegments(r, "Out"), fluidNutrient(r), r.status, r.notes]), "Rehab / Medical Monitoring"));

  heading(L, "9. Current Organization");
  const orgLines = flattenOrgFilled(org).map(item => `${"  ".repeat(item.depth || 0)}${item.title}: ${item.name}`);
  if (orgLines.length === 0) push("(none entered)");
  else orgLines.forEach(l => wrapPush(L, l));
  if (orgChartImage) L.push({ kind: "image", img: orgChartImage });
  blank();

  if (include("205")) {
    heading(L, "ICS-205 · Incident Radio Communications Plan");
    push(`Date/Time Prepared: ${comms.dateTimePrepared || "-"}   Operational Period: ${comms.opFrom || "-"} to ${comms.opTo || "-"}`, "H", 9);
    blank();
    L.push(...tableLines(["ZN/GRP", "CH#", "FUNCTION", "CHANNEL NAME", "ASSIGN", "RX FREQ", "TX FREQ", "MODE", "REMARKS"], [45, 35, 75, 110, 80, 75, 75, 40, 160],
      comms.rows.map(c => [c.zoneGroup, c.chNum, c.func, c.channelName, c.assignment, c.rxFreq, c.txFreq, c.mode, c.remarks])));
    if (comms.specialInstructions) {
      push("Special Instructions:", "HB", 9);
      wrapPush(L, comms.specialInstructions);
    }
    push(`Prepared By (Comms Unit Leader): ${comms.preparedBy || "-"}   Signature: ${comms.signature || "-"}   Date/Time: ${comms.dateTime || "-"}`, "H", 9);
    blank();
  }

  if (include("215a")) {
    heading(L, "ICS-215A · Incident Action Plan Safety Analysis");
    push(`Operational Period: ${safety.opFrom || "-"} to ${safety.opTo || "-"}`, "H", 9);
    blank();
    L.push(...tableLines(["BRANCH", "DIV/GRP", "HAZARDS", "MITIGATIONS"], [70, 90, 270, 270],
      safety.rows.map(r => [r.branch, r.division, r.hazards, r.mitigations])));
    push(`Prepared By: ${safety.preparedBy || "-"}   Position: ${safety.position || "-"}`);
    push(`Signature: ${safety.signature || "-"}   Date/Time: ${safety.dateTime || "-"}`);
    blank();
  }

  if (include("208")) {
    heading(L, "ICS-208 · Safety Message/Plan");
    push(`Operational Period: ${ics208.opFrom || "-"} to ${ics208.opTo || "-"}`, "H", 9);
    blank();
    wrapPush(L, ics208.message || "(none entered)");
    push(`Site Safety Plan Required: ${ics208.siteSafetyPlanRequired || "-"}   Located At: ${ics208.siteSafetyPlanLocation || "-"}`, "H", 9);
    push(`Prepared By: ${ics208.preparedBy || "-"}   Position: ${ics208.position || "-"}`);
    push(`Signature: ${ics208.signature || "-"}   Date/Time: ${ics208.dateTime || "-"}`);
    blank();
  }

  if (include("208hm")) {
    heading(L, "ICS-208 HM · Site Safety and Control Plan");
    push(`Incident Location: ${ics208hm.incidentLocation || "-"}   Date Prepared: ${ics208hm.dateTime || "-"}`, "H", 9);
    push(`Op Period: ${ics208hm.opFrom || "-"} to ${ics208hm.opTo || "-"}`, "H", 9);
    push("Organization:", "HB", 9);
    push(`IC: ${ics208hm.orgIC || "-"}   HM Group Supv: ${ics208hm.orgHMGroupSupervisor || "-"}   Safety Officer: ${ics208hm.orgSafetyOfficer || "-"}`, "H", 9);
    push(`Entry Leader: ${ics208hm.orgEntryLeader || "-"}   Decon Leader: ${ics208hm.orgDeconLeader || "-"}   Site Access Control: ${ics208hm.orgSiteAccessControlLeader || "-"}`, "H", 9);
    L.push(...tableLines(["ENTRY MEMBER", "NAME", "PPE LEVEL"], [90, 150, 90],
      (ics208hm.entryTeam || []).map(m => [m.label, m.name, m.ppeLevel])));
    L.push(...tableLines(["DECON MEMBER", "NAME", "PPE LEVEL"], [90, 150, 90],
      (ics208hm.deconTeam || []).map(m => [m.label, m.name, m.ppeLevel])));
    L.push(...tableLines(["MATERIAL", "CONTAINER", "QTY", "IDLH", "LEL", "UEL"], [90, 80, 50, 60, 50, 50],
      (ics208hm.materials || []).map(m => [m.material, m.containerType, m.qty, m.idlh, m.lel, m.uel]), "Hazard/Risk Analysis"));
    push(`Monitoring — LEL: ${ics208hm.lelInstruments || "-"}   O2: ${ics208hm.o2Instruments || "-"}   Toxicity: ${ics208hm.toxicityInstruments || "-"}   Radiological: ${ics208hm.radiologicalInstruments || "-"}`, "H", 9);
    push(`Standard Decon Procedures: ${ics208hm.standardDecon || "-"}   ${ics208hm.deconComment || ""}`, "H", 9);
    push(`Comms — Command: ${ics208hm.commandFreq || "-"}   Tactical: ${ics208hm.tacticalFreq || "-"}   Entry: ${ics208hm.entryFreq || "-"}`, "H", 9);
    push(`Medical Monitoring: ${ics208hm.medicalMonitoring || "-"}   Treatment In-Place: ${ics208hm.medicalTreatmentInPlace || "-"}`, "H", 9);
    push("Entry Objectives:", "HB", 9);
    wrapPush(L, ics208hm.entryObjectives || "(none entered)");
    push("Emergency Procedures:", "HB", 9);
    wrapPush(L, ics208hm.emergencyProcedures || "(none entered)");
    push(`Safety Briefing — Asst. Safety Officer HM: ${ics208hm.asstSafetyOfficerSignature || "-"} (${ics208hm.safetyBriefingTime || "-"})`, "H", 9);
    push(`HM Group Supervisor: ${ics208hm.hmGroupSupervisorSignature || "-"}   Incident Commander: ${ics208hm.incidentCommanderSignature || "-"}`, "H", 9);
    blank();
  }

  if (include("209")) {
    heading(L, "ICS-209 · Incident Status Summary");
    push(`Incident Start: ${incident.dateInitiated || "-"} ${incident.timeInitiated || "-"} CST`, "H", 9);
    push(`Report Version: ${ics209.reportVersion || "-"}   Prepared: ${ics209.preparedDateTime || "-"}   For Period: ${ics209.opFrom || "-"} to ${ics209.opTo || "-"}`, "H", 9);
    push(`IC/Agency: ${incident.icName || "-"}${ics209.icAgencyOrg ? " - " + ics209.icAgencyOrg : ""}   Size/Area: ${ics209.sizeArea || "-"}   % Contained: ${ics209.percentContained || "-"}`, "H", 9);
    push(`Definition: ${ics209.definition || "-"}   Complexity: ${ics209.complexityLevel || "-"}`, "H", 9);
    push(`Location: ${ics209.shortLocation || "-"}`, "H", 9);
    push("Significant Events:", "HB", 9);
    wrapPush(L, ics209.significantEvents || "(none entered)");
    push(`Primary Materials/Hazards: ${ics209.primaryMaterials || "-"}`, "H", 9);
    const activeThreatFlags = THREAT_FLAG_OPTIONS.filter(([k]) => ics209.threatFlags[k]).map(([, l]) => l);
    push(`Threat Management: ${activeThreatFlags.length ? activeThreatFlags.join(", ") : "(none checked)"}`, "H", 9);
    push(`Weather Concerns: ${ics209.weatherConcerns || "-"}`, "H", 9);
    push("Strategic Objectives:", "HB", 9);
    wrapPush(L, ics209.strategicObjectives || "(none entered)");
    push("Planned Actions Next Op Period:", "HB", 9);
    wrapPush(L, ics209.plannedActions || "(none entered)");
    push(`Prepared By: ${ics209.preparedByName || "-"} (${ics209.preparedByPosition || "-"})   Approved By: ${ics209.approvedByName || "-"}`, "H", 9);
    blank();
  }

  if (include("206")) {
    heading(L, "ICS-206 · Medical Plan");
    L.push(...tableLines(["STATION", "LOCATION", "CONTACT", "PARAMEDIC"], [140, 220, 220, 100],
      ics206.aidStations.map(r => [r.name, r.location, r.contact, r.paramedic]), "Medical Aid Stations"));
    L.push(...tableLines(["SERVICE", "LOCATION", "CONTACT", "LEVEL"], [170, 190, 190, 100],
      ics206.ambulances.map(r => [r.name, r.location, r.contact, r.level]), "Ambulance Services"));
    L.push(...tableLines(["HOSPITAL", "ADDRESS", "TRAVEL AIR", "TRAVEL GRND", "TRAUMA", "BURN", "HELIPAD"], [140, 240, 75, 85, 70, 55, 65],
      ics206.hospitals.map(r => [r.name, r.address, r.travelAir, r.travelGround, r.trauma === "Yes" ? `Yes (${r.traumaLevel || "?"})` : "No", r.burn, r.helipad]), "Hospitals"));
    push(`Aviation Assets Utilized for Rescue: ${ics206.aviationAssets ? "Yes" : "No"}`, "H", 9);
  push("Special Medical Emergency Procedures:", "HB", 9);
  wrapPush(L, ics206.procedures || "(none entered)");
  push(`Prepared By: ${ics206.preparedBy || "-"}   Approved By (Safety Officer): ${ics206.approvedBy || "-"}`);
  blank();
  }

  if (include("214")) {
  heading(L, "ICS-214 · Activity Logs");
  if (logs.length === 0) {
    push("(none entered)");
  } else {
    logs.forEach(l => {
      push(`${l.name || "Unnamed"} - ${l.position || "-"} (${l.agency || "-"})`, "HB", 9);
      L.push(...tableLines(["TIME", "ACTIVITY"], [80, 620],
        l.entries.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).map(e => [fmtTimeShort(e.time), e.text])));
    });
  }
  }

  const nonImageAttachments = (attachments || []).filter(a => !(a.type || "").startsWith("image/"));
  if (nonImageAttachments.length > 0) {
    heading(L, "Attached Documents");
    L.push(...tableLines(["FILE NAME", "TYPE", "SIZE"], [400, 200, 112],
      nonImageAttachments.map(a => [a.name, a.type || "unknown", `${((a.size || 0) / 1024).toFixed(0)} KB`])));
  }

  // Placed last, on its own forced page, right before the trailing
  // attachment photo pages buildSimplePdf appends after everything
  // here — rather than flowing inline with whatever text happens to
  // precede it. Acreage is computed and stored on the feature itself
  // back when it was traced/edited on the Mapping tab (see persist()
  // in TabMapping) — read directly here rather than recomputed, so
  // this doesn't need any GIS/geometry logic of its own. The section
  // shows whenever there's anything at all drawn on the map, not only
  // when a perimeter has been traced, since the snapshot is useful on
  // its own (labels, hazard circles, etc.).
  const allMapFeatures = (mapData && mapData.features) || [];
  const perimeters = allMapFeatures.filter(f => f.properties && f.properties.isPerimeter);
  if (allMapFeatures.length > 0) {
    L.push({ kind: "pagebreak" });
    heading(L, "Incident Perimeter");
    if (perimeters.length > 0) {
      perimeters.forEach((f, i) => {
        const label = perimeters.length > 1 ? `Perimeter ${i + 1}: ` : "";
        push(`${label}${f.properties.perimeterAcres.toFixed(1)} acres`, "H", 9);
      });
      if (perimeters.length > 1) {
        const total = perimeters.reduce((sum, f) => sum + f.properties.perimeterAcres, 0);
        push(`Total: ${total.toFixed(1)} acres`, "HB", 9);
      }
    }
    if (mapSnapshotImage) L.push({ kind: "image", img: mapSnapshotImage });
  }

  return L;
}

// Byte-accurate PDF assembly. Content is built as an array of "parts"
// (ASCII strings + binary Uint8Arrays for the embedded image) rather
// than one big string, because a JS string containing raw bytes >127
// gets mangled by UTF-8 re-encoding when passed to Blob — binary data
// has to travel as an actual typed array, not characters in a string.
function buildSimplePdf(lines, logo, meta, attachmentImages = []) {
  // Landscape — swapped from the portrait 612x792 US Letter default —
  // gives tables meaningfully more horizontal room (content width goes
  // from ~532pt to ~712pt) at the cost of shorter pages, so text-heavy
  // sections paginate a bit more often. Every width below is computed
  // from PAGE_W/CONTENT_W rather than hardcoded, so this is the only
  // place orientation needs to change.
  const PAGE_W = 792, PAGE_H = 612, MARGIN_X = 40, MARGIN_BOTTOM = 46;
  // Header layout computed once, up front, so pagination (which needs
  // to know how much vertical space the header eats on page 1) and the
  // actual per-page drawing use the exact same numbers — previously
  // these were computed separately and could disagree, letting the
  // header text overlap the first line of content when no logo loaded.
  const drawH = logo ? 54 : 0;
  const drawW = logo ? drawH * (logo.width / logo.height) : 0;
  const textBottomOffset = 70; // below the "Started:" line (headerTop-60) with clearance
  const logoBottomOffset = logo ? drawH + 8 : 0;
  const ruleOffset = Math.max(textBottomOffset, logoBottomOffset);
  const HEADER_H = ruleOffset + 14;
  const MARGIN_TOP = PAGE_H - 42;
  const LH = { H: 12, HB: 14, heading: 20 };
  const RED = "0.769 0.204 0.122";
  const GREY = "0.72 0.72 0.72";

  const pages = [];
  let cur = [];
  let y = MARGIN_TOP - HEADER_H;
  const CONTENT_W = PAGE_W - 2 * MARGIN_X;
  const IMAGE_MAX_H = 300; // cap so one image can't eat an entire page (landscape pages are shorter, so this is smaller than it'd be in portrait)
  const IMAGE_GAP = 16;
  for (const ln of lines) {
    if (ln.kind === "pagebreak") {
      // Forces a fresh page unconditionally — used to put a section
      // on its own page regardless of how much room is left on the
      // current one. A no-op if the current page is already empty
      // (e.g. a previous overflow just started one), so this never
      // inserts a genuinely blank page.
      if (cur.length > 0) { pages.push(cur); cur = []; y = MARGIN_TOP; }
      continue;
    }
    if (ln.kind === "image") {
      // Scale to fit the content width (never upscale past the
      // image's native size), then cap the height too. Images never
      // split across a page break — if it doesn't fit in what's left,
      // the whole thing moves to a fresh page instead of clipping.
      let scale = Math.min(CONTENT_W / ln.img.width, 1);
      let displayW = ln.img.width * scale;
      let displayH = ln.img.height * scale;
      if (displayH > IMAGE_MAX_H) {
        scale = IMAGE_MAX_H / ln.img.height;
        displayH = IMAGE_MAX_H;
        displayW = ln.img.width * scale;
      }
      const needed = displayH + IMAGE_GAP;
      if (y - needed < MARGIN_BOTTOM) { pages.push(cur); cur = []; y = MARGIN_TOP; }
      cur.push({ ...ln, y, displayW, displayH });
      y -= needed;
      continue;
    }
    const lh = LH[ln.kind === "heading" ? "heading" : ln.font] || 12;
    if (y - lh < MARGIN_BOTTOM) { pages.push(cur); cur = []; y = MARGIN_TOP; }
    cur.push({ ...ln, y });
    y -= lh;
  }
  pages.push(cur);
  // Attachment photos each get their own dedicated page, appended
  // after the flowing text content — counted into the total up front
  // so "Page X of Y" is correct on every page, including the text ones.
  const totalPages = pages.length + attachmentImages.length;

  const parts = [];
  let pos = 0;
  const push = (x) => { parts.push(x); pos += (typeof x === "string") ? x.length : x.byteLength; };

  push("%PDF-1.4\n");

  let nextId = 1;
  const reserve = () => nextId++;
  const catalogId = reserve();
  const pagesTreeId = reserve();
  const fontHId = reserve();
  const fontHBId = reserve();
  const resourcesId = reserve();
  const imageId = logo ? reserve() : null;
  const pageIds = pages.map(() => reserve());
  const contentIds = pages.map(() => reserve());
  const attImageIds = attachmentImages.map(() => reserve());
  const attPageIds = attachmentImages.map(() => reserve());
  const attContentIds = attachmentImages.map(() => reserve());
  // Inline images (e.g. the org chart) live inside the normal flowing
  // pages rather than getting a dedicated page of their own — found
  // by scanning the already-paginated lines so each gets a stable
  // index for its XObject name/id, referenced later when drawing.
  const inlineImageEntries = [];
  pages.forEach(pageLines => pageLines.forEach(ln => { if (ln.kind === "image") inlineImageEntries.push(ln); }));
  const inlineImageIds = inlineImageEntries.map(() => reserve());

  const offsets = {};
  const writeObj = (id, body) => {
    offsets[id] = pos;
    push(`${id} 0 obj\n`);
    body();
    push(`\nendobj\n`);
  };

  writeObj(fontHId, () => push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  writeObj(fontHBId, () => push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"));
  if (logo) {
    writeObj(imageId, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${logo.rgb.byteLength} >>\nstream\n`);
      push(logo.rgb);
      push(`\nendstream`);
    });
  }
  attachmentImages.forEach((img, idx) => {
    writeObj(attImageIds[idx], () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${img.rgb.byteLength} >>\nstream\n`);
      push(img.rgb);
      push(`\nendstream`);
    });
  });
  inlineImageEntries.forEach((ln, idx) => {
    writeObj(inlineImageIds[idx], () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${ln.img.width} /Height ${ln.img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${ln.img.rgb.byteLength} >>\nstream\n`);
      push(ln.img.rgb);
      push(`\nendstream`);
    });
  });
  const xobjectEntries = [
    logo ? `/Logo ${imageId} 0 R` : "",
    ...attachmentImages.map((_, idx) => `/AttImg${idx} ${attImageIds[idx]} 0 R`),
    ...inlineImageEntries.map((_, idx) => `/InlineImg${idx} ${inlineImageIds[idx]} 0 R`),
  ].filter(Boolean).join(" ");
  const resourcesDict = xobjectEntries
    ? `<< /Font << /FH ${fontHId} 0 R /FHB ${fontHBId} 0 R >> /XObject << ${xobjectEntries} >> >>`
    : `<< /Font << /FH ${fontHId} 0 R /FHB ${fontHBId} 0 R >> >>`;
  writeObj(resourcesId, () => push(resourcesDict));

  let inlineImgCounter = 0;
  pages.forEach((pageLines, i) => {
    let stream = "";
    if (i === 0) {
      const headerTop = PAGE_H - 40;
      if (logo) {
        stream += `q ${drawW.toFixed(1)} 0 0 ${drawH.toFixed(1)} ${MARGIN_X} ${(headerTop - drawH).toFixed(1)} cm /Logo Do Q\n`;
      }
      stream += "BT\n";
      const textX = MARGIN_X + drawW + (logo ? 14 : 0);
      stream += `/FHB 18 Tf\n1 0 0 1 ${textX} ${(headerTop - 16).toFixed(1)} Tm\n(COMMAND BOARD) Tj\n`;
      stream += `/FH 9 Tf\n1 0 0 1 ${textX} ${(headerTop - 30).toFixed(1)} Tm\n(Incident Action Plan Packet) Tj\n`;
      stream += `/FHB 12 Tf\n1 0 0 1 ${textX} ${(headerTop - 46).toFixed(1)} Tm\n(${pdfEscape(meta.name || "Untitled Incident")}) Tj\n`;
      if (meta.started) {
        stream += `/FH 9 Tf\n1 0 0 1 ${textX} ${(headerTop - 60).toFixed(1)} Tm\n(Started: ${pdfEscape(meta.started)}) Tj\n`;
      }
      stream += "ET\n";
      stream += `${RED} RG 1.4 w ${MARGIN_X} ${(headerTop - ruleOffset).toFixed(1)} m ${PAGE_W - MARGIN_X} ${(headerTop - ruleOffset).toFixed(1)} l S\n`;
    }

    stream += "BT\n";
    for (const ln of pageLines) {
      if (ln.kind === "image") {
        stream += "ET\n";
        const x = MARGIN_X + (CONTENT_W - ln.displayW) / 2;
        const yBottom = ln.y - ln.displayH;
        stream += `q ${ln.displayW.toFixed(1)} 0 0 ${ln.displayH.toFixed(1)} ${x.toFixed(1)} ${yBottom.toFixed(1)} cm /InlineImg${inlineImgCounter} Do Q\n`;
        inlineImgCounter++;
        stream += "BT\n";
        continue;
      }
      if (ln.kind === "rule") {
        stream += "ET\n";
        stream += `${GREY} RG 0.6 w ${MARGIN_X} ${(ln.y + 3).toFixed(1)} m ${MARGIN_X + ln.width} ${(ln.y + 3).toFixed(1)} l S\n`;
        stream += "BT\n";
        continue;
      }
      if (ln.kind === "heading") {
        stream += `/FHB 12 Tf\n1 0 0 1 ${MARGIN_X} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(ln.text)}) Tj\n`;
        stream += "ET\n";
        stream += `${RED} RG 1 w ${MARGIN_X} ${(ln.y - 4).toFixed(1)} m ${PAGE_W - MARGIN_X} ${(ln.y - 4).toFixed(1)} l S\n`;
        stream += "BT\n";
        continue;
      }
      if (ln.kind === "row") {
        for (const cell of ln.cells) {
          if (cell.segments) {
            // Draw each segment left-to-right, switching font per
            // segment and advancing x by the same average-char-width
            // estimate fitText uses elsewhere, so bold and regular
            // runs sit flush against each other with no visible gap.
            let curX = MARGIN_X + cell.x;
            for (const seg of cell.segments) {
              const segFontKey = seg.bold ? "FHB" : "FH";
              stream += `/${segFontKey} ${ln.size} Tf\n1 0 0 1 ${curX.toFixed(1)} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(seg.text)}) Tj\n`;
              curX += seg.text.length * ln.size * (AVG_CHAR_W[seg.bold ? "HB" : "H"] || 0.5);
            }
            continue;
          }
          const fontKey = ln.font === "HB" ? "FHB" : "FH";
          stream += `/${fontKey} ${ln.size} Tf\n1 0 0 1 ${MARGIN_X + cell.x} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(cell.text)}) Tj\n`;
        }
        continue;
      }
      const fontKey = ln.font === "HB" ? "FHB" : "FH";
      stream += `/${fontKey} ${ln.size} Tf\n1 0 0 1 ${MARGIN_X} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(ln.text)}) Tj\n`;
    }
    stream += `/FH 8 Tf\n1 0 0 1 ${PAGE_W / 2 - 40} 24 Tm\n(Page ${i + 1} of ${totalPages}) Tj\n`;
    stream += "ET";

    writeObj(contentIds[i], () => push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    writeObj(pageIds[i], () => push(`<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resourcesId} 0 R /Contents ${contentIds[i]} 0 R >>`));
  });

  attachmentImages.forEach((img, idx) => {
    const availW = PAGE_W - 2 * MARGIN_X;
    const availH = PAGE_H - 100;
    const scale = Math.min(availW / img.width, availH / img.height);
    const drawImgW = img.width * scale, drawImgH = img.height * scale;
    const x = MARGIN_X + (availW - drawImgW) / 2;
    const y = PAGE_H - 50 - drawImgH;
    let stream = `q ${drawImgW.toFixed(1)} 0 0 ${drawImgH.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)} cm /AttImg${idx} Do Q\n`;
    stream += "BT\n";
    stream += `/FHB 10 Tf\n1 0 0 1 ${MARGIN_X} ${(y - 18).toFixed(1)} Tm\n(${pdfEscape(img.caption || "Attachment")}) Tj\n`;
    stream += `/FH 8 Tf\n1 0 0 1 ${PAGE_W / 2 - 40} 24 Tm\n(Page ${pages.length + idx + 1} of ${totalPages}) Tj\n`;
    stream += "ET";
    writeObj(attContentIds[idx], () => push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    writeObj(attPageIds[idx], () => push(`<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resourcesId} 0 R /Contents ${attContentIds[idx]} 0 R >>`));
  });

  writeObj(pagesTreeId, () => push(`<< /Type /Pages /Kids [${[...pageIds, ...attPageIds].map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length + attPageIds.length} >>`));
  writeObj(catalogId, () => push(`<< /Type /Catalog /Pages ${pagesTreeId} 0 R >>`));

  const xrefStart = pos;
  push(`xref\n0 ${nextId}\n0000000000 65535 f \n`);
  for (let id = 1; id < nextId; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  return parts;
}

// Decodes the embedded KFD patch PNG into raw RGB pixel bytes via an
// offscreen canvas — needed because the hand-built PDF above embeds
// the image as a raw DeviceRGB stream rather than relying on a PDF
// library to handle PNG decoding for us.
/* ============================================================
   ORG CHART -> PDF: draws the same tree the on-screen diagram shows
   onto an offscreen canvas, then feeds it through the same
   image-embedding pipeline built for attachment photos (see
   loadLogoRGB / the attachmentImages param on buildSimplePdf) —
   the hand-built PDF writer has no way to render an HTML/CSS
   flowchart directly, so rendering it as an image is the only path.
   ============================================================ */
const ORG_BOX_W = 150, ORG_BOX_H = 56, ORG_GAP_X = 18, ORG_LEVEL_H = 88;

// Recursive layout: positions a node's box and, if it has children,
// their boxes and the connector lines to them — centering each parent
// over the full width of its children's combined subtrees (not just
// their box positions), so multi-level branches stay properly aligned.
function layoutOrgTree(node, depth) {
  if (!node.children || node.children.length === 0) {
    return { width: ORG_BOX_W, maxDepth: depth, boxes: [{ node, x: 0, y: depth * ORG_LEVEL_H }], lines: [] };
  }
  let childX = 0;
  const childResults = [];
  for (const child of node.children) {
    const r = layoutOrgTree(child, depth + 1);
    childResults.push({ r, offsetX: childX });
    childX += r.width + ORG_GAP_X;
  }
  const totalChildWidth = childX - ORG_GAP_X;
  const width = Math.max(ORG_BOX_W, totalChildWidth);
  const childrenStartX = (width - totalChildWidth) / 2;
  const boxes = [{ node, x: (width - ORG_BOX_W) / 2, y: depth * ORG_LEVEL_H }];
  const lines = [];
  let maxDepth = depth;
  const parentCenterX = width / 2;
  const parentBottomY = depth * ORG_LEVEL_H + ORG_BOX_H;
  for (const { r, offsetX } of childResults) {
    const shiftedBoxes = r.boxes.map(b => ({ ...b, x: b.x + childrenStartX + offsetX }));
    const shiftedLines = r.lines.map(l => ({ x1: l.x1 + childrenStartX + offsetX, y1: l.y1, x2: l.x2 + childrenStartX + offsetX, y2: l.y2 }));
    boxes.push(...shiftedBoxes);
    lines.push(...shiftedLines);
    maxDepth = Math.max(maxDepth, r.maxDepth);
    const childBoxX = shiftedBoxes[0].x + ORG_BOX_W / 2;
    const childBoxY = shiftedBoxes[0].y;
    // T-connector: down from parent, across, down into the child —
    // matches the on-screen diagram's connector style.
    lines.push({ x1: parentCenterX, y1: parentBottomY, x2: parentCenterX, y2: parentBottomY + 15 });
    lines.push({ x1: parentCenterX, y1: parentBottomY + 15, x2: childBoxX, y2: parentBottomY + 15 });
    lines.push({ x1: childBoxX, y1: parentBottomY + 15, x2: childBoxX, y2: childBoxY });
  }
  return { width, maxDepth, boxes, lines };
}

// Combines IC/Deputy IC, the Command Staff row, and each Section
// Chief's (possibly deep) subtree into one full-chart layout.
function layoutFullOrgChart(org) {
  const csBoxes = org.commandStaff.map((cs, i) => ({ node: cs, x: i * (ORG_BOX_W + ORG_GAP_X), y: 0 }));
  const csWidth = org.commandStaff.length > 0 ? org.commandStaff.length * ORG_BOX_W + (org.commandStaff.length - 1) * ORG_GAP_X : 0;

  const sectionResults = org.sections.map(s => layoutOrgTree(s, 0));
  const groups = [];
  if (csWidth > 0) groups.push({ width: csWidth, boxes: csBoxes, lines: [], maxDepth: 0 });
  groups.push(...sectionResults);

  const GROUP_GAP = 40;
  let curX = 0;
  const allBoxes = [];
  const allLines = [];
  let maxDepth = 0;
  const groupCenters = [];
  for (const g of groups) {
    allBoxes.push(...g.boxes.map(b => ({ ...b, x: b.x + curX })));
    allLines.push(...(g.lines || []).map(l => ({ x1: l.x1 + curX, y1: l.y1, x2: l.x2 + curX, y2: l.y2 })));
    maxDepth = Math.max(maxDepth, g.maxDepth);
    groupCenters.push(curX + g.width / 2);
    curX += g.width + GROUP_GAP;
  }
  const rowWidth = groups.length > 0 ? curX - GROUP_GAP : 0;

  const hasDeputy = !!org.deputyIc;
  const icGroupWidth = hasDeputy ? ORG_BOX_W * 2 + ORG_GAP_X : ORG_BOX_W;
  const totalWidth = Math.max(rowWidth, icGroupWidth);
  const rowOffsetX = (totalWidth - rowWidth) / 2;
  const icOffsetX = (totalWidth - icGroupWidth) / 2;

  const IC_ROW_H = ORG_BOX_H + 70; // IC box height + connector space down to the next row
  const finalBoxes = allBoxes.map(b => ({ ...b, x: b.x + rowOffsetX, y: b.y + IC_ROW_H }));
  const finalLines = allLines.map(l => ({ x1: l.x1 + rowOffsetX, y1: l.y1 + IC_ROW_H, x2: l.x2 + rowOffsetX, y2: l.y2 + IC_ROW_H }));

  const icBoxes = [{ node: { title: "Incident Commander", name: org.ic }, x: icOffsetX, y: 0, isRoot: true }];
  if (hasDeputy) icBoxes.push({ node: { title: "Deputy IC", name: org.deputyIc }, x: icOffsetX + ORG_BOX_W + ORG_GAP_X, y: 0, isRoot: true });

  const icCenterX = icOffsetX + icGroupWidth / 2;
  const barY = ORG_BOX_H + 35;
  const connectorLines = [{ x1: icCenterX, y1: ORG_BOX_H, x2: icCenterX, y2: barY }];
  if (groupCenters.length > 0) {
    const firstCenter = groupCenters[0] + rowOffsetX;
    const lastCenter = groupCenters[groupCenters.length - 1] + rowOffsetX;
    connectorLines.push({ x1: firstCenter, y1: barY, x2: lastCenter, y2: barY });
    for (const gc of groupCenters) {
      const x = gc + rowOffsetX;
      connectorLines.push({ x1: x, y1: barY, x2: x, y2: barY + 35 });
    }
  }

  return {
    boxes: [...icBoxes, ...finalBoxes],
    lines: [...connectorLines, ...finalLines],
    width: totalWidth,
    height: IC_ROW_H + (maxDepth + 1) * ORG_LEVEL_H,
  };
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  const lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return lines.length;
}

// Renders the layout to an offscreen canvas and returns a PNG data
// URI — plain black/grey ink on white, matching print conventions
// (the on-screen dark theme's colors aren't meant for paper).
function renderOrgChartDataUri(org) {
  const hasAnyContent = org.ic || org.deputyIc || org.commandStaff.some(c => c.name) || org.sections.some(s => s.name || (s.children && s.children.length));
  if (!hasAnyContent) return null;
  const layout = layoutFullOrgChart(org);
  const PADDING = 24;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.width + PADDING * 2);
  canvas.height = Math.ceil(layout.height + PADDING * 2);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#9AA0A6";
  ctx.lineWidth = 1.5;
  layout.lines.forEach(l => {
    ctx.beginPath();
    ctx.moveTo(l.x1 + PADDING, l.y1 + PADDING);
    ctx.lineTo(l.x2 + PADDING, l.y2 + PADDING);
    ctx.stroke();
  });

  layout.boxes.forEach(b => {
    const x = b.x + PADDING, y = b.y + PADDING;
    ctx.fillStyle = b.isRoot ? "#F0F0F0" : "#FFFFFF";
    ctx.strokeStyle = b.isRoot ? "#96690F" : "#9AA0A6";
    ctx.lineWidth = b.isRoot ? 2 : 1.5;
    const r = 5;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + ORG_BOX_W, y, x + ORG_BOX_W, y + ORG_BOX_H, r);
    ctx.arcTo(x + ORG_BOX_W, y + ORG_BOX_H, x, y + ORG_BOX_H, r);
    ctx.arcTo(x, y + ORG_BOX_H, x, y, r);
    ctx.arcTo(x, y, x + ORG_BOX_W, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = "#96690F";
    ctx.font = "bold 10px Arial, sans-serif";
    wrapCanvasText(ctx, (b.node.title || "").toUpperCase(), x + ORG_BOX_W / 2, y + 16, ORG_BOX_W - 12, 11);

    ctx.fillStyle = "#191C1F";
    ctx.font = "12px Arial, sans-serif";
    ctx.fillText(b.node.name || "(vacant)", x + ORG_BOX_W / 2, y + ORG_BOX_H - 12);
  });

  return canvas.toDataURL("image/png");
}

/* ============================================================
   MAP ANNOTATIONS -> PDF: renders every drawn shape (text labels,
   freehand lines, hazard circles, and traced perimeters) onto a
   plain white diagram, the same way the org chart is rendered — this
   is a deliberate simplification, not the live interactive map with
   its street/satellite tiles: those tiles come from an external
   server without the CORS headers a canvas needs to export an image
   that includes them, so embedding the literal map view isn't
   possible here. A vector re-drawing of just the annotations avoids
   that entirely and is honestly more legible on paper anyway.
   ============================================================ */

// Walks every feature's geometry (Point/LineString/Polygon, whatever
// nesting depth that implies) to find the overall lat/lng bounds,
// then separately widens that box for any circle (stored as a Point
// plus a radius in meters) so its edge doesn't get clipped when its
// center sits near the box computed from raw coordinates alone.
function computeGeoJsonBounds(mapData) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  const visit = (coords, depth) => {
    if (depth === 0) {
      const [lng, lat] = coords;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    } else {
      coords.forEach(c => visit(c, depth - 1));
    }
  };
  mapData.features.forEach(f => {
    const g = f.geometry;
    if (g.type === "Point") visit(g.coordinates, 0);
    else if (g.type === "LineString") visit(g.coordinates, 1);
    else if (g.type === "Polygon") visit(g.coordinates, 2);
  });
  mapData.features.forEach(f => {
    if (f.geometry.type === "Point" && f.properties && "radius" in f.properties) {
      const [lng, lat] = f.geometry.coordinates;
      const dLat = f.properties.radius / 111320;
      const dLng = f.properties.radius / (111320 * Math.cos(lat * Math.PI / 180));
      minLat = Math.min(minLat, lat - dLat); maxLat = Math.max(maxLat, lat + dLat);
      minLng = Math.min(minLng, lng - dLng); maxLng = Math.max(maxLng, lng + dLng);
    }
  });
  return { minLat, maxLat, minLng, maxLng };
}

// Shared by both rendering paths below (with real map tiles, or the
// plain vector-only fallback) — draws every feature using whatever
// projection and radius-to-pixel conversion the caller supplies, so
// the same drawing logic works whether the underlying scale comes
// from a simple linear projection or a real Web Mercator zoom level.
// Dark-theme hex equivalents of the live app's CSS-variable colors
// (theme.js), used only for canvas drawing in the PDF export — a
// canvas strokeStyle/fillStyle reliably resolving a var(--x)
// reference depends on the canvas being attached to a DOM tree where
// that variable is actually defined, which isn't guaranteed for an
// offscreen PDF-generation canvas, so concrete hex values are used
// here instead. Picking one fixed theme (dark, matching this file's
// other existing PDF map-drawing colors) rather than trying to make a
// static, already-generated PDF "switch themes."
const PDF_STATUS_COLOR = { Active: "#3B6FA6", Staging: "#D9A02B", Rehab: "#2E8B72", "Out of Service": "#565F68", Released: "#5A6169" };
const PDF_ASSIGNMENT_COLOR_PALETTE = ["#D9A02B", "#2E8B72", "#3B6FA6", "#8B5CF6", "#E85D28", "#C4341F"];
function pdfAssignmentColor(assignment, columns) {
  if (PDF_STATUS_COLOR[assignment]) return PDF_STATUS_COLOR[assignment];
  const idx = columns.indexOf(assignment);
  return idx === -1 ? "#565F68" : PDF_ASSIGNMENT_COLOR_PALETTE[idx % PDF_ASSIGNMENT_COLOR_PALETTE.length];
}

function drawMapFeatures(ctx, mapData, project, radiusToPixels, getDivisionColor) {
  mapData.features.forEach(f => {
    const props = f.properties || {};
    const g = f.geometry;
    if (g.type === "LineString") {
      const pts = g.coordinates.map(([lng, lat]) => project(lat, lng));
      ctx.strokeStyle = "#2E8B72";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.stroke();
    } else if (g.type === "Polygon") {
      const ring = g.coordinates[0].map(([lng, lat]) => project(lat, lng));
      const isPerimeter = !!props.isPerimeter;
      ctx.beginPath();
      ring.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fillStyle = isPerimeter ? "rgba(196,52,31,0.15)" : "rgba(217,160,43,0.15)";
      ctx.fill();
      ctx.strokeStyle = isPerimeter ? "#C4341F" : "#D9A02B";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      if (isPerimeter && "perimeterAcres" in props) {
        const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
        const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
        ctx.fillStyle = "#C4341F";
        ctx.font = "bold 14px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(`${props.perimeterAcres.toFixed(1)} acres`, cx, cy);
      }
    } else if (g.type === "Point") {
      const p = project(g.coordinates[1], g.coordinates[0]);
      if ("radius" in props) {
        const rPixels = radiusToPixels(props.radius, g.coordinates[1]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rPixels, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(217,160,43,0.15)";
        ctx.fill();
        ctx.strokeStyle = "#D9A02B";
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (props.isDivisionMarker) {
        // Small fixed-size square with a short label, matching the
        // compact on-map marker style (see makeDivisionMarkerIcon) —
        // keeps the PDF export's map snapshot visually consistent
        // with what's actually shown live on the Mapping tab,
        // including its border color. Manual arcTo corners (not
        // ctx.roundRect) to match this file's existing rounded-box
        // drawing elsewhere and avoid relying on a newer canvas API
        // on older devices.
        const label = shortDivisionLabel(props.divisionName || "");
        const half = 13, r = 4, bx = p.x - half, by = p.y - half, boxW = half * 2, boxH = half * 2;
        ctx.fillStyle = "#1B1F23";
        ctx.strokeStyle = getDivisionColor(props.divisionName);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + boxW, by, bx + boxW, by + boxH, r);
        ctx.arcTo(bx + boxW, by + boxH, bx, by + boxH, r);
        ctx.arcTo(bx, by + boxH, bx, by, r);
        ctx.arcTo(bx, by, bx + boxW, by, r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#EDEFF1";
        ctx.font = "700 10px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, p.x, p.y + 3);
      } else if ("textLabel" in props) {
        ctx.font = "600 13px Arial, sans-serif";
        const textW = ctx.measureText(props.textLabel).width;
        const boxW = textW + 14, boxH = 22, bx = p.x - boxW / 2, by = p.y - boxH / 2, r = 4;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = "#96690F";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bx + r, by);
        ctx.arcTo(bx + boxW, by, bx + boxW, by + boxH, r);
        ctx.arcTo(bx + boxW, by + boxH, bx, by + boxH, r);
        ctx.arcTo(bx, by + boxH, bx, by, r);
        ctx.arcTo(bx, by, bx + boxW, by, r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = "#191C1F";
        ctx.textAlign = "center";
        ctx.fillText(props.textLabel, p.x, p.y + 4);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#3B6FA6";
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  });
}

function drawNorthArrow(ctx, canvasW) {
  ctx.strokeStyle = "#5B6570";
  ctx.fillStyle = "#5B6570";
  ctx.lineWidth = 2;
  const arrowX = canvasW - 40, arrowYBottom = 55, arrowYTop = 20;
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowYBottom);
  ctx.lineTo(arrowX, arrowYTop);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowYTop);
  ctx.lineTo(arrowX - 5, arrowYTop + 9);
  ctx.lineTo(arrowX + 5, arrowYTop + 9);
  ctx.closePath();
  ctx.fill();
  ctx.font = "bold 12px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("N", arrowX, arrowYBottom + 16);
}

// Plain-diagram fallback — no base map, just the annotations
// redrawn to scale on white. Always succeeds (given at least one
// feature exists), which is why the tile-based attempt below falls
// back to this on any failure rather than producing nothing.
function renderMapSnapshotVectorOnly(mapData, bounds, getDivisionColor) {
  const PADDING = 40, CANVAS_W = 1000, CANVAS_H = 700;
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  // Longitude degrees represent fewer real-world meters than latitude
  // degrees do at any latitude away from the equator — this factor
  // keeps the drawing's proportions true rather than stretched.
  const lngScale = Math.cos(centerLat * Math.PI / 180);
  // Floored so a single point (or a tiny cluster) doesn't blow up
  // into an absurd zoom level with a division near zero.
  const spanLat = Math.max(bounds.maxLat - bounds.minLat, 0.0005);
  const spanLng = Math.max((bounds.maxLng - bounds.minLng) * lngScale, 0.0005);
  const availW = CANVAS_W - PADDING * 2, availH = CANVAS_H - PADDING * 2;
  const scale = Math.min(availW / spanLng, availH / spanLat); // one uniform scale for both axes — no distortion
  const project = (lat, lng) => ({
    x: PADDING + ((lng - bounds.minLng) * lngScale * scale) + (availW - spanLng * scale) / 2,
    y: PADDING + ((bounds.maxLat - lat) * scale) + (availH - spanLat * scale) / 2, // north = up
  });

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawMapFeatures(ctx, mapData, project, (meters) => (meters / 111320) * scale, getDivisionColor);
  drawNorthArrow(ctx, CANVAS_W);
  return canvas.toDataURL("image/png");
}

function loadTileImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // required for a same-origin-clean (non-tainted) canvas afterward
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tile failed to load: " + url));
    img.src = url;
  });
}

// Attempts to embed the real Esri World Imagery satellite tiles
// behind the drawn annotations, using Leaflet's own Web Mercator
// projection math (L.CRS.EPSG3857) rather than reimplementing
// slippy-map tile math independently, since that's well-established
// and already correct. Esri's own developer documentation lists
// server.arcgisonline.com as one of the servers automatically
// recognized as CORS-enabled by their API, which is considerably more
// reliable evidence than OpenStreetMap's tile servers offered (their
// CORS support has reportedly been inconsistent over time) — this is
// why satellite was chosen over street tiles here. Every failure path
// below still returns null rather than throwing, though, and the
// caller (renderMapSnapshotDataUri) falls back to the tile-free
// diagram instead of producing nothing, in case that ever changes.
async function renderMapSnapshotWithTiles(mapData, bounds, getDivisionColor) {
  const TILE_SIZE = 256, CANVAS_W = 1000, CANVAS_H = 700, PADDING = 20;

  let zoom = 18;
  let nw, se;
  for (; zoom >= 1; zoom--) {
    nw = L.CRS.EPSG3857.latLngToPoint(L.latLng(bounds.maxLat, bounds.minLng), zoom);
    se = L.CRS.EPSG3857.latLngToPoint(L.latLng(bounds.minLat, bounds.maxLng), zoom);
    if (se.x - nw.x <= CANVAS_W - PADDING * 2 && se.y - nw.y <= CANVAS_H - PADDING * 2) break;
  }
  const boxW = se.x - nw.x, boxH = se.y - nw.y;
  const originX = nw.x - (CANVAS_W - boxW) / 2;
  const originY = nw.y - (CANVAS_H - boxH) / 2;

  const maxTileIndex = Math.pow(2, zoom) - 1;
  const firstTileX = Math.max(0, Math.floor(originX / TILE_SIZE));
  const firstTileY = Math.max(0, Math.floor(originY / TILE_SIZE));
  const lastTileX = Math.min(maxTileIndex, Math.floor((originX + CANVAS_W) / TILE_SIZE));
  const lastTileY = Math.min(maxTileIndex, Math.floor((originY + CANVAS_H) / TILE_SIZE));

  const tileRequests = [];
  for (let tx = firstTileX; tx <= lastTileX; tx++) {
    for (let ty = firstTileY; ty <= lastTileY; ty++) {
      // Esri's tile URL scheme orders {z}/{y}/{x} — the reverse of
      // OpenStreetMap's {z}/{x}/{y} — matching the same satellite
      // layer already used on the live map.
      const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`;
      tileRequests.push(
        loadTileImage(url)
          .then(img => ({ img, px: tx * TILE_SIZE - originX, py: ty * TILE_SIZE - originY }))
          .catch(() => null)
      );
    }
  }
  const tiles = await Promise.all(tileRequests);
  if (tiles.every(t => !t)) return null; // every tile failed — nothing worth keeping

  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  tiles.forEach(t => { if (t) ctx.drawImage(t.img, t.px, t.py); });

  const project = (lat, lng) => {
    const pt = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lng), zoom);
    return { x: pt.x - originX, y: pt.y - originY };
  };
  // Standard Web Mercator meters-per-pixel formula at this zoom/latitude.
  const radiusToPixels = (meters, lat) => meters / (156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom));
  drawMapFeatures(ctx, mapData, project, radiusToPixels, getDivisionColor);
  drawNorthArrow(ctx, CANVAS_W);

  try {
    return canvas.toDataURL("image/png");
  } catch {
    // A tile that silently failed CORS would "taint" the canvas —
    // export throwing here is the actual, definitive signal of that,
    // more reliable than trying to detect it any other way.
    return null;
  }
}

async function renderMapSnapshotDataUri(mapData, resources, assignmentPresets, resourceColumnOrder) {
  if (!mapData || !mapData.features || mapData.features.length === 0) return null;
  const bounds = computeGeoJsonBounds(mapData);
  // Same live-computed, position-cycling color a division's palette
  // card and its on-map marker both already use (assignmentColumnColor)
  // — just resolved to concrete hex here (pdfAssignmentColor) rather
  // than a CSS var(), for the reasons explained above PDF_STATUS_COLOR.
  const columns = deriveAssignmentColumns(resources || [], assignmentPresets, resourceColumnOrder);
  const getDivisionColor = (name) => pdfAssignmentColor(name, columns);
  try {
    const withTiles = await renderMapSnapshotWithTiles(mapData, bounds, getDivisionColor);
    if (withTiles) return withTiles;
  } catch {
    // fall through to the reliable fallback below
  }
  return renderMapSnapshotVectorOnly(mapData, bounds, getDivisionColor);
}

function loadLogoRGB(dataUri, maxDim = 130) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const rgb = new Uint8Array(w * h * 3);
        for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
          rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
        }
        resolve({ width: w, height: h, rgb });
      };
      img.onerror = () => resolve(null);
      img.src = dataUri;
    } catch { resolve(null); }
  });
}

// A separate, standalone PDF for just one PAR/Mayday event, rather
// than the full incident packet — reuses buildSimplePdf directly with
// its own small "lines" array instead of going through
// buildPacketLines, since this only ever needs a few lines and one or
// two small tables, not the entire report structure.
async function downloadParEventPdf(event, incidentName) {
  const logo = await loadLogoRGB(KFD_PATCH_DATA_URI);
  const isMayday = event.kind === "mayday";
  const L = [];
  L.push({ kind: "heading", text: `${isMayday ? "MAYDAY" : "PAR"} — Accountability Check Detail` });
  L.push({ kind: "text", text: `Started: ${fmtDateTimeShort(event.startedAt)}`, font: "H", size: 9 });
  L.push({ kind: "text", text: `Completed: ${fmtDateTimeShort(event.completedAt)}`, font: "H", size: 9 });
  L.push({ kind: "text", text: `${event.checkedUnits} of ${event.totalUnits} units accounted for`, font: "HB", size: 9 });
  L.push({ kind: "text", text: "", font: "H", size: 9 });

  const hasDetail = event.checkedUnitDetails && event.checkedUnitDetails.length > 0;
  if (hasDetail) {
    const checkedRows = event.checkedUnitDetails.map(u => [u.label, u.assignment || "-", u.task || "-", fmtDateTimeShort(u.checkedAt)]);
    L.push(...tableLines(["UNIT", "ASSIGNMENT", "TASK", "TIME CHECKED"], [100, 140, 140, 130], checkedRows, "Accounted For"));
    if (event.uncheckedUnitDetails && event.uncheckedUnitDetails.length > 0) {
      L.push({ kind: "text", text: "", font: "H", size: 9 });
      const uncheckedRows = event.uncheckedUnitDetails.map(u => [u.label, u.assignment || "-", u.task || "-"]);
      L.push(...tableLines(["UNIT", "ASSIGNMENT", "TASK"], [100, 140, 140], uncheckedRows, "NOT Accounted For"));
    }
  } else {
    // Older entries recorded before per-unit assignment/task/timestamp
    // detail was captured — falls back to whatever names alone were
    // saved, rather than showing a blank report.
    L.push({ kind: "heading", text: "Accounted For" });
    wrapPush(L, event.checkedUnitNames && event.checkedUnitNames.length > 0 ? event.checkedUnitNames.join(", ") : "(none recorded)");
    if (event.uncheckedUnitNames && event.uncheckedUnitNames.length > 0) {
      L.push({ kind: "text", text: "", font: "H", size: 9 });
      L.push({ kind: "heading", text: "NOT Accounted For" });
      wrapPush(L, event.uncheckedUnitNames.join(", "));
    }
  }

  const parts = buildSimplePdf(L, logo, { name: incidentName, started: fmtDateTimeShort(event.startedAt) });
  const blob = new Blob(parts, { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (incidentName || "incident").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const stamp = event.completedAt ? new Date(event.completedAt).getTime() : Date.now();
  a.download = `${safeName}-${isMayday ? "mayday" : "par"}-${stamp}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function downloadPacketPdf(data) {
  const logo = await loadLogoRGB(KFD_PATCH_DATA_URI);
  const inc = data.incident || {};
  const started = [inc.dateInitiated, inc.timeInitiated].filter(Boolean).join(" ") || (inc.opStart ? new Date(inc.opStart).toLocaleString() : "");
  // Image attachments get decoded and embedded as their own pages;
  // non-image attachments (PDFs, Word docs, etc.) are listed by name
  // in the report body instead (buildPacketLines handles that part —
  // see the "attachments" list passed through in `data`).
  const imageAttachments = (data.attachments || []).filter(a => (a.type || "").startsWith("image/"));
  const attachmentImages = [];
  // The org chart diagram is decoded here (this is the browser-only
  // step) and handed to buildPacketLines as an INLINE image placed
  // right under "9. Current Organization" — unlike attachment photos,
  // it doesn't get a trailing page of its own. Always included, not
  // gated by a checkbox, matching the text org summary next to it.
  const orgChartDataUri = renderOrgChartDataUri(normalizeOrg(data.org));
  const orgChartImage = orgChartDataUri ? await loadLogoRGB(orgChartDataUri, 1400) : null;
  // Same inline-image approach as the org chart above, placed instead
  // under "Incident Perimeter" — see the comment on
  // renderMapSnapshotDataUri for why this redraws just the
  // annotations rather than exporting the live map with its tiles.
  const mapSnapshotDataUri = await renderMapSnapshotDataUri(parseMapData(data.mapData), data.resources, data.assignmentPresets, data.resourceColumnOrder);
  const mapSnapshotImage = mapSnapshotDataUri ? await loadLogoRGB(mapSnapshotDataUri, 1400) : null;
  for (const a of imageAttachments) {
    const decoded = await loadLogoRGB(`data:${a.type};base64,${a.dataBase64}`, 1000);
    if (decoded) attachmentImages.push({ ...decoded, caption: a.name });
  }
  const parts = buildSimplePdf(buildPacketLines({ ...data, orgChartImage, mapSnapshotImage, mapData: parseMapData(data.mapData) }), logo, { name: inc.name, started }, attachmentImages);
  const blob = new Blob(parts, { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (data.incident.name || "incident").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  a.download = `${safeName}-ics-packet.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function PrintView({ incident, resources, comms, org, safety, logs }) {
  return (
    <div className="print-only" style={{ color: "#111", background: "#fff", padding: 24, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <h1 style={{ fontFamily: "'Oswald', sans-serif" }}>ICS-201 · Incident Briefing</h1>
      <p><b>Incident:</b> {incident.name} &nbsp; <b>#</b> {incident.number} &nbsp; <b>Type:</b> {incident.type}</p>
      <p><b>Location:</b> {incident.location}</p>
      <p><b>IC:</b> {incident.icName} &nbsp; <b>Prepared By:</b> {incident.preparedBy} &nbsp; <b>Op Period Start:</b> {fmtClock(incident.opStart)} {fmtDate(incident.opStart)}</p>
      <p><b>Wind:</b> {incident.wind} &nbsp; <b>Temp:</b> {incident.temp} &nbsp; <b>RH:</b> {incident.rh}</p>
      <p><b>Conditions:</b> {incident.conditions}</p>
      <p><b>Situation:</b> {incident.situation}</p>
      <p><b>Safety Message:</b> {incident.safetyMessage}</p>
      <b>Objectives:</b>
      <ol>{incident.objectives.filter(Boolean).map((o, i) => <li key={i}>{o}</li>)}</ol>

      <h2>Resource Summary</h2>
      <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>Unit</th><th>Type</th><th>Pers.</th><th>Status</th><th>Assignment</th></tr></thead>
        <tbody>{resources.map(r => <tr key={r.id}><td>{r.label}</td><td>{r.kind}</td><td>{r.personnel}</td><td>{r.status}</td><td>{r.assignment}</td></tr>)}</tbody>
      </table>

      <h2>Command Structure</h2>
      <ul>{flattenOrgFilled(org).map((item, i) => <li key={i}>{item.title}: {item.name}</li>)}</ul>

      <h2>ICS-205 Communications Plan</h2>
      <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>Ch#</th><th>Function</th><th>Channel Name</th><th>Assignment</th><th>RX</th><th>TX</th><th>Mode</th><th>Remarks</th></tr></thead>
        <tbody>{comms.rows.map(c => <tr key={c.id}><td>{c.chNum}</td><td>{c.func}</td><td>{c.channelName}</td><td>{c.assignment}</td><td>{c.rxFreq}</td><td>{c.txFreq}</td><td>{c.mode}</td><td>{c.remarks}</td></tr>)}</tbody>
      </table>

      <h2>ICS-215A Incident Action Plan Safety Analysis</h2>
      <p><b>Incident Name:</b> {incident.name} &nbsp; <b>Incident #:</b> {incident.number}</p>
      <p><b>Operational Period:</b> {safety.opFrom} &nbsp;to&nbsp; {safety.opTo}</p>
      <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>Branch</th><th>Division/Group</th><th>Hazards/Risks</th><th>Mitigations for Identified Hazards</th></tr></thead>
        <tbody>{safety.rows.map(r => <tr key={r.id}><td>{r.branch}</td><td>{r.division}</td><td>{r.hazards}</td><td>{r.mitigations}</td></tr>)}</tbody>
      </table>
      <p><b>Prepared By:</b> {safety.preparedBy} &nbsp; <b>Position/Title:</b> {safety.position} &nbsp; <b>Signature:</b> {safety.signature} &nbsp; <b>Date/Time:</b> {safety.dateTime}</p>

      <h2>ICS-214 Activity Logs</h2>
      {logs.map(l => (
        <div key={l.id} style={{ marginBottom: 12 }}>
          <p><b>{l.name}</b> — {l.position} ({l.agency})</p>
          <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={{ width: 90 }}>Time</th><th>Activity</th></tr></thead>
            <tbody>{l.entries.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).map(e => <tr key={e.id}><td>{fmtTime(e.time)}</td><td>{e.text}</td></tr>)}</tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   INCIDENT LIBRARY (load/save/new)
   ============================================================ */
// Reuses FlatListManager directly — the exact same drag-to-reorder,
// rename-inline, delete component already used for Resource Types
// under Manage Resources, so this behaves identically rather than
// introducing a second, slightly-different list-editing pattern.
// Objectives are grouped by incident type (plus a catch-all "General"
// category for anything relevant regardless of type) rather than one
// flat list — this lets the picker on the Tactical Worksheet only
// surface what's actually relevant once an incident type is chosen.
// Reuses FlatListManager for the actual list editing, same as the
// other two preset-management modals, just with a category picker on
// top to choose which type's list is currently being edited.
// Two-level "pick incident type, then pick from its objectives"
// cascading picker for the Tactical Worksheet. The second level opens
// directly beneath the selected type as its own visually distinct
// panel — a real side-flyout was considered, but those are prone to
// running off narrow phone screens, a class of bug this app has hit
// (and fixed) more than once elsewhere already, so this avoids it
// entirely rather than risk a repeat.
function ObjectivePickerDropdown({ incidentType, objectivesByType, onPick }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef(null);
  const objectives = objectivesByType[incidentType] || [];

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const pick = (objective) => {
    onPick(objective);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-block" }}>
      <Btn kind="subtle" icon={ChevronDown} onClick={() => setOpen(o => !o)} style={{ padding: "6px 11px", fontSize: 12.5 }}>
        Pick Objective{incidentType ? ` (${incidentType})` : ""}
      </Btn>
      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 100,
          background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 6,
          minWidth: 240, maxWidth: "90vw", maxHeight: 280, overflowY: "auto",
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        }}>
          {!incidentType ? (
            <div style={{ padding: "12px 14px", fontSize: 12.5, color: COLORS.faint }}>Select an Incident Type above first.</div>
          ) : objectives.length === 0 ? (
            <div style={{ padding: "12px 14px", fontSize: 12.5, color: COLORS.faint }}>No objectives set up for {incidentType} yet.</div>
          ) : (
            objectives.map(obj => (
              <button key={obj} onClick={() => pick(obj)}
                style={{ width: "100%", textAlign: "left", padding: "9px 14px", background: "transparent", border: "none", borderBottom: `1px solid ${COLORS.line}`, color: COLORS.text, cursor: "pointer", fontSize: 13 }}>
                {obj}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}


function ManageObjectivesModal({ onClose, onBack, incidentTypes, objectivesByType, onAdd, onRename, onDelete, onReorder }) {
  // Category list is exactly the incident types list from Manage
  // Incident Types — no extra catch-all category, so the two stay in
  // lockstep with each other rather than the objectives side having
  // its own separate notion of what a category is.
  const [selectedCategory, setSelectedCategory] = useState(incidentTypes[0] || "");
  const list = objectivesByType[selectedCategory] || [];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 400, maxHeight: "85vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Manage Objectives</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
          Objectives are grouped by incident type — pick one below to edit its list. This is the same list of types managed under Manage Incident Types.
        </div>
        {incidentTypes.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.faint }}>No incident types set up yet — add some under Manage Incident Types first.</div>
        ) : (
          <>
            <Field label="Incident Type">
              <Select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
                {incidentTypes.map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <div style={{ marginTop: 14 }}>
              <FlatListManager
                items={list}
                onAdd={(name) => onAdd(selectedCategory, name)}
                onRename={(oldName, newName) => onRename(selectedCategory, oldName, newName)}
                onDelete={(name) => onDelete(selectedCategory, name)}
                onReorder={(newList) => onReorder(selectedCategory, newList)}
                addLabel="Add Objective" addPlaceholder="New objective" emptyLabel="None yet."
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Filters the assignment/division dropdown at check-in (ResourceForm)
// down to a per-incident-type subset — a checkbox picker over the
// existing shared assignments list, not a freeform list of its own,
// since a division like "Division A" is typically reusable across
// several incident types rather than being specific to one.
function ManageAssignmentsByTypeModal({ onClose, onBack, incidentTypes, assignmentPresets, assignmentsByType, onToggle }) {
  const [selectedCategory, setSelectedCategory] = useState(incidentTypes[0] || "");
  const selected = assignmentsByType[selectedCategory] || [];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 400, maxHeight: "85vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Assignments by Incident Type</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
          Pick which of the existing assignments/divisions show up at check-in for each incident type. Leaving none checked for a type shows every assignment for that type instead — this only narrows the list once you've actually picked some.
        </div>
        {incidentTypes.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.faint }}>No incident types set up yet — add some under Manage Incident Types first.</div>
        ) : assignmentPresets.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.faint }}>No assignments set up yet — add some under Manage Resources first.</div>
        ) : (
          <>
            <Field label="Incident Type">
              <Select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
                {incidentTypes.map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {assignmentPresets.map(a => (
                <label key={a} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={selected.includes(a)} onChange={() => onToggle(selectedCategory, a)} style={{ width: 15, height: 15 }} />
                  {a}
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Same pattern as ManageAssignmentsByTypeModal above, for the task
// dropdown instead.
function ManageTasksByTypeModal({ onClose, onBack, incidentTypes, taskPresets, tasksByType, onToggle }) {
  const [selectedCategory, setSelectedCategory] = useState(incidentTypes[0] || "");
  const selected = tasksByType[selectedCategory] || [];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 400, maxHeight: "85vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Tasks by Incident Type</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
          Pick which of the existing tasks show up at check-in for each incident type. Leaving none checked for a type shows every task for that type instead — this only narrows the list once you've actually picked some.
        </div>
        {incidentTypes.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.faint }}>No incident types set up yet — add some under Manage Incident Types first.</div>
        ) : taskPresets.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.faint }}>No tasks set up yet — add some under Manage Resources first.</div>
        ) : (
          <>
            <Field label="Incident Type">
              <Select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
                {incidentTypes.map(c => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {taskPresets.map(t => (
                <label key={t} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13, cursor: "pointer" }}>
                  <input type="checkbox" checked={selected.includes(t)} onChange={() => onToggle(selectedCategory, t)} style={{ width: 15, height: 15 }} />
                  {t}
                </label>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ManageIncidentTypesModal({ onClose, onBack, incidentTypes, onAdd, onRename, onDelete, onReorder }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 380, maxHeight: "85vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Manage Incident Types</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
          Edit a name and click away (or press Enter) to rename it. Drag to reorder — this is also the order shown in the Type dropdown on the Tactical Worksheet.
        </div>
        <FlatListManager
          items={incidentTypes} onRename={onRename} onDelete={onDelete} onReorder={onReorder} onAdd={onAdd}
          addLabel="Add Incident Type" addPlaceholder="New incident type" emptyLabel="None yet." />
      </div>
    </div>
  );
}

// Consolidates the board's two credential-management actions —
// changing the main PIN and changing the admin password itself —
// behind the single "Admin" button in the header, which is already
// gated by the admin password via PasswordConfirmModal before this
// ever renders. Previously, changing the admin password specifically
// only lived inside the archive browsing flow, several steps removed
// from where someone would naturally look for it.
function AdminModal({ onClose, onChangePin, onChangeAdminPassword, onManageIncidentTypes, onManageResources, onManageObjectives, onManageAssignmentsByType, onManageTasksByType, onManageParSettings }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Admin</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Btn kind="ghost" icon={KeyRound} onClick={onChangePin} style={{ width: "100%", justifyContent: "center" }}>Change PIN</Btn>
          <Btn kind="ghost" icon={Lock} onClick={onChangeAdminPassword} style={{ width: "100%", justifyContent: "center" }}>Change Admin Password</Btn>
          <Btn kind="ghost" icon={ClipboardList} onClick={onManageIncidentTypes} style={{ width: "100%", justifyContent: "center" }}>Manage Incident Types</Btn>
          <Btn kind="ghost" icon={Settings} onClick={onManageResources} style={{ width: "100%", justifyContent: "center" }}>Manage Resources</Btn>
          <Btn kind="ghost" icon={Star} onClick={onManageObjectives} style={{ width: "100%", justifyContent: "center" }}>Manage Objectives</Btn>
          <Btn kind="ghost" icon={Layers} onClick={onManageAssignmentsByType} style={{ width: "100%", justifyContent: "center" }}>Assignments by Incident Type</Btn>
          <Btn kind="ghost" icon={CheckCircle2} onClick={onManageTasksByType} style={{ width: "100%", justifyContent: "center" }}>Tasks by Incident Type</Btn>
          <Btn kind="ghost" icon={AlertTriangle} onClick={onManageParSettings} style={{ width: "100%", justifyContent: "center" }}>PAR / Mayday Settings</Btn>
        </div>
      </div>
    </div>
  );
}

// A single, focused setting rather than a full FlatListManager-style
// modal, since there's only one value to manage here.
function ParSettingsModal({ onClose, onBack, parIntervalMinutes, onSave }) {
  const [value, setValue] = useState(String(parIntervalMinutes));
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 340, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>PAR / Mayday Settings</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        <Field label="PAR Reminder Interval (minutes)">
          <TextInput type="number" min="1" value={value} onChange={e => setValue(e.target.value)} />
        </Field>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginTop: 8, lineHeight: 1.5 }}>
          A reminder pops up this often, counting from the last completed PAR, prompting a fresh accountability check.
        </div>
        <Btn kind="solid" onClick={() => { onSave(value); onClose(); }} style={{ width: "100%", justifyContent: "center", marginTop: 14 }}>Save</Btn>
      </div>
    </div>
  );
}

function ChangePinModal({ onClose, onBack }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState(""); // "" | "saving" | "done"

  const submit = async () => {
    setError("");
    const cfg = await loadPinConfig();
    const currentHash = await sha256(current);
    if (!cfg || currentHash !== cfg.pinHash) { setError("Incorrect current PIN."); return; }
    if (next.length < 4) { setError("New PIN must be at least 4 digits."); return; }
    if (next !== confirm) { setError("New PINs don't match."); return; }
    setStatus("saving");
    const nextHash = await sha256(next);
    await savePinConfig({ ...cfg, pinHash: nextHash });
    refreshUnlockRecord(nextHash);
    setStatus("done");
    setTimeout(onClose, 900);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Change PIN</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        {status === "done" ? (
          <div style={{ color: COLORS.teal, fontSize: 13, textAlign: "center", padding: "10px 0" }}>PIN updated.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Current PIN">
              <TextInput id="change-pin-current" name="change-pin-current" autoComplete="off" type="password" inputMode="numeric" value={current} onChange={e => setCurrent(e.target.value.replace(/\D/g, ""))} maxLength={12} />
            </Field>
            <Field label="New PIN">
              <TextInput id="change-pin-new" name="change-pin-new" autoComplete="off" type="password" inputMode="numeric" value={next} onChange={e => setNext(e.target.value.replace(/\D/g, ""))} maxLength={12} />
            </Field>
            <Field label="Confirm New PIN">
              <TextInput id="change-pin-confirm" name="change-pin-confirm" autoComplete="off" type="password" inputMode="numeric" value={confirm} onChange={e => setConfirm(e.target.value.replace(/\D/g, ""))} maxLength={12}
                onKeyDown={e => e.key === "Enter" && submit()} />
            </Field>
            {error && <div style={{ color: COLORS.dangerText, fontSize: 12 }}>{error}</div>}
            <Btn kind="solid" onClick={submit} disabled={status === "saving"} style={{ justifyContent: "center" }}>
              {status === "saving" ? "Saving…" : "Save New PIN"}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// Mirrors ChangePinModal above, but targets the archive's separate
// password (archivePinHash) rather than the board's main PIN — kept as
// its own component since the two are genuinely different credentials.
function ChangeArchivePasswordModal({ onClose, onBack }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState(""); // "" | "saving" | "done"

  const submit = async () => {
    setError("");
    const cfg = await loadPinConfig();
    const currentHash = await sha256(current);
    if (!cfg || currentHash !== cfg.archivePinHash) { setError("Incorrect current admin password."); return; }
    if (next.length < 4) { setError("New password must be at least 4 characters."); return; }
    if (next !== confirm) { setError("New passwords don't match."); return; }
    setStatus("saving");
    const nextHash = await sha256(next);
    await savePinConfig({ ...cfg, archivePinHash: nextHash });
    localStorage.setItem(ARCHIVE_UNLOCK_KEY, nextHash);
    setStatus("done");
    setTimeout(onClose, 900);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && <button onClick={onBack} title="Back to Admin" style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer", display: "flex", alignItems: "center" }}><ChevronLeft size={18} /></button>}
            <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Change Admin Password</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        {status === "done" ? (
          <div style={{ color: COLORS.teal, fontSize: 13, textAlign: "center", padding: "10px 0" }}>Admin password updated.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Current Admin Password">
              <TextInput id="change-archive-pw-current" name="change-archive-pw-current" autoComplete="off" type="password" value={current} onChange={e => setCurrent(e.target.value)} />
            </Field>
            <Field label="New Admin Password">
              <TextInput id="change-archive-pw-new" name="change-archive-pw-new" autoComplete="off" type="password" value={next} onChange={e => setNext(e.target.value)} />
            </Field>
            <Field label="Confirm New Password">
              <TextInput id="change-archive-pw-confirm" name="change-archive-pw-confirm" autoComplete="off" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                onKeyDown={e => e.key === "Enter" && submit()} />
            </Field>
            {error && <div style={{ color: COLORS.dangerText, fontSize: 12 }}>{error}</div>}
            <Btn kind="solid" onClick={submit} disabled={status === "saving"} style={{ justifyContent: "center" }}>
              {status === "saving" ? "Saving…" : "Save New Password"}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// Generic password gate for a destructive/protected action — checks
// against the same archivePinHash used to view archived incidents and
// manage resources (now referred to as the "admin password" in the
// UI, since it protects more than just the archive), rather than a
// separate credential per feature. If no admin password has ever
// been set, the action can't be confirmed (nothing to check against)
// rather than silently allowing it through unprotected.
function PasswordConfirmModal({ title, message, onConfirm, onCancel }) {
  const [phase, setPhase] = useState("loading"); // loading | notSet | prompt
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    (async () => {
      const cfg = await loadPinConfig();
      setPhase(cfg && cfg.archivePinHash ? "prompt" : "notSet");
    })();
  }, []);

  const submit = async () => {
    setError("");
    setChecking(true);
    const cfg = await loadPinConfig();
    const hash = await sha256(pin);
    setChecking(false);
    if (cfg && cfg.archivePinHash && hash === cfg.archivePinHash) {
      onConfirm();
    } else {
      setError("Incorrect admin password.");
      setPin("");
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>{title}</span>
          <button onClick={onCancel} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        {phase === "loading" && <div style={{ color: COLORS.muted, fontSize: 13 }}>Loading…</div>}
        {phase === "notSet" && (
          <div style={{ fontSize: 12.5, color: COLORS.muted, lineHeight: 1.5 }}>
            No admin password has been set yet, so this action can't be confirmed. Set one first from "View Archived Incidents" in the library.
          </div>
        )}
        {phase === "prompt" && (
          <>
            <p style={{ fontSize: 12.5, color: COLORS.muted, marginTop: 0, lineHeight: 1.5 }}>{message}</p>
            <TextInput id="archive-unlock-pw" name="archive-unlock-pw" autoComplete="off" type="password" autoFocus placeholder="Admin password" value={pin} onChange={e => setPin(e.target.value)} style={{ width: "100%" }}
              onKeyDown={e => e.key === "Enter" && submit()} />
            <Btn kind="solid" onClick={submit} disabled={checking} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
              {checking ? "Checking…" : "Confirm"}
            </Btn>
            {error && <div style={{ color: COLORS.dangerText, fontSize: 12.5, marginTop: 10, textAlign: "center" }}>{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function LibraryModal({ index, onClose, onLoad, onNew, onDelete, onArchive, onOpenArchive, onOpenAdmin, mandatory }) {
  const active = index.filter(i => !i.archived);
  const archivedCount = index.length - active.length;
  const [confirmAction, setConfirmAction] = useState(null); // { type: "archive" | "delete", id, name }
  const [showLibMenu, setShowLibMenu] = useState(false);
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 480, maxHeight: "80vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${COLORS.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src={KFD_PATCH_DATA_URI} alt="KFD Patch" style={{ width: 26, height: 34, objectFit: "contain", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, letterSpacing: "0.03em", lineHeight: 1.1 }}>COMMAND BOARD</div>
              <div style={{ fontSize: 9, color: COLORS.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Incident Management System</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: COLORS.muted, letterSpacing: "0.05em", textTransform: "uppercase" }}>Incident Library</span>
            {/* Same menu/drawer pattern as the main header — Admin
                lives inside it rather than as its own button here,
                for the same reason it moved there: not something
                glanced at, just an occasional destination. */}
            <button onClick={() => setShowLibMenu(true)} title="Menu"
              style={{ background: "none", border: `1px solid ${COLORS.line}`, borderRadius: 5, color: COLORS.text, cursor: "pointer", padding: "5px 8px", display: "flex", alignItems: "center" }}>
              <Menu size={16} />
            </button>
            {!mandatory && <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>}
          </div>
        </div>
        {showLibMenu && (
          <div onClick={() => setShowLibMenu(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100 }}>
            <style>{`@keyframes cbHeaderMenuSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
            <div onClick={e => e.stopPropagation()}
              style={{
                position: "absolute", top: 0, right: 0, bottom: 0, width: 240, maxWidth: "85vw",
                background: COLORS.panel, borderLeft: `1px solid ${COLORS.line}`, boxShadow: "-4px 0 16px rgba(0,0,0,0.4)",
                padding: 16, overflowY: "auto", animation: "cbHeaderMenuSlideIn 0.2s ease-out",
                display: "flex", flexDirection: "column", gap: 10,
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Menu</span>
                <button onClick={() => setShowLibMenu(false)} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>
              </div>
              <Btn kind="ghost" icon={Settings} onClick={() => { setShowLibMenu(false); onOpenAdmin(); }} style={{ width: "100%", justifyContent: "center" }}>Admin</Btn>
            </div>
          </div>
        )}
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 12, lineHeight: 1.5 }}>
            {mandatory ? "Select an incident to open, or start a new one." : "Shared board — visible and editable by anyone who opens this app. Changes sync to other users within a few seconds."}
          </div>
          <Btn kind="solid" icon={Plus} onClick={() => setConfirmAction({ type: "new" })} style={{ marginBottom: 14, width: "100%", justifyContent: "center" }}>Start New Incident</Btn>
          {active.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13 }}>No active incidents.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {active.map(item => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "9px 12px" }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{item.name || "Unnamed Incident"}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{item.type} · {fmtDate(item.savedAt)}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn kind="subtle" onClick={() => onLoad(item.id)} style={{ padding: "5px 9px", fontSize: 12 }}>Open</Btn>
                  <Btn kind="ghost" onClick={() => setConfirmAction({ type: "archive", id: item.id, name: item.name })} title="Archive" style={{ padding: "5px 9px", fontSize: 12 }}><Archive size={13} /></Btn>
                  <Btn kind="danger" onClick={() => setConfirmAction({ type: "delete", id: item.id, name: item.name })} style={{ padding: "5px 9px", fontSize: 12 }}><Trash2 size={13} /></Btn>
                </div>
              </div>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${COLORS.line}`, marginTop: 16, paddingTop: 12 }}>
            <Btn kind="ghost" icon={Archive} onClick={onOpenArchive} style={{ width: "100%", justifyContent: "center", fontSize: 12.5 }}>
              View Archived Incidents{archivedCount > 0 ? ` (${archivedCount})` : ""}
            </Btn>
          </div>
        </div>
      </div>

      {confirmAction && (
        <PasswordConfirmModal
          title={confirmAction.type === "archive" ? "Confirm Archive" : confirmAction.type === "delete" ? "Confirm Delete" : "Confirm New Incident"}
          message={
            confirmAction.type === "archive"
              ? `Enter the admin password to archive "${confirmAction.name || "Unnamed Incident"}".`
              : confirmAction.type === "delete"
                ? `Enter the admin password to permanently delete "${confirmAction.name || "Unnamed Incident"}". This can't be undone.`
                : "Enter the admin password to start a new incident."
          }
          onConfirm={() => {
            if (confirmAction.type === "archive") onArchive(confirmAction.id);
            else if (confirmAction.type === "delete") onDelete(confirmAction.id);
            else onNew();
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}

const ARCHIVE_UNLOCK_KEY = "cb_archive_unlocked_hash";

// Gated behind its own password (separate from the board's main PIN) —
// browsing here shows every archived incident with a one-click PDF
// export, or a restore button to bring it back into the active list.
function ArchiveModal({ index, onClose, onExport, onRestore }) {
  const [phase, setPhase] = useState("loading"); // loading | setup | locked | browse
  const [config, setConfig] = useState(null);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const cfg = await loadPinConfig();
      setConfig(cfg);
      if (!cfg || !cfg.archivePinHash) { setPhase("setup"); return; }
      const remembered = localStorage.getItem(ARCHIVE_UNLOCK_KEY);
      setPhase(remembered === cfg.archivePinHash ? "browse" : "locked");
    })();
  }, []);

  const doSetup = async () => {
    setError("");
    if (pin.length < 4) return setError("Password must be at least 4 characters.");
    if (pin !== pin2) return setError("Passwords don't match.");
    const archivePinHash = await sha256(pin);
    await savePinConfig({ ...config, archivePinHash });
    localStorage.setItem(ARCHIVE_UNLOCK_KEY, archivePinHash);
    setPhase("browse");
  };
  const doUnlock = async () => {
    setError("");
    const hash = await sha256(pin);
    if (config && hash === config.archivePinHash) {
      localStorage.setItem(ARCHIVE_UNLOCK_KEY, hash);
      setPhase("browse");
    } else {
      setError("Incorrect password.");
      setPin("");
    }
  };

  const archived = index.filter(i => i.archived);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 420, maxHeight: "80vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${COLORS.line}` }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em" }}>Archived Incidents</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>
        </div>
        <div style={{ padding: 16 }}>
          {phase === "loading" && <div style={{ color: COLORS.muted, fontSize: 13 }}>Loading…</div>}

          {(phase === "setup" || phase === "locked") && (
            <>
              <p style={{ fontSize: 12.5, color: COLORS.muted, lineHeight: 1.5, marginTop: 0 }}>
                {phase === "setup"
                  ? "No admin password is set yet. Choose one now — this is separate from the board's main PIN, and is only needed to view or export incidents that have been closed out."
                  : "Enter the admin password to view closed-out incidents."}
              </p>
              <TextInput id="archive-pw-primary" name="archive-pw-primary" autoComplete="off" type="password" autoFocus placeholder={phase === "setup" ? "New admin password" : "Admin password"} value={pin}
                onChange={e => setPin(e.target.value)} style={{ width: "100%" }}
                onKeyDown={e => e.key === "Enter" && phase === "locked" && doUnlock()} />
              {phase === "setup" && (
                <TextInput id="archive-pw-confirm" name="archive-pw-confirm" autoComplete="off" type="password" placeholder="Confirm password" value={pin2} onChange={e => setPin2(e.target.value)}
                  style={{ width: "100%", marginTop: 10 }}
                  onKeyDown={e => e.key === "Enter" && doSetup()} />
              )}
              <Btn kind="solid" onClick={phase === "setup" ? doSetup : doUnlock} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
                {phase === "setup" ? "Set Password & Continue" : "Unlock"}
              </Btn>
              {error && <div style={{ color: COLORS.dangerText, fontSize: 12.5, marginTop: 10, textAlign: "center" }}>{error}</div>}
            </>
          )}

          {phase === "browse" && (
            <>
              {archived.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13 }}>No archived incidents.</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {archived.map(item => (
                  <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "9px 12px" }}>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{item.name || "Unnamed Incident"}</div>
                      <div style={{ fontSize: 11, color: COLORS.muted }}>{item.type} · archived {fmtDate(item.archivedAt)}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn kind="subtle" onClick={() => onExport(item.id)} style={{ padding: "5px 9px", fontSize: 12 }}>Export PDF</Btn>
                      <Btn kind="ghost" onClick={() => onRestore(item.id)} title="Restore to active" style={{ padding: "5px 9px", fontSize: 12 }}><RotateCcw size={13} /></Btn>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   APP
   ============================================================ */
const TABS = [
  { k: "201", label: "Tactical Worksheet", icon: ClipboardList },
  { k: "resources", label: "Resource Board", icon: Truck },
  { k: "mapping", label: "Mapping", icon: MapIcon },
  { k: "weather", label: "Weather", icon: CloudSun },
  { k: "org", label: "Org Chart", icon: Users },
  { k: "rehab", label: "Rehab", icon: HeartPulse },
  { k: "icsforms", label: "ICS Forms", icon: Layers },
  { k: "attachments", label: "Attachments", icon: Paperclip },
];

// Rendered at the very top of the tree, outside PinGate, so the dark
// theme's page reset (no white margin/background) is active even
// before the PIN gate decides what to show — otherwise the browser's
// default white body margin is visible around the lock screen.
function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
      ${THEME_CSS}
      * { box-sizing: border-box; }
      html {
        /* iOS Safari automatically boosts font sizes when it judges
           the viewport "wide enough" — most noticeably right after
           rotating to landscape — on the assumption that's helping
           readability. This turns that off explicitly so text stays
           the size the CSS actually specifies, regardless of device
           orientation. */
        -webkit-text-size-adjust: 100%;
        text-size-adjust: 100%;
      }
      html, body, #root { margin: 0; padding: 0; min-height: 100%; background: ${COLORS.bg}; }
      select { -webkit-appearance: none; }
      input:focus, textarea:focus, select:focus { border-color: ${COLORS.amber} !important; }
      /* Native date/time picker icons default to a dark glyph — fine
         against our dark theme's inputs, but wrong (invisible) against
         light theme's, so both the color-scheme and the icon invert
         follow the active theme via CSS variables instead of being
         hardcoded to dark. */
      input[type="date"]::-webkit-calendar-picker-indicator,
      input[type="time"]::-webkit-calendar-picker-indicator,
      input[type="datetime-local"]::-webkit-calendar-picker-indicator {
        filter: invert(var(--cb-picker-invert));
        cursor: pointer;
      }
      input[type="date"], input[type="time"], input[type="datetime-local"] {
        color-scheme: var(--cb-picker-scheme);
      }
      /* iOS/iPadOS Safari centers the displayed value inside date/time
         inputs by default (via this internal pseudo-element), unlike
         every other browser (and every other input type in this app),
         which left-align it — this forces the same left alignment
         Safari already uses everywhere else, so these fields don't
         stand out as different on an iPad. */
      input[type="date"]::-webkit-date-and-time-value,
      input[type="time"]::-webkit-date-and-time-value,
      input[type="datetime-local"]::-webkit-date-and-time-value {
        text-align: left;
      }
      ::-webkit-scrollbar { height: 8px; width: 8px; }
      ::-webkit-scrollbar-thumb { background: ${COLORS.line}; border-radius: 4px; }
      .print-only { display: none; }
      @media print {
        .no-print { display: none !important; }
        .print-only { display: block !important; }
      }
    `}</style>
  );
}

export default function App() {
  // Lives above PinGate (not inside AppInner) so the chosen theme is
  // already applied — via the data-theme attribute on <html>, which
  // every COLORS.xxx reference resolves through via CSS variables —
  // before the lock screen itself even renders, not just after unlock.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("cb-theme") || "dark"; } catch { return "dark"; }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("cb-theme", theme); } catch { /* private browsing, etc. — theme just won't persist */ }
  }, [theme]);
  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");

  return (
    <>
      <GlobalStyles />
      <PinGate>
        {(lock) => <AppInner onLock={lock} theme={theme} toggleTheme={toggleTheme} />}
      </PinGate>
    </>
  );
}

// Tracks browser connectivity so the UI can tell the crew when they're
// on cached/offline data versus live. navigator.onLine reflects network
// interface state, not whether Firestore specifically can reach its
// servers, but it's a reliable enough signal for this purpose.
function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

function AppInner({ onLock, theme, toggleTheme }) {
  const online = useOnlineStatus();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("201");
  const [showLib, setShowLib] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [showAdminAuth, setShowAdminAuth] = useState(false);
  const [showAdminMenu, setShowAdminMenu] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showManageIncidentTypes, setShowManageIncidentTypes] = useState(false);
  // Lifted up from TabResources (rather than local state there) since
  // this now also needs to be reachable from the Admin menu, which is
  // available from any tab — local state inside TabResources would
  // only ever take effect while that specific tab happened to be the
  // one currently mounted.
  const [showManageResources, setShowManageResources] = useState(false);
  // Manage Resources has two separate entry points (its own button on
  // the Resource Board, and now also the Admin menu) — this tracks
  // which one was used so the "Back to Admin" button only shows up
  // when there's actually an Admin menu to go back to.
  const [manageResourcesFromAdmin, setManageResourcesFromAdmin] = useState(false);
  const [showManageObjectives, setShowManageObjectives] = useState(false);
  const [showManageAssignmentsByType, setShowManageAssignmentsByType] = useState(false);
  const [showManageTasksByType, setShowManageTasksByType] = useState(false);
  const [showParSettings, setShowParSettings] = useState(false);
  const [showManageResourcesAuth, setShowManageResourcesAuth] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showChangeArchivePassword, setShowChangeArchivePassword] = useState(false);
  const [presets, setPresets] = useState({ departments: [], objectives: [], assignments: [], resourceKinds: [], incidentTypes: [], objectivesByType: {}, assignmentsByType: {}, tasksByType: {}, tasks: [], parIntervalMinutes: 15 });
  const [formsUsed, setFormsUsed] = useState({});
  const [attachments, setAttachments] = useState([]);
  const toggleFormUsed = (key) => setFormsUsed(f => ({ ...f, [key]: !f[key] }));
  const [incidentLoaded, setIncidentLoaded] = useState(false);
  const [index, setIndex] = useState([]);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [now, setNow] = useState(Date.now());

  const [incident, setIncident] = useState(blankIncident());
  const [resources, setResources] = useState([]);
  // Persisted per-incident (not a global preset) since different
  // incidents may reasonably want their Resource Board divisions
  // arranged in a different order — saved/loaded/autosaved alongside
  // resources itself, the exact same way.
  const [resourceColumnOrder, setResourceColumnOrder] = useState([]);
  const [showMaydayModal, setShowMaydayModal] = useState(false);
  const [showParModal, setShowParModal] = useState(false);
  const [showMaydayConfirm, setShowMaydayConfirm] = useState(false);
  // Tracks the separate, dedicated cross-device Mayday alert (see
  // triggerMaydayAlert/watchMaydayAlert in store.js) — distinct from
  // showMaydayModal, since a remote Mayday needs to force the modal
  // open (and the alarm playing) on this device even if this device
  // isn't the one that triggered it.
  const [maydayAlertActive, setMaydayAlertActive] = useState(false);
  // Local to THIS device only — never synced. Pressing "Silence
  // Alarm" only quiets it here; every other device keeps sounding
  // until they silence it themselves, take PAR themselves, or the
  // Mayday is cleared entirely. Resets to false the moment a fresh
  // Mayday starts, so a silenced alarm from a past Mayday can't
  // accidentally suppress a brand new one.
  const [alarmSilenced, setAlarmSilenced] = useState(false);
  // Covers two gaps: (1) this device skipping the PIN screen entirely
  // via the grace period (see PinGate.jsx), meaning
  // unlockAudioContext was never called from there, and (2) iOS
  // re-suspending an already-unlocked context whenever the tab loses
  // focus/backgrounds — resuming opportunistically on every tap and
  // on regaining visibility gives a remotely-triggered Mayday the
  // best realistic chance of playing audibly on this device, though
  // it can't fully overcome a genuinely locked/backgrounded phone
  // (see the comments in audio.js for why).
  useEffect(() => setupAudioResumeListeners(), []);
  const [org, setOrg] = useState({ positions: {}, divisions: [] });
  const [comms, setComms] = useState(defaultComms());
  const [safety, setSafety] = useState({ opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] });
  const [ics208, setIcs208] = useState(defaultIcs208());
  const [ics208hm, setIcs208hm] = useState(defaultIcs208HM());
  const [ics209, setIcs209] = useState(defaultIcs209());
  const [ics206, setIcs206] = useState(defaultIcs206());
  const [rehab, setRehab] = useState([]);
  const [mapData, setMapData] = useState(defaultMapData());
  const [logs, setLogs] = useState([]);

  const saveTimer = useRef(null);
  const lastKnownUpdatedAt = useRef(null);
  const dirty = useRef(false); // true while a local edit hasn't been written to shared storage yet
  // Set to true by applyBlob() every time it's called to LOAD data (opening
  // an incident, starting new, or receiving a real-time update from
  // another device) — never for a genuine local edit. The autosave effect
  // checks this and skips the very next save cycle when it's set. Without
  // this, simply opening an incident re-saves whatever was just loaded
  // back to Firestore (because `incidentLoaded` is one of autosave's
  // dependencies), which silently overwrites newer data with an older
  // cached copy on any device that hadn't synced recently — the exact
  // failure mode that caused entered data to be wiped out.
  const suppressNextAutosave = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      const idx = await loadIndex();
      setIndex(idx);
      const p = await loadPresets();
      // Migrate the old flat unit list (before departments existed) into
      // a "General" department bucket, so nobody's already-saved units
      // silently disappear when this ships — they just land somewhere
      // reorganizable instead of a fixed department nobody chose.
      let departments = p.departments || [];
      if (!p.departments && p.units && p.units.length > 0) {
        departments = [{ id: uid(), name: "General", units: p.units }];
      }
      // Resource Type was a hardcoded, non-editable list before this —
      // seed it from that same list on first load so nothing changes
      // for anyone until they actually go edit it.
      const resourceKinds = p.resourceKinds && p.resourceKinds.length > 0 ? p.resourceKinds : RESOURCE_KINDS;
      // Same pattern for Incident Type — was a hardcoded list with a
      // fixed color per entry; seeded from just the names here, with
      // color now assigned by list position instead (see
      // incidentTypeColor) so a custom/added type still gets one
      // without needing a color-picker UI of its own.
      const incidentTypes = p.incidentTypes && p.incidentTypes.length > 0 ? p.incidentTypes : INCIDENT_TYPES.map(t => t.v);
      // Objectives used to be one flat list shared across every
      // incident regardless of type — migrated into a "General"
      // category here (rather than discarded) so anything already
      // saved keeps showing up as a suggestion, just alongside the
      // new per-type categories instead of being the only list.
      const objectivesByType = p.objectivesByType || (p.objectives && p.objectives.length > 0 ? { General: p.objectives } : {});
      // Which of the existing (already-shared) assignments/divisions
      // are relevant for a given incident type — a membership map
      // rather than a separate freeform list per type, since
      // divisions are a shared, reusable pool (unlike objectives,
      // which are inherently type-specific text). Empty/missing for a
      // type means "not yet configured", not "nothing available" —
      // see the fallback in ResourceForm, which shows every
      // assignment for any type that hasn't had a filter set up.
      const assignmentsByType = p.assignmentsByType || {};
      // Same membership-map pattern as assignmentsByType above, for
      // the task dropdown instead.
      const tasksByType = p.tasksByType || {};
      const tasks = p.tasks || [];
      const parIntervalMinutes = p.parIntervalMinutes || 15;
      setPresets({ departments, objectives: p.objectives || [], assignments: p.assignments || [], resourceKinds, incidentTypes, objectivesByType, assignmentsByType, tasksByType, tasks, parIntervalMinutes });
      setReady(true);
      setShowLib(true); // land on the incident library instead of auto-opening one
    })();
  }, []);

  // The incident's Date/Time Initiated is the starting point for every
  // ICS form's Operational Period — kept in sync with each form's
  // "From" field on every change. This always overwrites, by design:
  // if a specific form needs its own different operational period,
  // set it there AFTER the incident's initiated time is finalized, or
  // it'll get overwritten the next time Date/Time Initiated changes.
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    if (!incident.dateInitiated && !incident.timeInitiated) return;
    const combined = incident.dateInitiated ? `${incident.dateInitiated}T${incident.timeInitiated || "00:00"}` : "";
    if (!combined) return;
    setComms(c => ({ ...c, opFrom: combined }));
    setSafety(s => ({ ...s, opFrom: combined }));
    setIcs208(v => ({ ...v, opFrom: combined }));
    setIcs208hm(v => ({ ...v, opFrom: combined }));
    setIcs209(v => ({ ...v, opFrom: combined }));
    setIcs206(v => ({ ...v, opFrom: combined }));
  }, [incident.dateInitiated, incident.timeInitiated, ready, incidentLoaded]);

  // Same idea for "Operational Period To" — paired with Date/Time
  // Terminated, falling back to Date Initiated if Date Terminated
  // hasn't been filled in (covers the common same-day case). Always
  // overwrites on every change, same tradeoff as the "From" sync above.
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    const terminationDate = incident.dateTerminated || incident.dateInitiated;
    if (!terminationDate || !incident.timeTerminated) return;
    const combinedTo = `${terminationDate}T${incident.timeTerminated}`;
    setComms(c => ({ ...c, opTo: combinedTo }));
    setSafety(s => ({ ...s, opTo: combinedTo }));
    setIcs208(v => ({ ...v, opTo: combinedTo }));
    setIcs208hm(v => ({ ...v, opTo: combinedTo }));
    setIcs209(v => ({ ...v, opTo: combinedTo }));
    setIcs206(v => ({ ...v, opTo: combinedTo }));
  }, [incident.dateInitiated, incident.dateTerminated, incident.timeTerminated, ready, incidentLoaded]);

  // Keep ICS-201's Block 10 Resource Summary in sync with the Resource
  // Board: every checked-in resource gets (or keeps updated) a matching
  // row — Resource Identifier from its unit ID, Arrived always checked
  // with the check-in time standing in for arrival time, and Notes
  // reflecting its current assignment. Rows are matched by
  // sourceResourceId so a resource's row keeps updating as its
  // assignment changes, without disturbing any row someone added by
  // hand for something ordered but not yet on the board (those don't
  // have a sourceResourceId, so this loop never touches them). Existing
  // rows are updated in place rather than removed if a resource later
  // leaves the board, since an arrival record shouldn't disappear.
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    setIncident(inc => {
      const bySource = new Map(inc.resourceOrders.filter(r => r.sourceResourceId).map(r => [r.sourceResourceId, r]));
      let changed = false;
      const nextOrders = [...inc.resourceOrders];
      resources.forEach(r => {
        const arrivedTime = r.checkIn ? new Date(r.checkIn).toTimeString().slice(0, 5) : "";
        const existing = bySource.get(r.id);
        const synced = { resource: r.kind, identifier: r.label, eta: arrivedTime, arrived: true, notes: r.assignment || "", sourceResourceId: r.id };
        if (existing) {
          const idx = nextOrders.findIndex(o => o.id === existing.id);
          const updated = { ...existing, ...synced };
          if (updated.resource !== existing.resource || updated.identifier !== existing.identifier || updated.eta !== existing.eta || updated.arrived !== existing.arrived || updated.notes !== existing.notes) {
            nextOrders[idx] = updated;
            changed = true;
          }
        } else {
          nextOrders.push({ id: uid(), ordered: "", ...synced });
          changed = true;
        }
      });
      return changed ? { ...inc, resourceOrders: nextOrders } : inc;
    });
  }, [resources, ready, incidentLoaded]);

  // Returns the department's id synchronously (creating it if new) so
  // the picker can switch straight to it without waiting on the network
  // round-trip — the actual persist happens in the background.
  const saveDepartment = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = presets.departments.find(d => d.name === trimmed);
    if (existing) return existing.id;
    const id = uid();
    const next = { ...presets, departments: [...presets.departments, { id, name: trimmed, units: [] }] };
    setPresets(next);
    savePresets(next);
    return id;
  };
  const saveUnitUnderDepartment = (deptId, unitName) => {
    const trimmed = unitName.trim();
    if (!deptId || !trimmed) return;
    const dept = presets.departments.find(d => d.id === deptId);
    if (!dept || dept.units.includes(trimmed)) return;
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: [...d.units, trimmed] } : d) };
    setPresets(next);
    savePresets(next);
  };
  const renameDepartment = (deptId, newName) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, name: newName } : d) };
    setPresets(next);
    savePresets(next);
  };
  const deleteDepartment = (deptId) => {
    const next = { ...presets, departments: presets.departments.filter(d => d.id !== deptId) };
    setPresets(next);
    savePresets(next);
  };
  const renameUnit = (deptId, oldName, newName) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: d.units.map(u => u === oldName ? newName : u) } : d) };
    setPresets(next);
    savePresets(next);
  };
  const deleteUnit = (deptId, unitName) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: d.units.filter(u => u !== unitName) } : d) };
    setPresets(next);
    savePresets(next);
  };
  const moveUnit = (fromDeptId, unitName, toDeptId) => {
    if (fromDeptId === toDeptId) return;
    const next = {
      ...presets,
      departments: presets.departments.map(d => {
        if (d.id === fromDeptId) return { ...d, units: d.units.filter(u => u !== unitName) };
        if (d.id === toDeptId && !d.units.includes(unitName)) return { ...d, units: [...d.units, unitName] };
        return d;
      }),
    };
    setPresets(next);
    savePresets(next);
  };
  const reorderDepartments = (newDepartments) => {
    const next = { ...presets, departments: newDepartments };
    setPresets(next);
    savePresets(next);
  };
  const reorderUnits = (deptId, newUnits) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: newUnits } : d) };
    setPresets(next);
    savePresets(next);
  };
  const renameAssignmentPreset = (oldName, newName) => {
    // Keeps assignmentsByType in sync — a rename would otherwise
    // silently break filtering for any incident type that had the
    // old name checked, since it would no longer match anything in
    // the (now-renamed) master assignments list.
    const renamedByType = {};
    Object.keys(presets.assignmentsByType).forEach(type => {
      renamedByType[type] = presets.assignmentsByType[type].map(a => a === oldName ? newName : a);
    });
    const next = { ...presets, assignments: presets.assignments.map(a => a === oldName ? newName : a), assignmentsByType: renamedByType };
    setPresets(next);
    savePresets(next);
  };
  const deleteAssignmentPreset = (name) => {
    // Same reasoning as the rename above — removes any dangling
    // reference to the deleted assignment from every type's filter
    // list, rather than leaving a name checked that no longer exists
    // anywhere in the master list.
    const clearedByType = {};
    Object.keys(presets.assignmentsByType).forEach(type => {
      clearedByType[type] = presets.assignmentsByType[type].filter(a => a !== name);
    });
    const next = { ...presets, assignments: presets.assignments.filter(a => a !== name), assignmentsByType: clearedByType };
    setPresets(next);
    savePresets(next);
  };
  const reorderAssignmentPresets = (newAssignments) => {
    const next = { ...presets, assignments: newAssignments };
    setPresets(next);
    savePresets(next);
  };
  const saveTaskPreset = (name) => {
    const trimmed = name.trim();
    if (!trimmed || presets.tasks.includes(trimmed)) return;
    const next = { ...presets, tasks: [...presets.tasks, trimmed] };
    setPresets(next);
    savePresets(next);
  };
  const renameTaskPreset = (oldName, newName) => {
    // Keeps tasksByType in sync — same reasoning as
    // renameAssignmentPreset above.
    const renamedByType = {};
    Object.keys(presets.tasksByType).forEach(type => {
      renamedByType[type] = presets.tasksByType[type].map(t => t === oldName ? newName : t);
    });
    const next = { ...presets, tasks: presets.tasks.map(t => t === oldName ? newName : t), tasksByType: renamedByType };
    setPresets(next);
    savePresets(next);
  };
  const deleteTaskPreset = (name) => {
    // Same reasoning as deleteAssignmentPreset above.
    const clearedByType = {};
    Object.keys(presets.tasksByType).forEach(type => {
      clearedByType[type] = presets.tasksByType[type].filter(t => t !== name);
    });
    const next = { ...presets, tasks: presets.tasks.filter(t => t !== name), tasksByType: clearedByType };
    setPresets(next);
    savePresets(next);
  };
  const reorderTaskPresets = (newTasks) => {
    const next = { ...presets, tasks: newTasks };
    setPresets(next);
    savePresets(next);
  };
  const setParIntervalMinutes = (minutes) => {
    const n = Math.max(1, Number(minutes) || 15);
    const next = { ...presets, parIntervalMinutes: n };
    setPresets(next);
    savePresets(next);
  };
  // Starting a Mayday both updates the incident's own parSession
  // (subject to the normal debounced save/sync — fine, since the
  // urgent part is the separate alert below) and fires the dedicated,
  // un-debounced cross-device alert so every other device reacts
  // immediately regardless of what they're doing locally.
  const startMayday = () => {
    setIncident(prev => ({ ...prev, parSession: { type: "mayday", startedAt: nowISO(), checks: {} } }));
    setShowMaydayModal(true);
    if (incident.id) triggerMaydayAlert(incident.id).catch(() => console.error("Mayday alert failed to reach other devices — check Firestore rules include icMayday."));
  };
  const startPar = () => {
    setIncident(prev => ({ ...prev, parSession: { type: "par", startedAt: nowISO(), checks: {} } }));
    setShowParModal(true);
  };
  // Same reasoning as completeParSession below — parSession might
  // genuinely not have synced to this device yet, especially right
  // after the modal force-opens via the fast, separate Mayday
  // channel. Rather than silently doing nothing (a checkbox click
  // that appears to not register at all), this initializes a fresh
  // session using the mode the modal itself already knows, rather
  // than requiring parSession to already exist first.
  const toggleParCheck = (resourceId, mode) => {
    setIncident(prev => {
      const session = prev.parSession || { type: mode, startedAt: nowISO(), checks: {} };
      const nextChecks = { ...session.checks };
      if (nextChecks[resourceId]) delete nextChecks[resourceId];
      else nextChecks[resourceId] = nowISO();
      return { ...prev, parSession: { ...session, checks: nextChecks } };
    });
  };
  // Takes mode explicitly rather than inferring it from
  // incident.parSession.type — that field syncs through the normal
  // incident-blob channel, which can genuinely still be in flight on
  // a device other than the one that triggered the Mayday (the modal
  // itself force-opens instantly via the separate, dedicated Mayday
  // channel, well before the slower incident sync is guaranteed to
  // have delivered parSession yet). Inferring from a field that might
  // not have arrived meant clearMaydayAlert could silently never get
  // called at all — the modal would still close locally, but the
  // underlying alert record never actually changed, so the Mayday
  // would reappear the moment the incident was reloaded.
  const completeParSession = (mode) => {
    const session = incident.parSession;
    const checks = session?.checks || {};
    // Captures a full snapshot per unit — name, assignment, task, and
    // the exact moment it was checked — not just a count. Assignment
    // and task are captured here (rather than looked up later from
    // the live resource) since a unit's division or task can change
    // after the fact, and the history should reflect what was true
    // at the time of THIS event, not whatever it's since become.
    // checkedUnitNames is kept alongside for the existing summary
    // views (the list view and the PDF's heading line), which only
    // need the names, not the full detail.
    const checkedUnitDetails = resources.filter(r => checks[r.id]).map(r => ({ id: r.id, label: r.label, assignment: r.assignment, task: r.task, checkedAt: checks[r.id] }));
    const uncheckedUnitDetails = resources.filter(r => !checks[r.id]).map(r => ({ id: r.id, label: r.label, assignment: r.assignment, task: r.task }));
    const entry = {
      id: uid(), type: mode, startedAt: session?.startedAt || nowISO(), completedAt: nowISO(),
      totalUnits: resources.length, checkedUnits: checkedUnitDetails.length,
      checkedUnitDetails, uncheckedUnitDetails,
      checkedUnitNames: checkedUnitDetails.map(u => u.label),
      uncheckedUnitNames: uncheckedUnitDetails.map(u => u.label),
    };
    setIncident(prev => ({ ...prev, parSession: null, lastParAt: nowISO(), parHistory: [entry, ...prev.parHistory], parReminderActive: false }));
    setShowMaydayModal(false);
    setShowParModal(false);
    if (mode === "mayday" && incident.id) clearMaydayAlert(incident.id).catch(() => console.error("Failed to clear the Mayday alert on other devices."));
  };
  const closeParModal = () => {
    setShowMaydayModal(false);
    setShowParModal(false);
  };
  const silenceAlarm = () => setAlarmSilenced(true);
  // Recorded each time "Dismiss" is explicitly clicked on the PAR
  // reminder — an intentional, visible signal that the notification
  // was seen and not acted on, shown alongside completed checks in
  // both the history view and the PDF export rather than leaving an
  // ignored reminder invisible.
  const dismissParReminder = () => {
    // Recording the ignored-reminder entry and clearing the shared
    // active flag together, in a single update — so dismissing on any
    // one device clears the popup on every device at once, not just
    // locally.
    setIncident(prev => ({
      ...prev,
      ignoredParReminders: [{ id: uid(), at: nowISO() }, ...prev.ignoredParReminders],
      parReminderActive: false,
    }));
  };
  const addResourceKind = (name) => {
    const trimmed = name.trim();
    if (!trimmed || presets.resourceKinds.includes(trimmed)) return;
    const next = { ...presets, resourceKinds: [...presets.resourceKinds, trimmed] };
    setPresets(next);
    savePresets(next);
  };
  const renameResourceKind = (oldName, newName) => {
    const next = { ...presets, resourceKinds: presets.resourceKinds.map(k => k === oldName ? newName : k) };
    setPresets(next);
    savePresets(next);
  };
  const deleteResourceKind = (name) => {
    const next = { ...presets, resourceKinds: presets.resourceKinds.filter(k => k !== name) };
    setPresets(next);
    savePresets(next);
  };
  const reorderResourceKinds = (newKinds) => {
    const next = { ...presets, resourceKinds: newKinds };
    setPresets(next);
    savePresets(next);
  };
  const addIncidentType = (name) => {
    const trimmed = name.trim();
    if (!trimmed || presets.incidentTypes.includes(trimmed)) return;
    const next = { ...presets, incidentTypes: [...presets.incidentTypes, trimmed] };
    setPresets(next);
    savePresets(next);
  };
  const renameIncidentType = (oldName, newName) => {
    const next = { ...presets, incidentTypes: presets.incidentTypes.map(k => k === oldName ? newName : k) };
    setPresets(next);
    savePresets(next);
    // Keep any incident currently using the old name pointed at its
    // new one, the same way a resource kind rename doesn't silently
    // orphan resources already using it.
    if (incident.type === oldName) setIncident({ ...incident, type: newName });
  };
  const deleteIncidentType = (name) => {
    const next = { ...presets, incidentTypes: presets.incidentTypes.filter(k => k !== name) };
    setPresets(next);
    savePresets(next);
  };
  const reorderIncidentTypes = (newTypes) => {
    const next = { ...presets, incidentTypes: newTypes };
    setPresets(next);
    savePresets(next);
  };
  const addObjectiveForType = (type, objective) => {
    const trimmed = objective.trim();
    if (!trimmed) return;
    const current = presets.objectivesByType[type] || [];
    if (current.includes(trimmed)) return;
    const next = { ...presets, objectivesByType: { ...presets.objectivesByType, [type]: [...current, trimmed] } };
    setPresets(next);
    savePresets(next);
  };
  const renameObjectiveForType = (type, oldName, newName) => {
    const current = presets.objectivesByType[type] || [];
    const next = { ...presets, objectivesByType: { ...presets.objectivesByType, [type]: current.map(o => o === oldName ? newName : o) } };
    setPresets(next);
    savePresets(next);
  };
  const deleteObjectiveForType = (type, objective) => {
    const current = presets.objectivesByType[type] || [];
    const next = { ...presets, objectivesByType: { ...presets.objectivesByType, [type]: current.filter(o => o !== objective) } };
    setPresets(next);
    savePresets(next);
  };
  const reorderObjectivesForType = (type, newList) => {
    const next = { ...presets, objectivesByType: { ...presets.objectivesByType, [type]: newList } };
    setPresets(next);
    savePresets(next);
  };
  // Toggles ONE existing assignment's membership in a given incident
  // type's filtered list — not a freeform add/rename/delete set like
  // objectives, since this is picking a subset of the already-shared
  // assignments list (managed separately under Manage Resources),
  // not creating type-specific entries of its own.
  const toggleAssignmentForType = (type, assignmentName) => {
    const current = presets.assignmentsByType[type] || [];
    const nextList = current.includes(assignmentName) ? current.filter(a => a !== assignmentName) : [...current, assignmentName];
    const next = { ...presets, assignmentsByType: { ...presets.assignmentsByType, [type]: nextList } };
    setPresets(next);
    savePresets(next);
  };
  // Same as toggleAssignmentForType above, for the task dropdown.
  const toggleTaskForType = (type, taskName) => {
    const current = presets.tasksByType[type] || [];
    const nextList = current.includes(taskName) ? current.filter(t => t !== taskName) : [...current, taskName];
    const next = { ...presets, tasksByType: { ...presets.tasksByType, [type]: nextList } };
    setPresets(next);
    savePresets(next);
  };
  const saveAssignmentPreset = async (assignment) => {
    if (!assignment || presets.assignments.includes(assignment)) return;
    const next = { ...presets, assignments: [...presets.assignments, assignment] };
    setPresets(next);
    await savePresets(next);
  };

  function applyBlob(blob, markSynced = true) {
    // This function only ever LOADS data into state — it's never used
    // for an individual field edit — so every call means "the next
    // autosave cycle is not a real edit, skip it."
    suppressNextAutosave.current = true;
    setIncident(normalizeIncident(blob.incident));
    // Assignment/Division is now required at check-in going forward
    // (see ResourceForm), but that doesn't help anything already
    // saved from before this change existed — a resource with a
    // blank assignment would otherwise have no column left to appear
    // in at all now that there's no catch-all "Unassigned" column.
    // Defaulting it to the literal string "Unassigned" here means it
    // naturally creates that column again for as long as any such
    // resource exists (same dynamic-column logic as any real
    // division), and that column just as naturally disappears again
    // once every one of them has been given a real division.
    setResources((blob.resources || []).map(r => ({ ...r, status: normalizeResourceStatus(r.status), assignment: r.assignment || "Unassigned" })));
    setResourceColumnOrder(blob.resourceColumnOrder || []);
    setOrg(normalizeOrg(blob.org));
    setComms(normalizeComms(blob.comms));
    setSafety(blob.safety || { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] });
    // Shallow-merge onto fresh defaults rather than using the saved
    // blob as-is: an incident saved under an earlier, simpler version
    // of these forms (before they were rebuilt to match the official
    // FEMA templates field-for-field) would otherwise be missing
    // nested structures like ics208hm.entryTeam or ics209.structural,
    // and the new UI would crash calling .map() on undefined.
    setIcs208({ ...defaultIcs208(), ...(blob.ics208 || {}) });
    setIcs208hm({ ...defaultIcs208HM(), ...(blob.ics208hm || {}) });
    setIcs209({ ...defaultIcs209(), ...(blob.ics209 || {}) });
    setIcs206({ ...defaultIcs206(), ...(blob.ics206 || {}) });
    setFormsUsed(blob.formsUsed || {});
    setRehab(blob.rehab || []);
    setMapData(parseMapData(blob.mapData));
    setLogs(blob.logs || []);
    if (markSynced) lastKnownUpdatedAt.current = blob.updatedAt || null;
  }

  // autosave (debounced) whenever data changes, after initial load
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    // This render cycle is the result of a LOAD (open/new/incoming
    // real-time update), not a real edit — skip saving. Critical: without
    // this, opening an incident immediately re-saves whatever was just
    // read straight back to Firestore (since incidentLoaded is a
    // dependency below), which can silently overwrite newer data on the
    // server with an older copy if this device's read was stale.
    if (suppressNextAutosave.current) {
      suppressNextAutosave.current = false;
      return;
    }
    dirty.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const updatedAt = nowISO();
      const blob = { incident, resources, resourceColumnOrder, org, comms, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, mapData: JSON.stringify(mapData), updatedAt };
      const ok = await saveIncidentBlob(incident.id, blob);
      const meta = { id: incident.id, name: incident.name, type: incident.type, savedAt: updatedAt };
      const nextIndex = [meta, ...index.filter(i => i.id !== incident.id)];
      setIndex(nextIndex);
      await saveIndex(nextIndex);
      lastKnownUpdatedAt.current = updatedAt;
      dirty.current = false;
      setSaveState(ok ? "saved" : "idle");
    }, 900);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incident, resources, resourceColumnOrder, org, comms, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, mapData, ready, incidentLoaded]);

  // real-time: subscribe to this incident's Firestore doc so other
  // users' changes appear here immediately, no polling needed.
  useEffect(() => {
    if (!ready || !incidentLoaded || !incident.id) return;
    const unsubscribe = watchIncident(incident.id, (blob) => {
      if (dirty.current) return; // don't clobber an in-flight local edit
      if (blob && blob.updatedAt && blob.updatedAt !== lastKnownUpdatedAt.current) {
        applyBlob(blob);
        setSaveState("synced");
      }
    });
    return () => unsubscribe();
  }, [ready, incidentLoaded, incident.id]);

  // Separate, dedicated subscription for the Mayday alert — bypasses
  // the dirty-check above entirely (see triggerMaydayAlert/
  // watchMaydayAlert in store.js) so a Mayday reaches every device
  // instantly, regardless of which tab they're currently on or
  // whether they have unsaved local edits pending.
  useEffect(() => {
    if (!ready || !incidentLoaded || !incident.id) return;
    const unsubscribe = watchMaydayAlert(incident.id, (record) => {
      setMaydayAlertActive(!!(record && record.active));
    });
    return () => unsubscribe();
  }, [ready, incidentLoaded, incident.id]);

  // While a Mayday is active, force the modal open (even if the user
  // is on a different tab entirely) — separate from the alarm sound
  // itself below, since the modal should stay open even after the
  // alarm has stopped playing. Resets alarmSilenced whenever a fresh
  // Mayday starts, so a silence from a past one can't suppress a new
  // one. Just as importantly, this now also force-CLOSES the modal
  // the moment maydayAlertActive is false — without this, an initial
  // Firestore snapshot on reload that briefly reports stale cached
  // data before the corrected one arrives could leave the modal stuck
  // open with nothing left to ever close it again.
  useEffect(() => {
    if (maydayAlertActive) {
      setShowMaydayModal(true);
      setAlarmSilenced(false);
    } else {
      setShowMaydayModal(false);
    }
  }, [maydayAlertActive]);

  // The alarm sound — separate from the modal-open effect above.
  // Now a looping <audio> element (see audio.js) rather than a
  // repeating setInterval of one-shot Web Audio beeps, since Web
  // Audio is what iOS silently mutes when the ringer switch is set to
  // silent — an <audio> element is exempt from that restriction.
  // Stops (for everyone, since this reads the synced parSession) the
  // moment anyone starts actually taking PAR — checking off even one
  // unit is a strong enough signal that a response is underway that
  // continuing to blare the alarm everywhere no longer helps. Also
  // stops locally-only via alarmSilenced, which the Silence Alarm
  // button in the modal sets — that one is deliberately NOT synced,
  // so silencing it on one device never silences it anywhere else.
  const hasAnyParChecks = !!(incident.parSession && incident.parSession.type === "mayday" && Object.keys(incident.parSession.checks || {}).length > 0);
  useEffect(() => {
    if (maydayAlertActive && !hasAnyParChecks && !alarmSilenced) {
      playMaydayTone();
      return () => stopMaydayTone();
    }
  }, [maydayAlertActive, hasAnyParChecks, alarmSilenced]);

  // Periodic PAR reminder — counts from the last completed PAR
  // (lastParAt), checked once a minute against the admin-configured
  // interval. Sets the SHARED incident.parReminderActive flag rather
  // than local state, so the popup appears in sync across every
  // device watching this incident, not independently computed and
  // potentially disagreeing on each one.
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    const checkDue = () => {
      // Gated to only the incident types where PAR tracking is
      // required by policy — see requiresParTracking. If the current
      // type doesn't qualify and a reminder somehow is still active
      // (e.g. the type was just changed away from a qualifying one
      // mid-incident), clear it rather than leaving a stale reminder
      // active for a type that shouldn't have one at all.
      if (!requiresParTracking(incident.type)) {
        if (incident.parReminderActive) setIncident(prev => ({ ...prev, parReminderActive: false }));
        return;
      }
      // Same reasoning again — if the incident clock has been
      // explicitly stopped (see the Stop/Resume Clock button;
      // incident.opEnd is set while stopped), there's no active
      // operational period to be reminding about, so a currently-due
      // reminder gets cleared here too rather than continuing to nag
      // during a stopped incident.
      if (incident.opEnd) {
        if (incident.parReminderActive) setIncident(prev => ({ ...prev, parReminderActive: false }));
        return;
      }
      // Counts from the last completed PAR if one exists, otherwise
      // from the incident's own operational start time — so a long
      // incident where nobody has taken a first PAR yet still gets
      // reminded, rather than the reminder never firing at all until
      // someone happens to take one.
      const baseline = incident.lastParAt || incident.opStart;
      if (!baseline) return;
      const minutesSince = (Date.now() - new Date(baseline).getTime()) / 60000;
      const isDue = minutesSince >= (presets.parIntervalMinutes || 15);
      if (isDue && !incident.parReminderActive) {
        setIncident(prev => ({ ...prev, parReminderActive: true }));
      }
    };
    checkDue();
    const interval = setInterval(checkDue, 60 * 1000);
    return () => clearInterval(interval);
  }, [ready, incidentLoaded, incident.type, incident.lastParAt, incident.opStart, incident.opEnd, incident.parReminderActive, presets.parIntervalMinutes]);

  // Auto-syncs the Org Chart from the Resource Board's own current
  // assignments, rather than requiring every division, its chief,
  // and every unit under it to be typed in by hand. Any unit whose
  // name starts with "C" (Command Vehicle, per the same
  // designation-letter convention used for auto-detecting resource
  // type at check-in) is treated as that division's chief and fills
  // the division box itself; every OTHER unit in that division gets
  // its own sub-box underneath, titled with the unit's resource type
  // and named after the unit itself.
  //
  // "Incident Command" and "Operations" are themselves
  // assignments/divisions on the Resource Board (per the user's own
  // setup) rather than fixed template boxes, so they're synced the
  // exact same way as any other division — just deliberately nested
  // in a fixed hierarchy: Incident Command at the very top (if that
  // assignment exists), wrapping Operations (if that assignment
  // exists), wrapping every regular division underneath. If only one
  // of Incident Command/Operations exists, whichever does becomes the
  // top-level wrapper instead. If neither exists, nothing here is
  // built or torn down — org.incidentCommand is left exactly as it
  // was, same as the "never delete" principle for a regular division.
  //
  // Uses the functional setOrg(prev => ...) form specifically so this
  // effect never needs org itself as a dependency — it always reads
  // the true latest org state at the moment it runs, without needing
  // to re-run every time org changes for an unrelated reason (editing
  // a Command Staff name, say).
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    setOrg(prev => {
      const allActive = deriveAssignmentColumns(resources, presets.assignments, resourceColumnOrder).filter(col => !STATUS_FLOW.includes(col));
      const icName = allActive.find(isIncidentCommandName) || null;
      const opsName = allActive.find(n => n !== icName && isOperationsName(n)) || null;
      const regularNames = allActive.filter(n => n !== icName && n !== opsName);

      if (!icName && !opsName) return prev;

      let changed = false;
      const priorTop = prev.incidentCommand;
      let priorOpsNode = null;
      if (priorTop) {
        priorOpsNode = isOperationsName(priorTop.title) ? priorTop : (priorTop.children || []).find(c => isOperationsName(c.title) && !c.sourceResourceId) || null;
      }
      const priorRegularNodes = priorOpsNode ? (priorOpsNode.children || []).filter(c => !c.sourceResourceId) : [];

      const { nodes: nextRegularNodes, changed: regularChanged } = syncDivisionList(regularNames, priorRegularNodes, resources);
      if (regularChanged) changed = true;

      let nextTop;
      if (opsName) {
        const { node: opsChiefNode, nonChiefUnits: opsNonChiefUnits, changed: opsChiefChanged } = syncDivisionChiefName(opsName, priorOpsNode, resources);
        const { children: opsSubBoxes, changed: opsSubChanged } = syncSubBoxes((opsChiefNode.children || []).filter(c => c.sourceResourceId), opsNonChiefUnits);
        if (opsChiefChanged || opsSubChanged) changed = true;
        const opsNode = { ...opsChiefNode, children: [...opsSubBoxes, ...nextRegularNodes] };

        if (icName) {
          const priorIcForChief = (priorTop && isIncidentCommandName(priorTop.title)) ? priorTop : null;
          const { node: icChiefNode, nonChiefUnits: icNonChiefUnits, changed: icChiefChanged } = syncDivisionChiefName(icName, priorIcForChief, resources);
          const { children: icSubBoxes, changed: icSubChanged } = syncSubBoxes((icChiefNode.children || []).filter(c => c.sourceResourceId), icNonChiefUnits);
          if (icChiefChanged || icSubChanged) changed = true;
          nextTop = { ...icChiefNode, children: [...icSubBoxes, opsNode] };
        } else {
          // No Incident Command division exists — Operations itself
          // becomes the top-level node.
          nextTop = opsNode;
        }
      } else {
        // No Operations division exists — Incident Command directly
        // wraps the regular divisions, with no Operations layer
        // between them.
        const priorIcForChief = (priorTop && isIncidentCommandName(priorTop.title)) ? priorTop : null;
        const { node: icChiefNode, nonChiefUnits: icNonChiefUnits, changed: icChiefChanged } = syncDivisionChiefName(icName, priorIcForChief, resources);
        const { children: icSubBoxes, changed: icSubChanged } = syncSubBoxes((icChiefNode.children || []).filter(c => c.sourceResourceId), icNonChiefUnits);
        if (icChiefChanged || icSubChanged) changed = true;
        nextTop = { ...icChiefNode, children: [...icSubBoxes, ...nextRegularNodes] };
      }

      if (!changed) return prev;
      return { ...prev, incidentCommand: nextTop };
    });
  }, [resources, presets.assignments, resourceColumnOrder, ready, incidentLoaded]);

  const startNew = () => {
    applyBlob({ incident: blankIncident(), resources: [], resourceColumnOrder: [], org: blankOrg(), comms: defaultComms(), safety: { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] }, ics208: defaultIcs208(), ics208hm: defaultIcs208HM(), ics209: defaultIcs209(), ics206: defaultIcs206(), rehab: [], logs: [], formsUsed: {}, mapData: defaultMapData() });
    setAttachments([]);
    setIncidentLoaded(true);
    setShowLib(false);
  };
  const openIncident = async (id) => {
    // Deliberately bypasses Firestore's local cache — see the comment on
    // loadIncidentBlobFresh for why this matters (a stale cached read
    // here is exactly what caused entered data to get overwritten).
    const blob = await loadIncidentBlobFresh(id);
    if (blob) applyBlob(blob);
    const atts = await loadAttachments(id);
    setAttachments(atts);
    setIncidentLoaded(true);
    setShowLib(false);
  };
  const uploadAttachment = async (file) => {
    const dataBase64 = await fileToBase64(file);
    const attId = uid();
    const data = { name: file.name, type: file.type, size: file.size, dataBase64, uploadedAt: nowISO() };
    await saveAttachment(incident.id, attId, data);
    setAttachments(prev => [...prev, { id: attId, ...data }]);
  };
  const removeAttachment = async (attId) => {
    await deleteAttachment(incident.id, attId);
    setAttachments(prev => prev.filter(a => a.id !== attId));
  };
  const deleteIncident = async (id) => {
    const nextIndex = index.filter(i => i.id !== id);
    setIndex(nextIndex);
    await saveIndex(nextIndex);
    await deleteAllAttachments(id);
    await deleteIncidentBlob(id);
  };

  const archiveIncident = async (id) => {
    const nextIndex = index.map(i => i.id === id ? { ...i, archived: true, archivedAt: nowISO() } : i);
    setIndex(nextIndex);
    await saveIndex(nextIndex);
    // If the incident being archived is the one currently open, kick
    // back to the library so nobody keeps editing a closed-out incident.
    if (id === incident.id) {
      setIncidentLoaded(false);
      setShowLib(false);
    }
  };
  const restoreIncident = async (id) => {
    const nextIndex = index.map(i => i.id === id ? { ...i, archived: false } : i);
    setIndex(nextIndex);
    await saveIndex(nextIndex);
  };
  const exportArchivedIncident = async (id) => {
    const blob = await loadIncidentBlobFresh(id);
    if (blob) {
      const atts = await loadAttachments(id);
      await downloadPacketPdf({ ...blob, attachments: atts, assignmentPresets: presets.assignments });
    }
  };

  const typeBadgeColor = incidentTypeColor(incident.type, presets.incidentTypes);
  // When the incident clock is stopped, resource/rehab timers freeze at
  // the same moment instead of continuing to count against real time.
  const effectiveNow = incident.opEnd ? new Date(incident.opEnd).getTime() : now;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {incidentLoaded && (
        <div className="no-print">
        {/* HEADER */}
        <div style={{ borderBottom: `1px solid ${COLORS.line}`, background: COLORS.panel, position: "sticky", top: 0, zIndex: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <img src={KFD_PATCH_DATA_URI} alt="KFD Patch" style={{ width: 34, height: 44, objectFit: "contain", flexShrink: 0 }} />
              <div>
                <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 19, letterSpacing: "0.03em", lineHeight: 1 }}>COMMAND BOARD</div>
                <div style={{ fontSize: 10.5, color: COLORS.muted, letterSpacing: "0.08em", textTransform: "uppercase" }}>Incident Management System</div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginLeft: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: typeBadgeColor, display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{incident.name || "Untitled Incident"}</span>
                <span style={{ fontSize: 11, color: COLORS.muted }}>({incident.type})</span>
              </div>
              {/* Kept directly in the header rather than the drawer
                  below (unlike its own Stop/Resume control, which did
                  move there) — how long the incident's been running
                  is glanceable, always-relevant status, not an
                  occasional action someone navigates to check. */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: COLORS.amber }}>
                <Clock size={14} />
                {fmtDuration((incident.pausedElapsedMs || 0) + (incident.opEnd ? 0 : Math.max(0, now - new Date(incident.opStart).getTime())))}
                {incident.opEnd && <span style={{ color: COLORS.faint, fontSize: 10, marginLeft: 2 }}>STOPPED</span>}
              </div>
              {!online && (
                <span style={{ fontSize: 11, color: COLORS.amber, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: COLORS.amber, display: "inline-block" }} />
                  offline — changes will sync when reconnected
                </span>
              )}
              <span style={{ fontSize: 11, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 5, visibility: saveState === "idle" ? "hidden" : "visible" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: saveState === "saving" ? COLORS.amber : COLORS.teal, transition: "background-color 0.15s" }} />
                Synced
              </span>
              {/* Everything actually actionable (the clock's own
                  control, navigation, export, locking, theme, admin)
                  lives in the slide-out drawer below instead of
                  cluttering this row directly — only always-relevant,
                  glanceable status (incident name/type, offline state,
                  sync state) stays visible here at all times. */}
              <button onClick={() => setShowHeaderMenu(true)} title="Menu"
                style={{ background: "none", border: `1px solid ${COLORS.line}`, borderRadius: 5, color: COLORS.text, cursor: "pointer", padding: "7px 9px", display: "flex", alignItems: "center" }}>
                <Menu size={18} />
              </button>
            </div>
          </div>

          {showHeaderMenu && (
            <div onClick={() => setShowHeaderMenu(false)}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100 }}>
              <style>{`@keyframes cbHeaderMenuSlideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>
              <div onClick={e => e.stopPropagation()}
                style={{
                  position: "absolute", top: 0, right: 0, bottom: 0, width: 280, maxWidth: "85vw",
                  background: COLORS.panel, borderLeft: `1px solid ${COLORS.line}`, boxShadow: "-4px 0 16px rgba(0,0,0,0.4)",
                  padding: 16, overflowY: "auto", animation: "cbHeaderMenuSlideIn 0.2s ease-out",
                  display: "flex", flexDirection: "column", gap: 10,
                }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Menu</span>
                  <button onClick={() => setShowHeaderMenu(false)} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>
                </div>

                <Btn kind="ghost" icon={Clock}
                  onClick={() => {
                    setShowHeaderMenu(false);
                    if (incident.opEnd) {
                      // Resuming: start a fresh running segment. The time
                      // already accumulated (pausedElapsedMs) is preserved
                      // as-is — only opStart resets, as the reference point
                      // for counting the NEW segment, not the total.
                      setIncident({ ...incident, opStart: nowISO(), opEnd: null });
                    } else {
                      // Stopping: fold this segment's elapsed time into the
                      // running total before freezing the display, instead
                      // of discarding it (which is what the old opStart-only
                      // reset on resume used to do).
                      const segmentMs = Math.max(0, Date.now() - new Date(incident.opStart).getTime());
                      setIncident({ ...incident, pausedElapsedMs: (incident.pausedElapsedMs || 0) + segmentMs, opEnd: nowISO() });
                    }
                  }}
                  style={{ width: "100%", justifyContent: "center" }}>
                  {incident.opEnd ? "Resume Clock" : "Stop Clock"}
                </Btn>
                <Btn kind="ghost" icon={FolderOpen} onClick={() => { setShowHeaderMenu(false); setShowLib(true); }} style={{ width: "100%", justifyContent: "center" }}>Incidents</Btn>
                <Btn kind="ghost" icon={Printer} onClick={() => { setShowHeaderMenu(false); downloadPacketPdf({ incident, resources, comms, org, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, mapData, attachments, assignmentPresets: presets.assignments, resourceColumnOrder }); }} style={{ width: "100%", justifyContent: "center" }}>Print / Export</Btn>
                <Btn kind="ghost" icon={Lock} onClick={() => { setShowHeaderMenu(false); onLock(); }} style={{ width: "100%", justifyContent: "center" }}>Lock</Btn>
                <Btn kind="ghost" icon={theme === "dark" ? Sun : Moon} onClick={() => { setShowHeaderMenu(false); toggleTheme(); }} title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} style={{ width: "100%", justifyContent: "center" }}>{theme === "dark" ? "Light" : "Dark"}</Btn>
                <Btn kind="ghost" icon={Settings} onClick={() => { setShowHeaderMenu(false); setShowAdminAuth(true); }} style={{ width: "100%", justifyContent: "center" }}>Admin</Btn>
              </div>
            </div>
          )}

          {/* TAB NAV */}
          <div style={{ display: "flex", gap: 2, padding: "0 16px", overflowX: "auto" }}>
            {TABS.map(t => (
              <button key={t.k} onClick={() => setTab(t.k)} style={{
                display: "flex", alignItems: "center", gap: 7, padding: "10px 14px",
                background: "transparent", border: "none", cursor: "pointer",
                color: tab === t.k ? COLORS.text : COLORS.muted,
                borderBottom: tab === t.k ? `2px solid ${COLORS.red}` : `2px solid transparent`,
                fontSize: 13, fontWeight: 600, fontFamily: "'IBM Plex Sans', sans-serif", whiteSpace: "nowrap",
              }}>
                <t.icon size={14} /> {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <div style={{ maxWidth: 1600, margin: "0 auto", padding: "20px 16px 60px" }}>
          {!ready ? (
            <div style={{ color: COLORS.muted, padding: 40, textAlign: "center" }}>Loading…</div>
          ) : (
            <>
              {tab === "201" && <Tab201 incident={incident} setIncident={setIncident} resources={resources} incidentTypePresets={presets.incidentTypes} objectivesByType={presets.objectivesByType} onAddObjective={addObjectiveForType} assignmentPresets={presets.assignments} resourceColumnOrder={resourceColumnOrder} />}
              {tab === "resources" && <TabResources resources={resources} setResources={setResources} now={effectiveNow}
                incident={incident} setIncident={setIncident} parIntervalMinutes={presets.parIntervalMinutes}
                departments={presets.departments} onAddDepartment={saveDepartment} onAddUnitUnderDepartment={saveUnitUnderDepartment}
                onRenameDepartment={renameDepartment} onDeleteDepartment={deleteDepartment} onReorderDepartment={reorderDepartments}
                onRenameUnit={renameUnit} onDeleteUnit={deleteUnit} onMoveUnit={moveUnit} onReorderUnit={reorderUnits}
                assignmentPresets={presets.assignments} assignmentsByType={presets.assignmentsByType} onSaveAssignmentPreset={saveAssignmentPreset}
                onRenameAssignment={renameAssignmentPreset} onDeleteAssignment={deleteAssignmentPreset} onReorderAssignment={reorderAssignmentPresets}
                resourceKindPresets={presets.resourceKinds} onAddResourceKind={addResourceKind} onRenameResourceKind={renameResourceKind}
                onDeleteResourceKind={deleteResourceKind} onReorderResourceKind={reorderResourceKinds}
                taskPresets={presets.tasks} tasksByType={presets.tasksByType} onSaveTaskPreset={saveTaskPreset}
                resourceColumnOrder={resourceColumnOrder} setResourceColumnOrder={setResourceColumnOrder}
                onTriggerMayday={() => setShowMaydayConfirm(true)} onStartPar={startPar}
              />}
              {tab === "mapping" && <TabMapping mapData={mapData} setMapData={setMapData} resources={resources} assignmentPresets={presets.assignments} resourceColumnOrder={resourceColumnOrder} />}
              {tab === "weather" && <TabWeather />}
              {tab === "org" && <TabOrg org={org} setOrg={setOrg} resources={resources} assignmentPresets={presets.assignments} resourceColumnOrder={resourceColumnOrder} departments={presets.departments} />}
              {tab === "rehab" && <TabRehab rehab={rehab} setRehab={setRehab} resources={resources} now={effectiveNow} />}
              {tab === "icsforms" && (
                <TabICSForms
                  comms={comms} setComms={setComms}
                  safety={safety} setSafety={setSafety}
                  org={org} incident={incident} setIncident={setIncident}
                  ics208={ics208} setIcs208={setIcs208}
                  ics208hm={ics208hm} setIcs208hm={setIcs208hm}
                  ics209={ics209} setIcs209={setIcs209}
                  ics206={ics206} setIcs206={setIcs206}
                  logs={logs} setLogs={setLogs}
                  mapData={mapData}
                  objectivesByType={presets.objectivesByType} onAddObjective={addObjectiveForType} incidentTypePresets={presets.incidentTypes}
                  formsUsed={formsUsed} toggleFormUsed={toggleFormUsed}
                />
              )}
              {tab === "attachments" && <TabAttachments attachments={attachments} onUpload={uploadAttachment} onDelete={removeAttachment} />}
            </>
          )}
        </div>
        </div>
      )}

      {!ready && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.muted, fontFamily: "'IBM Plex Sans', sans-serif" }}>
          Loading…
        </div>
      )}

      {incidentLoaded && <PrintView incident={incident} resources={resources} comms={comms} org={org} safety={safety} logs={logs} />}

      {ready && (showLib || !incidentLoaded) && (
        <LibraryModal index={index} onClose={() => setShowLib(false)} onLoad={openIncident} onNew={startNew} onDelete={deleteIncident}
          onArchive={archiveIncident} onOpenArchive={() => setShowArchive(true)} onOpenAdmin={() => setShowAdminAuth(true)} mandatory={!incidentLoaded} />
      )}

      {showAdminAuth && (
        <PasswordConfirmModal
          title="Admin Password Required"
          message="Enter the admin password to access admin settings."
          onConfirm={() => { setShowAdminAuth(false); setShowAdminMenu(true); }}
          onCancel={() => setShowAdminAuth(false)}
        />
      )}
      {showMaydayConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 96, padding: 16 }}>
          <div style={{ background: COLORS.panel, border: `2px solid ${COLORS.red}`, borderRadius: 8, width: 380, maxWidth: "100%", padding: 22, textAlign: "center" }}>
            <div style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 17, color: COLORS.red, fontWeight: 700, marginBottom: 10 }}>
              Declare a MAYDAY?
            </div>
            <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 18, lineHeight: 1.5 }}>
              This will sound an alarm and open a PAR check on every device currently viewing this incident. Only confirm if this is real.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn kind="danger" onClick={() => { setShowMaydayConfirm(false); startMayday(); }} style={{ flex: 1, justifyContent: "center" }}>Confirm Mayday</Btn>
              <Btn kind="ghost" onClick={() => setShowMaydayConfirm(false)}>Cancel</Btn>
            </div>
          </div>
        </div>
      )}
      {showMaydayModal && (
        <ParCheckModal
          mode="mayday"
          resources={resources}
          parSession={incident.parSession}
          onCheck={(id) => toggleParCheck(id, "mayday")}
          onComplete={() => completeParSession("mayday")}
          onClose={closeParModal}
          isAlarmPlaying={maydayAlertActive && !hasAnyParChecks && !alarmSilenced}
          onSilenceAlarm={silenceAlarm}
        />
      )}
      {showParModal && (
        <ParCheckModal
          mode="par"
          resources={resources}
          parSession={incident.parSession}
          onCheck={(id) => toggleParCheck(id, "par")}
          onComplete={() => completeParSession("par")}
          onClose={closeParModal}
        />
      )}
      {incident.parReminderActive && !showMaydayModal && !showParModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 92, padding: 16 }}>
          <div style={{ background: COLORS.panel, border: `2px solid ${COLORS.amber}`, borderRadius: 8, width: 360, maxWidth: "100%", padding: 20, textAlign: "center" }}>
            <div style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 16, marginBottom: 8 }}>PAR Reminder</div>
            <div style={{ fontSize: 13, color: COLORS.muted, marginBottom: 16, lineHeight: 1.5 }}>
              It's been {presets.parIntervalMinutes || 15}+ minutes since the last accountability check. Take a PAR now?
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn kind="solid" onClick={startPar} style={{ flex: 1, justifyContent: "center" }}>Take PAR Now</Btn>
              <Btn kind="ghost" onClick={dismissParReminder}>Dismiss</Btn>
            </div>
          </div>
        </div>
      )}
      {showAdminMenu && (
        <AdminModal
          onClose={() => setShowAdminMenu(false)}
          onChangePin={() => { setShowAdminMenu(false); setShowChangePin(true); }}
          onChangeAdminPassword={() => { setShowAdminMenu(false); setShowChangeArchivePassword(true); }}
          onManageIncidentTypes={() => { setShowAdminMenu(false); setShowManageIncidentTypes(true); }}
          onManageResources={() => { setShowAdminMenu(false); setManageResourcesFromAdmin(true); setShowManageResources(true); }}
          onManageObjectives={() => { setShowAdminMenu(false); setShowManageObjectives(true); }}
          onManageAssignmentsByType={() => { setShowAdminMenu(false); setShowManageAssignmentsByType(true); }}
          onManageTasksByType={() => { setShowAdminMenu(false); setShowManageTasksByType(true); }}
          onManageParSettings={() => { setShowAdminMenu(false); setShowParSettings(true); }}
        />
      )}
      {showParSettings && (
        <ParSettingsModal
          onClose={() => setShowParSettings(false)}
          onBack={() => { setShowParSettings(false); setShowAdminMenu(true); }}
          parIntervalMinutes={presets.parIntervalMinutes}
          onSave={setParIntervalMinutes}
        />
      )}
      {showChangePin && <ChangePinModal onClose={() => setShowChangePin(false)} onBack={() => { setShowChangePin(false); setShowAdminMenu(true); }} />}
      {showManageIncidentTypes && (
        <ManageIncidentTypesModal
          onClose={() => setShowManageIncidentTypes(false)}
          onBack={() => { setShowManageIncidentTypes(false); setShowAdminMenu(true); }}
          incidentTypes={presets.incidentTypes}
          onAdd={addIncidentType}
          onRename={renameIncidentType}
          onDelete={deleteIncidentType}
          onReorder={reorderIncidentTypes}
        />
      )}
      {showManageObjectives && (
        <ManageObjectivesModal
          onClose={() => setShowManageObjectives(false)}
          onBack={() => { setShowManageObjectives(false); setShowAdminMenu(true); }}
          incidentTypes={presets.incidentTypes}
          objectivesByType={presets.objectivesByType}
          onAdd={addObjectiveForType}
          onRename={renameObjectiveForType}
          onDelete={deleteObjectiveForType}
          onReorder={reorderObjectivesForType}
        />
      )}
      {showManageAssignmentsByType && (
        <ManageAssignmentsByTypeModal
          onClose={() => setShowManageAssignmentsByType(false)}
          onBack={() => { setShowManageAssignmentsByType(false); setShowAdminMenu(true); }}
          incidentTypes={presets.incidentTypes}
          assignmentPresets={presets.assignments}
          assignmentsByType={presets.assignmentsByType}
          onToggle={toggleAssignmentForType}
        />
      )}
      {showManageTasksByType && (
        <ManageTasksByTypeModal
          onClose={() => setShowManageTasksByType(false)}
          onBack={() => { setShowManageTasksByType(false); setShowAdminMenu(true); }}
          incidentTypes={presets.incidentTypes}
          taskPresets={presets.tasks}
          tasksByType={presets.tasksByType}
          onToggle={toggleTaskForType}
        />
      )}
      {showManageResourcesAuth && (
        <PasswordConfirmModal
          title="Admin Password Required"
          message="Enter the admin password to manage departments, units, assignments, and resource types."
          onConfirm={() => { setShowManageResourcesAuth(false); setManageResourcesFromAdmin(false); setShowManageResources(true); }}
          onCancel={() => setShowManageResourcesAuth(false)}
        />
      )}
      {showManageResources && (
        <ManageResourcesModal
          departments={presets.departments} onRenameDept={renameDepartment} onDeleteDept={deleteDepartment} onReorderDept={reorderDepartments}
          onRenameUnit={renameUnit} onDeleteUnit={deleteUnit} onMoveUnit={moveUnit} onReorderUnit={reorderUnits}
          onAddDepartment={saveDepartment} onAddUnitUnderDepartment={saveUnitUnderDepartment}
          assignments={presets.assignments} onRenameAssignment={renameAssignmentPreset} onDeleteAssignment={deleteAssignmentPreset}
          onReorderAssignment={reorderAssignmentPresets} onAddAssignment={saveAssignmentPreset}
          resourceKinds={presets.resourceKinds} onRenameKind={renameResourceKind} onDeleteKind={deleteResourceKind}
          onReorderKind={reorderResourceKinds} onAddKind={addResourceKind}
          tasks={presets.tasks} onRenameTask={renameTaskPreset} onDeleteTask={deleteTaskPreset}
          onReorderTask={reorderTaskPresets} onAddTask={saveTaskPreset}
          onClose={() => setShowManageResources(false)}
          onBack={manageResourcesFromAdmin ? () => { setShowManageResources(false); setShowAdminMenu(true); } : undefined}
        />
      )}

      {showArchive && (
        <ArchiveModal
          index={index}
          onClose={() => setShowArchive(false)}
          onExport={exportArchivedIncident}
          onRestore={restoreIncident}
        />
      )}

      {showChangeArchivePassword && <ChangeArchivePasswordModal onClose={() => setShowChangeArchivePassword(false)} onBack={() => { setShowChangeArchivePassword(false); setShowAdminMenu(true); }} />}
    </div>
  );
}
