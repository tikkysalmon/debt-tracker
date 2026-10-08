// ซิงค์ข้อมูลระบบติดตามหนี้ (debt-tracker) ให้ตรงกับ CRM (api.salmonphone.com) โดยยึดเลข SO เป็นหลัก
// ครอบคลุมทั้งออเดอร์หลัก และตารางอุปกรณ์เสริม (accessoryOrderId): ราคาสินค้า / ส่วนลด / เงินดาวน์ /
// ยอดผ่อนต่องวด / ยอดชำระ+วันที่จ่ายรายงวด / ค่าปรับ — ให้ยอดคงเหลือที่หน้าเว็บแสดง = ยอดคงเหลือใน CRM
//
// โหมด: DRY_RUN=1 (ไม่ขอ lock ไม่เขียน state.json แค่สรุปผล + อัปโหลด reconcile-pending.json)
// รันโดย GitHub Actions (.github/workflows/crm-sync.yml) — ต้องตั้ง CRM_USERNAME / CRM_PASSWORD เป็น Secrets
// ห้าม hardcode ค่าจริงไว้ในไฟล์นี้เด็ดขาด

const CRM_BASE = 'https://api.salmonphone.com';
const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZHRmY2dhbmJ1eHpmZW5kZ2ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODc3NzQsImV4cCI6MjA5OTI2Mzc3NH0.eseoVPBdM9fPOh8J8HyqVsBWCIjtG4eTGCRC1scVsTg';
const USERNAME = process.env.CRM_USERNAME;
const PASSWORD = process.env.CRM_PASSWORD;
const CONCURRENCY = 8;
const DRY_RUN = process.env.DRY_RUN === '1';
const MY_CLIENT_ID = 'gh-actions-reconcile-' + Date.now();
const STALE_MS = 25000;
const TODAY = new Date().toISOString().slice(0, 10);

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }
function nowThaiTimestamp() {
  const th = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return th.getUTCFullYear() + '-' + pad(th.getUTCMonth() + 1) + '-' + pad(th.getUTCDate()) + ' ' +
    pad(th.getUTCHours()) + ':' + pad(th.getUTCMinutes()) + ':' + pad(th.getUTCSeconds());
}
// สั้นกว่า nowThaiTimestamp — ใช้ติดป้ายใกล้ "สถานะชำระเงิน" ของงวด (ไม่ใช่ในช่องหมายเหตุ)
// เฉพาะกรณีเติมยอดที่ยังไม่เคยมีการชำระมาก่อน (ไม่ใช่การแก้ไขยอดที่เคยบันทึกผิดไว้)
function apiUpdateLabel() {
  const th = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return 'API Update ' + pad(th.getUTCDate()) + '/' + pad(th.getUTCMonth() + 1) + '/' + th.getUTCFullYear() + ' ' +
    pad(th.getUTCHours()) + ':' + pad(th.getUTCMinutes());
}
// CRM เก็บ paymentDate เป็น UTC (เช่น 2026-06-15T21:42Z = 16/06/2026 เวลาไทย) — ต้องแปลงเป็นวันที่เวลาไทยก่อน
// ไม่ใช่ตัด 10 ตัวอักษรแรกตรงๆ ไม่งั้นธุรกรรมที่จ่ายหลังเที่ยงคืนเวลาไทยจะเลื่อนไปก่อนวันจริง 1 วัน
function thaiDateOf(iso) {
  return new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
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
// รายการที่ type รวมค่าปรับ (เช่น INSTALLMENT_AND_OVERDUE_FEE) แต่ paymentData เป็น null จาก list endpoint
// ต้องดึงรายละเอียดจริงจาก endpoint นี้แทน — คืน invoiceItems ที่แจกแจงค่าผ่อน/ค่าปรับเหมือนหน้าเว็บ CRM เป๊ะ
// (ยืนยันจากตัวอย่างจริง SO-2026022200079 no.4/5: 11,100 = ค่าผ่อน 10,100 + ค่าปรับชำระล่าช้า 500 +
// ค่าธรรมเนียมระบบ 500 — ทั้งสองอย่างหลังเป็น type "OVERDUE_FEE" เหมือนกัน แค่ name ต่างกัน)
async function fetchTransactionDetail(paymentTransactionId) {
  const r = await crmGet('/crm/payment-transaction/' + paymentTransactionId);
  if (r.__httpError || r.__crmError) return null;
  return r.invoiceItems || null;
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
// state.json is stored gzip-compressed since 2026-10-07 (50 MB per-object limit); sniff magic bytes so plain JSON still works.
const zlib = require('zlib');
async function downloadState(token) {
  const url = SUPABASE_URL + '/storage/v1/object/app-data/state.json?_=' + Date.now();
  const res = await fetch(url, { cache: 'no-store', headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error('download state.json failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return JSON.parse((isGzip ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}
async function uploadState(token, stateObj) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/state.json', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': '0' },
    body: zlib.gzipSync(Buffer.from(JSON.stringify(stateObj), 'utf8')),
  });
  if (!res.ok) throw new Error('upload state.json failed: ' + res.status + ' ' + (await res.text()));
}
// รายงาน read-only (ไม่แก้ state.json/หน้าเว็บใดๆ) — เก็บรายชื่อ SO ที่พบส่วนต่างจริงจาก CRM แต่ residual
// เกิน ฿5 จึงไม่ถูกเขียนอัตโนมัติ (เดิมหายไปเงียบๆ ไม่มี log เลย) เก็บไว้ที่ bucket private เดียวกับ
// state.json (ไม่ commit เข้า repo ซึ่งเป็น public — เลี่ยงการเปิดเผยยอดหนี้ต่อ SO ต่อสาธารณะ)
async function uploadPendingReport(token, reportObj) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/reconcile-pending.json', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': '0' },
    body: JSON.stringify(reportObj),
  });
  if (!res.ok) log('อัปโหลด reconcile-pending.json ไม่สำเร็จ: ' + res.status + ' ' + (await res.text()));
}


