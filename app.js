/* SK Guard PWA - app.js
   Backend: Supabase (Auth + Postgres) 100% - ไม่ใช้ GAS / Google Sheets
   ตารางจริง (ดู supabase/001_schema.sql — backend สร้างไว้แล้ว):
     checkpoints: code (PK), name, lat, lng, radius_m, is_active
     patrol_logs: id, guard_id, guard_username, checkpoint_code, scanned_at,
                  lat, lng, accuracy_m, distance_m, result, remark, synced
     profiles:    id, username, full_name, role, is_active
   RLS: insert patrol_logs ต้องมี guard_id = auth.uid() ของผู้ล็อกอิน
   ถ้าตารางยังไม่ถูกสร้าง แอปจะเข้าโหมด Demo (ข้อมูลตัวอย่างในเครื่อง) ไม่ค้าง */
'use strict';

const DEMO_CHECKPOINTS = [
  { id: 'demo-cp01', code: 'CP01', name: 'ป้อมยามประตู 1', lat: 17.765, lng: 100.56, radius: 50, active: true },
  { id: 'demo-cp02', code: 'CP02', name: 'อาคารสันเขื่อน', lat: 17.7662, lng: 100.5615, radius: 50, active: true },
  { id: 'demo-cp03', code: 'CP03', name: 'อาคารที่ทำการเขื่อนสิริกิติ์', lat: 17.744768, lng: 100.557775, radius: 50, active: true }
];
const DEMO_USERS = [
  { email: 'admin@skguard.local', display_name: 'admin', role: 'ADMIN', is_active: true },
  { email: 'guard1@skguard.local', display_name: 'guard1', role: 'GUARD', is_active: true }
];
const QUEUE_KEY = 'skguard_offline_queue_v1';
const SHIFT_KEY = 'skguard_shift_v1';
const GPS_FRESH_MS = 15000;      // B3: ตำแหน่ง GPS ต้องสดไม่เกิน 15 วินาทีตอนสแกน/บันทึก
const ACCURACY_LIMIT_M = 30;     // B7: accuracy เกิน 30 ม. บล็อกการบันทึก
let DEFAULT_CENTER = [17.765, 100.56];
let appSettings = { site_name: 'เขื่อนสิริกิติ์', default_radius_m: 50, default_lat: 17.765, default_lng: 100.56 };
let currentShift = null;         // B1: {id, guard_id, started_at, ended_at, done:[codes], donePass:[codes], demo}
let savingScan = false;          // G1: กันกดยืนยันซ้ำ
let gpsDenied = false;           // B2: ผู้ใช้ปฏิเสธสิทธิ์ Location
let gpsUnavailable = false;

