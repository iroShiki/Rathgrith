'use strict';

// 依赖 i18n.js 提供的 t()、LANG、LANGS、setLang()、locale()、applyStaticText()

const $ = (s, el = document) => el.querySelector(s);

const S = {
  ov: null,               // /api/overview 返回的数据
  selected: new Set(),    // 选中的日期 "YYYY-MM-DD"
  washers: [],            // 选中的洗衣机 ID，顺序即轮换顺序
  dryers: [],
  plan: null,
  planReq: null,
  overrides: {},          // 冲突的手动选择，结构见 planner.PlanRequest
  toggles: {},            // item key -> 用户手动勾选/取消
  results: {},            // item key -> {running} | {ok, status} | {ok: false, err}
  running: false,
  progress: { done: 0, n: 0 },   // 执行预约时的进度
  stop: false,
};

// ---------- 工具函数 ----------

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const wdIndex = d => (d.getDay() + 6) % 7;   // 周一 = 0
const hh = h => `${String(h).padStart(2, '0')}:00`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cap = s => s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1);

const fmt = (s, opts) => new Intl.DateTimeFormat(locale(), opts).format(typeof s === 'string' ? parseISO(s) : s);
const fmtDay = s => fmt(s, { month: 'long', day: 'numeric', weekday: 'short' });   // 11月2日周一 / Mon 2 November
const fmtShort = s => fmt(s, { month: 'numeric', day: 'numeric' });
const fmtWeekday = (s, style = 'short') => fmt(s, { weekday: style });

// 2026-01-05 是周一，用来按“周一 = 0”取各语言的星期名
const weekdayName = (i, style) => fmtWeekday(new Date(2026, 0, 5 + i), style);

function relDay(s) {
  const diff = Math.round((parseISO(s) - parseISO(iso(new Date()))) / 86400000);
  if (diff >= 0 && diff <= 2) return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(diff, 'day');
  return fmtShort(s);
}

// 站点上的机器名是英文（"Washing machine 2" / "Dryer 3"），换成当前语言的短名
function shortName(n) {
  const m = /^(Washing machine|Dryer)\s+(\d+)$/.exec(n);
  return m ? t(m[1] === 'Dryer' ? 'machine.dry' : 'machine.wash', { n: m[2] }) : n;
}

// 翻译后端返回的 {code, params}：小时、机器名、日期参数先格式化
function msg(prefix, m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  const p = { ...(m.params || {}) };
  if ('hour' in p) p.hour = hh(p.hour);
  for (const k of ['machine', 'used']) if (k in p) p[k] = shortName(p[k]);
  if ('date' in p) p.date = fmtDay(p.date);
  return t(`${prefix}.${m.code}`, p);
}

function toast(text, ms = 3500) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

class ApiError extends Error {
  constructor(data, status) {
    const known = data.code && `err.${data.code}` in I18N.en;
    super(known ? msg('err', data) : (data.error || t('err.bad_response', { status })));
    this.code = data.code;
    this.data = data;
  }
}

// 正在进行的请求数；大于 0 时导航栏底部显示进度条
let inflight = 0;
function trackRequest(delta) {
  inflight += delta;
  $('#nav-progress').classList.toggle('on', inflight > 0);
}

async function api(path, body) {
  const opt = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  trackRequest(1);
  let r;
  try {
    r = await fetch(path, opt);
  } catch {
    throw new ApiError({ code: 'network' }, 0);   // 断网或服务器没有响应
  } finally {
    trackRequest(-1);
  }
  const data = await r.json().catch(() => ({ code: 'bad_response', params: { status: r.status } }));
  if (r.status === 401 && path !== '/api/login') {
    const e = new ApiError(data, r.status);
    showLogin(e);
    throw e;
  }
  if (!r.ok) throw new ApiError(data, r.status);
  return data;
}

// 按当前语言给出错误文字（已知的错误代码重新翻译，其余用原始消息）
function errText(err) {
  const known = err?.code && `err.${err.code}` in I18N.en;
  return known ? msg('err', err.data) : (err?.message || '');
}

// 错误提示保存原始错误对象，切换语言时可以重新翻译
function showError(el, err) {
  el._err = err || null;
  el.textContent = err ? errText(err) : '';
  el.hidden = !err;
}

