import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deferEphemeralReply,
  deferReply,
  deferUpdate,
  editAlert,
  editComponents,
  editContent,
  editEmbed,
  editPayload,
  replyAlert,
  replyContent,
  replyEmbed,
  updateEmbed,
  updatePayload,
} from '../bot/utils/interactionReplies.js';
import { AlertSeverity } from '../bot/utils/alertEmbed.js';

test('replyEmbed wraps one or many embeds and defaults to ephemeral', async () => {
  const calls = [];
  const interaction = { reply: async (payload) => calls.push(payload) };
  const embeds = [{ main: true }, { detail: true }];

  await replyEmbed(interaction, embeds, { components: [{ row: true }] });

  assert.deepEqual(calls[0], {
    embeds,
    components: [{ row: true }],
    ephemeral: true,
  });
});

test('replyEmbed can send public replies without nesting embeds', async () => {
  const calls = [];
  const interaction = { reply: async (payload) => calls.push(payload) };
  const embed = { existing: true };

  await replyEmbed(interaction, embed, { ephemeral: false });

  assert.deepEqual(calls[0], {
    embeds: [embed],
    ephemeral: false,
  });
});

test('replyContent keeps ephemeral content replies consistent', async () => {
  const calls = [];
  const interaction = { reply: async (payload) => calls.push(payload) };

  await replyContent(interaction, 'No image', { ephemeral: true });

  assert.deepEqual(calls[0], {
    content: 'No image',
    ephemeral: true,
  });
});

test('editEmbed and updateEmbed preserve extra payload fields', async () => {
  const editCalls = [];
  const updateCalls = [];
  const interaction = {
    editReply: async (payload) => editCalls.push(payload),
    update: async (payload) => updateCalls.push(payload),
  };
  const embed = { existing: true };

  await editEmbed(interaction, embed, { content: '' });
  await updateEmbed(interaction, [embed], { components: [] });

  assert.deepEqual(editCalls[0], { content: '', embeds: [embed] });
  assert.deepEqual(updateCalls[0], { components: [], embeds: [embed] });
});

test('editContent preserves content-only edit payloads', async () => {
  const calls = [];
  const interaction = { editReply: async (payload) => calls.push(payload) };

  await editContent(interaction, 'Working...', { components: [] });

  assert.deepEqual(calls[0], {
    content: 'Working...',
    components: [],
  });
});

test('editComponents preserves component-only edit payloads', async () => {
  const calls = [];
  const interaction = { editReply: async (payload) => calls.push(payload) };
  const components = [{ row: true }];

  await editComponents(interaction, components);

  assert.deepEqual(calls[0], { components });
});

test('editPayload passes through full edit payloads unchanged', async () => {
  const calls = [];
  const interaction = { editReply: async (payload) => calls.push(payload) };
  const payload = { content: 'done', embeds: [], components: [{ row: true }] };

  await editPayload(interaction, payload);

  assert.deepEqual(calls[0], payload);
});

test('updatePayload passes through full update payloads unchanged', async () => {
  const calls = [];
  const interaction = { update: async (payload) => calls.push(payload) };
  const payload = { content: 'working', embeds: [], components: [] };

  await updatePayload(interaction, payload);

  assert.deepEqual(calls[0], payload);
});

test('defer helpers centralize public and ephemeral defer payloads', async () => {
  const calls = [];
  const interaction = { deferReply: async (payload) => calls.push(payload) };

  await deferReply(interaction);
  await deferEphemeralReply(interaction);

  assert.deepEqual(calls, [undefined, { ephemeral: true }]);
});

test('deferUpdate routes through the interaction update defer API', async () => {
  const calls = [];
  const interaction = { deferUpdate: async () => calls.push('deferUpdate') };

  await deferUpdate(interaction);

  assert.deepEqual(calls, ['deferUpdate']);
});

test('alert helpers route through the shared alert embed builder', async () => {
  const replyCalls = [];
  const editCalls = [];
  const interaction = {
    reply: async (payload) => replyCalls.push(payload),
    editReply: async (payload) => editCalls.push(payload),
  };

  await replyAlert(interaction, {
    severity: AlertSeverity.WARNING,
    title: 'Careful',
    description: 'Check this first.',
  });
  await editAlert(interaction, {
    severity: AlertSeverity.SUCCESS,
    title: 'Done',
  });

  assert.equal(replyCalls[0].ephemeral, true);
  assert.equal(replyCalls[0].embeds.length, 1);
  assert.equal(editCalls[0].embeds.length, 1);
});
