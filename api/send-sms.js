// Vercel serverless function — proxies debt-reminder SMS requests to the Thaibulksms API.
// Keeps THAIBULKSMS_API_KEY / THAIBULKSMS_API_SECRET server-side (set as Vercel env vars);
// index.html (public static file) must never see these directly.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.THAIBULKSMS_API_KEY;
  const apiSecret = process.env.THAIBULKSMS_API_SECRET;
  const sender = process.env.THAIBULKSMS_SENDER;
  if (!apiKey || !apiSecret || !sender) {
    res.status(500).json({ error: 'Thaibulksms API ยังไม่ได้ตั้งค่าบน server (THAIBULKSMS_API_KEY / THAIBULKSMS_API_SECRET / THAIBULKSMS_SENDER)' });
    return;
  }

  const { phone, message } = req.body || {};
  const msisdn = String(phone || '').replace(/[^0-9+]/g, '');
  const text = String(message || '').trim();
  if (!msisdn) { res.status(400).json({ error: 'ไม่มีเบอร์โทรศัพท์' }); return; }
  if (!text) { res.status(400).json({ error: 'ไม่มีข้อความ' }); return; }

  try {
    const auth = Buffer.from(apiKey + ':' + apiSecret).toString('base64');
    const body = new URLSearchParams({ msisdn: msisdn, message: text, sender: sender, force: 'corporate' });
    const smsRes = await fetch('https://api-v2.thaibulksms.com/sms', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: body.toString()
    });
    const data = await smsRes.json().catch(function () { return null; });
    // Thaibulksms's error shape is {"error":{"code":112,"name":"ERROR_MESSAGE","description":"..."}}
    // — a nested object, not a plain string. Pulling out .description/.name here is what actually
    // matters, since without it the frontend's alert used to just stringify the object as
    // "[object Object]" instead of showing the real reason (e.g. insufficient credit, bad sender).
    const thaiErr = data && data.error;
    const errMsg = thaiErr ? (thaiErr.description || thaiErr.name || JSON.stringify(thaiErr)) : ((data && data.message) || 'Thaibulksms API error');
    // bad_phone_number_list can carry a per-number rejection even on an overall HTTP 200 — surface
    // that too, since !smsRes.ok alone would miss it.
    const badNumbers = data && Array.isArray(data.bad_phone_number_list) ? data.bad_phone_number_list : [];
    if (!smsRes.ok) {
      res.status(smsRes.status).json({ error: errMsg, code: thaiErr && thaiErr.code, detail: data });
      return;
    }
    if (badNumbers.length) {
      res.status(400).json({ error: (badNumbers[0].message || 'เบอร์โทรศัพท์ไม่ถูกต้อง') + ' (' + badNumbers[0].number + ')', detail: data });
      return;
    }
    res.status(200).json({ ok: true, data: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
