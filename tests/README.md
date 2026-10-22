# 测试

这些脚本是开发期用的，不参与线上运行。

## 后端

```bash
# 1) 单元 + 出题全链路（本地假接口，不消耗真实 token）
php -S 127.0.0.1:8099 tests/mock-deepseek.php &
MOCK_BASE=http://127.0.0.1:8099 php tests/quiz-test.php

# 2) 解析失败自动重试（第一次返回散文，第二次返回 JSON）
php -S 127.0.0.1:8098 tests/mock-badfirst.php &
php tests/retry-test.php
```

覆盖内容：JSON 容错解析、题型/答案规范化、考点历史拼装与清洗、配置加解密（含权限与明文检查）、
统计聚合、出题全链路与 token 记账、解析失败重试。

`diag.php` 是排查工具，直接打真实接口并打印原始返回，需要自备 Key：

```bash
DEEPSEEK_KEY=sk-xxx MODEL=deepseek-chat THINKING=0 php tests/diag.php with
```

## 前端（无头浏览器）

需要本机安装 Edge 或 Chrome，并先启动一个被测实例：

```bash
php -S 127.0.0.1:8080 &          # 项目根目录
BASE_URL=http://127.0.0.1:8080/ node tests/cdp-quiz.js
```

- `cdp-quiz.js`：预出题队列、考点标签、判分、移动端布局
- `cdp-toggle.js`：做题页顶栏「预出」开关
- `cdp-quiz-check.js`：首页统计开关与页面跳转
- `real-flow.js`：真实 Key 跑一遍出题流程（`QUIZ_KEY=sk-xxx`）

截图默认写到 `tests/screenshots/`（已在 `.gitignore` 中忽略），可用 `SHOT_DIR` 覆盖。
