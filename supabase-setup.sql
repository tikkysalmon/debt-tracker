-- ============================================================
-- ระบบติดตามหนี้ — ตั้งค่าฐานข้อมูลกลาง (Supabase)
-- วางทั้งหมดนี้ใน Supabase → SQL Editor → New query → Run
--
-- โหมดเปิด (ไม่มีรหัสผ่าน) — ใครก็ตามที่มีลิงก์เว็บนี้อ่าน/แก้ไขข้อมูลได้ทันที
-- ไม่มีการตรวจสิทธิ์ใดๆ ที่ระดับฐานข้อมูล ตั้งใจเลือกแบบนี้เพื่อความสะดวก
-- ============================================================

-- 1) ตารางเก็บข้อมูลรวม (เปิด RLS = ห้ามเข้าถึงตรง เข้าได้ผ่าน 2 ฟังก์ชันด้านล่างเท่านั้น)
create table if not exists public.app_state (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.app_state (id, data) values (1, '{}'::jsonb)
  on conflict (id) do nothing;
alter table public.app_state enable row level security;

-- 2) ฟังก์ชันอ่านข้อมูล (เปิดกว้าง ไม่ตรวจรหัสผ่าน)
create or replace function public.get_state(pw text)
returns table(data jsonb, updated_at timestamptz, updated_by text)
language plpgsql security definer set search_path = public as $$
begin
  return query select s.data, s.updated_at, s.updated_by from public.app_state s where s.id = 1;
end; $$;

-- 3) ฟังก์ชันบันทึกข้อมูล (เปิดกว้าง ไม่ตรวจรหัสผ่าน)
create or replace function public.save_state(pw text, payload jsonb, client_id text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare ts timestamptz;
begin
  update public.app_state set data = payload, updated_at = now(), updated_by = client_id
    where id = 1 returning updated_at into ts;
  return ts;
end; $$;

-- 4) อนุญาตให้เรียกเฉพาะ 2 ฟังก์ชันนี้ (ตัวตารางยังล็อกอยู่)
revoke all on function public.get_state(text) from public;
revoke all on function public.save_state(text, jsonb, text) from public;
grant execute on function public.get_state(text) to anon, authenticated;
grant execute on function public.save_state(text, jsonb, text) to anon, authenticated;

-- ตาราง app_config (รหัสผ่านเดิม) ไม่ได้ใช้แล้ว — จะลบทิ้งก็ได้ (ไม่บังคับ):
-- drop table if exists public.app_config;
