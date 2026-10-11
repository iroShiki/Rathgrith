"""每个浏览器各自的登录状态。

登录后，HOAS 的会话 cookie 会被加密存进访问者自己浏览器的 cookie（HttpOnly）里，服务端不保存任何登录状态。
这样部署到 Vercel 之类的公网或无服务器环境时，不同访问者之间互不影响，也不依赖进程内存
（无服务器实例随时可能被回收，也可能同时存在多个实例）。

加密密钥来自环境变量 HOAS_SECRET_KEY。本地运行时如果没有设置，每次启动会随机生成一个，重启后需要重新登录。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets

from cryptography.fernet import Fernet, InvalidToken

COOKIE_NAME = "hoas_auth"
MAX_AGE = 30 * 24 * 3600   # “记住我”时浏览器 cookie 的有效期


def _load_key() -> bytes:
    secret = os.environ.get("HOAS_SECRET_KEY")
    if not secret:
        if os.environ.get("VERCEL"):
            raise RuntimeError("部署环境必须设置环境变量 HOAS_SECRET_KEY（任意足够长的随机字符串）")
        secret = secrets.token_urlsafe(32)
    return base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())


_fernet = Fernet(_load_key())


def encode(state: dict) -> str:
    return _fernet.encrypt(json.dumps(state, separators=(",", ":")).encode()).decode()


def decode(token: str | None) -> dict | None:
    """解密 cookie；cookie 不存在、被篡改、换过密钥或已超过有效期时返回 None。"""
    if not token:
        return None
    try:
        return json.loads(_fernet.decrypt(token.encode(), ttl=MAX_AGE))
    except (InvalidToken, ValueError):
        return None


def new_session_id() -> str:
    return secrets.token_urlsafe(16)
