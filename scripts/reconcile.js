// เทียบยอดคงเหลือ CRM (api.salmonphone.com) กับระบบติดตามหนี้ (debt-tracker) และแก้ไขเฉพาะรายการ
// ที่มั่นใจว่าถูกต้อง 100% (คำนวณจากประวัติการชำระเงินจริงราย งวด แล้วยอดหลังแก้ตรงกับ CRM ภายใน ฿5)
//
// รันโดย GitHub Actions (.github/workflows/crm-sync.yml) ตามตารางเวลาที่ตั้งไว้ — ต้องตั้ง
// CRM_USERNAME / CRM_PASSWORD เป็น GitHub Actions Secrets ของ repo นี้ก่อน (Settings > Secrets and
// variables > Actions) ห้าม hardcode ค่าจริงไว้ในไฟล์นี้เด็ดขาด

const CRM_BASE = 'https://api.salmonphone.com';
const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZHRmY2dhbmJ1eHpmZW5kZ2ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODc3NzQsImV4cCI6MjA5OTI2Mzc3NH0.eseoVPBdM9fPOh8J8HyqVsBWCIjtG4eTGCRC1scVsTg';
const USERNAME = process.env.CRM_USERNAME;
const PASSWORD = process.env.CRM_PASSWORD;
const CONCURRENCY = 8;
const MY_CLIENT_ID = 'gh-actions-reconcile-' + Date.now();
const STALE_MS = 25000;
const TODAY = new Date().toISOString().slice(0, 10);

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }
function employeeCodeToEmail(code) {
  const slug = String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return 'staff-' + slug + '@debttracker.internal';
}

let crmToken = null;
async function crmLogin() {
  const res = await fetch(CRM_BASE + '/crm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error('CRM login failed: ' + JSON.stringify(data));
  return data.token;
}
async function crmGet(path_, retried) {
  const res = await fetch(CRM_BASE + path_, { headers: { Authorization: 'Bearer ' + crmToken } });
  if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); return crmGet(path_, retried); }
  if (res.status === 401 && !retried) { crmToken = await crmLogin(); return crmGet(path_, true); }
  const data = await res.json().catch(() => null);
  if (!res.ok) return { __httpError: res.status };
  if (data && data.errorCode) return { __crmError: data.errorMessage || data.abbr };
  return data;
}
async function fetchAllPaymentTransactions(soNumber) {
  let all = [];
  for (let page = 1; page <= 15; page++) {
    const r = await crmGet('/crm/sale-order/' + encodeURIComponent(soNumber) + '/payment-transaction?page=' + page);
    if (r.__httpError || r.__crmError) break;
    all = all.concat(r.paymentTransactions || []);
    if (!r.pagination || !r.pagination.hasNextPage) break;
  }
  return all;
}

async function debtTrackerLogin() {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: employeeCodeToEmail(USERNAME), password: PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('debt-tracker login failed: ' + JSON.stringify(data));
  return data.access_token;
}
function restHeaders(token) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' };
}
async function tryAcquireOnce(token) {
  const nowIso = new Date().toISOString();
  const res = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=is.null', {
    method: 'PATCH', headers: restHeaders(token), body: JSON.stringify({ locked_by: MY_CLIENT_ID, locked_at: nowIso }),
  });
  const data = await res.json();
  if (res.ok && Array.isArray(data) && data.length) return true;
  const res2 = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&select=locked_by,locked_at', { headers: restHeaders(token) });
  const rows = await res2.json();
  const row = rows && rows[0];
  if (!row || !row.locked_by || !row.locked_at) return false;
  if (Date.now() - new Date(row.locked_at).getTime() < STALE_MS) return false;
  const res3 = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(row.locked_by), {
    method: 'PATCH', headers: restHeaders(token), body: JSON.stringify({ locked_by: MY_CLIENT_ID, locked_at: nowIso }),
  });
  const data3 = await res3.json();
  return res3.ok && Array.isArray(data3) && data3.length > 0;
}
async function acquireLock(token) {
  const deadline = Date.now() + 33000;
  while (Date.now() < deadline) {
    if (await tryAcquireOnce(token)) return true;
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }
  return false;
}
async function releaseLock(token) {
  await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(MY_CLIENT_ID), {
    method: 'PATCH', headers: restHeaders(token), body: JSON.stringify({ locked_by: null, locked_at: null }),
  }).catch(() => {});
}
async function downloadState(token) {
  const url = SUPABASE_URL + '/storage/v1/object/app-data/state.json?_=' + Date.now();
  const res = await fetch(url, { cache: 'no-store', headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error('download state.json failed: ' + res.status);
  return res.json();
}
async function uploadState(token, stateObj) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/state.json', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': '0' },
    body: JSON.stringify(stateObj),
  });
  if (!res.ok) throw new Error('upload state.json failed: ' + res.status + ' ' + (await res.text()));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); } }
  await Promise.all(new Array(limit).fill(0).map(runner));
  return results;
}
function close(a, b, tol) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= (tol || 0.5); }

