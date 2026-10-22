<?php
/**
 * DeepSeek Quiz —— 后端接口
 *
 *  - DeepSeek API 代理（浏览器直连会被 CORS 拦，也避免把 Key 暴露在请求日志里）
 *  - 配置加密存取（PBKDF2 派生密钥 + AES-256-GCM）
 *  - 题量 / token / 正确率统计（SQLite）
 *
 * 默认数据目录：与本文件同级的 data/（可用环境变量 QUIZ_DATA_DIR 或 config.php 覆盖）
 * 生产环境建议把数据目录放到 web 根之外，见 README 的「部署」一节。
 */
declare(strict_types=1);

date_default_timezone_set(getenv('QUIZ_TZ') ?: 'Asia/Shanghai');
umask(0077);   // 数据文件默认仅属主可读写

// 可选的本地配置（已在 .gitignore 中忽略，不会被提交）
if (is_file(__DIR__ . '/config.php')) {
    require __DIR__ . '/config.php';
}

if (!defined('DATA_DIR')) {
    define('DATA_DIR', rtrim(getenv('QUIZ_DATA_DIR') ?: (__DIR__ . '/data'), '/'));
}
if (!defined('CONFIG_FILE')) define('CONFIG_FILE', DATA_DIR . '/config.json');
if (!defined('DB_FILE'))     define('DB_FILE', DATA_DIR . '/usage.sqlite');
if (!defined('API_BASE'))    define('API_BASE', rtrim(getenv('DEEPSEEK_BASE') ?: 'https://api.deepseek.com', '/'));
const SUBJECTS = ['英语', '数学', '物理', '化学', '生物'];

/* ------------------------------------------------------------------ 基础 */

function send_json(array $data, int $code = 200): never
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $code = 400): never
{
    send_json(['ok' => false, 'error' => $message], $code);
}

function body(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function field(array $src, string $key, string $default = ''): string
{
    $v = $src[$key] ?? $default;
    return is_string($v) ? trim($v) : $default;
}

function ensure_data_dir(): void
{
    if (!is_dir(DATA_DIR) && !mkdir(DATA_DIR, 0700, true) && !is_dir(DATA_DIR)) {
        fail('数据目录不可用', 500);
    }
    @chmod(DATA_DIR, 0700);
}

/* ------------------------------------------------------------------ HTTP */

function deepseek(string $method, string $path, string $apiKey, ?array $payload = null): array
{
    $ch = curl_init(API_BASE . $path);
    $headers = [
        'Authorization: Bearer ' . $apiKey,
        'Content-Type: application/json',
        'Accept: application/json',
    ];

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT        => 150,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    if ($payload !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE));
    }

    $raw  = curl_exec($ch);
    $err  = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($raw === false) {
        fail('连接 DeepSeek 失败：' . ($err ?: 'network error'), 502);
    }

    $json = json_decode((string) $raw, true);
    if ($code >= 400) {
        $msg = $json['error']['message'] ?? ('HTTP ' . $code);
        fail('DeepSeek 接口错误：' . $msg, $code === 401 ? 401 : 502);
    }
    if (!is_array($json)) {
        fail('DeepSeek 返回了非 JSON 内容', 502);
    }
    return $json;
}

/* ------------------------------------------------------------------ 配置 */

function pbkdf2_key(string $password, string $salt): string
{
    return hash_pbkdf2('sha256', $password, $salt, 120000, 32, true);
}

function config_save(string $password, string $apiKey, string $model, bool $thinking): array
{
    ensure_data_dir();
    if (mb_strlen($password) < 4) fail('密码至少 4 位');
    if (strlen($apiKey) < 10) fail('API Key 看起来不合法');

    $salt  = random_bytes(16);
    $nonce = random_bytes(12);
    $key   = pbkdf2_key($password, $salt);
    $plain = json_encode(['apiKey' => $apiKey, 'model' => $model, 'thinking' => $thinking], JSON_UNESCAPED_UNICODE);

    $cipher = openssl_encrypt($plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $nonce, $tag);
    if ($cipher === false) fail('加密失败', 500);

    $doc = [
        'v'      => 1,
        'salt'   => base64_encode($salt),
        'nonce'  => base64_encode($nonce),
        'tag'    => base64_encode($tag),
        'hash'   => password_hash($password, PASSWORD_DEFAULT),
        'cipher' => base64_encode($cipher),
        'saved'  => time(),
    ];

    $tmp = CONFIG_FILE . '.tmp';
    if (file_put_contents($tmp, json_encode($doc), LOCK_EX) === false) fail('写入配置失败', 500);
    @chmod($tmp, 0600);
    if (!rename($tmp, CONFIG_FILE)) fail('写入配置失败', 500);

    return ['saved' => true, 'updated' => time()];
}

