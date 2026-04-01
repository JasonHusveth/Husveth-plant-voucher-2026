// Rare Plant Voucher — Google Apps Script v2
// Supports both POST (data submission) and GET (data retrieval for label generator)
//
// SETUP: Same as before — Extensions > Apps Script > paste > Deploy > Web App
// Set "Execute as" = Me, "Who has access" = Anyone
// If updating an existing deployment: Deploy > Manage deployments > edit > New version

const SHEET_NAME = "Voucher Records";

// ── POST: receive a new voucher record from the field app ──────────────────
function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

    var data = JSON.parse(e.postData.contents);

    var headers = [
      "Date","Specimen Number","Plants of (Locality)","County","State",
      "TRS / QQ","Species","Authority","NPC Primary Code","NPC Primary Name",
      "NPC Secondary Code","NPC Secondary Name","Associated Species",
      "Hydrology","Soil Texture","Sun Exposure",
      "Latitude (NAD83)","Longitude (NAD83)",
      "Primary Collector","Other Observers","Notes","Special Permit No.","Timestamp"
    ];

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
      sheet.setFrozenRows(1);
    }

    var row = [
      data["Date"] || "",
      data["Specimen Number"] || "",
      data["Plants of"] || "",
      data["County"] || "",
      data["State"] || "",
      data["TRS QQ"] || "",
      data["Species"] || "",
      data["Authority"] || "",
      data["NPC Primary"] || "",
      data["NPC Primary Name"] || "",
      data["NPC Secondary"] || "",
      data["NPC Secondary Name"] || "",
      data["Associated Species"] || "",
      data["Hydrology"] || "",
      data["Soil Texture"] || "",
      data["Sun Exposure"] || "",
      data["Latitude NAD83"] || "",
      data["Longitude NAD83"] || "",
      data["Collector"] || "",
      data["Other Observers"] || "",
      data["Notes"] || "",
      data["Special Permit No."] || "",
      new Date().toLocaleString()
    ];

    sheet.appendRow(row);
    sheet.autoResizeColumns(1, headers.length);

    return ContentService
      .createTextOutput(JSON.stringify({status:"success", message:"Record saved"}))
      .setMimeType(ContentService.MimeType.JSON);

  } catch(err) {
    return ContentService
      .createTextOutput(JSON.stringify({status:"error", message:err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── GET: retrieve records for the label generator ─────────────────────────
// Usage:
//   ?action=list                     → returns all specimen numbers + dates
//   ?action=get&specnum=JJH-2026-001 → returns that record as JSON
//   ?action=recent&n=4               → returns the 4 most recent records
//   ?action=range&from=JJH-2026-001&to=JJH-2026-004 → returns records in that range
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      return jsonOut({status:"error", message:"Sheet not found"});
    }

    var params = e.parameter;
    var action = params.action || "list";
    var data = sheetToObjects(sheet);

    if (action === "list") {
      var list = data.map(function(r) {
        return {
          specnum: r["Specimen Number"],
          date: r["Date"],
          species: r["Species"],
          county: r["County"]
        };
      });
      return jsonOut({status:"success", records: list});
    }

    if (action === "get") {
      var specnum = params.specnum || "";
      var matches = data.filter(function(r) {
        return r["Specimen Number"] === specnum;
      });
      if (!matches.length) return jsonOut({status:"error", message:"Record not found: " + specnum});
      return jsonOut({status:"success", record: matches[0]});
    }

    if (action === "recent") {
      var n = parseInt(params.n) || 4;
      var recent = data.slice(-n);
      return jsonOut({status:"success", records: recent});
    }

    if (action === "range") {
      var from = params.from || "";
      var to = params.to || "";
      var inRange = data.filter(function(r) {
        var s = r["Specimen Number"] || "";
        return s >= from && s <= to;
      });
      return jsonOut({status:"success", records: inRange});
    }

    return jsonOut({status:"error", message:"Unknown action: " + action});

  } catch(err) {
    return jsonOut({status:"error", message:err.toString()});
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sheetToObjects(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var result = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = values[i][j] || "";
    }
    result.push(obj);
  }
  return result;
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Test from Apps Script editor ───────────────────────────────────────────
function testGet() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  var data = sheetToObjects(sheet);
  Logger.log("Total records: " + data.length);
  if (data.length) Logger.log("Most recent: " + JSON.stringify(data[data.length-1]));
}
