"""HOAS（Tampuuri）预约站点的客户端。

站点是服务端渲染的 HTML，没有 JSON API，所以所有读取都靠解析页面。接口说明见 API.md。
预约和取消请求只会 302 重定向回时间表，不返回结果，因此每次操作后都要重新拉取时间表来确认。
"""
from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime

import requests
from bs4 import BeautifulSoup

from . import config

FREE, RESERVED, MINE, UNAVAILABLE = "free", "reserved", "mine", "unavailable"

_RESERVE_RE = re.compile(r"/varaus/service/reserve/(\d+)/(\d{2})\.(\d{2})/(\d{4}-\d{2}-\d{2})")
_CANCEL_RE = re.compile(r"/varaus/service/cancel/(\d+)")
_TIMETABLE_RE = re.compile(r"/varaus/service/timetable/(\d+)")
_RANGE_RE = re.compile(r"minDate\s*=\s*'([\d.]+)'\s*,\s*maxDate\s*=\s*'([\d.]+)'")
_HOUR_RE = re.compile(r"^(\d{2}):00$")
_SIDEBAR_RE = re.compile(
    r"(\d{2}\.\d{2}\.\d{4})\s+(\d{2}):\d{2}\s*-\s*(\d{2}):\d{2}\s+(.+?)\s+-\s+(.+)$"
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)


class HoasError(Exception):
    """code 和 params 会原样返回给前端，由前端按当前语言翻译；消息文本只用于日志和调试。"""
    code = "site_error"

    def __init__(self, message: str = "", code: str | None = None, **params):
        super().__init__(message)
        if code:
            self.code = code
        self.params = params


class NotLoggedIn(HoasError):
    code = "not_logged_in"


class LoginFailed(HoasError):
    code = "login_failed"


class OutOfRange(HoasError):
    """请求的日期不在可预约范围内（站点会重定向到别的日期）。"""
    code = "out_of_range"


def _fi_date(s: str) -> date:
    return datetime.strptime(s, "%d.%m.%Y").date()


def _text(el) -> str:
    return " ".join(el.get_text(" ").replace("\xa0", " ").split())


@dataclass
class Cell:
    status: str
    cancel_id: int | None = None


@dataclass
class DaySchedule:
    service_id: int
    day: date
    resources: list[tuple[int, str]]          # 从左到右的 (资源 ID, 名称)
    hours: list[int]                          # 当天页面上列出的开始小时
    cells: dict[tuple[int, int], Cell]        # (小时, 资源 ID) -> Cell
    used: int | None                          # 本周已用次数（洗衣机和烘干机共用）
    limit: int | None
    min_date: date | None
    max_date: date | None
    fetched_at: float = field(default_factory=time.time)

    def cell(self, hour: int, resource_id: int) -> Cell:
        return self.cells.get((hour, resource_id), Cell(UNAVAILABLE))

    def is_free(self, hour: int, resource_id: int) -> bool:
        return self.cell(hour, resource_id).status == FREE

    def free_slots(self) -> list[tuple[int, int]]:
        return sorted(k for k, c in self.cells.items() if c.status == FREE)

    def mine(self) -> list[tuple[int, int, Cell]]:
        return sorted((h, rid, c) for (h, rid), c in self.cells.items() if c.status == MINE)

    def resource_name(self, resource_id: int) -> str:
        return dict(self.resources).get(resource_id, str(resource_id))


@dataclass
class Reservation:
    service_id: int
    service_name: str
    day: date
    start_hour: int
    end_hour: int
    resource_name: str
    resource_id: int | None