(async () => {
  if (!USERNAME || !PASSWORD) { log('ต้องตั้งค่า env CRM_USERNAME / CRM_PASSWORD'); process.exit(1); }

  crmToken = await crmLogin();
  const dtToken = await debtTrackerLogin();
  const state0 = await downloadState(dtToken);
  log('โหลด state.json: ' + state0.orders.length + ' orders');

  const candidates = state0.orders.filter(o => {
    if (o.wasCancelled || o.wasSold) return false;
    if ((o.accessoryInstallments || []).length > 0) return false;
    const insts = o.installments || [];
    const totalPaid = insts.reduce((s, i) => s + (Number(i.amountPaid) || 0), 0);
    const remaining = (Number(o.productPrice || 0) - Number(o.discount || 0)) - (Number(o.downPayment || 0) + totalPaid);
    return Math.abs(remaining) > 0.5; // ต้องเช็คทั้งค้างจ่าย (>0) และเกิน/ผิดปกติ (<0) ไม่ใช่แค่ >0
  });
  log('ออเดอร์ที่ยังมียอดค้าง (จะเช็คกับ CRM): ' + candidates.length);

  const plans = await mapWithConcurrency(candidates, CONCURRENCY, async (order) => {
    const so = await crmGet('/crm/sale-order/' + encodeURIComponent(order.orderId));
    if (so.__httpError || so.__crmError) return { orderId: order.orderId, skip: 'crm_error' };

    const totalDiscount = (so.discounts || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);
    const netPrice = Number(so.productPrice) - totalDiscount;
    const crmRemaining = netPrice - (Number(so.accumulatedAmount) || 0);
    const isClosed = so.status === 'COMPLETED' || Math.abs(crmRemaining) < 1;
    if (isClosed) return { orderId: order.orderId, skip: 'crm_closed' };

    const insts = (order.installments || []).slice().sort((a, b) => (a.no || 0) - (b.no || 0));
    const totalPaidNow = insts.reduce((s, i) => s + (Number(i.amountPaid) || 0), 0);
    const dtRemaining = (Number(order.productPrice || 0) - Number(order.discount || 0)) - (Number(order.downPayment || 0) + totalPaidNow);
    if (close(dtRemaining, crmRemaining, 5)) return { orderId: order.orderId, skip: 'already_matches' };

    const txs = await fetchAllPaymentTransactions(order.orderId);
    const successful = txs.filter(x => x.paymentStatus === 'SUCCESSFUL' && /INSTALLMENT/.test(x.type || '') && Number(x.amount) > 0);
    const firstNumberedIdx = successful.findIndex(x => /^(\d+)\/(\d+)$/.test(String(x.no || '')));

    const perInstallment = {};
    let unassignedTotal = 0;
    successful.forEach((x, i) => {
      const m = /^(\d+)\/(\d+)$/.exec(String(x.no || ''));
      if (!m) {
        if (firstNumberedIdx === -1 || i < firstNumberedIdx) return;
        unassignedTotal += Number(x.amount) || 0;
        return;
      }
      const n = Number(m[1]);
      const entry = perInstallment[n] || { installmentAmt: 0, penaltyAmt: 0, latestDate: null };
      const items = (x.paymentData && x.paymentData.items) || null;
      if (items) items.forEach(it => { if (it.type === 'INSTALLMENT') entry.installmentAmt += Number(it.amount) || 0; else entry.penaltyAmt += Number(it.amount) || 0; });
      else entry.installmentAmt += Number(x.amount) || 0;
      const d = x.paymentDate ? x.paymentDate.slice(0, 10) : null;
      if (d && (!entry.latestDate || d > entry.latestDate)) entry.latestDate = d;
      perInstallment[n] = entry;
    });

    const maxCrmNo = Object.keys(perInstallment).map(Number).reduce((a, b) => Math.max(a, b), 0);
    if (maxCrmNo > insts.length) return { orderId: order.orderId, skip: 'structure_mismatch' };

    const changes = [];
    insts.forEach(inst => {
      const real = perInstallment[inst.no] || { installmentAmt: 0, penaltyAmt: 0, latestDate: null };
      const dueRemaining = Math.max(0, Number(inst.amountDue || 0) - Number(inst.discount || 0));
      let installmentPortion = real.installmentAmt, penaltyPortion = real.penaltyAmt;
      if (installmentPortion > dueRemaining + 0.01) { penaltyPortion += (installmentPortion - dueRemaining); installmentPortion = dueRemaining; }
      const targetAmountPaid = Math.round(installmentPortion * 100) / 100;
      const targetPaidDate = (installmentPortion > 0.005 || penaltyPortion > 0.005) ? real.latestDate : '';
      const targetPenaltyPaid = Math.round(penaltyPortion * 100) / 100;

      const curAmountPaid = Number(inst.amountPaid) || 0;
      const curPaidDate = inst.paidDate || '';
      const curPenaltyPaid = Number(inst.penaltyPaid) || 0;
      if (!close(curAmountPaid, targetAmountPaid, 0.5) || (targetAmountPaid > 0.005 && curPaidDate !== targetPaidDate) || !close(curPenaltyPaid, targetPenaltyPaid, 0.5)) {
        changes.push({
          no: inst.no,
          before: { amountPaid: curAmountPaid, paidDate: curPaidDate, penaltyPaid: curPenaltyPaid },
          after: { amountPaid: targetAmountPaid, paidDate: targetPaidDate, penaltyPaid: targetPenaltyPaid },
        });
      }
    });

    if (unassignedTotal > 1) return { orderId: order.orderId, skip: 'unassigned_transactions' };
    if (!changes.length) return { orderId: order.orderId, skip: 'no_installment_change' };

    const newTotalPaid = insts.reduce((s, inst) => { const ch = changes.find(c => c.no === inst.no); return s + (ch ? ch.after.amountPaid : (Number(inst.amountPaid) || 0)); }, 0);
    const newRemaining = (Number(order.productPrice || 0) - Number(order.discount || 0)) - (Number(order.downPayment || 0) + newTotalPaid);
    const residual = Math.round((newRemaining - crmRemaining) * 100) / 100;

    return { orderId: order.orderId, crmRemaining, residual, residualOk: Math.abs(residual) < 5, changes };
  });

  const ready = plans.filter(p => p.residualOk === true);
  const bySkip = {};
  plans.forEach(p => { if (p.skip) bySkip[p.skip] = (bySkip[p.skip] || 0) + 1; });
  log('เทียบยอดเสร็จ: candidates=' + candidates.length + ' ready=' + ready.length + ' skip=' + JSON.stringify(bySkip));

  if (!ready.length) { log('ไม่มีรายการที่ต้องแก้ไขรอบนี้'); return; }

  log('ขอ lock เพื่อเขียนแก้ไข ' + ready.length + ' orders...');
  const gotLock = await acquireLock(dtToken);
  if (!gotLock) { log('ขอ lock ไม่สำเร็จภายใน 33 วินาที — ข้ามรอบนี้ไปก่อน'); return; }

  let released = false;
  const release = async () => { if (!released) { released = true; await releaseLock(dtToken); } };
  const report = { fixedOrders: 0, fixedInstallments: 0, conflicts: 0, penaltiesApplied: 0 };

  try {
    const state = await downloadState(dtToken);
    const orderById = {};
    state.orders.forEach(o => { orderById[o.orderId] = o; });

    ready.forEach(plan => {
      const order = orderById[plan.orderId];
      if (!order) return;
      let touched = false;
      plan.changes.forEach(ch => {
        const inst = (order.installments || []).find(i => i.no === ch.no);
        if (!inst) return;
        const curAmountPaid = Number(inst.amountPaid) || 0;
        const curPaidDate = inst.paidDate || '';
        const curPenaltyPaid = Number(inst.penaltyPaid) || 0;
        if (!close(curAmountPaid, ch.before.amountPaid, 0.5) || curPaidDate !== (ch.before.paidDate || '') || !close(curPenaltyPaid, ch.before.penaltyPaid, 0.5)) {
          report.conflicts++;
          return;
        }
        inst.amountPaid = ch.after.amountPaid;
        inst.paidDate = ch.after.paidDate;
        if (ch.after.penaltyPaid > 0) {
          inst.penaltyPaid = ch.after.penaltyPaid;
          if (!Number(inst.lateFee) && !Number(inst.unlockFee)) {
            const occurrences = Math.max(1, Math.round(ch.after.penaltyPaid / 500));
            inst.lateFee = 500;
            inst.unlockFee = occurrences >= 2 ? (occurrences - 1) * 500 : 0;
          }
          report.penaltiesApplied++;
        }
        const bits = ['อัพเดทยอด โดย API (เทียบข้อมูลจริงจาก CRM ' + plan.orderId + ', ' + TODAY + ')'];
        bits.push('เดิม ฿' + curAmountPaid + (curPaidDate ? ' (' + curPaidDate + ')' : '') + ' → ฿' + ch.after.amountPaid + (ch.after.paidDate ? ' (' + ch.after.paidDate + ')' : ''));
        if (ch.after.penaltyPaid > 0) bits.push('มีค่าปรับ ฿' + ch.after.penaltyPaid);
        inst.note = bits.join(' | ');
        report.fixedInstallments++;
        touched = true;
      });
      if (touched) report.fixedOrders++;
    });

    await uploadState(dtToken, state);
    log('อัปโหลดสำเร็จ: fixedOrders=' + report.fixedOrders + ' fixedInstallments=' + report.fixedInstallments + ' penalties=' + report.penaltiesApplied + ' conflicts=' + report.conflicts);
  } finally {
    await release();
  }

  console.log('::notice::fixedOrders=' + report.fixedOrders + ' fixedInstallments=' + report.fixedInstallments + ' penalties=' + report.penaltiesApplied + ' conflicts=' + report.conflicts);
})().catch(err => { log('FATAL: ' + err.message + '\n' + err.stack); process.exit(1); });
