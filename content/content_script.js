/* global browser, html2canvas */

(() => {
  if (window.__cgexportInjected) return;
  window.__cgexportInjected = true;

  const STORAGE_PROFILES = "cgexport_profiles_v1";
  const STORAGE_ACTIVE = "cgexport_active_profile_id_v1";

  const THEME_PRESETS = {
    "gpt-red": {
      label: "赤",
      gptBg: "#ffd6d6",
      userBg: "#d9f5ff"
    },
    "gpt-orange": {
      label: "橙",
      gptBg: "#ffe1c4",
      userBg: "#d6e4ff"
    },
    "gpt-yellow": {
      label: "黄",
      gptBg: "#fff4c2",
      userBg: "#e3dcff"
    },
    "gpt-green": {
      label: "緑",
      gptBg: "#dff5e1",
      userBg: "#f8dbe8"
    },
    "gpt-blue": {
      label: "青",
      gptBg: "#dbe9ff",
      userBg: "#fff3cc"
    },
    "gpt-indigo": {
      label: "藍",
      gptBg: "#e1dcff",
      userBg: "#ffe6bf"
    },
    "gpt-violet": {
      label: "紫",
      gptBg: "#f0dcff",
      userBg: "#e7f5cf"
    }
  };
  const DEFAULT_THEME_ID = "gpt-green";
  const DEFAULT_USER_NAME = "ユーザー";
  const DEFAULT_GPT_NAME = "GPT";

  const state = {
    profiles: [],
    activeProfileId: null,
    selectedTurnUids: new Set(),
    viewerReadySessions: new Set(),
    viewerReadyResolvers: new Map(),
    selectionEnabled: false,
    lastSyncAt: 0,
    syncScheduled: false,
    fallbackCount: 0,
    textFallbackCount: 0,
    requestTimestamp: ""
  };

  document.documentElement.classList.add("cgexport-selection-off");

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "cgexport_viewer_ready" && msg.sessionId) {
      state.viewerReadySessions.add(msg.sessionId);
      const resolver = state.viewerReadyResolvers.get(msg.sessionId);
      if (resolver) {
        state.viewerReadyResolvers.delete(msg.sessionId);
        resolver(msg);
      }
    }
  });

  init().catch(console.error);

  async function init() {
    await ensureDefaultProfiles();
    await loadProfiles();
    injectPanel();
    startObservers();
    scheduleSync();
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      if (changes[STORAGE_PROFILES] || changes[STORAGE_ACTIVE]) {
        await loadProfiles();
        refreshProfileSelect();
      }
    });
  }

  async function ensureDefaultProfiles() {
    const got = await browser.storage.local.get([STORAGE_PROFILES, STORAGE_ACTIVE]);
    if (Array.isArray(got[STORAGE_PROFILES]) && got[STORAGE_PROFILES].length > 0) return;

    const defaultProfile = {
      id: "default",
      name: "デフォルト",
      maskWords: [],
      maskCaseInsensitive: false,
      themeColor: "#0b1220",
      themeId: DEFAULT_THEME_ID,
      userName: DEFAULT_USER_NAME,
      gptName: DEFAULT_GPT_NAME,
      widthPx: 360,
      paddingPx: 24,
      scale: 2
    };

    await browser.storage.local.set({
      [STORAGE_PROFILES]: [defaultProfile],
      [STORAGE_ACTIVE]: "default"
    });
  }

  async function loadProfiles() {
    const got = await browser.storage.local.get([STORAGE_PROFILES, STORAGE_ACTIVE]);
    state.profiles = Array.isArray(got[STORAGE_PROFILES]) ? got[STORAGE_PROFILES] : [];
    state.activeProfileId = typeof got[STORAGE_ACTIVE] === "string" ? got[STORAGE_ACTIVE] : (state.profiles[0]?.id ?? null);
    if (!state.activeProfileId && state.profiles[0]) state.activeProfileId = state.profiles[0].id;
  }

  function getActiveProfile() {
    return state.profiles.find((p) => p.id === state.activeProfileId) || state.profiles[0];
  }

  function injectPanel() {
    if (document.getElementById("cgexport-panel")) return;

    const panel = document.createElement("div");
    panel.id = "cgexport-panel";
    panel.innerHTML = `
      <div class="cgexport-card">
        <div class="row">
          <select id="cgexport-profile"></select>
          <button id="cgexport-toggle">選択</button>
        </div>
        <div class="row">
          <button id="cgexport-all">全選択</button>
          <button id="cgexport-none">全解除</button>
          <button class="primary" id="cgexport-export">書き出し</button>
        </div>
        <div class="meta" id="cgexport-meta">選択中: 0</div>
      </div>
    `;

    document.body.appendChild(panel);

    refreshProfileSelect();

    panel.querySelector("#cgexport-profile").addEventListener("change", async (e) => {
      state.activeProfileId = e.target.value;
      await browser.storage.local.set({ [STORAGE_ACTIVE]: state.activeProfileId });
    });

    panel.querySelector("#cgexport-toggle").addEventListener("click", () => {
      state.selectionEnabled = !state.selectionEnabled;
      document.documentElement.classList.toggle("cgexport-selection-off", !state.selectionEnabled);
      panel.querySelector("#cgexport-toggle").textContent = state.selectionEnabled ? "選択中…" : "選択";
      scheduleSync();
    });

    panel.querySelector("#cgexport-all").addEventListener("click", () => {
      const turns = getTurns();
      turns.forEach((t) => state.selectedTurnUids.add(t.uid));
      updateAllCheckboxes(true);
      updateMeta();
    });

    panel.querySelector("#cgexport-none").addEventListener("click", () => {
      state.selectedTurnUids.clear();
      updateAllCheckboxes(false);
      updateMeta();
    });

    panel.querySelector("#cgexport-export").addEventListener("click", () => {
      exportSelected().catch((err) => {
        console.error(err);
        setMeta(`書き出し失敗: ${String(err?.message ?? err)}`);
      });
    });

    updateMeta();
  }

  function refreshProfileSelect() {
    const sel = document.getElementById("cgexport-profile");
    if (!sel) return;
    sel.innerHTML = "";
    for (const p of state.profiles) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    if (state.activeProfileId) sel.value = state.activeProfileId;
  }

  function setMeta(text) {
    const el = document.getElementById("cgexport-meta");
    if (el) el.textContent = text;
  }

  function updateMeta() {
    setMeta(`選択中: ${state.selectedTurnUids.size}`);
  }

  function updateAllCheckboxes(checked) {
    document.querySelectorAll(".cgexport-turn-control input[type=checkbox]").forEach((cb) => {
      cb.checked = checked;
    });
  }

  function startObservers() {
    const root = document.querySelector("main") || document.body;
    const mo = new MutationObserver(() => scheduleSync());
    mo.observe(root, { childList: true, subtree: true });

    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        scheduleSync(true);
      }
    }, 800);
  }

  function scheduleSync(force = false) {
    const now = Date.now();
    if (!force && now - state.lastSyncAt < 400) return;
    if (state.syncScheduled) return;
    state.syncScheduled = true;
    setTimeout(() => {
      state.syncScheduled = false;
      state.lastSyncAt = Date.now();
      syncTurnControls();
    }, 250);
  }

  function getMessageNodes() {
    const root = document.querySelector("main") || document.body;
    const nodes = Array.from(root.querySelectorAll("[data-message-author-role]"));
    return nodes.filter((n) => !n.closest("#cgexport-sandbox") && !n.closest("#cgexport-panel"));
  }

  function getTurns() {
    const nodes = getMessageNodes();

    const turns = [];
    let i = 0;

    while (i < nodes.length) {
      const role = nodes[i].getAttribute("data-message-author-role");

      if (role === "user") {
        const userNode = nodes[i];
        const assistantNodes = [];
        i++;

        while (i < nodes.length) {
          const r = nodes[i].getAttribute("data-message-author-role");
          if (r === "user") break;
          assistantNodes.push(nodes[i]);
          i++;
        }

        if (assistantNodes.length > 0) {
          const uid = ensureTurnUid(userNode);
          turns.push({ uid, userNode, assistantNodes });
        }
      } else {
        i++;
      }
    }

    return turns;
  }

  function ensureTurnUid(userNode) {
    if (userNode.dataset.cgexportTurnUid) return userNode.dataset.cgexportTurnUid;
    const uid = (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `t_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    userNode.dataset.cgexportTurnUid = uid;
    return uid;
  }

  function syncTurnControls() {
    const turns = getTurns();
    turns.forEach((t, idx) => attachTurnControl(t.userNode, t.uid, idx));
    updateMeta();
  }

  function attachTurnControl(userNode, uid, idx) {
    if (!state.selectionEnabled) return;

    const existing = userNode.querySelector(":scope > .cgexport-turn-control");
    if (existing) {
      const cb = existing.querySelector("input[type=checkbox]");
      if (cb) cb.checked = state.selectedTurnUids.has(uid);
      return;
    }

    try {
      const pos = getComputedStyle(userNode).position;
      if (pos === "static") userNode.style.position = "relative";
    } catch {
      // ignore
    }

    const ctrl = document.createElement("div");
    ctrl.className = "cgexport-turn-control";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selectedTurnUids.has(uid);
    cb.addEventListener("change", () => {
      if (cb.checked) state.selectedTurnUids.add(uid);
      else state.selectedTurnUids.delete(uid);
      updateMeta();
    });

    const label = document.createElement("span");
    label.textContent = `#${idx + 1}`;

    ctrl.appendChild(cb);
    ctrl.appendChild(label);
    userNode.prepend(ctrl);
  }

  async function exportSelected() {
    if (typeof html2canvas !== "function") {
      setMeta("書き出し失敗: html2canvas が見つかりません");
      return;
    }

    const selected = getTurns().filter((t) => state.selectedTurnUids.has(t.uid));
    if (selected.length === 0) {
      setMeta("選択中: 0（書き出し対象なし）");
      return;
    }

    state.fallbackCount = 0;
    state.textFallbackCount = 0;
    state.requestTimestamp = formatRequestTimestamp(new Date());
    setMeta(`表示タブを開いています… (${selected.length}件)`);
    const { sessionId } = await browser.runtime.sendMessage({ type: "cgexport_open_viewer" });

    await waitForViewerReady(sessionId);
    setMeta(`描画中… 0/${selected.length}`);

    const profile = getActiveProfile();
    for (let i = 0; i < selected.length; i++) {
      setMeta(`描画中… ${i + 1}/${selected.length}`);
      const buf = await renderTurnToPngBuffer(selected[i], profile);
      const filename = buildFileName(i + 1);
      await browser.runtime.sendMessage({
        type: "cgexport_add_image",
        sessionId,
        filename,
        data: buf
      });
    }

    await browser.runtime.sendMessage({ type: "cgexport_export_done", sessionId });
    const notes = [];
    if (state.fallbackCount > 0) notes.push(`画像/背景を除外: ${state.fallbackCount}件`);
    if (state.textFallbackCount > 0) notes.push(`テキストのみ: ${state.textFallbackCount}件`);
    if (notes.length > 0) setMeta(`完了: ${selected.length}件（${notes.join(" / ")}）`);
    else setMeta(`完了: ${selected.length}件`);
  }

  function formatRequestTimestamp(date) {
    const d = date instanceof Date ? date : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}${m}${day}${h}${min}`;
  }

  function buildFileName(index) {
    const stamp = state.requestTimestamp || formatRequestTimestamp(new Date());
    return `${stamp}_${index}.png`;
  }

  function waitForViewerReady(sessionId, timeoutMs = 15000) {
    if (state.viewerReadySessions.has(sessionId)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      state.viewerReadyResolvers.set(sessionId, resolve);
      setTimeout(() => {
        if (state.viewerReadyResolvers.has(sessionId)) {
          state.viewerReadyResolvers.delete(sessionId);
          reject(new Error("表示タブの準備が完了しませんでした（タイムアウト）"));
        }
      }, timeoutMs);
    });
  }

  function getSandbox() {
    let sb = document.getElementById("cgexport-sandbox");
    if (sb) return sb;

    sb = document.createElement("div");
    sb.id = "cgexport-sandbox";
    sb.style.position = "fixed";
    sb.style.left = "-100000px";
    sb.style.top = "0";
    sb.style.width = "2000px";
    sb.style.pointerEvents = "none";
    sb.style.zIndex = "-1";
    document.body.appendChild(sb);
    return sb;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getMaskWords(profile) {
    const words = Array.isArray(profile?.maskWords) ? profile.maskWords : [];
    if (words.length > 0) {
      return words.map((w) => String(w ?? "").trim()).filter(Boolean);
    }

    const pairs = Array.isArray(profile?.maskPairs) ? profile.maskPairs : [];
    return pairs.map((p) => String(p?.from ?? "").trim()).filter(Boolean);
  }

  function applyMask(root, profile) {
    const list = getMaskWords(profile);
    if (list.length === 0) return;

    const flags = profile?.maskCaseInsensitive ? "gi" : "g";
    const rules = list.map((w) => ({
      w,
      re: new RegExp(escapeRegExp(w), flags)
    }));

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const textNode of nodes) {
      let v = textNode.nodeValue || "";
      for (const r of rules) {
        v = v.replace(r.re, "*".repeat(r.w.length));
      }
      textNode.nodeValue = v;
    }
  }

  function resolveThemeColors(profile) {
    if (profile?.userBgColor || profile?.gptBgColor) {
      return {
        userBg: profile.userBgColor || THEME_PRESETS[DEFAULT_THEME_ID].userBg,
        gptBg: profile.gptBgColor || THEME_PRESETS[DEFAULT_THEME_ID].gptBg
      };
    }

    const themeId = profile?.themeId;
    if (themeId && THEME_PRESETS[themeId]) return THEME_PRESETS[themeId];
    return THEME_PRESETS[DEFAULT_THEME_ID];
  }

  function applyTurnBackground(root, color) {
    if (!root || !color) return;
    root.style.background = color;
    root.style.borderRadius = "14px";
    root.style.padding = "10px 12px";
    root.style.boxSizing = "border-box";
  }

  function extractTextFromNode(node, profile) {
    if (!node) return "";
    const sandbox = getSandbox();
    const clone = node.cloneNode(true);
    removeExporterUI(clone);
    applyMask(clone, profile);
    stripMediaElements(clone);
    sandbox.appendChild(clone);
    let text = "";
    try {
      text = clone.innerText || clone.textContent || "";
    } finally {
      if (clone.parentNode === sandbox) sandbox.removeChild(clone);
    }
    return String(text).trim();
  }

  function wrapTextLines(ctx, text, maxWidth) {
    const lines = [];
    const paragraphs = String(text || "").split(/\n/);
    for (const para of paragraphs) {
      if (para.length === 0) {
        lines.push("");
        continue;
      }
      let line = "";
      for (const ch of para) {
        const test = line + ch;
        if (ctx.measureText(test).width > maxWidth && line.length > 0) {
          lines.push(line);
          line = ch;
        } else {
          line = test;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  function drawRoundedRect(ctx, x, y, w, h, r, fill) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  async function waitImagesLoaded(root, timeoutMs = 4000) {
    const imgs = Array.from(root.querySelectorAll("img"));
    if (imgs.length === 0) return;

    await Promise.all(
      imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          const t = setTimeout(resolve, timeoutMs);
          img.onload = () => {
            clearTimeout(t);
            resolve();
          };
          img.onerror = () => {
            clearTimeout(t);
            resolve();
          };
        });
      })
    );
  }

  function removeExporterUI(root) {
    root.querySelectorAll(".cgexport-turn-control").forEach((n) => n.remove());
    root.querySelectorAll("#cgexport-panel").forEach((n) => n.remove());
  }

  function stripMediaElements(root) {
    root.querySelectorAll("img, video, svg, canvas, iframe, object, embed, audio, picture, source").forEach((n) => n.remove());
  }

  function stripBackgroundImages(root) {
    root.querySelectorAll("*").forEach((el) => {
      el.style.backgroundImage = "none";
    });
  }

  function buildRenderCard(turn, profile, options) {
    const sandbox = getSandbox();

    const card = document.createElement("div");
    card.style.boxSizing = "border-box";
    card.style.width = `${Number(profile.widthPx || 980)}px`;
    card.style.padding = `${Number(profile.paddingPx || 24)}px`;
    card.style.borderRadius = "18px";
    card.style.background = String(profile.themeColor || "#0b1220");
    card.style.overflow = "hidden";

    const userClone = turn.userNode.cloneNode(true);
    const assistantWrap = document.createElement("div");
    assistantWrap.style.marginTop = "12px";
    for (const n of turn.assistantNodes) assistantWrap.appendChild(n.cloneNode(true));

    removeExporterUI(userClone);
    removeExporterUI(assistantWrap);

    applyMask(userClone, profile);
    applyMask(assistantWrap, profile);

    const theme = resolveThemeColors(profile);
    applyTurnBackground(userClone, theme.userBg);
    applyTurnBackground(assistantWrap, theme.gptBg);

    if (options?.stripMedia) {
      stripMediaElements(userClone);
      stripMediaElements(assistantWrap);
    }
    if (options?.stripBackgrounds) {
      stripBackgroundImages(userClone);
      stripBackgroundImages(assistantWrap);
    }

    card.appendChild(userClone);
    card.appendChild(assistantWrap);
    sandbox.appendChild(card);
    return { sandbox, card };
  }

  function isInsecureOperationError(err) {
    const msg = String(err?.message ?? err ?? "");
    return msg.includes("The operation is insecure") || msg.includes("SecurityError") || msg.includes("tainted");
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("PNG変換に失敗しました"));
        }, "image/png");
      } catch (err) {
        reject(err);
      }
    });
  }

  function resolveProfileName(value, fallback) {
    const v = String(value ?? "").trim();
    return v.length > 0 ? v : fallback;
  }

  function buildLabeledText(name, body) {
    const title = String(name ?? "").trim();
    const text = String(body ?? "").trim();
    if (title && text) return `${title}\n\n${text}`;
    if (title) return title;
    return text;
  }

  async function renderTurnToTextPngBuffer(turn, profile) {
    const theme = resolveThemeColors(profile);
    const width = Number(profile.widthPx || 980);
    const padding = Number(profile.paddingPx || 24);
    const gap = 12;
    const fontSize = Math.max(15, Math.min(18, Math.round(width * 0.047)));
    const bubblePadX = Math.round(fontSize * 0.75);
    const bubblePadY = Math.round(fontSize * 0.6);
    const lineHeight = Math.round(fontSize * 1.5);
    const font = `${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const textColor = "#334155";
    const sideIndent = Math.max(32, Math.min(96, Math.round(width * 0.08)));

    const userName = resolveProfileName(profile?.userName, DEFAULT_USER_NAME);
    const gptName = resolveProfileName(profile?.gptName, DEFAULT_GPT_NAME);
    const userBody = extractTextFromNode(turn.userNode, profile);
    const assistantBody = turn.assistantNodes
      .map((n) => extractTextFromNode(n, profile))
      .filter(Boolean)
      .join("\n\n");
    const userText = buildLabeledText(userName, userBody);
    const assistantText = buildLabeledText(gptName, assistantBody);

    const bubbleWidth = width - padding * 2 - sideIndent;
    const textMaxWidth = Math.max(10, bubbleWidth - bubblePadX * 2);
    const measureCanvas = document.createElement("canvas");
    const mctx = measureCanvas.getContext("2d");
    mctx.font = font;

    const userLines = wrapTextLines(mctx, userText, textMaxWidth);
    const assistantLines = wrapTextLines(mctx, assistantText, textMaxWidth);

    const userHeight = Math.max(lineHeight, userLines.length * lineHeight) + bubblePadY * 2;
    const assistantHeight = Math.max(lineHeight, assistantLines.length * lineHeight) + bubblePadY * 2;
    const totalHeight = padding + userHeight + gap + assistantHeight + padding;

    const scale = Number(profile.scale || 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(totalHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(Number.isFinite(scale) ? scale : 2, Number.isFinite(scale) ? scale : 2);

    ctx.fillStyle = String(profile.themeColor || "#0b1220");
    ctx.fillRect(0, 0, width, totalHeight);
    ctx.font = font;
    ctx.textBaseline = "top";

    let y = padding;
    const userX = padding;
    const gptX = padding + sideIndent;

    drawRoundedRect(ctx, userX, y, bubbleWidth, userHeight, 12, theme.userBg);
    let textY = y + bubblePadY;
    ctx.fillStyle = textColor;
    for (const line of userLines) {
      ctx.fillText(line, userX + bubblePadX, textY);
      textY += lineHeight;
    }

    y += userHeight + gap;
    drawRoundedRect(ctx, gptX, y, bubbleWidth, assistantHeight, 12, theme.gptBg);
    textY = y + bubblePadY;
    ctx.fillStyle = textColor;
    for (const line of assistantLines) {
      ctx.fillText(line, gptX + bubblePadX, textY);
      textY += lineHeight;
    }

    const blob = await canvasToBlob(canvas);
    return await blob.arrayBuffer();
  }

  async function renderTurnToPngBufferInternal(turn, profile, options) {
    const { sandbox, card } = buildRenderCard(turn, profile, options);
    try {
      if (!options?.stripMedia) {
        await waitImagesLoaded(card);
      }

      const scale = Number(profile.scale || 2);
      const canvas = await html2canvas(card, {
        backgroundColor: null,
        scale: Number.isFinite(scale) ? scale : 2,
        useCORS: true
      });

      const blob = await canvasToBlob(canvas);
      return await blob.arrayBuffer();
    } finally {
      if (card.parentNode === sandbox) sandbox.removeChild(card);
    }
  }

  async function renderTurnToPngBuffer(turn, profile) {
    try {
      return await renderTurnToPngBufferInternal(turn, profile, { stripMedia: false, stripBackgrounds: false });
    } catch (err) {
      if (!isInsecureOperationError(err)) throw err;
      try {
        const buf = await renderTurnToPngBufferInternal(turn, profile, { stripMedia: true, stripBackgrounds: true });
        state.fallbackCount++;
        return buf;
      } catch (err2) {
        if (!isInsecureOperationError(err2)) throw err2;
        state.textFallbackCount++;
        return await renderTurnToTextPngBuffer(turn, profile);
      }
    }
  }
})();
