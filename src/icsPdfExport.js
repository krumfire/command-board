import { PDFDocument, StandardFonts } from "pdf-lib";

// Splits an HTML datetime-local input's value ("YYYY-MM-DDTHH:MM") into
// the separate date and time strings the ICS PDF templates' own Date/
// Time field pairs expect — MM/DD/YYYY (the standard US date format
// these forms use) and HH:MM 24-hour (ICS convention, and already the
// native format datetime-local stores, so no AM/PM conversion needed).
export function splitDateTimeLocal(value) {
  if (!value) return { date: "", time: "" };
  const [datePart, timePart] = value.split("T");
  if (!datePart) return { date: "", time: "" };
  const [y, m, d] = datePart.split("-");
  return { date: `${m}/${d}/${y}`, time: timePart || "" };
}

// Keeps an incident's own name (freely typed by the user) usable as
// part of a downloaded filename — strips characters most filesystems
// reject and collapses whitespace, rather than letting a name with a
// slash or colon in it silently produce a broken or truncated file.
function sanitizeForFilename(s) {
  return String(s || "Untitled").replace(/[\\/:*?"<>|]/g, "").trim().replace(/\s+/g, "_") || "Untitled";
}

export function icsFilename(formLabel, incident) {
  const d = new Date();
  const date = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
  return `${formLabel}_${sanitizeForFilename(incident.name)}_${date}.pdf`;
}

export function mapIcs208Fields(incident, ics208) {
  const from = splitDateTimeLocal(ics208.opFrom);
  const to = splitDateTimeLocal(ics208.opTo);
  const prepared = splitDateTimeLocal(ics208.dateTime);
  return {
    textFields: {
      "Date From": from.date, "Time From": from.time,
      "Date To": to.date, "Time To": to.time,
      "1 Incident Name_12": incident.name,
      "3 Safety MessageExpanded Safety Message Safety Plan Site Safety Plan": ics208.message,
      "4 Site Safety Plan Required Yes No Approved Site Safety Plans Located At": ics208.siteSafetyPlanLocation,
      "5 Prepared by Name": ics208.preparedBy,
      "PositionTitle_10": ics208.position,
      "DateTime_12": prepared.date && prepared.time ? `${prepared.date} ${prepared.time}` : "",
    },
    checkboxFields: {
      "Site Safety Plan Required? Yes": ics208.siteSafetyPlanRequired === "Yes",
      "Site Safety Plan Required? No": ics208.siteSafetyPlanRequired === "No",
    },
    // "Signature_14" is a PDF signature field (meant for cryptographic
    // signing), not a plain text field — the typed name is drawn onto
    // the page directly instead, since it can't be set through the
    // text-field API at all.
    overlayTexts: [
      { page: 1, rect: [465.12, 80.76, 570.48, 92.4], text: ics208.signature, fontSize: 9 },
    ],
  };
}

// Fills one of the official ICS PDF templates (public/ics-pdfs/*.pdf)
// with this app's own data and triggers a browser download — used by
// each ICS form's "Export" button. Templates are fetched on demand
// rather than bundled into the JS build, since some run to several
// hundred KB and most users will only ever export a handful of forms
// per incident, not all of them every load.
//
// - templateFile: just the filename under public/ics-pdfs/ (e.g.
//   "ics-208.pdf") — resolved against import.meta.env.BASE_URL here
//   rather than callers building the path themselves, since this app
//   deploys under a subpath (GitHub Pages) as well as file:// (the
//   Electron build) and a plain "/ics-pdfs/..." absolute path would
//   only resolve correctly for the first of those. Vite rewrites
//   static HTML asset references for this automatically at build
//   time, but a path passed to a runtime fetch() call like this one
//   is a plain string it has no way to rewrite the same way.
// - textFields: { pdfFieldName: value } — filled via the form's own
//   text-field API. A falsy value is skipped (left as whatever the
//   blank template already shows) rather than writing an empty
//   string over it.
// - checkboxFields: { pdfFieldName: boolean }
// - overlayTexts: [{ page, rect: [x0,y0,x1,y1], text, fontSize? }] —
//   for the handful of fields (typed "signature" lines) that are a
//   PDF signature field rather than a plain text field — those can't
//   be set through the text-field API at all, so the value is drawn
//   directly onto the page at the field's own known position instead.
//
// Every individual field fill is wrapped so one bad field name (a
// typo, or a template revision that renamed something) can't abort
// the whole export — it's skipped and logged instead, and everything
// else still gets filled in.
export async function fillAndDownloadIcsPdf({ templateFile, filename, textFields, checkboxFields, overlayTexts, fontSizes, multilineFields }) {
  const templatePath = `${import.meta.env.BASE_URL}ics-pdfs/${templateFile}`;
  const res = await fetch(templatePath);
  if (!res.ok) throw new Error(`Couldn't load the PDF template (${res.status}).`);
  const bytes = await res.arrayBuffer();
  const pdfDoc = await PDFDocument.load(bytes);
  const form = pdfDoc.getForm();

  for (const [name, value] of Object.entries(textFields || {})) {
    if (!value) continue;
    try {
      const field = form.getTextField(name);
      // An explicit override for the handful of fields whose default
      // (often auto) font size doesn't leave room for a value this
      // form actually produces — e.g. a combined "from ... to ..."
      // operational-period string in a field sized for a shorter one.
      if (fontSizes?.[name]) field.setFontSize(fontSizes[name]);
      // Not every field the template ships is actually flagged
      // multiline even when its own height suggests room for more
      // than one line — enabled here per-field (paired with a "\n" in
      // that field's value) rather than assuming the template already
      // supports wrapping.
      if (multilineFields?.includes(name)) field.enableMultiline();
      field.setText(String(value));
    } catch (err) {
      console.warn(`ICS PDF export: couldn't fill text field "${name}"`, err);
    }
  }
  for (const [name, checked] of Object.entries(checkboxFields || {})) {
    try {
      const field = form.getCheckBox(name);
      if (checked) field.check(); else field.uncheck();
    } catch (err) {
      console.warn(`ICS PDF export: couldn't set checkbox "${name}"`, err);
    }
  }
  const overlayFont = overlayTexts?.length ? await pdfDoc.embedFont(StandardFonts.Helvetica) : null;
  for (const { page, rect, text, fontSize } of overlayTexts || []) {
    if (!text) continue;
    try {
      const pdfPage = pdfDoc.getPage(page - 1);
      const [x0, y0, x1, y1] = rect;
      const availableWidth = x1 - x0 - 4; // small margin on each side
      let size = fontSize || 9;
      let renderText = String(text);
      // Overlay text isn't constrained by a real form field the way
      // filled fields are — drawText has no notion of a bounding box
      // and will happily run text straight through a neighboring
      // column (this is exactly what happened with a longer Incident
      // Name overlapping the Incident Number field next to it before
      // this was added). Shrinks to fit first; if even the smallest
      // still-legible size doesn't fit, truncates with an ellipsis as
      // a last resort rather than letting it run into whatever's next.
      const MIN_SIZE = 5;
      while (size > MIN_SIZE && overlayFont.widthOfTextAtSize(renderText, size) > availableWidth) size -= 0.5;
      if (overlayFont.widthOfTextAtSize(renderText, size) > availableWidth) {
        while (renderText.length > 1 && overlayFont.widthOfTextAtSize(renderText + "…", size) > availableWidth) renderText = renderText.slice(0, -1);
        renderText += "…";
      }
      pdfPage.drawText(renderText, { x: x0 + 2, y: y0 + (y1 - y0 - size) / 2 + 2, size });
    } catch (err) {
      console.warn(`ICS PDF export: couldn't draw overlay text on page ${page}`, err);
    }
  }

  // Regenerates each filled field's appearance stream so the values
  // actually render in every PDF viewer, not just ones that
  // regenerate appearances themselves on open.
  form.updateFieldAppearances();

  const outBytes = await pdfDoc.save();
  const blob = new Blob([outBytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function mapIcs205Fields(incident, comms) {
  const prepared = splitDateTimeLocal(comms.dateTimePrepared);
  const from = splitDateTimeLocal(comms.opFrom);
  const to = splitDateTimeLocal(comms.opTo);
  const signed = splitDateTimeLocal(comms.dateTime);
  const MAX_ROWS = 8; // the template's one page has exactly 8 channel rows
  const textFields = {
    "Date From": from.date, "Time From": from.time,
    "Date To": to.date, "Time To": to.time,
    "1 Incident Name_8": incident.name,
    "2 Date/Time Prepared": prepared.date && prepared.time ? `${prepared.date} ${prepared.time}` : "",
    "5 Special Instructions": comms.specialInstructions,
    "6 Prepared by Communications Unit Leader Name": comms.preparedBy,
    "DateTime_8": signed.date && signed.time ? `${signed.date} ${signed.time}` : "",
  };
  comms.rows.slice(0, MAX_ROWS).forEach((row, i) => {
    const n = i + 1;
    textFields[`Zone GrpRow${n}`] = row.zoneGroup;
    textFields[`Ch Row${n}`] = row.chNum;
    textFields[`FunctionRow${n}`] = row.func;
    textFields[`Channel NameTrunked Radio System TalkgroupRow${n}`] = row.channelName;
    textFields[`AssignmentRow${n}`] = row.assignment;
    textFields[`RX Freq N or WRow${n}`] = row.rxFreq;
    textFields[`RX ToneNACRow${n}`] = row.rxTone;
    textFields[`TX Freq N or WRow${n}`] = row.txFreq;
    textFields[`TX ToneNACRow${n}`] = row.txTone;
    textFields[`Mode A D or MRow${n}`] = row.mode;
    textFields[`RemarksRow${n}`] = row.remarks;
  });
  return {
    textFields,
    // "Signature_9" is a PDF signature field, drawn as overlay text instead — see mapIcs208Fields above.
    overlayTexts: [
      { page: 1, rect: [550.56, 74.6376, 750.12, 88.56], text: comms.signature, fontSize: 9 },
    ],
    truncatedRowCount: Math.max(0, comms.rows.length - MAX_ROWS),
  };
}

export function mapIcs206Fields(incident, ics206) {
  const from = splitDateTimeLocal(ics206.opFrom);
  const to = splitDateTimeLocal(ics206.opTo);
  const signed = splitDateTimeLocal(ics206.dateTime);
  const textFields = {
    "Date From": from.date, "Time From": from.time,
    "Date To": to.date, "Time To": to.time,
    "1 Incident Name_10": incident.name,
    "Special Medical Emergency Procedures": ics206.procedures,
    "7 Prepared by Medical Unit Leader Name": ics206.preparedBy,
    "8 Approved by Safety Officer Name": ics206.approvedBy,
    "DateTime_10": signed.date && signed.time ? `${signed.date} ${signed.time}` : "",
  };
  const checkboxFields = {
    "Check Box if aviation assests are utilized for rescue": !!ics206.aviationAssets,
  };
  const AID_MAX = 6;
  ics206.aidStations.slice(0, AID_MAX).forEach((r, i) => {
    const n = i + 1;
    textFields[`NameRow${n}`] = r.name;
    textFields[`LocationRow${n}`] = r.location;
    textFields[`Contact NumbersFrequencyRow${n}`] = r.contact;
    checkboxFields[`Paramedics on Site - Yes, Row ${n}`] = r.paramedic === "Yes";
    checkboxFields[`Paramedics on Site - No, Row ${n}`] = r.paramedic === "No";
  });
  const AMB_MAX = 4;
  ics206.ambulances.slice(0, AMB_MAX).forEach((r, i) => {
    const n = i + 1;
    textFields[`Ambulance ServiceRow${n}`] = r.name;
    textFields[`LocationRow${n}-2`] = r.location;
    textFields[`Contact NumbersFrequencyRow${n}_2`] = r.contact;
    checkboxFields[`Check Box${n} Level of Service - ALS`] = r.level === "ALS";
    checkboxFields[`Check Box${n} Level of Service - BLS`] = r.level === "BLS";
  });
  const HOSP_MAX = 5;
  ics206.hospitals.slice(0, HOSP_MAX).forEach((r, i) => {
    const n = i + 1;
    textFields[`Hospital NameRow${n}`] = r.name;
    textFields[`Address Latitude  Longitude if HelipadRow${n}`] = r.address;
    textFields[`Contact Numbers FrequencyRow${n}`] = r.contact;
    textFields[`AirRow${n}`] = r.travelAir;
    textFields[`GroundRow${n}`] = r.travelGround;
    textFields[`Trauma Center - Level (Row ${n})`] = r.trauma === "Yes" ? r.traumaLevel : "";
    checkboxFields[`Check Box Trauma Center ${n}`] = r.trauma === "Yes";
    checkboxFields[`Check Box Burn Center Yes ${n}`] = r.burn === "Yes";
    checkboxFields[`Check Box Burn Center No ${n}`] = r.burn === "No";
    checkboxFields[`Check Box Helipad Yes ${n}`] = r.helipad === "Yes";
    checkboxFields[`Check Box Helipad No ${n}`] = r.helipad === "No";
  });
  return {
    textFields, checkboxFields,
    // Signature_11 (Prepared By, section 7) and Signature_12 (Approved
    // By, section 8) are PDF signature fields — drawn as overlay text.
    overlayTexts: [
      { page: 1, rect: [442.56, 93.6, 570.48, 106.8], text: ics206.preparedSignature, fontSize: 9 },
      { page: 1, rect: [429.12, 74.04, 570.48, 87.24], text: ics206.approvedSignature, fontSize: 9 },
    ],
    truncatedCounts: {
      aidStations: Math.max(0, ics206.aidStations.length - AID_MAX),
      ambulances: Math.max(0, ics206.ambulances.length - AMB_MAX),
      hospitals: Math.max(0, ics206.hospitals.length - HOSP_MAX),
    },
  };
}

export function mapIcs208HMFields(incident, ics208hm) {
  const prepared = splitDateTimeLocal(ics208hm.dateTime);
  const from = splitDateTimeLocal(ics208hm.opFrom);
  const to = splitDateTimeLocal(ics208hm.opTo);
  const opPeriod = (from.date || from.time || to.date || to.time)
    ? `${from.date} ${from.time}\nto ${to.date} ${to.time}`.trim()
    : "";
  const textFields = {
    "1 Incident Name": incident.name,
    "2 Date Prepared": prepared.date && prepared.time ? `${prepared.date} ${prepared.time}` : prepared.date,
    "3 Operational Period Time": opPeriod,
    "4 Incident Location": ics208hm.incidentLocation,
    "5 Incident Commander": ics208hm.orgIC,
    "6 HM Group Supervisor": ics208hm.orgHMGroupSupervisor,
    "7 Tech Specialist  HM Reference": ics208hm.orgTechSpecialist,
    "8 Safety Officer": ics208hm.orgSafetyOfficer,
    "9 Entry Leader": ics208hm.orgEntryLeader,
    "10 Site Access Control Leader": ics208hm.orgSiteAccessControlLeader,
    "11 Asst Safety Officer  HM": ics208hm.orgAsstSafetyOfficerHM,
    "12 Decontamination Leader": ics208hm.orgDeconLeader,
    "13 Safe Refuge Area Mgr": ics208hm.orgSafeRefugeAreaMgr,
    "14 Environmental Health": ics208hm.orgEnvironmentalHealth,
    "15 Other": ics208hm.orgOther1,
    "16 Other": ics208hm.orgOther2,
    "Comment": ics208hm.materialsComment,
    "20 LEL Instruments": ics208hm.lelInstruments,
    "21 O2 Instruments": ics208hm.o2Instruments,
    "22 ToxicityPPM Instruments": ics208hm.toxicityInstruments,
    "23 Radiological Instruments": ics208hm.radiologicalInstruments,
    "Comment_2": ics208hm.monitoringComment,
    "Comment_3": ics208hm.deconComment,
    "25 Command Frequency": ics208hm.commandFreq,
    "26 Tactical Frequency": ics208hm.tacticalFreq,
    "27 Entry Frequency": ics208hm.entryFreq,
    "Comment_4": ics208hm.medicalComment,
    "Site Map": ics208hm.siteMapNotes,
    "31 Entry Objectives": ics208hm.entryObjectives,
    "Comment_5": ics208hm.sopComment,
    "33 Emergency Procedures": ics208hm.emergencyProcedures,
    "34 Asst Safety Officer  HM Signature Safety Briefing Completed Time": ics208hm.safetyBriefingTime,
  };
  // Entry/Decon team names and PPE levels — the PDF's own field
  // naming for these isn't a clean Row1/Row2 pattern like the
  // materials table below, so each is spelled out explicitly rather
  // than built from a loop.
  const entry = ics208hm.entryTeam, decon = ics208hm.deconTeam;
  if (entry[0]) { textFields["Entry Team, Entry 1 Name"] = entry[0].name; textFields["Entry 1, PPE Level"] = entry[0].ppeLevel; }
  if (entry[1]) { textFields["Entry Team, Entry 2 Name"] = entry[1].name; textFields["Entry 2, PPE Level"] = entry[1].ppeLevel; }
  if (entry[2]) { textFields["Entry Team, Entry 3 Name"] = entry[2].name; textFields["Entry 3, PPE Level"] = entry[2].ppeLevel; }
  if (entry[3]) { textFields["Entry Team, Entry 4 Name"] = entry[3].name; textFields["Entry 4, PPE Level"] = entry[3].ppeLevel; }
  if (decon[0]) { textFields["Decontamination Element, Decon 1 Name"] = decon[0].name; textFields["Decon 1, PPE Level"] = decon[0].ppeLevel; }
  if (decon[1]) { textFields["Decontamination Element, Decon 2 Name"] = decon[1].name; textFields["Decon 2, PPE Level"] = decon[1].ppeLevel; }
  if (decon[2]) { textFields["Decontamination Element, Decon 3 Name"] = decon[2].name; textFields["Decon 3, PPE Level"] = decon[2].ppeLevel; }
  if (decon[3]) { textFields["Decontamination Element, Decon 4 Name"] = decon[3].name; textFields["Decon 4, PPE Level"] = decon[3].ppeLevel; }

  const MAT_MAX = 4;
  ics208hm.materials.slice(0, MAT_MAX).forEach((m, i) => {
    const n = i + 1;
    textFields[`19 MaterialRow${n}`] = m.material;
    textFields[`Container typeRow${n}`] = m.containerType;
    textFields[`QtyRow${n}`] = m.qty;
    textFields[`Phys StateRow${n}`] = m.physState;
    textFields[`pHRow${n}`] = m.ph;
    textFields[`IDLHRow${n}`] = m.idlh;
    textFields[`FPRow${n}`] = m.fp;
    textFields[`ITRow${n}`] = m.it;
    textFields[`VPRow${n}`] = m.vp;
    textFields[`VDRow${n}`] = m.vd;
    textFields[`SGRow${n}`] = m.sg;
    textFields[`LELRow${n}`] = m.lel;
    textFields[`UELRow${n}`] = m.uel;
  });

  const checkboxFields = {
    "Standard Decon Procedures: Yes": ics208hm.standardDecon === "Yes",
    "Standard Decon Procedures: No": ics208hm.standardDecon === "No",
    "Medical Monitoring: Yes": ics208hm.medicalMonitoring === "Yes",
    "Medical Monitoring: No": ics208hm.medicalMonitoring === "No",
    "Medical Treatment/Transport in Place: Yes": ics208hm.medicalTreatmentInPlace === "Yes",
    "Medical Treatment/Transport in Place: No": ics208hm.medicalTreatmentInPlace === "No",
    "Weather": !!ics208hm.siteMapWeather,
    "Command Post": !!ics208hm.siteMapCommandPost,
    "Zones": !!ics208hm.siteMapZones,
    "Assembly Areas": !!ics208hm.siteMapAssemblyAreas,
    "Escape Routes": !!ics208hm.siteMapEscapeRoutes,
    "Other": !!ics208hm.siteMapOther,
    "Modifications to Documented SOPs or Work Practices: Yes": ics208hm.sopModifications === "Yes",
    "Modifications to Documented SOPs or Work Practices: No": ics208hm.sopModifications === "No",
  };

  return {
    textFields, checkboxFields,
    // "3 Operational Period Time" combines from+to into one string
    // longer than this field's default single-line width leaves room
    // for — split across two lines instead, with multiline explicitly
    // enabled on the field since it isn't flagged that way in the
    // template despite its tall height suggesting room for it.
    fontSizes: { "3 Operational Period Time": 7 },
    multilineFields: ["3 Operational Period Time"],
    overlayTexts: [
      { page: 2, rect: [31.7377, 95.9032, 305.096, 112.334], text: ics208hm.asstSafetyOfficerSignature, fontSize: 9 },
      { page: 2, rect: [312.42, 66.685, 586.532, 85.8458], text: ics208hm.incidentCommanderSignature, fontSize: 9 },
      { page: 2, rect: [31.7922, 66.0736, 306.516, 85.2344], text: ics208hm.hmGroupSupervisorSignature, fontSize: 9 },
    ],
    truncatedMaterialCount: Math.max(0, ics208hm.materials.length - MAT_MAX),
  };
}

export function mapIcs201Fields(incident, orgLines) {
  const init = { date: incident.dateInitiated ? new Date(incident.dateInitiated + "T00:00").toLocaleDateString("en-US") : "", time: incident.timeInitiated || "" };
  const prepDT = splitDateTimeLocal(incident.prepDateTime);
  const preparedDateTime = prepDT.date && prepDT.time ? `${prepDT.date} ${prepDT.time}` : prepDT.date;

  const textFields = {
    "4 MapSketch include sketch showing the total area of operations the incident sitearea impacted and threatened areas overflight results trajectories impacted shorelines or other graphics depicting situational status and resource assignment": incident.mapSketch,
    "5 Situation Summary and Health and Safety Briefing for briefings or transfer of command Recognize potential incident Health and Safety Hazards and develop necessary measures remove hazard provide personal protective equipment warn people of the hazard to protect responders from those hazards": incident.situation,
    "6 Prepared by Name": incident.preparedBy, "PositionTitle": incident.prepPosition, "DateTime": preparedDateTime,
    "6 Prepared by Name_2": incident.preparedBy, "PositionTitle_2": incident.prepPosition, "DateTime_2": preparedDateTime,
    "6 Prepared by Name_3": incident.preparedBy, "PositionTitle_3": incident.prepPosition, "DateTime_3": preparedDateTime,
    "6 Prepared by Name_4": incident.preparedBy, "PositionTitle_4": incident.prepPosition, "DateTime_4": preparedDateTime,
    "7 Current and Planned Objectives": (incident.objectives || []).filter(Boolean).map((o, i) => `${i + 1}. ${o}`).join("\n"),
    "9 Current Organization fill in additional organization as appropriate Incident Commanders Operations Section Chief Planning Section Chief Logistics Section Chief FinanceAdministration Section Chief Safety Officer Public Information Officer Liaison Officer":
      orgLines.join("\n"),
  };
  const checkboxFields = {};
  const fontSizes = {};

  const ACTIONS_MAX = 22;
  (incident.actionsLog || []).slice(0, ACTIONS_MAX).forEach((a, i) => {
    const n = i + 1;
    textFields[`TimeRow${n}`] = a.time;
    textFields[`ActionsRow${n}`] = a.actions;
  });

  // Rows 1-7 and 8-17 of the Resource Summary table use two DIFFERENT
  // naming patterns for the same "Notes" column in this template —
  // "Notes locationassignmentstatus"/"_2".."_7" for the first seven,
  // then "Notes locationassignmentstatusRow8".."Row17" from the
  // eighth on — confirmed directly against the template's own
  // extracted field list rather than assumed, since guessing a single
  // pattern here would have silently dropped notes for half the rows.
  const notesFieldName = (n) => n === 1 ? "Notes locationassignmentstatus" : n <= 7 ? `Notes locationassignmentstatus_${n}` : `Notes locationassignmentstatusRow${n}`;
  const RESOURCES_MAX = 17;
  (incident.resourceOrders || []).slice(0, RESOURCES_MAX).forEach((r, i) => {
    const n = i + 1;
    const ordered = splitDateTimeLocal(r.ordered);
    textFields[`ResourceRow${n}`] = r.resource;
    textFields[`Resource IdentifierRow${n}`] = r.identifier;
    textFields[`DateTime OrderedRow${n}`] = ordered.date && ordered.time ? `${ordered.date} ${ordered.time}` : ordered.date;
    fontSizes[`DateTime OrderedRow${n}`] = 7; // default size clips the full "MM/DD/YYYY HH:MM" in this column's width
    textFields[`ETARow${n}`] = r.eta;
    textFields[notesFieldName(n)] = r.notes;
    checkboxFields[`Check Box${n}`] = !!r.arrived;
  });

  return {
    textFields, checkboxFields,
    // "1. Incident Name", "2. Incident Number", and "3. Date/Time
    // Initiated" are visually present on page 1 but have no
    // underlying fillable form field at all in this template (unlike
    // the signature fields elsewhere, which exist but as the wrong
    // field type) — confirmed by their absence from the template's
    // own extracted field list. Coordinates below came from the
    // template's own text-label positions (the "1.Incident Name:"
    // label etc.), not visual estimation.
    overlayTexts: [
      { page: 1, rect: [129, 720.5, 210, 730.4], text: incident.name, fontSize: 9 },
      { page: 1, rect: [316, 720.5, 360, 730.4], text: incident.number, fontSize: 9 },
      { page: 1, rect: [393, 705.4, 444, 715.3], text: init.date, fontSize: 9 },
      { page: 1, rect: [478, 705.4, 570, 715.3], text: init.time, fontSize: 9 },
      { page: 1, rect: [469.68, 77.52, 570.6, 90.72], text: incident.prepSignature, fontSize: 9 },
      { page: 2, rect: [469.56, 83.76, 570.48, 96.96], text: incident.prepSignature, fontSize: 9 },
      { page: 3, rect: [469.56, 78.6, 570.72, 91.8], text: incident.prepSignature, fontSize: 9 },
      { page: 4, rect: [469.56, 116.52, 570.48, 129.72], text: incident.prepSignature, fontSize: 9 },
    ],
    fontSizes,
    truncatedCounts: {
      actionsLog: Math.max(0, (incident.actionsLog || []).length - ACTIONS_MAX),
      resourceOrders: Math.max(0, (incident.resourceOrders || []).length - RESOURCES_MAX),
    },
  };
}

// Only pages 1-3 (141 of this template's 952 fields) are mapped.
// Page 4 is a 21-column resource-type x row matrix ("Resource 1"..
// "Resource 21" as column headers, "Number of Resources N, Row M" as
// cells) — a fundamentally different shape than this app's own
// resourceCommitments, which is a flat list of {agency, resources,
// additionalPersonnel, totalPersonnel, totalResources} rows. Forcing
// that list into specific resource-type columns would mean guessing
// which column each entry belongs in, producing a table that looks
// authoritative but is actually wrong — left blank instead of risking
// that on a form built for cross-agency situational awareness.
export function mapIcs209Fields(incident, ics209) {
  const prepared = splitDateTimeLocal(ics209.preparedDateTime);
  const submitted = splitDateTimeLocal(ics209.submittedDateTime);
  const from = splitDateTimeLocal(ics209.opFrom);
  const to = splitDateTimeLocal(ics209.opTo);

  const textFields = {
    // Top header — no dedicated "report date/time" field exists in
    // this app's data (startDate/startTime/startTimeZone are defined
    // in the data shape but never actually exposed in the UI to set),
    // so this reuses Prepared Date/Time as the closest meaningful
    // value, the same way it's repeated at the bottom of the form.
    "Date": prepared.date, "Time": prepared.time, "Time Zone": ics209.submittedTimeZone,
    "Report Number (if used)": ics209.reportNumber,
    "4 Incident Commanders  Agency or Organization": ics209.icAgencyOrg,
    "5 Incident Management Organization": ics209.imTeam,
    "From DateTime": from.date && from.time ? `${from.date} ${from.time}` : from.date,
    "To DateTime": to.date && to.time ? `${to.date} ${to.time}` : to.date,
    "Percent Contained": ics209.percentContained,
    "7 Current Incident Size or Area Involved use unit label  eg sq mi city block": ics209.sizeArea,
    "9 Incident Definition": ics209.definition,
    "10 Incident Complexity Level": ics209.complexityLevel,
    "Print Name": ics209.preparedByName, "ICS Position": ics209.preparedByPosition,
    "DateTime Prepared_2": prepared.date && prepared.time ? `${prepared.date} ${prepared.time}` : prepared.date,
    "13 DateTime Submitted Time Zone": submitted.date && submitted.time ? `${submitted.date} ${submitted.time} ${ics209.submittedTimeZone}` : ics209.submittedTimeZone,
    "Print Name_2": ics209.approvedByName, "ICS Position_2": ics209.approvedByPosition,
    "15 Primary Location Organization or Agency Sent To": ics209.sentTo,
    "16 State": ics209.state, "17 CountyParishBorough": ics209.county, "18 City": ics209.city,
    "19 Unit or Other": ics209.unitOther, "20 Incident Jurisdiction": ics209.jurisdiction,
    "21 Incident Location Ownership if different than jurisdiction": ics209.ownership,
    "22 Longitude": ics209.longitude, "22 Latitude": ics209.latitude,
    "23 US National Grid Reference": ics209.usng,
    "24 Legal Description township section range": ics209.legalDescription,
    "25 Short Location or Area Description list all affected areas or a reference point": ics209.shortLocation,
    "26 UTM Coordinates": ics209.utm,
    "27 Note any electronic geospatial data included or attached indicate data format content and collection time information and labels": ics209.geospatialNote,
    "28 Significant Events for the Time Period Reported summarize significant progress made evacuations incident growth etc": ics209.significantEvents,
    "29 Primary Materials or Hazards Involved hazardous chemicals fuel types infectious agents radiation etc": ics209.primaryMaterials,
    "30 Damage Assessment Information summarize damage andor restriction of use or availability to residential or commercial property natural resources critical infrastructure and key resources etc": ics209.damageOther,
    "33 Life Safety and Health StatusThreat Remarks": ics209.threatRemarks,
    "35.Weather Concerns (synopsis of current and predictedweather; discuss related factors that may cause concern):": ics209.weatherConcerns,
    "37 Strategic Objectives define planned endstate for incident": ics209.strategicObjectives,
    "40 Strategic Discussion  Explain the relation of overall strategy constraints and current available information to 1 critical resource needs identified above 2 the Incident Action Plan and management objectives and targets 3 anticipated results Explain major problems and concerns such as operational challenges incident management problems and social political economic or environmental concerns or impacts": ics209.strategicDiscussion,
    "41 Planned Actions for Next Operational Period": ics209.plannedActions,
    "42 Projected Final Incident SizeArea use unit label  eg sq mi": ics209.projectedFinalSize,
    "43 Anticipated Incident Management Completion Date": ics209.completionDate,
    "44 Projected Significant Resource Demobilization Start Date": ics209.demobStartDate,
    "45 Estimated Incident Costs to Date": ics209.costsToDate,
    "46 Projected Final Incident Cost Estimate": ics209.finalCostEstimate,
    "47 Remarks or continuation of any blocks above  list block number in notation": ics209.remarks,
  };

  // Structural damage table — maps directly onto ics209.structural's
  // own four categories.
  const structuralMap = {
    singleResidences: "E Single Residences", nonresidential: "F Nonresidential Commercial Property",
    otherMinor: "Other Minor Structures", other: "Other",
  };
  for (const [key, suffix] of Object.entries(structuralMap)) {
    const row = ics209.structural[key];
    textFields[`B  Threatened 72 hrs${suffix}`] = row.threatened;
    textFields[`C  Damaged${suffix}`] = row.damaged;
    textFields[`D  Destroyed${suffix}`] = row.destroyed;
  }

  // Public/Responder Status Summary (rows D-N) — each row letter means
  // a DIFFERENT category depending on which side of the table it's
  // on (row H is "Evacuated" for Public but "Sheltering in Place" for
  // Responder, for instance) — every field name below was confirmed
  // against the template's own column-header positions (Public Status
  // left, Responder Status right; "This Period" then "Total to Date"
  // within each) rather than assumed from the field's own name, which
  // alone is not reliably self-describing here (e.g. "D Fatalities_2"
  // vs "D Fatalities - Total to Date-2" only differ by which of the
  // two Responder columns they are).
  const publicFieldNames = {
    fatalities: ["D Fatalities", "D Fatalities - Total to Date"],
    injuries: ["E With Injuries Illness", "E With Injuries Illness - Total to Date"],
    trapped: ["F TrappedIn Need of Rescue", "F TrappedIn Need of Rescue - Total to Date"],
    missing: ["G Missing note if estimated", "G Missing note if estimated - Total to Date"],
    evacuated: ["H Evacuated note if estimated", "H Evacuated note if estimated - Total to Date"],
    shelterInPlace: ["I Sheltering in Place note if estimated", "I Sheltering in Place note if estimated - Total to Date"],
    tempShelters: ["J In Temporary Shelters note if est", "J In Temporary Shelters note if est - Total to Date"],
    massImmunizations: ["K Have Received Mass Immunizations", "K Have Received Mass Immunizations - Total to Date"],
    requireImmunizations: ["L Require Immunizations note if est", "L Require Immunizations note if est - Total to Date"],
    quarantine: ["M In Quarantine", "M In Quarantine - Total to Date"],
  };
  const responderFieldNames = {
    fatalities: ["D Fatalities_2", "D Fatalities - Total to Date-2"],
    injuries: ["E With InjuriesIllness_2", "E With Injuries Illness - Total to Date-2"],
    trapped: ["F TrappedIn Need of Rescue_2", "F TrappedIn Need of Rescue - Total to Date-2"],
    missing: ["G Missing", "G Missing note if estimated - Total to Date-2"],
    shelterInPlace: ["H Sheltering in Place", "H Sheltering in Place note if estimated - Total to Date-2"],
    receivedImmunizations: ["I Have Received Immunizations", "I Have Received Immunizations - Total to Date-2"],
    requireImmunizations: ["J Require Immunizations", "J Require Immunizations - Total to Date -2"],
    quarantine: ["K In Quarantine", "K In Quarantine - Total to Date -2"],
  };
  for (const [key, [periodField, totalField]] of Object.entries(publicFieldNames)) {
    const row = ics209.publicStatus[key];
    if (row) { textFields[periodField] = row.period; textFields[totalField] = row.total; }
  }
  for (const [key, [periodField, totalField]] of Object.entries(responderFieldNames)) {
    const row = ics209.responderStatus[key];
    if (row) { textFields[periodField] = row.period; textFields[totalField] = row.total; }
  }

  // "Check if Active" fields — despite the name and appearance
  // (small boxes next to each threat line), these are actually plain
  // TEXT fields in this template, not real checkboxes (confirmed by
  // the validation pass, not assumed from the field name) — an "X"
  // marks active, left blank otherwise, the standard convention for a
  // text-based check field. This app's THREAT_FLAG_OPTIONS list and
  // the template's A-N row labels match 1:1 in the same order.
  const threatFlagFieldNames = {
    noLikelyThreat: "A Check if ActiveA No Likely Threat",
    potentialFutureThreat: "A Check if ActiveB Potential Future Threat",
    massNotificationsInProgress: "A Check if ActiveC Mass Notifications in Progress",
    massNotificationsCompleted: "A Check if ActiveD Mass Notifications Completed",
    noEvacImminent: "A Check if ActiveE No Evacuations Imminent",
    planningForEvac: "A Check if ActiveF Planning for Evacuation",
    planningForShelterInPlace: "A Check if ActiveG Planning for ShelterinPlace",
    evacInProgress: "A Check if ActiveH Evacuations in Progress",
    shelterInPlaceInProgress: "A Check if ActiveI ShelterinPlace in Progress",
    repopulationInProgress: "A Check if ActiveJ Repopulation in Progress",
    massImmunizationInProgress: "A Check if ActiveK Mass Immunization in Progress",
    massImmunizationComplete: "A Check if ActiveL Mass Immunization Complete",
    quarantineInProgress: "A Check if ActiveM Quarantine in Progress",
    areaRestrictionInEffect: "A Check if ActiveN Area Restriction in Effect",
  };
  const checkboxFields = {
    "Check Box Report Version - Initial": ics209.reportVersion === "Initial",
    "Check Box Report Version -Update": ics209.reportVersion === "Update",
    "Check Box Report Version - Final": ics209.reportVersion === "Final",
  };
  for (const [key, fieldName] of Object.entries(threatFlagFieldNames)) {
    textFields[fieldName] = ics209.threatFlags[key] ? "X" : "";
  }

  // Timeframe blocks (12/24/48/72/after-72 hr) — three separate
  // sections share the same five keys. Each field name is spelled out
  // explicitly (confirmed against the template's own extracted field
  // list) rather than built from a shared pattern — the four "in
  // N-hour" variants and the "after 72-hour" variant aren't
  // consistently worded in the template itself (a missing space in
  // "operationalperiod" for the first four that isn't missing in the
  // fifth), which a generated-name approach would risk getting wrong.
  textFields["36.Projected Incident Activity, Potential, Movement, Escalation, or Spread and influencing factors during the next operationalperiod and in 12hour timeframes"] = ics209.projectedActivity.h12;
  textFields["36.Projected Incident Activity, Potential, Movement, Escalation, or Spread and influencing factors during the next operationalperiod and in 24hour timeframes"] = ics209.projectedActivity.h24;
  textFields["36.Projected Incident Activity, Potential, Movement, Escalation, or Spread and influencing factors during the next operationalperiod and in 48hour timeframes"] = ics209.projectedActivity.h48;
  textFields["36.Projected Incident Activity, Potential, Movement, Escalation, or Spread and influencing factors during the next operationalperiod and in 72hour timeframes"] = ics209.projectedActivity.h72;
  textFields["36.Projected Incident Activity, Potential, Movement, Escalation, or Spread and influencing factors during the next operational period and anticipated after 72hour timeframes"] = ics209.projectedActivity.after72;
  // The threat-summary and resource-needs blocks use a differently
  // worded (but per-timeframe identical in structure) field name —
  // built explicitly per key below rather than reused from the
  // pattern above, since guessing at a shared template between three
  // long, similarly-worded field names risks a subtle mismatch.
  textFields["38.Current Incident Threat Summary and Risk Information in 12-hour timeframes and beyond. Summarize primary incident threats to life, property, communities and community stability, residences, health care facilities, other critical infrastructure and key resources, commercial facilities, natural and environmental resources, cultural resources, and continuity of operations and/or business. Identify corresponding incident-related potential economic or cascading impacts"] = ics209.threatSummaryTimeframes.h12;
  textFields["38.Current Incident Threat Summary and Risk Information in 24-hour timeframes and beyond. Summarize primary incident threats to life, property, communities and community stability, residences, health care facilities, other critical infrastructure and key resources, commercial facilities, natural and environmental resources, cultural resources, and continuity of operations and/or business. Identify corresponding incident-related potential economic or cascading impacts"] = ics209.threatSummaryTimeframes.h24;
  textFields["38.Current Incident Threat Summary and Risk Information in 48-hour timeframes and beyond. Summarize primary incident threats to life, property, communities and community stability, residences, health care facilities, other critical infrastructure and key resources, commercial facilities, natural and environmental resources, cultural resources, and continuity of operations and/or business. Identify corresponding incident-related potential economic or cascading impacts"] = ics209.threatSummaryTimeframes.h48;
  textFields["38.Current Incident Threat Summary and Risk Information in 72-hour timeframes and beyond. Summarize primary incident threats to life, property, communities and community stability, residences, health care facilities, other critical infrastructure and key resources, commercial facilities, natural and environmental resources, cultural resources, and continuity of operations and/or business. Identify corresponding incident-related potential economic or cascading impacts"] = ics209.threatSummaryTimeframes.h72;
  textFields["38.Current Incident Threat Summary and Risk Information after 72-hour timeframes and beyond. Summarize primary incident threats to life, property, communities and community stability, residences, health care facilities, other critical infrastructure and key resources, commercial facilities, natural and environmental resources, cultural resources, and continuity of operations and/or business. Identify corresponding incident-related potential economic or cascading impacts"] = ics209.threatSummaryTimeframes.after72;
  textFields["39.Critical Resource Needs in 12-hour timeframes and beyond to meet critical incident objectives. List resource category, kind, and/or type, and amount needed, in priority order:"] = ics209.resourceNeeds.h12;
  textFields["39.Critical Resource Needs in 24-hour timeframes and beyond to meet critical incident objectives. List resource category, kind, and/or type, and amount needed, in priority order:"] = ics209.resourceNeeds.h24;
  textFields["39.Critical Resource Needs in 48-hour timeframes and beyond to meet critical incident objectives. List resource category, kind, and/or type, and amount needed, in priority order:"] = ics209.resourceNeeds.h48;
  textFields["39.Critical Resource Needs in 72-hour timeframes and beyond to meet critical incident objectives. List resource category, kind, and/or type, and amount needed, in priority order:"] = ics209.resourceNeeds.h72;
  textFields["39.Critical Resource Needs after 72-hour timeframes and beyond to meet critical incident objectives. List resource category, kind, and/or type, and amount needed, in priority order:"] = ics209.resourceNeeds.after72;

  return {
    textFields, checkboxFields,
    // Signature_15 (Approved By) is a PDF signature field.
    overlayTexts: [
      { page: 1, rect: [87.48, 478.2, 378.12, 491.88], text: ics209.approvedBySignature, fontSize: 9 },
    ],
  };
}

// Formats a full ISO timestamp (as this app's activity-log entries
// store, via nowISO()) as "MM/DD HH:MM" for the ICS-214's combined
// Date/Time column — includes the date (not just time) since a log
// can span multiple days, unlike a datetime-local value which
// splitDateTimeLocal above already expects a different, "YYYY-MM-
// DDTHH:MM" shaped string for.
function fmtLogDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const date = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${date} ${time}`;
}

// Maps a single activity log (one of this app's possibly-several
// per-unit/position logs — see Tab214) onto one ICS-214. Only the
// currently-selected log is exported at a time, matching every other
// form here exporting "this form's current data," not a batch of
// everything the incident has.
export function mapIcs214Fields(incident, log) {
  const textFields = {
    "1 Incident Name_19": incident.name,
    "1 Incident Name_20": incident.name,
    "3 Name": log.name, "4 ICS Position": log.position, "5 Home Agency and Unit": log.agency,
    // This app has no dedicated "prepared by" name/position separate
    // from the log's own — the person keeping an activity log IS the
    // one preparing it, so its own Name/Position are reused for
    // Section 8 on both pages rather than left blank. Signature and a
    // prepared date/time aren't collected anywhere for a log (only
    // each entry's own timestamp is), so those stay blank rather than
    // fabricated.
    "8 Prepared by Name": log.name, "PositionTitle_15": log.position,
    "8 Prepared by Name_2": log.name, "PositionTitle_16": log.position,
  };

  // Resources Assigned (Section 6) — 8 rows fit on the template's
  // single page 1. Only the "Name" column's field name carries an
  // odd "_3" suffix for rows 1-6 specifically (not rows 7-8, and not
  // the other two columns at all) — confirmed against the template's
  // own field list rather than assumed, since a single shared pattern
  // guess across all three columns would have been wrong for two of
  // them.
  const RESOURCES_MAX = 8;
  const nameFieldFor = (n) => n <= 6 ? `NameRow${n}_3` : `NameRow${n}`;
  (log.resourcesAssigned || []).slice(0, RESOURCES_MAX).forEach((r, i) => {
    const n = i + 1;
    textFields[nameFieldFor(n)] = r.name;
    textFields[`ICS PositionRow${n}`] = r.icsPosition;
    textFields[`Home Agency and UnitRow${n}`] = r.homeAgency;
  });

  // Chronological, oldest-first, for export — the reverse of how
  // Tab214 stores and displays them (newest-first, so the latest
  // entry is easiest to find while actively logging) since a
  // completed activity log is conventionally read top-to-bottom in
  // the order things actually happened, matching the row-by-row
  // layout of the official form itself.
  const chronological = [...(log.entries || [])].reverse();
  // Page 1 holds 24 rows (DateTimeRow1..24); page 2 continues with 24
  // more under a "_2" suffix (DateTimeRow1_2..24_2, entries 25-48)
  // before switching to a third, unsuffixed numbering picking up at
  // 25 (DateTimeRow25..36, entries 49-60) — confirmed against the
  // template's own field list rather than assumed, since a plausible
  // but wrong guess here (e.g. expecting _2 through all 36) would
  // have silently dropped the last dozen rows.
  const fieldNamesFor = (n) => {
    if (n <= 24) return { date: `DateTimeRow${n}`, text: `Notable ActivitiesRow${n}` };
    if (n <= 48) return { date: `DateTimeRow${n - 24}_2`, text: `Notable ActivitiesRow${n - 24}_2` };
    return { date: `DateTimeRow${n - 24}`, text: `Notable ActivitiesRow${n - 24}` };
  };
  const MAX_ENTRIES = 60;
  chronological.slice(0, MAX_ENTRIES).forEach((entry, i) => {
    const { date, text } = fieldNamesFor(i + 1);
    textFields[date] = fmtLogDateTime(entry.time);
    textFields[text] = entry.text;
  });

  return {
    textFields,
    // Position/Title can easily run longer than this narrow field's
    // default size accommodates (e.g. "Communications Unit Leader" —
    // observed clipping in testing), so both instances get a smaller
    // explicit size rather than leaving it to the field's own default.
    fontSizes: { "PositionTitle_15": 7, "PositionTitle_16": 7 },
    // Signature_21 (page 1) / Signature_22 (page 2) are PDF signature
    // fields — left undrawn here since this app never collects a
    // signature for an activity log, rather than fabricating one from
    // the log's own name.
    overlayTexts: [],
    truncatedEntryCount: Math.max(0, chronological.length - MAX_ENTRIES),
    truncatedResourceCount: Math.max(0, (log.resourcesAssigned || []).length - RESOURCES_MAX),
  };
}

export function mapIcs215AFields(incident, safety) {
  const from = splitDateTimeLocal(safety.opFrom);
  const to = splitDateTimeLocal(safety.opTo);
  const prepared = splitDateTimeLocal(safety.dateTime);
  const preparedCombined = prepared.date && prepared.time ? `${prepared.date} ${prepared.time}` : prepared.date;

  const textFields = {
    "1 Incident Name_21": incident.name,
    "2 Incident Number_10": incident.number,
    // Section 3's "Date/Time Prepared" and the footer's "DateTime_17"
    // are the same underlying concept (when the form was prepared) —
    // this app has only one dateTime field for it, reused for both,
    // the same pattern used for the other forms' repeated footers.
    "Date": prepared.date, "Time": prepared.time,
    "Date From": from.date, "Time From": from.time,
    "Date To": to.date, "Time To": to.time,
    "8 Prepared by Safety Officer Name": safety.preparedBy,
    "DateTime_17": preparedCombined,
    // "Prepared by Operations Section Chief Name" is left unset —
    // this app tracks only one preparer (Safety Officer), not a
    // second one for Operations Section Chief, so there's no source
    // data to put there rather than a blank placeholder.
  };

  const MAX_ROWS = 14;
  safety.rows.slice(0, MAX_ROWS).forEach((r, i) => {
    const n = i + 1;
    textFields[`5 Incident AreaRow${n}`] = [r.branch, r.division].filter(Boolean).join(" / ");
    textFields[`6 HazardsRisksRow${n}`] = r.hazards;
    textFields[`7 MitigationsRow${n}`] = r.mitigations;
  });

  return {
    textFields,
    // Signature_23 (Safety Officer, this app's own preparer) is drawn
    // as overlay text since it's a PDF signature field, not a text
    // field. Signature_24 (Operations Section Chief) is left
    // undrawn — same reasoning as the name field above.
    overlayTexts: [
      { page: 1, rect: [424.68, 98.88, 571.08, 110.88], text: safety.signature, fontSize: 9 },
    ],
    truncatedRowCount: Math.max(0, safety.rows.length - MAX_ROWS),
  };
}
