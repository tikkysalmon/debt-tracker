// ลบออเดอร์ที่ระบุ (ONLY_SO) ออกจาก state.json บน Supabase — ใช้เมื่อสัญญาถูกนำเข้าแต่ลูกค้ายังไม่ได้รับสินค้า
//
// ความปลอดภัย:
//   - DRY_RUN=true เป็นค่าเริ่มต้น: แสดงสรุปแบบไม่มีข้อมูลส่วนบุคคล (log ของ repo นี้เป็นสาธารณะ) แล้วจบ
//   - ปฏิเสธการลบถ้าออเดอร์นั้นมีงวดที่ชำระเงินแล้ว (amountPaid>0 หรือมี paidDate) เว้นแต่ FORCE=true
//   - ก่อนลบจะสำรองออเดอร์ทั้งก้อนไว้ที่ Supabase Storage (bucket app-data, private): backups/removed-<SO>-<เวลา>.json
//   - ลบเฉพาะออเดอร์ที่ระบุ ไม่แตะข้อมูลอื่น (แท็ก/หมายเหตุของลูกค้าคงอยู่)
// ENV: CRM_USERNAME CRM_PASSWORD (ใช้ล็อกอิน Supabase เหมือน import-contracts)  ONLY_SO  DRY_RUN  FORCE
const zlib = require('zlib');
const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kZHRmY2dhbmJ1eHpmZW5kZ2ZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2ODc3NzQsImV4cCI6MjA5OTI2Mzc3NH0.eseoVPBdM9fPOh8J8HyqVsBWCIjtG4eTGCRC1scVsTg';
const STALE_MS = 25000;
const MY_CLIENT_ID = 'gh-actions-remove-order-' + Date.now();
function log(msg) { console.log('[' + new Date().toISOString() + '] ' + msg); }
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

async function main() {
  const so = String(process.env.ONLY_SO || '').trim();
  const dry = String(process.env.DRY_RUN || 'true') !== 'false';
  const force = String(process.env.FORCE || 'false') === 'true';
  if (!/^SO-\d+$/.test(so)) throw new Error('ONLY_SO ต้องเป็นเลข SO รูปแบบ SO-xxxxxxxxxxxxx (ระบุได้ทีละ 1 รายการ)');
  const t = await debtTrackerLogin();
  if (dry) {
    const s = await downloadState(t);
    report(s, so);
    log('DRY-RUN: ไม่เขียนข้อมูล');
    return;
  }
  if (!(await acquireLock(t))) throw new Error('ขอ lock ไม่สำเร็จ — ลองใหม่');
  try {
    const state = await downloadState(t);
    const info = report(state, so);
    if (info.matches !== 1) throw new Error('ต้องพบออเดอร์นี้พอดี 1 รายการ แต่พบ ' + info.matches);
    if (info.refAsAccessory) throw new Error('SO นี้เป็นเลขอุปกรณ์เสริมของออเดอร์อื่น — ไม่ลบอัตโนมัติ');
    if (info.paidInst > 0 && !force) throw new Error('ออเดอร์นี้มีงวดที่ชำระแล้ว ' + info.paidInst + ' งวด — ไม่ลบ (ตั้ง FORCE=true ถ้ามั่นใจ)');
    const removed = state.orders.find(o => o.orderId === so);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bpath = 'backups/removed-' + so + '-' + stamp + '.json';
    const up = await fetch(SUPABASE_URL + '/storage/v1/object/app-data/' + bpath, { method: 'POST', headers: { Authorization: 'Bearer ' + t, apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(removed) });
    if (!up.ok) throw new Error('สำรองข้อมูลล้มเหลว (' + up.status + ') — ยกเลิกการลบ');
    log('สำรองออเดอร์ไว้ที่ app-data/' + bpath);
    const before = state.orders.length;
    state.orders = state.orders.filter(o => o.orderId !== so);
    if (state.orders.length !== before - 1) throw new Error('จำนวนออเดอร์หลังลบไม่ตรงคาด');
    await uploadState(t, state);
    log('ลบสำเร็จ: ออเดอร์ ' + before + ' → ' + state.orders.length);
    const verify = await downloadState(t);
    log('ตรวจซ้ำ: พบ ' + SO_COUNT(verify, so) + ' รายการของ ' + so + ' (ควรเป็น 0), รวม ' + verify.orders.length + ' ออเดอร์');
  } finally { await releaseLock(t); }
}
function SO_COUNT(s, so) { return s.orders.filter(o => o.orderId === so || o.accessoryOrderId === so).length; }
// สรุปแบบไม่มีชื่อ/เบอร์/อีเมล
function report(state, so) {
  const ms = state.orders.filter(o => o.orderId === so);
  const refAsAccessory = state.orders.some(o => o.orderId !== so && o.accessoryOrderId === so);
  log('จำนวนออเดอร์ทั้งหมด ' + state.orders.length + ' | พบ ' + so + ' = ' + ms.length + (refAsAccessory ? ' | ⚠️ ถูกอ้างเป็นอุปกรณ์เสริมของออเดอร์อื่น' : ''));
  let paidInst = 0;
  ms.forEach(o => {
    const all = (o.installments || []).concat(o.accessoryInstallments || []);
    paidInst = all.filter(i => Number(i.amountPaid) > 0.005 || i.paidDate).length;
    const hist = ['smsHistory', 'emailHistory', 'callHistory', 'letterHistory'].map(k => k + '=' + (Array.isArray(o[k]) ? o[k].length : 0)).join(' ');
    log('  สัญญา ' + (o.contractDate || '-') + ' | ' + (o.purchaseType || '-') + ' | importedFrom=' + (o.importedFrom || '-') + ' | ' + (o.installments || []).length + ' งวด | งวดที่ชำระแล้ว ' + paidInst + ' | ' + hist + ' | isBillCancelled/isCancelled=' + !!o.isBillCancelled + '/' + !!o.isCancelled);
    const sameCust = state.orders.filter(x => x.customerId === o.customerId && x.orderId !== so).length;
    log('  ลูกค้าคนเดียวกันมีออเดอร์อื่นอีก ' + sameCust + ' รายการ (จะไม่ถูกแตะ)');
  });
  return { matches: ms.length, paidInst, refAsAccessory };
}
main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
