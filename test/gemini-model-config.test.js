import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGeminiModelWaitlist,
  DEFAULT_GEMINI_MODEL_WAITLIST,
  DEFAULT_GEMINI_MODELS,
  GEMINI_MODEL_PROFILES,
  isGemini3Model,
  resolveGeminiAttemptTimeoutMs,
  resolveDefaultGeminiPrimaryTimeoutMs,
  resolveGeminiModels,
  resolveGeminiModelProfile,
} from '../bot/config/geminiModels.js';

test('OCR catalog retains every supported Gemini 3.x model', () => {
  assert.deepEqual(DEFAULT_GEMINI_MODELS, [
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ]);
  assert.ok(DEFAULT_GEMINI_MODELS.every(isGemini3Model));
  assert.ok(DEFAULT_GEMINI_MODELS.every((model) => !model.includes('preview')));
});

test('env model resolution rejects 2.x while preserving ordered 3.x overrides', () => {
  const resolution = resolveGeminiModels([
    'gemini-2.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'GEMINI-3.5-FLASH-LITE',
  ].join(','));

  assert.deepEqual(resolution.models, [
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
  ]);
  assert.deepEqual(resolution.rejected, ['gemini-2.5-flash']);
  assert.equal(resolution.usedDefaults, false);
});

test('empty or entirely rejected env model lists fall back to the 3.x defaults', () => {
  assert.deepEqual(resolveGeminiModels('').models, DEFAULT_GEMINI_MODELS);

  const rejected = resolveGeminiModels('gemini-2.5-flash,gemini-2.5-flash-lite');
  assert.deepEqual(rejected.models, DEFAULT_GEMINI_MODELS);
  assert.deepEqual(rejected.rejected, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.equal(rejected.usedDefaults, true);
});

test('default waitlist restores 3.8 to the catalog without disturbing fallback order', () => {
  const resolution = applyGeminiModelWaitlist(
    DEFAULT_GEMINI_MODELS,
    DEFAULT_GEMINI_MODEL_WAITLIST.join(','),
  );

  assert.deepEqual(resolution.models, DEFAULT_GEMINI_MODELS);
  assert.deepEqual(resolution.waitlisted, []);
  assert.deepEqual(resolution.rejected, []);
  assert.deepEqual(applyGeminiModelWaitlist(DEFAULT_GEMINI_MODELS, '').models, DEFAULT_GEMINI_MODELS);
  assert.deepEqual(applyGeminiModelWaitlist(DEFAULT_GEMINI_MODELS, 'none').models, DEFAULT_GEMINI_MODELS);
  assert.deepEqual(applyGeminiModelWaitlist(DEFAULT_GEMINI_MODELS, 'off').rejected, []);
});

test('daily and analysis have disjoint, complete default chains', () => {
  assert.deepEqual(resolveGeminiModelProfile().models, [
    'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite',
  ]);
  assert.deepEqual(resolveGeminiModelProfile('', 'analysis').models, [
    'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
  ]);
  assert.deepEqual(
    [...GEMINI_MODEL_PROFILES.daily, ...GEMINI_MODEL_PROFILES.analysis].sort(),
    [...DEFAULT_GEMINI_MODELS].sort(),
  );
});

test('legacy and profile overrides cannot cross the daily/analysis boundary', () => {
  const mixed = 'gemini-3.5-flash-lite,gemini-3.7-flash,gemini-3.1-flash-lite,gemini-3.8-flash';
  assert.deepEqual(resolveGeminiModelProfile(mixed).models, [
    'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
  ]);
  assert.deepEqual(resolveGeminiModelProfile(mixed, 'analysis').models, [
    'gemini-3.7-flash', 'gemini-3.8-flash',
  ]);
  assert.deepEqual(resolveGeminiModelProfile('gemini-3.8-flash').models, GEMINI_MODEL_PROFILES.daily);
  assert.deepEqual(resolveGeminiModelProfile('gemini-3.1-flash-lite', 'analysis').models, GEMINI_MODEL_PROFILES.analysis);
  assert.deepEqual(resolveGeminiModelProfile('gemini-2.5-flash').rejected, ['gemini-2.5-flash']);
  assert.throws(() => resolveGeminiModelProfile('', 'unexpected'), /Unknown Gemini OCR profile/);
});

test('waitlist validation is case-insensitive and primary timeout follows the active model', () => {
  const resolution = applyGeminiModelWaitlist(
    DEFAULT_GEMINI_MODELS,
    'GEMINI-3.8-FLASH,gemini-2.5-flash',
  );

  assert.deepEqual(resolution.waitlisted, ['gemini-3.8-flash']);
  assert.deepEqual(resolution.rejected, ['gemini-2.5-flash']);
  assert.equal(resolveDefaultGeminiPrimaryTimeoutMs(resolution.models[0]), 30_000);
  assert.equal(resolveDefaultGeminiPrimaryTimeoutMs('gemini-3.8-flash'), 8_000);
});

test('attempt timeout preserves fallback time without starving the active model', () => {
  assert.equal(resolveGeminiAttemptTimeoutMs({
    remainingMs: 30_000,
    modelTimeoutMs: 30_000,
    fallbackReserveMs: 10_000,
    hasFallback: true,
  }), 20_000);
  assert.equal(resolveGeminiAttemptTimeoutMs({
    remainingMs: 9_000,
    modelTimeoutMs: 30_000,
    fallbackReserveMs: 10_000,
    hasFallback: true,
  }), 9_000);
  assert.equal(resolveGeminiAttemptTimeoutMs({
    remainingMs: 30_000,
    modelTimeoutMs: 30_000,
    fallbackReserveMs: 10_000,
    hasFallback: false,
  }), 30_000);
  assert.equal(resolveGeminiAttemptTimeoutMs({
    remainingMs: 30_000,
    modelTimeoutMs: 15_000,
    fallbackReserveMs: 10_000,
    hasFallback: true,
  }), 15_000, 'a promoted model keeps its own cap while preserving another fallback');
  assert.equal(resolveGeminiAttemptTimeoutMs({
    remainingMs: 15_000,
    modelTimeoutMs: 15_000,
    fallbackReserveMs: 10_000,
    hasFallback: false,
  }), 15_000, 'after a timeout, the next model can consume the remainder');
});
