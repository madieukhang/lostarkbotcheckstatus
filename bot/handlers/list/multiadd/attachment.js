import { t } from '../../../services/i18n/index.js';

export function validateMultiaddAttachment(file, lang = 'en') {
  if (!file) {
    return t('dialogue.multiadd.attachment.required', lang);
  }
  if (!file.name?.toLowerCase().endsWith('.xlsx')) {
    return t('dialogue.multiadd.attachment.wrongType', lang, { name: file.name });
  }
  if (file.size > 1024 * 1024) {
    return t('dialogue.multiadd.attachment.tooLarge', lang, { size: (file.size / 1024).toFixed(1) });
  }
  return null;
}

export async function downloadMultiaddAttachment(file, lang = 'en') {
  try {
    const response = await fetch(file.url);
    if (!response.ok) {
      return { ok: false, content: t('dialogue.multiadd.attachment.httpFailed', lang, { status: response.status }) };
    }
    return { ok: true, buffer: Buffer.from(await response.arrayBuffer()) };
  } catch (err) {
    console.error('[multiadd] Download failed:', err);
    return { ok: false, content: t('dialogue.multiadd.attachment.networkFailed', lang, { error: err.message }) };
  }
}
