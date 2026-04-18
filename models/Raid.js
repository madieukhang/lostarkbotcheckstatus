/**
 * Allowed raid labels for /list add.
 */
export const RAIDS = [
  'Act4 Nor',
  'Act4 Hard',
  'Kazeros Nor',
  'Kazeros Hard',
  'Mordum Hard',
  'Secra Nor',
  'Secra Hard',
  'Secra NM',
];

/**
 * Build Discord string option choices from the raid list.
 * @returns {Array<{name: string, value: string}>}
 */
export function getRaidChoices() {
  return RAIDS.map((raid) => ({ name: raid, value: raid }));
}
