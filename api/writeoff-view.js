// GET /api/writeoff-view?batch=<token> — read-only, NO LOGIN required. This is the whole point of
// this endpoint: an executive opens writeoff-review.html with just the link (see
// confirmSubmitWriteoffBatch in index.html, which copies it), no debt-tracker account needed.
// Uses the SERVICE ROLE key (lib/writeoff-store.js) because the Storage bucket holding state.json
// is private and an anonymous visitor has no Supabase session at all. Returns only the small subset
// of fields the review page needs — never the full ~15-20MB state.json itself.
const { downloadState, signedPdfUrl, findBatchOrders } = require('../lib/writeoff-store');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const batchId = String((req.query && req.query.batch) || '').trim();
  if (!batchId) { res.status(400).json({ error: 'ไม่มีเลขที่เอกสาร' }); return; }

  try {
    const state = await downloadState();
    const orders = findBatchOrders(state, batchId);
    if (!orders.length) { res.status(404).json({ error: 'ไม่พบเอกสารนี้ — อาจถูกยกเลิกหรือลิงก์ไม่ถูกต้อง' }); return; }
    const latest = orders[0].writeoffHistory[orders[0].writeoffHistory.length - 1];
    const items = orders.map((o) => {
      const e = o.writeoffHistory[o.writeoffHistory.length - 1];
      return { customerName: o.customerName, soDisplay: o.soDisplay, overdueCount: e.overdueCount, amountDisp: e.amountDisp };
    });
    const totalAmountRaw = orders.reduce((s, o) => s + Number(o.writeoffHistory[o.writeoffHistory.length - 1].amountRaw || 0), 0);
    const pdfLink = await signedPdfUrl(latest.pdfPath, 24 * 3600);
    res.status(200).json({
      batchId: batchId,
      docNo: latest.docNo || batchId,
      status: latest.status,
      submittedBy: latest.submittedBy || '',
      submittedAt: latest.submittedAt || '',
      approver: latest.approver || '',
      reason: latest.reason || '',
      signedBy: latest.signedBy || '',
      signedAt: latest.signedAt || '',
      items: items,
      totalAmountRaw: totalAmountRaw,
      pdfLink: pdfLink
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
