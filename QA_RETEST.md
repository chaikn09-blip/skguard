# QA Retest Report — SK Guard PWA (รอบทดสอบซ้ำหลังแก้ B1–B7, G1/G3/G4/G5/G6/G9)

วันที่ทดสอบ: 27 พ.ย. 2026 (01:11 น.)
ผู้ทดสอบ: QA Tester อิสระ (ไม่ได้แก้โค้ด ไม่ได้เขียนโค้ดใหม่)
ไฟล์ที่ทดสอบ: `~/workspace/sk-guard-pwa/` — app.js (62,297 bytes), index.html (14,598 bytes), styles.css, manifest.webmanifest, sw.js, icons, `supabase/003_shifts.sql` (ใหม่, 2,434 bytes)
รายงานเดิม: `QA_REPORT.md` (27 พ.ย. 2026 01:04 น., Blocker B1–B7)

## วิธีทดสอบที่ใช้ (และข้อจำกัด)

- อ่านโค้ดทุกส่วนที่แก้แบบบรรทัดต่อบรรทัด, `node --check` ผ่านทั้ง app.js / sw.js, manifest JSON ผ่าน
- เสิร์ฟไฟล์ด้วย `python3 -m http.server` แล้ว curl: ทุกไฟล์ local ได้ HTTP 200 (index.html, app.js, config.js, styles.css, manifest, sw.js, icons, supabase/003_shifts.sql)
- ทดสอบฟังก์ชันจริงใน Node + jsdom (ติดตั้งชั่วคราวใน /tmp/qatest ไม่ได้แตะโค้ดแอป): โหลด index.html + app.js จริง, stub geolocation / Html5Qrcode / Supabase client, เรียกฟังก์ชันจริง (`startShift`, `endShift`, `startLiveScan`, `handleQrFileScan`, `handleScanned`, `refreshScanCalc`, `submitScan`, `applyAuthUser`, `loadSettings`, `translateLoginError`, `haversine`) แล้วตรวจ DOM จริง
  - Harness หลัก: **30/30 ผ่าน** (กะ, Location gate, GPS เก่า, accuracy, บันทึก, กันซ้ำ, B6, B4, G9)
  - Harness เสริม (Haversine 49/50/51, Location ปฏิเสธ, กล้องปฏิเสธ, G3/G4/G6 ด้วย mock Supabase): **7/7 + 6/6 ผ่าน**
  - Harness เสริม 2 (ถ่ายรูปตอน Location ปิด, จบกะครบ 3 จุด, เริ่มกะซ้ำ): **4/4 ผ่าน**
  - รวม **47 checks ผ่านทั้งหมด 0 ไม่ผ่าน** (ครั้งแรกที่รัน harness มี 11 fail แต่พิสูจน์แล้วว่าเป็น artifact ของ harness เอง — jsdom ยิง DOMContentLoaded ซ้ำทำให้ `checkSession()` เรียก `setLoggedOut()` หลังล็อกอิน, และ mock `sb` ที่ inject ผ่าน `window.eval` ครั้งที่สองมองไม่เห็น `let sb` ของ eval ครั้งแรก; แก้ harness ให้รอ DOMContentLoaded ธรรมชาติ และ inject mock Supabase ผ่าน `window.supabase.createClient` ก่อนโหลด app.js แล้วทุกข้อผ่าน)
- ตรวจ SQL ด้วย `pglast` (PostgreSQL parser): 001 = 52 statements, 002 = 2, **003_shifts.sql = 14 statements ผ่าน**
- ตรวจ Supabase จริงด้วย publishable key: `GET /rest/v1/checkpoints` ยังตอบ `PGRST205: Could not find the table 'public.checkpoints'` — **ตารางจริงยังไม่ได้ถูกสร้าง** ดังนั้นล็อกอิน/บันทึก/RLS จริงยังทดสอบไม่ได้ (เหมือนรอบแรก เป็นข้อจำกัดที่รู้อยู่แล้ว ไม่ใช่บั๊กของโค้ดรอบนี้)
- **ไม่ได้ทดสอบด้วยเบราว์เซอร์จริง / มือถือจริง**: ถอดรหัส QR จากภาพจริง (เบลอ/เอียง/แสงสะท้อน/ถ่ายจากจอ), GPS ที่เขื่อนจริงตรง CP01–CP03, Add to Home Screen, พิมพ์ QR ลงกระดาษ, เปิด CSV ใน Excel — ต้องทดสอบซ้ำบนเครื่องจริงก่อนใช้งานจริง

## สรุปผล — B1–B7 ผ่านทั้งหมด

