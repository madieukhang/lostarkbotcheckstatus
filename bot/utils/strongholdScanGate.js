import { buildAlertEmbed, AlertSeverity } from './alertEmbed.js';
import { isPrivilegedStrongholdScanUser } from './scanPermissions.js';
import { reserveUserScan } from './scanSession.js';

export function reserveStrongholdScanForInteraction(interaction, label) {
  return reserveUserScan(interaction.user.id, {
    label,
    startedAt: Date.now(),
  }, {
    allowMultiple: isPrivilegedStrongholdScanUser(interaction.user.id),
  });
}

export function scanLimitAlertOptions(active) {
  return {
    severity: AlertSeverity.WARNING,
    title: 'Scan Already Running',
    description: 'You already have a Stronghold scan running. Wait for it to finish or press **Stop scan** on the active card before starting another.',
    footer: active?.label ? `Active: ${active.label}` : undefined,
  };
}

export function buildStrongholdScanLimitEmbed(active) {
  return buildAlertEmbed(scanLimitAlertOptions(active));
}
