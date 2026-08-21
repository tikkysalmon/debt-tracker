// POST /api/writeoff-action { batch, decision, reason?, actorName? } — NO LOGIN required.
// decision: 'approve' | 'reject' | 'hold' | 'sign'.
//
// Mutates the batch's status inside the shared state.json under the SAME optimistic lock
// (app_state_sync) the browser app itself uses for every save — see lib/writeoff-store.js for why a
// plain download→mutate→upload here would risk silently clobbering a staff member's concurrent edit
// in their own browser tab.
//
// Deliberate limitation: this endpoint does NOT regenerate the PDF file itself on 'sign' — real
// html2canvas rendering needs a browser DOM, which a Node serverless function doesn't have. A signed
// batch's PDF file stays the original draft image; who signed and when (signedBy/signedAt) is
// recorded as DATA and shown on the review page and inside the main app, just not stamped onto the
// PDF's pixels. If a visually-signed PDF is needed, a logged-in staff member can still open the
// batch from Report → ตัดจำหน่ายหนี้สูญ and use confirmSignWriteoffBatch there, which regenerates the
// image for real (same storage path, so the link stays valid either way).
const { acquireLock, releaseLock, downloadState, uploadState, findBatchOrders, nowTimestamp } = require('../lib/writeoff-store');

const VALID_DECISIONS = ['approve', 'reject', 'hold', 'sign'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const body = req.body || {};
  const batchId = String(body.batch || '').trim();
  const decision = String(body.decision || '').trim();
  const reason = String(body.reason || '').trim();
  const actorName = String(body.actorName || '').trim() || 'ผู้บริหาร (ไม่ระบุชื่อ)';

  if (!batchId) { res.status(400).json({ error: 'ไม่มีเลขที่เอกสาร' }); return; }
  if (VALID_DECISIONS.indexOf(decision) === -1) { res.status(400).json({ error: 'คำสั่งไม่ถูกต้อง' }); return; }
  if (decision === 'reject' && !reason) { res.status(400).json({ error: 'กรุณาระบุเหตุผลที่ไม่อนุมัติ' }); return; }

  const clientId = 'wo-srv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const gotLock = await acquireLock(clientId);
  if (!gotLock) { res.status(503).json({ error: 'ระบบกำลังมีการบันทึกอื่นอยู่ กรุณาลองใหม่อีกครั้งใน 1 นาที' }); return; }

  try {
    const state = await downloadState();
    const orders = findBatchOrders(state, batchId);
    if (!orders.length) throw new Error('ไม่พบเอกสารนี้ — อาจถูกยกเลิกหรือลิงก์ไม่ถูกต้อง');

    const latestBefore = orders[0].writeoffHistory[orders[0].writeoffHistory.length - 1];
    if (decision === 'sign') {
      if (latestBefore.status !== 'approved') throw new Error('ต้องอนุมัติก่อนจึงจะเซ็นได้');
    } else {
      if (latestBefore.status !== 'pending') throw new Error('เอกสารนี้ถูกตัดสินใจไปแล้ว (สถานะปัจจุบัน: ' + latestBefore.status + ')');
    }

    const nowIso = new Date().toISOString();
    const nowDisp = nowTimestamp();
    const batchOrderIds = orders.map((o) => o.orderId);
    let newStatus = latestBefore.status;

    state.orders = state.orders.map((o) => {
      if (batchOrderIds.indexOf(o.orderId) === -1) return o;
      const hist = o.writeoffHistory || [];
      const cur = hist[hist.length - 1];
      let updated;
      if (decision === 'approve') {
        updated = Object.assign({}, cur, { status: 'approved', approver: actorName, decidedAt: nowDisp });
        newStatus = 'approved';
      } else if (decision === 'reject') {
        updated = Object.assign({}, cur, { status: 'rejected', reason: reason, decidedAt: nowDisp });
        newStatus = 'rejected';
      } else if (decision === 'hold') {
        updated = Object.assign({}, cur, { seenAt: nowDisp });
        newStatus = 'pending';
      } else {
        // signedBy is ALWAYS the approver already recorded on this batch, never body.actorName — the
        // review page no longer even shows an editable name field at sign time (see
        // writeoff-review.html's renderDoc, 'approved' branch), but that's only a UI-level lock; this
        // is the actual enforcement, since nothing stops a direct POST here bypassing the page
        // entirely. Whoever approved is who signs — a different name would need a fresh approve first.
        updated = Object.assign({}, cur, { status: 'signed', signedBy: cur.approver || actorName, signedAt: nowDisp });
        newStatus = 'signed';
      }
      return Object.assign({}, o, { writeoffHistory: hist.slice(0, -1).concat([updated]) });
    });

    await uploadState(state);
    res.status(200).json({ ok: true, status: newStatus, at: nowIso });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    await releaseLock(clientId);
  }
};
