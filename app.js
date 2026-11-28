/* SK Guard PWA - app.js (v2)
   CHANGELOG v2 (28 พ.ย. 2026) — ดู CHANGELOG_v2.md ฉบับเต็ม
   - ลบระบบกะ (shift) ออกทั้งหมด: ไม่มีเริ่ม/จบกะ ไม่บล็อกการสแกนด้วยกะ
   - หน้าผู้ตรวจแบบง่าย: ชื่อผู้ใช้ + นาฬิกาวันเวลาสด + GPS + ปุ่มสแกนใหญ่
   - กฎปุ่มบันทึก: ระยะห่างจุดตรวจ > รัศมี (50 ม.) = ปุ่มเทา บันทึกไม่ได้เด็ดขาด
     พร้อมข้อความ "ตำแหน่งคุณอยู่ห่างจุดตรวจเกิน 50 เมตร กรุณาไปยังจุดตรวจ"
   - ผลการตรวจ: ปกติ / ไม่ปกติ (เลือกย่อย: ไม่ปิดไฟ/ไม่ปิดประตู/ไม่ปิดหน้าต่าง/
     เปิดอุปกรณ์ไฟฟ้าไว้/อื่นๆ + ช่องพิมพ์เหตุการณ์)
   - "จุดที่ตรวจวันนี้" แสดงเฉพาะ log วันนี้ของผู้ล็อกอิน เรียงใหม่สุดก่อน
   - รายงาน: แผนที่รายวันตามกะ (กะเช้า 08:00-16:00 / กะบ่าย 16:01-07:59 วันถัดไป)
     หมุดเขียว=ตรวจแล้ว แดง=ยังไม่ตรวจ; ช่วง 7/15/30 วัน หรือกำหนดเอง แสดงเฉพาะตาราง
   - Admin: จัดการผู้ใช้ (แก้/ลบ profile) + แก้หมายเหตุ/ลบ log ในรายงาน
   - Trigger สร้าง profile อัตโนมัติเมื่อสร้าง Auth user: supabase/006_profile_trigger.sql
   Backend: Supabase (Auth + Postgres) 100% - ไม่ใช้ GAS / Google Sheets
   ตารางจริง (ดู supabase/001_schema.sql):
     checkpoints: code (PK), name, lat, lng, radius_m, is_active
     patrol_logs: id, guard_id, guard_username, checkpoint_code, scanned_at,
                  lat, lng, accuracy_m, distance_m, result, remark, synced
     profiles:    id, username, full_name, role, is_active
   RLS: insert patrol_logs ต้องมี guard_id = auth.uid() ของผู้ล็อกอิน
   ถ้าตารางยังไม่ถูกสร้าง แอปจะเข้าโหมด Demo (ข้อมูลตัวอย่างในเครื่อง) ไม่ค้าง */
'use strict';

const DEMO_CHECKPOINTS = [
  { id: 'demo-cp01', code: 'CP01', name: 'เรือนน้ำพุ', lat: 17.743079, lng: 100.55459, radius: 50, active: true },
  { id: 'demo-cp02', code: 'CP02', name: 'อาคารชีวะวิถี', lat: 17.7523, lng: 100.561149, radius: 50, active: true },
  { id: 'demo-cp03', code: 'CP03', name: 'อาคาร กบส.', lat: 17.756917, lng: 100.562258, radius: 50, active: true }
];
const DEMO_USERS = [
  { email: 'admin@skguard.local', display_name: 'admin', role: 'ADMIN', is_active: true },
  { email: 'guard1@skguard.local', display_name: 'guard1', role: 'GUARD', is_active: true }
];
const QUEUE_KEY = 'skguard_offline_queue_v1';
const GPS_FRESH_MS = 15000;      // ตำแหน่ง GPS ต้องสดไม่เกิน 15 วินาทีตอนสแกน/บันทึก
const ACCURACY_LIMIT_M = 30;     // accuracy เกิน 30 ม. บล็อกการบันทึก
const REPORT_LIMIT = 1000;       // โหลด log รายงานสูงสุดครั้งละ 1,000 แถว (กรองด้วย scanned_at ที่เซิร์ฟเวอร์)
let DEFAULT_CENTER = [17.765, 100.56];
let appSettings = { site_name: 'เขื่อนสิริกิติ์', default_radius_m: 50, default_lat: 17.765, default_lng: 100.56 };
let savingScan = false;          // กันกดยืนยันซ้ำ
let gpsDenied = false;           // ผู้ใช้ปฏิเสธสิทธิ์ Location
let gpsUnavailable = false;

let sb = null;
let currentUser = null;      // {id, email, display_name, role, demo}
let checkpoints = [];
let logs = [];               // log ที่โหลดมาในหน้ารายงาน (ตามช่วงที่เลือก)
let todayLogs = [];          // log วันนี้ของผู้ล็อกอิน (หน้า Dashboard)
let demoMode = false;
let currentPos = null;       // {lat, lng, accuracy, timestamp}
let scanned = null;          // checkpoint ที่สแกนได้
let map = null, userMarker = null, cpMarkers = [];
let reportMap = null, reportMarkers = [];
let liveScanner = null, liveRunning = false;
let watchId = null;
let clockTimer = null;
let reportRange = null;      // null = ดูเป็นวัน, {startISO, endISO, label} = ดูเป็นช่วง

const $ = (id) => document.getElementById(id);
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3500);
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function fmtTime(d) { return new Date(d).toLocaleString('th-TH', { hour12: false }); }
// วันที่ท้องถิ่นรูปแบบ YYYY-MM-DD (ใช้เปรียบเทียบ "วันนี้" แบบเวลาไทย ไม่ใช่ UTC)
function localDateStr(d) {
  const x = new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return x.getFullYear() + '-' + m + '-' + day;
}
// ขอบเขตวันท้องถิ่น (เที่ยงคืนถึง 23:59:59) แปลงเป็น ISO สำหรับกรองที่เซิร์ฟเวอร์
// วันที่ว่าง/ผิดรูปแบบ: ใช้วันปัจจุบันแทน (กันแอปพังเมื่อผู้ใช้ลบวันที่ในช่อง)
function safeDateStr(dateStr) {
  if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(new Date(dateStr + 'T00:00:00').getTime())) return dateStr;
  return localDateStr(new Date());
}
function dayBoundsISO(dateStr) {
  dateStr = safeDateStr(dateStr);
  const start = new Date(dateStr + 'T00:00:00');
  const end = new Date(dateStr + 'T23:59:59');
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

// ---------- กะ (ใช้เฉพาะหน้ารายงาน — ไม่ใช่ระบบเริ่ม/จบกะในแอป) ----------
// กะเช้า 08:00:00–16:00:59 ของวันที่เลือก (นาที 16:00 นับเป็นกะเช้า)
// กะบ่าย 16:01:00 ของวันที่เลือก ถึง 07:59:59 ของวันถัดไป
// (ตี 00:00-07:59 จึงนับเป็นกะบ่ายของวันก่อนหน้า แผนที่รีเซ็ตตอน 08:00 และ 16:01)
function shiftWindowFor(dateStr, shift) {
  dateStr = safeDateStr(dateStr);
  if (shift === 'morning') {
    const start = new Date(dateStr + 'T08:00:00');
    const end = new Date(dateStr + 'T16:00:59');
    return { label: 'กะเช้า ' + dateStr + ' 08:00–16:00', startISO: start.toISOString(), endISO: end.toISOString() };
  }
  const start = new Date(dateStr + 'T16:01:00');
  const next = new Date(dateStr + 'T00:00:00'); next.setDate(next.getDate() + 1);
  const end = new Date(localDateStr(next) + 'T07:59:59');
  return { label: 'กะบ่าย ' + dateStr + ' 16:01 – ' + localDateStr(next) + ' 07:59', startISO: start.toISOString(), endISO: end.toISOString() };
}
// กะปัจจุบันจากเวลาตอนนี้: 08:00-16:00 = กะเช้าวันนี้, 16:01-23:59 = กะบ่ายวันนี้,
// 00:00-07:59 = กะบ่ายของเมื่อวาน (แสดงเป็นวันที่ของเมื่อวาน)
// นาที 16:00 นับเป็นกะเช้า (กะบ่ายเริ่ม 16:01) — เปรียบเทียบเป็นนาทีตั้งแต่เที่ยงคืน
function currentWindow() {
  const now = new Date();
  const today = localDateStr(now);
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins >= 8 * 60 && mins < 16 * 60 + 1) return { dateStr: today, shift: 'morning' };
  if (mins >= 16 * 60 + 1) return { dateStr: today, shift: 'afternoon' };
  const y = new Date(now); y.setDate(y.getDate() - 1);
  return { dateStr: localDateStr(y), shift: 'afternoon' };
}

// ---------- Supabase ----------
function initSupabase() {
  const cfg = window.SK_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) { demoMode = true; return; }
  if (window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }
}
function isTableMissingError(err) {
  if (!err) return false;
  const s = (err.code || '') + ' ' + (err.message || '');
  return /PGRST205|42P01|Could not find the table|relation .* does not exist/i.test(s);
}

