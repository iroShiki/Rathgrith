# HOAS 洗衣机预约 — 后端接口记录

抓取日期：2026-10-10

- 入口 `https://booking.hoas.fi` 会跳转到 **`https://booking-hoas.tampuuri.fi`**（Tampuuri 系统，CodeIgniter + jQuery）
- 服务端渲染 HTML，**没有 JSON API**。所有数据都需要解析 HTML，所有操作都是表单 POST 或 GET 链接
- 会话靠 Cookie 维持：`csrf_cookie_name`（可读）以及一个 HttpOnly 的会话 cookie（大概率是 CodeIgniter 默认的 `ci_session`）。用 `requests.Session()` 会自动处理

BASE = `https://booking-hoas.tampuuri.fi`

---

## 1. 登录

### 1.1 获取 CSRF token
```
GET /auth/login
```
从 HTML 中提取：`<input type="hidden" name="csrf_token_name" value="...">`
（响应同时会 Set-Cookie `csrf_cookie_name`，两个值是配对的）

### 1.2 提交登录
```
POST /auth/login
Content-Type: application/x-www-form-urlencoded

csrf_token_name=<上一步取得的值>
login=<用户名>
password=<密码>
remember=1          # 可选，“Muista minut”（记住我）
submit=Kirjaudu
```
成功后 302 跳转到 `/varaus/service/timetable/509/{DD}/{MM}/{YYYY}`（当天）。
判断是否登录成功：响应页面中包含 `/auth/logout` 链接，并且不再停留在 `/auth/login`。

### 1.3 登出
```
GET /auth/logout
```

---

## 2. 服务 / 资源 ID（示例楼栋，各楼栋不同）

| 服务 (service_id) | 说明 |
|---|---|
| `509` | Laundry, staircase B（洗衣房） |
| `629` | Dryers, staircase B（烘干机） |
| `353` | Saunas（桑拿） |

| 洗衣机 (resource_id) | 名称 |
|---|---|
| `318` | Washing machine 1 |
| `319` | Washing machine 2 |
| `1166` | Washing machine 3 |

| 烘干机 (resource_id) | 名称 |
|---|---|
| `581` | Dryer 1 |
| `582` | Dryer 2 |
| `1167` | Dryer 3 |
| `1168` | Dryer 4 |

所有设备的时段都是 08:00–22:00，每格 1 小时（最后一格从 21:00 开始）。

**每周限额：洗衣机和烘干机共用 10 次**（周一至周日，已实测：没有烘干预约的周，烘干页面同样显示 7/10）。

> 资源 ID 不能凭空猜，应以时间表页面中预约链接里的数字为准（见下文）。

---

## 3. 查询某天的时间表

```
GET /varaus/service/timetable/{service_id}/{DD}/{MM}/{YYYY}
例：GET /varaus/service/timetable/509/02/11/2026
```
- 加 `?ajax` 后返回同一页面（前端翻页时使用），对脚本来说没有区别，直接请求普通 URL 即可
- 页面内联脚本给出可预约的日期范围：
  ```js
  var minDate = '10.10.2026', maxDate = '30.11.2026';
  ```
  当天就是 maxDate 时，页面上的 `a.next` 的 `href="false"`
- 超出范围的日期（如 `/509/01/12/2026`）会被 302 重定向

### 时间表 HTML 结构
`div.js-timetable-slide > table.calendar`：
- 第一行：表头 `<h3>Washing machine N</h3>`
- 第二行：`Reservations used this week: 7 out of 10` ← **每周最多 10 次**
- 之后每行对应一个小时（08:00 起，每格 1 小时）。第一列是时间，其余各列对应各台洗衣机

单元格的几种状态：

| 状态 | HTML |
|---|---|
| 空闲 | `<a href="{BASE}/varaus/service/reserve/318/08.00/2026-11-02" class="free" data-resource="Laundry, staircase B: Washing machine 1" data-date="02.11.2026 08:00 - 09:00">Vacant</a>` |
| 被他人预约 | `<span class="reserved">Reserved</span>` |
| 自己的预约 | `<a href="{BASE}/varaus/service/cancel/12345678" class="myReservation" data-resource="..." data-date="11.10.2026 21:00 - 22:00">Your reservation</a>` |
| 已过去 / 不可用 | 空单元格 |

---

## 4. 预约（关键接口）

```
GET /varaus/service/reserve/{resource_id}/{HH.MM}/{YYYY-MM-DD}
例：GET /varaus/service/reserve/319/21.00/2026-11-02
```
- 注意时间格式是 `21.00`（点号分隔），日期格式是 `YYYY-MM-DD`
- 网页上点 Vacant 会弹出 tooltip，再点确认对话框的“Yes”，之后执行的就是 `window.location.href = 该链接`，**没有额外参数，也没有 CSRF token**
- 也就是说，只要带着已登录的 cookie 发一个 GET 请求就能完成预约
- **响应（已实测）**：302 → `/varaus/service/timetable/{service_id}/{DD}/{MM}/{YYYY}`，页面上**没有任何成功或失败提示**。
  对已经是自己的时段重复预约，同样是静默重定向。
  → **判断结果的唯一办法是重新拉取当天时间表**：目标格子变成 `a.myReservation` 即成功；
  变成 `span.reserved` 说明被别人抢先；仍然是 `a.free` 说明站点没有接受（超出周限额或尚未开放）。

## 5. 取消预约

```
GET /varaus/service/cancel/{reservation_id}
```
`reservation_id` 只出现在时间表中自己格子的 `a.myReservation` 链接里（侧栏 YOUR RESERVATIONS 只链接到当天的时间表）。
响应同样是 302 回到时间表，没有提示；已实测，取消后配额会立即恢复。
规则：可以随时取消，但离开始时间不足 12 小时的取消仍计入当周次数。

---

## 6. 其他

| 接口 | 说明 |
|---|---|
| `GET /varaus/service/timetable/509` | 不带日期时默认显示当天 |
| 首页侧栏 `YOUR RESERVATIONS` | 列出自己全部的未来预约（`a.washer`，文本形如 `Sat 10.10.2026 20:00 - 21:00 Washing machine 2 - Laundry, staircase B`） |
| `GET /varaus/export/calendar/personal_feed/{user_id}/en/{token}` | 个人预约的 .ics 日历订阅 |
| `GET /varaus/messages` | 公告（如某台洗衣机停用） |

## 7. 开放规则（网站原文）

> The next month is reservable starting at 00.00 on the first day of the previous month.

即**每月 1 日 00:00（芬兰时间）开放下下个月**，例如 10 月 1 日开放 11 月整月。今天（10-10）的 maxDate 是 30.11.2026，与此一致。
这和“上个月最后一周开放”的说法不同。写定时任务时建议以 maxDate 为准，自动探测是否已开放。

## 待确认
- [x] `reserve` 接口的响应：见第 4 节，只能通过重新拉取时间表来判断
- [ ] 超出周限额时站点的具体行为（目前按“格子仍然空闲”处理）
- [ ] 登录失败时页面的提示文本（目前按“仍停留在 /auth/login”判断）
