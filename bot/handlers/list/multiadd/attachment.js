import { t } from '../../../services/i18n/index.js';

export function validateMultiaddAttachment(file, lang = 'en') {
  const rules = [
    {
      invalid: () => !file,
      message: () => t('dialogue.multiadd.attachment.required', lang),
    },
    {
      invalid: () => !file?.name?.toLowerCase().endsWith('.xlsx'),
      message: () => t('dialogue.multiadd.attachment.wrongType', lang, { name: file?.name }),
    },
    {
      invalid: () => file.size > 1024 * 1024,
      message: () => t('dialogue.multiadd.attachment.tooLarge', lang, {
        size: (file.size / 1024).toFixed(1),
      }),
    },
  ];
  const violation = rules.find(({ invalid }) => invalid());
  return violation?.message() || null;
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
