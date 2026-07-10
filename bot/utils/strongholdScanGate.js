import { buildAlertEmbed, AlertSeverity } from './alertEmbed.js';
import { isPrivilegedStrongholdScanUser } from './scanPermissions.js';
import { reserveUserScan } from './scanSession.js';
import { t } from '../services/i18n/index.js';

export function reserveStrongholdScanForInteraction(interaction, label) {
  return reserveUserScan(interaction.user.id, {
    label,
    startedAt: Date.now(),
  }, {
    allowMultiple: isPrivilegedStrongholdScanUser(interaction.user.id),
  });
}

export function scanLimitAlertOptions(active, lang = 'en') {
  return {
    severity: AlertSeverity.WARNING,
    ...t('dialogue.scan.limit', lang, { label: active?.label || '' }),
    footer: active?.label ? t('dialogue.scan.limit.active', lang, { label: active.label }) : undefined,
    lang,
  };
}

export function buildStrongholdScanLimitEmbed(active, lang = 'en') {
  return buildAlertEmbed(scanLimitAlertOptions(active, lang));
}
