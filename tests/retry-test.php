<?php
/** 验证：模型返回非 JSON 时，自动重试一次并成功出题 */
declare(strict_types=1);

$tmp = sys_get_temp_dir() . '/quiz-retry';
putenv('QUIZ_DATA_DIR=' . $tmp . '/data');
putenv('DEEPSEEK_BASE=' . (getenv('MOCK_BASE') ?: 'http://127.0.0.1:8098'));
@mkdir($tmp . '/data', 0700, true);
@file_put_contents(sys_get_temp_dir() . '/quiz-badfirst-count.txt', '0');
@unlink($tmp . '/data/debug.log');

define('QUIZ_LIB_ONLY', true);
require dirname(__DIR__) . '/api.php';

$fail = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $fail;
    if ($ok) { echo "ok   - {$name}\n"; return; }
    $fail++;
    echo "FAIL - {$name}" . ($detail !== '' ? "  ({$detail})" : '') . "\n";
}

$res = generate_question('sk-mock-0000000000', '数学', '函数与导数', 'deepseek-chat', false, []);
check('重试后成功出题', ($res['question']['stem'] ?? '') !== '');
check('知识点来自第二次响应', ($res['question']['knowledge'] ?? '') === '重试后成功');
check('token 已合并两次调用', ($res['meta']['tokensIn'] ?? 0) === 200 && ($res['meta']['tokensOut'] ?? 0) === 100,
    'in=' . ($res['meta']['tokensIn'] ?? 0) . ' out=' . ($res['meta']['tokensOut'] ?? 0));

$count = (int) @file_get_contents(sys_get_temp_dir() . '/quiz-badfirst-count.txt');
check('确实调用了两次模型', $count === 2, 'count=' . $count);

$log = @file_get_contents($tmp . '/data/debug.log') ?: '';
check('失败内容写入了 debug.log', strpos($log, 'parse-fail-1') !== false, substr($log, 0, 60));
check('debug.log 不含 API Key', strpos($log, 'sk-mock') === false);

echo "\n" . ($fail === 0 ? '全部通过' : "失败 {$fail} 项") . "\n";
exit($fail === 0 ? 0 : 1);