function config_load(string $password): array
{
    if (!is_file(CONFIG_FILE)) fail('还没有保存过配置', 404);
    $doc = json_decode((string) file_get_contents(CONFIG_FILE), true);
    if (!is_array($doc)) fail('配置文件损坏', 500);
    if (!password_verify($password, (string) ($doc['hash'] ?? ''))) fail('密码错误', 403);

    $salt   = base64_decode((string) $doc['salt'], true);
    $nonce  = base64_decode((string) $doc['nonce'], true);
    $tag    = base64_decode((string) $doc['tag'], true);
    $cipher = base64_decode((string) $doc['cipher'], true);
    if ($salt === false || $nonce === false || $tag === false || $cipher === false) fail('配置数据损坏', 500);

    $plain = openssl_decrypt($cipher, 'aes-256-gcm', pbkdf2_key($password, $salt), OPENSSL_RAW_DATA, $nonce, $tag);
    if ($plain === false) fail('解密失败', 500);

    $cfg = json_decode($plain, true) ?: [];
    return [
        'apiKey'   => (string) ($cfg['apiKey'] ?? ''),
        'model'    => (string) ($cfg['model'] ?? 'deepseek-chat'),
        'thinking' => (bool) ($cfg['thinking'] ?? false),
        'updated'  => (int) ($doc['saved'] ?? 0),
    ];
}

/* ------------------------------------------------------------------ 统计 */

function db(): PDO
{
    ensure_data_dir();
    $pdo = new PDO('sqlite:' . DB_FILE, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    @chmod(DB_FILE, 0600);
    $pdo->exec('PRAGMA journal_mode=WAL');
    $pdo->exec('PRAGMA busy_timeout=4000');
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            day TEXT NOT NULL,
            kind TEXT NOT NULL,
            subject TEXT NOT NULL DEFAULT "",
            model TEXT NOT NULL DEFAULT "",
            tokens_in INTEGER NOT NULL DEFAULT 0,
            tokens_out INTEGER NOT NULL DEFAULT 0,
            correct INTEGER
        )'
    );
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day)');
    return $pdo;
}

function record_gen(string $subject, string $model, int $in, int $out): void
{
    $pdo = db();
    $st = $pdo->prepare('INSERT INTO usage (ts, day, kind, subject, model, tokens_in, tokens_out) VALUES (?,?,?,?,?,?,?)');
    $st->execute([time(), date('Y-m-d'), 'gen', $subject, $model, $in, $out]);
}

function record_ans(string $subject, bool $correct): void
{
    $pdo = db();
    $st = $pdo->prepare('INSERT INTO usage (ts, day, kind, subject, correct) VALUES (?,?,?,?,?)');
    $st->execute([time(), date('Y-m-d'), 'ans', $subject, $correct ? 1 : 0]);
}

function week_start(): string
{
    $dow = (int) date('N');           // 1=周一
    return date('Y-m-d', strtotime('-' . ($dow - 1) . ' days'));
}

