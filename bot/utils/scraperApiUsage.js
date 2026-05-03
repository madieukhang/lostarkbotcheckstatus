import { AsyncLocalStorage } from 'node:async_hooks';

const startedAt = Date.now();
const usageScope = new AsyncLocalStorage();

function createSummary() {
  return {
    totalRequests: 0,
    successResponses: 0,
    failedResponses: 0,
    networkErrors: 0,
    lastRequestAt: null,
    lastStatus: null,
    lastError: '',
  };
}

const totals = createSummary();

const statusCounts = new Map();
const keyCounts = new Map();

function cloneSummary(summary = createSummary()) {
  return {
    totalRequests: summary.totalRequests,
    successResponses: summary.successResponses,
    failedResponses: summary.failedResponses,
    networkErrors: summary.networkErrors,
    lastRequestAt: summary.lastRequestAt,
    lastStatus: summary.lastStatus,
    lastError: summary.lastError,
  };
}

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

const EMPTY_SUMMARY = Object.freeze({
  totalRequests: 0,
  successResponses: 0,
  failedResponses: 0,
  networkErrors: 0,
  lastRequestAt: null,
  lastStatus: null,
  lastError: '',
});

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
    totalRequests: totals.totalRequests,
    successResponses: totals.successResponses,
    failedResponses: totals.failedResponses,
    networkErrors: totals.networkErrors,
    lastRequestAt: totals.lastRequestAt,
    lastStatus: totals.lastStatus,
    lastError: totals.lastError,
    statusCounts: Object.fromEntries(statusCounts.entries()),
    keyCounts: [...keyCounts.values()].sort((a, b) => a.keyNumber - b.keyNumber),
  };
}

export function diffScraperApiUsage(start, end = getScraperApiUsageSnapshot()) {
  return {
    totalRequests: end.totalRequests - (start?.totalRequests || 0),
    successResponses: end.successResponses - (start?.successResponses || 0),
    failedResponses: end.failedResponses - (start?.failedResponses || 0),
    networkErrors: end.networkErrors - (start?.networkErrors || 0),
  };
}

export function runWithScraperApiUsageScope(fn) {
  return usageScope.run(createSummary(), fn);
}

export function getCurrentScraperApiUsageScopeSnapshot() {
  return cloneSummary(usageScope.getStore() || EMPTY_SUMMARY);
}

export function resetScraperApiUsageForTests() {
  totals.totalRequests = 0;
  totals.successResponses = 0;
  totals.failedResponses = 0;
  totals.networkErrors = 0;
  totals.lastRequestAt = null;
  totals.lastStatus = null;
  totals.lastError = '';
  statusCounts.clear();
  keyCounts.clear();
}
