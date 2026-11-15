/**
 * services/roster/dom.js
 * The one place that loads jsdom. It takes about a second to load, and most
 * importers of the page parsers never parse a page, so it loads on first use.
 */

let jsdomLoad = null;

function loadJsdom() {
  jsdomLoad ??= import('jsdom');
  return jsdomLoad;
}

/**
 * A virtual console for fetched pages: the CSS parse errors every roster and
 * status page causes are dropped, any other jsdom error is logged.
 * @param {{warn?: Function}} [logger=console] - where other errors go
 * @returns {Promise<import('jsdom').VirtualConsole>} the console
 */
export async function createRosterVirtualConsole(logger = console) {
  const { VirtualConsole } = await loadJsdom();
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  virtualConsole.on('jsdomError', (error) => {
    // Pages ship stylesheets jsdom cannot parse; jsdom 31 reports them as
    // type 'css-parsing'.
    if (error?.type === 'css-parsing') return;
    logger.warn?.('[jsdom] Parse warning:', error?.message || error);
  });
  return virtualConsole;
}

/**
 * Parse fetched HTML into a document.
 * @param {string} html - the page
 * @param {object} [options] - JSDOM constructor options
 * @returns {Promise<Document>} the page's document
 */
export async function parseHtmlDocument(html, options = {}) {
  const { JSDOM } = await loadJsdom();
  return new JSDOM(html, options).window.document;
}

let rosterConsole = null;

/**
 * Parse a lostark.bible page into a document, with one shared roster console.
 * @param {string} html - the page
 * @returns {Promise<Document>} the page's document
 */
export async function parseRosterDocument(html) {
  rosterConsole ??= createRosterVirtualConsole();
  return parseHtmlDocument(html, { virtualConsole: await rosterConsole });
}
