/**
 * test/helpers/modal-submit.js
 * The fields of a modal submit, built by discord.js's own ModalSubmitFields
 * from the payload Discord sends, so a form reader meets the real class: it
 * throws on an id the submit does not carry and resolves uploads to Attachments.
 */

import { ComponentType, ModalSubmitFields, ModalSubmitInteraction } from 'discord.js';

/**
 * Build submitted form fields; an id left out was not submitted.
 * @param {object} submit
 * @param {Object<string, string>} [submit.texts] - text input values by custom id
 * @param {Object<string, string[]>} [submit.selects] - chosen select values by custom id
 * @param {Object<string, Array<{url: string, contentType: string}>>} [submit.files] - uploads by custom id
 * @returns {ModalSubmitFields}
 */
export function modalSubmitFields({ texts = {}, selects = {}, files = {} } = {}) {
  const attachments = {};
  const raw = [
    ...Object.entries(texts).map(([id, value]) => ({ type: ComponentType.TextInput, custom_id: id, value })),
    ...Object.entries(selects).map(([id, values]) => ({ type: ComponentType.StringSelect, custom_id: id, values })),
    ...Object.entries(files).map(([id, uploads]) => ({
      type: ComponentType.FileUpload,
      custom_id: id,
      values: uploads.map(({ url, contentType }, index) => {
        const attachmentId = `${id}-${index}`;
        attachments[attachmentId] = {
          id: attachmentId, url, proxy_url: url, filename: url.split('/').at(-1), size: 1, content_type: contentType,
        };
        return attachmentId;
      }),
    })),
  ];
  const resolved = { attachments };
  const components = raw.map((component, index) => ModalSubmitInteraction.transformComponent(
    { type: ComponentType.Label, id: index + 1, component: { id: index + 100, ...component } },
    resolved,
  ));
  return new ModalSubmitFields(components, resolved);
}
