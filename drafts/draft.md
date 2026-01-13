## リクエスト

Android版FirefoxでChatGPTのチャット画面を開いて、チェックした会話の全部を私の発話とGPTの返答を1セットにしてPNG保存できるアドオンを作りたいです。
設定画面でプロファイルを複数件登録できて、プロファイルごとに
・特定ワードのマスク機能
・会話の背景色の変更（テーマカラーの設定）
ができて、1セット分の画像を複数枚を保存したいです。
自動で複数枚ダウンロードは難しいと思うので、新規タブに複数枚の画像を出して、私が手動で一枚ずつダウンロードしたいです

## 結論

Firefox（Android）向けの **WebExtension（Manifest V3）** として、ChatGPTの各ターン（「あなたの発話」＋「GPTの返答」）を **選択（チェック）→ 1ターン=1枚のPNG** で生成し、**新規タブ（拡張機能ページ）に複数枚一覧表示**して、あなたが **手動で1枚ずつ保存**する方式で実現できます。
要件の「プロファイル複数登録」「特定ワードのマスク」「背景色（テーマカラー）変更」も、拡張の `options_ui` とコンテンツ側のレンダリング処理で対応できます。

---

## 推論過程

### なぜ「新規タブに複数枚表示」方式が適切か

* Firefox for Android では、過去に `downloads.download` の制約が話題になっており（現在も環境差が出やすい）、**自動で複数ファイルを連続ダウンロード**は UX/権限/挙動面で不安定になりがちです。
* 一方で、**拡張機能のページ（viewer）に画像を並べる**のはシンプルで、保存操作はブラウザ標準の「画像の保存」に任せられます。

### どうやって「DOM→PNG」を作るか

* `tabs.captureVisibleTab` は「画面に見えている範囲」しか撮れないため不適。
* そこで、コンテンツスクリプト側で **選択したターンを複製してオフスクリーンに配置→ html2canvas でレンダリング**が現実的です（外部コード読み込みは禁止なので、ライブラリは拡張に同梱）。Manifest V3 の CSP もこの方針と整合します。

### Androidでの配布/インストール前提

* Android版Firefoxで「ファイルから拡張機能（XPI）を入れる」手順はデバッグメニュー経由で存在しますが、**署名済みXPIが必要**という前提が付きます。
* 開発中は `web-ext run --target=firefox-android` で実機テストが可能です。
* AMO配布・署名を視野に入れるなら、`browser_specific_settings.gecko.id` などの add-on ID 周りも最初から入れておくのが安全です。

---

## 代替案／仮説

1. **（代替）Markdownテキストだけ抽出して自前レイアウトで描画**

   * DOM依存が減って壊れにくい一方、コードブロックや数式・装飾の再現コストが上がります。
2. **（代替）PDFに「印刷」→画像化**

   * 1ターン=1枚の要件と相性が悪い（分割や余白調整が面倒）。
3. **（仮説）ChatGPTのDOM属性変更リスク**

   * `data-message-author-role` 等が将来変わる可能性があります。
   * 対策として、セレクタを複数持ち、見つからない場合にフォールバックする設計にします（今回の実装もその方向で組みます）。

---

## 実行手順

### 1) 拡張機能の構成（フォルダ）

以下の構造で作成してください。

```
chatgpt-turn-exporter/
  manifest.json
  background.js
  content/
    overlay.css
    content_script.js
    vendor/
      html2canvas.min.js
  options/
    options.html
    options.css
    options.js
  viewer/
    viewer.html
    viewer.css
    viewer.js
```

### 2) `html2canvas` を同梱

外部URLから読み込む方式は避け、拡張に同梱してください（ポリシー/CSP的に安全）。
例（PCで作業）:

```bash
npm i html2canvas
cp node_modules/html2canvas/dist/html2canvas.min.js content/vendor/
```

### 3) コード一式

#### `manifest.json`（MV3）

