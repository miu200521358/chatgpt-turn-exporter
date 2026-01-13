/* global browser, html2canvas */

(() => {
  if (window.__cgexportInjected) return;
  window.__cgexportInjected = true;

  const STORAGE_PROFILES = "cgexport_profiles_v1";
  const STORAGE_ACTIVE = "cgexport_active_profile_id_v1";

  const state = {
    profiles: [],
    activeProfileId: null,
    selectedTurnUids: new Set(),
    viewerReadySessions: new Set(),
    viewerReadyResolvers: new Map(),
    selectionEnabled: false,
    lastSyncAt: 0,
    syncScheduled: false
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
      maskPairs: [],
      themeColor: "#0b1220",
      widthPx: 980,
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

    setMeta(`表示タブを開いています… (${selected.length}件)`);
    const { sessionId } = await browser.runtime.sendMessage({ type: "cgexport_open_viewer" });

    await waitForViewerReady(sessionId);
    setMeta(`描画中… 0/${selected.length}`);

    const profile = getActiveProfile();
    for (let i = 0; i < selected.length; i++) {
      setMeta(`描画中… ${i + 1}/${selected.length}`);
      const buf = await renderTurnToPngBuffer(selected[i], profile);
      const filename = buildFileName(profile, i + 1);
      await browser.runtime.sendMessage({
        type: "cgexport_add_image",
        sessionId,
        filename,
        data: buf
      });
    }

    await browser.runtime.sendMessage({ type: "cgexport_export_done", sessionId });
    setMeta(`完了: ${selected.length}件`);
  }

  function buildFileName(profile, index) {
    const base = (profile?.name || "chatgpt").replace(/[^\w\-]+/g, "_").slice(0, 32);
    return `${base}_turn_${String(index).padStart(3, "0")}.png`;
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

  function applyMask(root, profile) {
    const pairs = normalizeMaskPairs(profile);
    if (pairs.length > 0) {
      applyMaskPairs(root, pairs, !!profile?.maskCaseInsensitive);
      return;
    }

    applyMaskLegacy(root, profile);
  }

  function normalizeMaskPairs(profile) {
    const raw = Array.isArray(profile?.maskPairs) ? profile.maskPairs : [];
    return raw
      .map((p) => ({
        from: String(p?.from ?? "").trim(),
        to: String(p?.to ?? "")
      }))
      .filter((p) => p.from.length > 0);
  }

  function applyMaskPairs(root, pairs, caseInsensitive) {
    const flags = caseInsensitive ? "gi" : "g";
    const rules = pairs.map((p) => ({
      from: p.from,
      to: p.to,
      re: new RegExp(escapeRegExp(p.from), flags)
    }));

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const textNode of nodes) {
      let v = textNode.nodeValue || "";
      for (const r of rules) {
        v = v.replace(r.re, r.to);
      }
      textNode.nodeValue = v;
    }
  }

  function applyMaskLegacy(root, profile) {
    const list = (profile?.maskWords || []).map((w) => String(w).trim()).filter(Boolean);
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

  async function renderTurnToPngBuffer(turn, profile) {
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

    card.appendChild(userClone);
    card.appendChild(assistantWrap);
    sandbox.appendChild(card);

    await waitImagesLoaded(card);

    const scale = Number(profile.scale || 2);
    const canvas = await html2canvas(card, {
      backgroundColor: null,
      scale: Number.isFinite(scale) ? scale : 2,
      useCORS: true
    });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const buf = await blob.arrayBuffer();

    sandbox.removeChild(card);
    return buf;
  }
})();
