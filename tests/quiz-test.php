<?php
/**
 * 做题后端测试：容错解析、题目规范化、配置加解密、统计聚合、出题全链路（对接 mock 接口）
 * 用法：php quiz-test.php [api.php 路径]，环境变量 MOCK_BASE 可选
 */
declare(strict_types=1);

$mock = getenv('MOCK_BASE');
if ($mock) { putenv('DEEPSEEK_BASE=' . $mock); }
putenv('QUIZ_DATA_DIR=' . __DIR__ . '/data');
@mkdir(__DIR__ . '/data', 0700, true);
foreach (glob(__DIR__ . '/data/*') ?: [] as $f) { @unlink($f); }

define('QUIZ_LIB_ONLY', true);
require getenv('QUIZ_API') ?: (dirname(__DIR__) . '/api.php');

$failures = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures;
    if ($ok) {
        echo "ok   - {$name}\n";
    } else {
        $failures++;
        echo "FAIL - {$name}" . ($detail !== '' ? "  ({$detail})" : '') . "\n";
    }
}

/* ---------------------------------------------------------------- 1. 解析 */

$p1 = parse_json_loose("```json\n{\"a\":1}\n```");
check('去掉 markdown 围栏', is_array($p1) && ($p1['a'] ?? null) === 1);

$p2 = parse_json_loose("好的，题目如下：{\"a\":2} 希望有帮助");
check('从解释性文字中截取 JSON', is_array($p2) && ($p2['a'] ?? null) === 2);

check('非 JSON 返回 null', parse_json_loose('这道题很有意思') === null);
check('空字符串返回 null', parse_json_loose('') === null);

/* ---------------------------------------------------------------- 2. 规范化 */

$q = normalize_question([
    'type'    => 'single',
    'stem'    => '题干',
    'options' => [
        ['key' => 'a', 'text' => '选项一'],
        ['key' => 'B', 'text' => '选项二'],
        ['key' => 'C', 'text' => '选项三'],
        ['key' => 'D', 'text' => '选项四'],
    ],
    'answer'  => ['a'],
], '数学');
check('单选：题型与答案大小写归一', $q['type'] === 'single' && $q['answer'] === ['A']);

$q2 = normalize_question([
    'type'    => 'single',
    'stem'    => '多选题被标成单选',
    'options' => [['key' => 'A', 'text' => '1'], ['key' => 'B', 'text' => '2'], ['key' => 'C', 'text' => '3']],
    'answer'  => ['B', 'A'],
], '物理');
check('两个答案时自动改成多选并排序', $q2['type'] === 'multiple' && $q2['answer'] === ['A', 'B']);

$q3 = normalize_question([
    'type'    => 'single',
    'stem'    => '含非法答案',
    'options' => [['key' => 'A', 'text' => '1'], ['key' => 'B', 'text' => '2']],
    'answer'  => ['A', 'Z', 'A'],
], '化学');
check('非法/重复答案被过滤', $q3['answer'] === ['A']);

$q4 = normalize_question(['stem' => '无 key 的选项', 'options' => [['text' => '甲'], ['text' => '乙']], 'answer' => ['A']], '生物');
check('缺省 key 自动补 A/B', $q4['options'][0]['key'] === 'A' && $q4['options'][1]['key'] === 'B');

/* ---------------------------------------------------------------- 2b. 考点历史 */

$msgs = build_prompt('数学', '函数与导数', [
    ['knowledge' => '二次函数最值', 'stem' => '已知 f(x)=x²-2x+3，求最小值'],
    ['knowledge' => '导数与单调性', 'stem' => '讨论 f(x)=x³-3x 的单调区间'],
]);
$userMsg = $msgs[1]['content'];
check('prompt 带上了已考考点', strpos($userMsg, '二次函数最值') !== false && strpos($userMsg, '导数与单调性') !== false);
check('prompt 要求避免重复', strpos($userMsg, '不要出同一考点的') !== false || strpos($userMsg, '避开相同考点') !== false);
check('无历史时不含避免段落', strpos(build_prompt('数学', '函数')[1]['content'], '已经出过') === false);

$hist = sanitize_history([
    ['knowledge' => str_repeat('考', 80), 'stem' => str_repeat('题', 300)],
    ['knowledge' => 'a', 'stem' => 'b'],
    'not-an-array',
]);
check('历史清洗：长度截断', mb_strlen($hist[0]['knowledge']) === 40 && mb_strlen($hist[0]['stem']) === 120);
check('历史清洗：丢弃非法项', count($hist) === 2);

