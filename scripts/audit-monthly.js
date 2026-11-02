// ตรวจสอบ read-only: สรุปยอดครบกำหนด/ชำระแล้ว/ค้างชำระ รายเดือน จาก state.json แล้วสุ่มเทียบยอดสะสมกับ CRM
// ไม่เขียนข้อมูลใดๆ และพิมพ์เฉพาะยอดรวมรายเดือน (ไม่พิมพ์รายออเดอร์ เพราะ repo เป็น public)
const zlib = require('zlib');
const CRM_BASE = 'https://api.salmonphone.com';
const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';
const KEY = require('fs').readFileSync(__dirname + '/reconcile.js', 'utf8').match(/SUPABASE_ANON_KEY = '([^']+)'/)[1];
const U = process.env.CRM_USERNAME, P = process.env.CRM_PASSWORD;
const n = v => Number(v) || 0;
const r2 = v => Math.round(v * 100) / 100;
const email = c => 'staff-' + String(c).trim().toLowerCase().replace(/[^a-z0-9]/g, '') + '@debttracker.internal';
const ym = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})/); return m ? m[1] + '-' + m[2] : 'ไม่มีวันที่'; };
const fmt = v => Math.round(v).toLocaleString('en-US');
let crmToken;
async function crmGet(p) {
  for (let k = 0; k < 4; k++) {
    const r = await fetch(CRM_BASE + p, { headers: { Authorization: 'Bearer ' + crmToken } });
    if (r.status === 429) { await new Promise(x => setTimeout(x, 2000)); continue; }
    const d = await r.json().catch(() => null);
    return r.ok && d && !d.errorCode ? d : null;
  }
  return null;
}
(async () => {
  const lg = await (await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify({ email: email(U), password: P }) })).json();
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/state.json?_=' + Date.now(), { headers: { Authorization: 'Bearer ' + lg.access_token, apikey: KEY } });
  const buf = Buffer.from(await res.arrayBuffer());
  const st = JSON.parse((buf[0] === 0x1f ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  const crmLg = await (await fetch(CRM_BASE + '/crm/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: U, password: P }) })).json();
  crmToken = crmLg.token;
  const cancelled = o => o.wasCancelled || o.wasSold || (o.installments || []).concat(o.accessoryInstallments || []).some(i => i.status === 'ยกเลิกสัญญา คืนเครื่อง');
  const M = {}; const get = k => M[k] || (M[k] = { due: 0, paid: 0, out: 0, outNoPay: 0, outPartial: 0, nInst: 0, nOut: 0, canceledOut: 0, paidInMonth: 0, ordersOut: new Set() });
  for (const o of st.orders) {
    const can = cancelled(o);
    for (const i of (o.installments || []).concat(o.accessoryInstallments || [])) {
      const m = get(ym(i.dueDate)); const due = n(i.amountDue) - n(i.discount), paid = n(i.amountPaid);
      const out = Math.max(0, due - paid);
      if (can) { m.canceledOut += out; continue; }
      m.due += due; m.paid += paid; m.nInst++;
      if (out > 0.5) { m.out += out; m.nOut++; (paid > 0 ? (m.outPartial += out) : (m.outNoPay += out)); m.ordersOut.add(o.orderId); }
      if (paid > 0) get(ym(i.paidDate)).paidInMonth += paid;
    }
  }
  console.log('เดือนครบกำหนด | งวด | ยอดครบกำหนด | ชำระแล้ว | ค้าง | (ไม่เคยจ่ายเลย) | (จ่ายบางส่วน) | ค้างในออเดอร์ยกเลิก/ขายต่อ(ไม่นับ) | ยอดที่รับชำระโดยวันที่จ่าย=เดือนนี้');
  Object.keys(M).sort().forEach(k => { const m = M[k]; if (k >= '2026-01' || k === 'ไม่มีวันที่') console.log([k, m.nInst, fmt(m.due), fmt(m.paid), fmt(m.out), fmt(m.outNoPay), fmt(m.outPartial), fmt(m.canceledOut), fmt(m.paidInMonth)].join(' | ')); });
  // เทียบกับ CRM: ออเดอร์ที่มีงวดค้างเดือนละ N รายแรก (สุ่มเรียงตามเลข) -> ยอดคงเหลือ app vs CRM
  const byId = {}; st.orders.forEach(o => { byId[o.orderId] = o; });
  for (const mon of ['2026-10', '2026-09', '2026-08', '2026-07']) {
    const ids = [...(M[mon] ? M[mon].ordersOut : [])].filter(id => /^SO-\d{13}$/.test(id));
    const sample = ids.filter((_, idx) => idx % Math.max(1, Math.floor(ids.length / 400)) === 0).slice(0, 400);
    let same = 0, diff = 0, err = 0, diffAmt = 0, crmClosed = 0, crmClosedAmt = 0;
    let idx = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (idx < sample.length) {
      const id = sample[idx++]; const o = byId[id];
      const s = await crmGet('/crm/sale-order/' + id);
      if (!s) { err++; continue; }
      const t = (o.installments || []);
      const appRem = t.reduce((a, i) => a + n(i.amountDue) - n(i.discount) - n(i.amountPaid), 0) - (o._discountAppliedToInstallments ? 0 : n(o.discount));
      const crmRem = n(s.productPrice) - (s.discounts || []).reduce((a, d) => a + n(d.amount), 0) - n(s.accumulatedAmount);
      if (Math.abs(appRem - crmRem) < 1) same++; else { diff++; diffAmt += appRem - crmRem; }
      if (s.status === 'COMPLETED' || Math.abs(crmRem) < 1) { crmClosed++; crmClosedAmt += appRem; }
    } }));
    console.log('CRM check เดือน ' + mon + ': ออเดอร์ค้างทั้งหมด ' + ids.length + ' สุ่มเทียบ ' + sample.length + ' | ตรงกับ CRM ' + same + ' | ไม่ตรง ' + diff + ' (ส่วนต่าง app-CRM รวม ' + fmt(diffAmt) + ') | CRM ปิดยอดแล้วแต่ app ยังค้าง ' + crmClosed + ' (' + fmt(crmClosedAmt) + ') | เรียก CRM ไม่ได้ ' + err);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
