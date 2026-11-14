/**
 * utils/evidenceQuota.js
 * How many evidence images a member may archive per day. Each archived image
 * is posted to the owner's evidence channel and copied to MongoDB before any
 * approval, so a member who is not an officer or senior gets a daily allowance.
 */

import { t } from '../services/i18n/index.js';
import { NoticeKind } from './alertEmbed.js';
import { isOfficerOrSenior } from './approverRoles.js';
import { createRollingQuota } from './rollingQuota.js';

export const EVIDENCE_UPLOAD_LIMIT = 10;
const EVIDENCE_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

let quota = createRollingQuota({ limit: EVIDENCE_UPLOAD_LIMIT, windowMs: EVIDENCE_UPLOAD_WINDOW_MS });

/**
 * Take `count` images from the user's daily allowance.
 * @param {string} userId - Discord user id of the uploader
 * @param {number} count - images the request would archive
 * @returns {boolean} true when the images may be archived; officers and
 *   seniors are never limited
 */
export function takeEvidenceUploads(userId, count) {
  if (isOfficerOrSenior(userId)) return true;
  return quota.take(userId, count);
}

/**
 * The notice for a request refused because its images are over the allowance.
 * @param {string} lang - viewer language
 * @returns {object} editAlert options
 */
export function buildImageQuotaAlert(lang) {
  return { kind: NoticeKind.BUSY, ...t('dialogue.common.imageQuota', lang, { limit: EVIDENCE_UPLOAD_LIMIT }) };
}

/**
 * Start a fresh allowance for everyone. Test seam.
 * @param {{now?: () => number}} [options] - clock for the new allowance
 * @returns {void}
 */
export function resetEvidenceQuota({ now } = {}) {
  quota = createRollingQuota({ limit: EVIDENCE_UPLOAD_LIMIT, windowMs: EVIDENCE_UPLOAD_WINDOW_MS, now });
}
