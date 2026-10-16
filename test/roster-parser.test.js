import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseRosterCharactersFromHtml } from '../bot/services/roster/parsers.js';

// lostark.bible renders a card only for characters it updated recently,
// while the page's data payload lists the whole roster.
function rosterPage({ cards, payload }) {
  const cardHtml = cards.map(({ name, ilvl, cp }) =>
    `<a href="/character/NA/${name}"><div class="flex flex-row items-center gap-1 text-lg font-semibold">${name} `
    + `<span class="rounded-full">${ilvl}</span> <span class="inline-flex">${cp}</span></div></a>`).join('');
  return `<html><body>${cardHtml}<script>data:{roster:[${payload.join(',')}]}</script></body></html>`;
}

async function parse(html) {
  return parseRosterCharactersFromHtml(html, new JSDOM(html).window.document);
}

const ALPHA = '{id:1,name:"Alpha",class:"blade",ilvl:1740.8334,combatPower:{id:1,score:3264.49},combatPowerIsEstimate:true,lastUpdate:1792166510}';
const BETA = '{id:2,name:"Beta",class:"devil_hunter_female",ilvl:1722.5,combatPower:{id:1,score:2741.46},combatPowerIsEstimate:true,lastUpdate:1790173822}';
const GAMMA = '{id:3,name:"Gamma",class:"holyknight",ilvl:1710.8334,combatPower:{id:1,score:1617.64},combatPowerIsEstimate:false,lastUpdate:1792166888}';
const DELTA = '{id:4,name:"Delta",class:"warlord",ilvl:1643.5,combatPower:null,combatPowerIsEstimate:true,lastUpdate:1753335714}';

test('a roster character bible shows no card for is still parsed, in item level order', async () => {
  const html = rosterPage({
    cards: [{ name: 'Alpha', ilvl: '1740.83', cp: '≈3264.49' }, { name: 'Gamma', ilvl: '1710.83', cp: '1617.64' }],
    payload: [ALPHA, BETA, GAMMA, DELTA],
  });

  const characters = await parse(html);

  assert.deepEqual(characters.map(c => c.name), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.deepEqual(characters[1], {
    name: 'Beta', itemLevel: '1722.5', combatScore: '≈2741.46', classId: 'devil_hunter_female', className: 'Gunslinger',
  });
  assert.equal(characters[3].className, 'Gunlancer');
  assert.equal(characters[3].combatScore, '?');
});

test('a page with no character cards still reads as no roster', async () => {
  assert.deepEqual(await parse(rosterPage({ cards: [], payload: [ALPHA, BETA] })), []);
});
