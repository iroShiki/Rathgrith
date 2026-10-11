"""Web 服务：提供 UI 页面和 /api/* 接口。可以在本地运行，也可以部署到 Vercel。

账号密码只在登录请求中经过内存，不会保存。登录后 HOAS 的会话 cookie 加密存在访问者自己的浏览器里
（见 auth.py），服务端不保存任何登录状态，因此不同浏览器、不同访问者之间互不影响。
"""
from __future__ import annotations

import threading
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from datetime import date
from pathlib import Path

from flask import Flask, g, jsonify, request, send_from_directory

from . import auth, config
from .client import MINE, HoasClient, HoasError, LoginFailed, NotLoggedIn
from .planner import PlanRequest, build_plan

STATIC_DIR = Path(__file__).parent / "static"
SERVICES = {"wash": config.WASH_SERVICE_ID, "dry": config.DRY_SERVICE_ID}

app = Flask(__name__, static_folder=None)


@app.before_request
def _load_session():
    """从这个浏览器自己的加密 cookie 还原 HOAS 会话。"""
    g.state = auth.decode(request.cookies.get(auth.COOKIE_NAME))
    g.client = None
    g.clear_auth = False
    if g.state:
        g.client = HoasClient(g.state["cookies"], g.state.get("user"), cache_key=g.state["sid"])


