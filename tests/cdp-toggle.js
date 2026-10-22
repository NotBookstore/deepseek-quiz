/* 验证做题页顶栏「预出」开关：随时关闭/开启、队列不再补充/恢复补齐 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9340;
const OUT = process.env.SHOT_DIR || path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(OUT, 'edge-toggle-profile');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let genCount = 0;
const KNOWN = ['二次函数最值', '导数与单调性', '函数奇偶性', '数列通项'];

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
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      return;
    }
    if (msg.method !== 'Fetch.requestPaused') return;

    const { requestId, request } = msg.params;
    let body = null;

    if (request.url.indexOf('action=generate') !== -1) {
      genCount += 1;
      const n = genCount;
      body = {
        ok: true,
        question: {
          type: 'single',
          knowledge: KNOWN[(n - 1) % KNOWN.length],
          stem: '第 ' + n + ' 题：关于函数 f(x) = x² 的说法，正确的是？',
          options: [
            { key: 'A', text: '选项 A' }, { key: 'B', text: '选项 B' },
            { key: 'C', text: '选项 C' }, { key: 'D', text: '选项 D' }
          ],
          answer: ['A'],
          explanation: '第 ' + n + ' 题解析。'
        },
        meta: { model: 'deepseek-chat', tokensIn: 500, tokensOut: 200, elapsedMs: 3200 }
      };
    } else if (request.url.indexOf('action=answer') !== -1) {
      body = { ok: true };
    }

    if (body) {
      send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify(body)).toString('base64')
      });
    } else {
      send('Fetch.continueRequest', { requestId });
    }
  });

  const evalJs = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value;
  const shot = async name => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, 'shot-' + name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('  · ' + name);
  };
  const check = (n, ok, extra) => console.log((ok ? 'ok   - ' : 'FAIL - ') + n + (extra ? '  (' + extra + ')' : ''));

  await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api.php*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(1400);

  const start = async (prefetch) => {
    await evalJs("document.getElementById('startBtn').click()");
    await sleep(250);
    await evalJs("document.getElementById('apiKey').value='sk-test-1234567890'");
    await evalJs("document.getElementById('toExamBtn').click()");
    await sleep(250);
    await evalJs("document.getElementById('scopeInput').value='导数与函数单调性'");
    await evalJs("document.getElementById('prefetchInput').value='" + prefetch + "'; document.getElementById('prefetchInput').dispatchEvent(new Event('change'))");
    await evalJs("document.getElementById('startQuizBtn').click()");
    await sleep(1600);
  };

  await start(3);

  const badge = await evalJs("document.getElementById('bufferBadge').textContent");
  check('开局预出 3 题', /预出\s*3\/3/.test(badge) && genCount === 4, badge + ' / gen=' + genCount);
  await shot('quiz-toggle-on');

  /* 关闭开关 */
  await evalJs("document.getElementById('prefetchToggle').click()");
  await sleep(250);
  const off = await evalJs("JSON.stringify({checked: document.getElementById('prefetchToggle').checked, badge: document.getElementById('bufferBadge').hidden})");
  check('关闭后开关为关、徽标隐藏', JSON.parse(off).checked === false && JSON.parse(off).badge === true, off);

  const afterOff = genCount;
  await sleep(800);
  check('关闭后不再请求新题', genCount === afterOff, 'gen=' + genCount);
  await shot('quiz-toggle-off');

  /* 关闭状态下答题 → 下一题仍从队列取，且不补题 */
  await evalJs("document.querySelectorAll('.option')[0].click()");
  await evalJs("document.getElementById('submitBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('nextBtn').click()");
  await sleep(500);
  const stem = await evalJs("document.getElementById('stemText').textContent");
  check('关闭后仍能用队列里的题', /第 2 题/.test(stem), stem.slice(0, 16));
  check('关闭状态不补题', genCount === afterOff, 'gen=' + genCount);

  /* 重新打开开关 → 补回 3 题 */
  const beforeOn = genCount;
  await evalJs("document.getElementById('prefetchToggle').click()");
  await sleep(1500);
  const badge2 = await evalJs("document.getElementById('bufferBadge').textContent");
  check('重新打开后补回 3/3', /预出\s*3\/3/.test(badge2), badge2);
  check('补充请求数量正确', genCount - beforeOn === 1, 'delta=' + (genCount - beforeOn) + ' gen=' + genCount);

  /* 刷新页面后开关状态保留 */
  await send('Page.navigate', { url: BASE });
  await sleep(1200);
  check('刷新后开关状态保留（开）', (await evalJs("document.getElementById('prefetchToggle').checked")) === true);

  /* 手机端头部布局 */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: BASE });
  await sleep(1200);
  await start(3);
  console.log('  手机端横向溢出: ' + (await evalJs('document.documentElement.scrollWidth - innerWidth')) + 'px');
  await shot('quiz-toggle-mobile');

  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAILED: ' + e.stack); process.exit(1); });
