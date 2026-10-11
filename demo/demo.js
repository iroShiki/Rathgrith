'use strict';

/*
 * 演示模式（GitHub Pages 静态版本）。
 *
 * 用浏览器内的模拟后端代替 Python 服务：虚拟时间表、hoas/planner.py 的 JS 移植版，以及只保存在当前标签页
 * （sessionStorage）里的预约。不会向任何地方发送数据。界面部分（index.html / app.js / i18n.js）原样复用。
 *
 * 演示版的加载顺序：i18n.js、demo.js、app.js。由 scripts/build_demo.py 生成。
 */

const DemoPlanner = (() => {
  // ---------- hoas/planner.py 的移植版（两边要保持一致，tests/test_demo_parity.py 会比对结果） ----------

  const msg = (code, params = {}) => ({ code, params });

  const rotated = (ids, i, rotate) => {
    if (!ids.length || !rotate) return [...ids];
    const k = i % ids.length;
    return [...ids.slice(k), ...ids.slice(0, k)];
  };

  const slot = (s, hour, rid) => ({ hour, resource_id: rid, resource_name: s.name(rid) });

  const item = (day, kind, n, status, s, hour, rid) => ({
    key: `${day}|${kind}|${n}`, date: day, kind, status, service_id: s.service_id, ...slot(s, hour, rid),
  });

  const conflict = (day, kind, n, reason, s, targetHour, preferred, minHour = 0) => ({
    key: `${day}|${kind}|${n}`, kind, index: n, target_hour: targetHour, reason, preferred,
    options: s.freeSlots().filter(([h]) => h >= minHour).map(([h, rid]) => slot(s, h, rid)),
  });

  function pick(s, choice, fallbackHour, order) {
    if (choice && typeof choice === 'object') {
      const h = Number(choice.hour), rid = Number(choice.resource_id);
      if (s.isFree(h, rid)) return [h, rid, null];
      return [null, null, msg('manual_taken', { hour: h, machine: s.name(rid) })];
    }
    for (const rid of order) if (s.isFree(fallbackHour, rid)) return [fallbackHour, rid, null];
    if (!s.hours.includes(fallbackHour)) return [null, null, msg('no_slot', { hour: fallbackHour })];
    return [null, null, msg('all_busy', { hour: fallbackHour })];
  }

  function isoWeek(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);   // 本周的周四决定所属年份
    const year = d.getUTCFullYear();
    const firstThu = new Date(Date.UTC(year, 0, 4));
    const week = 1 + Math.round(((d - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function planDay(i, day, req, wash, dry) {
    const ov = req.overrides[day] || {};
    const out = { date: day, week: isoWeek(day), items: [], conflicts: [], notes: [] };

    let washHour = null;
    const existing = wash.mine();
    if (existing.length && req.skip_existing) {
      const [h, rid] = existing[0];
      out.items.push(item(day, 'wash', 0, 'existing', wash, h, rid));
      washHour = h;
    } else if (ov.wash === 'skip') {
      out.notes.push(msg('wash_skipped'));
    } else {
      const order = rotated(req.washers, i, req.rotate_washers);
      if (req.allow_other_washers) for (const [rid] of wash.resources) if (!order.includes(rid)) order.push(rid);
      const [h, rid, reason] = pick(wash, ov.wash, req.wash_hour, order);
      if (rid === null) {
        out.conflicts.push(conflict(day, 'wash', 0, reason, wash, req.wash_hour, req.washers));
      } else {
        out.items.push(item(day, 'wash', 0, 'new', wash, h, rid));
        washHour = h;
        const manual = ov.wash && typeof ov.wash === 'object';
        if (!manual && order.length && rid !== order[0]) {
          out.notes.push(msg('fallback_machine', { hour: h, machine: wash.name(order[0]), used: wash.name(rid) }));
        }
      }
    }

    if (!req.dryer || !dry) return out;
    if (washHour === null) {
      if (out.conflicts.length) out.notes.push(msg('pick_wash_first'));
      return out;
    }

    const existingDry = dry.mine();
    if (existingDry.length && req.skip_existing) {
      existingDry.forEach(([h, rid], n) => out.items.push(item(day, 'dry', n, 'existing', dry, h, rid)));
      return out;
    }

    const targets = [...new Set([washHour + req.dryer_offset, ...(req.dryer_include_wash_hour ? [washHour] : [])])]
      .sort((a, b) => a - b);
    const ovDry = ov.dry || {};
    const order = rotated(req.dryers, i, req.rotate_dryers);
    const auto = targets.filter((_, n) => !(String(n) in ovDry));
    const same = auto.length ? order.find(r => auto.every(t => dry.isFree(t, r))) ?? null : null;

    targets.forEach((t, n) => {
      const choice = ovDry[String(n)];
      if (choice === 'skip') { out.notes.push(msg('dry_skipped', { hour: t })); return; }
      const [h, rid, reason] = pick(dry, choice, t, same !== null && choice === undefined ? [same] : order);
      if (rid === null) out.conflicts.push(conflict(day, 'dry', n, reason, dry, t, req.dryers, washHour));
      else out.items.push(item(day, 'dry', n, 'new', dry, h, rid));
    });
    return out;
  }

  // getSched(serviceId, day) 返回时间表对象，或者在日期不可预约时返回 {code, params}
  function buildPlan(req, getSched, washId, dryId) {
    const days = [];
    const weeks = {};
    req.dates.forEach((day, i) => {
      const wash = getSched(washId, day);
      const dry = req.dryer ? getSched(dryId, day) : null;
      const err = [wash, dry].find(s => s && s.code);
      if (err) {
        days.push({ date: day, week: isoWeek(day), items: [], conflicts: [], notes: [], error: err });
        return;
      }
      days.push(planDay(i, day, req, wash, dry));
      const wk = isoWeek(day);
      const used = Math.max(...[wash, dry].filter(Boolean).map(s => s.used || 0));
      const monday = addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
      weeks[wk] ??= { used, limit: wash.limit ?? (dry ? dry.limit : null), start: monday, end: addDays(monday, 6) };
      weeks[wk].used = Math.max(weeks[wk].used, used);
    });
    return { days, weeks };
  }

  function planRequest(d) {
    return {
      dates: [...new Set(d.dates)].sort(),
      wash_hour: Number(d.wash_hour),
      washers: (d.washers || []).map(Number),
      rotate_washers: d.rotate_washers ?? true,
      allow_other_washers: !!d.allow_other_washers,
      dryer: !!d.dryer,
      dryers: (d.dryers || []).map(Number),
      rotate_dryers: d.rotate_dryers ?? true,
      dryer_offset: Number(d.dryer_offset ?? 1),
      dryer_include_wash_hour: !!d.dryer_include_wash_hour,
      skip_existing: d.skip_existing ?? true,
      overrides: d.overrides || {},
    };
  }

  return { buildPlan, planRequest, isoWeek, addDays };
})();

if (typeof module !== 'undefined') module.exports = DemoPlanner;   // 供 Node 中的一致性测试使用

// ---------- Mock backend (browser only) ----------

if (typeof window !== 'undefined') (() => {
  const WASH = 509, DRY = 629, LIMIT = 10;
  const HOURS = Array.from({ length: 14 }, (_, i) => 8 + i);   // 08:00–21:00 开始
  const RESOURCES = {
    [WASH]: [[318, 'Washing machine 1'], [319, 'Washing machine 2'], [1166, 'Washing machine 3']],
    [DRY]: [[581, 'Dryer 1'], [582, 'Dryer 2'], [1167, 'Dryer 3'], [1168, 'Dryer 4']],
  };
  const SERVICE_NAME = { [WASH]: 'Laundry', [DRY]: 'Dryers' };
  const { buildPlan, planRequest, isoWeek, addDays } = DemoPlanner;

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const lastOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  const maxDate = `${lastOfNextMonth.getFullYear()}-${pad(lastOfNextMonth.getMonth() + 1)}-${pad(lastOfNextMonth.getDate())}`;

  // ---- 状态（只保存在当前标签页） ----
  const KEY = 'rathgrith.demo';
  const seed = () => ({
    user: null,
    mine: [
      { sid: WASH, rid: 318, day: addDays(today, 1), hour: 20 },
      { sid: DRY, rid: 582, day: addDays(today, 1), hour: 21 },
      { sid: WASH, rid: 319, day: addDays(today, 2), hour: 20 },
      { sid: WASH, rid: 318, day: addDays(today, 4), hour: 19 },
    ],
  });
  let st;
  try { st = JSON.parse(sessionStorage.getItem(KEY)) || seed(); } catch { st = seed(); }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch { /* 隐私模式 */ } };

  // ---- 虚拟时间表：别人的预约按日期和时段确定性地生成，晚上更容易被占 ----
  function rand(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967296;
  }
  const isMine = (sid, rid, day, hour) => st.mine.some(m => m.sid === sid && m.rid === rid && m.day === day && m.hour === hour);
  const hoursOf = day => (day === today ? HOURS.filter(h => h > now.getHours()) : HOURS);

  function status(sid, rid, day, hour) {
    if (!hoursOf(day).includes(hour)) return 'unavailable';
    if (isMine(sid, rid, day, hour)) return 'mine';
    const p = hour >= 19 ? 0.6 : hour >= 17 ? 0.4 : 0.2;
    return rand(`${sid}|${rid}|${day}|${hour}`) < p ? 'reserved' : 'free';
  }
  const weekUsed = day => st.mine.filter(m => isoWeek(m.day) === isoWeek(day)).length;

  function sched(sid, day) {
    if (day < today || day > maxDate) return { code: 'out_of_range', params: { date: day } };
    const resources = RESOURCES[sid];
    const hours = hoursOf(day);
    const names = Object.fromEntries(resources);
    const all = hours.flatMap(h => resources.map(([rid]) => [h, rid]));
    return {
      service_id: sid, resources, hours, used: weekUsed(day), limit: LIMIT,
      name: rid => names[rid] ?? String(rid),
      isFree: (h, rid) => status(sid, rid, day, h) === 'free',
      freeSlots: () => all.filter(([h, rid]) => status(sid, rid, day, h) === 'free'),
      mine: () => all.filter(([h, rid]) => status(sid, rid, day, h) === 'mine'),
    };
  }

  // ---- 接口 ----
  const ok = body => ({ status: 200, body });
  const fail = (code, status = 400, params = {}) => ({ status, body: { error: code, code, params } });
  const loggedIn = () => !!st.user;

  const routes = {
    'GET /api/me': () => ok(loggedIn() ? { logged_in: true, user: st.user } : { logged_in: false }),

    'POST /api/login': b => {
      const user = (b.username || '').trim();
      if (!user || !b.password) return fail('missing_credentials');
      st.user = user;
      save();
      return ok({ user });
    },

    'POST /api/logout': () => { st.user = null; save(); return ok({ ok: true }); },

    'GET /api/overview': () => ok({
      user: st.user,
      min_date: today,
      max_date: maxDate,
      week: { used: weekUsed(today), limit: LIMIT },
      services: Object.fromEntries([['wash', WASH], ['dry', DRY]].map(([kind, sid]) => [kind, {
        service_id: sid,
        resources: RESOURCES[sid].map(([id, name]) => ({ id, name })),
        hours: HOURS,
      }])),
      reservations: st.mine
        .filter(m => m.day > today || (m.day === today && m.hour + 1 > now.getHours()))
        .sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour)
        .map(m => ({
          service_id: m.sid, service_name: SERVICE_NAME[m.sid], day: m.day, start_hour: m.hour, end_hour: m.hour + 1,
          resource_name: Object.fromEntries(RESOURCES[m.sid])[m.rid], resource_id: m.rid,
          kind: m.sid === DRY ? 'dry' : 'wash',
        })),
    }),

    'POST /api/plan': b => {
      const req = planRequest(b);
      if (!req.dates.length) return fail('no_dates');
      if (!req.washers.length) return fail('no_washers');
      if (req.dryer && !req.dryers.length) return fail('no_dryers');
      return ok(buildPlan(req, sched, WASH, DRY));
    },

    'POST /api/reserve': b => {
      const sid = Number(b.service_id), rid = Number(b.resource_id), day = b.date, hour = Number(b.hour);
      const before = status(sid, rid, day, hour);
      if (before === 'mine') return ok({ ok: true, status: 'already' });
      if (before !== 'free') return ok({ ok: false, status: 'taken' });
      if (weekUsed(day) >= LIMIT) return ok({ ok: false, status: 'rejected' });   // 和真实站点一样：超出周限额时不接受
      st.mine.push({ sid, rid, day, hour });
      save();
      return ok({ ok: true, status: 'reserved' });
    },

    'POST /api/cancel': b => {
      const sid = Number(b.service_id), rid = Number(b.resource_id), hour = Number(b.hour);
      const i = st.mine.findIndex(m => m.sid === sid && m.rid === rid && m.day === b.date && m.hour === hour);
      if (i < 0) return fail('reservation_not_found');
      st.mine.splice(i, 1);
      save();
      return ok({ ok: true });
    },
  };

  // 模拟网络延迟，让加载状态和真实使用时一样可见
  const DELAY = { '/api/overview': 900, '/api/plan': 700, '/api/reserve': 450, '/api/login': 600 };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opt = {}) => {
    const path = typeof input === 'string' ? input : input.url;
    if (!path.startsWith('/api/')) return realFetch(input, opt);
    const method = (opt.method || 'GET').toUpperCase();
    const body = opt.body ? JSON.parse(opt.body) : {};
    await new Promise(r => setTimeout(r, DELAY[path] ?? 300));
    const route = routes[`${method} ${path}`];
    let res;
    if (!route) res = fail('site_error', 404);
    else if (!['/api/me', '/api/login', '/api/logout'].includes(path) && !loggedIn()) res = fail('not_logged_in', 401);
    else res = route(body);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'Content-Type': 'application/json' } });
  };

  // ---- 演示提示 ----
  document.documentElement.classList.add('demo');
  for (const id of ['demo-banner', 'demo-login-hint']) document.getElementById(id)?.removeAttribute('hidden');
  // 部署在 <账号>.github.io/<仓库>/ 时，提示条链接到对应的 GitHub 仓库
  const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  const link = document.getElementById('demo-source');
  if (link && m && repo) { link.href = `https://github.com/${m[1]}/${repo}`; link.hidden = false; }
})();