// ---------- Views / session ----------
function showView(name) {
  if (!currentUser && name !== 'login') { name = 'login'; }
  if (name === 'admin' && currentUser && currentUser.role !== 'ADMIN') {
    toast('หน้านี้เฉพาะผู้ดูแลระบบ (ADMIN)'); name = 'dashboard';
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = $('view-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('#bottomnav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === name));
  if (name === 'dashboard') { setTimeout(initMap, 50); updateScanGate(); loadTodayLogs(); }
  if (name === 'report') { setTimeout(initReportMap, 50); loadReport(); }
  if (name === 'admin') { renderAdminList(); loadProfiles(); }
}
function setLoggedIn(user) {
  currentUser = user;
  $('userbar').classList.remove('hidden');
  $('bottomnav').classList.remove('hidden');
  const navAdmin = $('nav-admin'); if (navAdmin) navAdmin.classList.toggle('hidden', user.role !== 'ADMIN');
  $('user-info').textContent = user.display_name + ' (' + user.role + ')' + (user.demo ? ' • Demo' : '');
  $('demo-banner').classList.toggle('hidden', !demoMode);
  $('dash-user-name').textContent = user.display_name + ' (' + user.role + ')' + (user.demo ? ' • Demo' : '');
  startClock();
  showView('dashboard');
  startGPS();
  loadSettings().then(() => loadCheckpoints());
  updateQueueChip();
  syncQueue();
}
function setLoggedOut() {
  currentUser = null; demoMode = false; savingScan = false; scanned = null;
  stopClock();
  stopLiveScan();
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  $('userbar').classList.add('hidden');
  $('bottomnav').classList.add('hidden');
  const navAdmin = $('nav-admin'); if (navAdmin) navAdmin.classList.remove('hidden');
  $('demo-banner').classList.add('hidden');
  showView('login');
}

async function checkSession() {
  if (!sb) { setLoggedOut(); return; }
  try {
    const { data } = await sb.auth.getSession();
    if (data && data.session && data.session.user) {
      await applyAuthUser(data.session.user);
    } else setLoggedOut();
  } catch (e) { setLoggedOut(); }
}
async function applyAuthUser(authUser) {
  let role = 'GUARD', display = authUser.email || 'guard';
  let profileFound = false, tableMissing = false, profileInactive = false;
  try {
    const { data, error } = await sb.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
    if (!error && data) {
      profileFound = true;
      if (data.is_active === false) profileInactive = true;
      role = (data.role || 'GUARD').toUpperCase();
      display = data.full_name || data.username || data.email || display;
    } else if (error && isTableMissingError(error)) {
      demoMode = true; tableMissing = true;
    }
  } catch (e) { /* profiles อ่านไม่ได้ ใช้ค่าเริ่มต้น */ }
  if (profileInactive) {
    try { await sb.auth.signOut(); } catch (e) {}
    const errEl = $('login-error');
    errEl.textContent = 'บัญชีนี้ถูกปิดใช้งานแล้ว กรุณาติดต่อผู้ดูแลระบบ';
    errEl.classList.remove('hidden');
    setLoggedOut(); return false;
  }
  // ไม่มีแถว profiles = ยังไม่ได้ผูกบัญชี ห้ามให้สิทธิ์ใดๆ จากอีเมล
  // ยกเว้นกรณีตารางยังไม่ถูกสร้าง (tableMissing) ซึ่งเป็นช่วงตั้งค่าแรกเริ่ม
  // ให้เข้าโหมด Demo ด้วยสิทธิ์ GUARD เท่านั้น ไม่ใช่ ADMIN
  if (!profileFound && !tableMissing) {
    try { await sb.auth.signOut(); } catch (e) {}
    const errEl = $('login-error');
    errEl.textContent = 'บัญชีนี้ยังไม่มีข้อมูลใน profiles กรุณาให้ผู้ดูแลระบบผูกบัญชีใน Supabase ก่อน';
    errEl.classList.remove('hidden');
    setLoggedOut(); return false;
  }
  setLoggedIn({ id: authUser.id, email: authUser.email, display_name: display, role, demo: demoMode });
  return true;
}

function translateLoginError(err) {
  const m = String((err && (err.message || err)) || '');
  if (/Invalid login credentials/i.test(m)) return 'อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณาลองใหม่';
  if (/Email not confirmed/i.test(m)) return 'บัญชีนี้ยังไม่ได้ยืนยันอีเมล กรุณายืนยันอีเมลก่อน หรือให้แอดมินติ๊ก Auto Confirm ตอนสร้างบัญชี';
  if (/User not found|Invalid email/i.test(m)) return 'ไม่พบบัญชีนี้ กรุณาตรวจชื่อผู้ใช้ หรือให้แอดมินสร้างบัญชีใน Supabase > Authentication ก่อน';
  if (/Too many requests|rate limit/i.test(m)) return 'ลองล็อกอินผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'เชื่อมต่อ Supabase ไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่';
  return 'เข้าสู่ระบบไม่สำเร็จ: ' + m;
}

async function doLogin(e) {
  e.preventDefault();
  const errEl = $('login-error'); errEl.classList.add('hidden');
  let email = $('login-email').value.trim();
  const password = $('login-password').value;
  if (!email.includes('@')) email += '@skguard.local'; // พิมพ์แค่ชื่อผู้ใช้ก็ได้
  if (!sb) { errEl.textContent = 'เชื่อม Supabase ไม่ได้ กรุณาใช้โหมด Demo'; errEl.classList.remove('hidden'); return; }
  $('btn-login').disabled = true;
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data && data.user) await applyAuthUser(data.user);
  } catch (err) {
    errEl.textContent = translateLoginError(err);
    errEl.classList.remove('hidden');
  } finally { $('btn-login').disabled = false; }
}
async function doLogout() {
  try { if (sb) await sb.auth.signOut(); } catch (e) {}
  setLoggedOut();
  toast('ออกจากระบบแล้ว');
}

// ---------- นาฬิกาวัน-เวลา (อัปเดตทุก 1 วินาที) ----------
function tickClock() {
  const el = $('clock'); if (!el) return;
  el.textContent = new Date().toLocaleString('th-TH', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}
function startClock() {
  tickClock();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = setInterval(tickClock, 1000);
}
function stopClock() { if (clockTimer) { clearInterval(clockTimer); clockTimer = null; } }

// ---------- Checkpoints ----------
function normCheckpoint(r) {
  return {
    id: r.code, code: String(r.code || '').toUpperCase(),
    name: r.name || r.code || '-',
    lat: Number(r.lat ?? r.latitude), lng: Number(r.lng ?? r.longitude),
    radius: Number(r.radius_m ?? r.radius ?? appSettings.default_radius_m ?? 50),
    active: r.is_active !== false
  };
}
async function loadCheckpoints() {
  if (!sb || demoMode) {
    if (!checkpoints.length) checkpoints = DEMO_CHECKPOINTS.slice();
    if (demoMode) $('demo-banner').classList.remove('hidden');
    renderCheckpointMeta(); return;
  }
  try {
    const { data, error } = await sb.from('checkpoints').select('*').order('code');
    if (error) throw error;
    checkpoints = (data || []).map(normCheckpoint).filter((c) => c.active !== false);
    if (!checkpoints.length) { demoMode = true; checkpoints = DEMO_CHECKPOINTS.slice(); $('demo-banner').classList.remove('hidden'); }
    renderCheckpointMeta();
  } catch (err) {
    if (isTableMissingError(err)) {
      demoMode = true;
      checkpoints = DEMO_CHECKPOINTS.slice();
      $('demo-banner').classList.remove('hidden');
      toast('ยังไม่ได้สร้างตารางใน Supabase — ใช้โหมดทดลอง');
    } else {
      toast('โหลดจุดตรวจไม่สำเร็จ: ' + (err.message || err));
    }
    renderCheckpointMeta();
  }
}
function renderCheckpointMeta() {
  const cc = $('cp-count'); if (cc) cc.textContent = checkpoints.length;
  const sel = $('filter-cp');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">ทั้งหมด</option>';
    checkpoints.forEach((c) => { const o = document.createElement('option'); o.value = c.code; o.textContent = c.code + ' ' + c.name; sel.appendChild(o); });
    sel.value = cur;
  }
  drawMapMarkers();
  if (reportMap) renderReportMap();
}

// ---------- Settings ----------
async function loadSettings() {
  if (!sb || demoMode) return;
  try {
    const { data, error } = await sb.from('settings').select('key, value');
    if (error) throw error;
    (data || []).forEach((r) => {
      if (r.key === 'site_name' && r.value) appSettings.site_name = r.value;
      if (r.key === 'default_radius_m') appSettings.default_radius_m = parseInt(r.value, 10) || 50;
      if (r.key === 'default_lat') appSettings.default_lat = parseFloat(r.value) || appSettings.default_lat;
      if (r.key === 'default_lng') appSettings.default_lng = parseFloat(r.value) || appSettings.default_lng;
    });
    DEFAULT_CENTER = [appSettings.default_lat, appSettings.default_lng];
    const siteEl = $('site-name'); if (siteEl) siteEl.textContent = 'ระบบตรวจเวร ' + appSettings.site_name;
    document.title = 'SK Guard - ' + appSettings.site_name;
  } catch (err) {
    if (isTableMissingError(err)) { demoMode = true; }
  }
}

