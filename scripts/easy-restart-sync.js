// ซิงค์ลูกค้าโครงการ Salmon Easy Restart (2026-10-09)
//   1) หา SO ใหม่ใน CRM ของลูกค้าที่ออกหนังสือเงื่อนไข Easy Restart (order.easyRestartLetterHistory) — รหัสลูกค้าเดิม ราคาเท่ากับ
//      ราคาในหนังสือ ประเภท FULL_PAY_THEN_RECEIVE เปิดหลังวันออกหนังสือ; เจอใบเดียวเท่านั้นถึงโยง ไม่แน่ใจ = ไม่เดา (รายงานให้ตรวจ)
//   2) สร้าง/อัปเดตบิลใหม่ (order.easyRestart) พร้อมตารางผ่อนรายเดือนตามวันที่ในหนังสือ (งวดแรก..งวดสุดท้าย) + ลงยอดชำระจาก CRM
//      ยอดวางดาวน์ = initAmount ของ SO ใหม่ (ซึ่งรวมเงินที่จ่ายไปแล้วใน SO เดิม) — ตารางผ่อนคือยอดคงเหลือที่เหลือ
//   3) สร้างข้อความแจ้งเตือนเข้า Lark กลุ่ม AR/Cost&Stock: (ก) ผ่อนครบ  (ข) ถึงวันครบ 3 วันตามปฏิทินหลังงวดสุดท้าย (วันนั้นเลย) แต่ยังผ่อนไม่ครบ (ตัดสิทธิ์)
//      ส่งครั้งเดียวต่อเหตุการณ์ (เก็บเวลาที่ส่งไว้ใน order.easyRestart.alerts)
//
// โหมด: DRY_RUN=1 (ไม่เขียน state / ไม่ส่งข้อความ แค่พิมพ์ผล) · LOCAL_STATE=<ไฟล์ state.json> อ่านจากไฟล์แทน Supabase (ไม่เขียนกลับ)
// ENV: CRM_USERNAME CRM_PASSWORD (ต้องมีเสมอ)  LARK_APP_ID LARK_APP_SECRET LARK_CHAT_ID (เฉพาะตอนส่งจริง)  ONLY_ORDER (จำกัดเฉพาะ SO เดิม)
// ห้าม hardcode รหัสผ่านจริง — ตั้งเป็น GitHub Actions Secrets เท่านั้น. ไม่ commit รายงานที่มีชื่อลูกค้าเข้า repo (public)

const zlib = require('zlib');
const CRM_BASE = 'https://api.salmonphone.com';
const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZHRmY2dhbmJ1eHpmZW5kZ2ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODc3NzQsImV4cCI6MjA5OTI2Mzc3NH0.eseoVPBdM9fPOh8J8HyqVsBWCIjtG4eTGCRC1scVsTg';
const STALE_MS = 25000;
const MY_CLIENT_ID = 'gh-actions-easy-restart-' + Date.now();
const DRY_RUN = process.env.DRY_RUN === '1' || !!process.env.LOCAL_STATE;
const NEW_SO_BUSINESS_DAYS = 3;   // SO ใหม่ต้องเปิดภายใน 3 วันทำการ นับจากวันออกหนังสือ
const GRACE_CALENDAR_DAYS = 3;    // เลยวันงวดสุดท้ายแล้วรอลูกค้าติดต่อได้อีก 3 วันตามปฏิทิน (วันทำการใช้เฉพาะการตรวจสอบของพนักงาน)
const MIN_LAST_GAP_DAYS = 15;     // งวดสุดท้ายห่างจากงวดก่อนหน้าน้อยกว่านี้ → รวมเข้ากับงวดสุดท้าย
const TODAY = thaiDateOf(Date.now());
// กลุ่ม Lark ที่รับแจ้งเตือน (ส่งทุกเหตุการณ์ไปทุกกลุ่ม): AR/Cost&Stock + เร่งรัดหนี้สิน — override ด้วย env LARK_CHAT_ID (คั่นด้วย ,)
const ALERT_CHATS_DEFAULT = ['oc_a8883cf200cf7c7de97d5c8945f3b156', 'oc_c17c2664870430e64413b80a605130bd'];
const ALERT_SEND_HOUR_THAI = 9;   // ส่งแจ้งเตือนตั้งแต่ 09:00 น. (เวลาไทย) เป็นต้นไป — รอบที่รันก่อน 09:00 จะเก็บไว้ส่งรอบถัดไป
function alertChats() { const v = process.env.LARK_CHAT_ID; return v ? v.split(',').map(x => x.trim()).filter(Boolean) : ALERT_CHATS_DEFAULT; }
function thaiHourNow() { return new Date(Date.now() + 7 * 3600 * 1000).getUTCHours(); }

