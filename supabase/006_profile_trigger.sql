-- ============================================================
-- SK Guard — Trigger สร้าง profile อัตโนมัติ (006_profile_trigger.sql)
-- รันใน Supabase Dashboard > SQL Editor (New query > Run) 1 ครั้ง
-- หลังจากรันแล้ว: ทุกครั้งที่สร้างบัญชีใหม่ใน Supabase Dashboard >
-- Authentication > Add user ระบบจะสร้างแถวใน public.profiles ให้เอง
-- ไม่ต้องสร้าง profile ด้วยมืออีก
--
-- วิธีเพิ่มผู้ใช้ใหม่ (แอดมินทำใน Supabase Dashboard):
--   1) Authentication > Add user
--   2) อีเมล: <ชื่อผู้ใช้>@skguard.local  (เช่น guard5@skguard.local)
--   3) ติ๊ก Auto Confirm (จะได้ล็อกอินได้ทันที ไม่ต้องยืนยันอีเมล)
--   4) กด Create user — trigger นี้จะสร้าง profile ให้อัตโนมัติ
--      (username = ส่วนหน้าของอีเมล, role เริ่มต้น = GUARD, เปิดใช้งาน)
--   5) กลับมาแก้ชื่อ-นามสกุล / บทบาท (ADMIN/GUARD) ได้ในหน้า "จัดการ" ของแอป
--
-- หมายเหตุ:
-- - profiles.id เป็น FK ไป auth.users — สร้างแถว profile ด้วยมือโดยไม่มี
--   Auth user มาก่อนไม่ได้ (จะ error) trigger นี้แก้ปัญหานั้น
-- - ถ้าบัญชีนั้นมี profile อยู่แล้ว trigger จะไม่สร้างซ้ำ (ON CONFLICT DO NOTHING)
-- - ห้ามใส่ secret key / service_role key ลงไฟล์นี้
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, full_name, role, is_active)
  values (
    new.id,
    split_part(new.email, '@', 1),
    null,
    'GUARD',
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