function stats(): array
{
    $pdo = db();
    $today = date('Y-m-d');
    $week  = week_start();

    $sum = function (string $where, array $args) use ($pdo): array {
        $sql = "SELECT
                    COALESCE(SUM(CASE WHEN kind='gen' THEN tokens_in + tokens_out ELSE 0 END), 0) AS tokens,
                    SUM(CASE WHEN kind='gen' THEN 1 ELSE 0 END) AS questions,
                    SUM(CASE WHEN kind='ans' THEN 1 ELSE 0 END) AS answers,
                    SUM(CASE WHEN kind='ans' AND correct = 1 THEN 1 ELSE 0 END) AS correct
                FROM usage WHERE $where";
        $st = $pdo->prepare($sql);
        $st->execute($args);
        $r = $st->fetch() ?: [];
        return [
            'tokens'    => (int) ($r['tokens'] ?? 0),
            'questions' => (int) ($r['questions'] ?? 0),
            'answers'   => (int) ($r['answers'] ?? 0),
            'correct'   => (int) ($r['correct'] ?? 0),
        ];
    };

    $out = [
        'ok'    => true,
        'today' => $sum('day >= :d', [':d' => $today]),
        'week'  => $sum('day >= :w', [':w' => $week]),
        'total' => $sum('1 = 1', []),
        'subjects' => [],
        'weekStart' => $week,
    ];

    $rows = $pdo->query(
        "SELECT subject,
                SUM(CASE WHEN kind='gen' THEN 1 ELSE 0 END) AS questions,
                SUM(CASE WHEN kind='gen' THEN tokens_in + tokens_out ELSE 0 END) AS tokens,
                SUM(CASE WHEN kind='gen' AND day >= '$today' THEN 1 ELSE 0 END) AS q_today,
                SUM(CASE WHEN kind='gen' AND day >= '$week'  THEN 1 ELSE 0 END) AS q_week,
                SUM(CASE WHEN kind='ans' THEN 1 ELSE 0 END) AS answers,
                SUM(CASE WHEN kind='ans' AND day >= '$today' THEN 1 ELSE 0 END) AS a_today,
                SUM(CASE WHEN kind='ans' AND day >= '$week'  THEN 1 ELSE 0 END) AS a_week,
                SUM(CASE WHEN kind='ans' AND correct = 1 THEN 1 ELSE 0 END) AS correct
         FROM usage GROUP BY subject ORDER BY answers DESC, questions DESC"
    )->fetchAll();

    foreach ($rows as $r) {
        if ((string) $r['subject'] === '') continue;
        $out['subjects'][] = [
            'subject'   => $r['subject'],
            'questions' => (int) $r['questions'],
            'tokens'    => (int) $r['tokens'],
            'today'     => (int) $r['q_today'],
            'week'      => (int) $r['q_week'],
            'answers'   => (int) $r['answers'],
            'answeredToday' => (int) $r['a_today'],
            'answeredWeek'  => (int) $r['a_week'],
            'correct'   => (int) $r['correct'],
        ];
    }
    return $out;
}

/* ------------------------------------------------------------------ 出题 */

function resolve_model(string $model, bool $thinking): string
{
    $model = $model !== '' ? $model : 'deepseek-chat';
    if ($thinking) {
        return 'deepseek-reasoner';
    }
    return stripos($model, 'reasoner') !== false ? 'deepseek-chat' : $model;
}

function build_prompt(string $subject, string $scope, array $history = []): array
{
    $sys = '你是一位资深命题老师，负责按给定的科目和考试范围命制高质量选择题。'
        . '你只输出 JSON 对象，不输出任何解释文字或 Markdown 代码块。';

    $avoid = '';
    if ($history) {
        $lines = [];
        foreach ($history as $h) {
            $k = trim((string) ($h['knowledge'] ?? ''));
            $s = trim((string) ($h['stem'] ?? ''));
            if ($s !== '' && mb_strlen($s) > 70) $s = mb_substr($s, 0, 70) . '…';
            $line = '- ' . ($k !== '' ? '考点：' . $k : '考点：未标注');
            if ($s !== '') $line .= '；题干：' . $s;
            $lines[] = $line;
        }
        $avoid = "下面这些题目已经出过，请务必避开相同考点，也不要出同一考点的“换皮题”：\n"
            . implode("\n", $lines) . "\n\n";
    }

    $user = "科目：{$subject}\n"
        . "考试范围：{$scope}\n\n"
        . $avoid
        . "请命制 1 道题目，要求：\n"
        . "0. 必须与上面已考考点不重复；在范围内优先覆盖还没考到的知识点。\n"
        . "1. 题型由你判断（单选题或多选题均可，多选题至少 2 个正确选项）。\n"
        . "2. 恰好 4 个选项，标号为 A、B、C、D，选项之间不能互相包含。\n"
        . "3. 难度中等偏上，考查对概念和方法的理解，避免死记硬背和超纲内容。\n"
        . "4. 数学公式必须用纯文本或 Unicode 表示（例如 x²、√3、≤、∫、π、sin x），禁止使用 LaTeX 或 $ 符号。\n"
        . "5. 英语科目用英文题干和选项，其余科目用中文。\n"
        . "6. 解释控制在 120 字以内，说明关键步骤。\n\n"
        . '严格按此 JSON 结构输出：'
        . '{"type":"single 或 multiple","knowledge":"本题考点（不超过 15 字）","stem":"题干","options":[{"key":"A","text":"..."},'
        . '{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}],'
        . '"answer":["A"],"explanation":"解析"}';

    return [
        ['role' => 'system', 'content' => $sys],
        ['role' => 'user', 'content' => $user],
    ];
}

/** 限制前端传来的历史题目长度，避免 prompt 被撑爆 */
function sanitize_history(mixed $raw): array
{
    if (!is_array($raw)) return [];
    $out = [];
    foreach ($raw as $h) {
        if (!is_array($h)) continue;
        $out[] = [
            'knowledge' => mb_substr(trim((string) ($h['knowledge'] ?? '')), 0, 40),
            'stem'      => mb_substr(trim((string) ($h['stem'] ?? '')), 0, 120),
        ];
        if (count($out) >= 12) break;
    }
    return $out;
}

