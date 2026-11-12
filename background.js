/**
 * Clicking the toolbar icon toggles the downloader panel in the current tab.
 * The panel's scripts are normally already in Echo360 tabs (content_scripts). Tabs that were
 * open before the extension was installed/reloaded don't have them, so they are injected on
 * demand (activeTab grants access to the clicked tab).
 */
const CONTENT_FILES = ['src/hls.js', 'src/fmp4.js', 'src/echo360.js', 'src/panel.js'];
const ECHO360_PAGE = /^https:\/\/echo360\.org\.uk\//i;
const LOG = '[Echo360 Downloader]';

function toggle(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: 'ECHO360DL_TOGGLE' });
}

async function pageUrl(tab) {
  if (tab.url) return tab.url; // only present with host access to the tab
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => location.href });
  return (res && res.result) || '';
}

async function flash(tabId, title) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#cf222e' });
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setTitle({ tabId, title });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  try {
    await toggle(tab.id);
    return;
  } catch (e) {
    console.info(LOG, 'panel not loaded in this tab yet:', e.message);
  }
  try {
    const url = await pageUrl(tab);
    if (!ECHO360_PAGE.test(url)) {
      console.info(LOG, 'not an Echo360 page:', url);
      await flash(tab.id, 'Open a course’s class list on echo360.org.uk, then click this icon.');
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
    await toggle(tab.id);
  } catch (e) {
    console.error(LOG, 'could not open the panel:', e);
    flash(tab.id, 'Echo360 Downloader could not open here. Reload the page and try again.').catch(() => {});
  }
});
