<?php
/** 假的 DeepSeek 接口，仅用于本地联调测试（php -S 127.0.0.1:8099 mock-deepseek.php） */
header('Content-Type: application/json; charset=utf-8');
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);

if ($uri === '/models') {
    echo json_encode([
        'object' => 'list',
        'data'   => [['id' => 'deepseek-chat', 'object' => 'model'], ['id' => 'deepseek-reasoner', 'object' => 'model']],
    ]);
    return;
}

if ($uri === '/chat/completions') {
    $body  = json_decode((string) file_get_contents('php://input'), true) ?: [];
    $model = (string) ($body['model'] ?? 'deepseek-chat');

    $q = [
        'type'        => 'single',
        'knowledge'   => '二次函数最值',
        'stem'        => '已知函数 f(x)=x²-2x，则 f(x) 在区间 [0,2] 上的最小值是？',
        'options'     => [
            ['key' => 'A', 'text' => '-1'],
            ['key' => 'B', 'text' => '0'],
            ['key' => 'C', 'text' => '1'],
            ['key' => 'D', 'text' => '2'],
        ],
        'answer'      => ['a'],
        'explanation' => '配方得 f(x)=(x-1)²-1，故最小值为 -1。',
    ];

    // 故意包一层 markdown 围栏，测试容错解析
    $content = "```json\n" . json_encode($q, JSON_UNESCAPED_UNICODE) . "\n```";

    echo json_encode([
        'id'      => 'mock-completion',
        'model'   => $model,
        'choices' => [[
            'index'         => 0,
            'message'       => ['role' => 'assistant', 'content' => $content],
            'finish_reason' => 'stop',
        ]],
        'usage'   => ['prompt_tokens' => 321, 'completion_tokens' => 123, 'total_tokens' => 444],
    ]);
    return;
}

http_response_code(404);
echo json_encode(['error' => ['message' => 'mock: unknown path ' . $uri]]);