// ---------- Map & GPS ----------
function initMap() {
  if (typeof L === 'undefined') { toast('โหลดแผนที่ Leaflet ไม่สำเร็จ ตรวจเน็ตแล้วโหลดใหม่'); return; }
  if (map) { map.invalidateSize(); drawMapMarkers(); return; }
  map = L.map('map').setView(DEFAULT_CENTER, 15);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, Maxar, Earthstar Geographics', maxZoom: 19
  }).addTo(map);
  drawMapMarkers();
}
function drawMapMarkers() {
  if (!map || typeof L === 'undefined') return;
  cpMarkers.forEach((m) => map.removeLayer(m)); cpMarkers = [];
  checkpoints.forEach((c) => {
    const m = L.marker([c.lat, c.lng]).addTo(map).bindPopup('<b>' + c.code + ' ' + c.name + '</b><br>รัศมี ' + c.radius + ' ม.');
    L.circle([c.lat, c.lng], { radius: c.radius, color: '#0f766e', fillOpacity: 0.15 }).addTo(map);
    cpMarkers.push(m);
  });
  if (currentPos) updateUserMarker();
}
function updateUserMarker() {
  if (!map || !currentPos || typeof L === 'undefined') return;
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.circleMarker([currentPos.lat, currentPos.lng], { radius: 8, color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.9 })
    .addTo(map).bindPopup('ตำแหน่งของคุณ<br>แม่นยำ ±' + Math.round(currentPos.accuracy) + ' ม.');
}
function onGps(pos) {
  currentPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy || 999, timestamp: pos.timestamp };
  gpsDenied = false; gpsUnavailable = false;
  $('gps-lat').textContent = currentPos.lat.toFixed(6);
  $('gps-lng').textContent = currentPos.lng.toFixed(6);
  $('gps-acc').textContent = '±' + Math.round(currentPos.accuracy) + ' ม.';
  $('gps-time').textContent = fmtTime(currentPos.timestamp);
  $('gps-status').textContent = currentPos.accuracy > ACCURACY_LIMIT_M
    ? '⚠️ ความแม่นยำ GPS ต่ำ (±' + Math.round(currentPos.accuracy) + ' ม.) — บันทึกไม่ได้จนกว่าจะแม่นยำภายใน 30 ม. กรุณาออกไปในที่โล่งแล้วกด “ขอตำแหน่งอีกครั้ง”'
    : '✅ GPS พร้อมใช้งาน (แม่นยำ ±' + Math.round(currentPos.accuracy) + ' ม.)';
  updateUserMarker();
  updateScanGate();
  if (scanned) refreshScanCalc();
}
function onGpsError(err) {
  gpsDenied = (err && (err.code === 1 || /denied/i.test(err.message || '')));
  $('gps-status').textContent = gpsDenied
    ? '❌ ยังไม่ได้อนุญาตตำแหน่ง — กรุณาเปิด Location ของมือถือและอนุญาตตำแหน่งให้เว็บนี้ แล้วกด “ขอตำแหน่งอีกครั้ง” (Chrome: แตะไอคอน 🔒 ข้างแถบที่อยู่ > สิทธิ์ของไซต์ > ตำแหน่ง > อนุญาต / iPhone: การตั้งค่า > ความเป็นส่วนตัวและความปลอดภัย > บริการตำแหน่งที่ตั้ง > Safari > ขณะใช้แอป)'
    : '❌ เปิด GPS ไม่ได้: ' + (err.message || 'กรุณาเปิด Location แล้วกด "ขอตำแหน่งอีกครั้ง"');
  updateScanGate();
  if (scanned) refreshScanCalc();
}
function startGPS() {
  if (!('geolocation' in navigator)) { gpsUnavailable = true; $('gps-status').textContent = '❌ อุปกรณ์นี้ไม่รองรับ GPS'; updateScanGate(); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onGps, onGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}
function isFreshPos() {
  return !!(currentPos && currentPos.timestamp && (Date.now() - currentPos.timestamp) <= GPS_FRESH_MS);
}
function gpsAgeSeconds() {
  return currentPos && currentPos.timestamp ? Math.round((Date.now() - currentPos.timestamp) / 1000) : null;
}
function requestFreshPosition() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { gpsUnavailable = true; resolve(false); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { onGps(pos); resolve(true); },
      (err) => { onGpsError(err); resolve(false); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
// Location gate — ต้องมี GPS สดก่อนสแกนทุกครั้ง ถ้าไม่ผ่านให้บล็อกและบอกวิธีเปิด
async function ensureLocationReady() {
  if (!('geolocation' in navigator)) {
    $('scan-status').textContent = '❌ อุปกรณ์นี้ไม่รองรับ GPS — ใช้มือถือที่มี GPS และเปิด Location ก่อนสแกน';
    return false;
  }
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'geolocation' });
      if (st.state === 'denied') {
        gpsDenied = true; updateScanGate();
        $('scan-status').textContent = '❌ ยังไม่ได้อนุญาตตำแหน่ง — เปิด Location ของมือถือและอนุญาตตำแหน่งให้เว็บนี้ก่อน (Chrome: แตะไอคอน 🔒 ข้างแถบที่อยู่ > สิทธิ์ของไซต์ > ตำแหน่ง > อนุญาต / iPhone: การตั้งค่า > ความเป็นส่วนตัว > บริการตำแหน่งที่ตั้ง > Safari > ขณะใช้แอป) แล้วกด “ขอตำแหน่งอีกครั้ง”';
        return false;
      }
    }
  } catch (e) { /* ข้ามไปขอตำแหน่งตรงๆ */ }
  if (!isFreshPos()) {
    $('scan-status').textContent = 'กำลังขอตำแหน่ง GPS สด… กรุณารอสักครู่';
    const ok = await requestFreshPosition();
    if (!ok || !isFreshPos()) {
      $('scan-status').textContent = '❌ ขอตำแหน่ง GPS ไม่ได้ — กรุณาเปิด Location ของมือถือ อนุญาตตำแหน่งให้เว็บนี้ แล้วกด “ขอตำแหน่งอีกครั้ง” ก่อนสแกน';
      return false;
    }
  }
  return true;
}
// แบนเนอร์เตือนตามสถานะ GPS เท่านั้น (v2 ไม่มีระบบกะแล้ว)
function updateScanGate() {
  const gate = $('location-gate'); if (!gate) return;
  if (!currentUser) { gate.classList.add('hidden'); return; }
  if (gpsDenied || gpsUnavailable) {
    gate.classList.remove('hidden');
    gate.innerHTML = '❌ <b>ยังเปิด Location ไม่ได้</b> — สแกน QR ไม่ได้จนกว่าจะเปิด Location และอนุญาตตำแหน่งให้เว็บนี้<br>วิธีเปิด: Chrome บน Android แตะไอคอน 🔒 ข้างแถบที่อยู่ → สิทธิ์ของไซต์ → ตำแหน่ง → อนุญาต • iPhone: การตั้งค่า → ความเป็นส่วนตัวและความปลอดภัย → บริการตำแหน่งที่ตั้ง → Safari → ขณะใช้แอป';
    return;
  }
  if (!currentPos) {
    gate.classList.remove('hidden');
    gate.textContent = '⏳ กำลังรอตำแหน่ง GPS… กรุณาอนุญาตตำแหน่งและรอจน GPS พร้อมก่อนสแกน';
    return;
  }
  if (!isFreshPos()) {
    gate.classList.remove('hidden');
    gate.textContent = '⚠️ ตำแหน่ง GPS เก่าเกิน 15 วินาทีแล้ว — กด “ขอตำแหน่งอีกครั้ง” เพื่อขอตำแหน่งสดก่อนสแกน';
    return;
  }
  if (currentPos.accuracy > ACCURACY_LIMIT_M) {
    gate.classList.remove('hidden');
    gate.textContent = '⚠️ ความแม่นยำ GPS เกิน 30 ม. (±' + Math.round(currentPos.accuracy) + ' ม.) — บันทึกไม่ได้จนกว่าจะแม่นยำภายใน 30 ม. กรุณาออกไปในที่โล่งแล้วกด “ขอตำแหน่งอีกครั้ง”';
    return;
  }
  gate.classList.add('hidden');
}

