#!/bin/sh
# 在一份干净的原版源码上套中文补丁（CI 和本地都用它）：
#   1. 动作中文名（apply-names.mjs，含重新生成 App 数据）
#   2. App 内更新改查我们的 Release（原版写死查 DuarteSantos8/openGym，签名不同装不上）
# 任何一步对不上原版代码就失败，宁可不出包也不出错包。
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
UPDATE_REPO=${UPDATE_REPO:-signalband/openGym}
node "$ROOT/scripts/zh-overlay/apply-names.mjs"
F="$ROOT/frontend/src/lib/update.js"
grep -q "^const REPO = 'DuarteSantos8/openGym'$" "$F" || { echo "update.js: REPO line not found, upstream changed it" >&2; exit 1; }
sed -i.bak "s#^const REPO = 'DuarteSantos8/openGym'\$#const REPO = '$UPDATE_REPO'#" "$F" && rm -f "$F.bak"
grep -n "^const REPO" "$F"
# 原版测试断言的是官方仓库的 API 地址，跟着改。
T="$ROOT/frontend/src/lib/update.test.js"
grep -q "api.github.com/repos/DuarteSantos8/openGym/releases/latest" "$T" || { echo "update.test.js: expected URL not found" >&2; exit 1; }
sed -i.bak "s#api.github.com/repos/DuarteSantos8/openGym/releases/latest#api.github.com/repos/$UPDATE_REPO/releases/latest#" "$T" && rm -f "$T.bak"