// ---------- Pure planning logic (ไม่เรียก network / ไม่แก้ state) ----------
// Pure planning logic: given one track (main device or accessory) + CRM data for its SO,
// compute what the debt-tracker values SHOULD be so that every figure matches CRM.
// No network / no state mutation here, so it can be dry-run against cached CRM data.

const n = x => Number(x) || 0;
const r2 = x => Math.round(x * 100) / 100;
const close = (a, b, tol) => Math.abs(n(a) - n(b)) <= (tol === undefined ? 0.5 : tol);

// same as splitEvenlyRounded in index.html
function splitEvenlyRounded(total, cnt) {
  const per = r2(total / cnt); const out = [];
  for (let i = 0; i < cnt; i++) out.push(i === cnt - 1 ? r2(total - per * (cnt - 1)) : per);
  return out;
}

// trackOf(order, kind) -> normalized view of the fields we read
function trackOf(o, kind) {
  if (kind === 'main') return {
    kind, soId: o.orderId, price: n(o.productPrice), disc: n(o.discount), down: n(o.downPayment),
    flag: !!o._discountAppliedToInstallments, insts: o.installments || [],
  };
  return {
    kind, soId: o.accessoryOrderId, price: n(o.accessoryProductPrice), disc: 0, down: n(o.accessoryDownPayment),
    flag: true, insts: o.accessoryInstallments || [],
  };
}
// remaining exactly as the web app shows it (computeOrdersUncached), but unclamped so overpay is visible
function appRemaining(t) {
  const due = t.insts.reduce((s, i) => s + n(i.amountDue) - n(i.discount), 0);
  const paid = t.insts.reduce((s, i) => s + n(i.amountPaid), 0);
  return r2(due - paid - (t.flag ? 0 : t.disc));
}

