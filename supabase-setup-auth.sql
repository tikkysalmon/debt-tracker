-- ============================================================
-- ระบบติดตามหนี้ — เพิ่มระบบ Login + สิทธิ์การใช้งาน (2026-08)
-- วางทั้งหมดนี้ใน Supabase → SQL Editor → New query → Run
--
-- แบ่งเป็น 2 เฟส ตั้งใจให้รันคนละเวลากัน อย่ารันรวดเดียวทั้งไฟล์:
--   เฟส A (บรรทัด 1-45)  — ปลอดภัย รันตอนไหนก็ได้ ไม่กระทบเว็บที่ใช้งานอยู่เลย เพราะยังไม่แตะ
--                          bucket สาธารณะ — สร้างตาราง + สร้างบัญชี Admin คนแรกได้ทันที
--   [ ที่นี่ค่อย deploy โค้ดใหม่ (branch feature/staff-auth ขึ้น main) แล้วล็อกอินด้วยบัญชี
--     Admin ที่เพิ่งสร้าง ไปสร้างบัญชีพนักงานคนอื่นให้ครบก่อน ]
--   เฟส B (บรรทัดท้ายไฟล์) — ปิด bucket จากสาธารณะจริง รันเมื่อสร้างบัญชีพนักงานที่จำเป็นครบแล้ว
--                          เท่านั้น — รันก่อนมีบัญชี Admin จะล็อกทุกคนออกจากระบบทันทีรวมถึงตัวเอง
--
-- Login ด้วย "รหัสพนักงาน" ไม่ใช่อีเมล — Supabase Auth ต้องมีอีเมลเสมอ จึงสร้างอีเมลปลอม
-- ที่คำนวณได้แน่นอนจากรหัสพนักงาน (เช่น รหัส "ACC001" -> "staff-acc001@debttracker.internal")
-- ไม่ใช่อีเมลจริงที่ใครเปิดอ่านได้ ใช้แค่เป็น "กุญแจ" ภายในของระบบ auth เท่านั้น — ดู
-- employeeCodeToEmail() ในทั้ง index.html (ฝั่งเข้าสู่ระบบ) และ api/staff-admin.js (ฝั่งสร้างบัญชี)
-- ============================================================

-- ============================================================
-- เฟส A — รันได้เลยตอนนี้ ก่อน deploy โค้ดใหม่ก็ได้ ไม่กระทบเว็บปัจจุบัน
-- ============================================================

-- 1) ตาราง staff_users — ข้อมูลพนักงาน/สิทธิ์ (แยกจาก auth.users ของ Supabase Auth ที่เก็บแค่
--    อีเมล/รหัสผ่านเข้ารหัส)
create table if not exists staff_users (
  id uuid primary key references auth.users(id) on delete cascade,
  employee_code text not null unique,     -- ใช้ล็อกอินแทนอีเมล เช่น "ACC001"
  email text not null,                    -- อีเมลปลอมที่คำนวณจาก employee_code (ดูด้านบน) — ไม่ใช่อีเมลจริง
  first_name text not null default '',
  last_name text not null default '',
  nickname text not null default '',
  department text not null default '',    -- Department/ตำแหน่ง — ค่าที่รับได้จำกัดตาม DEPARTMENT_OPTIONS (ดู index.html/api/staff-admin.js), enforced ที่แอปไม่ใช่ระดับ DB
  is_admin boolean not null default false,
  is_active boolean not null default true,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
alter table staff_users enable row level security;

-- 2) Helper function — เช็คว่า uid ที่ให้มาเป็น admin ที่ยัง active อยู่ไหม
--    security definer เพื่อเลี่ยงปัญหา RLS อ้างอิงตัวเองแบบวนลูป (policy ของตารางนี้เรียกใช้ตารางนี้)
--    set search_path เพื่อกันช่องโหว่มาตรฐานของ SECURITY DEFINER ใน Postgres — ถ้าไม่ล็อก
--    search_path ไว้ ผู้เรียกที่มีสิทธิ์สร้าง schema/ตารางในเซสชันตัวเองอาจตั้ง search_path ให้ชี้ไป
--    ตาราง staff_users ปลอมที่ควบคุมเองแทนตารางจริงได้
create or replace function is_staff_admin(uid uuid) returns boolean
language sql security definer stable
set search_path = public, pg_temp as $$
  select coalesce((select is_admin and is_active from staff_users where id = uid), false);
$$;

-- 3) RLS: อ่านได้เฉพาะแถวตัวเอง หรือถ้าเป็น admin อ่านได้ทุกแถว (สำหรับหน้า "จัดการผู้ใช้งาน")
--    ไม่มี policy insert/update/delete ให้ anon/authenticated เลย — การสร้าง/แก้ไข/ลบบัญชีทั้งหมด
--    ต้องผ่าน /api/staff-admin (server-side, ใช้ SUPABASE_SERVICE_ROLE_KEY ซึ่ง bypass RLS อยู่แล้ว
--    และตรวจสิทธิ์ admin เองอีกชั้นก่อนทำงานทุกครั้ง — ดู api/staff-admin.js)
drop policy if exists "staff self or admin read" on staff_users;
create policy "staff self or admin read" on staff_users
  for select using (auth.uid() = id or is_staff_admin(auth.uid()));