```json
{
  "manifest_version": 3,
  "name": "ChatGPT Turn Exporter (PNG)",
  "version": "0.1.0",
  "description": "Export selected ChatGPT turns (user + assistant) as PNG images into a viewer tab.",
  "permissions": ["storage", "tabs"],
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*"
  ],
  "background": {
    "scripts": ["background.js"]
  },
  "options_ui": {
    "page": "options/options.html",
    "open_in_tab": true
  },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      "js": [
        "content/vendor/html2canvas.min.js",
        "content/content_script.js"
      ],
      "css": ["content/overlay.css"],
      "run_at": "document_idle"
    }
  ],
  "browser_specific_settings": {
    "gecko": {
      "id": "chatgpt-turn-exporter@example.com"
    }
  }
}
```

#### `background.js`

```javascript
/* global browser */

function randomId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `sess_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function waitTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      resolve(); // タイムアウトしても進める（viewer側が後で起動する可能性）
    }, timeoutMs);

    const listener = (id, changeInfo) => {
      if (id !== tabId) return;
      if (changeInfo.status === "complete") {
        if (done) return;
        done = true;
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    browser.tabs.onUpdated.addListener(listener);
  });
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "cgexport_open_viewer") {
    const sessionId = randomId();
    const url = browser.runtime.getURL(`viewer/viewer.html?session=${encodeURIComponent(sessionId)}`);
    const tab = await browser.tabs.create({ url });
    await waitTabComplete(tab.id);
    return { sessionId, tabId: tab.id };
  }
});
```

#### `content/overlay.css`

```css
/* 画面上に重ねるUI（モバイル想定で小さめ） */

:root.cgexport-selection-off .cgexport-turn-control {
  display: none !important;
}

#cgexport-panel {
  position: fixed;
  right: 12px;
  bottom: 12px;
  z-index: 2147483647;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  width: min(92vw, 320px);
}

#cgexport-panel .cgexport-card {
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  border-radius: 14px;
  padding: 10px 10px 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  backdrop-filter: blur(8px);
}

#cgexport-panel .row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

#cgexport-panel select,
#cgexport-panel button {
  font-size: 13px;
}

#cgexport-panel select {
  flex: 1;
  border-radius: 10px;
  padding: 6px 8px;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.10);
  color: #fff;
}

#cgexport-panel button {
  border-radius: 10px;
  padding: 6px 10px;
  border: 1px solid rgba(255,255,255,0.18);
  background: rgba(255,255,255,0.10);
  color: #fff;
}

#cgexport-panel button.primary {
  background: rgba(59, 130, 246, 0.75);
  border-color: rgba(59, 130, 246, 0.95);
}

#cgexport-panel .meta {
  font-size: 12px;
  opacity: 0.9;
  line-height: 1.35;
}

.cgexport-turn-control {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 9999;
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 2px 8px 2px 6px;
  border-radius: 999px;
  background: rgba(0,0,0,0.55);
  color: #fff;
  font-size: 12px;
}

