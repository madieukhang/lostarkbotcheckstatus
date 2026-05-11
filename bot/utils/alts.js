/**
 * Merge alt arrays case-insensitively by character name.
 * Later entries win so a resumed scan can replace older class/iLvl data.
 */
export function mergeAltsByName(prior = [], next = []) {
  const byName = new Map();
  for (const alt of prior || []) {
    if (!alt?.name) continue;
    byName.set(String(alt.name).toLowerCase(), alt);
  }
  for (const alt of next || []) {
    if (!alt?.name) continue;
    byName.set(String(alt.name).toLowerCase(), alt);
  }
  return Array.from(byName.values());
}
