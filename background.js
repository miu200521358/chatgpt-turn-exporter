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
