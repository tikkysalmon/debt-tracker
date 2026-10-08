// นำเข้าลูกหนี้ใหม่ (ทำสัญญาในช่วงวันที่กำหนด) เข้าระบบติดตามหนี้ โดยไม่ต้องอัปโหลดไฟล์
//   1) ดึงรายชื่อจาก Lark Base "ลูกหนี้การทำสัญญา" เฉพาะ *สถานะการทำสัญญา = "5.แจ้งเลข EMIE แล้ว"
//   2) ข้อมูลลูกค้า (ชื่อ/รหัส/เบอร์/อายุ/อีเมล/เลขที่สัญญา/วันครบกำหนดงวดแรก) มาจาก Lark
//   3) รายการสินค้า/ราคา/ส่วนลด/ยอดผ่อนต่องวด/จำนวนงวด/ยอดดาวน์/การชำระที่ผ่านมา มาจาก CRM
//   4) ตรวจว่ายอดคงเหลือในระบบติดตามหนี้ = ยอดคงเหลือ CRM (ภายใน ฿0.5) — ไม่ตรง = ไม่เขียน แต่รายงาน
//
// ความปลอดภัยของข้อมูล: สคริปต์นี้ "เพิ่มอย่างเดียว" ไม่เคยลบ/แก้ออเดอร์ที่มีอยู่แล้ว — ออเดอร์ที่นำเข้าไปแล้ว
// จะคงอยู่ในระบบแม้สถานะใน Lark จะเปลี่ยนจาก "5." ไปเป็นสถานะอื่นภายหลัง (SO ที่มีในระบบแล้วถูกข้ามทั้งหมด)
// ออเดอร์ที่นำเข้าจะมี importedFrom='lark-contract-import' เพื่อแสดงป้าย "🤖 AI นำเข้า" ให้ staff ตรวจสอบ
//
// ENV: CRM_USERNAME CRM_PASSWORD LARK_APP_ID LARK_APP_SECRET
//      PURCHASE_TYPE (เช่น 'วางดาวน์ เครื่อง' — เว้นว่าง = ทุกประเภท)  DATE_FROM (2026-08-01) DATE_TO (2026-09-30)  ONLY_SO (คั่นด้วย ,)  LIMIT  DRY_RUN (ค่าเริ่มต้น true)
// ห้าม hardcode รหัสผ่านจริง — ตั้งเป็น GitHub Actions Secrets เท่านั้น

const zlib = require('zlib');
const CRM_BASE = 'https://api.salmonphone.com';
const LARK_BASE = 'https://open.larksuite.com';
const LARK_APP_TOKEN = 'H8n6bxctqaYgxCsQkvhlJa8mglc';
const LARK_TABLE_ID = 'tblYou0JZxVSzBYx';
const LARK_STATUS_FIELD = '*สถานะการทำสัญญา';
const LARK_STATUS_VALUE = '5.แจ้งเลข EMIE แล้ว';
const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZHRmY2dhbmJ1eHpmZW5kZ2ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODc3NzQsImV4cCI6MjA5OTI2Mzc3NH0.eseoVPBdM9fPOh8J8HyqVsBWCIjtG4eTGCRC1scVsTg';
const STALE_MS = 25000;
const CONCURRENCY = 6;
const MY_CLIENT_ID = 'gh-actions-import-contracts-' + Date.now();

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function thaiDateOf(msOrIso) { return new Date(new Date(msOrIso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10); }

// ---------- Lark field helpers (รองรับทั้งรูปแบบ raw API และ MCP) ----------
function larkText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(larkText).join('');
  if (typeof v === 'object') {
    if (v.text != null) return String(v.text);
    if (v.value != null) return larkText(v.value);
  }
  return '';
}
function larkNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return larkNumber(v[0]);
  if (typeof v === 'object' && v.value != null) return larkNumber(v.value);
  const n = Number(larkText(v)); return isFinite(n) ? n : 0;
}
function larkDateMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (Array.isArray(v)) return larkDateMs(v[0]);
  if (typeof v === 'object' && v.value != null) return larkDateMs(v.value);
  return null;
}

