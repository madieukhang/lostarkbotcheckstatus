function matches(doc, filter) {
  if (!doc) return false;
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some(branch => matches(doc, branch));
    const actual = doc[key];
    if (expected === null) return actual == null;
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('$in' in expected) return expected.$in.includes(actual ?? null);
      if ('$gt' in expected) return actual > expected.$gt;
      if ('$lte' in expected) return actual <= expected.$lte;
    }
    return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
  });
}

/** In-memory persistence for handler tests; real lease semantics are covered by Mongo integration tests. */
export function mockPendingApprovalModel(t, Model, initial) {
  let pending = structuredClone(initial);
  const calls = { claims: [], updates: [], deletes: [] };
  const apply = update => {
    Object.assign(pending, structuredClone(update.$set || {}));
    for (const key of Object.keys(update.$unset || {})) delete pending[key];
  };
  t.mock.method(Model, 'findOne', filter => ({ lean: async () => matches(pending, filter) ? structuredClone(pending) : null }));
  t.mock.method(Model, 'exists', async filter => matches(pending, filter));
  t.mock.method(Model, 'findOneAndUpdate', (filter, update) => ({ lean: async () => {
    calls.claims.push(filter);
    if (!matches(pending, filter)) return null;
    apply(update);
    return structuredClone(pending);
  } }));
  t.mock.method(Model, 'updateOne', async (filter, update) => {
    calls.updates.push(filter);
    if (!matches(pending, filter)) return { matchedCount: 0 };
    apply(update);
    return { matchedCount: 1 };
  });
  t.mock.method(Model, 'deleteOne', async filter => {
    calls.deletes.push(filter);
    if (!matches(pending, filter)) return { deletedCount: 0 };
    pending = null;
    return { deletedCount: 1 };
  });
  return { get: () => pending, calls };
}