| ข้อ | ผล | หลักฐาน |
|---|---|---|
| B1 ระบบกะ | ✅ ผ่าน | ปุ่มเริ่มกะ/จบกะ (`index.html` shift-card, `app.js:313 startShift`, `:330 endShift`, `:358 renderShift`), แสดง `X/N จุด (Y%)` + รายการตรวจแล้ว/จุดที่เหลือ, สแกนไม่ได้ถ้ายังไม่เริ่มกะ (harness: สแกนก่อนเริ่มกะถูกบล็อกด้วย “กรุณากดเริ่มกะก่อนสแกน QR”), จบกะสรุปครบ/ขาด (harness: ตรวจ 1/3 แล้วจบกะได้ alert “ยังขาด 2 จุด”, ตรวจครบ 3/3 ได้ “ตรวจครบทุกจุด ✅”), `supabase/003_shifts.sql` parse ผ่าน ชื่อคอลัมน์ตรงกับ app.js ทุกจุด (`guard_id, guard_username, started_at, ended_at, status, total_points, completed_codes` — insert ใน `startShift`, update ใน `endShift`, select ใน `loadActiveShiftFromDb`, RLS ใช้ `public.is_admin()` ที่มีอยู่แล้วใน 001) |
| B2 Location gate | ✅ ผ่าน | `ensureLocationReady()` (`app.js:470`) ถูกเรียกก่อนสแกนสด (`:602`) และถ่ายรูป (`:637`) ทุกครั้ง; ทดสอบจริง: ปฏิเสธสิทธิ์ Location → `startLiveScan` ไม่เปิดกล้อง, `ensureLocationReady()` คืน `false`, ข้อความภาษาไทยบอกวิธีเปิด Location (Chrome แตะ 🔒 > สิทธิ์ของไซต์ > ตำแหน่ง, iPhone การตั้งค่า > ความเป็นส่วนตัว > บริการตำแหน่งที่ตั้ง); ถ่ายรูปตอน Location ปิดถูกบล็อกก่อนเรียก `scanFile` จริง (harness: `scanFile` ไม่ถูกเรียก) |
| B3 GPS เก่า | ✅ ผ่าน | `GPS_FRESH_MS = 15000` (`app.js:23`), `isFreshPos()` (`:453`, `Date.now() - timestamp <= 15000`) ถูกเช็กที่ `ensureLocationReady`, `refreshScanCalc` (`:574`), `submitScan` (`:700` และ `:713` เช็กซ้ำหลังตั้ง `savingScan`); ทดสอบจริง: GPS อายุ 20 วินาที → ปุ่มยืนยัน disabled, ข้อความ “ตำแหน่ง GPS เก่าเกิน 15 วินาที”, `submitScan` ไม่บันทึกอะไรเลย (คิวออฟไลน์คง 0 รายการ) |
| B4 กรอกรหัสเอง | ✅ ผ่าน | ช่องกรอกรหัสบน Dashboard หายไปแล้ว (grep `btn-manual` ได้ 0 ผล, ใน `index.html` เหลือแค่ `admin-test-code` ในหน้า Admin); `previewCheckpoint()` (`app.js:657`) ตั้งแค่ข้อความ `admin-test-result` ไม่ตั้ง `scanned`, ไม่เปิด `scan-card`, ไม่เปิดปุ่มยืนยัน (harness: ทดสอบ CP02 ได้ข้อความ “พบจุดตรวจ … (ดูข้อมูลเท่านั้น ไม่นับเป็นการตรวจ)” และ `scan-card` ยังซ่อนอยู่) |
| B5 loadProfiles | ✅ ผ่าน | `loadProfiles()` (`app.js:938`) ใช้ `.order('username')` แล้ว — `profiles` ใน schema ไม่มีคอลัมน์ `email` ปัญหาเดิมหายไป (ตรวจโค้ด + ตรวจชื่อคอลัมน์เทียบ 001_schema.sql) |
| B6 ยังไม่ล็อกอิน | ✅ ผ่าน | `bottomnav` มีคลาส `hidden` ตั้งต้นใน `index.html:207`, `setLoggedOut()` (`app.js:108`) ซ่อนกลับ, `showView()` (`:72`) บังคับกลับ `login` ถ้า `!currentUser` และบล็อกหน้า Admin ถ้า role ไม่ใช่ ADMIN, คลิก nav ตรวจ `!currentUser` ก่อน (`:968`); ทดสอบจริง: เปิด Dashboard/Admin ตอนยังไม่ล็อกอิน → กลับหน้า login, หลัง logout แถบล่างซ่อนกลับ |
| B7 Accuracy > 30 ม. | ✅ ผ่าน | `ACCURACY_LIMIT_M = 30` (`app.js:24`); `refreshScanCalc` (`:584`) ตั้งปุ่มยืนยัน `disabled = true` พร้อมข้อความ “บล็อก” (ไม่ใช่แค่เตือน), `submitScan` (`:705`, `:713`) บล็อกซ้ำก่อนบันทึก; ทดสอบจริง: accuracy ±50 ม. → ปุ่มยืนยัน disabled, accuracy 8 ม. → เปิดกลับ |
| G1 กดยืนยันซ้ำ | ✅ ผ่าน | `savingScan` กันระหว่างบันทึก (`:695`), `afterSaved()` (`:758`) ล้าง `scanned = null`, ซ่อน `scan-card`, ปิดปุ่มยืนยัน; ทดสอบจริง: บันทึกแล้วการ์ดหายทันที, สแกนจุดเดิมซ้ำในกะถูกบล็อก “ตรวจ PASS แล้วในกะนี้” |
| G3 บัญชีถูกปิด | ✅ ผ่าน | `applyAuthUser` (`:131`) เช็ก `data.is_active === false` → signOut + ข้อความไทย “บัญชีนี้ถูกปิดใช้งานแล้ว”; ทดสอบจริงด้วย mock Supabase: คืน `false` และเรียก `signOut` แล้ว |
| G4 Role fallback | ✅ ผ่าน | ไม่มีโค้ดให้ ADMIN จากอีเมลแล้ว (เหลือแค่คอมเมนต์อธิบายว่าเอาออกแล้วที่ `:146`); ทดสอบจริง: อีเมล `admin@skguard.local` แต่ไม่มีแถว profiles → ถูกบล็อก + signOut, ไม่ได้สิทธิ์ ADMIN; มีแถว profiles จริงจึงล็อกอินได้ตรง role (GUARD → “ยาม 1 (GUARD)”, ADMIN → “แอดมิน (ADMIN)”) |
| G5 กล้องถูกปฏิเสธ | ✅ ผ่าน | `startLiveScan` จับ `NotAllowedError` (`:615`) แสดงวิธีเปิดสิทธิ์กล้องภาษาไทย (Chrome 🔒 > กล้อง, iPhone การตั้งค่า > Safari > กล้อง) และบอกว่ายังใช้ “ถ่ายรูปสแกน” ได้; ทดสอบจริง: throw `NotAllowedError` → ข้อความดังกล่าว กล้องไม่เปิด |
| G6 อ่าน settings | ✅ ผ่าน | `loadSettings()` (`app.js:254`) อ่านตาราง `settings` จริง (site_name, default_radius_m, default_lat/lng) และตั้งชื่อไซต์/หัวเว็บ; ทดสอบจริงด้วย mock Supabase: ชื่อไซต์เปลี่ยนเป็น “เขื่อนทดสอบ” |
| G9 Error ไทย | ✅ ผ่าน | `translateLoginError()` (`:161`) แปล Invalid credentials / Email not confirmed / User not found / rate limit / network เป็นภาษาไทย; ทดสอบจริง 2 เคสแรกผ่าน |

