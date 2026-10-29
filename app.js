/* 雅思口语陪练 —— 主逻辑（无框架、file:// 可直接打开） */
(function () {
  "use strict";

  /* =========================================================
     0. 小工具
     ========================================================= */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const LS_SETTINGS = "ielts_settings_v1";
  const LS_HISTORY = "ielts_history_v1";

  const CAT_LABEL = {
    people: "人物", place: "地点", object: "物品", event: "事件",
    activity: "活动", media: "媒体", abstract: "抽象", other: "其他"
  };
  const SRC_LABEL = { yage: "雅思哥", xhd: "新航道" };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { /* 隐私模式等，忽略 */ }
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /* 极简 Markdown：**粗体**、- 列表、空行分段 */
  function fmt(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    let html = "";
    let inList = false;
    const inline = (s) => esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        if (inList) { html += "</ul>"; inList = false; }
        continue;
      }
      const li = line.match(/^[-·•*]\s+(.*)$/);
      if (li) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + inline(li[1]) + "</li>";
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        html += "<p>" + inline(line) + "</p>";
      }
    }
    if (inList) html += "</ul>";
    return html;
  }

  /* =========================================================
     1. 数据
     ========================================================= */
  const BANK = window.IELTS_BANK || { meta: {}, part1: [], part2: [] };
  const PAST = window.PAST_QUESTIONS || { meta: {}, part1: [], part2: [] };

  function p1TopicGroups(entries) {
    const map = new Map();
    for (const x of entries) {
      const key = (x.topic || "General").trim();
      if (!map.has(key)) map.set(key, { topic: key, sub: x.sub || "", questions: [], src: x.src || "" });
      const g = map.get(key);
      if (x.q) g.questions.push(x.q);
    }
    return Array.from(map.values()).filter(g => g.questions.length);
  }

  /* =========================================================
     2. 全局状态
     ========================================================= */
  const state = {
    mode: "bank",
    cats: new Set(),
    sources: new Set(),
    scope: "all",
    round: null,
    ai: { text: "", done: false, error: "", timer: null, startedAt: 0 },
    viewingHistoryId: null
  };

  const timer = { id: null, left: 0, total: 0, onDone: null, onTick: null };

  function settings() {
    const s = loadJSON(LS_SETTINGS, {});
    return {
      apiKey: s.apiKey || "",
      baseUrl: s.baseUrl || "",
      model: s.model || "deepseek-chat",
      voice: s.voice || "",
      rate: Number(s.rate) || 1
    };
  }

  function saveSettings(patch) {
    const s = Object.assign(settings(), patch);
    saveJSON(LS_SETTINGS, s);
  }

  /* =========================================================
     3. 屏幕切换
     ========================================================= */
  function go(screen, opts) {
    stopTimer();
    stopSpeak();
    $$(".screen").forEach(el => el.classList.remove("active"));
    const target = $("#screen-" + screen);
    if (target) target.classList.add("active");
    $$(".nav button, .tabbar button").forEach(b => {
      if (b.dataset.go === screen) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    if (screen === "home") renderHomeStats();
    if (screen === "history") renderHistory();
  }

  /* =========================================================
     4. 首页统计
     ========================================================= */
  function renderHomeStats() {
    const b1 = (BANK.part1 || []).length, b2 = (BANK.part2 || []).length;
    const p1 = (PAST.part1 || []).length, p2 = (PAST.part2 || []).length;
    const bankCats = Array.from(new Set((BANK.part2 || []).map(x => x.cat || "other"))).length;
    const pastCats = (PAST.meta && PAST.meta.cats || []).filter(c => c.count > 0).length;

    const bStat = $("#bankStat"), pStat = $("#pastStat");
    if (bStat) bStat.textContent = b2 ? `${b2} 张卡片 · ${b1} 道小题` : "题库未加载";
    if (pStat) pStat.textContent = p2 ? `${p2} 张卡片 · ${p1} 道小题` : "真题未加载";

    const roundStat = $("#roundStat");
    if (roundStat) {
      const n = loadJSON(LS_HISTORY, []).length;
      roundStat.textContent = n ? n + " 轮" : "还没练过";
    }

    const bMeta = $("#bankMeta"), pMeta = $("#pastMeta");
    if (bMeta) bMeta.textContent = b2 ? `${b2} 张 Part 2 · ${b1} 道 Part 1 · ${bankCats} 类` : "题库未加载";
    if (pMeta) pMeta.textContent = p2 ? `${p2} 张 Part 2 · ${p1} 道 Part 1 · ${pastCats} 类` : "真题未加载";
  }

  /* =========================================================
     5. 配置页
     ========================================================= */
  function openSetup(mode) {
    state.mode = mode;
    state.cats = new Set();
    state.sources = new Set();
    state.scope = "all";

    const isBank = mode === "bank";
    $("#setupTitle").textContent = isBank ? "题库模式" : "随机模式（往届真题）";
    $("#setupSub").textContent = isBank
      ? "从 2026 年 9–12 月题库里抽：Part 1 一个话题、Part 2 一张卡片、Part 3 若干讨论题。"
      : "从网上整理的真实考题里随机抽，练的是反复出现的经典题。";

    $("#fieldSource").hidden = !isBank;
    $("#fieldCats").hidden = !(isBank ? (BANK.part2 || []).length : (PAST.part2 || []).length);

    if (isBank) {
      const srcs = Array.from(new Set((BANK.part1 || []).map(x => x.src).filter(Boolean)));
      const box = $("#sourceChips");
      box.innerHTML = "";
      if (!srcs.length) box.innerHTML = '<span class="hint">题库文件没加载，先确认 question_bank.js 在同目录。</span>';
      for (const s of srcs) {
        const b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.textContent = SRC_LABEL[s] || s;
        b.dataset.src = s;
        b.addEventListener("click", () => {
          state.sources.has(s) ? state.sources.delete(s) : state.sources.add(s);
          b.setAttribute("aria-pressed", state.sources.has(s) ? "true" : "false");
        });
        box.appendChild(b);
      }
    }

    // 类型
    const catBox = $("#catChips");
    catBox.innerHTML = "";
    let catKeys = [];
    if (isBank) {
      const counts = {};
      for (const x of (BANK.part2 || [])) counts[x.cat || "other"] = (counts[x.cat || "other"] || 0) + 1;
      catKeys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    } else {
      const cats = (PAST.meta && PAST.meta.cats) || [];
      catKeys = cats.filter(c => c.count > 0).map(c => c.key);
      if (!catKeys.length) catKeys = Array.from(new Set((PAST.part2 || []).map(x => x.cat)));
    }
    for (const key of catKeys) {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.dataset.cat = key;
      b.textContent = CAT_LABEL[key] || key;
      b.addEventListener("click", () => {
        state.cats.has(key) ? state.cats.delete(key) : state.cats.add(key);
        b.setAttribute("aria-pressed", state.cats.has(key) ? "true" : "false");
      });
      catBox.appendChild(b);
    }

    // Part 1 范围
    const scopeBox = $("#p1ScopeChips");
    scopeBox.innerHTML = "";
    const scopes = [["all", "全部"], ["new", "本季新题"], ["old", "保留题 / 老题"]];
    for (const [key, label] of scopes) {
      const b = document.createElement("button");
      b.className = "chip";
      b.type = "button";
      b.dataset.scope = key;
      b.textContent = label;
      b.setAttribute("aria-pressed", key === "all" ? "true" : "false");
      if (!isBank && key !== "all") { b.disabled = true; b.style.opacity = ".45"; }
      b.addEventListener("click", () => {
        if (b.disabled) return;
        state.scope = key;
        $$("#p1ScopeChips .chip").forEach(o => o.setAttribute("aria-pressed", o === b ? "true" : "false"));
      });
      scopeBox.appendChild(b);
    }

    $("#setupHint").textContent = "";
    go("setup");
  }

  function isNewGroup(x) {
    const g = (x.group || "") + " " + (x.status || "");
    return x.status === "new" || /新题/.test(g);
  }
  function isOldGroup(x) {
    const g = (x.group || "") + " " + (x.status || "");
    return x.status === "old" || /保留|万年老题|老题/.test(g);
  }

  /* =========================================================
     6. 抽题
     ========================================================= */
  function pickP1() {
    let entries;
    if (state.mode === "bank") {
      entries = (BANK.part1 || []).filter(x => !state.sources.size || state.sources.has(x.src));
      if (state.scope === "new") entries = entries.filter(isNewGroup);
      else if (state.scope === "old") entries = entries.filter(isOldGroup);
    } else {
      entries = PAST.part1 || [];
    }
    let groups = p1TopicGroups(entries);
    // 优先抽有 2 个以上问题的完整话题
    const rich = groups.filter(g => g.questions.length >= 2);
    const g = pick(rich.length ? rich : groups);
    if (!g) return null;
    return { topic: g.topic, sub: g.sub, questions: g.questions.slice(0, 5) };
  }

  function p2Pool() {
    let pool;
    if (state.mode === "bank") {
      pool = (BANK.part2 || []).filter(x => !state.sources.size || state.sources.has(x.src));
    } else {
      pool = (PAST.part2 || []).slice();
      if (state.cats.size) pool = pool.filter(x => state.cats.has(x.cat));
    }
    if (state.mode === "bank" && state.cats.size) pool = pool.filter(x => state.cats.has(x.cat || "other"));
    return pool;
  }

  function pickP3(card) {
    const qs = (card.p3 || []).filter(Boolean);
    if (!qs.length) return [];
    return shuffle(qs).slice(0, Math.min(4, qs.length));
  }

  function startRound() {
    const p1 = pickP1();
    const pool = p2Pool();
    if (!p1) { toast("没有可用的 Part 1 题目，检查一下筛选条件或题库文件。"); return; }
    if (!pool.length) { toast("没有可用的 Part 2 卡片，检查一下筛选条件。"); return; }
    const card = pick(pool);
    state.round = {
      mode: state.mode,
      cats: Array.from(state.cats),
      sources: Array.from(state.sources),
      p1: p1,
      p2: card,
      p3: pickP3(card),
      at: Date.now()
    };
    state.ai = { text: "", done: false, error: "", timer: null, startedAt: 0 };
    go("practice");
    renderPart(1);
  }

  /* =========================================================
     7. 练习页
     ========================================================= */
  function setStep(n) {
    $$("#stepbar .step").forEach(el => {
      const s = Number(el.dataset.step);
      el.classList.toggle("on", s === n);
      el.classList.toggle("done", s < n);
    });
  }

  function ringHTML(total) {
    const C = 2 * Math.PI * 40;
    return `
      <div class="ring" id="ring">
        <svg width="92" height="92" viewBox="0 0 92 92">
          <circle class="bg" cx="46" cy="46" r="40"></circle>
          <circle class="fg" cx="46" cy="46" r="40"
            stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="0"></circle>
        </svg>
        <div class="time" id="ringTime">${fmtTime(total)}</div>
      </div>`;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function stopTimer() {
    if (timer.id) clearInterval(timer.id);
    timer.id = null;
  }

  function runTimer(total, onDone) {
    stopTimer();
    timer.total = total;
    timer.left = total;
    timer.onDone = onDone;
    const C = 2 * Math.PI * 40;
    const ring = $("#ring"), timeEl = $("#ringTime"), fg = $("#ring .fg");
    const tick = () => {
      const left = Math.max(0, timer.left);
      if (timeEl) timeEl.textContent = fmtTime(left);
      if (fg) fg.style.strokeDashoffset = (C * (1 - left / timer.total)).toFixed(2);
      if (ring) {
        ring.classList.toggle("warn", left <= 15 && left > 5);
        ring.classList.toggle("danger", left <= 5);
      }
      if (left <= 0) {
        stopTimer();
        if (timer.onDone) {
          try { timer.onDone(); } catch (e) { /* DOM 已切走 */ }
        }
      }
    };
    tick();
    timer.id = setInterval(() => { timer.left -= 1; tick(); }, 1000);
  }

  function renderPart(n) {
    if (!state.round) return;
    stopTimer();
    setStep(n);
    const stage = $("#stage");
    if (!stage) return;

    if (n === 1) {
      const r = state.round;
      $("#partEyebrow").textContent = "Step 1 / 3 · 日常问答";
      $("#partTitle").textContent = r.p1.topic;
      $("#partTopic").textContent = r.p1.sub || "先热身：像聊天一样，每题说 2–3 句";
      stage.innerHTML = `
        <div class="cue-card">
          <div class="cue-top">
            <span class="cue-label">Part 1 · Daily questions</span>
            <span class="cue-tag">约 4 分钟</span>
          </div>
          <h3>${esc(r.p1.topic)}</h3>
          <ul class="q-list">
            ${r.p1.questions.map(q => `<li>${esc(q)}</li>`).join("")}
          </ul>
          <div class="actions">
            <button class="btn" id="btnEnd1">结束 Part 1，进入 Part 2 →</button>
            <button class="btn btn-quiet" id="btnRerollP1">换一个话题</button>
            <span class="hint">不必写稿，先把话说顺</span>
          </div>
        </div>`;
      $("#btnEnd1").addEventListener("click", () => renderPart(2));
      $("#btnRerollP1").addEventListener("click", () => {
        const p1 = pickP1();
        if (!p1) return;
        state.round.p1 = p1;
        renderPart(1);
      });
      return;
    }

    if (n === 2) {
      const r = state.round;
      const card = r.p2;
      $("#partEyebrow").textContent = "Step 2 / 3 · 卡片陈述";
      $("#partTitle").textContent = "卡片陈述";
      $("#partTopic").textContent = card.cn || "Part 2 · Cue card";
      stage.innerHTML = `
        <div class="cue-card">
          <div class="cue-top">
            <span class="cue-label">Part 2 · Cue card</span>
            <span class="cue-tag">1 分钟准备 · 2 分钟作答</span>
          </div>
          <h3>${esc(card.prompt)}</h3>
          <div class="cue-label" style="margin:2px 0 8px">You should say</div>
          <ul class="cue-list">
            ${(card.bullets || []).map(b => `<li>${esc(b)}</li>`).join("")}
          </ul>
          <div class="timer-row">
            ${ringHTML(60)}
            <div class="timer-text">
              <div id="timerLabel">准备 1 分钟，然后连续说 2 分钟</div>
              <div class="timer-sub" id="timerSub">点「开始准备」，计时结束会自动切到作答阶段</div>
            </div>
          </div>
          <div class="actions" id="p2Actions">
            <button class="btn" id="btnPrep">开始准备（1 分钟）</button>
            <button class="btn btn-quiet" id="btnSkipPrep" hidden>跳过准备，直接作答</button>
            <button class="btn btn-quiet" id="btnEnd2">结束 Part 2，进入 Part 3 →</button>
          </div>
        </div>`;
      const prepBtn = $("#btnPrep");
      prepBtn.addEventListener("click", () => {
        prepBtn.disabled = true;
        $("#btnSkipPrep").hidden = false;
        $("#timerLabel").textContent = "准备中… 可以在纸上列 3 个关键词";
        runTimer(60, () => {
          $("#timerLabel").textContent = "准备时间到，开始作答";
          startSpeakingPhase();
        });
      });
      $("#btnSkipPrep").addEventListener("click", startSpeakingPhase);
      function startSpeakingPhase() {
        $("#timerLabel").textContent = "作答中… 连续说 2 分钟，不要停";
        const sub = $("#timerSub");
        if (sub) sub.textContent = "时间到会自动提示，也可以随时点「结束 Part 2」";
        $("#p2Actions").innerHTML = `
          <button class="btn" id="btnEnd2">结束 Part 2，进入 Part 3 →</button>
          <button class="btn btn-quiet" id="btnRestartTimer">重新计时</button>`;
        $("#btnEnd2").addEventListener("click", () => renderPart(3));
        $("#btnRestartTimer").addEventListener("click", () => runTimer(120, () => {
          $("#timerLabel").textContent = "时间到，可以进入 Part 3 了";
        }));
        runTimer(120, () => { $("#timerLabel").textContent = "时间到，可以进入 Part 3 了"; });
      }
      $("#btnEnd2").addEventListener("click", () => renderPart(3));
      return;
    }

    // Part 3
    const r = state.round;
    $("#partEyebrow").textContent = "Step 3 / 3 · 深入讨论";
    $("#partTitle").textContent = "深入讨论";
    $("#partTopic").textContent = r.p2.cn || "Part 3 · Discussion";
    stage.innerHTML = `
      <div class="cue-card">
        <div class="cue-top">
          <span class="cue-label">Part 3 · Discussion</span>
          <span class="cue-tag">立场 · 理由 · 例子</span>
        </div>
        <h3>顺着 Part 2 的话题往深处聊</h3>
        <ul class="q-list">
          ${r.p3.length
            ? r.p3.map(q => `<li>${esc(q)}</li>`).join("")
            : `<li>（这道卡片没配 Part 3 问题，直接点下面的按钮生成素材）</li>`}
        </ul>
        <div class="actions">
          <button class="btn" id="btnFinish">结束 Part 3，生成复盘素材 →</button>
          <button class="btn btn-quiet" id="btnRerollP3">换一组问题</button>
          <span class="hint">先给观点，再补理由和例子</span>
        </div>
      </div>`;
    $("#btnFinish").addEventListener("click", finishRound);
    $("#btnRerollP3").addEventListener("click", () => {
      state.round.p3 = pickP3(state.round.p2);
      renderPart(3);
    });
  }

  /* =========================================================
     8. AI 生成
     ========================================================= */
  function isPrivateHost() {
    const h = location.hostname || "";
    return h === "" || h === "localhost" || /^127\./.test(h) || /^10\./.test(h) ||
      /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === "[::1]";
  }

  function endpoint() {
    const s = settings();
    let base = (s.baseUrl || "").trim();
    if (!base) {
      // 本机 file:// 直连；通过本机/局域网代理打开时走同源 /deepseek；其它（如 GitHub Pages）直连
      if (location.protocol === "file:") base = "https://api.deepseek.com";
      else if (isPrivateHost()) base = location.origin + "/deepseek";
      else base = "https://api.deepseek.com";
    }
    return base.replace(/\/+$/, "") + "/chat/completions";
  }

  function buildMessages(round) {
    const p2 = round.p2 || {};
    const lines = [];
    lines.push("这是学生刚完成的一轮完整雅思口语练习，请据此生成复盘素材。");
    lines.push("");
    lines.push("【Part 1 话题】" + (round.p1 ? round.p1.topic : ""));
    (round.p1 ? round.p1.questions : []).forEach(q => lines.push("- " + q));
    lines.push("");
    lines.push("【Part 2 卡片】" + (p2.prompt || ""));
    lines.push("You should say:");
    (p2.bullets || []).forEach(b => lines.push("- " + b));
    lines.push("");
    lines.push("【Part 3 问题】");
    (round.p3 || []).forEach(q => lines.push("- " + q));

    const system = [
      "你是一位有十年经验的雅思口语外教，中文解释、英文示范。",
      "学生刚刚完成 Part 1、Part 2、Part 3 的一轮练习，你要给他三份思路素材、两篇 Part 2 口语范例和一组加分表达。",
      "",
      "必须严格按下面的标记输出，标记单独占一行，标记之外不要加任何前后语、不要用别的标题层级：",
      "",
      "===素材1===",
      "思路：一兩句中文，点明这道题可以怎么破题、走什么角度。",
      "要点：",
      "- 第一条中文思路/内容（具体、可讲，不要空话）",
      "- 第二条",
      "- 第三条",
      "可套用句：一句英文，旁边用括号给中文意思。",
      "",
      "===素材2===",
      "（同上结构，换一个不同的角度）",
      "",
      "===素材3===",
      "（同上结构，再换一个角度）",
      "",
      "===范例1===",
      "【英文】",
      "一段 130-180 词的自然口语英文，直接回答 Part 2 卡片，第一人称，允许口语化表达，不要分点、不要标题。",
      "【中文翻译】",
      "上面这段英文对应的中文翻译。",
      "【亮点表达】",
      "- 英文短语 / 句型：中文释义",
      "- 再给 3-5 条",
      "",
      "===范例2===",
      "（结构同范例1，换一个素材或角度，不要和范例1 用同一套细节）",
      "",
      "===加分表达===",
      "- 5 条本项目的高分表达，每条格式：英文表达：中文释义",
      "",
      "要求：三份素材的角度要明显不同（比如：个人经历 / 社会观察 / 对比与让步）。范例要像真人说出来的，长短句交错，杜绝模板腔。"
    ].join("\n");

    return [
      { role: "system", content: system },
      { role: "user", content: lines.join("\n") }
    ];
  }

  function scheduleRender() {
    if (state.ai.timer) return;
    state.ai.timer = setTimeout(() => {
      state.ai.timer = null;
      renderResult(true);
    }, 120);
  }

  async function runAI() {
    const round = state.round;
    if (!round) return;
    const s = settings();

    if (!s.apiKey) {
      state.ai = {
        text: "",
        done: true,
        error: "还没有填 DeepSeek API Key —— 点右上角「设置」填好，再回来点「重新生成」。Key 只保存在本机浏览器里。",
        timer: null,
        startedAt: 0
      };
      renderResult(false);
      openSettings();
      return;
    }

    state.ai = { text: "", done: false, error: "", timer: null, startedAt: Date.now() };
    renderResult(true);

    const url = endpoint();
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + s.apiKey
        },
        body: JSON.stringify({
          model: s.model,
          messages: buildMessages(round),
          stream: true,
          temperature: 0.8,
          max_tokens: 2600
        })
      });
    } catch (err) {
      state.ai.error = "网络请求失败：" + (err && err.message ? err.message : err) +
        "\n\n如果是跨域（CORS）被拦：在电脑上双击「启动本地代理.bat」，用 http://127.0.0.1:8765/index.html 打开；手机想用就双击「手机同局域网访问.bat」，按窗口里给出的 http://192.168.x.x:8765 地址打开。";
      state.ai.done = true;
      renderResult(false);
      return;
    }

    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = (j.error && j.error.message) || JSON.stringify(j);
      } catch (e) {
        try { detail = await res.text(); } catch (e2) { detail = ""; }
      }
      state.ai.error = "接口返回 " + res.status + "：" + (detail || "未知错误");
      state.ai.done = true;
      renderResult(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (delta) { state.ai.text += delta; scheduleRender(); }
          } catch (e) { /* 忽略半截 JSON */ }
        }
      }
    } catch (err) {
      state.ai.error = "生成中断：" + (err && err.message ? err.message : err);
    }

    state.ai.done = true;
    renderResult(false);
    saveHistoryIfDone();
  }

  /* ---------- 解析标记 ---------- */
  const SECTION_RE = /^[ \t]*(?:#{1,6}\s*)?(?:={2,}\s*)?【?\s*(素材\s*[1-9]|范例\s*[1-9]|加分表达|加分词组)\s*】?(?:\s*={2,})?[ \t]*$/gim;

  function parseSections(text) {
    const matches = [];
    let m;
    SECTION_RE.lastIndex = 0;
    while ((m = SECTION_RE.exec(text)) !== null) {
      matches.push({ key: m[1].replace(/\s+/g, ""), start: m.index, bodyStart: m.index + m[0].length });
    }
    const sections = [];
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
      sections.push({
        key: cur.key,
        body: text.slice(cur.bodyStart, end).trim(),
        closed: i + 1 < matches.length
      });
    }
    const lead = matches.length ? text.slice(0, matches[0].start).trim() : text;
    return { lead: lead, sections: sections };
  }

  function splitSample(body) {
    const out = { en: "", zh: "", words: [] };
    // 统一标记：允许 **【英文】**、英文：、【English】 等写法
    const norm = String(body || "")
      .replace(/\r/g, "")
      .replace(/\*\*/g, "")
      .replace(/[【\[]\s*(英文|English)\s*[】\]]/gi, "\n@@EN@@\n")
      .replace(/[【\[]\s*中文翻译\s*[】\]]/g, "\n@@ZH@@\n")
      .replace(/[【\[]\s*亮点表达\s*[】\]]/g, "\n@@W@@\n")
      .replace(/^[ \t]*(英文|English)[ \t]*[:：][ \t]*$/gim, "\n@@EN@@\n")
      .replace(/^[ \t]*中文翻译[ \t]*[:：][ \t]*$/gm, "\n@@ZH@@\n")
      .replace(/^[ \t]*亮点表达[ \t]*[:：][ \t]*$/gm, "\n@@W@@\n");

    if (!/@@(EN|ZH|W)@@/.test(norm)) {
      out.en = norm.trim();
      return out;
    }
    const enM = norm.match(/@@EN@@([\s\S]*?)(?=@@EN@@|@@ZH@@|@@W@@|$)/);
    const zhM = norm.match(/@@ZH@@([\s\S]*?)(?=@@EN@@|@@ZH@@|@@W@@|$)/);
    const wM = norm.match(/@@W@@([\s\S]*)$/);
    out.en = enM ? enM[1].trim() : "";
    out.zh = zhM ? zhM[1].trim() : "";
    if (wM) {
      out.words = wM[1].split("\n").map(s => s.trim()).filter(Boolean)
        .map(s => s.replace(/^[-·•*]\s*/, ""));
    }
    return out;
  }

  function splitSentences(text) {
    const parts = String(text || "")
      .replace(/\s+/g, " ")
      .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g);
    return (parts || []).map(s => s.trim()).filter(Boolean);
  }

  function mdInline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  /* 把一份素材拆成 思路 / 要点 / 可套用句 */
  function parseMaterial(body) {
    const out = { idea: "", points: [], quote: "", rest: "" };
    const lines = String(body || "").replace(/\r/g, "").split("\n");
    let mode = "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { if (mode === "points") mode = ""; continue; }
      let m;
      if ((m = line.match(/^思路\s*[:：]\s*(.*)$/))) { out.idea = m[1]; mode = "idea"; continue; }
      if ((m = line.match(/^要点\s*[:：]\s*(.*)$/))) { mode = "points"; if (m[1]) out.points.push(m[1]); continue; }
      if ((m = line.match(/^可套用(?:句|表达)\s*[:：]\s*(.*)$/))) { out.quote = m[1]; mode = "quote"; continue; }
      if (/^[-·•*]\s+/.test(line)) {
        const t = line.replace(/^[-·•*]\s+/, "");
        if (mode === "points") out.points.push(t);
        else if (mode === "quote") out.quote += " " + t;
        else out.rest += line + "\n";
        continue;
      }
      if (mode === "idea") { out.idea += " " + line; continue; }
      if (mode === "points") { out.points.push(line); continue; }
      if (mode === "quote") { out.quote += " " + line; continue; }
      out.rest += line + "\n";
    }
    return out;
  }

  function materialHTML(n, body, closed) {
    const m = parseMaterial(body);
    if (!closed) return `<div class="res-body"><div class="streaming">${esc(body)}</div></div>`;
    if (!m.idea && !m.points.length && !m.quote) {
      return `<div class="res-body">${body ? fmt(body) : '<div class="streaming"></div>'}</div>`;
    }
    let inner = "";
    if (m.idea) inner += `<div class="mat-row"><span class="mat-key">思路</span><div>${mdInline(m.idea)}</div></div>`;
    if (m.points.length) {
      inner += `<div class="mat-row"><span class="mat-key">要点</span><ul>${m.points.map(p => `<li>${mdInline(p)}</li>`).join("")}</ul></div>`;
    }
    if (m.quote) inner += `<div class="mat-quote"><span class="mat-key">可套用句</span>${mdInline(m.quote)}</div>`;
    if (m.rest.trim()) inner += `<div class="mat-row"><span class="mat-key">补充</span><div>${fmt(m.rest)}</div></div>`;
    return `<div class="res-body">${inner}</div>`;
  }

  function bonusItems(body) {
    return String(body || "").replace(/\r/g, "").split("\n")
      .map(s => s.trim().replace(/^[-·•*]\s+/, ""))
      .filter(Boolean)
      .map(s => {
        const i = s.search(/[:：]/);
        return i > 0
          ? { en: s.slice(0, i).trim(), zh: s.slice(i + 1).trim() }
          : { en: s, zh: "" };
      });
  }

  function renderRoundSummary() {
    const box = $("#roundSummaryBody");
    if (!box) return;
    const r = state.round;
    if (!r) { box.innerHTML = ""; return; }
    const mode = r.mode === "past" ? "往届真题" : "题库模式";
    box.innerHTML = `
      <p><b>${mode}</b>${r.cats && r.cats.length ? " · " + r.cats.map(c => CAT_LABEL[c] || c).join(" / ") : ""}</p>
      <p><b>Part 1</b> ${esc(r.p1 ? r.p1.topic : "—")}${r.p1 ? `（${r.p1.questions.length} 问）` : ""}</p>
      <p><b>Part 2</b> ${esc(r.p2 ? r.p2.prompt : "—")}</p>
      <p><b>Part 3</b> ${(r.p3 || []).length} 个讨论问题</p>`;
  }

  function renderResult(streaming) {
    const cards = $("#resultCards");
    const actions = $("#resultActions");
    if (!cards) return;
    const round = state.round;
    const text = state.ai.text || "";
    const { lead, sections } = parseSections(text);

    const status = $("#resultStatus");
    status.classList.toggle("done", state.ai.done && !state.ai.error);
    status.querySelector(".txt").textContent = state.ai.error
      ? "生成失败"
      : state.ai.done ? "已生成" : "正在生成…";

    let html = "";
    renderRoundSummary();

    if (state.ai.error) {
      html += `<div class="notice">${fmt(state.ai.error)}</div>`;
      if (text) {
        html += `<article class="res-card">
          <div class="res-num">!</div>
          <div class="res-main">
            <div class="res-head"><span class="res-kind">原始输出</span><span class="res-title">已生成的部分</span></div>
            <div class="res-body"><div class="streaming">${esc(text)}</div></div>
          </div>
        </article>`;
      }
      cards.innerHTML = html;
      actions.hidden = false;
      return;
    }

    if (!sections.length) {
      html += `<article class="res-card">
        <div class="res-num">…</div>
        <div class="res-main">
          <div class="res-head">
            <span class="res-kind">Generating</span>
            <span class="res-title">正在写素材与范例</span>
            <div class="res-tools"><span class="spinner"></span></div>
          </div>
          <div class="res-body"><div class="streaming">${esc(lead || (streaming ? text : "正在连接模型…"))}</div></div>
        </div>
      </article>`;
      cards.innerHTML = html;
      actions.hidden = true;
      return;
    }

    const matIndex = { 素材1: 1, 素材2: 2, 素材3: 3 };
    let sampleCount = 0;

    for (const sec of sections) {
      if (/^素材/.test(sec.key)) {
        const n = matIndex[sec.key] || "";
        html += `<article class="res-card res-card--idea">
          <div class="res-num">${esc(n)}</div>
          <div class="res-main">
            <div class="res-head">
              <span class="res-kind">Idea</span>
              <span class="res-title">思路素材 ${esc(n)}</span>
            </div>
            ${materialHTML(n, sec.body, sec.closed)}
          </div>
        </article>`;
      } else if (/^范例/.test(sec.key)) {
        sampleCount += 1;
        const s = splitSample(sec.body);
        const enSents = splitSentences(s.en);
        const enHTML = enSents.length
          ? `<p class="sample-en">${enSents.map(x => `<span class="sentence" data-sentence>${esc(x)}</span>`).join(" ")}</p>`
          : `<div class="streaming">${esc(sec.body)}</div>`;
        html += `<article class="res-card res-card--sample" data-sample-card>
          <div class="res-num">A</div>
          <div class="res-main">
            <div class="res-head">
              <span class="res-kind">Model answer</span>
              <span class="res-title">口语范例 ${sampleCount}</span>
              <div class="res-tools">
                ${enSents.length ? `<button class="btn-read" data-speak><i>▶</i> 朗读</button>
                <button class="btn btn-quiet btn-sm" data-stop-speak hidden>停止</button>` : ""}
              </div>
            </div>
            <div class="res-body">
              ${enHTML}
              ${s.zh ? `<details class="sample-zh"><summary>中文翻译</summary><div>${esc(s.zh)}</div></details>` : ""}
              ${s.words.length ? `<div class="words">${s.words.map(w => {
                const i = w.search(/[:：]/);
                if (i > 0) return `<span class="word-chip"><b>${esc(w.slice(0, i))}</b>${esc(w.slice(i + 1))}</span>`;
                return `<span class="word-chip">${esc(w)}</span>`;
              }).join("")}</div>` : ""}
            </div>
          </div>
        </article>`;
      } else {
        // 加分表达
        const items = bonusItems(sec.body);
        html += `<article class="res-card res-card--bonus">
          <div class="res-num">＋</div>
          <div class="res-main">
            <div class="res-head"><span class="res-kind">Bonus</span><span class="res-title">加分表达</span></div>
            <div class="res-body">
              ${items.length
                ? `<div class="bonus-grid">${items.map(it => `<div class="bonus-item"><b>${esc(it.en)}</b>${it.zh ? `<span>${esc(it.zh)}</span>` : ""}</div>`).join("")}</div>`
                : (sec.body ? `<div class="streaming">${esc(sec.body)}</div>` : '<div class="streaming"></div>')}
            </div>
          </div>
        </article>`;
      }
    }

    cards.innerHTML = html;
    bindSpeakButtons();
    actions.hidden = !state.ai.done;
  }

  function bindSpeakButtons() {
    $$("[data-speak]").forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        const card = btn.closest("[data-sample-card]");
        speakCard(card);
      });
    });
    $$("[data-stop-speak]").forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => { stopSpeak(); btn.hidden = true; });
    });
  }

  /* =========================================================
     9. 朗读（speechSynthesis）
     ========================================================= */
  const speak = { active: false, queue: [], idx: 0, nodes: [], lang: "en-US" };

  function pickVoice() {
    if (!("speechSynthesis" in window)) return null;
    const want = settings().voice;
    const voices = window.speechSynthesis.getVoices() || [];
    if (want) {
      const v = voices.find(x => x.voiceURI === want || x.name === want);
      if (v) return v;
    }
    return voices.find(v => /^en(-|_)/i.test(v.lang) && /samantha|zira|aria|jenny|google us english|english/i.test(v.name))
      || voices.find(v => /^en(-|_)/i.test(v.lang))
      || null;
  }

  function stopSpeak() {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    speak.active = false;
    speak.queue = [];
    speak.idx = 0;
    speak.nodes.forEach(n => n.classList.remove("active"));
    speak.nodes = [];
    $$("[data-stop-speak]").forEach(b => { b.hidden = true; });
  }

  function speakCard(card) {
    if (!card || !("speechSynthesis" in window)) { toast("这个浏览器不支持朗读"); return; }
    const nodes = $$("[data-sentence]", card);
    if (!nodes.length) return;
    stopSpeak();
    const synth = window.speechSynthesis;
    const rate = settings().rate || 1;
    const voice = pickVoice();
    speak.nodes = nodes;
    speak.idx = 0;
    speak.active = true;
    const stopBtn = $("[data-stop-speak]", card);
    if (stopBtn) stopBtn.hidden = false;

    const next = () => {
      if (!speak.active || speak.idx >= nodes.length) {
        stopSpeak();
        return;
      }
      const node = nodes[speak.idx];
      const u = new SpeechSynthesisUtterance(node.textContent);
      u.lang = "en-US";
      if (voice) u.voice = voice;
      u.rate = rate;
      u.pitch = 1;
      u.onstart = () => {
        nodes.forEach(n => n.classList.remove("active"));
        node.classList.add("active");
        node.scrollIntoView({ block: "center", behavior: "smooth" });
      };
      u.onend = () => { speak.idx += 1; next(); };
      u.onerror = () => { speak.idx += 1; next(); };
      synth.speak(u);
    };
    next();
  }

  /* =========================================================
     10. 历史
     ========================================================= */
  function saveHistoryIfDone() {
    const round = state.round;
    if (!round || !state.ai.done || state.ai.error) return;
    const list = loadJSON(LS_HISTORY, []);
    const entry = {
      id: "h" + Date.now(),
      at: round.at || Date.now(),
      mode: round.mode,
      p1topic: round.p1 ? round.p1.topic : "",
      p2prompt: round.p2 ? round.p2.prompt : "",
      round: round,
      text: state.ai.text
    };
    const filtered = list.filter(x => !(x.round && x.round.at === round.at && x.p2prompt === entry.p2prompt));
    filtered.unshift(entry);
    saveJSON(LS_HISTORY, filtered.slice(0, 20));
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderHistory() {
    const box = $("#historyList");
    if (!box) return;
    const list = loadJSON(LS_HISTORY, []);
    if (!list.length) {
      box.innerHTML = `<div class="empty">还没有练习记录。练完一轮会自动存在这里。</div>`;
      return;
    }
    box.innerHTML = list.map(x => `
      <div class="history-item" data-id="${esc(x.id)}">
        <div class="when">${esc(fmtDate(x.at))}</div>
        <div class="what">
          <b>${esc(x.p2prompt || "（无 Part 2 卡片）")}</b>
          <span>Part 1 · ${esc(x.p1topic || "—")}</span>
        </div>
        <span class="mode-badge">${x.mode === "past" ? "往届真题" : "题库"}</span>
      </div>`).join("");
    $$(".history-item").forEach(el => el.addEventListener("click", () => openHistory(el.dataset.id)));
  }

  function openHistory(id) {
    const list = loadJSON(LS_HISTORY, []);
    const item = list.find(x => x.id === id);
    if (!item) return;
    state.round = item.round;
    state.ai = { text: item.text || "", done: true, error: "", timer: null, startedAt: 0 };
    state.viewingHistoryId = id;
    go("result");
    renderResult(false);
  }

  /* =========================================================
     11. 设置弹窗
     ========================================================= */
  function fillVoiceOptions() {
    const sel = $("#selVoice");
    if (!sel) return;
    const s = settings();
    const voices = ("speechSynthesis" in window) ? window.speechSynthesis.getVoices() : [];
    const en = voices.filter(v => /^en(-|_)/i.test(v.lang));
    sel.innerHTML = `<option value="">自动选择（推荐）</option>` +
      en.map(v => `<option value="${esc(v.voiceURI)}"${s.voice === v.voiceURI ? " selected" : ""}>${esc(v.name)} · ${esc(v.lang)}</option>`).join("");
  }

  function openSettings() {
    const s = settings();
    $("#inpKey").value = s.apiKey || "";
    $("#inpBase").value = s.baseUrl || "";
    $("#inpModel").value = s.model || "deepseek-chat";
    $("#selRate").value = String(s.rate || 1);
    fillVoiceOptions();
    const hints = [];
    if (location.protocol === "file:") hints.push("现在是直接双击打开的（file://），接口默认连 https://api.deepseek.com。");
    else if (isPrivateHost()) hints.push("检测到通过本机 / 局域网服务打开，接口地址留空就会走本地代理。");
    else hints.push("当前是线上地址，接口地址留空会直连 https://api.deepseek.com（若浏览器报跨域，就把代理地址填进来）。");
    $("#baseHint").textContent = hints.join(" ") + " 接口地址留空 = 自动选择。";
    $("#settingsMask").classList.add("open");
  }

  function closeSettings() {
    $("#settingsMask").classList.remove("open");
  }

  /* =========================================================
     12. 事件绑定 + 启动
     ========================================================= */
  document.addEventListener("click", (e) => {
    const goBtn = e.target.closest("[data-go]");
    if (goBtn) { go(goBtn.dataset.go); }
    const scrollBtn = e.target.closest("[data-scroll]");
    if (scrollBtn) {
      const el = document.getElementById(scrollBtn.dataset.scroll);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  $$("[data-mode]").forEach(card => {
    card.addEventListener("click", () => openSetup(card.dataset.mode));
  });

  $("#btnStartPractice").addEventListener("click", startRound);

  $$("[data-settings]").forEach(b => b.addEventListener("click", openSettings));
  $("#btnCloseSettings").addEventListener("click", closeSettings);
  $("#settingsMask").addEventListener("click", (e) => {
    if (e.target === $("#settingsMask")) closeSettings();
  });
  $("#btnSaveSettings").addEventListener("click", () => {
    saveSettings({
      apiKey: $("#inpKey").value.trim(),
      baseUrl: $("#inpBase").value.trim(),
      model: $("#inpModel").value.trim() || "deepseek-chat",
      voice: $("#selVoice").value,
      rate: Number($("#selRate").value) || 1
    });
    closeSettings();
    toast("设置已保存");
  });

  $("#btnRetryAI").addEventListener("click", () => { stopSpeak(); runAI(); });
  $("#btnNextRound").addEventListener("click", () => {
    stopSpeak();
    state.viewingHistoryId = null;
    openSetup(state.mode);
  });
  $("#btnClearHistory").addEventListener("click", () => {
    if (!confirm("确定清空全部练习历史吗？")) return;
    saveJSON(LS_HISTORY, []);
    renderHistory();
    toast("历史已清空");
  });

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = fillVoiceOptions;
  }

  function finishRound() {
    go("result");
    runAI();
  }

  /* 把 config.js 里预填的设置（如果有）写进本机设置 */
  function applyConfigDefaults() {
    const cfg = window.IELTS_CONFIG || {};
    const stored = loadJSON(LS_SETTINGS, {});
    const patch = {};
    if (!stored.apiKey && cfg.apiKey) patch.apiKey = cfg.apiKey;
    if (!stored.baseUrl && cfg.baseUrl) patch.baseUrl = cfg.baseUrl;
    if (!stored.model && cfg.model) patch.model = cfg.model;
    if (Object.keys(patch).length) saveSettings(patch);
  }

  // 启动
  applyConfigDefaults();
  renderHomeStats();
  fillVoiceOptions();

  window.addEventListener("beforeunload", () => { stopTimer(); });
})();