/** 容错解析：去围栏/去零宽字符/截取首个 { 到末个 }/修尾逗号 */
function parse_json_loose(string $text): ?array
{
    $text = trim($text);
    if ($text === '') return null;

    // BOM 与零宽字符会把 json_decode 直接搞挂
    $text = preg_replace('/^\xEF\xBB\xBF/', '', $text) ?? $text;
    $text = str_replace(["\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}"], '', $text);

    // <json>...</json> 包裹
    if (preg_match('/<json>([\s\S]*?)<\/json>/i', $text, $m)) {
        $text = trim($m[1]);
    }

    $text = preg_replace('/^```(?:json)?\s*/i', '', $text) ?? $text;
    $text = preg_replace('/\s*```$/', '', $text) ?? $text;

    $direct = json_decode($text, true);
    if (is_array($direct)) return $direct;

    $start = strpos($text, '{');
    $end   = strrpos($text, '}');
    if ($start === false || $end === false || $end <= $start) return null;

    $slice = substr($text, $start, $end - $start + 1);
    $json  = json_decode($slice, true);
    if (is_array($json)) return $json;

    // 常见小毛病：对象/数组尾部多一个逗号
    $repaired = preg_replace('/,\s*([}\]])/', '$1', $slice);
    if ($repaired !== null && $repaired !== $slice) {
        $json = json_decode($repaired, true);
        if (is_array($json)) return $json;
    }
    return null;
}

function normalize_question(array $q, string $subject): array
{
    $type = (($q['type'] ?? '') === 'multiple') ? 'multiple' : 'single';
    $stem = trim((string) ($q['stem'] ?? ''));
    if ($stem === '') fail('AI 返回的题干为空，请重试', 502);

    $options = [];
    foreach ((array) ($q['options'] ?? []) as $i => $opt) {
        if (!is_array($opt)) continue;
        $key  = strtoupper(trim((string) ($opt['key'] ?? '')));
        $text = trim((string) ($opt['text'] ?? ''));
        if ($key === '') $key = chr(65 + count($options));
        if ($text === '') continue;
        $options[] = ['key' => $key, 'text' => $text];
        if (count($options) >= 4) break;
    }
    if (count($options) < 2) fail('AI 返回的选项不完整，请重试', 502);

    $answer = [];
    foreach ((array) ($q['answer'] ?? []) as $a) {
        if (is_array($a)) continue;
        $a = strtoupper(trim((string) $a));
        if ($a !== '' && !in_array($a, $answer, true)) $answer[] = $a;
    }
    $answer = array_values(array_filter($answer, fn($a) => in_array($a, array_column($options, 'key'), true)));
    if (!$answer) fail('AI 未给出有效答案，请重试', 502);
    sort($answer);
    if ($type === 'single' && count($answer) > 1) $type = 'multiple';

    return [
        'type'        => $type,
        'knowledge'   => mb_substr(trim((string) ($q['knowledge'] ?? '')), 0, 40),
        'stem'        => $stem,
        'options'     => $options,
        'answer'      => $answer,
        'explanation' => trim((string) ($q['explanation'] ?? '')),
    ];
}

/** 记录一次异常返回，便于事后定位（不写 Key、不写完整题干） */
function log_issue(string $kind, string $detail): void
{
    ensure_data_dir();
    $line = date('c') . "\t" . $kind . "\t"
        . str_replace(["\r", "\n", "\t"], ' ', mb_substr($detail, 0, 600)) . "\n";
    @file_put_contents(DATA_DIR . '/debug.log', $line, FILE_APPEND | LOCK_EX);
    @chmod(DATA_DIR . '/debug.log', 0600);
}

/** 调用一次 chat/completions，返回 [content, promptTokens, completionTokens, finishReason] */
function chat_once(string $apiKey, string $model, array $messages, bool $repair = false): array
{
    $payload = [
        'model'    => $model,
        'messages' => $messages,
        'stream'   => false,
    ];
    if (stripos($model, 'reasoner') !== false) {
        $payload['max_tokens'] = 6000;
    } else {
        $payload['temperature']     = $repair ? 0.3 : 1.0;
        $payload['max_tokens']      = 2500;
        $payload['response_format'] = ['type' => 'json_object'];
    }

    $res = deepseek('POST', '/chat/completions', $apiKey, $payload);

    $usage = $res['usage'] ?? [];
    return [
        (string) ($res['choices'][0]['message']['content'] ?? ''),
        (int) ($usage['prompt_tokens'] ?? 0),
        (int) ($usage['completion_tokens'] ?? 0),
        (string) ($res['choices'][0]['finish_reason'] ?? ''),
    ];
}