// crm = { so, txs, complete }, details = { [paymentTransactionId]: invoiceItems[] }
function planTrack(t, crm, details) {
  const s = crm && crm.so;
  if (!s || s.__http || s.__crm) return { skip: 'crm_error' };
  if (s.status === 'CANCELLED') return { skip: 'crm_cancelled' };
  const crmDisc = (s.discounts || []).reduce((a, d) => a + n(d.amount), 0);
  const accum = n(s.accumulatedAmount);
  const crmRem = r2(n(s.productPrice) - crmDisc - accum);
  const isClosed = s.status === 'COMPLETED' || Math.abs(crmRem) < 1;

  // CRM targets for the order-level fields (accessory has no discount field -> fold into price)
  const newPrice = t.kind === 'main' ? n(s.productPrice) : r2(n(s.productPrice) - crmDisc);
  const newDisc = t.kind === 'main' ? r2(crmDisc) : 0;

  // fast path: nothing differs at all -> no need to pull payment history
  const quickOk = close(appRemaining(t), crmRem, 0.5) && close(t.price, newPrice) && close(t.disc, newDisc) &&
    (t.kind !== 'main' || t.flag || newDisc === 0);
  if (quickOk && !crm.forceFull) return { skip: 'already_matches', crmRem };

  if (!crm.complete) return { skip: 'crm_tx_incomplete' };
  const insts = t.insts.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
  if (!insts.length) return { skip: 'no_installments' };

  // successful installment money, in order; split installment part vs fee part
  const ok = crm.txs.filter(x => x.paymentStatus === 'SUCCESSFUL' && /INSTALLMENT|FEE/.test(x.type || '') && n(x.amount) > 0);
  const firstNum = ok.findIndex(x => /^(\d+)\/(\d+)$/.test(String(x.no || '')));
  const txList = [];
  let numberedTotal = 0;
  for (let i = firstNum === -1 ? ok.length : firstNum; i < ok.length; i++) {
    const x = ok[i];
    let items = (x.paymentData && x.paymentData.items) || (x.paymentTransactionId && details[x.paymentTransactionId]) || null;
    let instAmt = 0, pen = 0;
    if (items) items.forEach(it => { if (it.type === 'INSTALLMENT') instAmt += n(it.amount); else pen += n(it.amount); });
    else if (/FEE/.test(x.type)) { pen = n(x.amount); } else instAmt = n(x.amount);
    numberedTotal += instAmt;
    txList.push({ instAmt, pen, date: x.paymentDate ? thaiDateOf(x.paymentDate) : null });
  }
  // down payment = whatever CRM counted that is not a numbered installment (pre-"N/M" payments)
  const newDown = r2(accum - numberedTotal);
  if (newDown < -0.5) return { skip: 'review', reason: 'negative_down', newDown };

  const dues = splitEvenlyRounded(Math.max(0, newPrice - newDisc - newDown), insts.length);
  const sim = insts.map((inst, i) => ({ due: dues[i], paid: 0, pen: 0, date: null }));
  let cur = 0;
  txList.forEach(tx => {
    let amt = tx.instAmt;
    while (cur < sim.length && sim[cur].due > 0 && sim[cur].paid >= sim[cur].due - 0.005) cur++;
    const primary = cur < sim.length ? cur : sim.length - 1;
    while (amt > 0.005 && cur < sim.length) {
      const sl = sim[cur]; const room = Math.max(0, sl.due - sl.paid);
      if (room <= 0.005) { cur++; continue; }
      const take = Math.min(amt, room); sl.paid += take; if (tx.date) sl.date = tx.date; amt -= take;
      if (sl.paid >= sl.due - 0.005) cur++;
    }
    if (amt > 0.005) { const last = sim[sim.length - 1]; last.paid += amt; if (tx.date) last.date = tx.date; } // overpay shown on last slot
    if (tx.pen > 0) { sim[primary].pen += tx.pen; if (tx.date && !sim[primary].date) sim[primary].date = tx.date; }
  });

  // build the new track and verify it reproduces CRM's remaining under the app's own formula
  const flagNew = t.kind === 'main' ? true : t.flag;
  const newInsts = insts.map((inst, i) => ({
    no: inst.no, amountDue: sim[i].due, amountPaid: r2(sim[i].paid), penaltyPaid: r2(sim[i].pen),
    paidDate: (sim[i].paid > 0.005 || sim[i].pen > 0.005) ? (sim[i].date || '') : '',
  }));
  const check = appRemaining({ insts: newInsts.map(x => ({ amountDue: x.amountDue, amountPaid: x.amountPaid, discount: 0 })), flag: flagNew, disc: newDisc });
  // per-installment manual discounts are cleared by the even split, so verify without them
  if (!close(check, crmRem, 1)) return { skip: 'review', reason: 'verify_failed', check, crmRem };

  const changes = [];
  insts.forEach((inst, i) => {
    const a = newInsts[i];
    const dueDiff = !close(inst.amountDue, a.amountDue) || n(inst.discount) !== 0;
    const paidDiff = !close(inst.amountPaid, a.amountPaid);
    const penDiff = !close(inst.penaltyPaid, a.penaltyPaid);
    const dateDiff = a.amountPaid > 0.005 && (inst.paidDate || '') !== a.paidDate;
    const clearDate = a.amountPaid <= 0.005 && a.penaltyPaid <= 0.005 && (inst.paidDate || '') !== '';
    if (dueDiff || paidDiff || penDiff || dateDiff || clearDate) changes.push({ idx: i, no: inst.no, before: { amountDue: n(inst.amountDue), amountPaid: n(inst.amountPaid), paidDate: inst.paidDate || '', penaltyPaid: n(inst.penaltyPaid), discount: n(inst.discount) }, after: a });
  });
  const orderChange = !close(t.price, newPrice) || !close(t.disc, newDisc) || !close(t.down, newDown) || (t.kind === 'main' && !t.flag);
  if (!changes.length && !orderChange) return { skip: 'already_matches', crmRem };

  const paidChanges = changes.some(c => !close(c.before.amountPaid, c.after.amountPaid) || !close(c.before.penaltyPaid, c.after.penaltyPaid));
  return {
    soId: t.soId, kind: t.kind, crmRem, isClosed,
    order: { before: { price: t.price, disc: t.disc, down: t.down, flag: t.flag }, after: { price: newPrice, disc: newDisc, down: newDown, flag: flagNew }, changed: orderChange },
    changes, paidChanges,
    bucket: (isClosed ? 'closed' : 'open') + (paidChanges ? '' : '_fieldsOnly'),
  };
}



