# hub-bridge：让外部健康中枢往 openGym 里记训练

一个只在内网监听的小 HTTP 服务。健康中枢（例如接了 Grok 的 MCP 服务）把「人话」训练交给它，它在 openGym 自己的动作库里认动作、换算单位，再像手机 App 一样通过服务端的同步接口写入。手机 App 连着同一台服务器，打开就能看到。

```
AI 助手 → 健康中枢 MCP → hub-bridge → openGym 服务端 /api/data ← 手机 App（配对一次）
```

## 为什么这样做

- **不改 App**：用 App 自带的「连接我的服务器」，二创版和原版都能用。
- **不绕过同步**：写入走 `GET /api/data` → 改 → `PUT /api/data`（带 `baseRev`）。中间手机写过就重读重试，服务端负责给外部写入方打时间戳，手机之后的合并不会把它撤回。
- **复用 App 的纯函数**：动作库、简体中文名、用户别名（`S.exAliases`）、`convertWeight`、组的结构都来自 `frontend/src/lib`，认出来的动作和换算结果与 App 里一致。

## 接口

全部需要 `Authorization: Bearer $BRIDGE_TOKEN`（`/health` 除外）。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 存活与是否已配对 |
| GET | `/v1/exercises?q=坐姿划船` | 搜动作，返回 id、中英文名、部位、器械 |
| GET | `/v1/summary?limit=5` | 最近训练与全部计划 |
| POST | `/v1/workouts` | 记一次已完成的训练 |
| POST | `/v1/routines` | 新建一个训练计划 |

写入是两步的：默认 `dryRun: true`，只返回预览；本人确认后同一请求带 `dryRun: false` 才写。`requestId` 决定条目 id，同一请求重发返回 `already_saved`，不会多一条。

训练：

```json
{
  "requestId": "grok-msg-123",
  "at": "2026-11-12T19:30:00+08:00",
  "durationMin": 50,
  "name": "背 + 肩",
  "exercises": [
    { "exercise": "坐姿划船", "sets": [{ "reps": 12, "weight": 80, "unit": "lb", "count": 4 }] },
    { "exercise": "哑铃推肩", "sets": [{ "reps": 12, "weight": 2.5, "unit": "kg", "count": 4 }] }
  ],
  "dryRun": true
}
```

计划：`{ requestId, name, exercises: [{ exercise | exerciseId, sets, reps, weight?, unit?, restSec? }], dryRun }`。

### 认动作

只有 id、中文名、英文名或本人别名规范化后完全相同才直接采用（本人别名优先于动作库同名动作）。其余返回：

```json
{ "status": "needs_choice", "unresolved": [{ "input": "坐姿划船", "candidates": [{ "id": "1235", "name": "器械单臂坐姿划船(坐姿划船机)", "nameEn": "lever one arm seated row (seated row machine)", "bodyPart": "back", "equipment": "leverage machine" }] }] }
```

什么都不写。给本人看候选，选定后对那个动作补 `exerciseId` 和 `remember: true` 重发；写入成功后这个叫法记成 App 里的动作别名，下次直接认出，App 里搜索也能用上。

### 单位

每组可以各写各的单位（健身房器械 kg、lb 混着标），也可以在请求级写一次 `unit`。写了重量没写单位返回 `unit_required`，不猜。重量换算成档案单位（kg 取到 0.25、lb 取到 0.5，与 App 切换单位一致），预览里 `entered` 保留原值。

## 部署

见 `compose.example.yml`。首次配对：

1. 用密码登录在服务端生成一个配对码（`POST /api/pair/create`，要当前密码）。
2. 在 `private/bridge.env` 里临时加 `OPENGYM_PAIR_CODE=…`，启动 bridge；令牌写进 `/data/token.json` 后删掉这一行。
3. 令牌默认 90 天，bridge 每天问一次 `/api/me`，过半有效期自动换新。

## 测试

```bash
cd hub-bridge && node --test test/      # 单元测试 + 起真服务端的联调（需要先 cd api && npm ci）
```