// 按钮的等待状态：显示转圈并把文字换成 busyKey；文字放在带 data-i18n 的 span 里，切换语言时也会跟着更新
function setBusy(btn, busyKey) {
  const label = btn.querySelector('[data-i18n]');
  btn.dataset.idleKey ??= label.dataset.i18n;
  label.dataset.i18n = busyKey || btn.dataset.idleKey;
  label.textContent = t(label.dataset.i18n);
  btn.classList.toggle('busy', !!busyKey);
  btn.disabled = !!busyKey;
  btn.setAttribute('aria-busy', String(!!busyKey));
}

// ---------- 语言 ----------

function initLangSelect() {
  const sel = $('#lang-select');
  sel.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  sel.value = LANG;
  sel.addEventListener('change', () => { setLang(sel.value); applyLanguage(); });
}

function applyLanguage() {
  applyStaticText();
  $('#lang-select').value = LANG;
  for (const id of ['#login-error', '#plan-error']) if ($(id)._err) showError($(id), $(id)._err);
  renderOverviewError();
  if (S.ov) {
    renderOverviewText();
    renderStats();
    renderReservations();
    renderSettingsText();
    renderCalendar();
  }
  if (S.plan) renderPlan();
}

// ---------- 登录 ----------

function showLogin(err) {
  $('#boot-view').hidden = true;
  $('#app-view').hidden = true;
  $('#who').hidden = true;
  $('#login-view').hidden = false;
  showError($('#login-error'), err && err.code !== 'not_logged_in' ? err : null);
  $('#login-form [name=username]').focus();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const btn = $('#login-btn');
  setBusy(btn, 'login.submitting');
  showError($('#login-error'), null);
  let res;
  try {
    res = await api('/api/login', {
      username: f.username.value, password: f.password.value, remember: f.remember.checked,
    });
    f.password.value = '';
  } catch (err) {
    showError($('#login-error'), err);
    return;
  } finally {
    setBusy(btn, null);
  }
  enterApp(res.user);   // 概览加载有自己的加载和错误状态
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', {}).catch(() => {});
  S.plan = null;
  $('#plan-section').hidden = true;
  showLogin();
});

async function enterApp(user) {
  $('#boot-view').hidden = true;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#who').hidden = false;
  if (user) $('#user-name').textContent = user;
  await loadOverview();
}

// ---------- 概览 ----------

let overviewError = null;

function renderOverviewError() {
  $('#overview-error').hidden = !overviewError;
  $('#overview-error-text').textContent = overviewError ? t('loading.failed', { msg: errText(overviewError) }) : '';
}

// 首次加载时在各区域放上形状接近最终内容的占位块
function renderSkeleton() {
  const line = (w, h = 14) => `<span class="skel-line" style="width:${w};height:${h}px"></span>`;
  $('#today-label').innerHTML = line('180px', 12);
  for (const id of ['#next-time', '#week-used', '#res-count']) $(id).innerHTML = line('70%', 34);
  for (const id of ['#next-machine', '#res-range']) $(id).innerHTML = line('45%', 12);
  $('#week-meter').style.width = '0';
  $('#overview-meta').textContent = '';
  $('#reservations').innerHTML = Array.from({ length: 4 }, () => `
    <div class="res-day skel-card" aria-hidden="true">${line('55%', 26)}${line('85%')}${line('70%')}</div>`).join('');
  const pills = n => Array.from({ length: n }, () => '<span class="pill skel" aria-hidden="true"></span>').join('');
  $('#weekday-chips').innerHTML = pills(7);
  $('#washer-chips').innerHTML = pills(3);
  $('#dryer-chips').innerHTML = pills(4);
  $('#calendar').innerHTML = '<div class="skel-block" style="height:320px"></div><div class="skel-block" style="height:320px"></div>';
  $('#selected-count').textContent = '';
}

