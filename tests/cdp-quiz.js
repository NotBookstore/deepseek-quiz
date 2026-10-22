/* 做题页 UI 走查（v2）：预出题队列、考点去重、判分与移动端布局 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9338;
const OUT = process.env.SHOT_DIR || path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(OUT, 'edge-quiz-profile');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const KNOWN = ['二次函数最值', '导数与单调性', '函数奇偶性', '数列通项', '三角函数化简', '立体几何体积', '概率分布', '向量数量积'];

let genCount = 0;
const bodies = [];

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const proc = spawn(EXE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });

  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    try { ready = (await fetch('http://127.0.0.1:' + PORT + '/json/version')).ok; } catch (e) {}
    if (!ready) await sleep(250);
  }
  const targets = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));

  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method !== 'Fetch.requestPaused') return;

    const { requestId, request } = msg.params;
    let body = null;

    if (request.url.indexOf('action=generate') !== -1) {
      genCount += 1;
      const n = genCount;
      const parsed = request.postData ? JSON.parse(request.postData) : {};
      bodies.push(parsed);

      body = {
        ok: true,
        question: {
          type: 'single',
          knowledge: KNOWN[(n - 1) % KNOWN.length],
          stem: '第 ' + n + ' 题：已知函数 f(x) = x³ − ' + n + 'x + 1，下列说法正确的是？',
          options: [
            { key: 'A', text: '选项 A（正确）' },
            { key: 'B', text: '选项 B' },
            { key: 'C', text: '选项 C' },
            { key: 'D', text: '选项 D' }
          ],
          answer: ['A'],
          explanation: '这是第 ' + n + ' 题的解析，考查 ' + KNOWN[(n - 1) % KNOWN.length] + '。'
        },
        meta: { model: 'deepseek-chat', tokensIn: 500 + n, tokensOut: 200, elapsedMs: 3800 }
      };
    } else if (request.url.indexOf('action=answer') !== -1) {
      body = { ok: true };
    }

    if (body) {
      send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64')
      });
    } else {
      send('Fetch.continueRequest', { requestId });
    }
  });

  const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, 'shot-' + name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  · ' + name);
  };
  const check = (name, ok, extra) => console.log((ok ? 'ok   - ' : 'FAIL - ') + name + (extra ? '  (' + extra + ')' : ''));

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api.php*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: BASE });
  await sleep(1500);

  /* 进入配置 → 科目页 */
  await evalJs("document.getElementById('startBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('apiKey').value='sk-test-1234567890'");
  await evalJs("document.getElementById('toExamBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('scopeInput').value='导数与函数单调性、极值'");
  await evalJs("document.getElementById('prefetchInput').value='3'; document.getElementById('prefetchInput').dispatchEvent(new Event('change'))");
  await sleep(200);

  /* 开始做题：预出 3 题 */
  await evalJs("document.getElementById('startQuizBtn').click()");
  await sleep(1800);

  const badge = await evalJs("document.getElementById('bufferBadge').textContent");
  check('顶栏显示预出进度', /预出\s*3\/3/.test(badge), badge);
  check('开局共请求 4 次生成（当前 1 + 预出 3）', genCount === 4, 'genCount=' + genCount);

  const kTag = await evalJs("document.getElementById('knowledgeTag').textContent");
  check('题目卡片显示考点标签', /考点 · /.test(kTag), kTag);

  check('第 2 次请求带上了首题的考点', (bodies[1].history || []).some(h => h.knowledge === KNOWN[0]), JSON.stringify((bodies[1].history || []).slice(0, 1)));
  check('后续请求历史累积', (bodies[3].history || []).length >= 2, 'history=' + (bodies[3].history || []).length);
  check('历史条数受控（≤10）', (bodies[3].history || []).length <= 10);

  await shot('quiz-prefetch');

  /* 答题 → 下一题应立即出题（来自队列） */
  await evalJs("document.querySelectorAll('.option')[0].click()");
  await evalJs("document.getElementById('submitBtn').click()");
  await sleep(400);
  await shot('quiz-prefetch-result');

  const t0 = Date.now();
  await evalJs("document.getElementById('nextBtn').click()");
  await sleep(300);
  const instantLoading = await evalJs("document.getElementById('quizLoading').hidden === true");
  const stem2 = await evalJs("document.getElementById('stemText').textContent");
  check('下一题从队列即时取出（不显示加载）', instantLoading, (Date.now() - t0) + 'ms');
  check('展示的是第 2 题', /第 2 题/.test(stem2), stem2.slice(0, 18));

  await sleep(900);
  check('取走后自动补一题（共 5 次请求）', genCount === 5, 'genCount=' + genCount);
  const badge2 = await evalJs("document.getElementById('bufferBadge').textContent");
  check('队列恢复到 3/3', /预出\s*3\/3/.test(badge2), badge2);
  check('第 2 题已带上历史', (bodies[4].history || []).some(h => h.knowledge === KNOWN[1]), 'history=' + (bodies[4].history || []).length);

  /* 预出 = 0 时按需生成 */
  await evalJs("document.getElementById('endBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('startBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('prefetchInput').value='0'; document.getElementById('prefetchInput').dispatchEvent(new Event('change'))");
  await evalJs("document.getElementById('startQuizBtn').click()");
  await sleep(600);
  const badgeHidden = await evalJs("document.getElementById('bufferBadge').hidden");
  check('预出 0 时隐藏队列徽标', badgeHidden === true);
  const before = genCount;
  await evalJs("document.querySelectorAll('.option')[0].click()");
  await evalJs("document.getElementById('submitBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('nextBtn').click()");
  await sleep(600);
  check('预出 0 时下一题现场生成', genCount === before + 1, 'delta=' + (genCount - before));

  /* 手机端 */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE });
  await sleep(1200);
  await evalJs("document.getElementById('startBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('apiKey').value='sk-test-1234567890'");
  await evalJs("document.getElementById('toExamBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('scopeInput').value='导数与函数单调性、极值'");
  await evalJs("document.getElementById('prefetchInput').value='3'; document.getElementById('prefetchInput').dispatchEvent(new Event('change'))");
  await shot('quiz-exam-mobile');
  console.log('  手机端横向溢出: ' + (await evalJs('document.documentElement.scrollWidth - innerWidth')) + 'px');

  await evalJs("document.getElementById('startQuizBtn').click()");
  await sleep(1500);
  await shot('quiz-prefetch-mobile');
  console.log('  手机端题目页溢出: ' + (await evalJs('document.documentElement.scrollWidth - innerWidth')) + 'px');

  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAILED: ' + e.stack); process.exit(1); });
