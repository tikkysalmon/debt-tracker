-- ============================================================
-- ระบบติดตามหนี้ — ตั้งค่าฐานข้อมูลกลาง (Supabase)
-- วางทั้งหมดนี้ใน Supabase → SQL Editor → New query → Run
-- ก่อนกด Run: แก้ 'ใส่รหัสผ่านของทีมตรงนี้' เป็นรหัสผ่านที่ต้องการ
-- ============================================================

-- 1) ตารางเก็บข้อมูลรวม (เปิด RLS = ห้ามเข้าถึงตรง)
create table if not exists public.app_state (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.app_state (id, data) values (1, '{}'::jsonb)
  on conflict (id) do nothing;
alter table public.app_state enable row level security;

-- 2) ตารางเก็บรหัสผ่านร่วม (เปิด RLS = ห้ามเข้าถึงตรง)
create table if not exists public.app_config (k text primary key, v text);
alter table public.app_config enable row level security;

-- >>> เปลี่ยนรหัสผ่านตรงนี้ <<<
insert into public.app_config (k, v) values ('password', 'ใส่รหัสผ่านของทีมตรงนี้')
  on conflict (k) do update set v = excluded.v;

-- 3) ฟังก์ชันอ่านข้อมูล (ตรวจรหัสผ่านฝั่งเซิร์ฟเวอร์)
create or replace function public.get_state(pw text)
returns table(data jsonb, updated_at timestamptz, updated_by text)
language plpgsql security definer set search_path = public as $$
begin
  if pw is distinct from (select v from public.app_config where k = 'password') then
    raise exception 'unauthorized';
  end if;
  return query select s.data, s.updated_at, s.updated_by from public.app_state s where s.id = 1;
end; $$;

-- 4) ฟังก์ชันบันทึกข้อมูล (ตรวจรหัสผ่าน)
create or replace function public.save_state(pw text, payload jsonb, client_id text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare ts timestamptz;
begin
  if pw is distinct from (select v from public.app_config where k = 'password') then
    raise exception 'unauthorized';
  end if;
  update public.app_state set data = payload, updated_at = now(), updated_by = client_id
    where id = 1 returning updated_at into ts;
  return ts;
end; $$;

-- 5) อนุญาตให้เรียกเฉพาะ 2 ฟังก์ชันนี้ (ตัวตารางยังล็อกอยู่)
revoke all on function public.get_state(text) from public;
revoke all on function public.save_state(text, jsonb, text) from public;
grant execute on function public.get_state(text) to anon, authenticated;
grant execute on function public.save_state(text, jsonb, text) to anon, authenticated;
