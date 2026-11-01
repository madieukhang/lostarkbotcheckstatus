import test from 'node:test';
import assert from 'node:assert/strict';

import { buildListAddApprovalEmbed } from '../bot/handlers/list/helpers.js';
import { buildEvidenceEmbed } from '../bot/handlers/list/view/ui.js';
import { buildCheckEntryDetailsEmbed } from '../bot/handlers/list/check/ui.js';
import { t } from '../bot/services/i18n/index.js';

const IMAGE = 'https://cdn.example/evidence.png';
const ENTRY = {
  _id: 'a'.repeat(24), _listType: 'black', _icon: 'x', _label: 'Blacklist', _color: 0xed4245,
  name: 'Shandijr', reason: 'dead', raid: '', scope: 'global', imageUrl: IMAGE,
  addedAt: new Date('2026-11-02T00:00:00Z'),
};

function evidenceField(embed, lang) {
  const data = embed.toJSON ? embed.toJSON() : embed.data;
  return data.fields.find((field) => field.name === t('listView.evidence.attached', lang));
}

test('every card that shows the evidence image captions it instead of a blank line', () => {
  for (const lang of ['en', 'vi', 'jp']) {
    const cards = {
      approval: buildListAddApprovalEmbed({ id: 'g', name: 'Guild' }, {
        requestId: 'r', action: 'add', type: 'black', scope: 'global', name: 'Shandijr',
        reason: 'dead', raid: '', imageUrl: IMAGE, requestedByUserId: 'u', requestedByDisplayName: 'Minh',
      }, { forRequester: true, lang }),
      view: buildEvidenceEmbed(ENTRY, IMAGE, { lang }),
      check: buildCheckEntryDetailsEmbed(ENTRY, { displayUrl: IMAGE, lang }),
    };
    for (const [card, embed] of Object.entries(cards)) {
      const field = evidenceField(embed, lang);
      assert.ok(field, `${lang} ${card}: no evidence field`);
      assert.equal(field.value, t('listView.evidence.caption', lang, { url: IMAGE }), `${lang} ${card}`);
      assert.ok(field.value.includes(`(${IMAGE})`), `${lang} ${card}: ${field.value}`);
    }
  }
});