-- ============================================================
-- ขั้นตอนสร้างบัญชี Admin คนแรก (ทำมือ, ครั้งเดียว) — ยังอยู่ในเฟส A ปลอดภัย
-- เพราะยังไม่มี admin คนไหนอยู่เลยที่จะกด "เพิ่มพนักงาน" ให้คนแรกได้ ต้องสร้างเองผ่าน
-- Dashboard ดังนี้:
--   1. ตั้งค่ารหัสพนักงานที่จะใช้เป็น Admin คนแรก เช่น ADMIN001 แล้วคำนวณอีเมลปลอมด้วยมือ
--      ตามสูตรเดียวกับที่ระบบใช้ (ดูฟังก์ชัน employeeCodeToEmail): เอารหัสพนักงานมา lowercase
--      แล้วตัดอักขระที่ไม่ใช่ a-z0-9 ออก ต่อด้วย "@debttracker.internal"
--      เช่น "ADMIN001" -> "staff-admin001@debttracker.internal"
--   2. Supabase Dashboard → Authentication → Users → Add user
--      กรอกอีเมลปลอมที่คำนวณได้ + ตั้งรหัสผ่าน (ต้องมีตัวเล็ก+ใหญ่+ตัวเลข+อักขระพิเศษ อย่างน้อย 8 ตัว),
--      ติ๊ก "Auto Confirm User"
--   3. คัดลอก User UID ที่ได้ แล้วรันคำสั่งนี้ (แก้ค่าในเครื่องหมาย <...> ก่อนรัน):
--
--      insert into staff_users (id, employee_code, email, first_name, last_name, nickname, department, is_admin, is_active, permissions)
--      values ('<UID ที่คัดลอกมา>', 'ADMIN001', 'staff-admin001@debttracker.internal', '<ชื่อ>', '<นามสกุล>', '<ชื่อเล่น>', 'ผู้ดูแลระบบ', true, true, '{}'::jsonb);
--
-- ทำได้ตอนนี้เลย ก่อน deploy โค้ดใหม่ก็ได้ ไม่กระทบใครเพราะ bucket ยังเปิดสาธารณะอยู่
-- ============================================================

-- ============================================================
-- >>> ถึงจุดนี้: ให้ deploy โค้ดใหม่ (merge feature/staff-auth → main, push) และตั้ง env var
--     SUPABASE_SERVICE_ROLE_KEY บน Vercel ก่อน แล้วลองล็อกอินด้วยบัญชี Admin ที่เพิ่งสร้างดู
--     ให้แน่ใจว่าเข้าได้จริง จากนั้นใช้เมนู "จัดการผู้ใช้งาน" สร้างบัญชีพนักงานที่จำเป็นให้ครบ
--     ก่อนจะรันเฟส B ด้านล่าง — รันเฟส B ก่อนมีบัญชีพร้อมจะทำให้ทุกคน (รวมถึงคุณ) ยังเข้าเว็บได้
--     ปกติผ่านหน้า login ที่ deploy ไปแล้ว เพียงแต่ยังไม่มีใครนอกจาก Admin ที่ล็อกอินได้ ซึ่งก็คือ
--     สถานะที่ตั้งใจไว้พอดีในช่วงนี้ — เฟส B แค่ปิดช่องโหว่ที่คนนอก (ไม่มีบัญชีเลย) ยังเข้าถึงข้อมูล
--     ผ่าน Storage URL ตรงๆ ได้อยู่จนกว่าจะรัน
-- ============================================================

-- ============================================================
-- เฟส B — รันเมื่อสร้างบัญชีพนักงานที่จำเป็นครบแล้วเท่านั้น (นี่คือจุดที่ปิดช่องโหว่ข้อมูล
-- รั่วไหลจริงๆ — เปลี่ยน bucket จากที่ใครก็อ่าน/เขียนได้ ให้ต้องล็อกอินก่อนเท่านั้น)
-- ============================================================

-- 4) Storage bucket app-data — ปิดจากสาธารณะ
update storage.buckets set public = false where id = 'app-data';

-- 5) ลบ policy แบบเปิดกว้าง (anon) เดิมทิ้ง แล้วสร้างใหม่ให้เฉพาะ authenticated เท่านั้น
drop policy if exists "app-data anon read" on storage.objects;
drop policy if exists "app-data anon insert" on storage.objects;
drop policy if exists "app-data anon update" on storage.objects;
create policy "app-data authenticated read" on storage.objects
  for select to authenticated using (bucket_id = 'app-data');
create policy "app-data authenticated insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'app-data');
create policy "app-data authenticated update" on storage.objects
  for update to authenticated using (bucket_id = 'app-data');

-- เท่านี้เสร็จสมบูรณ์ — จากนี้ทุกคนต้องล็อกอินด้วยรหัสพนักงานก่อนถึงจะเห็น/แก้ข้อมูลได้
