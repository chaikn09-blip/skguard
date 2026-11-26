-- ============================================================
-- SK Guard — Supabase schema (001_schema.sql)
-- รันใน Supabase Dashboard > SQL Editor (New query > Run)
-- โปรเจกต์: bsgitjtttkldzksefrte (https://bsgitjtttkldzksefrte.supabase.co)
-- ย้าย 100% จาก GAS + Google Sheets — ไม่ใช้ Sheets/GAS ที่รันไทม์แล้ว
-- ไฟล์นี้สร้างเฉพาะโครงสร้างตาราง + RLS + policy เท่านั้น
-- ข้อมูลเริ่มต้นอยู่ใน 002_seed.sql (รันต่อจากไฟล์นี้)
-- ห้ามใส่ secret key / service_role key ลงไฟล์นี้หรือในโค้ด frontend
-- ============================================================

-- gen_random_uuid() ต้องใช้ pgcrypto (Supabase เปิดไว้อยู่แล้วตามปกติ)
create extension if not exists "pgcrypto";

-- ---------- ตาราง profiles ----------
-- 1 แถว ต่อ 1 Auth user (auth.users.id) — รหัสผ่านเก็บใน Supabase Auth เท่านั้น
-- ห้าม seed รหัสผ่าน SHA-256 เดิมจากชีต เพราะย้ายมา Auth ไม่ได้
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique,
  full_name  text,
  role       text not null check (role in ('ADMIN', 'GUARD')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- ตาราง checkpoints ----------
create table if not exists public.checkpoints (
  code       text primary key,
  name       text not null,
  lat        numeric(10, 7) not null,
  lng        numeric(10, 7) not null,
  radius_m   integer not null default 50 check (radius_m > 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- ตาราง patrol_logs ----------
create table if not exists public.patrol_logs (
  id               uuid primary key default gen_random_uuid(),
  guard_id         uuid references public.profiles (id) on delete set null,
  guard_username   text,
  checkpoint_code  text references public.checkpoints (code) on delete restrict,
  scanned_at       timestamptz not null default now(),
  lat              numeric(10, 7),
  lng              numeric(10, 7),
  accuracy_m       numeric(8, 2),
  distance_m       numeric(10, 2),
  result           text check (result in ('PASS', 'FAIL')),
  remark           text,
  synced           boolean not null default true,
  created_at       timestamptz not null default now()
);

create index if not exists patrol_logs_guard_id_idx
  on public.patrol_logs (guard_id);
create index if not exists patrol_logs_checkpoint_code_idx
  on public.patrol_logs (checkpoint_code);
create index if not exists patrol_logs_scanned_at_idx
  on public.patrol_logs (scanned_at desc);

-- ---------- ตาราง settings ----------
create table if not exists public.settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- อัปเดต updated_at อัตโนมัติเมื่อมีการแก้ไข settings
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security (RLS)
-- หลักการ: anon (ยังไม่ล็อกอิน) เข้าถึงตารางใดๆ ไม่ได้เลย
-- authenticated (ล็อกอินแล้ว) อ่าน checkpoints/settings ได้,
-- อ่าน/เขียน patrol_logs ของตัวเองได้, ADMIN จัดการทุกอย่างได้
-- ============================================================

alter table public.profiles     enable row level security;
alter table public.checkpoints  enable row level security;
alter table public.patrol_logs  enable row level security;
alter table public.settings     enable row level security;

-- ฟังก์ชันช่วยเช็กว่าเป็น ADMIN หรือไม่
-- security definer = รันโดยข้าม RLS จึงไม่เกิด recursion
-- ตอนเช็ก policy ของ profiles เอง
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'ADMIN'
      and is_active
  );
$$;

-- ---------- สิทธิ์ระดับ role (กัน anon เขียน/อ่านทุกอย่าง) ----------
revoke all on public.profiles, public.checkpoints,
  public.patrol_logs, public.settings from anon;
grant select, insert, update, delete
  on public.profiles, public.checkpoints,
     public.patrol_logs, public.settings
  to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.set_updated_at() to authenticated;

-- ---------- profiles ----------
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select to authenticated
  using (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_insert_admin" on public.profiles;
create policy "profiles_insert_admin" on public.profiles
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists "profiles_update_own_or_admin" on public.profiles;
create policy "profiles_update_own_or_admin" on public.profiles
  for update to authenticated
  using (auth.uid() = id or public.is_admin())
  with check (auth.uid() = id or public.is_admin());

drop policy if exists "profiles_delete_admin" on public.profiles;
create policy "profiles_delete_admin" on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- ---------- checkpoints ----------
drop policy if exists "checkpoints_select_authenticated" on public.checkpoints;
create policy "checkpoints_select_authenticated" on public.checkpoints
  for select to authenticated
  using (true);

drop policy if exists "checkpoints_insert_admin" on public.checkpoints;
create policy "checkpoints_insert_admin" on public.checkpoints
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists "checkpoints_update_admin" on public.checkpoints;
create policy "checkpoints_update_admin" on public.checkpoints
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "checkpoints_delete_admin" on public.checkpoints;
create policy "checkpoints_delete_admin" on public.checkpoints
  for delete to authenticated
  using (public.is_admin());

-- ---------- patrol_logs ----------
drop policy if exists "patrol_logs_select_own_or_admin" on public.patrol_logs;
create policy "patrol_logs_select_own_or_admin" on public.patrol_logs
  for select to authenticated
  using (auth.uid() = guard_id or public.is_admin());

drop policy if exists "patrol_logs_insert_own" on public.patrol_logs;
create policy "patrol_logs_insert_own" on public.patrol_logs
  for insert to authenticated
  with check (auth.uid() = guard_id);

drop policy if exists "patrol_logs_update_own_or_admin" on public.patrol_logs;
create policy "patrol_logs_update_own_or_admin" on public.patrol_logs
  for update to authenticated
  using (auth.uid() = guard_id or public.is_admin())
  with check (auth.uid() = guard_id or public.is_admin());

drop policy if exists "patrol_logs_delete_admin" on public.patrol_logs;
create policy "patrol_logs_delete_admin" on public.patrol_logs
  for delete to authenticated
  using (public.is_admin());

-- ---------- settings ----------
drop policy if exists "settings_select_authenticated" on public.settings;
create policy "settings_select_authenticated" on public.settings
  for select to authenticated
  using (true);

drop policy if exists "settings_insert_admin" on public.settings;
create policy "settings_insert_admin" on public.settings
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists "settings_update_admin" on public.settings;
create policy "settings_update_admin" on public.settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "settings_delete_admin" on public.settings;
create policy "settings_delete_admin" on public.settings
  for delete to authenticated
  using (public.is_admin());
