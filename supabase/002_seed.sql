-- ============================================================
-- SK Guard — Seed data (002_seed.sql)
-- รันต่อจาก 001_schema.sql ใน Supabase Dashboard > SQL Editor
-- ข้อมูลย้ายมาจาก Google Sheets เดิม (sk_guard)
-- รันซ้ำได้ (ON CONFLICT ... DO UPDATE) ไม่สร้างแถวซ้ำ
-- patrol_logs ว่างเหมือนในชีตเดิม จึงไม่ seed
-- profiles ไม่ seed ในไฟล์นี้ — ต้องสร้าง Auth user ก่อน
-- ดูวิธีสร้างได้ใน README.md ของโฟลเดอร์นี้
-- ============================================================

-- ---------- checkpoints (3 จุด จากชีตเดิม, รัศมี 50 ม. ทุกจุด) ----------
insert into public.checkpoints (code, name, lat, lng, radius_m, is_active)
values
  ('CP01', 'ป้อมยามประตู 1',            17.765,    100.56,     50, true),
  ('CP02', 'อาคารสันเขื่อน',             17.7662,   100.5615,   50, true),
  ('CP03', 'อาคารที่ทำการเขื่อนสิริกิติ์', 17.744768, 100.557775, 50, true)
on conflict (code) do update set
  name      = excluded.name,
  lat       = excluded.lat,
  lng       = excluded.lng,
  radius_m  = excluded.radius_m,
  is_active = excluded.is_active;

-- ---------- settings (จากชีตเดิม) ----------
insert into public.settings (key, value)
values
  ('site_name',        'เขื่อนสิริกิติ์'),
  ('default_radius_m', '50'),
  ('default_lat',      '17.765'),
  ('default_lng',      '100.56')
on conflict (key) do update set
  value = excluded.value;

-- ---------- patrol_logs ----------
-- ว่าง (เหมือนในชีตเดิม) — ไม่ต้อง seed

-- ============================================================
-- profiles — ตัวอย่าง SQL (ยังไม่ต้องรันจนกว่าจะสร้าง Auth user แล้ว)
-- ขั้นตอน: สร้าง Auth user admin / guard1 ใน Dashboard ก่อน
-- (Authentication > Users > Add user) แล้วคัดลอก UUID ของแต่ละคน
-- มาแทนที่ '<UUID ของ admin>' / '<UUID ของ guard1>' ด้านล่าง
-- รหัสผ่านตั้งตอนสร้าง Auth user — ห้ามใส่รหัสผ่านลงไฟล์ SQL นี้
-- ============================================================
-- insert into public.profiles (id, username, full_name, role, is_active)
-- values
--   ('<UUID ของ admin>',  'admin',  'ผู้ดูแลระบบ', 'ADMIN', true),
--   ('<UUID ของ guard1>', 'guard1', 'ยาม 1',        'GUARD', true)
-- on conflict (id) do update set
--   username  = excluded.username,
--   full_name = excluded.full_name,
--   role      = excluded.role,
--   is_active = excluded.is_active;
