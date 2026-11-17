// สำรอง state.json อัตโนมัติ + เฝ้าระวังข้อมูลถูกล้าง (ตั้งขึ้นหลังข้อมูลหายเมื่อ 2026-11-10 และ 2026-11-17)
// - ดาวน์โหลด state.json (ไบต์ดิบ ไม่แปลงอะไร) แล้วเก็บเป็น app-data/backups/state-<เวลา>.json.gz
// - เทียบจำนวนออเดอร์กับ backup ล่าสุด: ถ้าลดเกิน 20% = ผิดปกติ → เก็บเป็น backups/suspect-<เวลา>.json.gz
//   (ไม่นับเป็น backup ปกติ ไม่ลบของเดิม) แล้ว exit 1 เพื่อให้ GitHub Actions ล้มเหลว/ส่งอีเมลแจ้งเตือน
// - เขียนเฉพาะโฟลเดอร์ backups/ — ไม่เขียน/ไม่แก้ state.json เด็ดขาด
// - ลบ backup เก่า: เก็บ KEEP_RECENT ไฟล์ล่าสุด + ไฟล์แรกของแต่ละวันย้อนหลัง KEEP_DAILY_DAYS วัน (ลบไม่ได้ = แค่เตือน)
// ใช้ Secrets เดียวกับ reconcile (CRM_USERNAME / CRM_PASSWORD = บัญชีพนักงานในระบบ)
const zlib = require('zlib');

const SUPABASE_URL = process.env.SUPABASE_URL_OVERRIDE || 'https://mddtfcganbuxzfendgfi.supabase.co'; // override ใช้ทดสอบกับเซิร์ฟเวอร์จำลองเท่านั้น
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || require('fs').readFileSync(__dirname + '/reconcile.js', 'utf8').match(/SUPABASE_ANON_KEY = '([^']+)'/)[1];
const USERNAME = process.env.CRM_USERNAME, PASSWORD = process.env.CRM_PASSWORD;
const BUCKET = 'app-data', PREFIX = 'backups';
const MIN_ORDERS_TO_COMPARE = 200, MAX_DROP = 0.2;
const KEEP_RECENT = 16, KEEP_DAILY_DAYS = 30;
const DAILY = process.env.BACKUP_MODE === 'daily', DAILY_PREFIX = PREFIX + '/daily', DAILY_KEEP_DAYS = 31; // โหมดรายวัน: 1 ไฟล์/วัน (เวลาไทย) เก็บ 31 วัน

function log(m) { console.log('[' + new Date().toISOString() + '] ' + m); }
function employeeCodeToEmail(code) {
  return 'staff-' + String(code || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') + '@debttracker.internal';
}
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-'); } // 20261117-020000 (UTC)
function parseState(buf) {
  const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  return JSON.parse((gz ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}

async function login() {
  const res = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: employeeCodeToEmail(USERNAME), password: PASSWORD }),
  });
  const d = await res.json();
  if (!res.ok || !d.access_token) throw new Error('login failed: ' + JSON.stringify(d));
  return d.access_token;
}
const H = t => ({ Authorization: 'Bearer ' + t, apikey: SUPABASE_ANON_KEY });

async function downloadRaw(t, path) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path + '?_=' + Date.now(), { cache: 'no-store', headers: H(t) });
  if (!res.ok) throw new Error('download ' + path + ' failed: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}
async function listBackups(t) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H(t)),
    body: JSON.stringify({ prefix: PREFIX, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error('list backups failed: ' + res.status);
  return (await res.json()).filter(f => /^state-\d{8}-\d{6}\.json\.gz$/.test(f.name));
}
async function upload(t, path, buf) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'cache-control': '0' }, H(t)), body: buf, // POST = ห้ามทับไฟล์เดิม (ไม่ใส่ x-upsert)
  });
  if (!res.ok) throw new Error('upload ' + path + ' failed: ' + res.status + ' ' + (await res.text()));
}
async function prune(t, files) {
  const names = files.map(f => f.name).sort(); // เก่า → ใหม่
  const keep = new Set(names.slice(-KEEP_RECENT));
  const cutoff = new Date(Date.now() - KEEP_DAILY_DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const seenDay = new Set();
  names.forEach(n => { const day = n.slice(6, 14); if (day >= cutoff && !seenDay.has(day)) { seenDay.add(day); keep.add(n); } });
  const del = names.filter(n => !keep.has(n)).map(n => PREFIX + '/' + n);
  if (!del.length) return;
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET, {
    method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, H(t)), body: JSON.stringify({ prefixes: del }),
  });
  log(res.ok ? 'ลบ backup เก่า ' + del.length + ' ไฟล์' : 'WARN: ลบ backup เก่าไม่สำเร็จ (' + res.status + ') — ข้ามได้ ไม่กระทบข้อมูล');
}

