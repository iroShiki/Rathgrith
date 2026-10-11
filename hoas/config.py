"""站点和楼栋相关的常量。

洗衣房和烘干房的服务 ID 因楼栋而异：登录 booking.hoas.fi，打开洗衣房（或烘干房）页面，
网址 /varaus/service/timetable/{service_id} 中的数字就是 ID。用环境变量 HOAS_WASH_SERVICE_ID /
HOAS_DRY_SERVICE_ID 覆盖默认值即可用于其他楼栋。
"""
import os

BASE_URL = "https://booking-hoas.tampuuri.fi"

# 服务 ID：/varaus/service/timetable/{service_id}
WASH_SERVICE_ID = int(os.environ.get("HOAS_WASH_SERVICE_ID", 509))
DRY_SERVICE_ID = int(os.environ.get("HOAS_DRY_SERVICE_ID", 629))

# 资源名 -> 资源 ID 的兜底映射（只对默认楼栋有效）。正常情况下会从时间表里的预约链接自动学习，
# 这里只在某一列整天没有空位（因此页面上看不到 ID）时使用。
KNOWN_RESOURCES = {
    509: {"Washing machine 1": 318, "Washing machine 2": 319, "Washing machine 3": 1166},
    629: {"Dryer 1": 581, "Dryer 2": 582, "Dryer 3": 1167, "Dryer 4": 1168},
}

HOST = os.environ.get("HOAS_HOST", "127.0.0.1")
PORT = int(os.environ.get("HOAS_PORT", 8765))

# 时间表缓存的有效期（秒）。规划阶段反复调整冲突时不必每次都重新抓取。
SCHEDULE_CACHE_TTL = 120
# 并发抓取时间表的线程数，不要太大，以免给对方服务器造成压力。
FETCH_WORKERS = 4