async function loadOverview() {
  const first = !S.ov;
  const view = $('#app-view');
  overviewError = null;
  renderOverviewError();
  if (first) {
    renderSkeleton();
    view.classList.add('is-loading');
    $('#overview-status').hidden = false;
    $('#plan-btn').disabled = true;
    $('#refresh-overview').disabled = true;
  } else {
    view.classList.add('is-refreshing');
    setBusy($('#refresh-overview'), 'loading.refreshing');
  }
  view.setAttribute('aria-busy', 'true');
  try {
    const ov = await api('/api/overview');
    S.ov = ov;
    $('#user-name').textContent = ov.user || '';
    renderOverviewText();
    renderStats();
    renderReservations();
    if (first) initSettings();
    renderCalendar();
  } catch (err) {
    if (err.code === 'not_logged_in' || err.code === 'session_expired') return;   // api() 已切回登录页
    overviewError = err;
    renderOverviewError();
  } finally {
    view.classList.remove('is-loading', 'is-refreshing');
    view.setAttribute('aria-busy', 'false');
    $('#overview-status').hidden = true;
    $('#plan-btn').disabled = !S.ov;
    if (first) $('#refresh-overview').disabled = false; else setBusy($('#refresh-overview'), null);
  }
}

$('#overview-retry').addEventListener('click', () => loadOverview());

function renderOverviewText() {
  $('#today-label').textContent = t('hero.today', { date: fmtDay(new Date()) });
  $('#overview-meta').textContent = t('rail.until', { date: fmtDay(S.ov.max_date) });
}

function renderStats() {
  const now = new Date();
  const upcoming = S.ov.reservations
    .filter(r => { const d = parseISO(r.day); d.setHours(r.end_hour); return d > now; })
    .sort((a, b) => a.day.localeCompare(b.day) || a.start_hour - b.start_hour);
  const next = upcoming[0];
  $('#next-time').textContent = next ? `${cap(relDay(next.day))} ${hh(next.start_hour)}` : t('stat.none');
  $('#next-machine').textContent = next
    ? `${t(next.kind === 'dry' ? 'kind.dry' : 'kind.wash')} · ${shortName(next.resource_name)}`
    : t('stat.noneSub');

  const { used, limit } = S.ov.week || {};
  $('#week-used').textContent = used == null ? '—' : `${used} / ${limit}`;
  $('#week-meter').style.width = used == null ? '0' : `${Math.min(100, (used / limit) * 100)}%`;

  const list = S.ov.reservations;
  $('#res-count').textContent = t('stat.count', { n: list.length });
  const days = [...new Set(list.map(r => r.day))].sort();
  $('#res-range').textContent = days.length ? t('stat.range', { n: days.length, last: relDay(days[days.length - 1]) }) : '';
}

function existingByDate() {
  const m = {};
  for (const r of S.ov.reservations) (m[r.day] ??= { wash: false, dry: false })[r.kind === 'dry' ? 'dry' : 'wash'] = true;
  return m;
}

function renderReservations() {
  const list = S.ov.reservations;
  if (!list.length) {
    $('#reservations').innerHTML = `<div class="rail-empty">${esc(t('rail.empty'))}</div>`;
    return;
  }
  const byDay = {};
  for (const r of list) (byDay[r.day] ??= []).push(r);
  $('#reservations').innerHTML = Object.keys(byDay).sort().map(day => `
    <div class="res-day">
      <div class="res-date"><b>${esc(fmtShort(day))}</b><span>${esc(fmtWeekday(day))} · ${esc(relDay(day))}</span></div>
      ${byDay[day].sort((a, b) => a.start_hour - b.start_hour).map(r => `
        <div class="res-item">
          <i class="dot ${r.kind === 'dry' ? 'dry' : 'wash'}" title="${esc(t(r.kind === 'dry' ? 'kind.dry' : 'kind.wash'))}"></i>
          <span>${hh(r.start_hour)} ${esc(shortName(r.resource_name))}</span>
          ${r.resource_id != null ? `<button class="x" title="${esc(t('cancel.title'))}" aria-label="${esc(t('cancel.title'))}" data-cancel='${esc(JSON.stringify({
            service_id: r.service_id, resource_id: r.resource_id, date: r.day, hour: r.start_hour,
          }))}'>✕</button>` : ''}
        </div>`).join('')}
    </div>`).join('');
}

$('#reservations').addEventListener('click', async e => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  const p = JSON.parse(b.dataset.cancel);
  if (!confirm(t('cancel.confirm', { date: fmtDay(p.date), hour: hh(p.hour) }))) return;
  b.disabled = true;
  b.classList.add('busy');
  try {
    await api('/api/cancel', p);
    toast(t('cancel.done'));
    await loadOverview();
  } catch (err) {
    toast(t('cancel.failed', { msg: errText(err) }));
    b.disabled = false;
    b.classList.remove('busy');
  }
});