// ---------- QR scan ----------
function parseCode(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  try {
    const u = new URL(s);
    const cp = u.searchParams.get('cp') || u.searchParams.get('code');
    if (cp) return cp.trim().toUpperCase();
    s = u.pathname.split('/').filter(Boolean).pop() || s;
  } catch (e) { /* ไม่ใช่ URL */ }
  return s.split(/[?#\s]/)[0].trim().toUpperCase();
}
function handleScanned(raw, opts) {
  const code = parseCode(raw);
  const cp = checkpoints.find((c) => c.code === code);
  if (!cp) {
    $('scan-status').textContent = '❌ ไม่พบจุดตรวจรหัส "' + code + '" — ตรวจว่า QR นี้เป็นของ SK Guard หรือไม่';
    toast('ไม่พบจุดตรวจรหัส ' + code);
    return;
  }
  stopLiveScan();
  scanned = cp;
  scanned._scanSource = (opts && opts.source) || 'qr'; // ต้องมาจากการสแกน QR เท่านั้น
  $('scan-code').textContent = cp.code;
  $('scan-name').textContent = cp.name;
  $('scan-detail').textContent = 'พิกัดจุดตรวจ ' + cp.lat + ', ' + cp.lng + ' • รัศมี ' + cp.radius + ' ม.';
  $('scan-card').classList.remove('hidden');
  $('scan-status').textContent = 'สแกนได้: ' + cp.code;
  // รีเซ็ตผลการตรวจทุกครั้งที่สแกนใหม่
  $('remark-type').value = 'ปกติ';
  $('remark-sub').value = 'ไม่ปิดไฟ';
  $('remark-other').value = '';
  updateRemarkUI();
  refreshScanCalc();
  $('scan-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- ผลการตรวจ (remark) ----------
// ปกติ → remark = "ปกติ"
// ไม่ปกติ → เลือกย่อย; อื่นๆ → พิมพ์เหตุการณ์เอง
// คืนค่า null ถ้ายังเลือกไม่ครบ (อื่นๆ แต่ช่องว่าง) พร้อมเหตุผลใน save-block-reason
function updateRemarkUI() {
  const type = $('remark-type').value;
  $('remark-sub-wrap').classList.toggle('hidden', type !== 'ไม่ปกติ');
  const sub = $('remark-sub').value;
  $('remark-other-wrap').classList.toggle('hidden', !(type === 'ไม่ปกติ' && sub === 'อื่นๆ'));
  if (scanned) refreshScanCalc();
}
function getRemark() {
  const type = $('remark-type').value;
  if (type === 'ปกติ') return 'ปกติ';
  const sub = $('remark-sub').value;
  if (sub === 'อื่นๆ') {
    const txt = $('remark-other').value.trim();
    return txt ? txt : null; // อื่นๆ แต่ไม่พิมพ์ = ยังบันทึกไม่ได้
  }
  return sub;
}

// ---------- กฎปุ่มบันทึก (หัวใจของ v2) ----------
// บันทึกได้เฉพาะเมื่อ: GPS สด (<=15 วินาที) + แม่นยำ <=30 ม. + อยู่ห่างจุดตรวจ
// ไม่เกินรัศมี (50 ม.) + ผลการตรวจเลือกครบ (อื่นๆ ต้องพิมพ์เหตุการณ์)
// อยู่นอกระยะ = ปุ่มเทา (disabled) + ข้อความสีแดงตายตัว — บันทึกไม่ได้เด็ดขาด
// ดังนั้น log ที่บันทึกสำเร็จจะเป็น PASS เสมอ (ไม่มี FAIL จากการสแกนไกล)
function refreshScanCalc() {
  if (!scanned) return;
  const confirmBtn = $('btn-confirm-scan');
  const farMsg = $('far-msg');
  const reason = $('save-block-reason');
  const setBlocked = (msg, far) => {
    confirmBtn.disabled = true;
    if (far) { farMsg.classList.remove('hidden'); } else { farMsg.classList.add('hidden'); }
    reason.textContent = msg || '';
  };
  const setOk = () => {
    confirmBtn.disabled = false;
    farMsg.classList.add('hidden');
    reason.textContent = '✅ อยู่ในระยะจุดตรวจแล้ว กด “บันทึกผลการตรวจ” ได้เลย';
  };
  if (!currentPos) {
    $('scan-distance').textContent = '-';
    $('scan-result-line').innerHTML = '⏳ ยังไม่มีตำแหน่ง GPS กรุณาเปิด Location รอ GPS แล้วสแกนใหม่อีกครั้ง';
    setBlocked('ยังไม่มีตำแหน่ง GPS'); return;
  }
  if (!isFreshPos()) {
    $('scan-distance').textContent = '-';
    $('scan-result-line').innerHTML = '⚠️ ตำแหน่ง GPS เก่าเกิน 15 วินาที (อายุ ' + (gpsAgeSeconds() ?? '-') + ' วินาที) — ห้ามใช้ตำแหน่งเก่าบันทึก กรุณากด “ขอตำแหน่งอีกครั้ง” เพื่อขอตำแหน่งสด';
    $('scan-accuracy-warn').classList.add('hidden');
    setBlocked('ตำแหน่ง GPS เก่าเกิน 15 วินาที — กด “ขอตำแหน่งอีกครั้ง”'); return;
  }
  const d = haversine(currentPos.lat, currentPos.lng, scanned.lat, scanned.lng);
  scanned._distance = d;
  scanned._pass = d <= scanned.radius;
  $('scan-distance').textContent = Math.round(d) + ' ม.';
  if (currentPos.accuracy > ACCURACY_LIMIT_M) {
    $('scan-result-line').innerHTML = '<span class="badge badge-fail">บล็อก</span> ความแม่นยำ GPS ±' + Math.round(currentPos.accuracy) + ' ม. เกิน 30 ม. — บันทึกไม่ได้ กรุณาออกไปในที่โล่งแล้วกด “ขอตำแหน่งอีกครั้ง” จนแม่นยำภายใน 30 ม.';
    $('scan-accuracy-warn').classList.remove('hidden');
    setBlocked('ความแม่นยำ GPS เกิน 30 ม. — บันทึกไม่ได้'); return;
  }
  $('scan-accuracy-warn').classList.add('hidden');
  if (!scanned._pass) {
    // เกินระยะ: ปุ่มเทา + ข้อความตายตัวตามสเปก — บันทึกไม่ได้เด็ดขาด
    $('scan-result-line').innerHTML = '<span class="badge badge-fail">ห่างเกินไป</span> อยู่นอก รัศมี ' + scanned.radius + ' ม. (เกิน ' + Math.round(d - scanned.radius) + ' ม.)';
    setBlocked('', true); return;
  }
  // อยู่ในระยะแล้ว — เช็กผลการตรวจว่ากรอกครบหรือยัง
  if (getRemark() === null) {
    $('scan-result-line').innerHTML = '<span class="badge badge-pass">PASS</span> อยู่ในรัศมี ' + scanned.radius + ' ม.';
    setBlocked('กรุณาระบุเหตุการณ์'); return;
  }
  $('scan-result-line').innerHTML = '<span class="badge badge-pass">PASS</span> อยู่ในรัศมี ' + scanned.radius + ' ม.';
  setOk();
}
async function startLiveScan() {
  if (typeof Html5Qrcode === 'undefined') { toast('โหลดตัวสแกน Html5Qrcode ไม่สำเร็จ'); return; }
  if (!(await ensureLocationReady())) return; // Location ปิด/ปฏิเสธสิทธิ์ = บล็อก
  stopLiveScan();
  $('reader').classList.remove('hidden');
  $('scan-stop-row').classList.remove('hidden');
  $('scan-status').textContent = 'กำลังเปิดกล้อง…';
  try {
    liveScanner = new Html5Qrcode('reader');
    await liveScanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 250 },
      (text) => handleScanned(text, { source: 'live' }), () => {});
    liveRunning = true;
    $('scan-status').textContent = 'กำลังสแกน… เล็งกล้องไปที่ QR จุดตรวจ';
  } catch (err) {
    const denied = err && (/NotAllowedError|Permission denied|denied/i.test(err.name || '') || /denied/i.test(err.message || ''));
    $('scan-status').textContent = denied
      ? '❌ ยังไม่ได้อนุญาตกล้อง — เปิดสิทธิ์กล้องให้เว็บนี้ก่อน: Chrome บน Android แตะไอคอน 🔒 ข้างแถบที่อยู่ → สิทธิ์ของไซต์ → กล้อง → อนุญาต แล้วโหลดหน้าใหม่ • iPhone: การตั้งค่า → Safari → กล้อง → อนุญาต • ระหว่างนี้ยังใช้ “ถ่ายรูปสแกน” ได้ เพราะไม่ต้องขอสิทธิ์กล้อง'
      : '❌ เปิดกล้องไม่ได้: ' + (err.message || err) + ' — ลองใช้ "ถ่ายรูปสแกน" แทน';
    toast('เปิดกล้องไม่ได้ ลองถ่ายรูปสแกน');
  }
}
async function stopLiveScan() {
  if (liveScanner && liveRunning) {
    try { await liveScanner.stop(); } catch (e) {}
    try { liveScanner.clear(); } catch (e) {}
  }
  liveRunning = false; liveScanner = null;
  $('reader').classList.add('hidden');
  $('scan-stop-row').classList.add('hidden');
}
// แก้จาก PDF: ย่อภาพเหลือสูงสุด 1000px ด้วย Canvas แล้วสแกน, ไม่เจอให้ลองภาพต้นฉบับอีกรอบ
async function handleQrFileScan(file) {
  if (!file) return;
  if (typeof Html5Qrcode === 'undefined') { toast('โหลดตัวสแกนไม่สำเร็จ'); return; }
  if (!(await ensureLocationReady())) return;
  $('scan-status').textContent = 'กำลังอ่าน QR จากรูป…';
  const scanner = new Html5Qrcode('qr-file-reader');
  const downscaled = await downscaleImage(file, 1000);
  try {
    const text = await scanner.scanFile(downscaled, false);
    handleScanned(text, { source: 'photo' }); return;
  } catch (e1) {
    try {
      const text = await scanner.scanFile(file, false); // two-pass: ลองภาพต้นฉบับ
      handleScanned(text, { source: 'photo' }); return;
    } catch (e2) {
      $('scan-status').textContent = '❌ อ่าน QR จากรูปไม่เจอ ลองถ่ายใหม่ให้ชัด ตรง ไม่สะท้อนแสง';
      toast('อ่าน QR จากรูปไม่เจอ');
    }
  } finally { try { scanner.clear(); } catch (e) {} }
}
// ดูข้อมูลจุดตรวจแบบไม่บันทึก (ADMIN ทดสอบเท่านั้น — ไม่ตั้ง scanned ไม่เปิดปุ่มยืนยัน)
function previewCheckpoint(code) {
  const cp = checkpoints.find((c) => c.code === parseCode(code));
  const el = $('admin-test-result');
  if (!cp) { el.textContent = '❌ ไม่พบจุดตรวจรหัส "' + parseCode(code) + '"'; return; }
  el.textContent = 'พบจุดตรวจ ' + cp.code + ' ' + cp.name + ' • พิกัด ' + cp.lat + ', ' + cp.lng + ' • รัศมี ' + cp.radius + ' ม. (ดูข้อมูลเท่านั้น ไม่นับเป็นการตรวจ)';
}
function downscaleImage(file, maxSize) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((b) => resolve(b ? new File([b], 'qr-downscaled.jpg', { type: 'image/jpeg' }) : file), 'image/jpeg', 0.92);
      } catch (e) { URL.revokeObjectURL(url); resolve(file); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ---------- Save log + offline queue ----------
function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; } }
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); updateQueueChip(); }
function updateQueueChip() {
  const n = getQueue().length;
  const chip = $('queue-chip');
  chip.textContent = 'คิวออฟไลน์: ' + n;
  chip.classList.toggle('hidden', n === 0);
}
function updateOnlineBanner() {
  $('offline-banner').classList.toggle('hidden', navigator.onLine);
  if (navigator.onLine) syncQueue();
}
async function submitScan() {
  if (!scanned || !currentUser) return;
  if (savingScan) return; // กันกดซ้ำระหว่างบันทึก
  // ตรวจเงื่อนไขซ้ำอีกชั้นที่ตัวบันทึก (กันกดปุ่มที่ควรจะถูกปิดไว้)
  if (!currentPos || !isFreshPos()) {
    toast('ตำแหน่ง GPS เก่าเกินไป กรุณากด “ขอตำแหน่งอีกครั้ง” แล้วสแกนใหม่');
    $('save-status').textContent = '⛔ ตำแหน่ง GPS เก่าเกิน 15 วินาที — ห้ามใช้ตำแหน่งเก่าบันทึก กรุณาขอตำแหน่งสดแล้วสแกนใหม่';
    return;
  }
  if (currentPos.accuracy > ACCURACY_LIMIT_M) {
    toast('ความแม่นยำ GPS เกิน 30 ม. บันทึกไม่ได้');
    $('save-status').textContent = '⛔ ความแม่นยำ GPS ±' + Math.round(currentPos.accuracy) + ' ม. เกิน 30 ม. — บันทึกไม่ได้ กรุณาออกไปในที่โล่งแล้วขอตำแหน่งใหม่';
    return;
  }
  const d = haversine(currentPos.lat, currentPos.lng, scanned.lat, scanned.lng);
  if (d > scanned.radius) {
    // ถึงจุดนี้ไม่ควรเกิด (ปุ่มถูกปิดไว้) แต่กันไว้ไม่ให้บันทึกไกลเด็ดขาด
    $('save-status').textContent = '⛔ ตำแหน่งคุณอยู่ห่างจุดตรวจเกิน 50 เมตร กรุณาไปยังจุดตรวจ';
    toast('อยู่ห่างจุดตรวจเกิน 50 เมตร บันทึกไม่ได้');
    return;
  }
  const remark = getRemark();
  if (remark === null) {
    $('save-status').textContent = 'กรุณาระบุเหตุการณ์';
    toast('กรุณาระบุเหตุการณ์');
    return;
  }
  savingScan = true;
  $('btn-confirm-scan').disabled = true;
  // บันทึกได้เฉพาะเมื่ออยู่ในระยะ → ผลเป็น PASS เสมอ
  const rec = {
    checkpoint_code: scanned.code,
    guard_id: currentUser.id || null,
    guard_username: currentUser.display_name || currentUser.email,
    lat: currentPos.lat, lng: currentPos.lng,
    accuracy_m: Math.round(currentPos.accuracy),
    distance_m: Math.round(d),
    result: 'PASS',
    remark,
    scanned_at: new Date().toISOString(),
    synced: true
  };
  $('save-status').textContent = 'กำลังบันทึก…';
  if (demoMode || !sb) {
    const q = getQueue(); q.push(rec); setQueue(q);
    $('save-status').textContent = 'บันทึกในเครื่อง (โหมด Demo) — จะส่งเมื่อเชื่อม Supabase ได้';
    toast('บันทึกแล้ว (Demo/ออฟไลน์) PASS');
    afterSaved(); return;
  }
  if (!navigator.onLine) {
    const q = getQueue(); q.push(rec); setQueue(q);
    $('save-status').textContent = 'ไม่มีเน็ต — เก็บเข้าคิวออฟไลน์แล้ว (' + getQueue().length + ' รายการ)';
    toast('เก็บเข้าคิวออฟไลน์แล้ว');
    afterSaved(); return;
  }
  try {
    const { error } = await sb.from('patrol_logs').insert([rec]);
    if (error) throw error;
    $('save-status').textContent = '✅ บันทึกสำเร็จ PASS (' + rec.distance_m + ' ม.)';
    toast('บันทึกสำเร็จ PASS');
    afterSaved();
  } catch (err) {
    if (isTableMissingError(err)) {
      demoMode = true; $('demo-banner').classList.remove('hidden');
      const q = getQueue(); q.push(rec); setQueue(q);
      $('save-status').textContent = 'ยังไม่ได้สร้างตารางใน Supabase — เก็บเข้าคิวในเครื่องแล้ว';
    } else {
      const q = getQueue(); q.push(rec); setQueue(q);
      $('save-status').textContent = 'บันทึกไม่สำเร็จ (' + (err.message || err) + ') — เก็บเข้าคิวแล้ว';
    }
    toast('บันทึกไม่สำเร็จ เก็บเข้าคิวแล้ว');
    afterSaved();
  }
}
function afterSaved() {
  scanned = null; savingScan = false;
  $('scan-card').classList.add('hidden');
  $('btn-confirm-scan').disabled = true;
  $('save-status').textContent = '';
  $('scan-status').textContent = 'บันทึกแล้ว — สแกนจุดถัดไปได้เลย';
  updateScanGate();
  loadTodayLogs();
}
async function syncQueue() {
  if (!sb || demoMode || !navigator.onLine) return;
  const q = getQueue();
  if (!q.length) return;
  const rest = [];
  for (const rec of q) {
    if (!rec.guard_id && currentUser && currentUser.id) {
      rec.guard_id = currentUser.id;
      rec.guard_username = rec.guard_username || currentUser.display_name || currentUser.email;
    }
    try {
      const { error } = await sb.from('patrol_logs').insert([rec]);
      if (error) throw error;
    } catch (e) { rest.push(rec); }
  }
  setQueue(rest);
  if (rest.length < q.length) { toast('ซิงก์คิวออฟไลน์แล้ว ' + (q.length - rest.length) + ' รายการ'); loadTodayLogs(); }
}