function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }
function n(x) { return Number(x) || 0; }
function r2(x) { return Math.round(n(x) * 100) / 100; }
function thaiDateOf(msOrIso) { return new Date(new Date(msOrIso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10); }
function pad(x) { return String(x).padStart(2, '0'); }
function isoDate(y, m0, d) { return y + '-' + pad(m0 + 1) + '-' + pad(d); }
function parseIso(s) { const p = String(s).split('-').map(Number); return { y: p[0], m: p[1] - 1, d: p[2] }; }
function daysBetween(a, b) { const x = parseIso(a), y = parseIso(b); return Math.round((Date.UTC(y.y, y.m, y.d) - Date.UTC(x.y, x.m, x.d)) / 86400000); }
// นับวันทำการ จันทร์-ศุกร์ เท่านั้น (ไม่มีปฏิทินวันหยุดนักขัตฤกษ์ — เหมือน addBusinessDays ในหน้าเว็บ)
function addBusinessDays(iso, k) {
  const p = parseIso(iso); const d = new Date(Date.UTC(p.y, p.m, p.d)); let added = 0;
  while (added < k) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) added++; }
  return isoDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function dmyToIso(s) { const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? m[3] + '-' + pad(m[2]) + '-' + pad(m[1]) : ''; }
function monthlyDate(firstIso, k) {
  const f = parseIso(firstIso); const m0 = f.m + k; const y = f.y + Math.floor(m0 / 12); const m = ((m0 % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return isoDate(y, m, Math.min(f.d, last));
}
function splitEvenlyRounded(total, cnt) {
  const per = r2(total / cnt); const out = [];
  for (let i = 0; i < cnt; i++) out.push(i === cnt - 1 ? r2(total - per * (cnt - 1)) : per);
  return out;
}

// ---------- ตารางผ่อนตามหนังสือ ----------
// งวดแรก = วันเริ่มในหนังสือ · งวดถัดไปรายเดือน (วันเดียวกับงวดแรก ติดสิ้นเดือนถ้าเดือนนั้นไม่มีวัน) · งวดสุดท้าย = วันงวดสุดท้ายในหนังสือเสมอ
// ถ้างวดสุดท้ายห่างจากงวดก่อนหน้า < MIN_LAST_GAP_DAYS วัน ให้ตัดงวดก่อนหน้าทิ้ง (รวมเข้างวดสุดท้าย) — ไม่มีงวดใดเลยวันงวดสุดท้าย
function buildScheduleDates(firstIso, lastIso) {
  if (!firstIso || !lastIso || firstIso >= lastIso) return [lastIso || firstIso];
  const dates = [];
  for (let k = 0; ; k++) {
    const d = monthlyDate(firstIso, k);
    if (d >= lastIso) break;
    dates.push(d);
    if (k > 60) break;
  }
  if (dates.length && daysBetween(dates[dates.length - 1], lastIso) < MIN_LAST_GAP_DAYS) dates.pop();
  dates.push(lastIso);
  return dates;
}
function buildInstallments(firstIso, lastIso, outstanding, note) {
  const dates = buildScheduleDates(firstIso, lastIso);
  const dues = splitEvenlyRounded(Math.max(0, outstanding), dates.length);
  return dates.map((d, i) => ({
    no: i + 1, dueDate: d, amountDue: dues[i], amountPaid: 0, paidDate: '', status: '', statusOverride: false, discount: 0,
    note: i === 0 ? note : '', smsHistory: [],
  }));
}

// ---------- ยอดชำระจาก CRM ----------
// ยอดวางดาวน์ = initAmount (เงินที่จ่ายไปแล้วใน SO เดิมถูกยกมาเป็นรายการเดียวใน SO ใหม่) — ตัดออกจากรายการชำระก่อน ที่เหลือคือเงินผ่อนใหม่
// นับเฉพาะ type INSTALLMENT (ไม่มีค่าปรับในโครงการ) — type อื่นที่มียอดเงิน (เช่น รวมค่าปรับ) ไม่นับแต่ส่งให้ตรวจ
function paymentsFromTxs(txs, initAmount) {
  const ok = (txs || []).filter(x => x.paymentStatus === 'SUCCESSFUL' && n(x.amount) > 0);
  const inst = ok.filter(x => x.type === 'INSTALLMENT').sort((a, b) => String(a.paymentDate || '').localeCompare(String(b.paymentDate || '')));
  const review = ok.filter(x => x.type !== 'INSTALLMENT' && x.type !== 'APPROVE_CREDIT' && x.type !== 'CANCEL')
    .map(x => ({ type: x.type, amount: x.amount, no: x.no, date: x.paymentDate }));
  let downLeft = n(initAmount); const payments = [];
  for (const x of inst) {
    let a = n(x.amount);
    const toDown = Math.min(a, downLeft); downLeft = r2(downLeft - toDown); a = r2(a - toDown);
    if (a > 0.005) payments.push({ amount: a, date: x.paymentDate ? thaiDateOf(x.paymentDate) : '' });
  }
  return { payments, downCovered: r2(n(initAmount) - downLeft), review };
}
// ลงยอดชำระไล่ตามงวด (ตามใจ: จ่ายกี่ครั้งต่อเดือนก็ได้) — ส่วนที่เกินรวมไว้งวดสุดท้าย
function allocatePayments(installments, payments) {
  installments.forEach(i => { i.amountPaid = 0; i.paidDate = ''; });
  let idx = 0;
  for (const p of payments) {
    let left = p.amount;
    while (left > 0.005 && idx < installments.length) {
      const inst = installments[idx];
      const room = r2(n(inst.amountDue) - n(inst.amountPaid));
      const isLast = idx === installments.length - 1;
      const put = isLast ? left : Math.min(left, room);
      if (put > 0.005) { inst.amountPaid = r2(n(inst.amountPaid) + put); inst.paidDate = p.date || inst.paidDate; left = r2(left - put); }
      if (isLast || r2(n(inst.amountDue) - n(inst.amountPaid)) <= 0.005) { if (isLast) break; idx++; }
    }
  }
  return installments;
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
async function fetchTxs(so) {
  let all = [];
  for (let page = 1; page <= 40; page++) {
    const r = await crmGet('/crm/sale-order/' + encodeURIComponent(so) + '/payment-transaction?page=' + page);
    if (r.__httpError || r.__crmError) return { txs: all, complete: false };
    all = all.concat(r.paymentTransactions || []);
    if (!r.pagination || !r.pagination.hasNextPage) return { txs: all, complete: true };
  }
  return { txs: all, complete: false };
}

function latestLetter(order) {
  return (order.easyRestartLetterHistory || []).reduce((b, x) => (!b || x.no > b.no ? x : b), null);
}
function parseMoney(s) { return n(String(s || '').replace(/,/g, '')); }

// หา SO ใหม่ของลูกค้า — คืน { soId } | { none } | { ambiguous:[...] }
async function findNewSo(oldOrder, letter) {
  const c = await crmGet('/crm/customer/' + encodeURIComponent(oldOrder.customerId));
  if (!c || c.__httpError || c.__crmError) return { error: 'crm_customer' };
  const letterIso = dmyToIso(letter.at);
  const price = parseMoney(letter.fullPriceDisp);
  const cands = [];
  for (const s of (c.saleOrders || [])) {
    if (s.saleOrderId === oldOrder.orderId || s.status === 'CANCELLED') continue;
    const created = thaiDateOf(s.createdAt);
    if (letterIso && created < letterIso) continue;
    if (price && Math.abs(n(s.productPrice) - price) > 1) continue;
    const full = await crmGet('/crm/sale-order/' + encodeURIComponent(s.saleOrderId));
    if (full.__httpError || full.__crmError) continue;
    if (full.installmentType !== 'FULL_PAY_THEN_RECEIVE') continue;
    cands.push(full);
  }
  if (cands.length === 1) return { so: cands[0] };
  return cands.length ? { ambiguous: cands.map(x => x.saleOrderId) } : { none: true };
}

function buildEasyRestartOrder(oldOrder, letter, so, txsInfo) {
  const price = n(so.productPrice), down = n(so.initAmount);
  const outstanding = r2(price - down);
  const firstIso = letter.firstDueDate, lastIso = letter.lastDueDate;
  const insts = buildInstallments(firstIso, lastIso, outstanding, 'ตารางผ่อน Easy Restart สร้างตามหนังสือ ' + (letter.docNo || '') + ' (' + TODAY + ') — ไม่คิดค่าปรับ ไม่ล็อคเครื่อง');
  allocatePayments(insts, txsInfo.payments);
  return {
    customerId: oldOrder.customerId, customerName: oldOrder.customerName, orderId: so.saleOrderId, soUnknown: false,
    contractDate: thaiDateOf(so.orderDate || so.createdAt), productList: so.productName || oldOrder.productList || '',
    downPayment: down, productPrice: price, discount: 0, purchaseType: 'Easy Restart (ผ่อนครบรับของ)',
    age: oldOrder.age, phone: oldOrder.phone, email: oldOrder.email, contractNo: letter.docNo || '', shippedAt: '', // เลขที่สัญญา = เลขที่เอกสารหนังสือเงื่อนไข Easy Restart
    firstDueDate: insts[0].dueDate, payDay: parseIso(firstIso).d, installments: insts,
    accessoryOrderId: '', accessoryProductList: '', accessoryProductPrice: 0, accessoryDownPayment: 0,
    accessoryFirstDueDate: '', accessoryPayDay: null, accessoryInstallments: [],
    easyRestart: {
      fromOrderId: oldOrder.orderId, letterNo: letter.no, letterDocNo: letter.docNo || '', scope: letter.scope || 'all',
      firstDueDate: firstIso, lastDueDate: lastIso, createdAt: TODAY, crmStatus: so.status || '', crmPaymentFrequency: so.paymentFrequency || '',
      alerts: {},
    },
    importedFrom: 'easy-restart-sync', importedAt: new Date().toISOString(),
  };
}

// รีเฟรชบิลที่มีอยู่แล้ว: ยอดชำระจาก CRM + ตารางผ่อนถ้าวันที่ในหนังสือเปลี่ยน — ไม่แตะฟิลด์อื่น
function refreshEasyRestartOrder(ord, letter, so, txsInfo) {
  const er = ord.easyRestart; let changed = false;
  const down = n(so.initAmount), price = n(so.productPrice);
  if (n(ord.downPayment) !== down) { ord.downPayment = down; changed = true; }
  if (n(ord.productPrice) !== price) { ord.productPrice = price; changed = true; }
  const datesChanged = letter && (er.firstDueDate !== letter.firstDueDate || er.lastDueDate !== letter.lastDueDate);
  if (datesChanged || n(ord.installments.reduce((s, i) => s + n(i.amountDue), 0)) !== r2(price - down)) {
    ord.installments = buildInstallments(letter.firstDueDate, letter.lastDueDate, r2(price - down), 'ตารางผ่อน Easy Restart ปรับตามหนังสือ ' + (letter.docNo || '') + ' (' + TODAY + ')');
    er.firstDueDate = letter.firstDueDate; er.lastDueDate = letter.lastDueDate; er.letterNo = letter.no; er.letterDocNo = letter.docNo || '';
    ord.firstDueDate = ord.installments[0].dueDate; changed = true;
  }
  const before = JSON.stringify(ord.installments.map(i => [i.amountPaid, i.paidDate]));
  allocatePayments(ord.installments, txsInfo.payments);
  if (JSON.stringify(ord.installments.map(i => [i.amountPaid, i.paidDate])) !== before) changed = true;
  if (letter && letter.docNo && ord.contractNo !== letter.docNo) { ord.contractNo = letter.docNo; changed = true; }
  if (er.crmStatus !== (so.status || '')) { er.crmStatus = so.status || ''; changed = true; }
  return changed;
}

function outstandingOf(ord) {
  const paid = ord.installments.reduce((s, i) => s + n(i.amountPaid), 0);
  return r2(n(ord.productPrice) - n(ord.downPayment) - paid);
}

// ---------- ข้อความแจ้งเตือน (Lark กลุ่ม AR/Cost&Stock) ----------
function fmtThai(iso) { const p = parseIso(iso); return pad(p.d) + '/' + pad(p.m + 1) + '/' + p.y; }
function fmtBaht(x) { return n(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function paidFullMessage(ord) {
  const er = ord.easyRestart;
  return {
    title: '✅ Easy Restart — ลูกค้าผ่อนครบแล้ว',
    body: [
      '👤 ลูกค้า: ' + ord.customerName + ' (' + ord.customerId + ')',
      '🧾 SO ใหม่: ' + ord.orderId + ' (SO เดิม ' + er.fromOrderId + (er.letterDocNo ? ' · ' + er.letterDocNo : '') + ')',
      '📦 สินค้า: ' + (ord.productList || '-'),
      '💰 ราคา ฿' + fmtBaht(ord.productPrice) + ' · ชำระครบแล้ว',
      '📅 เงื่อนไขผ่อน: ' + fmtThai(er.firstDueDate) + ' – ' + fmtThai(er.lastDueDate),
      '',
      'ลูกค้าผ่อนครบตามเงื่อนไขโครงการ Salmon Easy Restart — ขอให้ทีมที่เกี่ยวข้องประสานงานดำเนินการต่อ (ส่งมอบสินค้าคืนลูกค้า)',
    ].join('\n'),
  };
}
function expiredMessage(ord, outstanding, graceEnd) {
  const er = ord.easyRestart;
  return {
    title: '⚠️ Easy Restart — ลูกค้าผ่อนไม่ครบตามเงื่อนไข',
    body: [
      '👤 ลูกค้า: ' + ord.customerName + ' (' + ord.customerId + ')',
      '🧾 SO ใหม่: ' + ord.orderId + ' (SO เดิม ' + er.fromOrderId + (er.letterDocNo ? ' · ' + er.letterDocNo : '') + ')',
      '📦 สินค้า: ' + (ord.productList || '-'),
      '💰 ราคา ฿' + fmtBaht(ord.productPrice) + ' · ยอดคงเหลือ ฿' + fmtBaht(outstanding),
      '📅 วันครบกำหนดงวดสุดท้าย: ' + fmtThai(er.lastDueDate) + ' · ครบ ' + GRACE_CALENDAR_DAYS + ' วัน ' + fmtThai(graceEnd),
      '',
      'ลูกค้าไม่ผ่อนให้ครบและไม่ได้ติดต่อกลับภายในกำหนด — บริษัทมีสิทธิ์ตัดสิทธิ์ตามเงื่อนไขในหนังสือ (ยึดเงินผ่อนและเครื่อง) ขอให้ทีมที่เกี่ยวข้องดำเนินการต่อ',
    ].join('\n'),
  };
}
// เหตุการณ์ที่ต้องแจ้ง ณ วันนี้ (ยังไม่เคยส่ง) — pure function
function pendingAlerts(ord, today) {
  const er = ord.easyRestart; const out = [];
  if (!er) return out;
  const out_ = outstandingOf(ord);
  if (out_ <= 0.5 && !(er.alerts && er.alerts.paidFullAt)) out.push({ kind: 'paidFull', msg: paidFullMessage(ord) });
  if (out_ > 0.5 && er.lastDueDate && !(er.alerts && er.alerts.expiredAt)) {
    const graceEnd = addCalendarDays(er.lastDueDate, GRACE_CALENDAR_DAYS);
    if (today >= graceEnd) out.push({ kind: 'expired', msg: expiredMessage(ord, out_, graceEnd) });
  }
  return out;
}

// ---------- คิวแจ้งเตือนให้ routine ส่งตอน 09:00 (reports/easy-restart-alerts.json) ----------
// ทำงานเหมือนรายงานสรุปรายวัน: สคริปต์นี้เตรียมไฟล์ใน repo แล้ว routine ของ Claude (ตั้งเวลาแม่น) อ่านไฟล์และส่งการ์ดเข้า Lark เอง
// repo นี้เป็น public — ไฟล์จึงมีเฉพาะเลข SO / เลขเอกสาร / วันที่ ห้ามมีชื่อลูกค้าและยอดเงิน (ดูรายละเอียดในเมนู Easy Restart)
// routine ส่งเฉพาะรายการที่ alertDate = วันนี้ (เวลาไทย) จึงไม่ส่งซ้ำและไม่ต้องจำสถานะ:
//  - expired: alertDate = วันสุดท้ายของช่วงรอลูกค้า (งวดสุดท้าย + 3 วันตามปฏิทิน) — ใส่ในคิวตั้งแต่วันครบกำหนดงวดสุดท้ายเพื่อให้ไฟล์พร้อมก่อน 09:00; ถ้าลูกค้าผ่อนครบก่อน จะหลุดจากคิวเอง
//  - paidFull: alertDate = วันที่ตรวจพบผ่อนครบ ถ้าตรวจพบก่อน 09:00 (ไทย) ส่งวันนั้น ไม่งั้นส่งวันถัดไป (จดไว้ที่ er.alerts.paidFullQueued)
function addCalendarDays(iso, k) {
  const p = parseIso(iso); const d = new Date(Date.UTC(p.y, p.m, p.d + k));
  return isoDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function buildAlertQueue(orders, today, hourThai) {
  const items = [];
  for (const o of orders) {
    const er = o.easyRestart; if (!er) continue;
    const out = outstandingOf(o);
    const base = { newSo: o.orderId, oldSo: er.fromOrderId, docNo: er.letterDocNo || '', lastDueDate: er.lastDueDate || '' };
    if (out <= 0.5) {
      er.alerts = er.alerts || {};
      if (!er.alerts.paidFullQueued) er.alerts.paidFullQueued = hourThai < ALERT_SEND_HOUR_THAI ? today : addCalendarDays(today, 1);
      if (er.alerts.paidFullQueued >= today) items.push(Object.assign({ kind: 'paidFull', alertDate: er.alerts.paidFullQueued }, base));
    } else if (er.lastDueDate) {
      const graceEnd = addCalendarDays(er.lastDueDate, GRACE_CALENDAR_DAYS);
      if (today >= er.lastDueDate && today <= graceEnd) items.push(Object.assign({ kind: 'expired', alertDate: graceEnd, graceEnd }, base));
    }
  }
  return items;
}

// ---------- Lark ----------
async function larkSend(chatId, msg) {
  const tr = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: process.env.LARK_APP_ID, app_secret: process.env.LARK_APP_SECRET }) });
  const t = (await tr.json()).tenant_access_token;
  if (!t) throw new Error('Lark auth failed');
  const card = { config: { wide_screen_mode: true }, header: { template: 'orange', title: { tag: 'plain_text', content: msg.title } }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: msg.body } }] };
  const res = await fetch('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }),
  });
  const d = await res.json();
  if (d.code !== 0) throw new Error('Lark send failed: ' + (d.msg || res.status));
}

