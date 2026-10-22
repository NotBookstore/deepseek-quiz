/* 用真实 Key 跑一遍前端做题流程（不拦截接口），复现「无法解析为题目」 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9339;
const OUT = process.env.SHOT_DIR || path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const PROFILE = path.join(OUT, 'edge-real-profile');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080/';
const KEY = process.env.QUIZ_KEY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!KEY) { console.error('missing QUIZ_KEY'); process.exit(2); }
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
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evalJs = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value;

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(1500);

  await evalJs("document.getElementById('startBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('apiKey').value='" + KEY + "'");
  // 明确关闭深度思考
  const checked = await evalJs("document.getElementById('thinkingToggle').checked");
  if (checked) {
    await evalJs("document.getElementById('thinkingToggle').click()");
    await sleep(200);
  }
  const nowChecked = await evalJs("document.getElementById('thinkingToggle').checked");
  console.log('深度思考开关（点击后）:', nowChecked);
  console.log('本地存储 thinking:', await evalJs("localStorage.getItem('quiz.thinking')"));

  await evalJs("document.getElementById('toExamBtn').click()");
  await sleep(300);
  await evalJs("document.getElementById('scopeInput').value='导数与函数单调性、极值'");
  await evalJs("document.getElementById('prefetchInput').value='0'; document.getElementById('prefetchInput').dispatchEvent(new Event('change'))");

  const t0 = Date.now();
  await evalJs("document.getElementById('startQuizBtn').click()");
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const state = await evalJs("JSON.stringify({err: document.getElementById('quizError').hidden ? '' : document.getElementById('errorText').textContent, body: !document.getElementById('quizBody').hidden, loading: !document.getElementById('quizLoading').hidden})");
    const s = JSON.parse(state);
    if (s.err || s.body) {
      console.log('耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's', '状态:', state);
      if (s.err) {
        await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(OUT, 'shot-real-error.png'), Buffer.from(r.data, 'base64')));
      } else {
        await send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(OUT, 'shot-real-ok.png'), Buffer.from(r.data, 'base64')));
      }
      break;
    }
  }

  proc.kill();
  process.exit(0);
})().catch(e => { console.error('FAILED: ' + e.stack); process.exit(1); });
