// GET /api/dashboard-summary — read-only, NO LOGIN required (same pattern as api/writeoff-view.js).
// Returns just the 6 aggregate KPI numbers the Dashboard's top KPI row shows (ยอดรวมสัญญา/ยอดชำระแล้ว/
// ยอดคงเหลือ/ยอดรวมหนี้ทั้งหมด/ยอดค้างชำระ/ดำเนินคดีทางกฎหมาย) — built for the Lark daily-summary
// routine (see project memory "project_debt_tracker_daily_lark_summary") so it never needs a real
// login or the full ~15-20MB state.json.
//
// IMPORTANT — this is a DELIBERATE, VERBATIM PORT of index.html's computeStatus/effectiveStatusOf/
// computeOrdersUncached/computeDashboard (as of build 2026-08-26, index.html lines ~528, ~1990,
// ~2008, ~2195), NOT a fresh reimplementation. There is no shared module between the browser app and
// server code (same accepted limitation lib/writeoff-store.js's own header already documents) — if
// any of those 4 functions in index.html change (they change often — see project memory), this file
// must be updated to match or the Lark report will silently drift from the real Dashboard numbers.
// Grep index.html for the function names above to re-sync.
const { downloadState } = require('../lib/writeoff-store');

const CFG = { screenDays: 3, lockDays: 5 };
const NOTDUE_STATUSES = ['ยังไม่ถึงกำหนดชำระ', 'ถึงกำหนดชำระ'];
const STATUS_GROUP_META = [
  { label: 'ยังไม่ถึงกำหนดชำระ', statuses: ['ยังไม่ถึงกำหนดชำระ'] },
  { label: 'ถึงกำหนดชำระ', statuses: ['ถึงกำหนดชำระ'] },
  { label: 'ชำระแล้ว', statuses: ['ชำระแล้ว', 'ชำระบางส่วน'] },
  { label: 'ค้างชำระ', statuses: ['ค้างชำระ', 'เกินกำหนดชำระ', 'ล็อคเครื่อง', 'ล็อคเครื่อง (ระบบ)', 'เปลี่ยนภาพพักหน้าจอ', 'เปลี่ยนภาพพักหน้าจอ (ระบบ)', 'ค้างชำระ ล็อคเครื่องไม่ได้'] },
  { label: 'หนี้สงสัยจะสูญ', statuses: ['หนี้สงสัยจะสูญ'] },
  { label: 'จำหน่ายชื่อให้บริษัทติดตามหนี้', statuses: ['จำหน่ายชื่อให้บริษัทติดตามหนี้'] },
  { label: 'ยกเลิกสัญญา คืนเครื่อง', statuses: ['ยกเลิกสัญญา คืนเครื่อง'] },
  { label: 'ยกเลิกบิล', statuses: ['ยกเลิกบิล'] }
];
const STATUS_TO_GROUP = {};
STATUS_GROUP_META.forEach((g) => g.statuses.forEach((s) => { STATUS_TO_GROUP[s] = g.label; }));
const PAYMENT_CLEARS_OVERRIDE_STATUSES = { 'เปลี่ยนภาพพักหน้าจอ': true };