// ---------- วันครบกำหนด (เหมือน recalcDueDate ใน index.html) ----------
function recalcDueDate(firstDue, offset, payDay) {
  const p = firstDue.split('-').map(Number);
  const t = new Date(p[0], p[1] - 1 + offset, 1);
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  const dd = Math.min(payDay > 0 ? payDay : p[2], lastDay);
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
}
// แบ่งยอดเป็นงวดละเท่าๆ กัน ปัดสตางค์ แล้วโยนเศษไปงวดสุดท้าย (เหมือน splitEvenlyRounded)
function splitEvenlyRounded(total, n) {
  const each = Math.round((total / n) * 100) / 100;
  const out = new Array(n).fill(each);
  out[n - 1] = round2(total - each * (n - 1));
  return out;
}

// ---------- แปลงแถว Lark -> ข้อมูลลูกค้า ----------
function parseLarkRow(fields) {
  const f = fields || {};
  const email = (f['อีเมล์'] && (Array.isArray(f['อีเมล์']) ? (f['อีเมล์'][0] || {}).text : larkText(f['อีเมล์']))) || '';
  const firstMs = larkDateMs(f['วันที่เริ่มส่งยอด']) || larkDateMs(f['งวดที่ 1']);
  const dates = [];
  for (let k = 1; k <= 24; k++) { const d = larkDateMs(f['งวดที่ ' + k]); if (d) dates.push(thaiDateOf(d)); }
  return {
    soNumber: larkText(f['เลข SO']).trim(),
    customerId: larkText(f['รหัสลูกค้า']).trim(),
    customerName: larkText(f['ชื่อ-นามสกุลลูกค้า']).trim(),
    phone: larkText(f['เบอร์ติดต่อ']).trim(),
    email: String(email).trim(),
    age: Math.round(larkNumber(f['อายุลูกค้า'])) || 0,
    purchaseType: larkText(f['ประเภทการซื้อ']).trim(),
    contractNo: larkText(f['เลขที่สัญญา']).trim(),
    contractDate: larkDateMs(f['วันที่ที่ออกสัญญา']) ? thaiDateOf(larkDateMs(f['วันที่ที่ออกสัญญา'])) : '',
    firstDueDate: firstMs ? thaiDateOf(firstMs) : '',
    payDay: Math.round(larkNumber(f['*ชำระทุกวันที่'])) || null,
    larkDueDates: dates,
    referenceName: larkText(f['ชื่อบุคคลที่ติดต่อได้คนที่หนึ่ง']).trim(),
    referencePhone: larkText(f['เบอร์ติดต่อบุคคลอ้างอิงที่1']).trim(),
  };
}

