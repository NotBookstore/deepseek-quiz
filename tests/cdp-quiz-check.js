/* 做题页交互校验：统计面板开关、页面切换（无截图） */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9337;
const PROFILE = path.join(__dirname, '..', 'edge-check-profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const proc = spawn(EXE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore' });

  let ok = false;
  for (let i = 0; i < 80 && !ok; i++) {
    try { ok = (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok; } catch (e) {}
    if (!ok) await sleep(250);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evalJs = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE });
  await sleep(1800);

  const checks = [];
  const check = async (name, expr) => {
    const v = await evalJs(expr);
    checks.push([name, !!v]);
    console.log((v ? 'ok   - ' : 'FAIL - ') + name);
  };

  await check('首页统计卡片有数值', "document.getElementById('todayQuestions').textContent !== '–'");
  await evalJs("document.querySelector('#summary .metric').click()");
  await sleep(250);
  await check('点击统计卡片展开明细', "document.getElementById('statsDetail').hidden === false");
  await evalJs("document.getElementById('statsBtn').click()");
  await sleep(250);
  await check('再次点击收起明细', "document.getElementById('statsDetail').hidden === true");

  await evalJs("document.getElementById('settingsBtn').click()");
  await sleep(250);
  await check('设置按钮进入配置页', "document.getElementById('view-api').hidden === false");
  await evalJs("document.querySelector('#view-api [data-back]').click()");
  await sleep(250);
  await check('返回按钮回到首页', "document.getElementById('view-home').hidden === false");

  await evalJs("document.getElementById('startBtn').click()");
  await sleep(300);
  await check('无 Key 时进入做题会跳到配置页', "document.getElementById('view-api').hidden === false");

  await evalJs("document.getElementById('apiKey').value='sk-test-abcdef123456'");
  await evalJs("document.getElementById('toExamBtn').click()");
  await sleep(300);
  await check('下一步进入科目页', "document.getElementById('view-exam').hidden === false");

  const sel = await evalJs("document.querySelector('#subjectChips [data-subject=\"物理\"]').click(), document.querySelector('#subjectChips [data-subject=\"物理\"]').getAttribute('aria-checked')");
  checks.push(['科目切换为物理', sel === 'true']);
  console.log((sel === 'true' ? 'ok   - ' : 'FAIL - ') + '科目切换为物理');

  await evalJs("document.getElementById('scopeInput').value='牛顿运动定律与受力分析'");
  await evalJs("document.getElementById('startQuizBtn').click()");
  await sleep(900);
  await check('进入做题页并显示加载态', "document.getElementById('view-quiz').hidden === false");
  await check('未配置真实 Key 时给出错误提示', "document.getElementById('quizError').hidden === false");

  const failed = checks.filter(c => !c[1]).length;
  console.log('\n' + (failed ? '失败 ' + failed + ' 项' : '全部通过'));
  proc.kill();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAILED: ' + e.stack); process.exit(1); });
