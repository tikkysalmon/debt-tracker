// Vercel serverless function — proxies debt-letter email requests to the Thaibulksms Email API.
// Keeps credentials server-side; index.html (public static file) must never see these directly.
//
// This hits a SEPARATE gateway from the SMS API and is template-based. Staff build the email's
// content as a Template in the Thaibulksms Email console (thaibulkmail.com) using these merge
// tags: {{CUSTOMER_NAME}} {{AMOUNT}} {{DUE_DATE}} {{PDF_LINK}} {{LETTER_NO}} {{ORDER_ID}}
//
// Auth: uses a DEDICATED API Key/Secret pair (THAIBULKSMS_EMAIL_API_KEY / THAIBULKSMS_EMAIL_API_SECRET),
// created via API Key > "ประเภท API: อีเมล" in the Thaibulksms console, not the shared
// THAIBULKSMS_API_KEY/SECRET used for SMS.
//
// ROOT CAUSE FOUND (2026-08-01): every request to https://tbs-email-api-gateway.omb.to returned a
// generic 500 "internal error" no matter what changed — payload shape, sender, 5 different
// templates, 2 API key pairs, with/without the PDF link, plain-text vs. hyperlink vs. button.
// Turned out that domain was simply WRONG. Thaibulksms's real, current OpenAPI spec (pulled
// straight from developer.thaibulksms.com/tbs-api-en.json, which is what their own interactive
// reference page loads) gives the actual base URL: https://email-api.thaibulksms.com — a
// different host than the one in their old developer-manual PDF and every prior guess. The spec
// also shows the real shape differs from what the stale docs said:
//   - mail_from is an OBJECT { email, name? }, not a bare string
//   - mail_to is a single OBJECT { email }, not an array (the old gateway's validator accepted an
//     array without complaint, which in hindsight was itself a sign it wasn't the real backend)
//   - attachments IS supported — an "attachments" array of either { type:'url', filename, fileUrl }
//     or { type:'uuid', uuid } (from the separate Upload Attachment API), up to 5 files / 5MB total
// Since attachments are real now, this sends the debt letter PDF as an actual attachment (not just
// a download-link merge tag) — closer to what was originally asked for before "no attachment
// support" turned out to be based on stale documentation.
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
      mail_from: { email: senderName },
      mail_to: { email: mailTo },
      subject: subject,
      payload: {
        CUSTOMER_NAME: customerName || '',
        AMOUNT: amount || '',
        DUE_DATE: dueDate || '',
        PDF_LINK: pdfLink,
        LETTER_NO: String(letterNo || ''),
        ORDER_ID: orderId || ''
      },
      attachments: [
        { type: 'url', filename: 'debt-letter-' + (orderId || 'unknown') + '.pdf', fileUrl: pdfLink }
      ]
    };
    const emailRes = await fetch('https://email-api.thaibulksms.com/email/v1/send_template', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await emailRes.json().catch(function () { return null; });
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
