// Vercel serverless function — proxies e-sign notification emails to the Thaibulksms Email API.
// Deliberately mirrors api/send-email.js's proven-working call pattern (same credentials, same
// gateway, same auth/payload shape) instead of calling Thaibulksms directly from the Supabase
// Edge Function — that separate path kept showing "Delivered" in the Thaibulksms dashboard while
// never actually reaching Gmail (not even Spam), and this file exists specifically to rule out
// "something about calling from Deno/Supabase instead of this Vercel function" as the cause.
//
// templateUuid is passed in per-request (not a fixed env var like send-email.js's
// THAIBULKSMS_EMAIL_TEMPLATE_ID) because e-sign uses its own template, separate from the debt
// demand-letter one — avoids needing a new Vercel env var just to point at it.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.THAIBULKSMS_EMAIL_API_KEY;
  const apiSecret = process.env.THAIBULKSMS_EMAIL_API_SECRET;
  const senderName = (process.env.THAIBULKSMS_EMAIL_SENDER_NAME || '').trim().toLowerCase();
  if (!apiKey || !apiSecret || !senderName) {
    res.status(500).json({ error: 'Thaibulksms Email API ยังไม่ได้ตั้งค่าบน server (THAIBULKSMS_EMAIL_API_KEY / THAIBULKSMS_EMAIL_API_SECRET / THAIBULKSMS_EMAIL_SENDER_NAME)' });
    return;
  }

  const { to, templateUuid, subject, customerName, orderId, actionUrl } = req.body || {};
  const mailTo = String(to || '').trim();
  if (!mailTo) { res.status(400).json({ error: 'ไม่มีอีเมลผู้รับ' }); return; }
  if (!templateUuid) { res.status(400).json({ error: 'ไม่มี templateUuid' }); return; }
  if (!actionUrl) { res.status(400).json({ error: 'ไม่มีลิงก์ปลายทาง' }); return; }

  try {
    const auth = Buffer.from(apiKey + ':' + apiSecret).toString('base64');
    const payload = {
      template_uuid: templateUuid,
      mail_from: { email: senderName },
      mail_to: { email: mailTo },
      subject: subject || 'แจ้งเตือนจากระบบ',
      payload: {
        CUSTOMER_NAME: customerName || '',
        ORDER_ID: orderId || '',
        PDF_LINK: actionUrl
      }
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
