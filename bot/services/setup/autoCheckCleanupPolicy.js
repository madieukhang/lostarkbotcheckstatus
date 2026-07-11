function normalizeId(value) {
  return String(value || '').trim();
}

/**
 * Legacy owner-guild configs predate the explicit cleanup toggle. Preserve
 * their old managed-channel behavior, while every other guild defaults to
 * server-local auto-check without destructive cleanup.
 */
export function resolveAutoCheckCleanupEnabled(
  guildConfig,
  guildId,
  ownerGuildId = ''
) {
  if (typeof guildConfig?.autoCheckCleanupEnabled === 'boolean') {
    return guildConfig.autoCheckCleanupEnabled;
  }

  const ownerId = normalizeId(ownerGuildId);
  return Boolean(ownerId && normalizeId(guildId) === ownerId);
}

/**
 * Mongo predicate used both when loading cleanup candidates and claiming a
 * day. The second check prevents an in-flight tick from racing an admin who
 * has just disabled cleanup.
 */
export function buildAutoCheckCleanupEligibility(ownerGuildId = '') {
  const ownerId = normalizeId(ownerGuildId);
  if (!ownerId) return { autoCheckCleanupEnabled: true };

  return {
    $or: [
      { autoCheckCleanupEnabled: true },
      {
        guildId: ownerId,
        autoCheckCleanupEnabled: { $exists: false },
      },
    ],
  };
}