// ---------- สร้าง order จาก Lark + CRM (pure function — ทดสอบแยกได้) ----------
// คืน { order } หรือ { skip: 'เหตุผล' }
function buildOrder(lark, so, txs) {
  if (!so || !so.saleOrderId) return { skip: 'crm_not_found' };
  if (so.installmentType === 'FULL_PAYMENT') return { skip: 'full_payment' };
  // ดาวน์+อุปกรณ์เสริม มีตารางงวดของอุปกรณ์เสริมอีกชุด (accessoryInstallments) ซึ่งสคริปต์นี้ยังไม่สร้าง
  if (/อุปกรณ์เสริม/.test(lark.purchaseType || '')) return { skip: 'accessory_bundle_not_supported_yet' };
  const price = Number(so.productPrice) || 0;
  const discount = round2((so.discounts || []).reduce((s, d) => s + (Number(d.amount) || 0), 0));
  // ส่วนลดจาก CRM (เช่น "โปร100ลด1,000") ใส่ในช่อง ส่วนลด ของออเดอร์ และหักออกก่อนแบ่งงวด
  // (ราคา − ส่วนลด − ยอดวางดาวน์) ÷ จำนวนงวด — เหมือนที่ updateOrderField ในหน้าเว็บทำ
  const ok = (txs || []).filter(x => x.paymentStatus === 'SUCCESSFUL' && Number(x.amount) !== 0);
  // งวดที่นับเป็น "ผ่อนจริง" = มีเลข no "X/Y"; รายการ INSTALLMENT ที่ no=null ก่อนนั้น = ยอดวางดาวน์
  const numbered = ok.filter(x => /^\d+\/\d+$/.test(String(x.no || '')));
  const preCredit = ok.filter(x => !/^\d+\/\d+$/.test(String(x.no || '')));
  if (preCredit.some(x => x.type !== 'INSTALLMENT')) return { skip: 'has_fee_transactions_needs_review' };
  const downPayment = round2(preCredit.reduce((s, x) => s + Number(x.amount), 0));
  if (numbered.some(x => x.type !== 'INSTALLMENT')) return { skip: 'has_fee_in_installments_needs_review' };
  const paidNos = new Set(numbered.map(x => String(x.no)));
  const totalFromNo = numbered.length ? Math.max.apply(null, numbered.map(x => Number(String(x.no).split('/')[1]))) : 0;
  const term = totalFromNo || ((Number(so.installmentCount) || 0) + paidNos.size);
  if (!term) return { skip: 'no_term' };
  if (!lark.firstDueDate || !lark.payDay) return { skip: 'lark_missing_first_due_or_payday' };

  const amounts = splitEvenlyRounded(round2(price - discount - downPayment), term);
  const installments = amounts.map((amt, i) => ({
    no: i + 1,
    dueDate: recalcDueDate(lark.firstDueDate, i, lark.payDay),
    amountDue: amt, amountPaid: 0, paidDate: '', status: '', statusOverride: false, discount: 0, note: '',
  }));
  // เติมยอดที่ชำระจริงตามลำดับเวลาแบบ FIFO (หลักเดียวกับ reconcile.js)
  numbered.slice().sort((a, b) => new Date(a.paymentDate) - new Date(b.paymentDate)).forEach(tx => {
    let amt = Number(tx.amount); const date = tx.paymentDate ? thaiDateOf(tx.paymentDate) : '';
    for (let i = 0; i < installments.length && amt > 0.005; i++) {
      const it = installments[i];
      const room = round2(it.amountDue - it.amountPaid);
      if (room <= 0.005) continue;
      const take = Math.min(amt, room);
      it.amountPaid = round2(it.amountPaid + take); it.paidDate = date; amt = round2(amt - take);
    }
    if (amt > 0.005) { const last = installments[installments.length - 1]; last.amountPaid = round2(last.amountPaid + amt); last.paidDate = date; }
  });

  const order = {
    customerId: lark.customerId || so.customerId || '',
    customerName: lark.customerName || ((so.customerFirstName || '') + ' ' + (so.customerLastName || '')).trim(),
    orderId: so.saleOrderId, soUnknown: false,
    contractDate: lark.contractDate,
    productList: so.productName || '',
    downPayment, productPrice: price, discount,
    purchaseType: lark.purchaseType || (so.installmentType === 'DOWN_PAYMENT' ? 'วางดาวน์ เครื่อง' : 'ผ่อน เครื่อง'),
    age: lark.age, phone: lark.phone, email: lark.email,
    contractNo: lark.contractNo, shippedAt: '', referenceName: lark.referenceName, referencePhone: lark.referencePhone,
    firstDueDate: lark.firstDueDate, payDay: lark.payDay,
    installments,
    accessoryOrderId: '', accessoryProductList: '', accessoryProductPrice: 0, accessoryDownPayment: 0,
    accessoryFirstDueDate: '', accessoryPayDay: null, accessoryInstallments: [],
    // บอกระบบว่าส่วนลดถูกหักเข้า amountDue ของงวดแล้ว ห้ามหักซ้ำตอนคำนวณยอดคงเหลือ (ดู updateOrderField)
    _discountAppliedToInstallments: discount > 0 ? true : undefined,
    importedFrom: 'lark-contract-import', importedAt: new Date().toISOString(),
  };
  const crmRemaining = round2(price - discount - (Number(so.accumulatedAmount) || 0));
  const paidTotal = installments.reduce((s, i) => s + i.amountPaid, 0);
  const trackerRemaining = round2(price - discount - (downPayment + paidTotal));
  return { order, crmRemaining, trackerRemaining, match: Math.abs(crmRemaining - trackerRemaining) <= 0.5 };
}

