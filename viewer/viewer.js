/* global browser */

(() => {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session") || "";
  const statusEl = document.getElementById("status");
  const grid = document.getElementById("grid");

  let count = 0;

  (async () => {
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
  })();

  setStatus("準備完了。画像の受信待ち…");

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.sessionId !== sessionId) return;

    if (msg.type === "cgexport_add_image") {
      addImage(msg.filename, msg.data);
    }
    if (msg.type === "cgexport_export_done") {
      setStatus(`完了: 画像 ${count} 件`);
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
    open.textContent = "開く";

    const dl = document.createElement("a");
    dl.href = url;
    dl.download = filename;
    dl.textContent = "保存";
    dl.style.marginLeft = "10px";

    links.appendChild(open);
    links.appendChild(dl);

    meta.appendChild(name);
    meta.appendChild(links);

    card.appendChild(img);
    card.appendChild(meta);

    grid.appendChild(card);

    count++;
    setStatus(`受信中… 画像 ${count} 件`);
  }
})();
