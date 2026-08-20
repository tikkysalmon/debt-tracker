// Shared Supabase Storage + app_state_sync lock helpers for the anonymous (no-login)
// ตัดจำหน่ายหนี้สูญ approval flow — api/writeoff-view.js (read) and api/writeoff-action.js (write)
// both require() this. Uses the SERVICE ROLE key (full RLS bypass) — NEVER expose this key, or any
// function here, to client-side code; only api/*.js (which run server-side on Vercel) may import it.
//
// Talks to Supabase over plain REST (no @supabase/supabase-js — this project has no package.json or
// build step, same as every other file under api/). The lock-acquire/steal/release logic below is a
// deliberate line-for-line port of tryAcquireSaveLockOnce/acquireSaveLock/releaseSaveLock in
// index.html (search those names there) — an anonymous approval click and a staff member's own
// cloudSaveNow() both contend for the SAME app_state_sync row, so this endpoint MUST use the exact
// same protocol or it could silently clobber a concurrent staff save (see that file's extensive
// comments on why the lock exists at all — this was a real, previously-shipped bug).
//
// state.json itself is large (~15-20MB per project notes) — downloadState/uploadState move the
// whole file each call, same as the browser client does; there is no cheaper partial-write option
// with Storage-file-backed state (a real Postgres row would need the RPC path that was abandoned
// for statement_timeout reasons — see supabase-setup.sql's history).

const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';
const BUCKET = 'app-data';
const STATE_FILE = 'state.json';
const SAVE_LOCK_STALE_MS = 25000; // must match index.html's SAVE_LOCK_STALE_MS exactly
const ACQUIRE_DEADLINE_MS = 33000; // must match index.html's acquireSaveLock deadline exactly

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY ยังไม่ได้ตั้งค่าบน server');
  return { apikey: key, Authorization: 'Bearer ' + key };
}

// Same display format as index.html's nowTimestamp() (dd/mm/yyyy HH:MM) — every other history log
// in this app (sms/letter/call/restructure/postpone) uses this exact shape, so writeoffHistory
// entries written from here must match or downstream display/parsing (dmyToIso, esc(h.at) etc.)
// breaks for entries created via this anonymous path.
function nowTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

async function tryAcquireOnce(clientId) {
  const nowIso = new Date().toISOString();
  const res = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=is.null', {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=representation' }, serviceHeaders()),
    body: JSON.stringify({ locked_by: clientId, locked_at: nowIso })
  });
  const rows = await res.json().catch(() => []);
  if (res.ok && Array.isArray(rows) && rows.length) return true;

  // Nobody free — check whether the current holder's lock is stale (crashed tab) and steal it, CAS'd
  // against the exact owner just read (mirrors index.html's own steal logic precisely).
  const readRes = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&select=locked_by,locked_at', {
    headers: serviceHeaders()
  });
  const readRows = await readRes.json().catch(() => []);
  const row = readRows && readRows[0];
  if (!row || !row.locked_by || !row.locked_at) return false;
  if (Date.now() - new Date(row.locked_at).getTime() < SAVE_LOCK_STALE_MS) return false;
  const stealRes = await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(row.locked_by), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=representation' }, serviceHeaders()),
    body: JSON.stringify({ locked_by: clientId, locked_at: nowIso })
  });
  const stealRows = await stealRes.json().catch(() => []);
  return !!(stealRes.ok && Array.isArray(stealRows) && stealRows.length);
}

async function acquireLock(clientId) {
  const deadline = Date.now() + ACQUIRE_DEADLINE_MS;
  for (;;) {
    let ok = false;
    try { ok = await tryAcquireOnce(clientId); } catch (e) { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 300 + Math.random() * 400));
  }
}

async function releaseLock(clientId) {
  try {
    await fetch(SUPABASE_URL + '/rest/v1/app_state_sync?id=eq.1&locked_by=eq.' + encodeURIComponent(clientId), {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, serviceHeaders()),
      body: JSON.stringify({ locked_by: null, locked_at: null })
    });
  } catch (e) { /* best-effort, same as index.html's releaseSaveLock */ }
}

async function downloadState() {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + STATE_FILE, {
    headers: serviceHeaders()
  });
  if (!res.ok) throw new Error('โหลดข้อมูลกลางไม่สำเร็จ (' + res.status + ')');
  return res.json();
}

async function uploadState(state) {
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + STATE_FILE, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': '0' }, serviceHeaders()),
    body: JSON.stringify(state)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('บันทึกข้อมูลกลางไม่สำเร็จ (' + res.status + ') ' + detail);
  }
}

async function signedPdfUrl(path, expiresInSeconds) {
  if (!path) return null;
  const res = await fetch(SUPABASE_URL + '/storage/v1/object/sign/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, serviceHeaders()),
    body: JSON.stringify({ expiresIn: expiresInSeconds || 24 * 3600 })
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.signedURL) return null;
  return SUPABASE_URL + '/storage/v1' + data.signedURL;
}

// Every order whose LATEST writeoffHistory entry carries this batchId — same grouping rule as
// writeoffPendingBatchesGrouped in index.html, reimplemented here since server code can't import
// from the client bundle (no shared module between the two).
function findBatchOrders(state, batchId) {
  return (state.orders || []).filter((o) => {
    const hist = o.writeoffHistory || [];
    const latest = hist.length ? hist[hist.length - 1] : null;
    return latest && latest.batchId === batchId;
  });
}

module.exports = { acquireLock, releaseLock, downloadState, uploadState, signedPdfUrl, findBatchOrders, nowTimestamp };
