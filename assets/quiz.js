/* ==========================================================================
   做题：API 配置 → 科目与范围 → AI 出题 → 判分 → 统计
   ========================================================================== */
(function () {
  'use strict';

  var SUBJECTS = ['英语', '数学', '物理', '化学', '生物'];
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    apiKey: '',
    model: 'deepseek-chat',
    thinking: false,
    subject: '数学',
    scope: '',
    prefetch: 3,          // 当前生效的预出数量（开关关闭时为 0）
    prefetchTarget: 3,    // 用户设置的目标数量
    prefetchOn: true,     // 做题途中可随时开关
    question: null,
    selected: new Set(),
    answered: false,
    count: 0,
    busy: false,
    view: 'home',
    inSession: false,
    queue: [],
    history: [],
    prefetching: false,
    bufferError: ''
  };

  /* ------------------------------------------------------------ 存储 */

  function store(key, value) {
    try { localStorage.setItem('quiz.' + key, String(value)); } catch (e) {}
  }
  function read(key, fallback) {
    try {
      var v = localStorage.getItem('quiz.' + key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  /* ------------------------------------------------------------ 请求 */

  function api(action, payload) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 180000) : 0;

    return fetch('api.php?action=' + encodeURIComponent(action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) {}
        if (!r.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || ('请求失败（HTTP ' + r.status + '）'));
        }
        return data;
      });
    }).finally(function () {
      if (timer) clearTimeout(timer);
    });
  }

  /* ------------------------------------------------------------ 基础 UI */

  var toastTimer = null;
  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    requestAnimationFrame(function () { el.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.hidden = true; }, 240);
    }, 2600);
  }

  function showView(name) {
    ['home', 'api', 'exam', 'quiz'].forEach(function (v) {
      var el = $('view-' + v);
      if (el) el.hidden = v !== name;
    });
    state.view = name;
    window.scrollTo(0, 0);
  }

  function fmt(n) {
    return (n || 0).toLocaleString('zh-CN');
  }

  /* ------------------------------------------------------------ 统计 */

  function refreshStats() {
    return api('stats').then(function (data) {
      // 题目数按「已作答」统计（预出题会多生成，但没做的不算）
      $('todayQuestions').textContent = fmt(data.today.answers);
      $('todayTokens').textContent = fmt(data.today.tokens);
      $('weekQuestions').textContent = fmt(data.week.answers);
      $('weekTokens').textContent = fmt(data.week.tokens);
      $('totalQuestions').textContent = fmt(data.total.answers);
      $('totalTokens').textContent = fmt(data.total.tokens);
      renderSubjects(data.subjects || []);
    }).catch(function (e) {
      // 首页统计失败不阻塞使用
      console.warn('stats failed:', e.message);
    });
  }

  function renderSubjects(rows) {
    var tbody = $('subjectRows');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty">还没有做题记录</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      var rate = r.answers ? Math.round((r.correct / r.answers) * 100) + '%' : '—';
      return '<tr>' +
        '<td class="subj">' + r.subject + '</td>' +
        '<td>' + (r.answeredToday || 0) + '</td>' +
        '<td>' + (r.answeredWeek || 0) + '</td>' +
        '<td>' + (r.answers || 0) + '</td>' +
        '<td>' + rate + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ------------------------------------------------------------ 第一步：API */

  function setConfigStatus(text, isError) {
    var el = $('configStatus');
    el.textContent = text;
    el.style.color = isError ? 'var(--error)' : '';
  }

  function checkConfig() {
    api('config_status').then(function (d) {
      setConfigStatus(d.exists
        ? '已有保存过的配置：输入密码后点击「读取配置」即可恢复。'
        : '还没有保存过配置：填好 API Key 与密码后点击「保存配置」。');
    }).catch(function () {
      setConfigStatus('无法检查配置状态。', true);
    });
  }

  function fillModelOptions(models) {
    var sel = $('modelSelect');
    if (!models.length) return;
    sel.innerHTML = models.map(function (m) {
      return '<option value="' + m + '">' + m + '</option>';
    }).join('');
    if (models.indexOf(state.model) === -1) state.model = models[0];
    sel.value = state.model;
  }

  function loadModels() {
    var key = $('apiKey').value.trim();
    if (!key) { toast('先填 API Key', true); $('apiKey').focus(); return; }

    var btn = $('loadModelsBtn');
    btn.disabled = true;
    btn.textContent = '获取中…';

    api('models', { apiKey: key }).then(function (d) {
      var models = d.models || [];
      if (!models.length) throw new Error('账号下没有可用模型');
      fillModelOptions(models);
      $('modelsHint').textContent = '已获取 ' + models.length + ' 个模型。';
      toast('模型列表已更新');
    }).catch(function (e) {
      $('modelsHint').textContent = '获取失败：' + e.message;
      toast(e.message, true);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = '获取模型列表';
    });
  }

  function saveConfig() {
    var key = $('apiKey').value.trim();
    var pwd = $('cfgPassword').value.trim();
    if (!key) { toast('先填 API Key', true); return; }
    if (pwd.length < 4) { toast('密码至少 4 位', true); $('cfgPassword').focus(); return; }

    api('config_save', {
      password: pwd, apiKey: key, model: $('modelSelect').value, thinking: state.thinking
    }).then(function () {
      toast('配置已加密保存');
      setConfigStatus('配置已保存（AES-256-GCM 加密，只有密码能解开）。');
    }).catch(function (e) { toast(e.message, true); setConfigStatus(e.message, true); });
  }

  function loadConfig() {
    var pwd = $('cfgPassword').value.trim();
    if (!pwd) { toast('先输入配置密码', true); $('cfgPassword').focus(); return; }

    api('config_load', { password: pwd }).then(function (d) {
      $('apiKey').value = d.apiKey;
      state.apiKey = d.apiKey;
      state.model = d.model || 'deepseek-chat';
      state.thinking = !!d.thinking;

      var sel = $('modelSelect');
      if (!Array.prototype.some.call(sel.options, function (o) { return o.value === state.model; })) {
        var opt = document.createElement('option');
        opt.value = state.model;
        opt.textContent = state.model;
        sel.appendChild(opt);
      }
      sel.value = state.model;
      $('thinkingToggle').checked = state.thinking;

      try { sessionStorage.setItem('quiz.key', state.apiKey); } catch (e) {}
      toast('配置已读取');
      setConfigStatus('已恢复配置（模型 ' + state.model + '，深度思考' + (state.thinking ? '开启' : '关闭') + '）。');
    }).catch(function (e) { toast(e.message, true); setConfigStatus(e.message, true); });
  }

  /* ------------------------------------------------------------ 第二步：科目 */

  function selectSubject(subject) {
    state.subject = subject;
    Array.prototype.forEach.call($('subjectChips').children, function (btn) {
      btn.setAttribute('aria-checked', String(btn.dataset.subject === subject));
    });
    store('subject', subject);
  }

  /* ------------------------------------------------------------ 出题与预出题队列 */

  function showQuizError(message) {
    $('quizLoading').hidden = true;
    $('quizBody').hidden = true;
    $('quizError').hidden = false;
    $('errorTitle').textContent = '出题失败';
    $('errorText').textContent = message;
  }

  function updateBufferBadge() {
    var el = $('bufferBadge');
    if (!el) return;
    if (state.prefetch <= 0) { el.hidden = true; return; }

    el.hidden = false;
    var queued = state.queue.length;
    var text;
    if (state.bufferError && queued < state.prefetch) text = '预出中断 ' + queued + '/' + state.prefetch;
    else if (state.prefetching) text = '预出 ' + queued + '/' + state.prefetch + ' · 生成中';
    else text = '预出 ' + queued + '/' + state.prefetch;

    el.innerHTML = '<span class="pulse"></span>';
    var span = document.createElement('span');
    span.textContent = text;
    el.appendChild(span);
  }

  // 请求一道题，并把它记入「已考考点」历史，避免后续重复
  function fetchQuestion() {
    return api('generate', {
      apiKey: state.apiKey,
      model: state.model,
      thinking: state.thinking,
      subject: state.subject,
      scope: state.scope,
      history: state.history.slice(-10)
    }).then(function (d) {
      state.bufferError = '';
      state.history.push({
        knowledge: (d.question && d.question.knowledge) || '',
        stem: (d.question && d.question.stem) || ''
      });
      if (state.history.length > 20) state.history = state.history.slice(-20);
      return d;
    });
  }

  // 维持队列长度 = 预出题数量，一次只跑一个请求，避免并发打爆接口
  function ensureBuffer() {
    if (!state.inSession || state.prefetch <= 0) { updateBufferBadge(); return; }
    if (state.prefetching || state.queue.length >= state.prefetch) { updateBufferBadge(); return; }

    state.prefetching = true;
    updateBufferBadge();

    (function loop() {
      if (!state.inSession || state.queue.length >= state.prefetch) {
        state.prefetching = false;
        updateBufferBadge();
        return;
      }
      fetchQuestion().then(function (d) {
        if (!state.inSession) { state.prefetching = false; return; }   // 已结束，丢弃结果
        state.queue.push(d);
        updateBufferBadge();
        loop();
      }).catch(function (e) {
        state.prefetching = false;
        state.bufferError = e.message;
        updateBufferBadge();
      });
    })();
  }

  function renderQuestion(q, meta) {
    $('quizSubject').textContent = state.subject;
    $('quizCount').textContent = '第 ' + state.count + ' 题';

    $('typeTag').textContent = q.type === 'multiple' ? '多选题' : '单选题';

    var kTag = $('knowledgeTag');
    kTag.textContent = q.knowledge ? '考点 · ' + q.knowledge : '';
    kTag.hidden = !q.knowledge;

    $('modelTag').textContent = meta && meta.model
      ? meta.model + (meta.elapsedMs ? ' · ' + (meta.elapsedMs / 1000).toFixed(1) + 's' : '')
      : '';

    $('stemText').textContent = q.stem;

    var list = $('optionsList');
    list.innerHTML = '';
    q.options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option';
      btn.dataset.key = opt.key;
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = '<span class="key">' + opt.key + '</span><span class="text"></span>';
      btn.querySelector('.text').textContent = opt.text;
      btn.addEventListener('click', function () { toggleOption(opt.key); });
      list.appendChild(btn);
    });

    $('submitBtn').disabled = true;
    $('submitBtn').hidden = false;
    $('submitBtn').textContent = '完成';
    $('resultPanel').hidden = true;
  }

  function optionEls() {
    return Array.prototype.slice.call($('optionsList').children);
  }

  function toggleOption(key) {
    if (state.answered || !state.question) return;

    if (state.question.type === 'single') {
      state.selected.clear();
      state.selected.add(key);
    } else {
      if (state.selected.has(key)) state.selected.delete(key);
      else state.selected.add(key);
    }

    optionEls().forEach(function (el) {
      el.setAttribute('aria-pressed', String(state.selected.has(el.dataset.key)));
    });
    $('submitBtn').disabled = state.selected.size === 0;
  }

  function judge() {
    if (state.answered || !state.question || state.selected.size === 0) return;
    state.answered = true;

    var q = state.question;
    var picked = Array.from(state.selected).sort();
    var answer = q.answer.slice().sort();
    state.correct = picked.length === answer.length && picked.every(function (k, i) { return k === answer[i]; });

    optionEls().forEach(function (el) {
      var key = el.dataset.key;
      var isAnswer = answer.indexOf(key) !== -1;
      var isPicked = picked.indexOf(key) !== -1;
      el.disabled = true;
      if (isAnswer) el.classList.add('is-correct');
      else if (isPicked) el.classList.add('is-wrong');
    });

    $('submitBtn').disabled = true;
    $('submitBtn').hidden = true;   // 已判分，改由「下一题」推进

    var icon = $('resultIcon');
    icon.classList.toggle('bad', !state.correct);
    icon.innerHTML = state.correct
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>';

    $('resultTitle').textContent = state.correct ? '回答正确' : '回答错误';
    $('resultSub').textContent = state.correct
      ? '正确答案：' + answer.join('、')
      : '你选了 ' + picked.join('、') + '，正确答案是 ' + answer.join('、');

    $('explainText').textContent = q.explanation || '（这道题没有附带解析）';
    $('resultPanel').hidden = false;
    $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    api('answer', { subject: state.subject, correct: state.correct }).catch(function () {});
  }

  /* ------------------------------------------------------------ 推进题目 */

  function takeFromQueue() {
    var item = state.queue.shift();
    if (!item) { state.busy = false; showQuizError('题目队列为空，请重试'); return; }

    state.question = item.question;
    state.count += 1;
    renderQuestion(item.question, item.meta);

    $('quizLoading').hidden = true;
    $('quizBody').hidden = false;
    state.busy = false;
    ensureBuffer();               // 取走一题，立即补一题
  }

  function waitForQueue() {
    if (!state.inSession) { state.busy = false; return; }
    if (state.queue.length) { takeFromQueue(); return; }
    if (!state.prefetching) {
      fetchQuestion().then(function (d) {
        state.queue.push(d);
        takeFromQueue();
      }).catch(function (e) {
        state.busy = false;
        showQuizError(e.message);
      });
      return;
    }
    setTimeout(waitForQueue, 150);
  }

  function advance() {
    if (state.busy) return;
    state.busy = true;
    state.answered = false;
    state.selected.clear();

    $('resultPanel').hidden = true;
    $('quizError').hidden = true;

    if (state.queue.length) { takeFromQueue(); return; }

    $('quizBody').hidden = true;
    $('quizLoading').hidden = false;
    $('quizCount').textContent = '第 ' + (state.count + 1) + ' 题';
    $('loadingSub').textContent = state.thinking
      ? '深度思考模型正在推导，可能需要几十秒'
      : 'AI 正在根据你的范围拟题，通常需要几秒';

    if (state.prefetching) {
      waitForQueue();                       // 首题正在预出，等它好
    } else {
      fetchQuestion().then(function (d) {
        state.queue.push(d);
        takeFromQueue();
      }).catch(function (e) {
        state.busy = false;
        showQuizError(e.message);
      });
    }
  }

  function startSession() {
    state.inSession = true;
    state.count = 0;
    state.queue = [];
    state.history = [];
    state.bufferError = '';
    state.prefetching = false;
    state.busy = false;
    state.question = null;
    state.prefetch = state.prefetchOn ? state.prefetchTarget : 0;

    $('prefetchToggle').checked = state.prefetchOn;

    showView('quiz');
    updateBufferBadge();
    advance();
  }

  function endSession() {
    state.inSession = false;
    state.prefetching = false;
    state.count = 0;
    state.queue = [];
    state.history = [];
    state.question = null;
    state.selected.clear();
    state.answered = false;

    showView('home');
    refreshStats();
  }

  /* ------------------------------------------------------------ 事件绑定 */

  function bind() {
    $('startBtn').addEventListener('click', function () {
      if (!$('apiKey').value.trim() && !state.apiKey) {
        toast('先完成 API 配置', true);
        showView('api');
        return;
      }
      showView('exam');   // 本次会话已配置过，直接进入第二步
    });
    $('settingsBtn').addEventListener('click', function () { showView('api'); });

    function toggleStats() {
      var panel = $('statsDetail');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        refreshStats();
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    $('statsBtn').addEventListener('click', toggleStats);
    $('summary').addEventListener('click', toggleStats);
    $('statsRefresh').addEventListener('click', function () { refreshStats().then(function () { toast('已刷新'); }); });

    $('loadModelsBtn').addEventListener('click', loadModels);
    $('saveConfigBtn').addEventListener('click', saveConfig);
    $('loadConfigBtn').addEventListener('click', loadConfig);

    $('apiKey').addEventListener('input', function () {
      state.apiKey = this.value.trim();
      try { sessionStorage.setItem('quiz.key', state.apiKey); } catch (e) {}
    });
    $('modelSelect').addEventListener('change', function () { state.model = this.value; store('model', state.model); });
    $('thinkingToggle').addEventListener('change', function () { state.thinking = this.checked; store('thinking', state.thinking ? '1' : '0'); });

    $('toExamBtn').addEventListener('click', function () {
      var key = $('apiKey').value.trim();
      if (!key) { toast('请先填写 API Key', true); $('apiKey').focus(); return; }
      state.apiKey = key;
      state.model = $('modelSelect').value || state.model;
      showView('exam');
    });

    Array.prototype.forEach.call($('subjectChips').children, function (btn) {
      btn.addEventListener('click', function () { selectSubject(btn.dataset.subject); });
    });

    $('scopeInput').addEventListener('input', function () {
      state.scope = this.value.trim();
      store('scope', state.scope);
    });

    function setPrefetch(value) {
      var n = Math.max(0, Math.min(10, parseInt(value, 10) || 0));
      state.prefetchTarget = n;
      state.prefetch = state.prefetchOn ? n : 0;
      $('prefetchInput').value = n;
      $('prefetchValue').textContent = n;
      store('prefetch', n);
    }

    $('prefetchToggle').addEventListener('change', function () {
      state.prefetchOn = this.checked;
      store('prefetchOn', state.prefetchOn ? '1' : '0');

      if (state.prefetchOn && state.prefetchTarget <= 0) {
        state.prefetchTarget = 3;
        store('prefetch', 3);
      }
      state.prefetch = state.prefetchOn ? state.prefetchTarget : 0;
      updateBufferBadge();
      if (state.prefetchOn && state.inSession) ensureBuffer();

      toast(state.prefetchOn ? '已开启预出题' : '已关闭预出题，队列里的题仍可作答');
    });

    $('prefetchMinus').addEventListener('click', function () { setPrefetch(state.prefetch - 1); });
    $('prefetchPlus').addEventListener('click', function () { setPrefetch(state.prefetch + 1); });
    $('prefetchInput').addEventListener('change', function () { setPrefetch(this.value); });
    $('prefetchInput').addEventListener('blur', function () { setPrefetch(this.value); });

    $('startQuizBtn').addEventListener('click', function () {
      var scope = $('scopeInput').value.trim();
      if (scope.length < 2) { toast('请填写考试范围', true); $('scopeInput').focus(); return; }
      state.scope = scope;
      store('scope', scope);
      setPrefetch($('prefetchInput').value);
      startSession();
    });

    $('submitBtn').addEventListener('click', judge);
    $('nextBtn').addEventListener('click', advance);
    $('retryBtn').addEventListener('click', advance);
    $('endBtn').addEventListener('click', endSession);

    Array.prototype.forEach.call(document.querySelectorAll('[data-back]'), function (btn) {
      btn.addEventListener('click', function () { showView(btn.dataset.back); });
    });

    $('themeBtn').addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('dsh-theme', next); } catch (e) {}
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', next === 'dark' ? '#0E1414' : '#FAFDFC');
    });

    // 桌面端快捷键：A/B/C/D 选项，Enter 提交，N 下一题
    document.addEventListener('keydown', function (e) {
      if (state.view !== 'quiz' || !state.question) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      var key = e.key.toUpperCase();
      if (!state.answered && /^[A-D]$/.test(key)) {
        e.preventDefault();
        toggleOption(key);
      } else if (key === 'ENTER') {
        e.preventDefault();
        if (state.answered) { if (!$('resultPanel').hidden) advance(); }
        else judge();
      } else if (key === 'N' && state.answered) {
        advance();
      }
    });
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    // 恢复本地偏好
    state.model = read('model', 'deepseek-chat');
    state.thinking = read('thinking', '0') === '1';
    state.subject = read('subject', '数学');
    state.scope = read('scope', '');
    try { state.apiKey = sessionStorage.getItem('quiz.key') || ''; } catch (e) {}

    if (SUBJECTS.indexOf(state.subject) === -1) state.subject = '数学';

    state.prefetchTarget = Math.max(0, Math.min(10, parseInt(read('prefetch', '3'), 10) || 0));
    state.prefetchOn = read('prefetchOn', '1') === '1';
    state.prefetch = state.prefetchOn ? state.prefetchTarget : 0;

    $('modelSelect').value = state.model;
    $('thinkingToggle').checked = state.thinking;
    $('scopeInput').value = state.scope;
    $('apiKey').value = state.apiKey;
    $('prefetchInput').value = state.prefetchTarget;
    $('prefetchValue').textContent = state.prefetchTarget;
    $('prefetchToggle').checked = state.prefetchOn;
    selectSubject(state.subject);

    bind();
    checkConfig();
    refreshStats();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
