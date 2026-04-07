// ============================================================
//  MN Vascular Plant Voucher — Google Apps Script
//  Handles:
//    GET  ?action=list          → all records, newest first
//    GET  ?action=recent        → last 50 records
//    GET  ?action=get&id=N      → single row by row number
//    GET  ?action=range&start=DATE&end=DATE → records in date range
//    POST {action:"submit",...} → append new record
//    POST {action:"update", specimenNumber:"JJH-2026-001", fields:{...}} → update existing row
// ============================================================

// ── Column order (must match your sheet exactly) ──────────────────────────────
// If your sheet has a different column order, adjust COLUMNS below.
const COLUMNS = [
  "Date",
  "Specimen Number",
  "Plants of",
  "Municipality",
  "County",
  "State",
  "TRS QQ",
  "Species",
  "Authority",
  "NPC Primary",
  "NPC Primary Name",
  "NPC Secondary",
  "NPC Secondary Name",
  "Associated Species",
  "Hydrology",
  "Soil Texture",
  "Sun Exposure",
  "Latitude NAD83",
  "Longitude NAD83",
  "Collector",
  "Other Observers",
  "Notes",
  "Special Permit No.",
  "Timestamp"
];

// ── Helper: get the active sheet ──────────────────────────────────────────────
function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
}

// ── Helper: convert a row array to a record object ───────────────────────────
function rowToRecord(row, headers) {
  const rec = {};
  headers.forEach((h, i) => { rec[h] = row[i] !== undefined ? String(row[i]) : ""; });
  return rec;
}

// ── Helper: CORS-safe JSON response ──────────────────────────────────────────
function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── GET handler ───────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    const action = (e.parameter && e.parameter.action) || "list";
    const sheet  = getSheet();
    const data   = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return jsonResponse({ records: [], count: 0 });
    }

    const headers = data[0];
    const rows    = data.slice(1);

    if (action === "list") {
      // All records, newest first (by row order — most recent append = last row)
      const records = rows.map(r => rowToRecord(r, headers)).reverse();
      return jsonResponse({ records: records, count: records.length });
    }

    if (action === "recent") {
      const n       = parseInt((e.parameter && e.parameter.n) || "50");
      const records = rows.slice(-n).reverse().map(r => rowToRecord(r, headers));
      return jsonResponse({ records: records, count: records.length });
    }

    if (action === "get") {
      const id  = parseInt(e.parameter.id || "0");
      if (id < 1 || id > rows.length) {
        return jsonResponse({ error: "Row not found", status: "error" });
      }
      return jsonResponse({ record: rowToRecord(rows[id - 1], headers), status: "ok" });
    }

    if (action === "range") {
      const start   = e.parameter.start || "";
      const end     = e.parameter.end   || "";
      const records = rows
        .map(r => rowToRecord(r, headers))
        .filter(rec => {
          const d = rec["Date"] || "";
          return (!start || d >= start) && (!end || d <= end);
        })
        .reverse();
      return jsonResponse({ records: records, count: records.length });
    }

    return jsonResponse({ error: "Unknown action: " + action, status: "error" });

  } catch (err) {
    return jsonResponse({ error: err.toString(), status: "error" });
  }
}

// ── POST handler ──────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    let payload;
    try {
      // Both the field app and review app send plain JSON in the body
      payload = JSON.parse(e.postData.contents);
    } catch (_) {
      payload = e.parameter || {};
    }

    const action = payload.action || "submit";

    // ── SUBMIT: append new record ────────────────────────────────────────────
    if (action === "submit") {
      return handleSubmit(payload);
    }

    // ── UPDATE: overwrite existing row matched by Specimen Number ────────────
    if (action === "update") {
      return handleUpdate(payload);
    }

    return jsonResponse({ error: "Unknown action: " + action, status: "error" });

  } catch (err) {
    return jsonResponse({ error: err.toString(), status: "error" });
  }
}

// ── SUBMIT handler ────────────────────────────────────────────────────────────
function handleSubmit(fields) {
  const sheet   = getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const now     = new Date().toISOString();

  // Build row in header order
  const row = headers.map(h => {
    if (h === "Timestamp") return now;
    return fields[h] !== undefined ? fields[h] : "";
  });

  sheet.appendRow(row);
  return jsonResponse({ status: "ok", result: "success", timestamp: now });
}

// ── UPDATE handler ────────────────────────────────────────────────────────────
function handleUpdate(payload) {
  const specimenNumber = payload.specimenNumber || (payload.fields && payload.fields["Specimen Number"]);
  const fields         = payload.fields || payload;

  if (!specimenNumber) {
    return jsonResponse({ status: "error", error: "specimenNumber is required" });
  }

  const sheet   = getSheet();
  const data    = sheet.getDataRange().getValues();

  if (data.length < 2) {
    return jsonResponse({ status: "error", error: "Sheet is empty" });
  }

  const headers    = data[0];
  const specNumCol = headers.indexOf("Specimen Number");

  if (specNumCol === -1) {
    return jsonResponse({ status: "error", error: "Column 'Specimen Number' not found in sheet" });
  }

  // Find the matching row (1-indexed, skip header row 1)
  let targetRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][specNumCol]).trim() === String(specimenNumber).trim()) {
      targetRow = i + 1; // Sheet rows are 1-indexed; data[1] = sheet row 2
      break;
    }
  }

  if (targetRow === -1) {
    return jsonResponse({
      status: "error",
      error:  "No record found with Specimen Number: " + specimenNumber
    });
  }

  // Update each column that exists in the fields payload
  // Timestamp column is NOT overwritten on update
  headers.forEach((h, colIdx) => {
    if (h === "Timestamp") return;           // preserve original timestamp
    if (fields[h] === undefined) return;     // skip fields not in payload
    sheet.getRange(targetRow, colIdx + 1).setValue(fields[h]);
  });

  // Write an "Updated" timestamp in a column called "Last Updated" if it exists
  const lastUpdCol = headers.indexOf("Last Updated");
  if (lastUpdCol !== -1) {
    sheet.getRange(targetRow, lastUpdCol + 1).setValue(new Date().toISOString());
  }

  return jsonResponse({
    status:      "ok",
    result:      "success",
    updatedRow:  targetRow,
    specimenNumber: specimenNumber
  });
}