function generate_question(string $apiKey, string $subject, string $scope, string $model, bool $thinking, array $history = []): array
{
    $usedModel = resolve_model($model, $thinking);
    $messages  = build_prompt($subject, $scope, $history);

    $started = microtime(true);
    list($content, $inTok, $outTok, $finish) = chat_once($apiKey, $usedModel, $messages);

    $parsed = parse_json_loose($content);

    // 第一次解析失败：把模型自己的输出回灌，要求它只吐合法 JSON，再试一次
    if ($parsed === null) {
        log_issue('parse-fail-1', 'model=' . $usedModel . ' finish=' . $finish . ' len=' . strlen($content) . ' content=' . $content);

        $retryMessages = $messages;
        if ($content !== '') {
            $retryMessages[] = ['role' => 'assistant', 'content' => mb_substr($content, 0, 800)];
        }
        $retryMessages[] = [
            'role'    => 'user',
            'content' => '上面的内容不是合法 JSON 或不是题目格式。请重新输出这道题，只输出一个 JSON 对象：'
                . '以 { 开头、以 } 结尾，不要任何解释文字、不要 Markdown 代码块、不要用反引号。',
        ];

        list($content2, $in2, $out2, $finish2) = chat_once($apiKey, $usedModel, $retryMessages, true);
        $inTok  += $in2;
        $outTok += $out2;
        $parsed = parse_json_loose($content2);

        if ($parsed === null) {
            log_issue('parse-fail-2', 'model=' . $usedModel . ' finish=' . $finish2 . ' len=' . strlen($content2) . ' content=' . $content2);
            fail('模型这次没返回可解析的题目（模型：' . $usedModel . '），请再点一次重试', 502);
        }
    }

    $question = normalize_question($parsed, $subject);
    $elapsed  = (int) round((microtime(true) - $started) * 1000);

    record_gen($subject, $usedModel, $inTok, $outTok);

    return [
        'question' => $question,
        'meta'     => [
            'model'     => $usedModel,
            'tokensIn'  => $inTok,
            'tokensOut' => $outTok,
            'elapsedMs' => $elapsed,
        ],
    ];
}

/* ------------------------------------------------------------------ 路由 */

if (defined('QUIZ_LIB_ONLY')) {
    return;   // CLI 测试：只加载函数，不处理请求
}

$action = field($_GET, 'action', '');
$in     = body();

switch ($action) {
    case 'ping':
        send_json(['ok' => true, 'time' => date('c')]);

    case 'models':
        $key = field($in, 'apiKey');
        if ($key === '') fail('缺少 API Key');
        $r = deepseek('GET', '/models', $key);
        $ids = [];
        foreach ((array) ($r['data'] ?? []) as $m) {
            if (isset($m['id'])) $ids[] = (string) $m['id'];
        }
        send_json(['ok' => true, 'models' => $ids]);

    case 'config_save':
        $r = config_save(
            field($in, 'password'),
            field($in, 'apiKey'),
            field($in, 'model', 'deepseek-chat'),
            (bool) ($in['thinking'] ?? false)
        );
        send_json(['ok' => true] + $r);

    case 'config_load':
        $cfg = config_load(field($in, 'password'));
        send_json(['ok' => true] + $cfg);

    case 'config_status':
        send_json(['ok' => true, 'exists' => is_file(CONFIG_FILE)]);

    case 'generate':
        $key     = field($in, 'apiKey');
        $subject = field($in, 'subject');
        $scope   = field($in, 'scope');
        if ($key === '') fail('缺少 API Key，请先完成配置', 401);
        if (!in_array($subject, SUBJECTS, true)) fail('科目不合法');
        if (mb_strlen($scope) < 2) fail('请填写考试范围');

        $result = generate_question(
            $key,
            $subject,
            $scope,
            field($in, 'model', 'deepseek-chat'),
            (bool) ($in['thinking'] ?? false),
            sanitize_history($in['history'] ?? [])
        );
        send_json(['ok' => true] + $result);

    case 'answer':
        $subject = field($in, 'subject');
        $correct = (bool) ($in['correct'] ?? false);
        if (!in_array($subject, SUBJECTS, true)) fail('科目不合法');
        record_ans($subject, $correct);
        send_json(['ok' => true]);

    case 'stats':
        send_json(stats());

    default:
        fail('未知操作', 404);
}