$('#refresh-overview').addEventListener('click', () => loadOverview());

// ---------- 设置 ----------

function initSettings() {
  const { wash, dry } = S.ov.services;
  $('#wash-hour').innerHTML = wash.hours.map(h => `<option value="${h}">${hh(h)}–${hh(h + 1)}</option>`).join('');
  $('#wash-hour').value = wash.hours.includes(21) ? 21 : wash.hours[wash.hours.length - 1];
  S.washers = wash.resources.map(r => r.id);
  S.dryers = dry.resources.map(r => r.id);
  renderSettingsText();
  $('#dryer-offset').value = 1;
  syncDryerBlock();
}

// 设置区里随语言变化的部分：星期快捷按钮、烘干偏移选项、机器名
function renderSettingsText() {
  const { wdChip } = LANGS[LANG];
  $('#weekday-chips').innerHTML = [0, 1, 2, 3, 4, 5, 6]
    .map(i => `<button class="pill" data-wd="${i}">${esc(cap(t('cal.every', { wd: weekdayName(i, wdChip) })))}</button>`).join('');
  const off = $('#dryer-offset');
  const cur = off.value || '1';
  off.innerHTML = [0, 1, 2, 3].map(n => `<option value="${n}">${esc(n === 0 ? t('dry.offsetSame') : t('dry.offsetN', { n }))}</option>`).join('');
  off.value = cur;
  renderMachineChips();
}

function renderMachineChips() {
  const chips = (resources, chosen) => resources.map(r => {
    const k = chosen.indexOf(r.id);
    return `<button class="pill ${k >= 0 ? 'on' : ''}" data-id="${r.id}" aria-pressed="${k >= 0}">${esc(shortName(r.name))}${k >= 0 ? `<span class="ord">${k + 1}</span>` : ''}</button>`;
  }).join('');
  $('#washer-chips').innerHTML = chips(S.ov.services.wash.resources, S.washers);
  $('#dryer-chips').innerHTML = chips(S.ov.services.dry.resources, S.dryers);
}

function toggleMachine(list, id) {
  const k = list.indexOf(id);
  if (k >= 0) list.splice(k, 1); else list.push(id);
  renderMachineChips();
}
$('#washer-chips').addEventListener('click', e => {
  const c = e.target.closest('[data-id]'); if (c) toggleMachine(S.washers, Number(c.dataset.id));
});
$('#dryer-chips').addEventListener('click', e => {
  const c = e.target.closest('[data-id]'); if (c) toggleMachine(S.dryers, Number(c.dataset.id));
});

function syncDryerBlock() {
  const on = $('#dryer-enabled').checked;
  $('#dryer-settings').classList.toggle('off', !on);
  $('#dryer-off-hint').hidden = on;
}
$('#dryer-enabled').addEventListener('change', syncDryerBlock);

// ---------- 日历 ----------

function selectableDates() {
  const out = [];
  const end = parseISO(S.ov.max_date);
  for (let d = parseISO(S.ov.min_date); d <= end; d.setDate(d.getDate() + 1)) out.push(iso(d));
  return out;
}

function renderCalendar() {
  const min = parseISO(S.ov.min_date), max = parseISO(S.ov.max_date);
  const ex = existingByDate();
  const today = iso(new Date());
  const head = [0, 1, 2, 3, 4, 5, 6].map(i => `<div class="wd">${esc(weekdayName(i, LANGS[LANG].wdHead))}</div>`).join('');
  let html = '';
  for (let m = new Date(min.getFullYear(), min.getMonth(), 1); m <= max; m.setMonth(m.getMonth() + 1)) {
    const y = m.getFullYear(), mo = m.getMonth();
    const days = new Date(y, mo + 1, 0).getDate();
    let cells = head + '<button class="day blank" disabled></button>'.repeat(wdIndex(new Date(y, mo, 1)));
    for (let d = 1; d <= days; d++) {
      const date = new Date(y, mo, d), s = iso(date);
      const off = date < min || date > max;
      const e = ex[s];
      const dots = e ? `<span class="dots">${e.wash ? '<span class="dot wash"></span>' : ''}${e.dry ? '<span class="dot dry"></span>' : ''}</span>` : '';
      cells += `<button class="day ${S.selected.has(s) ? 'sel' : ''} ${s === today ? 'today' : ''}" data-date="${s}" ${off ? 'disabled' : ''}>${d}${dots}</button>`;
    }
    const title = cap(fmt(new Date(y, mo, 1), { year: 'numeric', month: 'long' }));
    html += `<div class="month"><div class="month-title" data-month="${y}-${mo}" title="${esc(t('cal.monthTitle'))}">${esc(title)}</div><div class="grid7">${cells}</div></div>`;
  }
  $('#calendar').innerHTML = html;
  updateSelectedCount();
}

