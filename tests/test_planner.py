from datetime import date

from hoas.client import FREE, MINE, RESERVED, Cell, DaySchedule, parse_my_reservations, parse_timetable
from hoas.planner import PlanRequest, build_plan

W1, W2, W3 = 318, 319, 1166
D1, D2 = 581, 582
HOURS = list(range(8, 22))


def sched(sid, day, resources, overrides=None, used=0):
    cells = {(h, rid): Cell(FREE) for h in HOURS for rid, _ in resources}
    cells.update(overrides or {})
    return DaySchedule(sid, day, resources, HOURS, cells, used, 10, None, None)


WASHERS = [(W1, "Washing machine 1"), (W2, "Washing machine 2"), (W3, "Washing machine 3")]
DRYERS = [(D1, "Dryer 1"), (D2, "Dryer 2")]


def wash(day, overrides=None, used=0):
    return sched(509, day, WASHERS, overrides, used)


def dry(day, overrides=None, used=0):
    return sched(629, day, DRYERS, overrides, used)


def req(dates, **kw):
    base = dict(dates=dates, wash_hour=21, washers=[W1, W2])
    base.update(kw)
    return PlanRequest(**base)


def items(day_plan, kind="wash"):
    return [(i["hour"], i["resource_id"], i["status"]) for i in day_plan["items"] if i["kind"] == kind]


def test_rotates_between_selected_washers():
    days = [date(2026, 11, d) for d in (2, 3, 4)]
    plan = build_plan(req(days), {d: wash(d) for d in days}, {})
    assert [items(p) for p in plan["days"]] == [[(21, W1, "new")], [(21, W2, "new")], [(21, W1, "new")]]


def test_falls_back_to_other_selected_washer_at_same_hour():
    d = date(2026, 11, 2)
    plan = build_plan(req([d]), {d: wash(d, {(21, W1): Cell(RESERVED)})}, {})
    assert items(plan["days"][0]) == [(21, W2, "new")]
    assert plan["days"][0]["notes"] == [{"code": "fallback_machine", "params": {
        "hour": 21, "machine": "Washing machine 1", "used": "Washing machine 2"}}]


def test_conflict_when_all_selected_busy_unless_others_allowed():
    d = date(2026, 11, 2)
    busy = {(21, W1): Cell(RESERVED), (21, W2): Cell(RESERVED)}
    plan = build_plan(req([d]), {d: wash(d, busy)}, {})
    day = plan["days"][0]
    assert items(day) == [] and len(day["conflicts"]) == 1
    assert {"hour": 21, "resource_id": W3, "resource_name": "Washing machine 3"} in day["conflicts"][0]["options"]

    plan = build_plan(req([d], allow_other_washers=True), {d: wash(d, busy)}, {})
    assert items(plan["days"][0]) == [(21, W3, "new")]


def test_manual_override_resolves_conflict_and_dryer_follows():
    d = date(2026, 11, 2)
    busy = {(21, W1): Cell(RESERVED), (21, W2): Cell(RESERVED)}
    r = req([d], dryer=True, dryers=[D1, D2], overrides={"2026-11-02": {"wash": {"hour": 18, "resource_id": W1}}})
    day = build_plan(r, {d: wash(d, busy)}, {d: dry(d)})["days"][0]
    assert items(day) == [(18, W1, "new")]
    assert items(day, "dry") == [(19, D1, "new")]


def test_dryer_after_last_slot_is_a_conflict():
    d = date(2026, 11, 2)
    day = build_plan(req([d], dryer=True, dryers=[D1]), {d: wash(d)}, {d: dry(d)})["days"][0]
    assert items(day, "dry") == []
    [c] = day["conflicts"]
    assert c["kind"] == "dry" and c["reason"] == {"code": "no_slot", "params": {"hour": 22}}
    assert {o["hour"] for o in c["options"]} == {21}   # 不列出洗衣之前的时段


def test_dryer_including_wash_hour_prefers_one_machine():
    d = date(2026, 11, 2)
    r = req([d], wash_hour=18, dryer=True, dryers=[D1, D2], dryer_include_wash_hour=True)
    day = build_plan(r, {d: wash(d)}, {d: dry(d, {(19, D1): Cell(RESERVED)})})["days"][0]
    assert items(day, "dry") == [(18, D2, "new"), (19, D2, "new")]


