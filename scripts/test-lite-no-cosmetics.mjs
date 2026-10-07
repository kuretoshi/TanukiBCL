import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'lite-no-cosmetics-'));
try {
  const result = await build({ stdin: { contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import LiteAvatar from './src/renderer/LiteAvatar'; export function render(player) { return renderToStaticMarkup(React.createElement(LiteAvatar, {player, mod:'NoS', size:64, talking:false, borderColor:'#fff', isAlive:true, isUsingRadio:true})); }`, resolveDir: process.cwd() }, bundle:true, platform:'node', format:'esm', banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}, loader:{'.png':'dataurl','.svg':'dataurl'}, write:false });
  const output=join(directory,'test.mjs');
  await writeFile(output,result.outputFiles[0].contents);
  const {render}=await import(pathToFileURL(output));
  const html=render({currentOutfit:0,colorId:1,nosLobbyColor:'#50ef39',nosCosmetics:{hat:'nos-cosmetic://image/hat',skin:'nos-cosmetic://image/skin',visor:'nos-cosmetic://image/visor',bodyMask:'nos-cosmetic://image/mask'}});
  assert.ok(!html.includes('nos-cosmetic:')&&!html.includes('snr-cosmetic:'),'Lite must not render or preload costume assets');
  assert.ok(html.includes('#50ef39'),'NoS color must remain visible');
  assert.ok(html.includes('data:image/png'),'Base avatar must remain');
  assert.ok(html.includes('data:image/svg'),'Radio indicator must remain');
  console.log('PASS Lite: no costume images or masks, NoS body color, base avatar and radio indicator preserved');
} finally { await rm(directory,{recursive:true,force:true}); }