function setDate(s, on) {
  if (on) S.selected.add(s); else S.selected.delete(s);
  const el = $(`.day[data-date="${s}"]`);
  if (el) el.classList.toggle('sel', on);
}

function updateSelectedCount() {
  const el = $('#selected-count');
  el.textContent = S.selected.size ? t('cal.selected', { n: S.selected.size }) : t('cal.none');
  el.classList.toggle('on', S.selected.size > 0);
}

// 拖动时选中“起点到当前格”之间的整段日期；拖回来时恢复拖动前的状态
const drag = { active: false, mode: true, last: null, anchor: null, snapshot: null };

function applyDragRange(to) {
  const [a, b] = [drag.anchor, to].sort();
  for (const d of selectableDates()) setDate(d, d >= a && d <= b ? drag.mode : drag.snapshot.has(d));
  updateSelectedCount();
}

$('#calendar').addEventListener('pointerdown', e => {
  const el = e.target.closest('.day[data-date]');
  if (!el || el.disabled) return;
  e.preventDefault();
  el.releasePointerCapture?.(e.pointerId);    // 让触屏拖动时也能触发其他格子的 pointerover
  const s = el.dataset.date;
  if (e.shiftKey && drag.last) {
    const [a, b] = [drag.last, s].sort();
    const on = S.selected.has(drag.last);
    for (const d of selectableDates()) if (d >= a && d <= b) setDate(d, on);
  } else {
    drag.mode = !S.selected.has(s);
    drag.active = true;
    drag.anchor = s;
    drag.snapshot = new Set(S.selected);
    setDate(s, drag.mode);
  }
  drag.last = s;
  updateSelectedCount();
});
$('#calendar').addEventListener('pointerover', e => {
  if (!drag.active) return;
  const el = e.target.closest('.day[data-date]');
  if (el && !el.disabled) applyDragRange(el.dataset.date);
});
window.addEventListener('pointerup', e => {
  if (!drag.active) return;
  drag.active = false;
  // 指针抬起的位置也算进范围（快速拖动时可能没有触发中间的 pointerover）
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.day[data-date]');
  if (el && !el.disabled) { applyDragRange(el.dataset.date); drag.last = el.dataset.date; }
});

$('#calendar').addEventListener('click', e => {
  const tEl = e.target.closest('.month-title');
  if (!tEl) return;
  const [y, mo] = tEl.dataset.month.split('-').map(Number);
  const inMonth = selectableDates().filter(s => { const d = parseISO(s); return d.getFullYear() === y && d.getMonth() === mo; });
  const on = !inMonth.every(s => S.selected.has(s));
  inMonth.forEach(s => setDate(s, on));
  updateSelectedCount();
});

$('#weekday-chips').addEventListener('click', e => {
  const c = e.target.closest('[data-wd]');
  if (!c) return;
  const wd = Number(c.dataset.wd);
  const ds = selectableDates().filter(s => wdIndex(parseISO(s)) === wd);
  const on = !ds.every(s => S.selected.has(s));
  ds.forEach(s => setDate(s, on));
  updateSelectedCount();
});

document.querySelector('.cal-toolbar').addEventListener('click', e => {
  const q = e.target.closest('[data-quick]')?.dataset.quick;
  if (!q || !S.ov) return;   // 概览还没加载完时没有可选日期
  const all = selectableDates();
  const pick = {
    all: () => true,
    weekdays: s => wdIndex(parseISO(s)) < 5,
    weekends: s => wdIndex(parseISO(s)) >= 5,
    invert: s => !S.selected.has(s),
    clear: () => false,
  }[q];
  all.forEach(s => setDate(s, pick(s)));
  updateSelectedCount();
});

// ---------- 计划 ----------

