// Vercel serverless function — admin-only staff account management (create / update permissions /
// set password / activate-deactivate). Talks to Supabase's Auth Admin API and PostgREST directly
// via fetch (same zero-dependency pattern as send-sms.js / send-email.js — this repo has no
// package.json/build step, so no npm SDK can be required here).
//
// SUPABASE_SERVICE_ROLE_KEY must be set as a Vercel env var and must NEVER reach the client bundle
// (index.html only ever holds the anon key). Every request here re-verifies the CALLER's own
// Supabase session token and checks staff_users.is_admin for that caller before doing anything —
// the service-role key itself has no notion of "who's asking", so that check is entirely on us.
const SUPABASE_URL = 'https://mddtfcganbuxzfendgfi.supabase.co';

async function verifyCallerIsAdmin(callerToken, serviceRoleKey) {
  if (!callerToken) return { ok: false, status: 401, error: 'ไม่ได้ล็อกอิน' };
  const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { 'Authorization': 'Bearer ' + callerToken, 'apikey': serviceRoleKey }
  });
  if (!userRes.ok) return { ok: false, status: 401, error: 'เซสชันไม่ถูกต้องหรือหมดอายุ กรุณาล็อกอินใหม่' };
  const user = await userRes.json().catch(function () { return null; });
  if (!user || !user.id) return { ok: false, status: 401, error: 'เซสชันไม่ถูกต้อง' };

  const rowRes = await fetch(SUPABASE_URL + '/rest/v1/staff_users?id=eq.' + user.id + '&select=is_admin,is_active', {
    headers: { 'Authorization': 'Bearer ' + serviceRoleKey, 'apikey': serviceRoleKey }
  });
  if (!rowRes.ok) return { ok: false, status: 500, error: 'ตรวจสอบสิทธิ์ผู้ใช้ไม่สำเร็จ' };
  const rows = await rowRes.json().catch(function () { return []; });
  const row = rows && rows[0];
  if (!row || !row.is_admin || row.is_active === false) {
    return { ok: false, status: 403, error: 'ต้องเป็นผู้ดูแลระบบ (Admin) ที่ยังใช้งานได้เท่านั้น' };
  }
  return { ok: true, callerId: user.id };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า SUPABASE_SERVICE_ROLE_KEY บน server' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  const verify = await verifyCallerIsAdmin(callerToken, serviceRoleKey).catch(function (err) {
    return { ok: false, status: 500, error: err && err.message ? err.message : String(err) };
  });
  if (!verify.ok) { res.status(verify.status).json({ error: verify.error }); return; }

  const { action, payload } = req.body || {};
  const p = payload || {};
  const svHeaders = { 'Authorization': 'Bearer ' + serviceRoleKey, 'apikey': serviceRoleKey, 'Content-Type': 'application/json' };

  try {
    if (action === 'create') {
      const email = String(p.email || '').trim();
      const password = String(p.password || '');
      const displayName = String(p.displayName || '').trim();
      if (!email || !displayName) { res.status(400).json({ error: 'กรอกอีเมล/ชื่อให้ครบ' }); return; }
      if (password.length < 8) { res.status(400).json({ error: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร' }); return; }

      const createRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
        method: 'POST', headers: svHeaders,
        body: JSON.stringify({ email: email, password: password, email_confirm: true })
      });
      const created = await createRes.json().catch(function () { return null; });
      if (!createRes.ok) { res.status(createRes.status).json({ error: (created && (created.msg || created.error_description || created.message)) || 'สร้างบัญชีไม่สำเร็จ' }); return; }

      const insertRes = await fetch(SUPABASE_URL + '/rest/v1/staff_users', {
        method: 'POST', headers: Object.assign({}, svHeaders, { 'Prefer': 'return=representation' }),
        body: JSON.stringify({
          id: created.id, email: email, display_name: displayName,
          is_admin: !!p.isAdmin, permissions: p.permissions || {}, is_active: true, created_by: verify.callerId
        })
      });
      if (!insertRes.ok) {
        // Roll back the auth user so it doesn't dangle with no staff_users profile (would otherwise
        // let that email log in with zero permissions and no way for admin UI to see/manage it).
        await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + created.id, { method: 'DELETE', headers: svHeaders }).catch(function () {});
        const errBody = await insertRes.json().catch(function () { return null; });
        res.status(400).json({ error: (errBody && errBody.message) || 'บันทึกข้อมูลผู้ใช้ไม่สำเร็จ' });
        return;
      }
      res.status(200).json({ ok: true, userId: created.id });
      return;
    }

    if (action === 'update') {
      const userId = p.userId;
      if (!userId) { res.status(400).json({ error: 'ไม่มี userId' }); return; }
      const patch = {};
      if (p.displayName !== undefined) patch.display_name = String(p.displayName).trim();
      if (p.isAdmin !== undefined) patch.is_admin = !!p.isAdmin;
      if (p.permissions !== undefined) patch.permissions = p.permissions;
      if (p.isActive !== undefined) patch.is_active = !!p.isActive;
      if (Object.keys(patch).length) {
        const updRes = await fetch(SUPABASE_URL + '/rest/v1/staff_users?id=eq.' + userId, {
          method: 'PATCH', headers: svHeaders, body: JSON.stringify(patch)
        });
        if (!updRes.ok) { const eb = await updRes.json().catch(function () { return null; }); res.status(400).json({ error: (eb && eb.message) || 'อัปเดตไม่สำเร็จ' }); return; }
      }
      // is_active alone only blocks the NEXT login check — an already-open tab keeps a live session
      // until it expires, so also ban/unban the Auth account itself to cut that off immediately.
      if (p.isActive === false || p.isActive === true) {
        await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + userId, {
          method: 'PUT', headers: svHeaders,
          body: JSON.stringify({ ban_duration: p.isActive === false ? '876000h' : 'none' })
        }).catch(function () {});
      }
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'setPassword') {
      const userId = p.userId;
      const newPassword = String(p.newPassword || '');
      if (!userId || newPassword.length < 8) { res.status(400).json({ error: 'ข้อมูลไม่ครบ หรือรหัสผ่านสั้นเกินไป (ขั้นต่ำ 8 ตัวอักษร)' }); return; }
      const pwRes = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + userId, {
        method: 'PUT', headers: svHeaders, body: JSON.stringify({ password: newPassword })
      });
      if (!pwRes.ok) { const eb = await pwRes.json().catch(function () { return null; }); res.status(400).json({ error: (eb && (eb.msg || eb.message)) || 'ตั้งรหัสผ่านไม่สำเร็จ' }); return; }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: 'ไม่รู้จัก action: ' + action });
  } catch (err) {
    res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
};