$qk = normalize_question([
    'type' => 'single', 'knowledge' => '  函数奇偶性  ',
    'stem' => '题干', 'options' => [['key' => 'A', 'text' => '1'], ['key' => 'B', 'text' => '2']],
    'answer' => ['A'],
], '数学');
check('解析并裁剪 knowledge 字段', $qk['knowledge'] === '函数奇偶性');
/* ---------------------------------------------------------------- 3. 模型 */

check('深度思考 -> reasoner', resolve_model('deepseek-chat', true) === 'deepseek-reasoner');
check('关闭思考且选了 reasoner -> chat', resolve_model('deepseek-reasoner', false) === 'deepseek-chat');
check('普通模型保持不变', resolve_model('deepseek-chat', false) === 'deepseek-chat');

/* ---------------------------------------------------------------- 4. 配置 */

$save = config_save('pass1234', 'sk-mock-1234567890', 'deepseek-reasoner', true);
check('配置保存返回成功', ($save['saved'] ?? false) === true);
check('配置文件权限 0600', substr(sprintf('%o', fileperms(CONFIG_FILE)), -4) === '0600');

$raw = (string) file_get_contents(CONFIG_FILE);
check('磁盘上没有明文 Key', strpos($raw, 'sk-mock-1234567890') === false);

$cfg = config_load('pass1234');
check('密码可解出 Key', $cfg['apiKey'] === 'sk-mock-1234567890');
check('模型与思考开关一并恢复', $cfg['model'] === 'deepseek-reasoner' && $cfg['thinking'] === true);

/* ---------------------------------------------------------------- 5. 统计 */

$s0 = stats();
check('初始统计为 0', $s0['total']['questions'] === 0 && $s0['total']['tokens'] === 0);

record_gen('数学', 'deepseek-chat', 100, 50);
record_ans('数学', true);
record_ans('数学', false);
$s1 = stats();
check('题目数与 token 汇总', $s1['total']['questions'] === 1 && $s1['total']['tokens'] === 150);
check('答题数与正确数', $s1['total']['answers'] === 2 && $s1['total']['correct'] === 1);
check('按科目聚合', ($s1['subjects'][0]['subject'] ?? '') === '数学' && $s1['subjects'][0]['questions'] === 1);
check('今日与本周区间包含今天', $s1['today']['questions'] === 1 && $s1['week']['questions'] === 1);

/* ---------------------------------------------------------------- 6. 全链路（mock） */

$base = getenv('MOCK_BASE');
if ($base) {
    $models = deepseek('GET', '/models', 'sk-mock-1234567890');
    check('拉取模型列表', count($models['data'] ?? []) === 2 && $models['data'][0]['id'] === 'deepseek-chat');

    $before = stats();
    $res = generate_question('sk-mock-1234567890', '数学', '二次函数最值', 'deepseek-chat', false);

    check('题目类型解析正确', ($res['question']['type'] ?? '') === 'single');
    check('答案归一为 A', ($res['question']['answer'] ?? []) === ['A']);
    check('四个选项齐全', count($res['question']['options'] ?? []) === 4);
    check('解析文本非空', ($res['question']['explanation'] ?? '') !== '');
    check('返回考点字段', ($res['question']['knowledge'] ?? '') === '二次函数最值');
    check('记录了 token 用量', ($res['meta']['tokensIn'] ?? 0) === 321 && ($res['meta']['tokensOut'] ?? 0) === 123);

    $after = stats();
    check('统计累加一次出题（+444 token）', $after['total']['tokens'] - $before['total']['tokens'] === 444);
    check('统计累加一道题', $after['total']['questions'] - $before['total']['questions'] === 1);

    $think = generate_question('sk-mock-1234567890', '物理', '牛顿定律', 'deepseek-chat', true);
    check('深度思考切换为 reasoner', ($think['meta']['model'] ?? '') === 'deepseek-reasoner');
} else {
    echo "skip - 未提供 MOCK_BASE，跳过接口全链路测试\n";
}

echo "\n" . ($failures === 0 ? '全部通过' : "失败 {$failures} 项") . "\n";
exit($failures === 0 ? 0 : 1);