.cgexport-turn-control input {
  width: 16px;
  height: 16px;
}
```

#### `content/content_script.js`

```javascript
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

  // ルートにクラスを付けて制御
  document.documentElement.classList.add("cgexport-selection-off");

  // viewer ready を先に受け取ってしまうレース対策：常時リスナで記録
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
      name: "Default",
      maskWords: [],
      maskCaseInsensitive: false,
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
    return state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0];
  }

  function injectPanel() {
    if (document.getElementById("cgexport-panel")) return;

    const panel = document.createElement("div");
    panel.id = "cgexport-panel";
    panel.innerHTML = `
      <div class="cgexport-card">
        <div class="row">
          <select id="cgexport-profile"></select>
          <button id="cgexport-toggle">Select</button>
        </div>
        <div class="row">
          <button id="cgexport-all">All</button>
          <button id="cgexport-none">None</button>
          <button class="primary" id="cgexport-export">Export</button>
        </div>
        <div class="meta" id="cgexport-meta">Selected: 0</div>
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
      panel.querySelector("#cgexport-toggle").textContent = state.selectionEnabled ? "Selecting…" : "Select";
      scheduleSync();
    });

    panel.querySelector("#cgexport-all").addEventListener("click", () => {
      const turns = getTurns();
      turns.forEach(t => state.selectedTurnUids.add(t.uid));
      updateAllCheckboxes(true);
      updateMeta();
    });

    panel.querySelector("#cgexport-none").addEventListener("click", () => {
      state.selectedTurnUids.clear();
      updateAllCheckboxes(false);
      updateMeta();
    });

    panel.querySelector("#cgexport-export").addEventListener("click", () => {
      exportSelected().catch(err => {
        console.error(err);
        setMeta(`Export failed: ${String(err?.message ?? err)}`);
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
    setMeta(`Selected: ${state.selectedTurnUids.size}`);
  }

  function updateAllCheckboxes(checked) {
    document.querySelectorAll(".cgexport-turn-control input[type=checkbox]").forEach(cb => {
      cb.checked = checked;
    });
  }

  function startObservers() {
    const root = document.querySelector("main") || document.body;
    const mo = new MutationObserver(() => scheduleSync());
    mo.observe(root, { childList: true, subtree: true });

    // SPA遷移対策（URLが変わるだけのケース）
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
    return nodes.filter(n => !n.closest("#cgexport-sandbox") && !n.closest("#cgexport-panel"));
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
          // assistant / system / tool 等を「返答側」に含める
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
    const uid = (crypto?.randomUUID ? crypto.randomUUID() : `t_${Date.now()}_${Math.random().toString(16).slice(2)}`);
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

    // position: static の場合のみ relative を付与（レイアウト崩れを最小化）
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
    const selected = getTurns().filter(t => state.selectedTurnUids.has(t.uid));
    if (selected.length === 0) {
      setMeta("Selected: 0 (nothing to export)");
      return;
    }

    setMeta(`Opening viewer… (${selected.length} turns)`);
    const { sessionId } = await browser.runtime.sendMessage({ type: "cgexport_open_viewer" });

    await waitForViewerReady(sessionId);
    setMeta(`Rendering… 0/${selected.length}`);

    const profile = getActiveProfile();
    for (let i = 0; i < selected.length; i++) {
      setMeta(`Rendering… ${i + 1}/${selected.length}`);
      const buf = await renderTurnToPngBuffer(selected[i], profile);
      const filename = buildFileName(profile, i + 1);
      // viewer へ（broadcast だが sessionId で受信側がフィルタする）
      await browser.runtime.sendMessage({
        type: "cgexport_add_image",
        sessionId,
        filename,
        data: buf
      });
    }

    await browser.runtime.sendMessage({ type: "cgexport_export_done", sessionId });
    setMeta(`Done. Exported: ${selected.length}`);
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
          reject(new Error("viewer not ready (timeout)"));
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

  function applyMask(root, words, caseInsensitive) {
    const list = (words || []).map(w => String(w).trim()).filter(Boolean);
    if (list.length === 0) return;

    const flags = caseInsensitive ? "gi" : "g";
    const rules = list.map(w => ({
      w,
      re: new RegExp(escapeRegExp(w), flags)
    }));

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const textNode of nodes) {
      let v = textNode.nodeValue || "";
      for (const r of rules) {
        v = v.replace(r.re, "█".repeat(r.w.length));
      }
      textNode.nodeValue = v;
    }
  }

  async function waitImagesLoaded(root, timeoutMs = 4000) {
    const imgs = Array.from(root.querySelectorAll("img"));
    if (imgs.length === 0) return;

    await Promise.all(imgs.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        const t = setTimeout(resolve, timeoutMs);
        img.onload = () => { clearTimeout(t); resolve(); };
        img.onerror = () => { clearTimeout(t); resolve(); };
      });
    }));
  }

  function removeExporterUI(root) {
    root.querySelectorAll(".cgexport-turn-control").forEach(n => n.remove());
    root.querySelectorAll("#cgexport-panel").forEach(n => n.remove());
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

    applyMask(userClone, profile.maskWords, !!profile.maskCaseInsensitive);
    applyMask(assistantWrap, profile.maskWords, !!profile.maskCaseInsensitive);

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

    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const buf = await blob.arrayBuffer();

    sandbox.removeChild(card);
    return buf;
  }
})();
```

#### `viewer/viewer.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChatGPT Turn Exporter – Viewer</title>
  <link rel="stylesheet" href="viewer.css" />
</head>
<body>
  <header>
    <h1>Exported PNGs</h1>
    <p class="hint">
      Save manually: long-press an image (Android) or use the “Download” link.
    </p>
    <div id="status" class="status">Waiting…</div>
  </header>

  <main id="grid" class="grid"></main>

  <script src="viewer.js"></script>
</body>
</html>
```

#### `viewer/viewer.css`

```css
:root {
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}

body {
  margin: 0;
  padding: 16px;
  background: #0b0f17;
  color: #e5e7eb;
}

header {
  position: sticky;
  top: 0;
  background: rgba(11,15,23,0.85);
  backdrop-filter: blur(8px);
  padding: 10px 0 14px;
  z-index: 10;
}

h1 {
  font-size: 18px;
  margin: 0 0 6px;
}

.hint {
  margin: 0 0 10px;
  opacity: 0.85;
  font-size: 13px;
}

.status {
  font-size: 13px;
  opacity: 0.9;
}

.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 14px;
  margin-top: 14px;
}

