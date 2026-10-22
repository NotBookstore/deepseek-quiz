<?php
/** 第一次返回散文、第二次返回合法 JSON，用来验证「解析失败自动重试」 */
header('Content-Type: application/json; charset=utf-8');
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$counter = sys_get_temp_dir() . '/quiz-badfirst-count.txt';

if ($uri === '/models') {
    echo json_encode(['object' => 'list', 'data' => [['id' => 'deepseek-chat']]]);
    return;
}

if ($uri === '/chat/completions') {
    $n = (int) @file_get_contents($counter) + 1;
    @file_put_contents($counter, (string) $n);

    if ($n === 1) {
        $content = '抱歉，我需要先确认一下题目要求，请稍等。';
    } else {
        $q = [
            'type' => 'single',
            'knowledge' => '重试后成功',
            'stem' => '重试后生成的题目：1 + 1 = ?',
            'options' => [
                ['key' => 'A', 'text' => '2'], ['key' => 'B', 'text' => '3'],
                ['key' => 'C', 'text' => '4'], ['key' => 'D', 'text' => '5'],
            ],
            'answer' => ['A'],
            'explanation' => '显然等于 2。',
        ];
        $content = "```json\n" . json_encode($q, JSON_UNESCAPED_UNICODE) . "\n```";
    }

    echo json_encode([
        'id' => 'mock-' . $n,
        'choices' => [[
            'index' => 0,
            'message' => ['role' => 'assistant', 'content' => $content],
            'finish_reason' => 'stop',
        ]],
        'usage' => ['prompt_tokens' => 100, 'completion_tokens' => 50, 'total_tokens' => 150],
    ]);
    return;
}

http_response_code(404);
echo json_encode(['error' => ['message' => 'mock: unknown path']]);
