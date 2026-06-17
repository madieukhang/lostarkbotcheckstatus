/**
 * Allowed raid labels for /la-list add.
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
  // Horizon ships with three level tiers (Lv1/Lv2/Lv3) instead of
  // Nor/Hard/NM difficulties · mirrors the RaidManage catalog's
  // Horizon Level 1/2/3. Newest content, so it sorts last like in-game.
  'Horizon Lv1',
  'Horizon Lv2',
  'Horizon Lv3',
];

/**
 * Build Discord string option choices from the raid list.
 * @returns {Array<{name: string, value: string}>}
 */
export function getRaidChoices() {
  return RAIDS.map((raid) => ({ name: raid, value: raid }));
}
