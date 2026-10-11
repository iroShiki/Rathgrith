"""每个浏览器各自登录、互不影响（不访问真实站点）。"""
import pytest

from hoas import auth, server
from hoas.client import HoasClient, LoginFailed


@pytest.fixture(autouse=True)
def fake_hoas(monkeypatch):
    def login(self, username, password, remember=True):
        if password != "pw":
            raise LoginFailed("登录失败")
        self.session.cookies.set("ci_session", "secret-" + username, domain="booking-hoas.tampuuri.fi", path="/")
        self.user_name = username
        return username

    monkeypatch.setattr(HoasClient, "login", login)
    monkeypatch.setattr(HoasClient, "logout", lambda self: self.session.cookies.clear())


def browser():
    return server.app.test_client()


def login(c, user="alice", pw="pw"):
    return c.post("/api/login", json={"username": user, "password": pw})


def test_login_does_not_leak_to_other_browsers():
    a, b = browser(), browser()
    assert login(a).status_code == 200
    assert a.get("/api/me").json == {"logged_in": True, "user": "alice"}
    assert b.get("/api/me").json == {"logged_in": False}
    assert b.get("/api/overview").status_code == 401
    assert b.post("/api/reserve", json={"service_id": 509, "resource_id": 318,
                                        "date": "2026-11-02", "hour": 8}).status_code == 401


def test_two_users_stay_separate():
    a, b = browser(), browser()
    login(a, "alice")
    login(b, "bob")
    assert a.get("/api/me").json["user"] == "alice"
    assert b.get("/api/me").json["user"] == "bob"


def test_cookie_is_encrypted_and_httponly():
    r = login(browser())
    set_cookie = r.headers["Set-Cookie"]
    assert set_cookie.startswith(auth.COOKIE_NAME + "=")
    assert "HttpOnly" in set_cookie and "SameSite=Lax" in set_cookie
    assert "secret-alice" not in set_cookie


def test_state_carries_hoas_session():
    a = browser()
    login(a)
    state = auth.decode(a.get_cookie(auth.COOKIE_NAME).value)
    assert ["ci_session", "secret-alice", "booking-hoas.tampuuri.fi", "/"] in state["cookies"]
    restored = HoasClient(state["cookies"])
    assert restored.session.cookies.get("ci_session") == "secret-alice"


def test_tampered_cookie_is_rejected():
    c = browser()
    c.set_cookie(auth.COOKIE_NAME, "not-a-valid-token")
    assert c.get("/api/me").json == {"logged_in": False}


def test_logout_clears_cookie():
    a = browser()
    login(a)
    a.post("/api/logout", json={})
    assert a.get_cookie(auth.COOKIE_NAME) is None
    assert a.get("/api/me").json == {"logged_in": False}


def test_wrong_password_sets_no_cookie():
    c = browser()
    r = login(c, pw="wrong")
    assert r.status_code == 401
    assert r.json["code"] == "login_failed"
    assert c.get_cookie(auth.COOKIE_NAME) is None


def test_errors_carry_codes_for_translation():
    c = browser()
    assert c.get("/api/overview").json["code"] == "not_logged_in"
    assert c.post("/api/login", json={"username": "", "password": ""}).json["code"] == "missing_credentials"
    login(c)
    assert c.post("/api/plan", json={"dates": [], "wash_hour": 21, "washers": [318]}).json["code"] == "no_dates"


def test_non_json_post_is_rejected():
    # 跨站表单只能发 form/text 类型的请求；只接受 JSON 可以挡住这类 CSRF
    a = browser()
    login(a)
    r = a.post("/api/cancel", data={"service_id": "509"})
    assert r.status_code == 415