// ---------- Supabase (เหมือน reconcile.js) ----------
function employeeCodeToEmail(code) { return 'staff-' + String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') + '@debttracker.internal'; }
async function debtTrackerLogin() {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: employeeCodeToEmail(process.env.CRM_USERNAME), password: process.env.CRM_PASSWORD }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('debt-tracker login failed');
  return data.access_token;
}
function restHeaders(token) { return { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' }; }
async function tryAcquireOnce(token) {
  const nowIso = new Date().toISOString();
  const res = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=is.null', { method: 'PATCH', headers: restHeaders(token), body: JSON.stringify({ locked_by: MY_CLIENT_ID, locked_at: nowIso }) });
  const data = await res.json();
  if (res.ok && Array.isArray(data) && data.length) return true;
  const rows = await (await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&select=locked_by,locked_at', { headers: restHeaders(token) })).json();
  const row = rows && rows[0];
  if (!row || !row.locked_by || !row.locked_at) return false;
  if (Date.now() - new Date(row.locked_at).getTime() < STALE_MS) return false;
  const res3 = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(row.locked_by), { method: 'PATCH', headers: restHeaders(token), body: JSON.stringify({ locked_by: MY_CLIENT_ID, locked_at: nowIso }) });
  const d3 = await res3.json();
  return res3.ok && Array.isArray(d3) && d3.length > 0;
}
async function acquireLock(token) {
  const deadline = Date.now() + 33000;
  while (Date.now() < deadline) { if (await tryAcquireOnce(token)) return true; await new Promise(r => setTimeout(r, 300 + Math.random() * 400)); }
  return false;
}
async function releaseLock(token) {
  await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(MY_CLIENT_ID), { method: 'PATCH', headers: restHeaders(token), body: JSON.stringify({ locked_by: null, locked_at: null }) }).catch(() => {});
}
async function downloadState(token) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/state.json?_=' + Date.now(), { cache: 'no-store', headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY } });
  if (!res.ok) throw new Error('download state.json failed: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return JSON.parse((gz ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}
async function uploadState(token, stateObj) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/state.json', {
    method: 'PUT', headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': '0' },
    body: zlib.gzipSync(Buffer.from(JSON.stringify(stateObj), 'utf8')),
  });
  if (!res.ok) throw new Error('upload state.json failed: ' + res.status);
}