.card {
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 14px;
  overflow: hidden;
  background: rgba(255,255,255,0.04);
}

.card .meta {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-top: 1px solid rgba(255,255,255,0.10);
}

.card .meta .name {
  font-size: 13px;
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 70%;
}

.card .meta a {
  font-size: 13px;
  color: #93c5fd;
  text-decoration: none;
}

.card img {
  width: 100%;
  height: auto;
  display: block;
}
```

#### `viewer/viewer.js`

```javascript
/* global browser */

(async () => {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session") || "";
  const statusEl = document.getElementById("status");
  const grid = document.getElementById("grid");

  let count = 0;

  // viewer 起動通知（content_script 側が待つ）
  try {
    const tab = await browser.tabs.getCurrent();
    await browser.runtime.sendMessage({
      type: "cgexport_viewer_ready",
      sessionId,
      tabId: tab?.id ?? null
    });
  } catch {
    // ignore
  }

  setStatus("Ready. Waiting for images…");

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.sessionId !== sessionId) return;

    if (msg.type === "cgexport_add_image") {
      addImage(msg.filename, msg.data);
    }
    if (msg.type === "cgexport_export_done") {
      setStatus(`Done. Images: ${count}`);
    }
  });

  function setStatus(t) {
    statusEl.textContent = t;
  }

  function addImage(filename, arrayBuffer) {
    const blob = new Blob([arrayBuffer], { type: "image/png" });
    const url = URL.createObjectURL(blob);

    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.src = url;
    img.alt = filename;

    const meta = document.createElement("div");
    meta.className = "meta";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = filename;

    const links = document.createElement("div");

    const open = document.createElement("a");
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = "Open";

    const dl = document.createElement("a");
    dl.href = url;
    dl.download = filename;
    dl.textContent = "Download";
    dl.style.marginLeft = "10px";

    links.appendChild(open);
    links.appendChild(dl);

    meta.appendChild(name);
    meta.appendChild(links);

    card.appendChild(img);
    card.appendChild(meta);

    grid.appendChild(card);

    count++;
    setStatus(`Receiving… Images: ${count}`);
  }
})();
```

#### `options/options.html`

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ChatGPT Turn Exporter – Options</title>
  <link rel="stylesheet" href="options.css" />
</head>
<body>
  <h1>Profiles</h1>

  <section class="list">
    <div class="row">
      <button id="add">Add profile</button>
    </div>
    <div id="profiles"></div>
  </section>

  <hr />

  <section class="editor">
    <h2>Edit</h2>
    <form id="form">
      <input type="hidden" id="id" />

      <label>
        Name
        <input id="name" required />
      </label>

      <label>
        Theme color (background)
        <input id="themeColor" type="color" />
      </label>

      <label>
        Output width (px)
        <input id="widthPx" type="number" min="320" max="2000" step="10" />
      </label>

      <label>
        Padding (px)
        <input id="paddingPx" type="number" min="0" max="200" step="1" />
      </label>

      <label>
        Scale (html2canvas)
        <input id="scale" type="number" min="1" max="4" step="0.25" />
      </label>

      <label class="check">
        <input id="maskCaseInsensitive" type="checkbox" />
        Mask case-insensitive
      </label>

      <label>
        Mask words (one per line)
        <textarea id="maskWords" rows="6"></textarea>
      </label>

      <div class="row">
        <button type="submit">Save</button>
        <button type="button" id="del">Delete</button>
      </div>
    </form>
  </section>

  <script src="options.js"></script>
</body>
</html>
```

