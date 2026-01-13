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
      resolve();
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

const sessionMap = new Map();

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "cgexport_open_viewer") {
    const sessionId = randomId();
    const url = browser.runtime.getURL(`viewer/viewer.html?session=${encodeURIComponent(sessionId)}`);
    const sourceTabId = sender?.tab?.id ?? null;
    const tab = await browser.tabs.create({ url });
    sessionMap.set(sessionId, {
      sourceTabId,
      viewerTabId: tab?.id ?? null
    });
    await waitTabComplete(tab.id);
    return { sessionId, tabId: tab.id };
  }

  if (msg.type === "cgexport_viewer_ready" && msg.sessionId) {
    const session = sessionMap.get(msg.sessionId);
    if (!session) return;
    if (msg.tabId != null) session.viewerTabId = msg.tabId;
    if (session.sourceTabId != null) {
      await browser.tabs.sendMessage(session.sourceTabId, {
        type: "cgexport_viewer_ready",
        sessionId: msg.sessionId,
        tabId: msg.tabId ?? null
      });
    }
  }
});