// ---------- วางแผน (ไม่แก้ state) ----------
// คืน { creates:[{oldOrderId, order}], refreshes:[{orderId, so, txsInfo, letter}], unlinked:[{...}], messages:[...] }
async function plan(state) {
  const creates = [], refreshes = [], unlinked = [];
  const erByFrom = {};
  (state.orders || []).forEach(o => { if (o.easyRestart) erByFrom[o.easyRestart.fromOrderId] = o; });
  for (const old of state.orders || []) {
    if (process.env.ONLY_ORDER && old.orderId !== process.env.ONLY_ORDER) continue;
    const letter = latestLetter(old);
    if (!letter || old.easyRestart) continue;
    const existing = erByFrom[old.orderId];
    if (existing) {
      const so = await crmGet('/crm/sale-order/' + encodeURIComponent(existing.orderId));
      if (so.__httpError || so.__crmError) { unlinked.push({ oldOrderId: old.orderId, reason: 'crm_error_existing' }); continue; }
      const t = await fetchTxs(existing.orderId);
      if (!t.complete) { unlinked.push({ oldOrderId: old.orderId, reason: 'crm_tx_incomplete' }); continue; }
      refreshes.push({ orderId: existing.orderId, so, letter, txsInfo: paymentsFromTxs(t.txs, so.initAmount) });
      continue;
    }
    const found = await findNewSo(old, letter);
    if (found.error) { unlinked.push({ oldOrderId: old.orderId, reason: found.error }); continue; }
    if (found.none) { unlinked.push({ oldOrderId: old.orderId, reason: 'no_new_so_yet', dueBy: addBusinessDays(dmyToIso(letter.at) || TODAY, NEW_SO_BUSINESS_DAYS) }); continue; }
    if (found.ambiguous) { unlinked.push({ oldOrderId: old.orderId, reason: 'ambiguous', candidates: found.ambiguous }); continue; }
    const t = await fetchTxs(found.so.saleOrderId);
    if (!t.complete) { unlinked.push({ oldOrderId: old.orderId, reason: 'crm_tx_incomplete' }); continue; }
    const txsInfo = paymentsFromTxs(t.txs, found.so.initAmount);
    creates.push({ oldOrderId: old.orderId, order: buildEasyRestartOrder(old, letter, found.so, txsInfo), txsInfo, crmRemaining: r2(n(found.so.productPrice) - n(found.so.accumulatedAmount)) });
  }
  return { creates, refreshes, unlinked };
}