function thaiDate(ms) { return new Date((ms || Date.now()) + 7 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''); } // YYYYMMDD ตามเวลาไทย

// ---- สำรอง "ทุกอย่าง" (โหมดรายวัน) ----
// 1) extras bundle (รายวัน เก็บ 31 วัน): ตาราง staff_users + ไฟล์ขนาดเล็กใน bucket (ไฟล์ root ≤1MB, assets, writeoffs, easy-restart-*)
// 2) mirror (เพิ่มเฉพาะไฟล์ใหม่ ไม่ลบ): letters/ และ cancel-letters/ (ใหญ่ ~2GB) คัดลอกฝั่งเซิร์ฟเวอร์ไปที่ backups/mirror/
const SMALL_FOLDERS = ['assets', 'writeoffs', 'easy-restart-box-photos', 'easy-restart-box-sheets', 'easy-restart-letters'];
const MIRROR_FOLDERS = ['letters', 'cancel-letters'], MIRROR_PREFIX = PREFIX + '/mirror';
const JH = t => Object.assign({ 'Content-Type': 'application/json' }, H(t));

async function listAll(t, prefix) { // คืน [{name(เต็ม), size}] ของไฟล์ทั้งหมดใต้ prefix (ลงลึกทุกโฟลเดอร์)
  const out = [];
  async function walk(p) {
    for (let off = 0; ; off += 1000) {
      const res = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, { method: 'POST', headers: JH(t), body: JSON.stringify({ prefix: p, limit: 1000, offset: off, sortBy: { column: 'name', order: 'asc' } }) });
      if (!res.ok) throw new Error('list ' + p + ' failed: ' + res.status);
      const items = await res.json();
      for (const f of items) {
        const full = p ? p + '/' + f.name : f.name;
        if (f.id === null) await walk(full); else out.push({ name: full, size: (f.metadata && f.metadata.size) || 0 });
      }
      if (items.length < 1000) break;
    }
  }
  await walk(prefix);
  return out;
}
async function pool(items, n, fn) {
  let i = 0, fail = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { fail++; log('WARN: ' + e.message); } }
  }));
  return fail;
}
async function extrasBundle(t) {
  const bundle = { createdAt: new Date().toISOString(), files: {} };
  const su = await fetch(SUPABASE_URL + '/rest/v1/staff_users?select=*', { headers: H(t) });
  if (!su.ok) throw new Error('staff_users failed: ' + su.status);
  bundle.staff_users = await su.json();
  const root = (await listAll(t, '')).filter(f => !f.name.includes('/') && f.size <= 1048576 && !/^state/.test(f.name));
  const small = []; for (const d of SMALL_FOLDERS) small.push(...await listAll(t, d));
  const files = root.concat(small);
  await pool(files, 6, async f => { bundle.files[f.name] = (await downloadRaw(t, f.name)).toString('base64'); });
  log('extras: staff_users ' + bundle.staff_users.length + ' แถว, ไฟล์ ' + Object.keys(bundle.files).length + '/' + files.length);
  if (Object.keys(bundle.files).length !== files.length) throw new Error('extras: ดาวน์โหลดไฟล์ไม่ครบ');
  return zlib.gzipSync(Buffer.from(JSON.stringify(bundle)));
}
async function mirrorFiles(t) {
  let copied = 0, total = 0, fail = 0;
  for (const d of MIRROR_FOLDERS) {
    const src = await listAll(t, d);
    const have = new Set((await listAll(t, MIRROR_PREFIX + '/' + d)).map(f => f.name.slice(MIRROR_PREFIX.length + 1)));
    const todo = src.filter(f => !have.has(f.name));
    total += src.length;
    fail += await pool(todo, 8, async f => {
      const res = await fetch(SUPABASE_URL + '/storage/v1/object/copy', { method: 'POST', headers: JH(t), body: JSON.stringify({ bucketId: BUCKET, sourceKey: f.name, destinationKey: MIRROR_PREFIX + '/' + f.name }) });
      if (!res.ok) throw new Error('copy ' + f.name + ' failed: ' + res.status + ' ' + (await res.text()).slice(0, 100));
      copied++;
    });
  }
  log('mirror: คัดลอกใหม่ ' + copied + ' ไฟล์ (ทั้งหมดต้นทาง ' + total + ', ล้มเหลว ' + fail + ')');
  if (fail) console.error('::warning::mirror คัดลอกไม่สำเร็จ ' + fail + ' ไฟล์ — รอบถัดไปจะลองใหม่');
}