def parse_timetable(html: str, service_id: int, known: dict[str, int]) -> DaySchedule:
    """解析时间表页面。`known` 是资源名 -> ID 的映射，解析时会就地补充新学到的条目。"""
    soup = BeautifulSoup(html, "html.parser")

    picker = soup.select_one("a.js-datepicker")
    if picker is None:
        raise HoasError("页面中找不到时间表（可能是站点结构发生了变化）", code="site_changed")
    day = _fi_date(_text(picker))

    min_date = max_date = None
    m = _RANGE_RE.search(html)
    if m:
        min_date, max_date = _fi_date(m.group(1)), _fi_date(m.group(2))

    table = soup.select_one(".js-timetable-slide table.calendar")
    if table is None:
        raise HoasError("页面中找不到时间表（可能是站点结构发生了变化）", code="site_changed")
    rows = table.find_all("tr")
    names = [_text(h) for h in rows[0].find_all("h3")]

    # 第一遍：从空闲格子的链接里学习每一列的资源 ID
    col_ids: list[int | None] = [known.get(n) for n in names]
    for tr in rows:
        for idx, td in enumerate(tr.find_all("td", recursive=False)[1:]):
            a = td.find("a", class_="free")
            if a and idx < len(names) and (m := _RESERVE_RE.search(a.get("href", ""))):
                col_ids[idx] = int(m.group(1))
                known[names[idx]] = int(m.group(1))

    resources = [(rid, n) for rid, n in zip(col_ids, names) if rid is not None]

    used = limit = None
    hours: list[int] = []
    cells: dict[tuple[int, int], Cell] = {}
    for tr in rows[1:]:
        tds = tr.find_all("td", recursive=False)
        if not tds:
            continue
        hm = _HOUR_RE.match(_text(tds[0]))
        if not hm:
            # “Reservations used this week: 7 out of 10”这一行；只取数字，语言无关
            nums = re.findall(r"\d+", " ".join(_text(td) for td in tds))
            if len(nums) >= 2 and used is None:
                used, limit = int(nums[0]), int(nums[1])
            continue
        hour = int(hm.group(1))
        hours.append(hour)
        for idx, td in enumerate(tds[1:]):
            if idx >= len(col_ids) or col_ids[idx] is None:
                continue
            rid = col_ids[idx]
            if td.find("a", class_="free"):
                cells[(hour, rid)] = Cell(FREE)
            elif (a := td.find("a", class_="myReservation")) is not None:
                cm = _CANCEL_RE.search(a.get("href", ""))
                cells[(hour, rid)] = Cell(MINE, int(cm.group(1)) if cm else None)
            elif td.find(class_="reserved"):
                cells[(hour, rid)] = Cell(RESERVED)
            else:
                cells[(hour, rid)] = Cell(UNAVAILABLE)

    return DaySchedule(service_id, day, resources, hours, cells, used, limit, min_date, max_date)


def parse_my_reservations(html: str, known: dict[int, dict[str, int]]) -> list[Reservation]:
    """解析侧栏的 YOUR RESERVATIONS。"""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for a in soup.select("ul.myReservations li a"):
        m = _SIDEBAR_RE.search(_text(a))
        sm = _TIMETABLE_RE.search(a.get("href", ""))
        if not m or not sm:
            continue
        sid = int(sm.group(1))
        name = m.group(4)
        out.append(Reservation(
            service_id=sid,
            service_name=m.group(5),
            day=_fi_date(m.group(1)),
            start_hour=int(m.group(2)),
            end_hour=int(m.group(3)),
            resource_name=name,
            resource_id=known.get(sid, {}).get(name),
        ))
    return out


