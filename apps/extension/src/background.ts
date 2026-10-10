// Service worker: opens the side panel, owns the context menu, and hands selected text to the panel.
// It never touches resume data and makes no network calls.

const MENU_ID = 'jmo-analyze-selection';

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  chrome.contextMenus.create({ id: MENU_ID, title: 'Analyze selected text as a job description', contexts: ['selection'] });
  if (details.reason === 'install') await chrome.runtime.openOptionsPage().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  // open() must be called synchronously inside the user gesture; the panel picks the text up from session storage.
  void chrome.sidePanel.open({ tabId: tab.id });
  void chrome.storage.session.set({
    pendingSelection: { text: (info.selectionText ?? '').slice(0, 20_000), pageUrl: info.pageUrl ?? tab.url ?? '', pageTitle: tab.title ?? '', at: Date.now() },
  });
});

// Updates install only when no extension page is open; the panel shows "Reload to update" when this flag is set.
chrome.runtime.onUpdateAvailable.addListener(() => {
  void chrome.storage.session.set({ updateAvailable: true });
});

// The only message we accept: a reload request from our own pages.
chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (typeof msg === 'object' && msg && (msg as { type?: string }).type === 'app.reload') chrome.runtime.reload();
});
