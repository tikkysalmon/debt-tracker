-- ============================================================
-- ระบบติดตามหนี้ — ตั้งค่าฐานข้อมูลกลาง (Supabase)
-- วางทั้งหมดนี้ใน Supabase → SQL Editor → New query → Run
--
-- โหมดเปิด (ไม่มีรหัสผ่าน) — ใครก็ตามที่มีลิงก์เว็บนี้อ่าน/แก้ไขข้อมูลได้ทันที
-- ไม่มีการตรวจสิทธิ์ใดๆ ที่ระดับฐานข้อมูล ตั้งใจเลือกแบบนี้เพื่อความสะดวก
--
-- ข้อมูลจริงมีขนาด ~15-20MB (JSONB ก้อนเดียว) — บันทึกผ่านตาราง Postgres ธรรมดาแล้วเจอ
-- "canceling statement due to statement timeout" เพราะ Supabase จำกัดเวลา query ของ
-- role anon/authenticated ไว้ที่ระดับแพลตฟอร์ม (แก้ด้วย SET LOCAL statement_timeout ในฟังก์ชัน
-- ไม่ได้ผล) จึงเปลี่ยนมาเก็บเป็นไฟล์ใน Supabase Storage แทน ซึ่งไม่ผ่าน query engine เลย
-- ============================================================

-- 1) Storage bucket สำหรับเก็บไฟล์ข้อมูลรวม (state.json)
insert into storage.buckets (id, name, public)
values ('app-data', 'app-data', true)
on conflict (id) do nothing;

-- 2) อนุญาตให้ anon อ่าน/เขียนเฉพาะใน bucket นี้ (เปิดกว้างตามที่ตั้งใจไว้)
drop policy if exists "app-data anon read" on storage.objects;
drop policy if exists "app-data anon insert" on storage.objects;
drop policy if exists "app-data anon update" on storage.objects;
create policy "app-data anon read" on storage.objects
  for select to anon using (bucket_id = 'app-data');
create policy "app-data anon insert" on storage.objects
  for insert to anon with check (bucket_id = 'app-data');
create policy "app-data anon update" on storage.objects
  for update to anon using (bucket_id = 'app-data');

-- ============================================================
-- ตารางเดิม (public.app_state, get_state, save_state) ไม่ได้ใช้แล้วหลังจากนี้ — ปล่อยไว้เฉยๆ
-- ก็ได้ ไม่กระทบอะไร หรือจะลบทิ้งก็ได้ (ไม่บังคับ):
-- drop function if exists public.get_state(text);
-- drop function if exists public.save_state(text, jsonb, text);
-- drop table if exists public.app_state;
-- drop table if exists public.app_config;
-- ============================================================