def test_existing_reservation_is_kept_and_used_for_dryer():
    d = date(2026, 11, 2)
    r = req([d], dryer=True, dryers=[D1])
    day = build_plan(r, {d: wash(d, {(17, W2): Cell(MINE, 1)})}, {d: dry(d)})["days"][0]
    assert items(day) == [(17, W2, "existing")]
    assert items(day, "dry") == [(18, D1, "new")]


def test_weeks_report_shared_quota():
    days = [date(2026, 11, 2), date(2026, 11, 9)]
    plan = build_plan(req(days), {days[0]: wash(days[0], used=3), days[1]: wash(days[1], used=0)}, {})
    assert plan["weeks"]["2026-W45"] == {"used": 3, "limit": 10, "start": "2026-11-02", "end": "2026-11-08"}
    assert plan["weeks"]["2026-W46"]["used"] == 0


# ---- 解析 ----

def _cell(kind, rid, hour, day="2026-11-02", name="Washing machine 1"):
    base = "https://booking-hoas.tampuuri.fi/varaus/service"
    if kind == "free":
        return f'<td><a href="{base}/reserve/{rid}/{hour:02d}.00/{day}" class="free" data-resource="Laundry: {name}">Vacant</a></td>'
    if kind == "mine":
        return f'<td><a href="{base}/cancel/555" class="myReservation">Your reservation</a></td>'
    if kind == "reserved":
        return '<td><span class="reserved">Reserved</span></td>'
    return "<td></td>"


TIMETABLE_HTML = f"""
<html><body>
<a href="https://booking-hoas.tampuuri.fi/varaus/userprofile">Demo User</a>
<ul class="myReservations">
  <li><a href="https://booking-hoas.tampuuri.fi/varaus/service/timetable/509/10/10/2026" class="washer">Sat&nbsp;10.10.2026 20:00 - 21:00 Washing&nbsp;machine&nbsp;2&nbsp;-&nbsp;Laundry,&nbsp;staircase&nbsp;B</a></li>
</ul>
<script>var minDate = '10.10.2026',
    maxDate = '30.11.2026';</script>
<a href="javascript: ;" class="js-datepicker">02.11.2026</a>
<div class="box js-timetable-slide"><table class="calendar">
<tr><td></td><td><h3> Washing machine 1 </h3></td><td><h3> Washing machine 2 </h3></td></tr>
<tr><td></td><td colspan="2">Reservations used this week: 7 out of 10</td></tr>
<tr><td>20:00</td>{_cell("free", 318, 20)}{_cell("reserved", 319, 20)}</tr>
<tr><td>21:00</td>{_cell("mine", 318, 21)}{_cell("empty", 319, 21)}</tr>
</table></div>
</body></html>
"""


def test_parse_timetable():
    known = {"Washing machine 2": 319}
    s = parse_timetable(TIMETABLE_HTML, 509, known)
    assert s.day == date(2026, 11, 2)
    assert (s.min_date, s.max_date) == (date(2026, 10, 10), date(2026, 11, 30))
    assert (s.used, s.limit) == (7, 10)
    assert s.resources == [(318, "Washing machine 1"), (319, "Washing machine 2")]
    assert s.hours == [20, 21]
    assert s.cell(20, 318).status == FREE
    assert s.cell(20, 319).status == RESERVED
    assert s.cell(21, 318).status == MINE and s.cell(21, 318).cancel_id == 555
    assert s.cell(21, 319).status == "unavailable"
    assert known["Washing machine 1"] == 318


def test_parse_my_reservations():
    [r] = parse_my_reservations(TIMETABLE_HTML, {509: {"Washing machine 2": 319}})
    assert (r.service_id, r.day, r.start_hour, r.end_hour) == (509, date(2026, 10, 10), 20, 21)
    assert (r.resource_name, r.resource_id, r.service_name) == ("Washing machine 2", 319, "Laundry, staircase B")
