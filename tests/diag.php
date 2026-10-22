<?php
/**
 * 诊断脚本：复现「无法解析为题目」，打印 DeepSeek 原始返回
 * 用法：DEEPSEEK_KEY=sk-xxx MODEL=deepseek-chat THINKING=0 php diag.php [with|without]
 */
declare(strict_types=1);

putenv('QUIZ_DATA_DIR=' . sys_get_temp_dir() . '/quiz-diag/data');
@mkdir(sys_get_temp_dir() . '/quiz-diag/data', 0700, true);
define('QUIZ_LIB_ONLY', true);
require dirname(__DIR__) . '/api.php';

$key      = (string) getenv('DEEPSEEK_KEY');
$model    = (string) (getenv('MODEL') ?: 'deepseek-chat');
$thinking = getenv('THINKING') === '1';
$mode     = $argv[1] ?? 'with';

if ($key === '') { fwrite(STDERR, "missing key\n"); exit(2); }

$usedModel = resolve_model($model, $thinking);
$messages  = build_prompt('数学', '导数与函数单调性、极值', []);

$payload = ['model' => $usedModel, 'messages' => $messages, 'stream' => false];
if (stripos($usedModel, 'reasoner') !== false) {
    $payload['max_tokens'] = 6000;
} else {
    $payload['temperature'] = 1.0;
    $payload['max_tokens'] = 1600;
    if ($mode === 'with') $payload['response_format'] = ['type' => 'json_object'];
}

$ch = curl_init('https://api.deepseek.com/chat/completions');
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
    CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $key, 'Content-Type: application/json'],
    CURLOPT_TIMEOUT => 120,
]);
$raw  = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err  = curl_error($ch);
curl_close($ch);

echo "model={$usedModel} mode={$mode} http={$code} err={$err}\n";

$json = json_decode((string) $raw, true);
if (!is_array($json)) {
    echo "RAW (non-json):\n" . substr((string) $raw, 0, 800) . "\n";
    exit(1);
}

$choice  = $json['choices'][0] ?? [];
$content = (string) ($choice['message']['content'] ?? '');
echo "finish_reason=" . ($choice['finish_reason'] ?? '?') . "\n";
echo "usage=" . json_encode($json['usage'] ?? []) . "\n";
echo "content_len=" . strlen($content) . "\n";
echo "---- content ----\n" . $content . "\n---- end ----\n";

$parsed = parse_json_loose($content);
echo "parsed=" . ($parsed === null ? 'NULL' : 'ok') . "\n";
if ($parsed !== null) {
    echo "keys=" . implode(',', array_keys($parsed)) . "\n";
    try {
        $q = normalize_question($parsed, '数学');
        echo "normalized type={$q['type']} knowledge={$q['knowledge']} answer=" . implode('', $q['answer']) . "\n";
    } catch (Throwable $e) {
        echo "normalize failed: " . $e->getMessage() . "\n";
    }
}
