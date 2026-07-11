/**
 * Cleanup is destructive, so every guild defaults off. Only an explicit
 * persisted true value counts as consent to delete non-pinned messages.
 */
export function resolveAutoCheckCleanupEnabled(guildConfig) {
  return guildConfig?.autoCheckCleanupEnabled === true;
}

/**
 * Mongo predicate used both when loading cleanup candidates and claiming a
 * day. The second check prevents an in-flight tick from racing an admin who
 * has just disabled cleanup.
 */
export function buildAutoCheckCleanupEligibility() {
  return { autoCheckCleanupEnabled: true };
}
