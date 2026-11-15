# 中文动作名补丁（zh-overlay）

本分支不是分叉：原版 openGym 每发一个 Release，`.github/workflows/zh-overlay.yml` 就从原版 tag 干净检出，
套上这里的补丁，测试通过后构建、签名并发布 APK（tag 形如 `v1.4.5+zh`）。

| 文件 | 作用 |
| --- | --- |
| `names-zh.json` | 按动作 ID 的简体中文名审校：`[原版旧名, 审校名]`。来自 daoshi818-crypto/openGym（AGPL-3.0-or-later）的动作名审校，见其 `docs/dev/EXERCISE_NAMES_ZH_CN_REVIEW.md` |
| `apply-names.mjs` | 把审校名写进 `catalogue/i18n/zh.json`，再跑原版的 `scripts/catalogue/build.mjs`。原版自己改过的名字先套术语规则，仍不同就保留原版，写进 `conflicts.json` |
| `apply.sh` | 补丁入口：动作名 + App 内更新改查本仓库（`UPDATE_REPO`，默认 `signalband/openGym`） |

本地试：在原版源码根目录放入本目录后运行 `sh scripts/zh-overlay/apply.sh`（只能在干净源码上运行一次）。

不再需要本补丁的条件：审校名被原版收录（需要审校作者本人向原版提交并签 CLA）。
