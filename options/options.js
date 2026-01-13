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
    if (profiles[0]) loadToEditor(profiles.find((p) => p.id === activeId) || profiles[0]);
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
      const idx = profiles.findIndex((x) => x.id === p.id);
      if (idx >= 0) profiles[idx] = { ...profiles[idx], ...p };
      else profiles.push(p);
      await save();
      renderList();
    });

    els.del.addEventListener("click", async () => {
      const id = els.id.value;
      if (!id) return;
      if (profiles.length <= 1) {
        alert("少なくとも1件のプロファイルが必要です。");
        return;
      }
      profiles = profiles.filter((p) => p.id !== id);
      if (activeId === id) activeId = profiles[0].id;
      await save();
      renderList();
      loadToEditor(profiles.find((p) => p.id === activeId) || profiles[0]);
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
      edit.textContent = "編集";
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
    els.maskWords.value = getMaskWordsForEditor(p).join("\n");
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
        .map((s) => s.trim())
        .filter(Boolean)
    };
  }

  function newProfile() {
    const id = (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `p_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    return {
      id,
      name: `プロファイル ${profiles.length + 1}`,
      maskWords: [],
      maskCaseInsensitive: false,
      themeColor: "#0b1220",
      widthPx: 980,
      paddingPx: 24,
      scale: 2
    };
  }

  function getMaskWordsForEditor(p) {
    const words = Array.isArray(p.maskWords) ? p.maskWords : [];
    if (words.length > 0) return words.map((w) => String(w ?? "").trim()).filter(Boolean);

    const pairs = Array.isArray(p.maskPairs) ? p.maskPairs : [];
    return pairs.map((pair) => String(pair?.from ?? "").trim()).filter(Boolean);
  }
})();
