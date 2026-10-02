// POST /api/debt-summary — per-customer arrears for the customer-facing AI assistant (respond.io).
// Body: { phone } or { customerId }. Header x-debt-key must equal env DEBT_SUMMARY_KEY, else 403 with
// an empty body (never hints whether a number exists). Returns ONLY that customer's orders (max 10)
// and none of the internal history fields (uploadHistory, smsHistory, ...) — never the full state.json.
//
// Installment status/due-date logic is a deliberate COPY of the dashboard's (see the same sync warning
// in api/dashboard-summary.js): if computeStatus/effectiveStatusOf in index.html change, update there.
const { downloadState } = require('../lib/writeoff-store');
const { keyOk, deny } = require('../lib/key-auth');

const MAX_ORDERS = 10;
const CFG = { screenDays: 3, lockDays: 5 };
const NOT_DUE = ['ยังไม่ถึงกำหนดชำระ', 'ถึงกำหนดชำระ'];
const PAYMENT_CLEARS_OVERRIDE_STATUSES = { 'เปลี่ยนภาพพักหน้าจอ': true };

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;
const customerKey = (o) => String(o.customerId || '').trim() + '||' + String(o.customerName || '').trim();

function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function isDueDateReached(inst) {
  const due = new Date(inst.dueDate);
  if (isNaN(due.getTime())) return false;
  return dayStart(new Date()) >= dayStart(due);
}

function computeStatus(inst) {
  const due = new Date(inst.dueDate);
  const amountDue = num(inst.amountDue), amountPaid = num(inst.amountPaid);
  const netDue = Math.max(0, amountDue - num(inst.discount));
  if (amountDue > 0 && amountPaid >= netDue - 0.01) return 'ชำระแล้ว';
  if (amountPaid > 0) return 'ชำระบางส่วน';
  if (isNaN(due.getTime())) return (inst.noSchedulePlaceholder && amountDue > 0) ? 'ค้างชำระ' : 'ยังไม่ถึงกำหนดชำระ';
  const diffDays = Math.round((dayStart(new Date()) - dayStart(due)) / 86400000);
  if (diffDays < 0) return 'ยังไม่ถึงกำหนดชำระ';
  if (diffDays === 0) return 'ถึงกำหนดชำระ';
  if (diffDays > CFG.lockDays) return 'ล็อคเครื่อง (ระบบ)';
  if (diffDays > CFG.screenDays) return 'เปลี่ยนภาพพักหน้าจอ (ระบบ)';
  return 'เกินกำหนดชำระ';
}

function effectiveStatusOf(i) {
  const last = i.postponeHistory && i.postponeHistory.length ? i.postponeHistory[i.postponeHistory.length - 1] : null;
  const activePostpone = !!(last && last.to === i.dueDate);
  const stale = PAYMENT_CLEARS_OVERRIDE_STATUSES[i.status] && (num(i.amountPaid) > 0 || (activePostpone && isDueDateReached(i)));
  return ((i.statusOverride && !stale) && i.status) ? i.status : computeStatus(i);
}

// remaining per งวด = amountDue − amountPaid − discount + lateFee + unlockFee − penaltyPaid,
// with principal and fee parts floored at 0 separately so an overpayment on one never offsets the other.
function remainingOf(i) {
  const principal = Math.max(0, num(i.amountDue) - num(i.amountPaid) - num(i.discount));
  const fees = Math.max(0, num(i.lateFee) + num(i.unlockFee) - num(i.penaltyPaid));
  return principal + fees;
}

function summarizeOrder(o, state) {
  const insts = (o.installments || []).concat(o.accessoryInstallments || []).map((i) => Object.assign({}, i, { eff: effectiveStatusOf(i) }));
  const closed = !!(o.wasCancelled || o.wasSold || o.wasBillCancelled || insts.some((i) =>
    i.eff === 'ยกเลิกสัญญา คืนเครื่อง' || i.eff === 'จำหน่ายชื่อให้บริษัทติดตามหนี้' || i.eff === 'ยกเลิกบิล'));
  let remainingTotal = 0;
  const arrears = [];
  insts.forEach((i) => {
    const rem = remainingOf(i);
    remainingTotal += rem;
    if (closed || rem <= 0.005) return;
    if (NOT_DUE.indexOf(i.eff) !== -1) return;
    if (!(isDueDateReached(i) || isNaN(new Date(i.dueDate).getTime()))) return;
    arrears.push({
      no: i.no != null ? i.no : (i.installmentNo != null ? i.installmentNo : null),
      dueDate: i.dueDate || '',
      amountDue: num(i.amountDue),
      amountPaid: num(i.amountPaid),
      lateFee: num(i.lateFee),
      unlockFee: num(i.unlockFee),
      remaining: round2(rem)
    });
  });
  return {
    orderId: o.orderId || '',
    productList: [o.productList, o.accessoryProductList].filter(Boolean).join(' / '),
    arrearsInstallments: arrears,
    arrearsTotal: round2(arrears.reduce((s, a) => s + a.remaining, 0)),
    remainingTotal: round2(closed ? 0 : remainingTotal),
    legalAction: !!(state.customerLegalAction && state.customerLegalAction[customerKey(o)])
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  if (!keyOk(req, 'x-debt-key', 'DEBT_SUMMARY_KEY')) { deny(res); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const phone = digits(body.phone);
    const customerId = String(body.customerId || '').trim();
    if (!phone && !customerId) { res.status(200).json({ found: false }); return; }
    // A phone fragment is too loose a key — require a real 9-10 digit number.
    if (!customerId && phone.length < 9) { res.status(200).json({ found: false }); return; }

    const state = await downloadState();
    const matched = (state.orders || []).filter((o) => {
      if (customerId && String(o.customerId || '').trim() === customerId) return true;
      return !!phone && digits(o.phone) === phone;
    });
    if (!matched.length) { res.status(200).json({ found: false }); return; }
    const orders = matched.slice(0, MAX_ORDERS).map((o) => summarizeOrder(o, state));
    res.setHeader('Cache-Control', 'no-store');
    // legalAction is customer-level: expose it at the top too so the assistant escalates immediately.
    res.status(200).json({ found: true, orders: orders });
  } catch (err) {
    res.status(500).json({ error: 'ระบบขัดข้อง' });
  }
};
