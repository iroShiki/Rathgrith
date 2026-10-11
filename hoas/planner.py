"""根据用户选择的日期、机器和时段生成预约计划。纯逻辑，不发任何网络请求。

规则：
- 洗衣机：选中多台且开启轮换时，第 i 个日期优先使用第 (i mod n) 台。首选机器在该时段被占时，
  依次尝试同一时段的其他选中机器（可选：也尝试未选中的机器）。全部被占则记为冲突，
  由用户为当天单独选择时段。
- 烘干机：默认安排在洗衣开始后 dryer_offset 小时，可选同时预约洗衣那一小时。
  尽量让同一天的多个烘干时段使用同一台烘干机；找不到空位同样记为冲突。
- 当天已经有预约时默认跳过，但已有的洗衣时段仍会作为安排烘干的基准。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

from .client import DaySchedule, HoasError


@dataclass
class PlanRequest:
    dates: list[date]
    wash_hour: int
    washers: list[int]
    rotate_washers: bool = True
    allow_other_washers: bool = False
    dryer: bool = False
    dryers: list[int] = field(default_factory=list)
    rotate_dryers: bool = True
    dryer_offset: int = 1
    dryer_include_wash_hour: bool = False
    skip_existing: bool = True
    # "YYYY-MM-DD" -> {"wash": {"hour", "resource_id"} | "skip",
    #                  "dry": {"<序号>": {"hour", "resource_id"} | "skip"}}
    overrides: dict[str, dict] = field(default_factory=dict)

    @classmethod
    def from_json(cls, d: dict) -> PlanRequest:
        return cls(
            dates=sorted({date.fromisoformat(s) for s in d["dates"]}),
            wash_hour=int(d["wash_hour"]),
            washers=[int(x) for x in d.get("washers", [])],
            rotate_washers=bool(d.get("rotate_washers", True)),
            allow_other_washers=bool(d.get("allow_other_washers", False)),
            dryer=bool(d.get("dryer", False)),
            dryers=[int(x) for x in d.get("dryers", [])],
            rotate_dryers=bool(d.get("rotate_dryers", True)),
            dryer_offset=int(d.get("dryer_offset", 1)),
            dryer_include_wash_hour=bool(d.get("dryer_include_wash_hour", False)),
            skip_existing=bool(d.get("skip_existing", True)),
            overrides=d.get("overrides") or {},
        )


def _msg(code: str, **params) -> dict:
    """备注、冲突原因和错误都以 {code, params} 返回，由前端按当前语言翻译。"""
    return {"code": code, "params": params}


def week_key(day: date) -> str:
    y, w, _ = day.isocalendar()
    return f"{y}-W{w:02d}"


def _rotated(ids: list[int], i: int, rotate: bool) -> list[int]:
    if not ids or not rotate:
        return list(ids)
    k = i % len(ids)
    return ids[k:] + ids[:k]


def _slot(sched: DaySchedule, hour: int, rid: int) -> dict:
    return {"hour": hour, "resource_id": rid, "resource_name": sched.resource_name(rid)}


def _item(day: date, kind: str, n: int, status: str, sched: DaySchedule, hour: int, rid: int) -> dict:
    return {
        "key": f"{day.isoformat()}|{kind}|{n}",
        "date": day.isoformat(),
        "kind": kind,
        "status": status,              # "new" = 待预约, "existing" = 已有预约
        "service_id": sched.service_id,
        **_slot(sched, hour, rid),
    }


def _conflict(day: date, kind: str, n: int, reason: str, sched: DaySchedule, target_hour: int | None,
              preferred: list[int], min_hour: int = 0) -> dict:
    return {
        "key": f"{day.isoformat()}|{kind}|{n}",
        "kind": kind,
        "index": n,
        "target_hour": target_hour,
        "reason": reason,
        "preferred": preferred,     # 用户选中的机器，前端一键解决冲突时优先使用
        "options": [_slot(sched, h, rid) for h, rid in sched.free_slots() if h >= min_hour],
    }


def _pick(sched: DaySchedule, choice, fallback_hour: int, order: list[int]):
    """返回 (小时, 资源 ID, 失败原因)。choice 是用户为这一项手动指定的时段。"""
    if isinstance(choice, dict):
        h, rid = int(choice["hour"]), int(choice["resource_id"])
        if sched.is_free(h, rid):
            return h, rid, None
        return None, None, _msg("manual_taken", hour=h, machine=sched.resource_name(rid))
    for rid in order:
        if sched.is_free(fallback_hour, rid):
            return fallback_hour, rid, None
    if fallback_hour not in sched.hours:
        return None, None, _msg("no_slot", hour=fallback_hour)
    return None, None, _msg("all_busy", hour=fallback_hour)


def plan_day(i: int, day: date, req: PlanRequest, wash: DaySchedule, dry: DaySchedule | None) -> dict:
    ov = req.overrides.get(day.isoformat(), {})
    out = {"date": day.isoformat(), "week": week_key(day), "items": [], "conflicts": [], "notes": []}

    # ---- 洗衣机 ----
    wash_hour = None
    existing = wash.mine()
    if existing and req.skip_existing:
        h, rid, _ = existing[0]
        out["items"].append(_item(day, "wash", 0, "existing", wash, h, rid))
        wash_hour = h
    elif ov.get("wash") == "skip":
        out["notes"].append(_msg("wash_skipped"))
    else:
        order = _rotated(req.washers, i, req.rotate_washers)
        if req.allow_other_washers:
            order += [rid for rid, _ in wash.resources if rid not in order]
        h, rid, reason = _pick(wash, ov.get("wash"), req.wash_hour, order)
        if rid is None:
            out["conflicts"].append(_conflict(day, "wash", 0, reason, wash, req.wash_hour, req.washers))
        else:
            out["items"].append(_item(day, "wash", 0, "new", wash, h, rid))
            wash_hour = h
            if not isinstance(ov.get("wash"), dict) and order and rid != order[0]:
                out["notes"].append(_msg("fallback_machine", hour=h, machine=wash.resource_name(order[0]),
                                         used=wash.resource_name(rid)))

    # ---- 烘干机 ----
    if not req.dryer or dry is None:
        return out
    if wash_hour is None:
        if out["conflicts"]:
            out["notes"].append(_msg("pick_wash_first"))
        return out

    existing_dry = dry.mine()
    if existing_dry and req.skip_existing:
        for n, (h, rid, _) in enumerate(existing_dry):
            out["items"].append(_item(day, "dry", n, "existing", dry, h, rid))
        return out

    targets = sorted({wash_hour + req.dryer_offset} | ({wash_hour} if req.dryer_include_wash_hour else set()))
    ov_dry = ov.get("dry") or {}
    order = _rotated(req.dryers, i, req.rotate_dryers)
    # 自动安排的几个时段优先使用同一台烘干机，取衣服时不用换机器
    auto = [t for n, t in enumerate(targets) if str(n) not in ov_dry]
    same = next((r for r in order if auto and all(dry.is_free(t, r) for t in auto)), None)

    for n, t in enumerate(targets):
        choice = ov_dry.get(str(n))
        if choice == "skip":
            out["notes"].append(_msg("dry_skipped", hour=t))
            continue
        h, rid, reason = _pick(dry, choice, t, [same] if same is not None and choice is None else order)
        if rid is None:
            # 烘干只能在洗衣开始之后，备选项不列出更早的时段
            out["conflicts"].append(_conflict(day, "dry", n, reason, dry, t, req.dryers, min_hour=wash_hour))
        else:
            out["items"].append(_item(day, "dry", n, "new", dry, h, rid))
    return out


def build_plan(
    req: PlanRequest,
    wash_scheds: dict[date, DaySchedule | Exception],
    dry_scheds: dict[date, DaySchedule | Exception],
) -> dict:
    days = []
    weeks: dict[str, dict] = {}
    for i, day in enumerate(req.dates):
        wash = wash_scheds.get(day)
        dry = dry_scheds.get(day) if req.dryer else None
        err = next((s for s in (wash, dry) if isinstance(s, Exception)), None)
        if wash is None or err is not None:
            e = _msg(err.code, **err.params) if isinstance(err, HoasError) else _msg("fetch_failed")
            days.append({"date": day.isoformat(), "week": week_key(day), "items": [], "conflicts": [],
                         "notes": [], "error": e})
            continue
        days.append(plan_day(i, day, req, wash, dry))

        # 洗衣机和烘干机共用每周限额，两个页面显示的数字应该相同，保险起见取较大值
        wk = week_key(day)
        used = max(s.used or 0 for s in (wash, dry) if s is not None)
        limit = wash.limit if wash.limit is not None else (dry.limit if dry else None)
        monday = day - timedelta(days=day.weekday())
        w = weeks.setdefault(wk, {"used": used, "limit": limit, "start": monday.isoformat(),
                                  "end": (monday + timedelta(days=6)).isoformat()})
        w["used"] = max(w["used"], used)
    return {"days": days, "weeks": weeks}