let sb = null;
let currentUser = null;      // {id, email, display_name, role, demo}
let checkpoints = [];
let logs = [];
let demoMode = false;
let currentPos = null;       // {lat, lng, accuracy, timestamp}
let scanned = null;          // checkpoint ที่สแกนได้
let map = null, userMarker = null, cpMarkers = [];
let liveScanner = null, liveRunning = false;
let watchId = null;

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
function fmtDate(d) { return new Date(d).toLocaleDateString('th-TH'); }

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
  // B6: ยังไม่ล็อกอิน ห้ามเปิดหน้าใดๆ นอกจาก login
  if (!currentUser && name !== 'login') { name = 'login'; }
  // B6: หน้า Admin ต้องเป็น ADMIN เท่านั้น แม้ currentUser จะมีอยู่แล้ว
  if (name === 'admin' && currentUser && currentUser.role !== 'ADMIN') {
    toast('หน้านี้เฉพาะผู้ดูแลระบบ (ADMIN)'); name = 'dashboard';
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = $('view-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('#bottomnav button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === name));
  if (name === 'dashboard') { setTimeout(initMap, 50); renderShift(); updateScanGate(); }
  if (name === 'report') loadLogs();
  if (name === 'admin') { renderAdminList(); loadProfiles(); }
}
function setLoggedIn(user) {
  currentUser = user;
  $('userbar').classList.remove('hidden');
  $('bottomnav').classList.remove('hidden');
  // B6: ซ่อนปุ่มจัดการจากยาม (กดเข้าไปก็ถูกบล็อกที่ showView อีกชั้น)
  const navAdmin = $('nav-admin'); if (navAdmin) navAdmin.classList.toggle('hidden', user.role !== 'ADMIN');
  $('user-info').textContent = user.display_name + ' (' + user.role + ')' + (user.demo ? ' • Demo' : '');
  $('demo-banner').classList.toggle('hidden', !demoMode);
  loadShift(); // B1: โหลดกะที่ค้างอยู่ของผู้ใช้นี้
  showView('dashboard');
  startGPS();
  loadSettings().then(() => loadCheckpoints());
  updateQueueChip();
  syncQueue();
}
function setLoggedOut() {
  currentUser = null; demoMode = false; currentShift = null; savingScan = false;
  stopLiveScan();
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  $('userbar').classList.add('hidden');
  $('bottomnav').classList.add('hidden'); // B6: ซ่อนแถบล่างกลับเมื่อออกจากระบบ
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
  // คืน true = ล็อกอินสำเร็จ, false = บล็อก (บัญชีถูกปิด / ไม่มี profiles)
  let role = 'GUARD', display = authUser.email || 'guard';
  let profileFound = false, tableMissing = false, profileInactive = false;
  try {
    const { data, error } = await sb.from('profiles').select('*').eq('id', authUser.id).maybeSingle();
    if (!error && data) {
      profileFound = true;
      if (data.is_active === false) profileInactive = true; // G3
      role = (data.role || 'GUARD').toUpperCase();
      display = data.full_name || data.username || data.email || display;
    } else if (error && isTableMissingError(error)) {
      demoMode = true; tableMissing = true;
    }
  } catch (e) { /* profiles อ่านไม่ได้ ใช้ค่าเริ่มต้น */ }
  if (profileInactive) { // G3: บัญชีถูกปิดใช้งาน ห้ามล็อกอิน
    try { await sb.auth.signOut(); } catch (e) {}
    const errEl = $('login-error');
    errEl.textContent = 'บัญชีนี้ถูกปิดใช้งานแล้ว กรุณาติดต่อผู้ดูแลระบบ';
    errEl.classList.remove('hidden');
    setLoggedOut(); return false;
  }
  // G4: ไม่มีแถว profiles = ยังไม่ได้ผูกบัญชี ห้ามให้สิทธิ์ใดๆ จากอีเมล
  // (เดิมให้ ADMIN แค่เพราะอีเมลขึ้นต้น admin@ — เอาออกแล้ว)
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

// G9: แปลข้อความ error ล็อกอินของ Supabase เป็นภาษาไทย
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
  if (!email.includes('@')) email += '@skguard.local'; // พิมพ์แค่ admin / guard1 ก็ได้
  if (!sb) { errEl.textContent = 'เชื่อม Supabase ไม่ได้ กรุณาใช้โหมด Demo'; errEl.classList.remove('hidden'); return; }
  $('btn-login').disabled = true;
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data && data.user) await applyAuthUser(data.user);
  } catch (err) {
    errEl.textContent = translateLoginError(err); // G9: ข้อความภาษาไทย
    errEl.classList.remove('hidden');
  } finally { $('btn-login').disabled = false; }
}
async function doLogout() {
  try { if (sb) await sb.auth.signOut(); } catch (e) {}
  setLoggedOut();
  toast('ออกจากระบบแล้ว');
}

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
    renderCheckpoints(); return;
  }
  try {
    const { data, error } = await sb.from('checkpoints').select('*').order('code');
    if (error) throw error;
    checkpoints = (data || []).map(normCheckpoint).filter((c) => c.active !== false);
    if (!checkpoints.length) { demoMode = true; checkpoints = DEMO_CHECKPOINTS.slice(); $('demo-banner').classList.remove('hidden'); }
    renderCheckpoints();
  } catch (err) {
    if (isTableMissingError(err)) {
      demoMode = true;
      checkpoints = DEMO_CHECKPOINTS.slice();
      $('demo-banner').classList.remove('hidden');
      toast('ยังไม่ได้สร้างตารางใน Supabase — ใช้โหมดทดลอง');
    } else {
      toast('โหลดจุดตรวจไม่สำเร็จ: ' + (err.message || err));
    }
    renderCheckpoints();
  }
}
function renderCheckpoints() {
  $('cp-count').textContent = checkpoints.length;
  const list = $('cp-list');
  list.innerHTML = checkpoints.length ? '' : '<p class="muted">ไม่มีจุดตรวจ</p>';
  checkpoints.forEach((c) => {
    const d = currentPos ? Math.round(haversine(currentPos.lat, currentPos.lng, c.lat, c.lng)) : null;
    const div = document.createElement('div');
    div.className = 'cp-item';
    div.innerHTML = '<div><b></b> <span class="cp-code"></span><br><span class="small"></span></div>' +
      '<div style="text-align:right"><span class="small">รัศมี ' + c.radius + ' ม.</span><br>' +
      (d === null ? '<span class="small">ระยะ: -</span>' : '<span class="small">ห่าง ~' + d + ' ม.</span>') + '</div>';
    div.querySelector('b').textContent = c.name;
    div.querySelector('.cp-code').textContent = c.code;
    div.querySelector('.small').textContent = c.lat + ', ' + c.lng;
    list.appendChild(div);
  });
  const sel = $('filter-cp');
  const cur = sel.value;
  sel.innerHTML = '<option value="">ทั้งหมด</option>';
  checkpoints.forEach((c) => { const o = document.createElement('option'); o.value = c.code; o.textContent = c.code + ' ' + c.name; sel.appendChild(o); });
  sel.value = cur;
  drawMapMarkers();
  renderShift(); // B1: อัปเดตความคืบหน้ากะเมื่อรายการจุดตรวจเปลี่ยน
}