// ---------- CRM fetch helpers ----------
// complete=false ถ้าดึงประวัติชำระไม่ครบ (error กลางทาง หรือเกิน 40 หน้า) — ห้ามเดาแล้วเขียนจากข้อมูลไม่ครบ
async function fetchPaymentTransactions(soNumber) {
  let all = [];
  for (let page = 1; page <= 40; page++) {
    const r = await crmGet('/crm/sale-order/' + encodeURIComponent(soNumber) + '/payment-transaction?page=' + page);
    if (r.__httpError || r.__crmError) return { txs: all, complete: false };
    all = all.concat(r.paymentTransactions || []);
    if (!r.pagination || !r.pagination.hasNextPage) return { txs: all, complete: true };
  }
  return { txs: all, complete: false };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function runner() { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); } }
  await Promise.all(new Array(limit).fill(0).map(runner));
  return results;
}

// ---------- สร้างตารางผ่อนอุปกรณ์เสริมที่ยังไม่มีในระบบ (เฉพาะ SO ที่ผู้ใช้ยืนยันแล้ว: ออเดอร์หลัก -> SO อุปกรณ์เสริมใน CRM) ----------
const ACCESSORY_ALLOWLIST = {
  'SO-2026021500150': 'SO-2026021500151', 'SO-2026031500113': 'SO-2026031500115', 'SO-2026032700115': 'SO-2026032700117',
  'SO-2026032700069': 'SO-2026032700071', 'SO-2026012600125': 'SO-2026012600127', 'SO-2026033100118': 'SO-2026033100119',
  'SO-2026040100031': 'SO-2026040100032', 'SO-2026040100016': 'SO-2026040100017', 'SO-2026040100097': 'SO-2026040100098',
  'SO-2026050200192': 'SO-2026050200193', 'SO-2026050400005': 'SO-2026050400006', 'SO-2026050300002': 'SO-2026050300004',
  'SO-2026050100053': 'SO-2026050100054',
};
function isTrackerCancelled(o) {
  if (o.wasCancelled || o.wasSold) return true;
  return (o.installments || []).concat(o.accessoryInstallments || []).some(i => i.status === 'ยกเลิกสัญญา คืนเครื่อง');
}
function dueDateOf(first, payDay, i) {
  const m0 = Number(first.slice(5, 7)) - 1 + i, y = Number(first.slice(0, 4)) + Math.floor(m0 / 12), m = ((m0 % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(Number(payDay) || Number(first.slice(8, 10)), last);
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}
// spec = { soId, name, price, down, count } — คำนวณจาก CRM; ยอดชำระ/วันที่จ่ายจะถูกเติมโดย planTrack ตามปกติ
function buildAccessoryTrack(order, spec) {
  if ((order.accessoryInstallments || []).length) return false;
  const first = order.firstDueDate;
  if (!first) return false;
  const due = splitEvenlyRounded(Math.max(0, spec.price - spec.down), spec.count);
  order.accessoryOrderId = spec.soId;
  order.accessoryProductList = spec.name;
  order.accessoryProductPrice = spec.price;
  order.accessoryDownPayment = spec.down;
  order.accessoryFirstDueDate = first;
  order.accessoryPayDay = order.payDay || Number(first.slice(8, 10));
  order.accessoryInstallments = due.map((d, i) => ({
    no: i + 1, dueDate: dueDateOf(first, order.payDay, i), amountDue: d, amountPaid: 0, paidDate: '', status: '', statusOverride: false,
    discount: 0, note: i === 0 ? 'สร้างตารางผ่อนอุปกรณ์เสริมจาก CRM ' + spec.soId + ' (' + TODAY + ')' : '', smsHistory: [],
  }));
  return true;
}
// จำนวนงวดตามสัญญา = ตัวส่วนของป้าย "N/M" ในธุรกรรมจริง (installmentCount ของ CRM นับเป็นช่วงอื่น ไม่ใช่จำนวนงวดที่ใช้ตารางนี้)
async function accessorySpecFor(soId) {
  const so = await crmGet('/crm/sale-order/' + encodeURIComponent(soId));
  if (so.__httpError || so.__crmError || so.status === 'CANCELLED' || so.status === 'COMPLETED') return null;
  const r = await fetchPaymentTransactions(soId);
  let count = 0;
  r.txs.forEach(x => { const mm = /^(\d+)\/(\d+)$/.exec(String(x.no || '')); if (mm) count = Math.max(count, Number(mm[2])); });
  if (!r.complete || !count) return null;
  return { soId, name: so.productName, price: Number(so.productPrice), down: Number(so.initAmount) || 0, count };
}

// ---------- plan every track (main + accessory) ----------
async function planOne(order, kind) {
  const t = trackOf(order, kind);
  const so = await crmGet('/crm/sale-order/' + encodeURIComponent(t.soId));
  const crm = { so, txs: [], complete: true };
  const details = {};
  // ดูก่อนว่าต้องดึงประวัติชำระไหม (planTrack ตัดสินเองจาก fast-path) — ถ้าไม่ตรงค่อยดึง
  let p = planTrack(t, crm, details);
  if (p.skip !== 'already_matches' && p.skip !== 'crm_error' && p.skip !== 'crm_cancelled') {
    const r = await fetchPaymentTransactions(t.soId);
    crm.txs = r.txs; crm.complete = r.complete;
    for (const x of r.txs) {
      if (x.paymentStatus === 'SUCCESSFUL' && /FEE/.test(x.type || '') && !(x.paymentData && x.paymentData.items) && x.paymentTransactionId) {
        details[x.paymentTransactionId] = await fetchTransactionDetail(x.paymentTransactionId);
      }
    }
    p = planTrack(t, crm, details);
  }
  return Object.assign({ orderId: order.orderId, kind, soId: t.soId }, p);
}

// ---------- apply one plan onto the live order object; returns false on conflict ----------
function applyPlan(order, plan, report) {
  const kind = plan.kind;
  const t = trackOf(order, kind);
  // conflict guard: ค่าปัจจุบันต้องตรงกับตอนคำนวณแผน ไม่งั้นแปลว่ามีคนแก้สด -> ข้ามทั้ง track
  const ob = plan.order.before;
  if (!close(t.price, ob.price) || !close(t.disc, ob.disc) || !close(t.down, ob.down) || t.flag !== ob.flag) return false;
  const insts = (kind === 'main' ? order.installments : order.accessoryInstallments) || [];
  const sorted = insts.slice().sort((a, b) => (a.no || 0) - (b.no || 0));
  for (const ch of plan.changes) {
    const inst = sorted[ch.idx];
    if (!inst || inst.no !== ch.no) return false;
    if (!close(inst.amountDue, ch.before.amountDue) || !close(inst.amountPaid, ch.before.amountPaid) || (inst.paidDate || '') !== ch.before.paidDate ||
        !close(inst.penaltyPaid, ch.before.penaltyPaid) || !close(inst.discount, ch.before.discount)) return false;
  }

  const stamp = nowThaiTimestamp();
  const oa = plan.order.after;
  const orderBits = [];
  if (!close(ob.price, oa.price)) orderBits.push('ราคา ฿' + ob.price + ' → ฿' + oa.price);
  if (!close(ob.disc, oa.disc)) orderBits.push('ส่วนลด ฿' + ob.disc + ' → ฿' + oa.disc);
  if (!close(ob.down, oa.down)) orderBits.push('ดาวน์ ฿' + ob.down + ' → ฿' + oa.down);
  if (kind === 'main') {
    order.productPrice = oa.price; order.discount = oa.disc; order.downPayment = oa.down; order._discountAppliedToInstallments = true;
  } else {
    order.accessoryProductPrice = oa.price; order.accessoryDownPayment = oa.down;
  }

  let firstNoteInst = null;
  plan.changes.forEach(ch => {
    const inst = sorted[ch.idx];
    const a = ch.after, b = ch.before;
    const wasFresh = b.amountPaid <= 0.005 && b.penaltyPaid <= 0.005;
    inst.amountDue = a.amountDue;
    inst.amountPaid = a.amountPaid;
    inst.paidDate = a.paidDate;
    if (b.discount) inst.discount = 0;
    if (a.penaltyPaid > 0) {
      inst.penaltyPaid = a.penaltyPaid;
      if (!Number(inst.lateFee) && !Number(inst.unlockFee)) {
        const occurrences = Math.max(1, Math.round(a.penaltyPaid / 500));
        inst.lateFee = 500;
        inst.unlockFee = occurrences >= 2 ? (occurrences - 1) * 500 : 0;
      }
      report.penaltiesApplied++;
    } else if (b.penaltyPaid > 0) inst.penaltyPaid = 0;
    const paidChanged = !close(b.amountPaid, a.amountPaid) || !close(b.penaltyPaid, a.penaltyPaid) || (a.amountPaid > 0.005 && b.paidDate !== a.paidDate);
    const dueChanged = !close(b.amountDue, a.amountDue) || b.discount !== 0;
    if (paidChanged && wasFresh) {
      inst.apiUpdateHistory = (inst.apiUpdateHistory || []).concat([apiUpdateLabel()]);
    } else if (paidChanged || dueChanged) {
      const bits = ['แก้ไขจาก API (เทียบข้อมูลจริงจาก CRM ' + plan.soId + ', ' + TODAY + ')'];
      if (paidChanged) bits.push('เดิม ฿' + b.amountPaid + (b.paidDate ? ' (' + b.paidDate + ')' : '') + ' → ฿' + a.amountPaid + (a.paidDate ? ' (' + a.paidDate + ')' : ''));
      if (dueChanged) bits.push('ยอดผ่อนต่องวดเดิม ฿' + b.amountDue + (b.discount ? ' ส่วนลดรายงวดเดิม ฿' + b.discount : '') + ' → ฿' + a.amountDue);
      if (a.penaltyPaid > 0) bits.push('มีค่าปรับ ฿' + a.penaltyPaid);
      bits.push('ระบบแก้ไขเมื่อ ' + stamp + ' น.');
      inst.note = (inst.note ? inst.note + '\n' : '') + bits.join(' | ');
    }
    if (!firstNoteInst) firstNoteInst = inst;
    report.fixedInstallments++;
  });
  if (orderBits.length) {
    const target = firstNoteInst || sorted[0];
    if (target) target.note = (target.note ? target.note + '\n' : '') +
      'แก้ไขจาก API (เทียบข้อมูลจริงจาก CRM ' + plan.soId + ', ' + TODAY + ') | ' + orderBits.join(', ') + ' | ระบบแก้ไขเมื่อ ' + stamp + ' น.';
  }
  return true;
}

// ---------- main ----------
if (require.main === module) (async () => {
  if (!USERNAME || !PASSWORD) { log('ต้องตั้งค่า env CRM_USERNAME / CRM_PASSWORD'); process.exit(1); }

  crmToken = await crmLogin();
  const dtToken = process.env.LOCAL_STATE ? null : await debtTrackerLogin();
  const state0 = process.env.LOCAL_STATE ? JSON.parse(require('fs').readFileSync(process.env.LOCAL_STATE, 'utf8')) : await downloadState(dtToken);
  log('โหลด state.json: ' + state0.orders.length + ' orders' + (DRY_RUN ? ' [DRY RUN]' : ''));

  const jobs = [];
  const bySkip = {};
  const skip = k => { bySkip[k] = (bySkip[k] || 0) + 1; };
  const accessorySpecs = {};
  for (const o of state0.orders) {
    if (isTrackerCancelled(o)) { skip('tracker_cancelled_or_sold'); continue; } // สถานะที่พนักงานตั้งเอง (รวม ยกเลิกสัญญา คืนเครื่อง) ไม่แตะ
    const accSo = ACCESSORY_ALLOWLIST[o.orderId];
    if (accSo && !(o.accessoryInstallments || []).length) {
      const spec = await accessorySpecFor(accSo);
      if (spec && buildAccessoryTrack(o, spec)) { accessorySpecs[o.orderId] = spec; skip('accessory_track_created_in_plan'); }
      else skip('accessory_track_unavailable');
    }
    jobs.push({ order: o, kind: 'main' });
    if (o.accessoryOrderId && (o.accessoryInstallments || []).length) jobs.push({ order: o, kind: 'acc' });
  }
  log('SO ที่จะเทียบกับ CRM: ' + jobs.length);

  const plans = await mapWithConcurrency(jobs, CONCURRENCY, j => planOne(j.order, j.kind));
  const ready = plans.filter(p => !p.skip);
  const review = plans.filter(p => p.skip === 'review' || p.skip === 'crm_tx_incomplete' || p.skip === 'crm_error' || p.skip === 'no_installments');
  const cancelledInCrm = plans.filter(p => p.skip === 'crm_cancelled');
  plans.forEach(p => { if (p.skip) skip(p.skip + (p.reason ? ':' + p.reason : '')); });
  const byBucket = {};
  ready.forEach(p => { byBucket[p.bucket] = (byBucket[p.bucket] || 0) + 1; });
  log('เทียบยอดเสร็จ: tracks=' + jobs.length + ' ready=' + ready.length + ' buckets=' + JSON.stringify(byBucket) + ' skip=' + JSON.stringify(bySkip));

  await uploadPendingReport(dtToken, {
    generatedAt: new Date().toISOString(), dryRun: DRY_RUN, tracks: jobs.length, ready: ready.length, buckets: byBucket, skip: bySkip,
    review: review.map(p => ({ orderId: p.orderId, soId: p.soId, kind: p.kind, reason: p.skip + (p.reason ? ':' + p.reason : '') })),
    cancelledInCrm: cancelledInCrm.map(p => ({ orderId: p.orderId, soId: p.soId, kind: p.kind })),
    items: ready.map(p => ({ orderId: p.orderId, soId: p.soId, kind: p.kind, bucket: p.bucket, crmRemaining: p.crmRem, order: p.order.after, changedInstallments: p.changes.length })),
  });

  if (DRY_RUN) { log('DRY RUN — ไม่เขียนข้อมูล'); return; }
  if (!ready.length) { log('ไม่มีรายการที่ต้องแก้ไขรอบนี้'); return; }

  log('ขอ lock เพื่อเขียนแก้ไข ' + ready.length + ' tracks...');
  const gotLock = await acquireLock(dtToken);
  if (!gotLock) { log('ขอ lock ไม่สำเร็จภายใน 33 วินาที — ข้ามรอบนี้ไปก่อน'); return; }

  let released = false;
  const release = async () => { if (!released) { released = true; await releaseLock(dtToken); } };
  const report = { fixedOrders: 0, fixedInstallments: 0, conflicts: 0, penaltiesApplied: 0 };
  try {
    const state = await downloadState(dtToken);
    const orderById = {};
    state.orders.forEach(o => { orderById[o.orderId] = o; });
    const touchedOrders = new Set();
    ready.forEach(plan => {
      const order = orderById[plan.orderId];
      if (!order) return;
      if (plan.kind === 'acc' && accessorySpecs[plan.orderId] && !buildAccessoryTrack(order, accessorySpecs[plan.orderId]) && !(order.accessoryInstallments || []).length) { report.conflicts++; return; }
      if (applyPlan(order, plan, report)) touchedOrders.add(plan.orderId); else report.conflicts++;
    });
    report.fixedOrders = touchedOrders.size;
    await uploadState(dtToken, state);
    log('อัปโหลดสำเร็จ: fixedOrders=' + report.fixedOrders + ' fixedInstallments=' + report.fixedInstallments + ' penalties=' + report.penaltiesApplied + ' conflicts=' + report.conflicts);
  } finally {
    await release();
  }
  console.log('::notice::fixedOrders=' + report.fixedOrders + ' fixedInstallments=' + report.fixedInstallments + ' penalties=' + report.penaltiesApplied + ' conflicts=' + report.conflicts);
})().catch(err => { log('FATAL: ' + err.message + '\n' + err.stack); process.exit(1); });

module.exports = { planTrack, trackOf, applyPlan };
module.exports.buildAccessoryTrack = buildAccessoryTrack;
module.exports.appRemaining = appRemaining;
