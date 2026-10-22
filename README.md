# DeepSeek Quiz · AI 出题练习

> **本项目全部由 AI 生成**：页面、后端、样式、文档与测试均由 AI 编程助手（DeepSeek Harness 上的编码模型）生成并多轮迭代，人类只提供需求描述与验收反馈。代码未经人工逐行审查，请自行评估后再用于正式环境。

一个可以自己部署的刷题网页：选好科目和考试范围，调用 DeepSeek 即时生成单选题 / 多选题，做完立刻判分、给解析，并把题量、token 消耗、正确率记录下来。

纯 PHP + 原生 JS，无框架、无构建步骤，丢到任何支持 PHP 8.1+ 的空间就能跑。

## 特性

- **按范围出题**：五个科目（英语 / 数学 / 物理 / 化学 / 生物）+ 一句话自然语言范围，题目严格围绕范围生成。
- **单选 / 多选**：由模型自行决定题型，前端自动适配（单选互斥、多选可多选）。
- **即时判分**：选完点「完成」立刻判对错，标出正确选项、给出解析，答错会标红你选的项。
- **考点去重**：每道题附带「考点」，最近 10 题的考点会随请求带给模型，避免连续重复出同一知识点的换皮题。
- **预出题队列**：可提前生成 0–10 道题排队，答完一题即时出下一题、后台自动补一题；做题页右上角还能随时开关。
- **API 配置加密保存**：DeepSeek API Key 用「密码 → PBKDF2 → AES-256-GCM」加密存在服务端，只有密码能解开；也支持随时读取配置。
- **统计**：今日 / 本周 / 累计的题数、token 消耗、正确率，以及各科目明细。
- **深浅色主题**：Material 3 设计令牌，跟随系统或手动切换，手机 / 电脑自适应。

## 界面流程

```
首页（统计概览）
  └─ 进入做题
       ├─ 第 1 步：API 配置（Key / 模型 / 深度思考 / 密码保存或读取）
       ├─ 第 2 步：科目 + 考试范围 + 预出题数量
       └─ 做题页：题目 → 选项 → 完成 → 判分 + 解析 → 下一题 …（右上角「结束」回首页）
```

## 快速开始

需要 PHP 8.1+，且装有 `curl`、`openssl`、`json`、`mbstring`、`pdo_sqlite` 扩展。

```bash
git clone <this-repo> quiz
cd quiz
php -S 127.0.0.1:8080          # 本地预览
```

打开 <http://127.0.0.1:8080>，进「做题 → API 配置」填自己的 DeepSeek API Key（在
<https://platform.deepseek.com> 创建），选择模型、设置一个配置密码并保存，然后下一步选科目与范围即可。

> 用 `php -S` 时数据会写到项目内的 `data/` 目录，够本地试用；正式部署请按下一节把数据目录放到 web 根之外。

## 部署

### 1. 放置文件

把整个项目放到站点目录，例如 `/var/www/html/quiz/`，保证 `index.html`、`api.php`、`assets/` 同级。

### 2. 数据目录

默认写到项目内的 `data/`，**这个目录不能被浏览器访问**。两种做法任选：

**推荐：放到 web 根之外**（改 `config.php`，见下节）

```bash
mkdir -p /var/lib/quiz && chown www-data:www-data /var/lib/quiz && chmod 700 /var/lib/quiz
```

```php
// config.php
<?php
define('DATA_DIR', '/var/lib/quiz');
```

**或者：留在项目内**，用服务器配置挡住：

nginx：

```nginx
location ^~ /quiz/data/ { deny all; return 404; }
location = /quiz/config.php { deny all; return 404; }
```

Apache：项目已自带 `data/.htaccess`（`Require all denied`），确认 `AllowOverride` 已开启即可。

### 3. Nginx 示例

```nginx
server {
    listen 80;
    server_name quiz.example.com;
    root /var/www/html/quiz;
    index index.html;

    location / { try_files $uri $uri/ =404; }

    location ~ \.php$ {
        include fastcgi_params;
        fastcgi_pass unix:/run/php/php8.2-fpm.sock;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout 300s;          # 深度思考模型较慢
    }
}
```

深度思考（`deepseek-reasoner`）单次可能要几十秒，PHP-FPM 的 `request_terminate_timeout`
建议不低于 180s，否则请求会被中断。

### 4. 权限

```bash
chown -R www-data:www-data /var/www/html/quiz
chmod 700 /var/lib/quiz     # 或项目内 data/
```

## 配置

