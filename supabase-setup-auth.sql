-- ============================================================
-- ระบบติดตามหนี้ — เพิ่มระบบ Login + สิทธิ์การใช้งาน (2026-08)
-- วางทั้งหมดนี้ใน Supabase → SQL Editor → New query → Run
--
-- อย่ารันไฟล์นี้จนกว่าจะพร้อม deploy จริง — ขั้นตอนที่ 2 (ปิด bucket จากสาธารณะ) จะทำให้เว็บ
-- เวอร์ชันปัจจุบัน (ยังไม่มีหน้า login) เข้าไม่ถึงข้อมูลทันที ต้อง deploy โค้ดใหม่ (branch
-- feature/staff-auth) พร้อมกันในคราวเดียว ไม่งั้นพนักงานที่ใช้เว็บอยู่จะหลุดออกกลางคัน
-- ============================================================

-- 1) ตาราง staff_users — ข้อมูลพนักงาน/สิทธิ์ (แยกจาก auth.users ของ Supabase Auth ที่เก็บแค่
--    อีเมล/รหัสผ่านเข้ารหัส)
create table if not exists staff_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null,
  is_admin boolean not null default false,
  is_active boolean not null default true,
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
alter table staff_users enable row level security;

-- 2) Helper function — เช็คว่า uid ที่ให้มาเป็น admin ที่ยัง active อยู่ไหม
--    security definer เพื่อเลี่ยงปัญหา RLS อ้างอิงตัวเองแบบวนลูป (policy ของตารางนี้เรียกใช้ตารางนี้)
create or replace function is_staff_admin(uid uuid) returns boolean
language sql security definer stable as $$
  select coalesce((select is_admin and is_active from staff_users where id = uid), false);
$$;

-- 3) RLS: อ่านได้เฉพาะแถวตัวเอง หรือถ้าเป็น admin อ่านได้ทุกแถว (สำหรับหน้า "จัดการผู้ใช้งาน")
--    ไม่มี policy insert/update/delete ให้ anon/authenticated เลย — การสร้าง/แก้ไข/ลบบัญชีทั้งหมด
--    ต้องผ่าน /api/staff-admin (server-side, ใช้ SUPABASE_SERVICE_ROLE_KEY ซึ่ง bypass RLS อยู่แล้ว
--    และตรวจสิทธิ์ admin เองอีกชั้นก่อนทำงานทุกครั้ง — ดู api/staff-admin.js)
drop policy if exists "staff self or admin read" on staff_users;
create policy "staff self or admin read" on staff_users
  for select using (auth.uid() = id or is_staff_admin(auth.uid()));

-- 4) Storage bucket app-data — ปิดจากสาธารณะ (นี่คือจุดที่ปิดช่องโหว่ข้อมูลรั่วไหลจริงๆ)
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

-- ============================================================
-- ขั้นตอนสุดท้าย (ทำมือ, ครั้งเดียว): สร้างบัญชี Admin คนแรก
-- เพราะยังไม่มี admin คนไหนอยู่เลยที่จะกด "เพิ่มผู้ใช้งาน" ให้คนแรกได้ ต้องสร้างเองผ่าน
-- Dashboard ดังนี้:
--   1. Supabase Dashboard → Authentication → Users → Add user
--      กรอกอีเมล + รหัสผ่านของ Admin คนแรก, ติ๊ก "Auto Confirm User"
--   2. คัดลอก User UID ที่ได้ แล้วรันคำสั่งนี้ (แก้ค่าในเครื่องหมาย <...> ก่อนรัน):
--
--      insert into staff_users (id, email, display_name, is_admin, is_active, permissions)
--      values ('<UID ที่คัดลอกมา>', '<อีเมลเดียวกับข้อ 1>', '<ชื่อที่แสดง>', true, true, '{}'::jsonb);
--
-- จากนั้นบัญชีนี้จะล็อกอินเข้าเว็บได้ทันที และใช้เมนู "จัดการผู้ใช้งาน" สร้างบัญชีพนักงานคนอื่น
-- ต่อจากนี้ได้เอง ไม่ต้องทำขั้นตอนนี้ซ้ำอีก
-- ============================================================
