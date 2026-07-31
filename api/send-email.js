// Vercel serverless function — proxies debt-letter email requests to the Thaibulksms Email API.
// Keeps credentials server-side; index.html (public static file) must never see these directly.
//
// This hits a SEPARATE gateway from the SMS API (different domain) and is TEMPLATE-based only —
// confirmed 2026-07-31 against Thaibulksms's own developer PDF
// (assets.thaibulksms.com/documents/developer-manual/nwc/email-api-th.pdf). There is no raw
// body/HTML parameter and NO file-attachment parameter documented at all, so this sends a
// DOWNLOAD LINK to the PDF (already public on Supabase Storage) via a merge tag instead of a real
// attachment — per explicit user decision. Staff must first build the email's actual content as a
// Template in the Thaibulksms Email console (thaibulkmail.com) using these merge tags:
// {{CUSTOMER_NAME}} {{AMOUNT}} {{DUE_DATE}} {{PDF_LINK}} {{LETTER_NO}} {{ORDER_ID}}
//
// Auth: per Thaibulksms (2026-07-31), the SAME API Key/Secret already used for SMS (THAIBULKSMS_API_KEY
// / THAIBULKSMS_API_SECRET) works here too — both services were enabled under one credential pair,
// so this reuses those instead of needing a separate Email-only key.
//
// NOTE: the PDF's own parameter table had its columns visibly garbled by text extraction, so the
// exact key name/casing for the merge-tag payload ("Payload" below) is a best-effort reading, not
// 100% confirmed — if the API rejects the request, check the real payload shape via the Thaibulksms
// Email API Reference (https://developer.thaibulksms.com/reference) or their support before assuming
// this proxy is broken.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.THAIBULKSMS_API_KEY;
  const apiSecret = process.env.THAIBULKSMS_API_SECRET;
  const templateId = process.env.THAIBULKSMS_EMAIL_TEMPLATE_ID;
  const senderName = process.env.THAIBULKSMS_EMAIL_SENDER_NAME;
  if (!apiKey || !apiSecret || !templateId || !senderName) {
    res.status(500).json({ error: 'Thaibulksms Email API ยังไม่ได้ตั้งค่าบน server (THAIBULKSMS_API_KEY / THAIBULKSMS_API_SECRET / THAIBULKSMS_EMAIL_TEMPLATE_ID / THAIBULKSMS_EMAIL_SENDER_NAME)' });
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
      template_id: templateId,
      mail_from: senderName,
      mail_to: mailTo,
      subject: subject,
      Payload: {
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
