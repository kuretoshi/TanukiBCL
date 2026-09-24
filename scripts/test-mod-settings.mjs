import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const cache = resolve('.cache/mod-settings-test');
await mkdir(cache, { recursive: true });
const bundle = await build({ entryPoints: ['src/renderer/settings/sections/LobbySection.tsx'], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false });
const file = resolve(cache, 'section.mjs'); await writeFile(file, bundle.outputFiles[0].contents);
const { default: LobbySection } = await import(pathToFileURL(file));
const translations = JSON.parse(await readFile('static/locales/ja/translation.json', 'utf8'));
const labels = ['snr_jumbo_voice', 'jackal_haunting', 'jackal_hear_outside_vents', 'jackal_talk_in_vents', 'sidekick_haunting', 'sidekick_hear_outside_vents', 'sidekick_talk_in_vents'].map(key => translations.settings.lobbysettings[key]);
const props = {
  t: key => key.split('.').reduce((value, part) => value?.[part], translations) || key,
  gameState: { isHost: true, hostId: 1, lobbyCode: 'ABCDEF', players: [], mod: 'SUPER_NEW_ROLES' },
  activeLobbySettings: { maxDistance: 5.32, snrJumboVoice: true, jackalHaunting: true, jackalHearOutsideVents: true, jackalTalkInVents: true },
  hostId: 1, myLobbySettings: { maxDistance: 5.32 }, canEditMine: true, editDisabledReason: '', update() {}, confirm() {},
};
for (const lite of [false, true]) for (const mod of ['SUPER_NEW_ROLES', 'NoS', 'TOH4E', 'NONE']) {
  process.env.BETTERCREWLINK_LITE = lite ? '1' : '0';
  const markup = renderToStaticMarkup(React.createElement(LobbySection, { ...props, gameState: { ...props.gameState, mod } }));
  assert.equal(markup.includes('【MOD】SNR設定'), mod === 'SUPER_NEW_ROLES');
  assert.equal(markup.includes('【MOD】NoS設定'), mod === 'NoS');
  const sharedGhostLabel = translations.settings.lobbysettings.toh_neutral_killer_haunting;
  for (const label of labels) assert.equal(markup.includes(label), mod === 'SUPER_NEW_ROLES' || (mod === 'NoS' && label === translations.settings.lobbysettings.nos_neutral_killer_haunting), label);
  assert.equal(markup.includes(sharedGhostLabel), mod === 'TOH4E');
  assert.equal(markup.includes(translations.settings.lobbysettings.toh_section), mod === 'TOH4E');
  assert.equal(markup.includes(translations.settings.lobbysettings.nos_voice_positions), mod === 'NoS');
  // Lite displays the host's enabled values read-only, normal has editable switches.
  assert.equal(/<input[^>]+disabled=""[^>]+type="checkbox"/.test(markup), lite);
}
delete process.env.BETTERCREWLINK_LITE;
for (const hostField of ['name', 'appearanceName']) {
  const markup = renderToStaticMarkup(React.createElement(LobbySection, { ...props,
    gameState: { ...props.gameState, mod: 'NONE', isHost: false,
      players: [{ clientId: 1, [hostField]: 'ホスト\u00a0Town Of Host For E EM v6180.383' }] } }));
  assert.ok(markup.includes(translations.settings.lobbysettings.toh_section));
  assert.ok(markup.includes('第三陣営・アニマル陣営のキルできる役職が幽霊の声も聞こえる'));
}
console.log('PASS lobby UI: SNR/NoS detection gates their own sections, new labels, normal editing and Lite host settings');
