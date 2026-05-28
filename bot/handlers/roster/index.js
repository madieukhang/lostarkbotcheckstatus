/**
 * handlers/roster/index.js
 * Re-export surface for the /la-roster command + its Continue/Cancel
 * deep-scan button. command.js handles the slash entry (visible +
 * hidden roster paths, deep-scan opt-in); deepContinue.js handles
 * the "Continue scan" button on the deep-scan progress card.
 */

export { handleRosterCommand } from './command.js';
export { handleRosterDeepContinueButton } from './deepContinue.js';