// ---------- Settings (G6: อ่านตาราง settings มาใช้จริง) ----------
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
    // ตาราง settings ยังไม่มี / อ่านไม่ได้: ใช้ค่าเริ่มต้นในเครื่องต่อไป ไม่ค้าง
  }
}

// ---------- Shift / กะ (B1) ----------
function shiftStorageKey() {
  return SHIFT_KEY + ':' + (currentUser ? (currentUser.id || currentUser.email || 'demo') : 'anon');
}
function saveShiftLocal() {
  try { localStorage.setItem(shiftStorageKey(), JSON.stringify(currentShift)); } catch (e) {}
}
function loadShift() {
  currentShift = null;
  try {
    const raw = localStorage.getItem(shiftStorageKey());
    if (raw) {
      const s = JSON.parse(raw);
      // กะเก่าข้ามวันถือว่าจบแล้ว ไม่เอามานับต่อ
      if (s && !s.ended_at && String(s.started_at || '').slice(0, 10) === new Date().toISOString().slice(0, 10)) {
        currentShift = { done: [], donePass: [], ...s };
      }
    }
  } catch (e) { currentShift = null; }
  // โหลดกะที่เปิดค้างจากตาราง shifts (ถ้ามี) แล้วรวมกับ local
  loadActiveShiftFromDb().catch(() => {});
  renderShift();
}
async function loadActiveShiftFromDb() {
  if (!sb || demoMode || !currentUser || !currentUser.id) return;
  try {
    const { data, error } = await sb.from('shifts').select('*')
      .eq('guard_id', currentUser.id).is('ended_at', null)
      .order('started_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    if (data) {
      currentShift = {
        id: data.id, guard_id: data.guard_id, started_at: data.started_at, ended_at: data.ended_at,
        done: data.completed_codes || [], donePass: (data.completed_codes || []).slice(), demo: false
      };
      saveShiftLocal(); renderShift();
    }
  } catch (err) { /* ตาราง shifts ยังไม่มี: ใช้กะในเครื่องอย่างเดียว */ }
}
async function startShift() {
  if (!currentUser) { toast('กรุณาเข้าสู่ระบบก่อนเริ่มกะ'); return; }
  const now = new Date().toISOString();
  currentShift = { id: null, guard_id: currentUser.id || null, started_at: now, ended_at: null, done: [], donePass: [], demo: demoMode };
  // พยายามบันทึกกะลงตาราง shifts ถ้ามี (ล้มเหลวเพราะตารางยังไม่มีก็ใช้กะในเครื่องต่อ)
  if (sb && !demoMode && currentUser.id) {
    try {
      const { data, error } = await sb.from('shifts').insert([{
        guard_id: currentUser.id, guard_username: currentUser.display_name || currentUser.email,
        started_at: now, status: 'active', total_points: checkpoints.length
      }]).select('id').single();
      if (!error && data) currentShift.id = data.id;
    } catch (e) { /* fallback local */ }
  }
  saveShiftLocal(); renderShift(); updateScanGate();
  toast('เริ่มกะแล้ว — ต้องตรวจให้ครบ ' + checkpoints.length + ' จุด');
}
async function endShift() {
  if (!currentShift) return;
  const done = currentShift.done.length, total = checkpoints.length;
  currentShift.ended_at = new Date().toISOString();
  if (sb && !demoMode && currentShift.id) {
    try {
      await sb.from('shifts').update({ ended_at: currentShift.ended_at, status: done >= total ? 'complete' : 'incomplete', completed_codes: currentShift.done }).eq('id', currentShift.id);
    } catch (e) { /* เก็บสถานะในเครื่องต่อ */ }
  }
  const msg = done >= total
    ? 'จบกะแล้ว — ตรวจครบทุกจุด (' + done + '/' + total + ') ✅'
    : 'จบกะแล้ว — ตรวจไป ' + done + '/' + total + ' จุด ยังขาด ' + (total - done) + ' จุด';
  saveShiftLocal(); renderShift(); updateScanGate();
  toast(msg);
  alert(msg);
}
function shiftDoneFromLogs() {
  // รวมจุดที่ตรวจแล้วในกะนี้จาก log ของผู้ใช้ (กันกรณีโหลดหน้าใหม่/เปลี่ยนเครื่อง)
  if (!currentShift || !logs) return;
  const start = currentShift.started_at;
  logs.forEach((r) => {
    if (!r.checkpoint_code || !r.scanned_at) return;
    if (start && r.scanned_at < start) return;
    if (currentUser && r.guard_id && currentUser.id && r.guard_id !== currentUser.id && !r._queued) return;
    if (!currentShift.done.includes(r.checkpoint_code)) currentShift.done.push(r.checkpoint_code);
    if (r.result === 'PASS' && !currentShift.donePass.includes(r.checkpoint_code)) currentShift.donePass.push(r.checkpoint_code);
  });
}
function renderShift() {
  const card = $('shift-card'); if (!card) return;
  const total = checkpoints.length;
  if (!currentShift) {
    $('shift-status').textContent = 'ยังไม่ได้เริ่มกะ — กด “เริ่มกะ” แล้วเดินตรวจให้ครบทุกจุด';
    $('shift-progress-text').textContent = '0/' + total + ' จุด';
    $('shift-progress-bar').style.width = '0%';
    $('shift-done-list').innerHTML = '<p class="muted">ยังไม่มีจุดที่ตรวจแล้วในกะนี้</p>';
    $('shift-remaining-list').innerHTML = checkpoints.map((c) => '<p>• ' + c.code + ' ' + c.name + '</p>').join('') || '<p class="muted">ไม่มีจุดตรวจ</p>';
    $('btn-start-shift').classList.remove('hidden');
    $('btn-end-shift').classList.add('hidden');
    return;
  }
  shiftDoneFromLogs();
  const done = currentShift.done.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('shift-status').textContent = currentShift.ended_at
    ? 'จบกะแล้ว ' + fmtTime(currentShift.ended_at) + ' — ' + (done >= total ? 'ตรวจครบทุกจุด ✅' : 'ยังขาด ' + (total - done) + ' จุด')
    : 'กำลังตรวจกะนี้ เริ่ม ' + fmtTime(currentShift.started_at);
  $('shift-progress-text').textContent = done + '/' + total + ' จุด (' + pct + '%)';
  $('shift-progress-bar').style.width = pct + '%';
  $('shift-done-list').innerHTML = currentShift.done.length
    ? currentShift.done.map((code) => { const c = checkpoints.find((x) => x.code === code); return '<p>✅ ' + code + ' ' + (c ? c.name : '') + '</p>'; }).join('')
    : '<p class="muted">ยังไม่มีจุดที่ตรวจแล้วในกะนี้</p>';
  const remaining = checkpoints.filter((c) => !currentShift.done.includes(c.code));
  $('shift-remaining-list').innerHTML = remaining.length
    ? remaining.map((c) => '<p>• ' + c.code + ' ' + c.name + '</p>').join('')
    : '<p><b>ครบทุกจุดแล้ว ✅</b></p>';
  $('btn-start-shift').classList.add('hidden');
  $('btn-end-shift').classList.toggle('hidden', !!currentShift.ended_at);
  if (currentShift.ended_at) $('btn-start-shift').classList.remove('hidden');
}
function markShiftDone(code, result) {
  if (!currentShift || currentShift.ended_at) return;
  if (!currentShift.done.includes(code)) currentShift.done.push(code);
  if (result === 'PASS' && !currentShift.donePass.includes(code)) currentShift.donePass.push(code);
  saveShiftLocal(); renderShift();
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
  renderCheckpoints();
  updateScanGate();
  if (scanned) refreshScanCalc();
}
function onGpsError(err) {
  // B2: ปฏิเสธสิทธิ์ Location / ปิด Location — บล็อกการสแกนจนกว่าจะเปิด
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
// B3: ตำแหน่งต้องสดไม่เกิน 15 วินาที
function isFreshPos() {
  return !!(currentPos && currentPos.timestamp && (Date.now() - currentPos.timestamp) <= GPS_FRESH_MS);
}
function gpsAgeSeconds() {
  return currentPos && currentPos.timestamp ? Math.round((Date.now() - currentPos.timestamp) / 1000) : null;
}
// ขอตำแหน่งสดครั้งเดียว (maximumAge 0) ใช้ก่อนสแกน/บันทึก
function requestFreshPosition() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { gpsUnavailable = true; resolve(false); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => { onGps(pos); resolve(true); },
      (err) => { onGpsError(err); resolve(false); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
// B2: Location gate — ต้องมี GPS สดก่อนสแกนทุกครั้ง ถ้าไม่ผ่านให้บล็อกและบอกวิธีเปิด
async function ensureLocationReady() {
  if (!('geolocation' in navigator)) {
    $('scan-status').textContent = '❌ อุปกรณ์นี้ไม่รองรับ GPS — ใช้มือถือที่มี GPS และเปิด Location ก่อนสแกน';
    return false;
  }
  // เช็กสถานะสิทธิ์ก่อน (เบราว์เซอร์ที่ไม่รองรับ permissions API ให้ข้ามไปขอตำแหน่งตรงๆ)
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
// อัปเดตแบนเนอร์เตือน + สถานะปุ่มสแกนตาม GPS / กะ
function updateScanGate() {
  const gate = $('location-gate'); if (!gate) return;
  if (!currentUser) { gate.classList.add('hidden'); return; }
  if (gpsDenied || gpsUnavailable) {
    gate.classList.remove('hidden');
    gate.innerHTML = '❌ <b>ยังเปิด Location ไม่ได้</b> — สแกน QR ไม่ได้จนกว่าจะเปิด Location และอนุญาตตำแหน่งให้เว็บนี้<br>วิธีเปิด: Chrome บน Android แตะไอคอน 🔒 ข้างแถบที่อยู่ → สิทธิ์ของไซต์ → ตำแหน่ง → อนุญาต • iPhone: การตั้งค่า → ความเป็นส่วนตัวและความปลอดภัย → บริการตำแหน่งที่ตั้ง → Safari → ขณะใช้แอป';
    return;
  }
  if (!currentShift || currentShift.ended_at) {
    gate.classList.remove('hidden');
    gate.innerHTML = '⏸️ <b>ยังไม่ได้เริ่มกะ</b> — กด “เริ่มกะ” ด้านบนก่อน แล้วเดินตรวจให้ครบทุกจุดในกะนี้';
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
  // B1: จุดนี้ PASS แล้วในกะนี้ ห้ามบันทึกซ้ำ
  if (currentShift && !currentShift.ended_at && currentShift.donePass && currentShift.donePass.includes(cp.code)) {
    $('scan-status').textContent = '✅ จุด ' + cp.code + ' ตรวจ PASS แล้วในกะนี้ ไม่ต้องสแกนซ้ำ';
    toast('จุดนี้ตรวจ PASS แล้วในกะนี้');
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
  refreshScanCalc();
  $('scan-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function refreshScanCalc() {
  if (!scanned) return;
  const confirmBtn = $('btn-confirm-scan');
  if (!currentPos) {
    $('scan-distance').textContent = '-';
    $('scan-result-line').innerHTML = '⏳ ยังไม่มีตำแหน่ง GPS กรุณาเปิด Location รอ GPS แล้วกดยืนยันอีกครั้ง';
    confirmBtn.disabled = true; return;
  }
  // B3: GPS เก่าเกิน 15 วินาที ห้ามยืนยัน — ต้องขอตำแหน่งสดก่อน
  if (!isFreshPos()) {
    $('scan-distance').textContent = '-';
    $('scan-result-line').innerHTML = '⚠️ ตำแหน่ง GPS เก่าเกิน 15 วินาที (อายุ ' + (gpsAgeSeconds() ?? '-') + ' วินาที) — ห้ามใช้ตำแหน่งเก่าบันทึก กรุณากด “ขอตำแหน่งอีกครั้ง” เพื่อขอตำแหน่งสด';
    $('scan-accuracy-warn').classList.add('hidden');
    confirmBtn.disabled = true; return;
  }
  const d = haversine(currentPos.lat, currentPos.lng, scanned.lat, scanned.lng);
  const pass = d <= scanned.radius;
  $('scan-distance').textContent = Math.round(d) + ' ม.';
  // B7: accuracy เกิน 30 ม. บล็อกการบันทึก ไม่ใช่แค่เตือน
  if (currentPos.accuracy > ACCURACY_LIMIT_M) {
    $('scan-result-line').innerHTML = '<span class="badge badge-fail">บล็อก</span> ความแม่นยำ GPS ±' + Math.round(currentPos.accuracy) + ' ม. เกิน 30 ม. — บันทึกไม่ได้ กรุณาออกไปในที่โล่งแล้วกด “ขอตำแหน่งอีกครั้ง” จนแม่นยำภายใน 30 ม.';
    $('scan-accuracy-warn').classList.remove('hidden');
    $('scan-accuracy-warn').textContent = '⛔ ความแม่นยำ GPS เกิน 30 ม. บันทึกไม่ได้ — ค่า accuracy จะถูกบันทึกลง log ด้วยเมื่อแม่นยำพอ';
    confirmBtn.disabled = true;
    scanned._distance = d; scanned._pass = pass; return;
  }
  confirmBtn.disabled = false;
  $('scan-result-line').innerHTML = pass
    ? '<span class="badge badge-pass">PASS</span> อยู่ในรัศมี ' + scanned.radius + ' ม.'
    : '<span class="badge badge-fail">FAIL</span> อยู่นอก รัศมี ' + scanned.radius + ' ม. (เกิน ' + Math.round(d - scanned.radius) + ' ม.)';
  $('scan-accuracy-warn').classList.add('hidden');
  scanned._distance = d; scanned._pass = pass;
}
async function startLiveScan() {
  if (typeof Html5Qrcode === 'undefined') { toast('โหลดตัวสแกน Html5Qrcode ไม่สำเร็จ'); return; }
  // B1+B2: ต้องเริ่มกะและมี GPS สดก่อนเปิดกล้อง
  if (!currentShift || currentShift.ended_at) { $('scan-status').textContent = '⏸️ กรุณากด “เริ่มกะ” ก่อนสแกน QR'; toast('กรุณาเริ่มกะก่อนสแกน'); return; }
  if (!(await ensureLocationReady())) return; // B2: Location ปิด/ปฏิเสธสิทธิ์ = บล็อก
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
    // G5: ปฏิเสธสิทธิ์กล้อง — บอกวิธีเปิดสิทธิ์ใหม่ชัดเจน
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
  // B1+B2: ถ่ายรูปสแกนก็ต้องเริ่มกะและมี GPS สดก่อนเช่นกัน
  if (!currentShift || currentShift.ended_at) { $('scan-status').textContent = '⏸️ กรุณากด “เริ่มกะ” ก่อนสแกน QR'; toast('กรุณาเริ่มกะก่อนสแกน'); return; }
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
// B4: ดูข้อมูลจุดตรวจแบบไม่บันทึก (ADMIN ทดสอบเท่านั้น — ไม่ตั้ง scanned ไม่เปิดปุ่มยืนยัน)
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
  if (savingScan) return; // G1: กันกดซ้ำระหว่างบันทึก
  // B1: ต้องอยู่ในกะที่ยังไม่จบ และจุดนี้ต้องยังไม่ PASS ในกะนี้
  if (!currentShift || currentShift.ended_at) { toast('กรุณากด “เริ่มกะ” ก่อนบันทึก'); return; }
  if (currentShift.donePass && currentShift.donePass.includes(scanned.code)) { toast('จุดนี้บันทึก PASS แล้วในกะนี้'); return; }
  // B2+B3+B7: ต้องมี GPS สด (ไม่เกิน 15 วินาที) และแม่นยำภายใน 30 ม. ตอนบันทึก
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
  savingScan = true;
  $('btn-confirm-scan').disabled = true;
  refreshScanCalc();
  if (currentPos.accuracy > ACCURACY_LIMIT_M || !isFreshPos()) { savingScan = false; $('btn-confirm-scan').disabled = true; return; }
  const rec = {
    checkpoint_code: scanned.code,
    guard_id: currentUser.id || null,
    guard_username: currentUser.display_name || currentUser.email,
    lat: currentPos.lat, lng: currentPos.lng,
    accuracy_m: Math.round(currentPos.accuracy),
    distance_m: Math.round(scanned._distance || 0),
    result: scanned._pass ? 'PASS' : 'FAIL',
    remark: $('remark').value,
    scanned_at: new Date().toISOString(),
    synced: true
  };
  $('save-status').textContent = 'กำลังบันทึก…';
  if (demoMode || !sb) {
    const q = getQueue(); q.push(rec); setQueue(q);
    $('save-status').textContent = 'บันทึกในเครื่อง (โหมด Demo) — จะส่งเมื่อเชื่อม Supabase ได้';
    toast('บันทึกแล้ว (Demo/ออฟไลน์) ' + rec.result);
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
    $('save-status').textContent = '✅ บันทึกสำเร็จ ' + rec.result + ' (' + rec.distance_m + ' ม.)';
    toast('บันทึกสำเร็จ ' + rec.result);
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
  // G1: ล้างผลสแกนและซ่อนการ์ดทันทีหลังบันทึก กดยืนยันซ้ำไม่ได้โดยไม่สแกนใหม่
  if (scanned) markShiftDone(scanned.code, scanned._pass ? 'PASS' : 'FAIL');
  scanned = null; savingScan = false;
  $('scan-card').classList.add('hidden');
  $('btn-confirm-scan').disabled = true;
  $('save-status').textContent = '';
  $('scan-status').textContent = 'บันทึกแล้ว — สแกนจุดถัดไปในกะได้เลย';
  updateScanGate();
  loadLogs();
}
async function syncQueue() {
  if (!sb || demoMode || !navigator.onLine) return;
  const q = getQueue();
  if (!q.length) return;
  const rest = [];
  for (const rec of q) {
    // คิวที่สร้างตอน Demo/ออฟไลน์อาจไม่มี guard_id — ประทับตราผู้ล็อกอินปัจจุบัน
    // เพราะ RLS บังคับ insert patrol_logs ต้องมี guard_id = auth.uid()
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
  if (rest.length < q.length) { toast('ซิงก์คิวออฟไลน์แล้ว ' + (q.length - rest.length) + ' รายการ'); loadLogs(); }
}

// ---------- Report ----------
async function loadLogs() {
  if (!sb || demoMode) {
    // โหมด Demo: แสดงเฉพาะรายการในคิวเครื่อง
    logs = getQueue().map((r) => ({ ...r, created_at: r.scanned_at }));
    renderLogs(); return;
  }
  try {
    const { data, error } = await sb.from('patrol_logs').select('*').order('scanned_at', { ascending: false }).limit(200);
    if (error) throw error;
    logs = (data || []).map((r) => ({ ...r, created_at: r.scanned_at || r.created_at }));
    const queued = getQueue().map((r) => ({ ...r, created_at: r.scanned_at, _queued: true }));
    logs = queued.concat(logs);
    renderLogs();
  } catch (err) {
    if (isTableMissingError(err)) { demoMode = true; $('demo-banner').classList.remove('hidden'); logs = getQueue(); }
    renderLogs();
  }
}
function filteredLogs() {
  const d = $('filter-date').value, cp = $('filter-cp').value, res = $('filter-result').value;
  return logs.filter((r) => {
    if (d && String(r.created_at || '').slice(0, 10) !== d) return false;
    if (cp && r.checkpoint_code !== cp) return false;
    if (res && r.result !== res) return false;
    return true;
  });
}
function renderLogs() {
  const rows = filteredLogs();
  const tb = $('log-rows');
  $('log-count').textContent = 'แสดง ' + rows.length + ' รายการ' + (getQueue().length ? ' • คิวออฟไลน์ค้าง ' + getQueue().length + ' รายการ' : '');
  if (currentShift) { shiftDoneFromLogs(); renderShift(); } // B1: รวม log ที่โหลดมาเข้าความคืบหน้ากะ
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="6" class="muted">ยังไม่มีข้อมูล</td></tr>'; return; }
  tb.innerHTML = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const cp = checkpoints.find((c) => c.code === r.checkpoint_code);
    tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td>';
    tr.children[0].textContent = r.created_at ? fmtTime(r.created_at) : '-';
    tr.children[1].textContent = r.checkpoint_code + (cp ? ' ' + cp.name : '') + (r._queued ? ' (คิว)' : '');
    tr.children[2].textContent = r.guard_username || r.guard_name || '-';
    tr.children[3].textContent = (r.distance_m ?? '-') + (r.accuracy_m ? ' (±' + r.accuracy_m + ')' : '');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (r.result === 'PASS' ? 'badge-pass' : 'badge-fail');
    badge.textContent = r.result || '-';
    tr.children[4].appendChild(badge);
    tr.children[5].textContent = r.remark || '-';
    tb.appendChild(tr);
  });
}
function exportCSV() {
  const rows = filteredLogs();
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

// ---------- Admin ----------
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
    renderCheckpoints(); renderAdminList(); $('cp-form').reset(); $('cp-id').value = ''; return;
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
    renderCheckpoints(); renderAdminList(); return;
  }
  try {
    const { error } = await sb.from('checkpoints').delete().eq('code', c.code);
    if (error) throw error;
    await loadCheckpoints(); renderAdminList();
  } catch (err) { toast('ลบไม่สำเร็จ: ' + (err.message || err)); }
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
async function loadProfiles() {
  const list = $('user-list');
  if (demoMode || !sb) {
    list.innerHTML = DEMO_USERS.map((u) => '<div class="cp-item"><div><b>' + u.display_name + '</b> <span class="badge badge-admin">' + u.role + '</span><br><span class="small">' + u.email + '</span></div></div>').join('');
    return;
  }
  try {
    const { data, error } = await sb.from('profiles').select('*').order('username'); // B5: profiles ไม่มีคอลัมน์ email
    if (error) throw error;
    list.innerHTML = (data || []).length ? '' : '<p class="muted">ไม่มีผู้ใช้ใน profiles</p>';
    (data || []).forEach((u) => {
      const div = document.createElement('div'); div.className = 'cp-item';
      div.innerHTML = '<div><b></b> <span class="badge badge-admin"></span><br><span class="small"></span></div>';
      div.querySelector('b').textContent = u.full_name || u.username || u.email || '-';
      div.querySelector('.badge').textContent = (u.role || 'GUARD').toUpperCase();
      div.querySelector('.small').textContent = (u.username || u.email || '') + (u.is_active === false ? ' • ปิดใช้งาน' : '');
      list.appendChild(div);
    });
  } catch (err) {
    list.innerHTML = '<p class="muted">โหลดรายชื่อผู้ใช้ไม่ได้: ' + (err.message || err) + ' (ตาราง profiles อาจยังไม่ถูกสร้าง)</p>';
  }
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
    if (!currentUser) { toast('กรุณาเข้าสู่ระบบก่อน'); return; } // B6
    if (b.dataset.view === 'admin' && currentUser.role !== 'ADMIN') {
      toast('หน้านี้เฉพาะผู้ดูแลระบบ (ADMIN)'); return;
    }
    showView(b.dataset.view);
  }));
  $('btn-gps').addEventListener('click', async () => { await requestFreshPosition(); updateScanGate(); if (scanned) refreshScanCalc(); });
  $('btn-start-shift').addEventListener('click', startShift);
  $('btn-end-shift').addEventListener('click', endShift);
  $('btn-scan-live').addEventListener('click', startLiveScan);
  $('btn-scan-stop').addEventListener('click', stopLiveScan);
  $('btn-scan-photo').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', (e) => { handleQrFileScan(e.target.files[0]); e.target.value = ''; });
  // B4: ไม่มีช่องกรอกรหัสจุดเองในหน้าของยามอีกต่อไป — ทดสอบรหัสได้เฉพาะในหน้า Admin
  $('btn-admin-test').addEventListener('click', () => {
    const code = $('admin-test-code').value.trim();
    if (code) previewCheckpoint(code); else toast('กรอกรหัสจุดตรวจก่อน');
  });
  $('btn-confirm-scan').addEventListener('click', submitScan);
  $('btn-cancel-scan').addEventListener('click', () => { scanned = null; $('scan-card').classList.add('hidden'); $('save-status').textContent = ''; });
  $('btn-filter').addEventListener('click', renderLogs);
  $('btn-reload-logs').addEventListener('click', loadLogs);
  $('btn-export-csv').addEventListener('click', exportCSV);
  $('cp-form').addEventListener('submit', saveCheckpoint);
  $('btn-cp-reset').addEventListener('click', () => { $('cp-form').reset(); $('cp-id').value = ''; });
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