优先级：`config.php` > 环境变量 > 默认值。

| 配置项 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `DATA_DIR` | `QUIZ_DATA_DIR` | `<项目>/data` | 配置与统计数据库所在目录 |
| `API_BASE` | `DEEPSEEK_BASE` | `https://api.deepseek.com` | 可指向兼容 OpenAI 协议的自建网关 |
| 时区 | `QUIZ_TZ` | `Asia/Shanghai` | 影响「今日 / 本周」的切分 |

`config.php` 已在 `.gitignore` 中，不会被提交：

```php
<?php
define('DATA_DIR', '/var/lib/quiz');
// define('API_BASE', 'https://api.deepseek.com');
```

## 接口

所有接口都是 `POST api.php?action=<name>`，请求与响应均为 JSON。

| action | 入参 | 说明 |
|---|---|---|
| `ping` | — | 健康检查 |
| `models` | `apiKey` | 代理 DeepSeek `/models`，返回可用模型 id |
| `config_save` | `password` `apiKey` `model` `thinking` | 加密保存配置（密码 ≥ 4 位） |
| `config_load` | `password` | 解密读取配置，密码错误返回 403 |
| `config_status` | — | 是否已保存过配置 |
| `generate` | `apiKey` `model` `thinking` `subject` `scope` `history[]` | 生成一道题 |
| `answer` | `subject` `correct` | 记录一次作答 |
| `stats` | — | 今日 / 本周 / 累计统计与分科目明细 |

`generate` 返回：

```json
{
  "ok": true,
  "question": {
    "type": "single|multiple",
    "knowledge": "考点",
    "stem": "题干",
    "options": [{ "key": "A", "text": "..." }],
    "answer": ["A"],
    "explanation": "解析"
  },
  "meta": { "model": "deepseek-chat", "tokensIn": 812, "tokensOut": 305, "elapsedMs": 4200 }
}
```

## 安全说明

- **API Key 不会下发到浏览器持久存储**：前端只在 `sessionStorage` 里暂存，跨请求由浏览器随 POST body 交给后端代理。
- **落盘加密**：`config.json` 用用户密码派生的密钥加密（PBKDF2-SHA256，12 万轮，AES-256-GCM），密码本身只存 `password_hash`。
- **建议上 HTTPS**：如果用 HTTP，Key 在传输链路上是明文。
- **数据目录务必拒绝 web 访问**（见「部署」）。
- 出题失败会自动重试一次；仍失败时会把模型原始返回写入 `DATA_DIR/debug.log`（0600，不含 Key），便于排查。

## 目录结构

```
.
├── index.html          # 单页应用：首页 / 配置 / 科目 / 做题
├── api.php             # 后端：代理、加密、出题、统计
├── config.example.php  # 复制成 config.php 后可覆盖路径等配置
├── assets/
│   ├── theme.css       # Material 3 设计令牌
│   ├── quiz.css        # 页面样式
│   └── quiz.js         # 前端逻辑（预出题队列、考点历史、判分、统计）
├── data/               # 默认数据目录（含 .htaccess，Web 不可读）
└── tests/              # 自动化测试（PHP + 无头浏览器）
```

## 测试

```bash
# 后端单元测试 + 出题全链路（用本地 mock，不消耗真实 token）
php -S 127.0.0.1:8099 tests/mock-deepseek.php &   # 假 DeepSeek
MOCK_BASE=http://127.0.0.1:8099 php tests/quiz-test.php

# 解析失败自动重试
php -S 127.0.0.1:8098 tests/mock-badfirst.php &
php tests/retry-test.php
```

前端走查脚本在 `tests/` 里（依赖本机 Edge/Chrome），通过 `BASE_URL` 指定被测地址：

```bash
BASE_URL=http://127.0.0.1:8080 node tests/cdp-quiz.js
```

## 关于本项目

- **全部由 AI 生成**：前后端代码、样式、测试脚本和这份文档都是 AI 在对话中直接产出的，没有手工编写或逐行 review。
- 因此代码更偏向「能跑通、结构清晰」，但**不保证没有安全漏洞或边界问题**；用于生产前请自行审查（尤其是鉴权、密钥管理、并发与异常处理）。
- 功能与交互按实际使用反馈迭代过多轮（考点去重、预出题队列、判分、统计等），但仍是个人练手级别的项目，不提供任何担保。
- 欢迎 issue / PR；由于作者同样是「非人类」，请不要默认这里存在一个能及时响应的维护者。
## License

[MIT](LICENSE)