## ตรวจเพิ่มเติม (ผ่าน)

- Haversine 49/50/51 ม.: 49.00 / 50.0000 / 51.00 ม. ตรงตามเส้นแบ่ง
- ID ที่ app.js ใช้ 80 ตัว มีครบใน index.html (0 ตัวหาย)
- `node --check` ผ่านทั้ง app.js / sw.js, manifest JSON ผ่าน, เสิร์ฟ local ได้ HTTP 200 ทุกไฟล์
- ไม่มี `google.script.run`, ไม่มี secret key / service_role key (คำว่า `admin@skguard.local` ที่เจอ 2 จุดคือข้อมูล Demo ใน `DEMO_USERS` กับ placeholder ในช่องล็อกอิน ไม่ใช่ fallback สิทธิ์)

## ข้อสังเกตที่ยังเหลือ (ไม่ใช่ Blocker — ให้ผู้ใช้/ทีมตัดสินใจ)

- **R1 — จุดที่ได้ FAIL นับเป็น “ตรวจแล้ว”:** `markShiftDone()` นับทุกจุดที่บันทึกแล้ว ไม่ว่า PASS หรือ FAIL รายการ “ตรวจแล้ว” แสดง ✅ แม้จุดนั้นจะ FAIL และ `endShift` จะสรุป “ตรวจครบทุกจุด” เมื่อเดินครบทุกจุดแม้บางจุดจะ FAIL — ถือว่า “ครบ” = เดินไปครบทุกจุด ไม่ใช่ “ผ่านทุกจุด” ถ้าต้องการให้นับเฉพาะ PASS ต้องบอกทีมแก้ก่อน deploy
- **R2 — `startShift()` ไม่มีตัวกันเริ่มกะซ้อน:** ถ้าเรียกฟังก์ชันตรงๆ ขณะมีกะเปิดอยู่จะรีเซ็ตความคืบหน้ากะในเครื่องเป็น 0 และแถวกะเก่าในตาราง shifts จะค้างสถานะ active — ปุ่มใน UI ถูกซ่อนไว้ตอนมีกะอยู่แล้วจึงกดซ้ำไม่ได้ตามปกติ ความเสี่ยงต่ำ
- **R3 — ปุ่มสแกนไม่ได้ถูก disable ที่หน้า UI:** `updateScanGate()` แสดงแค่แบนเนอร์เตือน ปุ่มสแกนยังกดได้ แต่ handler บล็อกพร้อมข้อความภาษาไทยทุกครั้ง (ทดสอบแล้ว) — ถ้าอยากให้ปุ่มเทาไปเลยต้องแก้เพิ่ม
- **R4 — กะข้ามวันใช้วันที่ UTC:** `loadShift()` เทียบวันเริ่มกะด้วย `toISOString()` (UTC) ทั้งตอนเก็บและตอนโหลด จึงสอดคล้องกันเอง ไม่พบอาการผิด แต่กะที่เริ่มหลังเที่ยงคืนไทย (00:00–07:00 น.) จะถูกนับเป็นวัน UTC ก่อนหน้า
- **R5 — จบกะตอนออฟไลน์:** ถ้าอัปเดตตาราง shifts ไม่สำเร็จ `endShift` ยังตั้ง `ended_at` ในเครื่อง แต่แถวในฐานข้อมูลยังค้าง active ครั้งหน้า `loadActiveShiftFromDb` อาจดึงกะเก่ากลับมาได้ (กรณีออฟไลน์เท่านั้น)
- **R6 — โหมด Demo:** ปุ่ม “ทดลองดู UI” เข้าได้โดยไม่ล็อกอินตามออกแบบ (ติดป้าย Demo ชัดเจน) ไม่ใช่ช่องโหว่ของระบบจริง แต่ห้ามใช้โหมดนี้ตรวจงานจริง