// ---------- CRM ----------
let crmToken = null;
async function crmLogin() {
  const res = await fetch(CRM_BASE + '/crm/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: process.env.CRM_USERNAME, password: process.env.CRM_PASSWORD }) });
  const data = await res.json();
  if (!res.ok || !data.token) throw new Error('CRM login failed');
  return data.token;
}
async function crmGet(p, retried) {
  const res = await fetch(CRM_BASE + p, { headers: { Authorization: 'Bearer ' + crmToken } });
  if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); return crmGet(p, retried); }
  if (res.status === 401 && !retried) { crmToken = await crmLogin(); return crmGet(p, true); }
  const data = await res.json().catch(() => null);
  if (!res.ok) return { __httpError: res.status };
  if (data && data.errorCode) return { __crmError: data.errorMessage || data.abbr };
  return data;
}
async function fetchAllTx(so) {
  let all = [];
  for (let page = 1; page <= 300; page++) {
    const r = await crmGet('/crm/sale-order/' + encodeURIComponent(so) + '/payment-transaction?page=' + page);
    if (r.__httpError || r.__crmError) break;
    all = all.concat(r.paymentTransactions || []);
    if (!r.pagination || !r.pagination.hasNextPage) break;
  }
  return all;
}

// ---------- Lark ----------
async function larkToken() {
  const res = await fetch(LARK_BASE + '/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }) });
  const d = await res.json();
  if (!d.tenant_access_token) throw new Error('Lark auth failed: ' + (d.msg || res.status));
  return d.tenant_access_token;
}
async function fetchLarkRows(token) {
  const rows = []; let pageToken = '';
  do {
    const url = LARK_BASE + '/open-apis/bitable/v1/apps/' + LARK_APP_TOKEN + '/tables/' + LARK_TABLE_ID + '/records/search?page_size=500' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { conjunction: 'and', conditions: [{ field_name: LARK_STATUS_FIELD, operator: 'is', value: [LARK_STATUS_VALUE] }] } }) });
    const d = await res.json();
    if (d.code !== 0) throw new Error('Lark search failed: ' + d.code + ' ' + d.msg);
    (d.data.items || []).forEach(it => rows.push(it.fields));
    pageToken = d.data.has_more ? d.data.page_token : '';
  } while (pageToken);
  return rows;
}

