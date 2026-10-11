"""生成演示版静态网站（用于 GitHub Pages），输出到 _site/。

演示版和正式版用同一套前端，只是在 app.js 之前多加载 demo/demo.js，由它在浏览器里模拟后端。
不需要任何第三方依赖：python scripts/build_demo.py
本地预览：python -m http.server -d _site 8000，然后打开 http://localhost:8000/
"""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "hoas" / "static"
OUT = ROOT / "_site"

APP_TAG = '<script src="static/app.js"></script>'


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(STATIC, OUT / "static")
    shutil.copy2(ROOT / "demo" / "demo.js", OUT / "static" / "demo.js")

    html = (STATIC / "index.html").read_text(encoding="utf-8")
    if APP_TAG not in html:
        raise SystemExit(f"index.html 中找不到 {APP_TAG}")
    html = html.replace(APP_TAG, '<script src="static/demo.js"></script>\n  ' + APP_TAG)
    html = html.replace("<title>Rathgrith</title>", "<title>Rathgrith · Demo</title>")
    (OUT / "index.html").write_text(html, encoding="utf-8")
    (OUT / ".nojekyll").touch()   # 让 GitHub Pages 原样发布，不经过 Jekyll 处理
    print(f"Demo site written to {OUT}")


if __name__ == "__main__":
    main()
