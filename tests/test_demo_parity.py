"""演示模式里的 JS 规划器（demo/demo.js）必须和 hoas/planner.py 给出完全相同的计划。

随机生成时间表和计划请求，分别交给两边计算后逐项比较。需要 Node.js，没有时跳过。
"""
import json
import random
import shutil
import subprocess
from datetime import date, timedelta
from pathlib import Path

import pytest

from hoas.client import FREE, MINE, RESERVED, UNAVAILABLE, Cell, DaySchedule, OutOfRange
from hoas.planner import PlanRequest, build_plan

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")
WASH, DRY = 509, 629
RESOURCES = {
    WASH: [(318, "Washing machine 1"), (319, "Washing machine 2"), (1166, "Washing machine 3")],
    DRY: [(581, "Dryer 1"), (582, "Dryer 2"), (1167, "Dryer 3"), (1168, "Dryer 4")],
}

NODE_RUNNER = r"""
const P = require(process.argv[1]);
const cases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = cases.map(({ req, scheds }) => P.buildPlan(P.planRequest(req), (sid, day) => {
  const s = scheds[`${sid}|${day}`];
  if (s.error) return s.error;
  const status = new Map(s.cells.map(([h, rid, st]) => [`${h}|${rid}`, st]));
  const all = s.hours.flatMap(h => s.resources.map(([rid]) => [h, rid]));
  const names = Object.fromEntries(s.resources);
  const is = st => ([h, rid]) => status.get(`${h}|${rid}`) === st;
  return {
    service_id: sid, resources: s.resources, hours: s.hours, used: s.used, limit: 10,
    name: rid => names[rid] ?? String(rid),
    isFree: (h, rid) => status.get(`${h}|${rid}`) === 'free',
    freeSlots: () => all.filter(is('free')),
    mine: () => all.filter(is('mine')),
  };
}, 509, 629));
process.stdout.write(JSON.stringify(out));
"""


def random_case(rng: random.Random):
    start = date(2026, 11, 2) + timedelta(days=rng.randint(0, 20))
    dates = sorted({start + timedelta(days=rng.randint(0, 13)) for _ in range(rng.randint(1, 6))})
    raw, py = {}, {WASH: {}, DRY: {}}
    for sid, res in RESOURCES.items():
        for d in dates:
            key = f"{sid}|{d.isoformat()}"
            if rng.random() < 0.05:
                raw[key] = {"error": {"code": "out_of_range", "params": {"date": d.isoformat()}}}
                py[sid][d] = OutOfRange("x", date=d.isoformat())
                continue
            hours = list(range(rng.choice([8, 8, 8, 13]), 22))
            # 大约三分之一的日期带一个自己的预约，其余日期覆盖“新预约”的各种分支
            mine_rate = 0.4 / (len(hours) * len(res)) if rng.random() < 0.8 else 0
            cells = [[h, rid, rng.choices([FREE, RESERVED, MINE, UNAVAILABLE], [60, 36, 100 * mine_rate, 2])[0]]
                     for h in hours for rid, _ in res]
            used = rng.randint(0, 9)
            raw[key] = {"hours": hours, "cells": cells, "used": used, "resources": [list(r) for r in res]}
            py[sid][d] = DaySchedule(sid, d, res, hours, {(h, rid): Cell(st) for h, rid, st in cells},
                                     used, 10, None, None)

    overrides = {}
    for d in dates:
        if rng.random() < 0.3:
            ov = {}
            if rng.random() < 0.5:
                ov["wash"] = "skip" if rng.random() < 0.2 else {
                    "hour": rng.randint(8, 21), "resource_id": rng.choice(RESOURCES[WASH])[0]}
            if rng.random() < 0.5:
                ov["dry"] = {str(n): ("skip" if rng.random() < 0.2 else {
                    "hour": rng.randint(8, 21), "resource_id": rng.choice(RESOURCES[DRY])[0]}) for n in range(2)
                    if rng.random() < 0.6}
            overrides[d.isoformat()] = ov

    req = {
        "dates": [d.isoformat() for d in dates],
        "wash_hour": rng.choice([8, 12, 19, 20, 21]),
        "washers": rng.sample([318, 319, 1166], rng.randint(1, 3)),
        "rotate_washers": rng.random() < 0.7,
        "allow_other_washers": rng.random() < 0.3,
        "dryer": rng.random() < 0.7,
        "dryers": rng.sample([581, 582, 1167, 1168], rng.randint(1, 4)),
        "rotate_dryers": rng.random() < 0.7,
        "dryer_offset": rng.choice([0, 1, 1, 2, 3]),
        "dryer_include_wash_hour": rng.random() < 0.3,
        "skip_existing": rng.random() < 0.8,
        "overrides": overrides,
    }
    return req, raw, py


@pytest.mark.skipif(NODE is None, reason="需要 Node.js")
def test_js_planner_matches_python():
    rng = random.Random(20261011)
    cases, expected = [], []
    for _ in range(400):
        req, raw, py = random_case(rng)
        plan = build_plan(PlanRequest.from_json(req), py[WASH], py[DRY] if req["dryer"] else {})
        expected.append(json.loads(json.dumps(plan)))
        cases.append({"req": req, "scheds": raw})

    out = subprocess.run([NODE, "-e", NODE_RUNNER, str(ROOT / "demo" / "demo.js")],
                         input=json.dumps(cases), capture_output=True, text=True, check=True, timeout=60)
    actual = json.loads(out.stdout)
    for i, (exp, act) in enumerate(zip(expected, actual)):
        assert act == exp, f"第 {i} 组不一致：\nreq={json.dumps(cases[i]['req'])}"