function fmtMoney(n) {
  const v = Number(n || 0);
  if (!isFinite(v)) return '0.00';
  return v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function customerKey(o) {
  return String(o.customerId || '').trim() + '||' + String(o.customerName || '').trim();
}

function isCustomerLegalAction(o, state) {
  return !!(state.customerLegalAction && state.customerLegalAction[customerKey(o)]);
}

function isDueDateReached(inst) {
  const due = new Date(inst.dueDate);
  if (isNaN(due.getTime())) return false;
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dueMid = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return todayMid >= dueMid;
}

function computeStatus(inst) {
  const due = new Date(inst.dueDate);
  const amountDue = Number(inst.amountDue || 0);
  const amountPaid = Number(inst.amountPaid || 0);
  const netDue = Math.max(0, amountDue - Number(inst.discount || 0));
  if (amountDue > 0 && amountPaid >= netDue - 0.01) return 'ชำระแล้ว';
  if (amountPaid > 0) return 'ชำระบางส่วน';
  if (isNaN(due.getTime())) return (inst.noSchedulePlaceholder && amountDue > 0) ? 'ค้างชำระ' : 'ยังไม่ถึงกำหนดชำระ';
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dueMid = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.round((todayMid - dueMid) / 86400000);
  if (diffDays < 0) return 'ยังไม่ถึงกำหนดชำระ';
  if (diffDays === 0) return 'ถึงกำหนดชำระ';
  if (diffDays > CFG.lockDays) return 'ล็อคเครื่อง (ระบบ)';
  if (diffDays > CFG.screenDays) return 'เปลี่ยนภาพพักหน้าจอ (ระบบ)';
  return 'เกินกำหนดชำระ';
}

function effectiveStatusOf(i) {
  const lastPostpone = i.postponeHistory && i.postponeHistory.length ? i.postponeHistory[i.postponeHistory.length - 1] : null;
  const dueDateIsActivePostpone = !!(lastPostpone && lastPostpone.to === i.dueDate);
  const overrideStale = PAYMENT_CLEARS_OVERRIDE_STATUSES[i.status] && (Number(i.amountPaid || 0) > 0 || (dueDateIsActivePostpone && isDueDateReached(i)));
  return ((i.statusOverride && !overrideStale) && i.status) ? i.status : computeStatus(i);
}

function withEffectiveStatus(list) {
  return (list || []).map((i) => Object.assign({}, i, { effectiveStatus: effectiveStatusOf(i) }));
}

function computeOrders(state) {
  return (state.orders || []).map((o) => {
    const installments = withEffectiveStatus(o.installments);
    const accessoryInstallments = withEffectiveStatus(o.accessoryInstallments || []);
    const allInstallments = installments.concat(accessoryInstallments);
    const mainDue = installments.reduce((s, i) => s + Number(i.amountDue || 0), 0);
    const mainPaid = installments.reduce((s, i) => s + Number(i.amountPaid || 0), 0);
    const accDue = accessoryInstallments.reduce((s, i) => s + Number(i.amountDue || 0), 0);
    const accPaid = accessoryInstallments.reduce((s, i) => s + Number(i.amountPaid || 0), 0);
    const sumDiscount = (list) => list.reduce((s, i) => s + Number(i.discount || 0), 0);
    const mainOutstanding = Math.max(0, mainDue - mainPaid - sumDiscount(installments) - (o._discountAppliedToInstallments ? 0 : Number(o.discount || 0)));
    const accOutstanding = Math.max(0, accDue - accPaid - sumDiscount(accessoryInstallments));
    const totalDue = mainDue + accDue;
    const totalPaid = mainPaid + accPaid;
    const isCancelled = !!o.wasCancelled || allInstallments.some((i) => i.effectiveStatus === 'ยกเลิกสัญญา คืนเครื่อง');
    const isSold = !!o.wasSold || allInstallments.some((i) => i.effectiveStatus === 'จำหน่ายชื่อให้บริษัทติดตามหนี้');
    const isBillCancelled = !!o.wasBillCancelled || allInstallments.some((i) => i.effectiveStatus === 'ยกเลิกบิล');
    return Object.assign({}, o, {
      installments, accessoryInstallments,
      totalOutstandingRaw: mainOutstanding + accOutstanding,
      totalPaidFullRaw: Number(o.downPayment || 0) + Number(o.accessoryDownPayment || 0) + totalPaid,
      totalContractRaw: Number(o.downPayment || 0) + Number(o.accessoryDownPayment || 0) + totalDue,
      isCancelled, isSold, isBillCancelled
    });
  });
}

function computeSummary(state) {
  const orders = computeOrders(state);
  const activeOrders = orders.filter((o) => !o.isCancelled && !o.isSold && !o.isBillCancelled);
  const contractOrders = orders.filter((o) => !o.isBillCancelled);
  const legalActionOrders = orders.filter((o) => isCustomerLegalAction(o, state));

  // Re-synced 2026-08-28 to index.html's computeDashboard round-4 rewrite (see that file's big
  // comment on the same identity) — totalContract/paidSum now guarantee reconciliation with the
  // Dashboard donut for ANY data: netDue = max(0, amountDue - discount) (excludes ยอดวางดาวน์
  // entirely); cappedPaid = min(paid, netDue); remaining = max(0, netDue - paid). cappedPaid +
  // remaining = netDue always, so paidSum spans ALL contractOrders (not just active) and reads
  // higher than before; cancelled/sold orders' remaining (not their full gross contract) feeds
  // soldSum below instead of totalContractRaw.
  let paidSum = 0, totalContract = 0, soldRemainingSum = 0;
  contractOrders.forEach((o) => {
    o.installments.concat(o.accessoryInstallments || []).forEach((i) => {
      const due = Number(i.amountDue || 0), paid = Number(i.amountPaid || 0), disc = Number(i.discount || 0);
      const netDue = Math.max(0, due - disc);
      const cappedPaid = Math.min(paid, netDue);
      const remaining = Math.max(0, netDue - paid);
      totalContract += netDue;
      paidSum += cappedPaid;
      if (o.isSold) soldRemainingSum += remaining;
    });
  });
  const netRemaining = Math.max(0, totalContract - paidSum);
  const paidRatePercent = totalContract > 0 ? (paidSum / totalContract * 100) : 0;

  let overdueExLegalSum = 0;
  const overdueExLegalCustomerSet = {};
  activeOrders.forEach((o) => {
    if (isCustomerLegalAction(o, state)) return;
    const ck = customerKey(o);
    o.installments.concat(o.accessoryInstallments || []).forEach((i) => {
      const outstanding = Math.max(0, Number(i.amountDue || 0) - Number(i.amountPaid || 0) - Number(i.discount || 0));
      const grp = STATUS_TO_GROUP[i.effectiveStatus];
      if (grp === 'ค้างชำระ' || grp === 'หนี้สงสัยจะสูญ') { overdueExLegalSum += outstanding; overdueExLegalCustomerSet[ck] = true; }
    });
  });

  const soldSum = soldRemainingSum;
  const legalActionSum = legalActionOrders.reduce((s, o) => s + o.totalOutstandingRaw, 0);
  const totalDebtSum = overdueExLegalSum + soldSum + legalActionSum;

  return {
    asOf: new Date().toISOString(),
    totalContract: { amountRaw: totalContract, amountDisp: fmtMoney(totalContract), count: contractOrders.length },
    paid: { amountRaw: paidSum, amountDisp: fmtMoney(paidSum) },
    netRemaining: { amountRaw: netRemaining, amountDisp: fmtMoney(netRemaining) },
    totalDebt: { amountRaw: totalDebtSum, amountDisp: fmtMoney(totalDebtSum) },
    overdue: { amountRaw: overdueExLegalSum, amountDisp: fmtMoney(overdueExLegalSum), customerCount: Object.keys(overdueExLegalCustomerSet).length },
    legalAction: { amountRaw: legalActionSum, amountDisp: fmtMoney(legalActionSum), count: legalActionOrders.length },
    paidRatePercent: paidRatePercent.toFixed(1)
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const state = await downloadState();
    res.status(200).json(computeSummary(state));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
