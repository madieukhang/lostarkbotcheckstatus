import { VirtualConsole } from 'jsdom';

export function createRosterVirtualConsole(logger = console) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  virtualConsole.on('jsdomError', (error) => {
    if (error?.type === 'css parsing') return;
    logger.warn?.('[jsdom] Parse warning:', error?.message || error);
  });
  return virtualConsole;
}