// สำรองรายวัน (รัน 00:00 น. เวลาไทย): backups/daily/daily-YYYYMMDD.json.gz — มีของวันนี้แล้วข้าม, ลบไฟล์ที่เก่ากว่า 31 วัน
async function dailyBackup(t) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/list/' + BUCKET, {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H(t)),
    body: JSON.stringify({ prefix: DAILY_PREFIX, limit: 1000, sortBy: { column: 'name', order: 'asc' } }),
  });
  if (!res.ok) throw new Error('list daily failed: ' + res.status);
  const names = (await res.json()).map(f => f.name).filter(n => /^daily-\d{8}(-extras)?\.json\.gz$/.test(n));
  const today = thaiDate(), file = 'daily-' + today + '.json.gz';
  if (names.includes(file)) { log('มี backup รายวันของ ' + today + ' แล้ว — ข้าม'); }
  else {
    const raw = await downloadRaw(t, 'state.json');
    const cur = parseState(raw);
    const n = Array.isArray(cur.orders) ? cur.orders.length : -1;
    if (n < 0) throw new Error('state.json อ่านได้แต่ไม่มี orders');
    if (n === 0) console.error('::warning::state.json มี 0 ออเดอร์ — เก็บสำเนาไว้ตามปกติ แต่ควรตรวจข้อมูลทันที');
    const gz = (raw[0] === 0x1f && raw[1] === 0x8b) ? raw : zlib.gzipSync(raw);
    await upload(t, DAILY_PREFIX + '/' + file, gz);
    log('สำรองรายวัน: app-data/' + DAILY_PREFIX + '/' + file + ' (' + Math.round(gz.length / 1024) + ' KB, ' + n + ' ออเดอร์)');
    names.push(file);
  }
  const extrasFile = 'daily-' + today + '-extras.json.gz';
  if (!names.includes(extrasFile)) {
    const gz = await extrasBundle(t);
    await upload(t, DAILY_PREFIX + '/' + extrasFile, gz);
    log('สำรอง extras: ' + extrasFile + ' (' + Math.round(gz.length / 1024) + ' KB)');
    names.push(extrasFile);
  }
  await mirrorFiles(t);
  const cutoff = thaiDate(Date.now() - DAILY_KEEP_DAYS * 864e5);
  const del = names.filter(x => x.slice(6, 14) < cutoff).map(x => DAILY_PREFIX + '/' + x);
  if (!del.length) return;
  const d = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET, {
    method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, H(t)), body: JSON.stringify({ prefixes: del }),
  });
  log(d.ok ? 'ลบ backup รายวันที่เก่ากว่า 1 เดือน ' + del.length + ' ไฟล์' : 'WARN: ลบ backup รายวันเก่าไม่สำเร็จ (' + d.status + ')');
}

(async () => {
  if (!USERNAME || !PASSWORD) throw new Error('ต้องตั้ง CRM_USERNAME / CRM_PASSWORD');
  const t = await login();
  if (DAILY) return dailyBackup(t);
  const raw = await downloadRaw(t, 'state.json');
  const cur = parseState(raw);
  const curCount = Array.isArray(cur.orders) ? cur.orders.length : -1;
  if (curCount < 0) throw new Error('state.json อ่านได้แต่ไม่มี orders');
  const files = await listBackups(t);
  let prevCount = null, prevName = null;
  if (files.length) {
    prevName = files[files.length - 1].name;
    const prev = parseState(await downloadRaw(t, PREFIX + '/' + prevName));
    prevCount = Array.isArray(prev.orders) ? prev.orders.length : null;
  }
  log('state.json orders=' + curCount + ' | backup ล่าสุด ' + (prevName || '(ไม่มี)') + ' orders=' + prevCount);
  if (prevCount !== null && prevCount >= MIN_ORDERS_TO_COMPARE && curCount < prevCount * (1 - MAX_DROP)) {
    const p = PREFIX + '/suspect-' + stamp() + '.json.gz';
    await upload(t, p, raw);
    console.error('::error::ออเดอร์ลดลงผิดปกติ ' + prevCount + ' → ' + curCount + ' (เก็บสำเนาไว้ที่ app-data/' + p + ', backup ปกติล่าสุดคือ ' + prevName + ') — ตรวจ state.json ทันที');
    process.exitCode = 1;
    return;
  }
  const gzBuf = (raw[0] === 0x1f && raw[1] === 0x8b) ? raw : zlib.gzipSync(raw);
  const path = PREFIX + '/state-' + stamp() + '.json.gz';
  await upload(t, path, gzBuf);
  log('สำรองแล้ว: app-data/' + path + ' (' + Math.round(gzBuf.length / 1024) + ' KB, ' + curCount + ' ออเดอร์)');
  await prune(t, files.concat([{ name: path.slice(PREFIX.length + 1) }]));
})().catch(e => { console.error('::error::' + e.message); process.exit(1); });