@app.after_request
def _save_session(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    if g.get("clear_auth"):
        resp.delete_cookie(auth.COOKIE_NAME, path="/")
        return resp
    c, state = g.get("client"), g.get("state")
    # HOAS 会定期轮换会话 cookie，变化后要写回浏览器，否则下次请求会用到失效的旧 cookie
    if c is not None and state is not None and c.export_cookies() != state["cookies"]:
        state = {**state, "cookies": c.export_cookies(), "user": c.user_name}
        host = request.host.split(":")[0]
        resp.set_cookie(
            auth.COOKIE_NAME,
            auth.encode(state),
            max_age=auth.MAX_AGE if state.get("remember") else None,
            path="/",
            httponly=True,
            secure=host not in ("localhost", "127.0.0.1"),
            samesite="Lax",
        )
    return resp


def client() -> HoasClient:
    if g.client is None:
        raise NotLoggedIn("请先登录", code="not_logged_in")
    return g.client


def error(code: str, status: int = 400, message: str = "", **params):
    """错误响应：前端按 code 和 params 翻译成当前语言，error 只是给人看的备用文本。"""
    return jsonify(error=message or code, code=code, params=params), status


@app.errorhandler(NotLoggedIn)
def _not_logged_in(e):
    g.clear_auth = True
    return error(e.code, 401, str(e), **e.params)


@app.errorhandler(HoasError)
def _hoas_error(e):
    return error(e.code, 400, str(e), **e.params)


@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(STATIC_DIR, name)


@app.get("/api/me")
def me():
    if g.client is None:
        return jsonify(logged_in=False)
    return jsonify(logged_in=True, user=g.client.user_name)


@app.post("/api/login")
def login():
    body = request.get_json()
    username, password = (body.get("username") or "").strip(), body.get("password") or ""
    if not username or not password:
        return error("missing_credentials")
    remember = bool(body.get("remember", True))
    c = HoasClient()
    try:
        user = c.login(username, password, remember=remember)
    except LoginFailed as e:
        return error(e.code, 401, str(e))
    c.cache_key = auth.new_session_id()
    g.client = c
    # cookies 留空，after_request 会发现变化并把新会话写进浏览器 cookie
    g.state = {"sid": c.cache_key, "user": user, "remember": remember, "cookies": []}
    return jsonify(user=user)


@app.post("/api/logout")
def logout():
    if g.client is not None:
        try:
            g.client.logout()     # 让 HOAS 那边的会话也失效
        except Exception:  # noqa: BLE001 — 退出时网络出错也要清掉本地 cookie
            pass
    g.client = None
    g.clear_auth = True
    return jsonify(ok=True)


@app.get("/api/overview")
def overview():
    c = client()
    services = {}
    min_date = max_date = None
    week = {"used": None, "limit": None}
    for kind, sid in SERVICES.items():
        today = c.get_day(sid, fresh=True)
        min_date, max_date = today.min_date, today.max_date
        if today.used is not None:   # 洗衣机和烘干机共用限额，两边数字相同
            week = {"used": today.used, "limit": today.limit}
        # 最后一天通常空位最多，能把所有机器的资源 ID 学全
        last = c.get_day(sid, max_date) if max_date else today
        names = dict(today.resources) | dict(last.resources)
        services[kind] = {
            "service_id": sid,
            "resources": [{"id": rid, "name": n} for rid, n in sorted(names.items(), key=lambda x: x[1])],
            "hours": sorted(set(last.hours) | set(today.hours)),
        }
    reservations = [
        {**asdict(r), "day": r.day.isoformat(),
         "kind": next((k for k, sid in SERVICES.items() if sid == r.service_id), "other")}
        for r in c.my_reservations()
    ]
    return jsonify(
        user=c.user_name,
        min_date=min_date and min_date.isoformat(),
        max_date=max_date and max_date.isoformat(),
        week=week,
        services=services,
        reservations=reservations,
    )


def _fetch_all(c: HoasClient, sid: int, days: list[date], fresh: bool) -> dict:
    def one(d):
        try:
            return d, c.get_day(sid, d, fresh=fresh)
        except NotLoggedIn:
            raise
        except Exception as e:  # noqa: BLE001 — 单天失败不影响其他日期
            return d, e

    with ThreadPoolExecutor(config.FETCH_WORKERS) as ex:
        return dict(ex.map(one, days))


@app.post("/api/plan")
def plan():
    c = client()
    body = request.get_json()
    req = PlanRequest.from_json(body)
    if not req.dates:
        return error("no_dates")
    if not req.washers:
        return error("no_washers")
    if req.dryer and not req.dryers:
        return error("no_dryers")
    fresh = bool(body.get("refresh"))
    wash = _fetch_all(c, config.WASH_SERVICE_ID, req.dates, fresh)
    dry = _fetch_all(c, config.DRY_SERVICE_ID, req.dates, fresh) if req.dryer else {}
    return jsonify(build_plan(req, wash, dry))


@app.post("/api/reserve")
def reserve():
    c = client()
    b = request.get_json()
    sid, rid, day, hour = int(b["service_id"]), int(b["resource_id"]), date.fromisoformat(b["date"]), int(b["hour"])
    # status 由前端翻译：already 已是自己的预约 / taken 已被他人预约 / reserved 成功 /
    # sniped 被他人抢先 / rejected 站点未接受（请求发出后格子仍然空闲，通常是超出每周限额或尚未开放）
    before = c.get_day(sid, day, fresh=True).cell(hour, rid).status
    if before == MINE:
        return jsonify(ok=True, status="already")
    if before != "free":
        return jsonify(ok=False, status="taken")
    after = c.reserve(sid, rid, day, hour)
    if after == MINE:
        return jsonify(ok=True, status="reserved")
    if after == "reserved":
        return jsonify(ok=False, status="sniped")
    return jsonify(ok=False, status="rejected")


@app.post("/api/cancel")
def cancel():
    c = client()
    b = request.get_json()
    ok = c.cancel(int(b["service_id"]), int(b["resource_id"]), date.fromisoformat(b["date"]), int(b["hour"]))
    return jsonify(ok=ok)


def main():
    url = f"http://{config.HOST}:{config.PORT}/"
    print(f"HOAS 预约工具已启动：{url}  （Ctrl+C 退出）")
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=config.HOST, port=config.PORT, threaded=True, debug=False)


if __name__ == "__main__":
    main()