function buildPlanRequest() {
  return {
    dates: [...S.selected].sort(),
    wash_hour: Number($('#wash-hour').value),
    washers: S.washers,
    rotate_washers: $('#rotate-washers').checked,
    allow_other_washers: $('#allow-other-washers').checked,
    dryer: $('#dryer-enabled').checked,
    dryers: S.dryers,
    rotate_dryers: $('#rotate-dryers').checked,
    dryer_offset: Number($('#dryer-offset').value),
    dryer_include_wash_hour: $('#dryer-include-wash').checked,
    skip_existing: $('#skip-existing').checked,
  };
}

async function runPlan({ fresh = false, keepChoices = false } = {}) {
  const errEl = $('#plan-error');
  showError(errEl, null);
  if (!keepChoices) {
    S.planReq = buildPlanRequest();
    S.overrides = {};
    S.toggles = {};
    S.results = {};
  }
  // 首次生成：设置区的按钮转圈；在已有计划上调整（选冲突时段、一键解决、重新获取）：计划区显示“正在更新”并淡化
  const section = $('#plan-section');
  const updating = keepChoices && !section.hidden;
  const tools = ['#autoresolve-btn', '#replan-btn'].map(s => $(s));
  setBusy($('#plan-btn'), 'plan.loading');
  if (updating) {
    section.classList.add('plan-busy');
    section.setAttribute('aria-busy', 'true');
    $('#plan-status').hidden = false;
    tools.forEach(b => { b.disabled = true; });
    $('#exec-btn').disabled = true;
  }
  try {
    S.plan = await api('/api/plan', { ...S.planReq, overrides: S.overrides, refresh: fresh });
    renderPlan();
    section.hidden = false;
    if (!keepChoices) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    if (updating) toast(errText(e)); else showError(errEl, e);
  } finally {
    setBusy($('#plan-btn'), null);
    section.classList.remove('plan-busy');
    section.setAttribute('aria-busy', 'false');
    $('#plan-status').hidden = true;
    tools.forEach(b => { if (!b.classList.contains('busy')) b.disabled = false; });
    if (S.plan) renderPlan();   // 恢复执行按钮的可用状态
  }
}

$('#plan-btn').addEventListener('click', () => runPlan());

// 离目标时间最近者优先；距离相同时优先用户选中的机器（按轮换顺序），再优先较晚的时段
function bestOption(c) {
  const rank = o => {
    const p = c.preferred.indexOf(o.resource_id);
    return [Math.abs(o.hour - (c.target_hour ?? o.hour)), p < 0 ? 99 : p, -o.hour];
  };
  const cmp = (a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  return [...c.options].sort(cmp)[0];
}

$('#autoresolve-btn').addEventListener('click', async () => {
  const btn = $('#autoresolve-btn');
  setBusy(btn, 'plan.autoresolve');   // 文字不变，只加转圈；整个多轮过程中保持
  try {
    await autoResolve();
  } finally {
    setBusy(btn, null);
  }
});

async function autoResolve() {
  // 解决洗衣冲突后烘干会按新时段重新安排，可能产生新的烘干冲突，所以最多重复几轮
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const day of S.plan.days) {
      for (const c of day.conflicts) {
        const o = bestOption(c);
        if (!o) continue;
        const ov = (S.overrides[day.date] ??= {});
        const v = { hour: o.hour, resource_id: o.resource_id };
        if (c.kind === 'wash') { ov.wash = v; delete ov.dry; } else (ov.dry ??= {})[c.index] = v;
        changed = true;
      }
    }
    if (!changed) break;
    await runPlan({ keepChoices: true });
  }
  const left = S.plan.days.reduce((n, d) => n + d.conflicts.length, 0);
  toast(left ? t('resolve.left', { n: left }) : t('resolve.done'));
}

$('#replan-btn').addEventListener('click', async () => {
  const btn = $('#replan-btn');
  S.results = {};
  setBusy(btn, 'plan.replan');
  try {
    await runPlan({ fresh: true, keepChoices: true });
  } finally {
    setBusy(btn, null);
  }
});

// 按日期顺序（同一天先洗衣后烘干）分配每周剩余次数；超出部分默认不勾选
function computeSelection() {
  const sel = {}, added = {};
  for (const day of S.plan.days) {
    for (const it of day.items) {
      if (it.status !== 'new') continue;
      const w = S.plan.weeks[day.week] || {};
      const n = added[day.week] || 0;
      const fits = w.limit == null || w.used + n < w.limit;
      const user = S.toggles[it.key];
      const on = user === undefined ? fits : user;
      sel[it.key] = { on, overQuota: !fits };
      if (on) added[day.week] = n + 1;
    }
  }
  return { sel, added };
}