// ---------- Supabase (เหมือน reconcile.js) ----------
function employeeCodeToEmail(code) { return 'staff-' + String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') + '@debttracker.internal'; }
async function debtTrackerLogin() {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY }, body: JSON.stringify({ email: employeeCodeToEmail(process.env.CRM_USERNAME), password: process.env.CRM_PASSWORD }) });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error('debt-tracker login failed');
  return d.access_token;
}
function restHeaders(t) { return { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', Prefer: 'return=representation' }; }
async function tryAcquireOnce(t) {
  const nowIso = new Date().toISOString();
  const res = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=is.null', { method: 'PATCH', headers: restHeaders(t), body: JSON.stringify({ locked_by: MY_CLIENT_ID, locked_at: nowIso }) });
  const d = await res.json();
  if (res.ok && Array.isArray(d) && d.length) return true;
  const rows = await (await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&select=locked_by,locked_at', { headers: restHeaders(t) })).json();
  const row = rows && rows[0];
  if (!row || !row.locked_by || !row.locked_at) return false;
  if (Date.now() - new Date(row.locked_at).getTime() < STALE_MS) return false;
  const res3 = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(row.locked_by), { method: 'PATCH', headers: restHeaders(t), body: JSON.stringify({ locked_by: MY_CLIENT_ID, locked_at: nowIso }) });
  const d3 = await res3.json();
  return res3.ok && Array.isArray(d3) && d3.length > 0;
}
async function acquireLock(t) {
  const deadline = Date.now() + 33000;
  while (Date.now() < deadline) { if (await tryAcquireOnce(t)) return true; await new Promise(r => setTimeout(r, 300 + Math.random() * 400)); }
  return false;
}
async function releaseLock(t) {
  await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(MY_CLIENT_ID), { method: 'PATCH', headers: restHeaders(t), body: JSON.stringify({ locked_by: null, locked_at: null }) }).catch(() => {});
}
async function downloadState(t) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/state.json?_=' + Date.now(), { cache: 'no-store', headers: { Authorization: 'Bearer ' + t, apikey: SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error('download state.json failed: ' + res.status);
  // state.json ถูกเก็บแบบ gzip ตั้งแต่ 2026-10-07 — ตรวจ magic bytes 1f 8b ก่อนอ่าน
  const buf = Buffer.from(await res.arrayBuffer());
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return JSON.parse((isGzip ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}
async function uploadState(t, obj) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/state.json', { method: 'PUT', headers: { Authorization: 'Bearer ' + t, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': '0' }, body: zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')) });
  if (!res.ok) throw new Error('upload state.json failed: ' + res.status);
}
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length); let idx = 0;
  await Promise.all(new Array(limit).fill(0).map(async () => { while (idx < items.length) { const i = idx++; results[i] = await worker(items[i], i); } }));
  return results;
}

