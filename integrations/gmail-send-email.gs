/**
 * ICS-214 EMTF -> email, for the Command Board.
 *
 * Sends the PDF from the Gmail account that owns this script.
 *
 * SETUP (once), signed in to the Gmail account the emails should come FROM:
 *  1. Go to script.google.com -> New project. Replace the default code with
 *     this whole file.
 *  2. Fill in ALLOWED_RECIPIENTS and/or ALLOWED_DOMAINS below with whoever may
 *     receive these emails. (Must include the address you enter in the app.)
 *  3. Deploy -> New deployment -> gear icon -> Web app.
 *       Execute as:        Me
 *       Who has access:    Anyone
 *     Click Deploy and approve the permission prompt. Google will say the app
 *     is "unverified" because you wrote it yourself: Advanced -> Go to project.
 *  4. Copy the Web app URL (it ends in /exec) into the Command Board:
 *     Admin -> ICS-214 EMTF Sharing -> Email service URL.
 *
 * AFTER ANY LATER EDIT: Deploy -> Manage deployments -> pencil icon ->
 * Version: New version -> Deploy. Until you do, the live URL keeps running the
 * old code.
 */

// Anyone who has the web app URL can call it, so it only ever sends to the
// addresses listed here. Without this limit it would be an open mail relay
// sending from your Gmail account. If both lists are empty it refuses to send.
var ALLOWED_RECIPIENTS = [
  // "reports@example.com",
];
var ALLOWED_DOMAINS = [
  // "example.gov",
];

var MAX_PDF_BYTES = 5 * 1024 * 1024; // an ICS-214 EMTF is well under 1 MB

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || "");

    var recipients = String(data.to || "").split(/[;,\s]+/).filter(Boolean);
    if (recipients.length === 0) {
      return reply_({ ok: false, error: "No recipient address was provided." });
    }
    if (ALLOWED_RECIPIENTS.length === 0 && ALLOWED_DOMAINS.length === 0) {
      return reply_({ ok: false, error: "No allowed recipients are set in the script yet - edit ALLOWED_RECIPIENTS at the top of it." });
    }
    for (var i = 0; i < recipients.length; i++) {
      if (!isAllowed_(recipients[i])) {
        return reply_({ ok: false, error: recipients[i] + " isn't on the script's allowed-recipients list." });
      }
    }

    var bytes = Utilities.base64Decode(String(data.contentBase64 || ""));
    if (bytes.length === 0) return reply_({ ok: false, error: "No PDF was attached." });
    if (bytes.length > MAX_PDF_BYTES) return reply_({ ok: false, error: "The PDF is too large to send." });

    var filename = String(data.filename || "ICS-214-EMTF.pdf").replace(/[\\\/:*?"<>|]/g, "");
    var pdf = Utilities.newBlob(bytes, "application/pdf", filename);

    MailApp.sendEmail({
      to: recipients.join(","),
      subject: String(data.subject || "ICS-214 EMTF").slice(0, 200),
      body: String(data.body || ""),
      attachments: [pdf]
    });
    return reply_({ ok: true });
  } catch (err) {
    return reply_({ ok: false, error: String((err && err.message) || err) });
  }
}

function isAllowed_(addr) {
  var a = String(addr).toLowerCase();
  var i;
  for (i = 0; i < ALLOWED_RECIPIENTS.length; i++) {
    if (String(ALLOWED_RECIPIENTS[i]).toLowerCase() === a) return true;
  }
  var at = a.lastIndexOf("@");
  var domain = at >= 0 ? a.slice(at + 1) : "";
  for (i = 0; i < ALLOWED_DOMAINS.length; i++) {
    if (String(ALLOWED_DOMAINS[i]).toLowerCase() === domain) return true;
  }
  return false;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