#### `options/options.css`

```css
:root { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }

body { margin: 0; padding: 16px; max-width: 900px; }

h1 { margin: 0 0 12px; }
h2 { margin: 0 0 10px; }

.row { display: flex; gap: 10px; align-items: center; margin: 10px 0; }

#profiles .item {
  display: grid;
  grid-template-columns: 26px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 10px 8px;
  border: 1px solid #ddd;
  border-radius: 10px;
  margin-bottom: 10px;
}

label { display: grid; gap: 6px; margin: 10px 0; }

textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.check { display: flex; gap: 10px; align-items: center; }
```

#### `options/options.js`

```javascript
/* global browser */

(() => {
  const STORAGE_PROFILES = "cgexport_profiles_v1";
  const STORAGE_ACTIVE = "cgexport_active_profile_id_v1";

  const els = {
    profiles: document.getElementById("profiles"),
    add: document.getElementById("add"),
    form: document.getElementById("form"),
    del: document.getElementById("del"),
    id: document.getElementById("id"),
    name: document.getElementById("name"),
    themeColor: document.getElementById("themeColor"),
    widthPx: document.getElementById("widthPx"),
    paddingPx: document.getElementById("paddingPx"),
    scale: document.getElementById("scale"),
    maskCaseInsensitive: document.getElementById("maskCaseInsensitive"),
    maskWords: document.getElementById("maskWords")
  };

  let profiles = [];
  let activeId = null;

  init().catch(console.error);

  async function init() {
    await load();
    renderList();
    bind();
    if (profiles[0]) loadToEditor(profiles.find(p => p.id === activeId) || profiles[0]);
  }

  function bind() {
    els.add.addEventListener("click", async () => {
      const p = newProfile();
      profiles.push(p);
      activeId = p.id;
      await save();
      renderList();
      loadToEditor(p);
    });

    els.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const p = readFromEditor();
      const idx = profiles.findIndex(x => x.id === p.id);
      if (idx >= 0) profiles[idx] = p;
      else profiles.push(p);
      await save();
      renderList();
    });

    els.del.addEventListener("click", async () => {
      const id = els.id.value;
      if (!id) return;
      if (profiles.length <= 1) {
        alert("At least one profile is required.");
        return;
      }
      profiles = profiles.filter(p => p.id !== id);
      if (activeId === id) activeId = profiles[0].id;
      await save();
      renderList();
      loadToEditor(profiles.find(p => p.id === activeId) || profiles[0]);
    });
  }

  async function load() {
    const got = await browser.storage.local.get([STORAGE_PROFILES, STORAGE_ACTIVE]);
    profiles = Array.isArray(got[STORAGE_PROFILES]) ? got[STORAGE_PROFILES] : [];
    activeId = typeof got[STORAGE_ACTIVE] === "string" ? got[STORAGE_ACTIVE] : (profiles[0]?.id ?? null);
  }

  async function save() {
    await browser.storage.local.set({
      [STORAGE_PROFILES]: profiles,
      [STORAGE_ACTIVE]: activeId
    });
  }

  function renderList() {
    els.profiles.innerHTML = "";
    for (const p of profiles) {
      const item = document.createElement("div");
      item.className = "item";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "active";
      radio.checked = p.id === activeId;
      radio.addEventListener("change", async () => {
        activeId = p.id;
        await save();
        renderList();
      });

      const name = document.createElement("div");
      name.textContent = p.name;

      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => loadToEditor(p));

      item.appendChild(radio);
      item.appendChild(name);
      item.appendChild(edit);

      els.profiles.appendChild(item);
    }
  }

  function loadToEditor(p) {
    els.id.value = p.id;
    els.name.value = p.name ?? "";
    els.themeColor.value = p.themeColor ?? "#0b1220";
    els.widthPx.value = p.widthPx ?? 980;
    els.paddingPx.value = p.paddingPx ?? 24;
    els.scale.value = p.scale ?? 2;
    els.maskCaseInsensitive.checked = !!p.maskCaseInsensitive;
    els.maskWords.value = (p.maskWords || []).join("\n");
  }

  function readFromEditor() {
    return {
      id: els.id.value,
      name: els.name.value.trim(),
      themeColor: els.themeColor.value,
      widthPx: Number(els.widthPx.value || 980),
      paddingPx: Number(els.paddingPx.value || 24),
      scale: Number(els.scale.value || 2),
      maskCaseInsensitive: !!els.maskCaseInsensitive.checked,
      maskWords: els.maskWords.value
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean)
    };
  }

  function newProfile() {
    const id = (crypto?.randomUUID ? crypto.randomUUID() : `p_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    return {
      id,
      name: `Profile ${profiles.length + 1}`,
      maskWords: [],
      maskCaseInsensitive: false,
      themeColor: "#0b1220",
      widthPx: 980,
      paddingPx: 24,
      scale: 2
    };
  }
})();
```

---

## 4) 開発・テスト・インストール

### 開発中の実機テスト（推奨）

PCとAndroid端末をつないで、`web-ext` で実機起動できます。

```bash
npm i -g web-ext
cd chatgpt-turn-exporter
web-ext run --target=firefox-android --android-device=<device-id>
```

### 端末にXPIを入れて使う（環境依存あり）

* Android版Firefoxの設定で **About Firefox** からロゴを5回タップしてデバッグメニューを出し、「Install add-on from file」でXPIを選ぶ手順が知られています。
* ただし一般に **署名済みXPIが必要**です（未署名は弾かれます）。
  署名が必要なら、AMOで unlisted として署名取得する運用を検討してください（方針は変わり得るため、最終的にはAMOの現行手順に従ってください）。

---

## 5) 使い方（ユーザー操作フロー）

1. Android版Firefoxで ChatGPT のチャット画面を開く
2. 右下のパネルで **Select** を押して選択モードにする
3. 各ユーザー発話の左上に出る **チェック** を付ける
4. **Export** を押す
5. 新規タブ（viewer）が開き、PNGが順に並ぶ
6. viewer上で各画像を **長押し → 画像を保存**（または Download リンク）で保存

---

## 参考情報

* Firefox for Android での拡張機能エコシステム（AMO上でのAndroid拡張公開）
* Manifest V3 の移行・CSP等の注意点
* 背景スクリプト（MV2/MV3の非永続化の扱い）
* `browser_specific_settings.gecko.id`（署名/配布に必要になる add-on ID の話）
* `web-ext run --target=firefox-android` による実機テスト手順
* Androidで「ファイルからアドオン」を入れる導線（署名前提の言及含む）

---

必要なら次の改良も、コード差分（git diff形式）で即入れられます。

* 「返答側に含める範囲」を設定（assistantだけ/ toolも含む等）
* ターン検出セレクタの強化（DOM変更耐性）
* 画像が混ざる回答のCORS対策（表示欠けの回避策）
* 「チェックUIをユーザー発話ではなくターン全体に付ける」表示調整（好みのUX）
