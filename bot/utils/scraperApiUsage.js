import { AsyncLocalStorage } from 'node:async_hooks';

const startedAt = Date.now();
const usageScope = new AsyncLocalStorage();

const EMPTY_SUMMARY = Object.freeze({
  totalRequests: 0,
  successResponses: 0,
  failedResponses: 0,
  networkErrors: 0,
  lastRequestAt: null,
  lastStatus: null,
  lastError: '',
});

const totals = { ...EMPTY_SUMMARY };
const statusCounts = new Map();
const keyCounts = new Map();

function recordSummary(summary, { status, ok, error } = {}) {
  const isNetworkError = Boolean(error);

  summary.totalRequests += 1;
  summary.lastRequestAt = Date.now();

  if (isNetworkError) {
    summary.networkErrors += 1;
    summary.failedResponses += 1;
    summary.lastError = String(error?.message || error);
    return;
  }

  const statusCode = Number(status) || 0;
  summary.lastStatus = statusCode;
  if (ok) {
    summary.successResponses += 1;
  } else {
    summary.failedResponses += 1;
  }
}

function ensureKeyStats(keyIndex) {
  const keyNumber = Number.isFinite(keyIndex) ? keyIndex + 1 : 0;
  if (!keyCounts.has(keyNumber)) {
    keyCounts.set(keyNumber, {
      keyNumber,
      totalRequests: 0,
      successResponses: 0,
      failedResponses: 0,
      networkErrors: 0,
      lastStatus: null,
      lastError: '',
    });
  }
  return keyCounts.get(keyNumber);
}

export function recordScraperApiRequest({ keyIndex, status, ok = false, error } = {}) {
  const keyStats = ensureKeyStats(keyIndex);
  const isNetworkError = Boolean(error);

  recordSummary(totals, { status, ok, error });
  const scope = usageScope.getStore();
  if (scope) {
    recordSummary(scope, { status, ok, error });
  }

  keyStats.totalRequests += 1;

  if (isNetworkError) {
    keyStats.networkErrors += 1;
    keyStats.failedResponses += 1;
    keyStats.lastError = totals.lastError;
    return;
  }

  const statusCode = Number(status) || 0;
  keyStats.lastStatus = statusCode;
  statusCounts.set(statusCode, (statusCounts.get(statusCode) || 0) + 1);

  if (ok) {
    keyStats.successResponses += 1;
  } else {
    keyStats.failedResponses += 1;
  }
}

export function getScraperApiUsageSnapshot() {
  return {
    startedAt,
    ...totals,
    statusCounts: Object.fromEntries(statusCounts.entries()),
    keyCounts: [...keyCounts.values()].sort((a, b) => a.keyNumber - b.keyNumber),
  };
}

export function runWithScraperApiUsageScope(fn) {
  return usageScope.run({ ...EMPTY_SUMMARY }, fn);
}

export function getCurrentScraperApiUsageScopeSnapshot() {
  return { ...(usageScope.getStore() || EMPTY_SUMMARY) };
}

export function resetScraperApiUsageForTests() {
  Object.assign(totals, EMPTY_SUMMARY);
  statusCounts.clear();
  keyCounts.clear();
}
