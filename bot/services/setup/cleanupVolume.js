const CLEANUP_VOLUME_RULES = [
  { max: 0, bucket: 'empty' },
  { max: 5, bucket: 'trivial' },
  { max: 20, bucket: 'normal' },
  { max: Number.POSITIVE_INFINITY, bucket: 'heavy' },
];

/**
 * Resolve the shared cleanup volume thresholds. Callers choose whether an
 * empty sweep has its own message or should stay silent.
 */
export function resolveCleanupVolume(deleted, { emptyBucket = null } = {}) {
  const count = Number(deleted) || 0;
  const bucket = CLEANUP_VOLUME_RULES.find(({ max }) => count <= max).bucket;
  return bucket === 'empty' ? emptyBucket : bucket;
}