// ---------- จุดที่ตรวจวันนี้ (Dashboard) ----------
// แสดงเฉพาะ log วันนี้ (เทียบวันที่ท้องถิ่น) ของผู้ล็อกอินคนเดียว เรียงใหม่สุดก่อน
async function loadTodayLogs() {
  if (!currentUser) return;
  const today = localDateStr(new Date());
  if (!sb || demoMode) {
    todayLogs = getQueue()
      .filter((r) => localDateStr(r.scanned_at) === today)
      .sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at));
    renderTodayLogs();
    return;
  }
  try {
    const { startISO, endISO } = dayBoundsISO(today);
    let query = sb.from('patrol_logs').select('*')
      .gte('scanned_at', startISO).lte('scanned_at', endISO)
      .order('scanned_at', { ascending: false }).limit(200);
    if (currentUser.id) query = query.eq('guard_id', currentUser.id);
    const { data, error } = await query;
    if (error) throw error;
    todayLogs = (data || []).map((r) => ({ ...r, created_at: r.scanned_at || r.created_at }));
    renderTodayLogs();
  } catch (err) {
    if (isTableMissingError(err)) { demoMode = true; $('demo-banner').classList.remove('hidden'); }
    todayLogs = getQueue()
      .filter((r) => localDateStr(r.scanned_at) === today)
      .sort((a, b) => new Date(b.scanned_at) - new Date(a.scanned_at));
    renderTodayLogs();
  }
}
function renderTodayLogs() {
  const list = $('today-list');
  const count = $('today-count');
  if (count) count.textContent = todayLogs.length + ' จุด';
  if (!list) return;
  if (!todayLogs.length) { list.innerHTML = '<p class="muted">วันนี้ยังไม่ได้ตรวจจุดไหนเลย</p>'; return; }
  list.innerHTML = '';
  todayLogs.forEach((r) => {
    const cp = checkpoints.find((c) => c.code === r.checkpoint_code);
    const div = document.createElement('div');
    div.className = 'today-item';
    div.innerHTML = '<div><b></b> <span class="cp-code"></span><br><span class="small"></span></div>' +
      '<div style="text-align:right"><span class="badge badge-pass"></span><br><span class="small"></span></div>';
    div.querySelector('b').textContent = cp ? cp.name : (r.checkpoint_code || '-');
    div.querySelector('.cp-code').textContent = r.checkpoint_code || '-';
    div.querySelector('.small').textContent = (r.remark || 'ปกติ');
    div.querySelector('.badge').textContent = r.result || 'PASS';
    div.querySelectorAll('.small')[1].textContent = (r.scanned_at ? fmtTime(r.scanned_at) : '-') + ' • ' + (r.distance_m ?? '-') + ' ม.';
    list.appendChild(div);
  });
}