function resultText(r) {
  if (r.running) return t('tag.running');
  if (r.ok) return t('tag.ok');
  return r.status ? t(`res.${r.status}`) : r.err.message;
}

function itemHtml(it, sel) {
  const name = `<i class="dot ${it.kind === 'dry' ? 'dry' : 'wash'}"></i>${hh(it.hour)} ${esc(shortName(it.resource_name))}`;
  if (it.status === 'existing') {
    return `<div class="pi"><span class="lbl">${name}</span><span class="tag existing">${esc(t('tag.existing'))}</span></div>`;
  }
  const s = sel[it.key];
  const r = S.results[it.key];
  const res = r ? `<span class="tag ${r.running ? 'res-run' : r.ok ? 'res-ok' : 'res-bad'}">${esc(resultText(r))}</span>` : '';
  return `<label class="pi ${s.on ? '' : 'off'}">
    <input type="checkbox" data-toggle="${esc(it.key)}" ${s.on ? 'checked' : ''} ${S.running || r?.ok ? 'disabled' : ''}>
    <span class="lbl">${name}</span>
    ${s.overQuota ? `<span class="tag quota">${esc(t('tag.quota'))}</span>` : ''}${res}
  </label>`;
}

function conflictHtml(day, c) {
  const byHour = {};
  for (const o of c.options) (byHour[o.hour] ??= []).push(o);
  const opts = Object.keys(byHour).sort((a, b) => a - b).map(h => `<optgroup label="${hh(Number(h))}">${byHour[h].map(o =>
    `<option value="${o.hour}|${o.resource_id}">${hh(o.hour)} ${esc(shortName(o.resource_name))}</option>`).join('')}</optgroup>`).join('');
  return `<div class="conflict">${esc(msg('reason', c.reason))}
    <select data-conflict="${esc(JSON.stringify({ date: day.date, kind: c.kind, index: c.index }))}" ${S.running ? 'disabled' : ''}>
      <option value="">${esc(c.options.length ? t('conflict.choose') : t('conflict.none'))}</option>
      ${opts}
      <option value="skip">${esc(t('conflict.skip'))}</option>
    </select></div>`;
}

function renderPlan() {
  const { sel, added } = computeSelection();

  $('#weeks').innerHTML = Object.entries(S.plan.weeks).sort().map(([k, w]) => {
    const n = added[k] || 0;
    const limit = w.limit ?? 10;
    const over = w.used + n > limit;
    const pct = v => Math.min(100, (v / limit) * 100);
    return `<div class="week ${over ? 'over' : ''}">
      <div class="week-top"><b>${esc(t('week.title', { n: Number(k.split('-W')[1]) }))}</b><span>${esc(fmtShort(w.start))} – ${esc(fmtShort(w.end))}</span></div>
      <div class="week-num">${esc(t('week.usage', { used: w.used, n }))}<strong>${w.used + n} / ${limit}</strong></div>
      <div class="bar"><div class="u" style="width:${pct(w.used)}%"></div><div class="n" style="width:${Math.max(0, pct(w.used + n) - pct(w.used))}%"></div></div>
    </div>`;
  }).join('');

  const dateCell = s => `<div class="pc-date"><b>${esc(fmt(s, { month: 'long', day: 'numeric' }))}</b><span>${esc(fmtWeekday(s))}</span></div>`;
  const empty = '<span class="pc-empty">—</span>';
  $('#plan-body').innerHTML = S.plan.days.map(day => {
    if (day.error) return `<div class="prow err">${dateCell(day.date)}<div class="pc-notes">${esc(msg('err', day.error))}</div></div>`;
    const col = kind => [
      ...day.items.filter(i => i.kind === kind).map(i => itemHtml(i, sel)),
      ...day.conflicts.filter(c => c.kind === kind).map(c => conflictHtml(day, c)),
    ].join('') || empty;
    return `<div class="prow">
      ${dateCell(day.date)}
      <div><span class="pc-label">${esc(t('col.wash'))}</span>${col('wash')}</div>
      <div><span class="pc-label">${esc(t('col.dry'))}</span>${S.planReq.dryer ? col('dry') : empty}</div>
      <div class="pc-notes">${day.notes.map(n => esc(msg('note', n))).join('<br>')}</div>
    </div>`;
  }).join('');

  const todo = pendingItems(sel);
  const conflicts = S.plan.days.reduce((n, d) => n + d.conflicts.length, 0);
  $('#plan-meta').textContent = t('plan.meta', { n: S.plan.days.length }) + (conflicts ? t('plan.metaConflicts', { n: conflicts }) : '');
  $('#exec-summary').innerHTML = S.running
    ? esc(t('exec.progress', S.progress))
    : t('exec.summary', { n: todo.length }) + (conflicts ? `<br><span class="small">${esc(t('exec.skipNote'))}</span>` : '');
  $('#exec-btn').disabled = S.running || !todo.length;
}