## สิ่งที่ยังทดสอบไม่ได้ — ต้องทำก่อนใช้งานจริง

- ล็อกอิน/บันทึก/RLS/Admin CRUD จริง: **ณ เวลาที่ทดสอบรอบนี้ (01:11–01:15 น.)** ตาราง Supabase ยังไม่ได้ถูกสร้าง (`PGRST205` ยืนยันซ้ำรอบนี้) และยังไม่มี Auth user admin/guard1 + profiles — **ต้องรัน `supabase/001_schema.sql`, `002_seed.sql`, `003_shifts.sql` ใน SQL Editor แล้วสร้าง Auth user ก่อน** (ขั้นตอนอยู่ใน `supabase/README.md`)
- **อัปเดตหลังทดสอบ (01:15 น., จาก parent):** ผู้ใช้รัน `001_schema.sql` สำเร็จแล้วใน Supabase Dashboard (“Success. No rows returned”) ตาราง profiles/checkpoints/patrol_logs/settings ปรากฏใน Table Editor แล้ว และ REST probe เปลี่ยนจาก PGRST205 เป็น 42501 (anon ถูกปฏิเสธตามออกแบบ) — ยืนยันว่าตารางมีอยู่จริงแล้ว ส่วน seed `002_seed.sql` และตารางกะ `003_shifts.sql` ถูกส่งให้ browser task รันต่อ ยังไม่ยืนยันว่าสำเร็จ ดังนั้น **ต้องทดสอบซ้ำแบบ live อีกครั้งหลัง seed + shifts + สร้าง Auth user admin/guard1 และ profiles แล้ว** ก่อนประกาศว่าใช้งานจริงได้ — ผลทดสอบซ้ำรอบนี้ครอบคลุมแค่โค้ด ไม่ใช่ข้อมูลจริงใน Supabase
- กล้องและ QR บนเครื่องจริง (Android Chrome / iOS Safari, เบลอ/เอียง/แสงสะท้อน/ถ่ายจากจอ), GPS ที่เขื่อนจริงตรง CP01–CP03, Add to Home Screen, พิมพ์ QR, เปิด CSV ใน Excel

## คำตัดสิน: ✅ พร้อม deploy ขึ้น GitHub Pages ได้

Blocker B1–B7 และบั๊ก G1/G3/G4/G5/G6/G9 ที่รายงานไว้รอบแรก **แก้ครบและทดสอบจริงผ่านทุกข้อ (47 checks, 0 ไม่ผ่าน)** ไม่มี Blocker เหลือ โค้ดพร้อมอัปโหลดขึ้น Pages ได้เลย

ข้อแม้เดียวที่ยังไม่ใช่ความผิดของโค้ด: หลัง deploy แล้วเว็บจะยังล็อกอิน/บันทึกจริงไม่ได้จนกว่าผู้ใช้จะรันไฟล์ SQL 3 ไฟล์และสร้างบัญชี admin/guard1 ใน Supabase ก่อน — ระหว่างนั้นแอปจะแสดงโหมด Demo พร้อมป้ายเตือนชัดเจน ไม่ค้าง
