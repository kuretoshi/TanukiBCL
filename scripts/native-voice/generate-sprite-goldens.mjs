// Scalar variant-atlas resize oracle from the locked release dependency.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import vm from 'node:vm';
const root=resolve(import.meta.dirname,'../..');
const source=await readFile(join(root,'node_modules/unity-asset-reader-texture/dist/index.mjs'),'utf8');
const start=source.indexOf('const f32$1 = Math.fround;');
const end=source.indexOf('// Ported from AssetStudio.Utility/SpriteHelper.cs',start);
if(start<0||end<0)throw new Error('Release resize oracle was not found');
const resize=vm.runInNewContext(source.slice(start,end)+'; resizeCrop;');
const cases=[];
for(const [width,height,toWidth,toHeight,x,y,w,h]of [[2,2,4,4,0,0,4,4],[7,9,3,4,0,0,3,4],[3,5,9,7,2,1,5,4],[7,3,4,8,1,2,2,5]]){
 const data=Uint8Array.from({length:width*height*4},(_,i)=>(i*73+Math.floor(i/4)*31)%256);
 const image=resize({data,width,height},toWidth,toHeight,x,y,w,h);
 cases.push({width,height,data:[...data],toWidth,toHeight,x,y,w,h,expected:[...image.data]});
}
await writeFile(join(root,'resources/tauri-sprite-resize-goldens.json'),JSON.stringify(cases)+'\n');
console.log(JSON.stringify({resizeGoldens:cases.length}));
