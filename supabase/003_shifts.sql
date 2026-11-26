-- ============================================================
-- SK Guard — Shifts (003_shifts.sql)
-- รันใน Supabase Dashboard > SQL Editor ต่อจาก 001/002
-- ตารางกะตรวจเวร: 1 แถว ต่อ 1 กะของ 1 ยาม
-- แอปทำงานได้แม้ตารางนี้ยังไม่มี (fallback เก็บกะในเครื่อง)
-- ห้ามใส่ secret key / service_role key ลงไฟล์นี้
-- ============================================================

create table if not exists public.shifts (
  id               uuid primary key default gen_random_uuid(),
  guard_id         uuid references public.profiles (id) on delete set null,
  guard_username   text,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  status           text not null default 'active' check (status in ('active', 'complete', 'incomplete')),
  total_points     integer not null default 0,
  completed_codes  text[] not null default '{}',
  created_at       timestamptz not null default now()
);

create index if not exists shifts_guard_id_idx
  on public.shifts (guard_id);
create index if not exists shifts_started_at_idx
  on public.shifts (started_at desc);

alter table public.shifts enable row level security;

revoke all on public.shifts from anon;
grant select, insert, update, delete on public.shifts to authenticated;

-- ยามอ่าน/สร้าง/จบกะของตัวเองได้, ADMIN ดูทุกกะได้
drop policy if exists "shifts_select_own_or_admin" on public.shifts;
create policy "shifts_select_own_or_admin" on public.shifts
  for select to authenticated
  using (auth.uid() = guard_id or public.is_admin());

drop policy if exists "shifts_insert_own" on public.shifts;
create policy "shifts_insert_own" on public.shifts
  for insert to authenticated
  with check (auth.uid() = guard_id);

drop policy if exists "shifts_update_own_or_admin" on public.shifts;
create policy "shifts_update_own_or_admin" on public.shifts
  for update to authenticated
  using (auth.uid() = guard_id or public.is_admin())
  with check (auth.uid() = guard_id or public.is_admin());

drop policy if exists "shifts_delete_admin" on public.shifts;
create policy "shifts_delete_admin" on public.shifts
  for delete to authenticated
  using (public.is_admin());
