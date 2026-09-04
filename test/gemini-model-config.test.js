import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGeminiModelWaitlist,
  DEFAULT_GEMINI_MODEL_WAITLIST,
  DEFAULT_GEMINI_MODELS,
  isGemini3Model,
  resolveDefaultGeminiPrimaryTimeoutMs,
  resolveGeminiModels,
} from '../bot/config/geminiModels.js';

test('default OCR fallback uses stable Gemini 3.x Flash models only', () => {
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

test('default waitlist defers 3.8 and promotes 3.7 without disturbing fallback order', () => {
  const resolution = applyGeminiModelWaitlist(
    DEFAULT_GEMINI_MODELS,
    DEFAULT_GEMINI_MODEL_WAITLIST.join(','),
  );

  assert.deepEqual(resolution.models, DEFAULT_GEMINI_MODELS.slice(1));
  assert.deepEqual(resolution.waitlisted, ['gemini-3.8-flash']);
  assert.deepEqual(resolution.rejected, []);
  assert.deepEqual(applyGeminiModelWaitlist(DEFAULT_GEMINI_MODELS, '').models, DEFAULT_GEMINI_MODELS);
  assert.deepEqual(applyGeminiModelWaitlist(DEFAULT_GEMINI_MODELS, 'none').models, DEFAULT_GEMINI_MODELS);
  assert.deepEqual(applyGeminiModelWaitlist(DEFAULT_GEMINI_MODELS, 'off').rejected, []);
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
