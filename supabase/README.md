# SK Guard — Supabase Backend

ย้าย 100% จาก GAS + Google Sheets มา Supabase แล้ว รันไทม์ไม่ใช้ Sheets/GAS อีก
โฟลเดอร์นี้มีแค่ไฟล์ SQL + คำแนะนำ ไม่มี secret key ใดๆ

## ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `001_schema.sql` | สร้างตาราง `profiles`, `checkpoints`, `patrol_logs`, `settings` + เปิด RLS + policy |
| `002_seed.sql` | ใส่ข้อมูลจุดตรวจ 3 จุด + ตั้งค่า จากชีตเดิม (รันซ้ำได้ ไม่ซ้ำแถว) |
| `README.md` | ไฟล์นี้ — วิธีรันทีละขั้น |

## ทำไมต้องรันเอง

การสร้างตาราง (DDL) ทำได้เฉพาะผ่าน **SQL Editor ใน Supabase Dashboard** หรือใช้
**secret key / service_role key** เท่านั้น — publishable key ที่ใช้ในหน้าเว็บ
ทำ DDL ไม่ได้ และห้ามเอา secret key มาใส่ในแชทหรือในโค้ดหน้าเว็บเด็ดขาด

ดังนั้นตอนนี้**ตารางยังไม่ได้ถูกสร้าง** ต้องทำตามขั้นตอนด้านล่างเอง
(ใช้เวลาไม่เกิน 10 นาที)

## ขั้นตอนที่ 1 — รัน SQL สร้างตาราง

1. เปิด [Supabase Dashboard](https://supabase.com/dashboard) เลือกโปรเจกต์ **sk_guard**
   (URL: `https://bsgitjtttkldzksefrte.supabase.co`)
2. เมนูซ้าย เลือก **SQL Editor** > **New query**
3. เปิดไฟล์ `001_schema.sql` คัดลอกทั้งหมด วางลงในช่อง SQL แล้วกด **Run**
   - ถ้าขึ้น `Success. No rows returned` แปลว่าสำเร็จ
4. เปิด query ใหม่ วางเนื้อหาไฟล์ `002_seed.sql` แล้วกด **Run**
5. ตรวจสอบที่เมนู **Table Editor** ต้องเห็น 4 ตาราง:
   `profiles`, `checkpoints`, `patrol_logs`, `settings`
   - `checkpoints` ต้องมี 3 แถว: CP01, CP02, CP03
   - `settings` ต้องมี 4 แถว: site_name, default_radius_m, default_lat, default_lng
   - `patrol_logs` ว่าง (เหมือนในชีตเดิม) และ `profiles` ว่างจนกว่าจะทำขั้นที่ 2

## ขั้นตอนที่ 2 — สร้างบัญชีผู้ใช้ (Supabase Auth)

รหัสผ่านแบบ SHA-256 ในชีตเดิม**ย้ายมา Supabase Auth ไม่ได้** ต้องสร้างบัญชีใหม่
(ห้ามใช้รหัสผ่านเดิมซ้ำ และห้ามส่งรหัสผ่านมาทางแชท)

1. ใน Dashboard เลือก **Authentication** > **Users** > **Add user** > **Create new user**
2. สร้างผู้ใช้คนที่ 1:
   - **Email:** ใช้อีเมลจริงของแอดมิน เช่น `admin@skguard.local`
     (Auth ต้องใช้อีเมลเป็นชื่อล็อกอิน — ถ้าไม่มีอีเมลจริง ให้ใช้อีเมลสมมติลงท้าย
     `.local` แล้วจำไว้ว่าใช้ล็อกอินด้วยอีเมลนี้ ไม่ใช่ชื่อ `admin`)
   - **Password:** ตั้งรหัสผ่านใหม่ที่แข็งแรง จำไว้เอง
   - ติ๊ก **Auto Confirm User** (ถ้ามี) เพื่อไม่ต้องยืนยันอีเมลก่อนล็อกอิน
   - กด **Create user**
3. ทำซ้ำสำหรับผู้ใช้คนที่ 2 (ยาม): Email `guard1@skguard.local` + รหัสผ่านใหม่
4. คัดลอก **UUID (User UID)** ของทั้ง 2 คน จากหน้ารายชื่อผู้ใช้
   (คลิกที่แถวของผู้ใช้ จะเห็น UUID)

## ขั้นตอนที่ 3 — ผูก Auth user กับ profiles

1. กลับไปที่ **SQL Editor** > **New query**
2. รัน SQL นี้ โดยแทนที่ UUID ด้วยค่าจริงที่คัดลอกมาในขั้นที่ 2:

```sql
insert into public.profiles (id, username, full_name, role, is_active)
values
  ('<UUID ของ admin>',  'admin',  'ผู้ดูแลระบบ', 'ADMIN', true),
  ('<UUID ของ guard1>', 'guard1', 'ยาม 1',        'GUARD', true)
on conflict (id) do update set
  username  = excluded.username,
  full_name = excluded.full_name,
  role      = excluded.role,
  is_active = excluded.is_active;
```

3. ตรวจสอบที่ **Table Editor > profiles** ต้องมี 2 แถว: `admin` (ADMIN), `guard1` (GUARD)

> ตัวอย่าง SQL นี้อยู่ในท้ายไฟล์ `002_seed.sql` แบบ comment ไว้แล้ว

## โครงสร้างตาราง (สรุป)

| ตาราง | คอลัมน์สำคัญ |
|---|---|
| `profiles` | `id` (uuid, FK `auth.users.id`), `username` unique, `full_name`, `role` (ADMIN/GUARD), `is_active` |
| `checkpoints` | `code` (PK เช่น CP01), `name`, `lat`, `lng`, `radius_m` (ค่าเริ่มต้น 50), `is_active` |
| `patrol_logs` | `id` (uuid), `guard_id` (FK profiles), `guard_username`, `checkpoint_code` (FK checkpoints), `scanned_at`, `lat`, `lng`, `accuracy_m`, `distance_m`, `result` (PASS/FAIL), `remark`, `synced` |
| `settings` | `key` (PK), `value`, `updated_at` (อัปเดตอัตโนมัติ) |

## ความปลอดภัย (RLS)

- เปิด RLS ทุกตารางแล้ว ผู้ที่**ยังไม่ล็อกอิน (anon)** อ่าน/เขียนอะไรไม่ได้เลย
- ผู้ใช้ที่ล็อกอินแล้ว: อ่าน `checkpoints`/`settings` ได้, อ่าน/เขียน `patrol_logs` ของตัวเองได้
- เฉพาะ **ADMIN** เท่านั้นที่เพิ่ม/แก้/ลบ `checkpoints`, `profiles`, `settings` และลบ `patrol_logs` ได้
- หน้าเว็บ (PWA) ใช้แค่ **Project URL + publishable key** เท่านั้น ห้ามใส่ secret key ลง repo

## ข้อควรระวัง

- **Supabase แพ็กเกจฟรีจะหยุดชั่วคราว (pause) ถ้าไม่มีการใช้งาน 1 สัปดาห์**
  ถ้าใช้ตรวจเวรทุกวันจะไม่มีปัญหา ถ้าหยุดใช้หลายวันแล้วเข้าไม่ได้ ให้กด Resume
  ใน Dashboard แล้วรอประมาณ 1–2 นาที
- ถ้ารัน SQL แล้วขึ้น error ให้คัดลอกข้อความ error มาส่งให้ผู้ช่วยดู ห้ามเดา
  ว่าตารางถูกสร้างแล้ว — ต้องเห็นตารางใน Table Editor จึงถือว่าเสร็จ