// ทดสอบการส่งแจ้งเตือน: TEST_SAMPLE=1 → ส่งการ์ด "ผ่อนไม่ครบ" ของออเดอร์ตัวอย่างเข้า LARK_CHAT_ID เท่านั้น
// (ไม่ login CRM/Supabase ไม่อ่าน/เขียน state) — งวดสุดท้าย 07/04/2027, จำลองวันนี้ SIM_TODAY (ค่าเริ่มต้น 2027-04-12)
async function runSample() {
  const today = process.env.SIM_TODAY || '2027-04-12';
  const ord = {
    customerName: 'ลูกค้าตัวอย่าง (ทดสอบ)', customerId: 'CUS-TEST', orderId: 'SO-TEST-0001', productList: 'สินค้าตัวอย่าง', productPrice: 13200, downPayment: 10700,
    installments: [{ amountDue: 1300, amountPaid: 650 }],
    easyRestart: { fromOrderId: 'SO-TEST-OLD', letterDocNo: 'ER-TEST', firstDueDate: '2027-01-07', lastDueDate: '2027-04-07', alerts: {} },
  };
  const alerts = pendingAlerts(ord, today);
  log('วันนี้(จำลอง) ' + today + ' → แจ้งเตือนที่ต้องส่ง: ' + alerts.map(a => a.kind).join(',') + (alerts.length ? '' : ' (ไม่มี)'));
  const before = pendingAlerts(ord, addBusinessDays('2027-04-07', 2));
  log('เช็ควันก่อนครบกำหนด (' + addBusinessDays('2027-04-07', 2) + ') → ' + (before.length ? 'ส่ง (ผิด!)' : 'ยังไม่ส่ง (ถูกต้อง)'));
  for (const a of alerts) for (const c of alertChats()) { await larkSend(c, { title: '[ทดสอบ] ' + a.msg.title, body: a.msg.body }); log('ส่งการ์ดทดสอบแล้ว: ' + a.kind + ' → ' + c); }
}
if (require.main === module && process.env.TEST_SAMPLE === '1') runSample().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
else if (require.main === module) (async () => {
  if (!process.env.CRM_USERNAME || !process.env.CRM_PASSWORD) { log('ต้องตั้งค่า env CRM_USERNAME / CRM_PASSWORD'); process.exit(1); }
  crmToken = await crmLogin();
  const needDt = !process.env.LOCAL_STATE;
  const dtToken = needDt ? await debtTrackerLogin() : null;
  const state0 = process.env.LOCAL_STATE ? JSON.parse(require('fs').readFileSync(process.env.LOCAL_STATE, 'utf8')) : await downloadState(dtToken);
  log('โหลด state: ' + state0.orders.length + ' orders' + (DRY_RUN ? ' [DRY RUN]' : ''));

  const p = await plan(state0);
  log('สร้างบิลใหม่ ' + p.creates.length + ' · รีเฟรช ' + p.refreshes.length + ' · ยังไม่โยง ' + p.unlinked.length);
  p.creates.forEach(c => {
    const o = c.order;
    log('  + ' + o.orderId + ' (เดิม ' + c.oldOrderId + ') ราคา ' + o.productPrice + ' ดาวน์ ' + o.downPayment + ' งวด ' + o.installments.length + ' [' + o.installments.map(i => i.dueDate + ':' + i.amountDue).join(', ') + '] ชำระผ่อน ' + o.installments.reduce((s, i) => s + i.amountPaid, 0) + ' · คงเหลือ(แอป) ' + outstandingOf(o) + ' vs CRM ' + c.crmRemaining + (c.txsInfo.review.length ? ' · ต้องตรวจรายการ ' + JSON.stringify(c.txsInfo.review) : ''));
  });
  p.unlinked.forEach(u => log('  ? ' + u.oldOrderId + ' ' + u.reason + (u.dueBy ? ' (ควรเปิดภายใน ' + u.dueBy + ')' : '') + (u.candidates ? ' ' + u.candidates.join(',') : '')));

  // รวมผลลง state (ทำกับ state ที่ดึงสดอีกครั้งตอนเขียนจริง — ที่นี่ใช้ state0 เพื่อคำนวณข้อความ)
  const apply = (state) => {
    const byId = {}; state.orders.forEach(o => { byId[o.orderId] = o; });
    let changed = 0;
    for (const c of p.creates) { if (!byId[c.order.orderId]) { state.orders.push(JSON.parse(JSON.stringify(c.order))); byId[c.order.orderId] = state.orders[state.orders.length - 1]; changed++; } }
    for (const r of p.refreshes) { const o = byId[r.orderId]; if (o && o.easyRestart && refreshEasyRestartOrder(o, r.letter, r.so, r.txsInfo)) changed++; }
    return changed;
  };
  const work = JSON.parse(JSON.stringify(state0));
  apply(work);
  const messages = [];
  for (const o of work.orders) {
    if (!o.easyRestart) continue;
    const hasLetter = !!latestLetter(work.orders.find(x => x.orderId === o.easyRestart.fromOrderId) || {});
    if (!hasLetter) continue; // หนังสือถูกลบ — ไม่แจ้ง
    pendingAlerts(o, TODAY).forEach(a => messages.push({ orderId: o.orderId, kind: a.kind, msg: a.msg }));
  }
  log('ข้อความแจ้งเตือนที่ต้องส่ง: ' + messages.length);
  messages.forEach(m => console.log('---- [' + m.kind + '] ' + m.orderId + '\n' + m.msg.title + '\n' + m.msg.body + '\n----'));

  // คิวแจ้งเตือนสำหรับ routine 09:00 (เฉพาะบิลที่หนังสือยังอยู่) — เขียนไฟล์เมื่อกำหนด ALERT_FILE (ใน dry-run ก็เขียนได้ เพื่อดูผล)
  const queueOrders = work.orders.filter(o => o.easyRestart && latestLetter(work.orders.find(x => x.orderId === o.easyRestart.fromOrderId) || {}));
  const queue = buildAlertQueue(queueOrders, TODAY, thaiHourNow());
  log('คิวแจ้งเตือนสำหรับ routine: ' + queue.length + ' รายการ ' + JSON.stringify(queue.map(q => q.kind + '@' + q.alertDate + ':' + q.newSo)));
  if (process.env.ALERT_FILE) {
    require('fs').mkdirSync(require('path').dirname(process.env.ALERT_FILE), { recursive: true });
    require('fs').writeFileSync(process.env.ALERT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), today: TODAY, items: queue }, null, 1));
    log('เขียนไฟล์คิวแล้ว: ' + process.env.ALERT_FILE);
  }
  if (DRY_RUN) { log('DRY RUN — ไม่เขียนข้อมูล ไม่ส่งข้อความ'); return; }
  if (!p.creates.length && !p.refreshes.length && !messages.length && !work.orders.some(o => o.easyRestart && o.easyRestart.alerts && o.easyRestart.alerts.paidFullQueued && !(state0.orders.find(x => x.orderId === o.orderId) || { easyRestart: { alerts: {} } }).easyRestart.alerts.paidFullQueued)) { log('ไม่มีอะไรต้องทำรอบนี้'); return; }

  const chats = alertChats();
  const sentKinds = []; // { orderId, kind, chat }
  // ส่งตรงจากสคริปต์ปิดไว้เป็นค่าเริ่มต้น (routine 09:00 เป็นผู้ส่ง) — เปิดด้วย DIRECT_SEND=1 เท่านั้น
  const beforeSendHour = process.env.DIRECT_SEND !== '1' || (thaiHourNow() < ALERT_SEND_HOUR_THAI && !process.env.FORCE_SEND);
  if (messages.length && beforeSendHour) log('ไม่ส่งตรงจากสคริปต์ (routine 09:00 เป็นผู้ส่ง หรือยังไม่ถึงเวลา) — ' + messages.length + ' รายการอยู่ในคิว');
  for (const m of beforeSendHour ? [] : messages) {
    if (!chats.length || !process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) { log('ไม่มี LARK_* — ข้ามการส่งแจ้งเตือน'); break; }
    const ordNow = work.orders.find(x => x.orderId === m.orderId);
    const done = (ordNow && ordNow.easyRestart && ordNow.easyRestart.alerts && ordNow.easyRestart.alerts.sent) || {};
    for (const c of chats) {
      if (done[m.kind + ':' + c]) continue;
      try { await larkSend(c, m.msg); sentKinds.push({ orderId: m.orderId, kind: m.kind, chat: c }); log('ส่งแจ้งเตือนแล้ว: ' + m.kind + ' ' + m.orderId + ' → ' + c); } catch (e) { log('ส่งแจ้งเตือนไม่สำเร็จ ' + m.orderId + ' → ' + c + ': ' + e.message); }
    }
  }

  if (!(await acquireLock(dtToken))) { log('ขอ lock ไม่สำเร็จ — ข้ามการเขียน (ข้อความที่ส่งแล้วอาจถูกส่งซ้ำรอบหน้า)'); process.exit(1); }
  let stateTouched = false;
  try {
    const state = await downloadState(dtToken);
    const changed = apply(state);
    work.orders.forEach(wo => {
      const q = wo.easyRestart && wo.easyRestart.alerts && wo.easyRestart.alerts.paidFullQueued;
      const so = q && state.orders.find(x => x.orderId === wo.orderId);
      if (so && so.easyRestart) { so.easyRestart.alerts = so.easyRestart.alerts || {}; if (!so.easyRestart.alerts.paidFullQueued) { so.easyRestart.alerts.paidFullQueued = q; stateTouched = true; } }
    });
    const stamp = TODAY + ' ' + new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 16);
    // จดว่าส่งไปกลุ่มไหนแล้ว (กันส่งซ้ำเมื่อบางกลุ่มส่งไม่สำเร็จ) — ครบทุกกลุ่มแล้วค่อยปิดเหตุการณ์ (paidFullAt/expiredAt)
    sentKinds.forEach(m => {
      const o = state.orders.find(x => x.orderId === m.orderId);
      if (!o || !o.easyRestart) return;
      const al = o.easyRestart.alerts = o.easyRestart.alerts || {};
      al.sent = al.sent || {};
      al.sent[m.kind + ':' + m.chat] = stamp;
      if (alertChats().every(c => al.sent[m.kind + ':' + c])) al[m.kind === 'paidFull' ? 'paidFullAt' : 'expiredAt'] = stamp;
    });
    if (changed || sentKinds.length || stateTouched) { await uploadState(dtToken, state); log('อัปโหลดสำเร็จ: เปลี่ยน ' + changed + ' บิล · บันทึกแจ้งเตือน ' + sentKinds.length); }
  } finally { await releaseLock(dtToken); }
})().catch(err => { log('FATAL: ' + err.message); process.exit(1); });

module.exports = { buildAlertQueue, buildScheduleDates, buildInstallments, paymentsFromTxs, allocatePayments, addBusinessDays, pendingAlerts, paidFullMessage, expiredMessage, outstandingOf, buildEasyRestartOrder, refreshEasyRestartOrder, plan };
