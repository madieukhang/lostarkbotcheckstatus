import { VirtualConsole } from 'jsdom';

export function createRosterVirtualConsole(logger = console) {
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