async function main() {
  for (const k of ['CRM_USERNAME', 'CRM_PASSWORD', 'LARK_APP_ID', 'LARK_APP_SECRET']) if (!process.env[k]) { log('ต้องตั้งค่า env ' + k); process.exit(1); }
  const DATE_FROM = process.env.DATE_FROM || '2026-08-01';
  const DATE_TO = process.env.DATE_TO || '2026-09-30';
  const DRY_RUN = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';
  const ONLY = (process.env.ONLY_SO || '').split(',').map(s => s.trim()).filter(Boolean);
  const LIMIT = Number(process.env.LIMIT) || 0;
  const PURCHASE_TYPE = (process.env.PURCHASE_TYPE || '').trim();
  log('โหมด: ' + (DRY_RUN ? 'DRY-RUN (ไม่เขียนข้อมูล)' : 'เขียนจริง') + ' · ช่วงวันที่ ' + DATE_FROM + ' ถึง ' + DATE_TO + (ONLY.length ? ' · เฉพาะ ' + ONLY.join(',') : '') + (LIMIT ? ' · limit ' + LIMIT : '') + (PURCHASE_TYPE ? ' · ประเภทการซื้อ: ' + PURCHASE_TYPE : ' · ทุกประเภทการซื้อ'));

  crmToken = await crmLogin();
  const dtToken = await debtTrackerLogin();
  const state0 = await downloadState(dtToken);
  const existing = new Set(state0.orders.map(o => o.orderId));
  state0.orders.forEach(o => (o.previousOrderIds || []).forEach(p => existing.add(p)));

  const rows = (await fetchLarkRows(await larkToken())).map(parseLarkRow);
  let cands = rows.filter(r => r.soNumber && r.contractDate >= DATE_FROM && r.contractDate <= DATE_TO);
  log('Lark: สถานะ 5. ทั้งหมด ' + rows.length + ' · อยู่ในช่วงวันที่ ' + cands.length);
  const typeCount = {}; cands.forEach(r => { const k = r.purchaseType || '(ไม่ระบุ)'; typeCount[k] = (typeCount[k] || 0) + 1; });
  log('แยกตามประเภทการซื้อ (ในช่วงวันที่): ' + Object.keys(typeCount).map(k => k + '=' + typeCount[k]).join(' · '));
  if (PURCHASE_TYPE) cands = cands.filter(r => r.purchaseType === PURCHASE_TYPE);
  if (ONLY.length) cands = cands.filter(r => ONLY.includes(r.soNumber));
  const already = cands.filter(r => existing.has(r.soNumber)).length;
  cands = cands.filter(r => !existing.has(r.soNumber));
  if (LIMIT) cands = cands.slice(0, LIMIT);
  log('มีในระบบติดตามหนี้อยู่แล้ว ' + already + ' · จะประมวลผล ' + cands.length);

  const results = await mapWithConcurrency(cands, CONCURRENCY, async (lark) => {
    const so = await crmGet('/crm/sale-order/' + encodeURIComponent(lark.soNumber));
    if (so.__httpError || so.__crmError) return { so: lark.soNumber, skip: 'crm_error' };
    const txs = await fetchAllTx(lark.soNumber);
    const r = buildOrder(lark, so, txs);
    return Object.assign({ so: lark.soNumber }, r);
  });

  const ready = results.filter(r => r.order && r.match);
  const mismatch = results.filter(r => r.order && !r.match);
  const skipped = {}; results.filter(r => r.skip).forEach(r => { (skipped[r.skip] = skipped[r.skip] || []).push(r.so); });
  log('พร้อมนำเข้า ' + ready.length + ' · ยอดคงเหลือไม่ตรง CRM ' + mismatch.length + ' · ข้าม ' + results.filter(r => r.skip).length);
  Object.keys(skipped).forEach(k => log('  ข้าม ' + k + ': ' + skipped[k].length + ' (' + skipped[k].slice(0, 5).join(', ') + (skipped[k].length > 5 ? ' ...' : '') + ')'));
  mismatch.forEach(m => log('  ไม่ตรง ' + m.so + ' | ' + m.order.customerName + ' | ' + m.order.customerId + ' | สัญญา ' + m.order.contractDate + ' | ' + m.order.purchaseType + ' | ราคา ' + m.order.productPrice + ' ดาวน์ ' + m.order.downPayment + ' ส่วนลด ' + m.order.discount + ' | CRM=' + m.crmRemaining + ' tracker=' + m.trackerRemaining + ' ต่าง ' + round2(m.trackerRemaining - m.crmRemaining)));
  ready.slice(0, 5).forEach(r => log('  ตัวอย่าง ' + r.so + ' ' + r.order.customerName + ' | ' + r.order.productList + ' | ราคา ' + r.order.productPrice + ' ดาวน์ ' + r.order.downPayment + ' ' + r.order.installments.length + ' งวด x ' + r.order.installments[0].amountDue + ' | คงเหลือ CRM ' + r.crmRemaining + ' = tracker ' + r.trackerRemaining));

  if (DRY_RUN) { log('DRY-RUN: ไม่เขียนข้อมูล'); return; }
  if (!ready.length) { log('ไม่มีรายการที่ต้องเขียน'); return; }

  if (!(await acquireLock(dtToken))) { log('ขอ lock ไม่สำเร็จ — ข้ามรอบนี้'); return; }
  try {
    const state = await downloadState(dtToken);
    const have = new Set(state.orders.map(o => o.orderId));
    let added = 0;
    ready.forEach(r => { if (!have.has(r.order.orderId)) { state.orders.push(r.order); added++; } });
    await uploadState(dtToken, state);
    log('เขียนสำเร็จ: เพิ่ม ' + added + ' orders');
    console.log('::notice::imported=' + added + ' mismatch=' + mismatch.length);
  } finally { await releaseLock(dtToken); }
}

module.exports = { parseLarkRow, buildOrder, recalcDueDate, splitEvenlyRounded };
if (require.main === module) main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