function pendingItems(sel = computeSelection().sel) {
  return S.plan.days.flatMap(d => d.items).filter(it => it.status === 'new' && sel[it.key]?.on && !S.results[it.key]?.ok);
}

$('#plan-body').addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.toggle) {
    S.toggles[el.dataset.toggle] = el.checked;
    renderPlan();
    return;
  }
  if (el.dataset.conflict && el.value !== '') {
    const c = JSON.parse(el.dataset.conflict);
    const v = el.value === 'skip' ? 'skip' : { hour: Number(el.value.split('|')[0]), resource_id: Number(el.value.split('|')[1]) };
    const o = (S.overrides[c.date] ??= {});
    if (c.kind === 'wash') {
      o.wash = v;
      delete o.dry;   // 洗衣时段变了，烘干重新按新时段安排
    } else {
      (o.dry ??= {})[c.index] = v;
    }
    runPlan({ keepChoices: true });
  }
});

// ---------- 执行 ----------

function log(text, cls = '') {
  const el = $('#log');
  el.hidden = false;
  el.insertAdjacentHTML('beforeend', `<div class="${cls}">${esc(new Date().toLocaleTimeString(locale()))}　${esc(text)}</div>`);
  el.scrollTop = el.scrollHeight;
}

$('#exec-btn').addEventListener('click', async () => {
  const items = pendingItems();
  if (!items.length) return;
  if (!confirm(t('exec.confirm', { n: items.length }))) return;
  S.running = true;
  S.stop = false;
  S.progress = { done: 0, n: items.length };
  const tools = ['#autoresolve-btn', '#replan-btn', '#plan-btn'].map(s => $(s));
  tools.forEach(b => { b.disabled = true; });   // 执行期间不允许改动计划
  setBusy($('#exec-btn'), 'exec.running');
  $('#stop-btn').hidden = false;
  $('#log').innerHTML = '';
  let ok = 0, bad = 0;
  for (const it of items) {
    if (S.stop) { log(t('exec.stopped')); break; }
    const label = `${fmtDay(it.date)} ${hh(it.hour)} ${shortName(it.resource_name)}`;
    S.progress.done += 1;
    S.results[it.key] = { running: true };
    renderPlan();
    try {
      const r = await api('/api/reserve', {
        service_id: it.service_id, resource_id: it.resource_id, date: it.date, hour: it.hour,
      });
      S.results[it.key] = { ok: r.ok, status: r.status };
      r.ok ? ok++ : bad++;
      log(`${label}: ${t(`res.${r.status}`)}`, r.ok ? 'ok' : 'bad');
    } catch (err) {
      S.results[it.key] = { ok: false, err };
      bad++;
      log(`${label}: ${err.message}`, 'bad');
      if (err.code === 'not_logged_in' || err.code === 'session_expired') break;
    }
    renderPlan();
    await sleep(300);
  }
  S.running = false;
  setBusy($('#exec-btn'), null);
  tools.forEach(b => { b.disabled = false; });
  $('#stop-btn').hidden = true;
  renderPlan();
  log(t('exec.done', { ok, bad }) + (bad ? t('exec.doneHint') : ''), bad ? 'bad' : 'ok');
  toast(t('exec.toast', { ok, bad }));
  loadOverview();
});

$('#stop-btn').addEventListener('click', () => { S.stop = true; });

// ---------- 启动 ----------

initLangSelect();
applyStaticText();

(async () => {
  try {
    const me = await api('/api/me');
    if (me.logged_in) await enterApp(me.user); else showLogin();
  } catch (err) {
    showLogin(err);
  }
})();
