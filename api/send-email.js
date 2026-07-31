// Vercel serverless function — proxies debt-letter email requests to the Thaibulksms Email API.
// Keeps credentials server-side; index.html (public static file) must never see these directly.
//
// This hits a SEPARATE gateway from the SMS API (different domain) and is TEMPLATE-based only —
// no raw body/HTML parameter and NO file-attachment parameter, so this sends a DOWNLOAD LINK to
// the PDF (already public on Supabase Storage) via a merge tag instead of a real attachment — per
// explicit user decision. Staff build the email's actual content as a Template in the Thaibulksms
// Email console (thaibulkmail.com) using these merge tags:
// {{CUSTOMER_NAME}} {{AMOUNT}} {{DUE_DATE}} {{PDF_LINK}} {{LETTER_NO}} {{ORDER_ID}}
//
// Auth: uses a DEDICATED API Key/Secret pair (THAIBULKSMS_EMAIL_API_KEY / THAIBULKSMS_EMAIL_API_SECRET),
// created via API Key > "ประเภท API: อีเมล" in the Thaibulksms console, not the shared
// THAIBULKSMS_API_KEY/SECRET used for SMS. Reverted to this (2026-08-01) after payload shape, sender
// casing, template choice, credit balance, and link-vs-plain-text all ruled out as the cause of a
// persistent 500 "internal error" on every send attempt — testing whether a key created under the
// SMS "ประเภท API" type (even though the account has both services enabled) is itself the problem.
//
// Request shape: Thaibulksms's own developer PDF (assets.thaibulksms.com/documents/developer-manual/
// nwc/email-api-th.pdf, dated 2024-01-10) documents template_id/Payload/mail_to:string — but the
// LIVE gateway rejects that exact shape (tested directly 2026-08-01, response:
// {"message":"Bad Request Exception","required":["property template_id should not exist",
// "property Payload should not exist","template_uuid must be a UUID", "each value in nested
// property mail_to must be either object or array"]}). The PDF is stale vs. the deployed API. This
// now sends template_uuid + mail_to as an array of {email, payload} objects instead — the array
// shape is confirmed by that error, but the exact per-recipient merge-tag field name ("payload"
// below) is still an educated guess, not confirmed. If sends still fail, read the `detail` field
// of the error the app now surfaces — it's the raw response straight from Thaibulksms's validator
// and will spell out exactly what's still wrong — or check with Thaibulksms support directly.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.THAIBULKSMS_EMAIL_API_KEY;
  const apiSecret = process.env.THAIBULKSMS_EMAIL_API_SECRET;
  const templateId = process.env.THAIBULKSMS_EMAIL_TEMPLATE_ID;
  // Thaibulksms's sender list stores/verifies the address lowercase (confirmed 2026-08-01 — the
  // console shows "debtcollection@salmonphone.com" while the env var was originally typed with
  // mixed case); lowercasing here means an exact-match lookup on their end can never miss just
  // because of how this got typed into Vercel.
  const senderName = (process.env.THAIBULKSMS_EMAIL_SENDER_NAME || '').trim().toLowerCase();
  if (!apiKey || !apiSecret || !templateId || !senderName) {
    res.status(500).json({ error: 'Thaibulksms Email API ยังไม่ได้ตั้งค่าบน server (THAIBULKSMS_EMAIL_API_KEY / THAIBULKSMS_EMAIL_API_SECRET / THAIBULKSMS_EMAIL_TEMPLATE_ID / THAIBULKSMS_EMAIL_SENDER_NAME)' });
    return;
  }

  const { to, orderId, letterNo, pdfLink, customerName, amount, dueDate } = req.body || {};
  const mailTo = String(to || '').trim();
  if (!mailTo) { res.status(400).json({ error: 'ไม่มีอีเมลผู้รับ' }); return; }
  if (!pdfLink) { res.status(400).json({ error: 'ไม่มีลิงก์ไฟล์ PDF' }); return; }

  try {
    const auth = Buffer.from(apiKey + ':' + apiSecret).toString('base64');
    const subject = 'หนังสือทวงถามให้ชำระหนี้ค้างชำระ (ครั้งที่ ' + (letterNo || '') + ') เลขที่คำสั่งซื้อ ' + (orderId || '');
    const payload = {
      template_uuid: templateId,
      mail_from: senderName,
      subject: subject,
      mail_to: [{ email: mailTo }],
      payload: {
        CUSTOMER_NAME: customerName || '',
        AMOUNT: amount || '',
        DUE_DATE: dueDate || '',
        PDF_LINK: pdfLink,
        LETTER_NO: String(letterNo || ''),
        ORDER_ID: orderId || ''
      }
    };
    const emailRes = await fetch('https://tbs-email-api-gateway.omb.to/email/v1/send_template', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await emailRes.json().catch(function () { return null; });
    // Error shape per Thaibulksms's own example: {"statusCode":404,"message":"ERROR_EMAIL_SENDER_NOT_FOUND",...}
    const errMsg = data && (data.message || data.error) ? (data.message || data.error) : 'Thaibulksms Email API error';
    if (!emailRes.ok) {
      res.status(emailRes.status).json({ error: errMsg, detail: data });
      return;
    }
    res.status(200).json({ ok: true, data: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