// ---------- Report ----------
// โหมดวัน: แผนที่ + ตารางตามกะที่เลือก (ค่าเริ่มต้น = กะปัจจุบัน)
// โหมดช่วง (>1 วัน): ซ่อนแผนที่ แสดงเฉพาะตาราง + ข้อความแจ้ง
// วันที่ในหน้ารายงาน: ถ้าช่องว่างหรือผิดรูปแบบ ให้ใช้วันปัจจุบันแทนและแจ้งผู้ใช้
// (shiftWindowFor/dayBoundsISO กันซ้ำอีกชั้นด้วย safeDateStr)
function normalizeReportDate() {
  const v = $('report-date').value;
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v + 'T00:00:00').getTime())) {
    const today = localDateStr(new Date());
    $('report-date').value = today;
    toast('ไม่ได้เลือกวันที่ ใช้วันปัจจุบันแทน');
    return today;
  }
  return v;
}
function loadReport() {
  // ตั้งค่าเริ่มต้นครั้งแรก: วันที่ = วันนี้, กะ = กะปัจจุบัน
  if (!$('report-date').value) {
    const cw = currentWindow();
    $('report-date').value = cw.dateStr;
    $('report-shift').value = cw.shift;
  }
  if (reportRange) {
    loadReportRange(reportRange);
  } else {
    loadReportDay($('report-date').value, $('report-shift').value);
  }
}
async function loadReportDay(dateStr, shift) {
  const win = shiftWindowFor(dateStr, shift);
  $('report-window-label').textContent = win.label + ' — กำลังโหลด…';
  $('report-map-card').classList.remove('hidden');
  $('range-note').classList.add('hidden');
  if (!sb || demoMode) {
    logs = getQueue()
      .filter((r) => r.scanned_at >= win.startISO && r.scanned_at <= win.endISO)
      .map((r) => ({ ...r, created_at: r.scanned_at, _queued: true }));
    renderReport(win);
    return;
  }
  try {
    // กรองด้วย scanned_at ที่เซิร์ฟเวอร์ + limit 1000 (ไม่โหลดทั้งตาราง)
    // RLS: ยามเห็นเฉพาะ log ของตัวเอง, ADMIN เห็นทั้งหมด — ไม่เลี่ยง RLS จาก frontend
    const { data, error } = await sb.from('patrol_logs').select('*')
      .gte('scanned_at', win.startISO).lte('scanned_at', win.endISO)
      .order('scanned_at', { ascending: false }).limit(REPORT_LIMIT);
    if (error) throw error;
    logs = (data || []).map((r) => ({ ...r, created_at: r.scanned_at || r.created_at }));
    const queued = getQueue()
      .filter((r) => r.scanned_at >= win.startISO && r.scanned_at <= win.endISO)
      .map((r) => ({ ...r, created_at: r.scanned_at, _queued: true }));
    logs = queued.concat(logs);
    renderReport(win);
  } catch (err) {
    if (isTableMissingError(err)) { demoMode = true; $('demo-banner').classList.remove('hidden'); }
    logs = getQueue()
      .filter((r) => r.scanned_at >= win.startISO && r.scanned_at <= win.endISO)
      .map((r) => ({ ...r, created_at: r.scanned_at, _queued: true }));
    renderReport(win);
  }
}
async function loadReportRange(range) {
  // ช่วง 1 วัน (วันเริ่ม = วันสิ้นสุด) แสดงแผนที่เหมือนโหมดดูเป็นวัน; ช่วงมากกว่า 1 วัน แสดงเฉพาะตาราง
  const singleDay = localDateStr(new Date(range.startISO)) === localDateStr(new Date(range.endISO));
  const win = singleDay ? { label: range.label, startISO: range.startISO, endISO: range.endISO } : null;
  if (singleDay) {
    $('report-map-card').classList.remove('hidden');
    $('range-note').classList.add('hidden');
  } else {
    $('report-map-card').classList.add('hidden');
    $('range-note').classList.remove('hidden');
    $('range-note').textContent = 'ช่วงมากกว่า 1 วัน แสดงเฉพาะตาราง (' + range.label + ')';
  }
  $('report-window-label').textContent = range.label + ' — กำลังโหลด…';
  if (!sb || demoMode) {
    logs = getQueue()
      .filter((r) => r.scanned_at >= range.startISO && r.scanned_at <= range.endISO)
      .map((r) => ({ ...r, created_at: r.scanned_at, _queued: true }));
    renderReport(win);
    return;
  }
  try {
    const { data, error } = await sb.from('patrol_logs').select('*')
      .gte('scanned_at', range.startISO).lte('scanned_at', range.endISO)
      .order('scanned_at', { ascending: false }).limit(REPORT_LIMIT);
    if (error) throw error;
    logs = (data || []).map((r) => ({ ...r, created_at: r.scanned_at || r.created_at }));
    const queued = getQueue()
      .filter((r) => r.scanned_at >= range.startISO && r.scanned_at <= range.endISO)
      .map((r) => ({ ...r, created_at: r.scanned_at, _queued: true }));
    logs = queued.concat(logs);
    renderReport(win);
  } catch (err) {
    if (isTableMissingError(err)) { demoMode = true; $('demo-banner').classList.remove('hidden'); }
    logs = getQueue()
      .filter((r) => r.scanned_at >= range.startISO && r.scanned_at <= range.endISO)
      .map((r) => ({ ...r, created_at: r.scanned_at, _queued: true }));
    renderReport(win);
  }
}
function filteredReportRows() {
  const cp = $('filter-cp').value, res = $('filter-result').value;
  return logs.filter((r) => {
    if (cp && r.checkpoint_code !== cp) return false;
    if (res && r.result !== res) return false;
    return true;
  });
}
function renderReport(win) {
  const rows = filteredReportRows();
  const isAdmin = currentUser && currentUser.role === 'ADMIN';
  const thManage = $('th-manage'); if (thManage) thManage.classList.toggle('hidden', !isAdmin);
  const tb = $('log-rows');
  $('log-count').textContent = 'แสดง ' + rows.length + ' รายการ' + (logs.length >= REPORT_LIMIT ? ' (แสดงสูงสุด ' + REPORT_LIMIT + ' รายการ — ลองเลือกช่วงแคบลง)' : '') + (getQueue().length ? ' • คิวออฟไลน์ค้าง ' + getQueue().length + ' รายการ' : '');
  const colSpan = isAdmin ? 7 : 6;
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="' + colSpan + '" class="muted">ยังไม่มีข้อมูลในช่วงนี้</td></tr>'; }
  else {
    tb.innerHTML = '';
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      const cp = checkpoints.find((c) => c.code === r.checkpoint_code);
      const cells = isAdmin ? 7 : 6;
      for (let i = 0; i < cells; i++) tr.appendChild(document.createElement('td'));
      tr.children[0].textContent = r.created_at ? fmtTime(r.created_at) : '-';
      tr.children[1].textContent = r.checkpoint_code + (cp ? ' ' + cp.name : '') + (r._queued ? ' (คิว)' : '');
      tr.children[2].textContent = r.guard_username || r.guard_name || '-';
      tr.children[3].textContent = (r.distance_m ?? '-') + (r.accuracy_m ? ' (±' + r.accuracy_m + ')' : '');
      const badge = document.createElement('span');
      badge.className = 'badge ' + (r.result === 'PASS' ? 'badge-pass' : 'badge-fail');
      badge.textContent = r.result || '-';
      tr.children[4].appendChild(badge);
      tr.children[5].textContent = r.remark || '-';
      if (isAdmin) {
        const td = tr.children[6];
        const mk = (t, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary'; b.style.cssText = 'padding:6px 10px;font-size:13px;margin-right:4px'; b.textContent = t; b.onclick = fn; td.appendChild(b); };
        if (r.id && !r._queued) {
          mk('แก้หมายเหตุ', () => editLogRemark(r));
          mk('ลบ', () => deleteLog(r));
        } else {
          td.textContent = '-';
        }
      }
      tb.appendChild(tr);
    });
  }
  if (win) {
    // นับจุดที่ตรวจแล้วในกะนี้ (นับจุดไม่ซ้ำ) จาก log ในหน้าต่างกะ
    const doneCodes = new Set(logs.map((r) => r.checkpoint_code).filter(Boolean));
    $('report-window-label').textContent = win.label + ' — ตรวจแล้ว ' + doneCodes.size + '/' + checkpoints.length + ' จุด';
    renderReportMap(doneCodes);
  }
}
function initReportMap() {
  if (typeof L === 'undefined') return;
  if (reportMap) { reportMap.invalidateSize(); return; }
  reportMap = L.map('report-map').setView(DEFAULT_CENTER, 15);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, Maxar, Earthstar Geographics', maxZoom: 19
  }).addTo(reportMap);
  renderReportMap(new Set(logs.map((r) => r.checkpoint_code).filter(Boolean)));
}
// แผนที่รายงานรายวัน: เขียว = ตรวจแล้วในกะนี้, แดง = ยังไม่ตรวจ
function renderReportMap(doneCodes) {
  if (!reportMap || typeof L === 'undefined') return;
  reportMarkers.forEach((m) => reportMap.removeLayer(m)); reportMarkers = [];
  const byCode = {};
  logs.forEach((r) => { if (r.checkpoint_code && !byCode[r.checkpoint_code]) byCode[r.checkpoint_code] = r; });
  checkpoints.forEach((c) => {
    const done = doneCodes.has(c.code);
    const color = done ? '#15803d' : '#dc2626';
    const m = L.circleMarker([c.lat, c.lng], { radius: 10, color, fillColor: color, fillOpacity: 0.9 }).addTo(reportMap);
    if (done) {
      const r = byCode[c.code];
      m.bindPopup('<b>' + c.code + ' ' + c.name + '</b><br>✅ ตรวจแล้ว<br>ผู้ตรวจ: ' + (r.guard_username || '-') +
        '<br>เวลา: ' + (r.created_at ? fmtTime(r.created_at) : '-') +
        '<br>ระยะ: ' + (r.distance_m ?? '-') + ' ม.<br>หมายเหตุ: ' + (r.remark || '-'));
    } else {
      m.bindPopup('<b>' + c.code + ' ' + c.name + '</b><br>❌ ยังไม่ได้ตรวจในกะนี้');
    }
    reportMarkers.push(m);
  });
}
function exportCSV() {
  const rows = filteredReportRows();
  const head = ['เวลา', 'รหัสจุด', 'จุดตรวจ', 'ผู้ตรวจ', 'ละติจูด', 'ลองจิจูด', 'ความแม่นยำ(ม.)', 'ระยะ(ม.)', 'ผล', 'หมายเหตุ'];
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [head.map(esc).join(',')];
  rows.forEach((r) => {
    const cp = checkpoints.find((c) => c.code === r.checkpoint_code);
    lines.push([r.created_at || '', r.checkpoint_code || '', cp ? cp.name : '', r.guard_username || r.guard_name || '',
      r.lat ?? '', r.lng ?? '', r.accuracy_m ?? '', r.distance_m ?? '', r.result || '', r.remark || ''].map(esc).join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sk-guard-report-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------- Admin: จัดการ log (แก้หมายเหตุ / ลบ) ----------
async function editLogRemark(r) {
  const next = prompt('แก้ไขหมายเหตุของ ' + r.checkpoint_code + ' (' + (r.guard_username || '-') + ')', r.remark || '');
  if (next === null) return; // กดยกเลิก
  if (demoMode || !sb) { toast('โหมด Demo แก้หมายเหตุไม่ได้'); return; }
  try {
    const { error } = await sb.from('patrol_logs').update({ remark: next.trim() }).eq('id', r.id);
    if (error) throw error;
    toast('แก้ไขหมายเหตุแล้ว');
    loadReport();
  } catch (err) { toast('แก้ไขไม่สำเร็จ: ' + (err.message || err)); }
}
async function deleteLog(r) {
  if (!confirm('ลบประวัติการตรวจ ' + r.checkpoint_code + ' ของ ' + (r.guard_username || '-') + ' เวลา ' + (r.created_at ? fmtTime(r.created_at) : '-') + ' ใช่ไหม?')) return;
  if (demoMode || !sb) { toast('โหมด Demo ลบไม่ได้'); return; }
  try {
    const { error } = await sb.from('patrol_logs').delete().eq('id', r.id);
    if (error) throw error;
    toast('ลบประวัติแล้ว');
    loadReport();
  } catch (err) { toast('ลบไม่สำเร็จ: ' + (err.message || err)); }
}

// ---------- Admin: จุดตรวจ ----------
function renderAdminList() {
  const list = $('admin-cp-list');
  list.innerHTML = checkpoints.length ? '' : '<p class="muted">ไม่มีจุดตรวจ</p>';
  checkpoints.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'cp-item';
    div.innerHTML = '<div><b></b> <span class="cp-code"></span><br><span class="small"></span></div><div></div>';
    div.querySelector('b').textContent = c.name;
    div.querySelector('.cp-code').textContent = c.code;
    div.querySelector('.small').textContent = c.lat + ', ' + c.lng + ' • รัศมี ' + c.radius + ' ม.';
    const btns = div.children[1];
    const mk = (t, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary'; b.style.cssText = 'padding:6px 10px;font-size:13px;margin-left:4px'; b.textContent = t; b.onclick = fn; btns.appendChild(b); };
    mk('QR', () => showQrModal(c));
    mk('แก้ไข', () => fillCpForm(c));
    mk('ลบ', () => deleteCheckpoint(c));
    list.appendChild(div);
  });
}
function fillCpForm(c) {
  $('cp-id').value = c.code; // checkpoints ใช้ code เป็น PK ไม่มี id
  $('cp-code').value = c.code; $('cp-name').value = c.name;
  $('cp-lat').value = c.lat; $('cp-lng').value = c.lng; $('cp-radius').value = c.radius;
  $('cp-form').scrollIntoView({ behavior: 'smooth' });
}
async function saveCheckpoint(e) {
  e.preventDefault();
  const status = $('cp-form-status');
  const row = {
    code: $('cp-code').value.trim().toUpperCase(),
    name: $('cp-name').value.trim(),
    lat: parseFloat($('cp-lat').value), lng: parseFloat($('cp-lng').value),
    radius_m: parseInt($('cp-radius').value, 10) || 50
  };
  if (!row.code || !row.name || Number.isNaN(row.lat) || Number.isNaN(row.lng)) { status.textContent = 'กรุณากรอกข้อมูลให้ครบและถูกต้อง'; return; }
  const id = $('cp-id').value; // รหัสเดิม (code) สำหรับ update
  if (demoMode || !sb) {
    if (id) { const i = checkpoints.findIndex((c) => String(c.code) === String(id)); if (i >= 0) checkpoints[i] = { ...checkpoints[i], ...row, radius: row.radius_m }; }
    else checkpoints.push({ id: row.code, ...row, radius: row.radius_m, active: true });
    status.textContent = 'บันทึกแล้ว (โหมด Demo — ข้อมูลในเครื่องเท่านั้น)';
    renderCheckpointMeta(); renderAdminList(); $('cp-form').reset(); $('cp-id').value = ''; return;
  }
  try {
    let error;
    if (id) ({ error } = await sb.from('checkpoints').update(row).eq('code', id));
    else ({ error } = await sb.from('checkpoints').insert([row]));
    if (error) throw error;
    status.textContent = '✅ บันทึกจุดตรวจแล้ว';
    $('cp-form').reset(); $('cp-id').value = '';
    await loadCheckpoints(); renderAdminList();
  } catch (err) { status.textContent = 'บันทึกไม่สำเร็จ: ' + (err.message || err); }
}
async function deleteCheckpoint(c) {
  if (!confirm('ลบจุดตรวจ ' + c.code + ' ' + c.name + ' ใช่ไหม?')) return;
  if (demoMode || !sb) {
    checkpoints = checkpoints.filter((x) => x.code !== c.code);
    renderCheckpointMeta(); renderAdminList(); return;
  }
  try {
    const { error } = await sb.from('checkpoints').delete().eq('code', c.code);
    if (error) throw error;
    await loadCheckpoints(); renderAdminList();
  } catch (err) {
    // FK restrict: จุดที่มีประวัติการตรวจอยู่แล้วลบไม่ได้ — บอกเป็นภาษาไทย ไม่โชว์ error ดิบ
    const msg = String((err && (err.message || err)) || '');
    if ((err && err.code === '23503') || /foreign key|violates foreign key/i.test(msg)) {
      toast('ลบไม่ได้ เพราะจุดนี้มีประวัติการตรวจอยู่แล้ว');
    } else {
      toast('ลบไม่สำเร็จ: ' + (err.message || err));
    }
  }
}
function showQrModal(c) {
  $('qr-modal-title').textContent = 'QR จุดตรวจ ' + c.code;
  $('qr-modal-code').textContent = c.code;
  $('qr-modal-name').textContent = c.name;
  const box = $('qr-box'); box.innerHTML = '';
  // QR มีแค่รหัสสั้นเท่านั้น, Error Correction Level H
  new QRCode(box, { text: c.code, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.H });
  $('qr-modal').classList.add('open');
}

// ---------- Admin: จัดการผู้ใช้ (profiles) ----------
// profiles.id เป็น FK ไป auth.users — สร้างแถวสุ่มเองไม่ได้
// เพิ่มผู้ใช้ใหม่: สร้างใน Supabase Dashboard > Authentication > Add user
// (อีเมล <username>@skguard.local + Auto Confirm) แล้ว trigger ใน
// supabase/006_profile_trigger.sql จะสร้างแถว profile ให้อัตโนมัติ
async function loadProfiles() {
  const list = $('user-list');
  if (demoMode || !sb) {
    list.innerHTML = DEMO_USERS.map((u) => '<div class="cp-item"><div><b>' + u.display_name + '</b> <span class="badge badge-admin">' + u.role + '</span><br><span class="small">' + u.email + '</span></div></div>').join('');
    return;
  }
  try {
    const { data, error } = await sb.from('profiles').select('*').order('username');
    if (error) throw error;
    list.innerHTML = (data || []).length ? '' : '<p class="muted">ไม่มีผู้ใช้ใน profiles</p>';
    (data || []).forEach((u) => {
      const div = document.createElement('div'); div.className = 'cp-item';
      div.innerHTML = '<div><b></b> <span class="badge badge-admin"></span><br><span class="small"></span></div><div></div>';
      div.querySelector('b').textContent = u.full_name || u.username || '-';
      div.querySelector('.badge').textContent = (u.role || 'GUARD').toUpperCase();
      div.querySelector('.small').textContent = (u.username || '') + (u.is_active === false ? ' • ปิดใช้งาน' : '');
      const btns = div.children[1];
      const mk = (t, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn-secondary'; b.style.cssText = 'padding:6px 10px;font-size:13px;margin-left:4px'; b.textContent = t; b.onclick = fn; btns.appendChild(b); };
      mk('แก้ไข', () => editProfile(u));
      mk('ลบ', () => deleteProfile(u));
      list.appendChild(div);
    });
  } catch (err) {
    list.innerHTML = '<p class="muted">โหลดรายชื่อผู้ใช้ไม่ได้: ' + (err.message || err) + ' (ตาราง profiles อาจยังไม่ถูกสร้าง)</p>';
  }
}
// แก้ผู้ใช้ด้วยฟอร์มในหน้า (ไม่ใช้ prompt/confirm — งงสำหรับคนไม่เก่ง IT)
function editProfile(u) {
  $('user-id').value = u.id || '';
  $('user-username').textContent = u.username || '-';
  $('user-fullname').value = u.full_name || '';
  $('user-role').value = (u.role || 'GUARD').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'GUARD';
  $('user-active').checked = u.is_active !== false;
  $('user-form-status').textContent = '';
  $('user-form').classList.remove('hidden');
  $('user-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('user-fullname').focus();
}
async function saveProfile(e) {
  if (e) e.preventDefault();
  const id = $('user-id').value;
  if (!id) { toast('กรุณากดปุ่ม “แก้ไข” ที่รายชื่อผู้ใช้ก่อน'); return; }
  const role = $('user-role').value;
  if (role !== 'ADMIN' && role !== 'GUARD') { toast('บทบาทต้องเป็น ADMIN หรือ GUARD เท่านั้น'); return; }
  if (demoMode || !sb) { toast('โหมด Demo แก้ข้อมูลผู้ใช้ไม่ได้'); return; }
  try {
    const { error } = await sb.from('profiles').update({
      full_name: $('user-fullname').value.trim() || null,
      role,
      is_active: $('user-active').checked
    }).eq('id', id);
    if (error) throw error;
    $('user-form-status').textContent = '✅ บันทึกข้อมูลผู้ใช้แล้ว';
    toast('บันทึกข้อมูลผู้ใช้แล้ว');
    $('user-form').classList.add('hidden');
    loadProfiles();
  } catch (err) { $('user-form-status').textContent = 'บันทึกไม่สำเร็จ: ' + (err.message || err); }
}
async function deleteProfile(u) {
  if (!confirm('ลบผู้ใช้ ' + (u.username || '') + ' (' + (u.full_name || '-') + ') ใช่ไหม?\n\nลบเฉพาะแถวในตาราง profiles เท่านั้น บัญชีล็อกอินใน Supabase Auth จะยังคงอยู่ ต้องไปลบใน Supabase Dashboard > Authentication อีกทีถ้าต้องการลบถาวร')) return;
  try {
    const { error } = await sb.from('profiles').delete().eq('id', u.id);
    if (error) throw error;
    toast('ลบผู้ใช้แล้ว (เฉพาะ profiles)');
    loadProfiles();
  } catch (err) { toast('ลบไม่สำเร็จ: ' + (err.message || err)); }
}

// ---------- Init ----------
function bindEvents() {
  $('login-form').addEventListener('submit', doLogin);
  $('btn-logout').addEventListener('click', doLogout);
  $('btn-demo').addEventListener('click', () => {
    demoMode = true;
    setLoggedIn({ id: null, email: 'demo@demo', display_name: 'ผู้ใช้ทดลอง', role: 'GUARD', demo: true });
    toast('โหมดทดลอง — ไม่ใช่ข้อมูลจริง');
  });
  document.querySelectorAll('#bottomnav button').forEach((b) => b.addEventListener('click', () => {
    if (!currentUser) { toast('กรุณาเข้าสู่ระบบก่อน'); return; }
    if (b.dataset.view === 'admin' && currentUser.role !== 'ADMIN') {
      toast('หน้านี้เฉพาะผู้ดูแลระบบ (ADMIN)'); return;
    }
    showView(b.dataset.view);
  }));
  $('btn-gps').addEventListener('click', async () => { await requestFreshPosition(); updateScanGate(); if (scanned) refreshScanCalc(); });
  $('btn-scan-live').addEventListener('click', startLiveScan);
  $('btn-scan-stop').addEventListener('click', stopLiveScan);
  $('btn-scan-photo').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', (e) => { handleQrFileScan(e.target.files[0]); e.target.value = ''; });
  // ไม่มีช่องกรอกรหัสจุดเองในหน้าของยาม — ทดสอบรหัสได้เฉพาะในหน้า Admin
  $('btn-admin-test').addEventListener('click', () => {
    const code = $('admin-test-code').value.trim();
    if (code) previewCheckpoint(code); else toast('กรอกรหัสจุดตรวจก่อน');
  });
  // ผลการตรวจ: เปลี่ยนตัวเลือกแล้วคำนวณปุ่มบันทึกใหม่
  $('remark-type').addEventListener('change', updateRemarkUI);
  $('remark-sub').addEventListener('change', updateRemarkUI);
  $('remark-other').addEventListener('input', () => { if (scanned) refreshScanCalc(); });
  $('btn-confirm-scan').addEventListener('click', submitScan);
  $('btn-cancel-scan').addEventListener('click', () => { scanned = null; $('scan-card').classList.add('hidden'); $('save-status').textContent = ''; });
  // รายงาน: ดูเป็นวัน (วันที่ว่าง/ผิดรูปแบบ: ใช้วันปัจจุบันแทน ไม่ให้แอปพัง)
  $('btn-report-day').addEventListener('click', () => { reportRange = null; loadReportDay(normalizeReportDate(), $('report-shift').value); });
  $('btn-filter').addEventListener('click', () => renderReport(reportRange ? null : shiftWindowFor(normalizeReportDate(), $('report-shift').value)));
  $('btn-reload-logs').addEventListener('click', loadReport);
  $('btn-export-csv').addEventListener('click', exportCSV);
  // รายงาน: ดูเป็นช่วง 7 / 15 / 30 วัน (นับถอยหลังจากวันนี้)
  document.querySelectorAll('[data-range-days]').forEach((b) => b.addEventListener('click', () => {
    const days = parseInt(b.dataset.rangeDays, 10);
    const end = new Date(); end.setHours(23, 59, 59, 0);
    const start = new Date(); start.setDate(start.getDate() - (days - 1)); start.setHours(0, 0, 0, 0);
    reportRange = { startISO: start.toISOString(), endISO: end.toISOString(), label: days + ' วันล่าสุด (' + localDateStr(start) + ' – ' + localDateStr(end) + ')' };
    loadReportRange(reportRange);
  }));
  // รายงาน: กำหนดช่วงเอง (วันเริ่มต้น – วันสิ้นสุด)
  $('btn-report-range').addEventListener('click', () => {
    const s = $('range-start').value, e = $('range-end').value;
    if (!s || !e) { toast('กรุณาเลือกวันเริ่มต้นและวันสิ้นสุด'); return; }
    if (s > e) { toast('วันเริ่มต้นต้องไม่เกินวันสิ้นสุด'); return; }
    const { startISO } = dayBoundsISO(s);
    const { endISO } = dayBoundsISO(e);
    reportRange = { startISO, endISO, label: 'ช่วง ' + s + ' – ' + e };
    loadReportRange(reportRange);
  });
  $('cp-form').addEventListener('submit', saveCheckpoint);
  $('btn-cp-reset').addEventListener('click', () => { $('cp-form').reset(); $('cp-id').value = ''; });
  $('user-form').addEventListener('submit', saveProfile);
  $('btn-user-cancel').addEventListener('click', () => { $('user-form').classList.add('hidden'); $('user-id').value = ''; });
  $('btn-close-qr').addEventListener('click', () => $('qr-modal').classList.remove('open'));
  $('btn-print-qr').addEventListener('click', () => window.print());
  $('qr-modal').addEventListener('click', (e) => { if (e.target === $('qr-modal')) $('qr-modal').classList.remove('open'); });
  window.addEventListener('online', updateOnlineBanner);
  window.addEventListener('offline', updateOnlineBanner);
  if (sb) sb.auth.onAuthStateChange((_ev, session) => {
    if (!session && currentUser && !currentUser.demo) setLoggedOut();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  bindEvents();
  updateOnlineBanner();
  updateQueueChip();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  checkSession();
});
