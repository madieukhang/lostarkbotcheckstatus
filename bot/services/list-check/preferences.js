import UserPreference from '../../models/UserPreference.js';

/**
 * Read the sender's OCR mode once per image batch. Missing/legacy preferences
 * and read failures use Daily; never infer permission to spend analysis quota.
 * @param {string} discordId Sender identity.
 * @param {object} [dependencies] Optional preference model for isolated tests.
 * @returns {Promise<'daily'|'analysis'>}
 */
export async function getUserOcrMode(discordId, { UserPreferenceModel = UserPreference } = {}) {
  if (!discordId) return 'daily';
  try {
    const doc = await UserPreferenceModel.findOne({ discordId }, { ocrMode: 1 }).lean();
    return doc?.ocrMode === 'analysis' ? 'analysis' : 'daily';
  } catch (error) {
    console.warn(`[listcheck] OCR preference read failed; using daily: ${error.message}`);
    return 'daily';
  }
}

/**
 * Persist only this user's OCR mode, leaving language and identity untouched.
 * @param {string} discordId Sender identity.
 * @param {'daily'|'analysis'} mode Explicitly selected mode.
 * @param {object} [dependencies] Optional preference model for isolated tests.
 * @returns {Promise<'daily'|'analysis'>} Mode after a successful write.
 */
export async function setUserOcrMode(discordId, mode, { UserPreferenceModel = UserPreference } = {}) {
  if (!discordId) throw new TypeError('OCR preferences require a Discord user ID.');
  if (!['daily', 'analysis'].includes(mode)) throw new RangeError(`Unknown OCR mode: ${mode}`);
  await UserPreferenceModel.updateOne(
    { discordId },
    { $set: { ocrMode: mode } },
    { upsert: true, runValidators: true },
  );
  return mode;
}