def parse_user_name(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    a = soup.find("a", href=re.compile(r"/varaus/userprofile$"))
    return _text(a) if a else None


# 时间表缓存，按登录会话隔离：(cache_key, service_id, day) -> DaySchedule。
# 每个请求都会新建 HoasClient，所以缓存放在模块级；无服务器环境下实例被回收时缓存随之丢失，不影响正确性。
_CACHE: dict[tuple[str, int, date], DaySchedule] = {}
_CACHE_LOCK = threading.Lock()


def _cache_get(key) -> DaySchedule | None:
    with _CACHE_LOCK:
        s = _CACHE.get(key)
        if s and time.time() - s.fetched_at < config.SCHEDULE_CACHE_TTL:
            return s
        return None


def _cache_put(key, sched: DaySchedule) -> None:
    now = time.time()
    with _CACHE_LOCK:
        if len(_CACHE) > 2000:
            for k in [k for k, v in _CACHE.items() if now - v.fetched_at >= config.SCHEDULE_CACHE_TTL]:
                del _CACHE[k]
        _CACHE[key] = sched


class HoasClient:
    def __init__(self, cookies: list | None = None, user_name: str | None = None, cache_key: str | None = None):
        """cookies 是 export_cookies() 的返回值，用于还原之前登录的会话。
        cache_key 用于隔离不同登录会话的时间表缓存；为 None 时不使用缓存。"""
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        for name, value, domain, path in cookies or []:
            self.session.cookies.set(name, value, domain=domain, path=path)
        self.user_name = user_name
        self.cache_key = cache_key
        self.known = {sid: dict(m) for sid, m in config.KNOWN_RESOURCES.items()}
        self._lock = threading.Lock()

    def export_cookies(self) -> list:
        return sorted([c.name, c.value, c.domain, c.path] for c in self.session.cookies)

    # ---- HTTP ----

    def _get(self, path: str) -> requests.Response:
        r = self.session.get(config.BASE_URL + path, timeout=20)
        r.raise_for_status()
        if "/auth/login" in r.url:
            raise NotLoggedIn("登录已失效，请重新登录", code="session_expired")
        return r

    def login(self, username: str, password: str, remember: bool = True) -> str:
        r = self.session.get(config.BASE_URL + "/auth/login", timeout=20)
        r.raise_for_status()
        token = BeautifulSoup(r.text, "html.parser").find("input", {"name": "csrf_token_name"})
        if token is None:
            raise HoasError("登录页中找不到 CSRF token", code="site_changed")
        data = {
            "csrf_token_name": token["value"],
            "login": username,
            "password": password,
            "submit": "Kirjaudu",
        }
        if remember:
            data["remember"] = "1"
        r = self.session.post(config.BASE_URL + "/auth/login", data=data, timeout=20)
        r.raise_for_status()
        if "/auth/login" in r.url or "/auth/logout" not in r.text:
            raise LoginFailed("登录失败：用户名或密码错误")
        self.user_name = parse_user_name(r.text)
        return self.user_name or username

    def logout(self) -> None:
        try:
            self.session.get(config.BASE_URL + "/auth/logout", timeout=10)
        finally:
            self.session.cookies.clear()

    # ---- 时间表 ----

    def get_day(self, service_id: int, day: date | None = None, fresh: bool = False) -> DaySchedule:
        """获取某天的时间表；day 为 None 时返回站点默认（今天）的时间表。"""
        if day is not None and not fresh and self.cache_key:
            cached = _cache_get((self.cache_key, service_id, day))
            if cached:
                return cached
        path = f"/varaus/service/timetable/{service_id}"
        if day is not None:
            path += f"/{day.day:02d}/{day.month:02d}/{day.year}"
        r = self._get(path)
        with self._lock:
            sched = parse_timetable(r.text, service_id, self.known.setdefault(service_id, {}))
        if day is not None and sched.day != day:
            raise OutOfRange(f"{day.isoformat()} 不在可预约范围内", date=day.isoformat())
        if self.cache_key:
            _cache_put((self.cache_key, service_id, sched.day), sched)
        return sched

    def my_reservations(self) -> list[Reservation]:
        r = self._get(f"/varaus/service/timetable/{config.WASH_SERVICE_ID}")
        return parse_my_reservations(r.text, self.known)

    # ---- 预约 / 取消 ----

    def reserve(self, service_id: int, resource_id: int, day: date, hour: int) -> str:
        """预约一个时段，并重新拉取时间表来确认。返回该格子当前的状态（MINE 即成功）。"""
        self._get(f"/varaus/service/reserve/{resource_id}/{hour:02d}.00/{day.isoformat()}")
        return self.get_day(service_id, day, fresh=True).cell(hour, resource_id).status

    def cancel(self, service_id: int, resource_id: int, day: date, hour: int) -> bool:
        cell = self.get_day(service_id, day, fresh=True).cell(hour, resource_id)
        if cell.status != MINE or cell.cancel_id is None:
            raise HoasError("找不到这条预约（可能已经被取消）", code="reservation_not_found")
        self._get(f"/varaus/service/cancel/{cell.cancel_id}")
        return self.get_day(service_id, day, fresh=True).cell(hour, resource_id).status != MINE
