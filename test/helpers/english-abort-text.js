import en from '../../bot/locales/dialogue/en.js';

const LIVE_ABORT_TEXT = Object.values(en.scan.result.abortReasons)
  .flatMap(({ label, detail }) => [label, detail].filter(Boolean));

/**
 * English abort wording that a vi or jp scan surface must not carry: every
 * live en label and detail, plus earlier hard-coded labels that stay guarded
 * if the en copy is reworded.
 */
export const ENGLISH_ABORT_TEXT = [
  ...LIVE_ABORT_TEXT,
  'Stopped by user',
  'Discord update failed',
  'Bible rejected candidate profiles',
];
