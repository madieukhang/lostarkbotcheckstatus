/**
 * Minimum item level for a character to belong to the managed lists.
 *
 * Characters below this gate are treated as inactive or unleveled alts:
 * /la-list add rejects them, roster deep scans and alt detection skip them
 * as candidates, and /la-search defaults its min_ilvl filter here. Every
 * surface that applies the gate must read this constant so the threshold
 * moves in one place.
 */
export const MIN_TRACKED_ITEM_LEVEL = 1700;
