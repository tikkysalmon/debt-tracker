// GET|POST /api/state-export — INTERNAL ONLY (internal AI assistant + executives), never wired into
// respond.io. Guarded by header x-export-key == env DEBT_EXPORT_KEY (a DIFFERENT key from
// DEBT_SUMMARY_KEY: this one unlocks every debtor in state.json). Returns a short-lived (10 min)
// signed Storage URL for state.json rather than streaming the ~15-20MB file through the function,
// so the data itself never passes through this endpoint's response or its logs.
const { signedPdfUrl } = require('../lib/writeoff-store');
const { keyOk, deny } = require('../lib/key-auth');

const EXPIRES_SECONDS = 600;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).end(); return; }
  if (!keyOk(req, 'x-export-key', 'DEBT_EXPORT_KEY')) { deny(res); return; }
  try {
    // signedPdfUrl is generic over any object path in the app-data bucket.
    const url = await signedPdfUrl('state.json', EXPIRES_SECONDS);
    if (!url) { res.status(502).json({ error: 'สร้างลิงก์ดาวน์โหลดไม่สำเร็จ' }); return; }
    // Audit trail in Vercel logs (no data, just when/from where).
    console.log('[state-export] link issued', new Date().toISOString(), String(req.headers['x-forwarded-for'] || ''));
    res.setHeader('Cache-Control', 'no-store');
    // Since 2026-10-07 state.json is stored gzip-compressed (50 MB per-object limit) — consumers must gunzip when the
    // first two bytes are 0x1f 0x8b (older plain-JSON copies are still possible, so sniff, don't assume).
    res.status(200).json({ url: url, expiresInSeconds: EXPIRES_SECONDS, encoding: 'gzip (ตรวจ 2 ไบต์แรก 1f 8b — ถ้าใช่ให้ gunzip ก่อนอ่าน ไม่เช่นนั้นเป็น JSON ธรรมดา)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
