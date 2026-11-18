import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the real save method without constructing a canvas or browser DOM.
const previousRegistry=globalThis.customElements;
globalThis.customElements={get:()=>true};
const modules={
  '/core/runtime.js':`export const runtime={invoke:(...args)=>globalThis.__extractorSave.invoke(...args)};export function unwrap(result){if(Object.hasOwn(result,'err'))throw new Error(result.err);return result.ok;}`,
  '/util/view-canvas-base.js':'export class ViewCanvasBase {}',
  '/util/qoi/decode.js':'export function decode(){throw new Error("unexpected image decode in save test");}',
};
const hooks=registerHooks({resolve(name,context,next){if(Object.hasOwn(modules,name))return {url:`data:text/javascript,${encodeURIComponent(modules[name])}`,shortCircuit:true};return next(name,context);}});
let ViewTileExtractor;
try { ({ViewTileExtractor}=await import('../src/views/view-tile-extractor.js')); }
finally { hooks.deregister();if(previousRegistry===undefined)delete globalThis.customElements;else globalThis.customElements=previousRegistry; }

function fixture(tilesetPath='repeats.tileset.qoi',height=16){
  const writes=[],calls=[];
  const output={layers:[{width:2,data:[1,2,1,0],props:[['name','extracted']]}],props:[['tileHeight',String(height)],['tileWidth','16']]};
  globalThis.__extractorSave={invoke:async(target,...args)=>{calls.push(target);if(target==='tile-detect/tile-detect::to-tilemap')return {ok:structuredClone(output)};assert.equal(target,'fs/fs::write-text');writes.push(args);return {ok:null};}};
  const view={extractOutput:{tilemap:{'tile-w':16,'tile-h':height}},tilesetPath,setStatus(){},setResult(){}};
  return {view,writes,calls,output,save:()=>ViewTileExtractor.prototype.saveTilemapJsonToPath.call(view,'map.tilemap.json')};
}
test('save writes editor-compatible property objects, tile size and the saved atlas reference',async()=>{
  const f=fixture();try{await f.save();assert.equal(f.writes.length,1);const [path,text]=f.writes[0];assert.equal(path,'map.tilemap.json');assert.ok(text.endsWith('\n'));assert.deepEqual(JSON.parse(text),{
    layers:[{width:2,data:[1,2,1,0],props:{name:'extracted'}}],
    props:{tileHeight:'16',tileWidth:'16',tileSize:'16',tilesets:JSON.stringify([{file:'repeats.tileset.qoi'}])},
  });assert.ok(Array.isArray(f.output.props));}finally{delete globalThis.__extractorSave;}
});
test('save without a saved atlas does not invent a file reference',async()=>{
  const f=fixture('');try{await f.save();const document=JSON.parse(f.writes[0][1]);assert.equal(document.props.tileSize,'16');assert.equal(Object.hasOwn(document.props,'tilesets'),false);assert.deepEqual(document.layers[0].props,{name:'extracted'});}finally{delete globalThis.__extractorSave;}
});
test('rectangular tiles fail explicitly instead of writing a misleading square-grid document',async()=>{
  const f=fixture('repeats.tileset.qoi',8);try{await assert.rejects(f.save(),/square tiles/);assert.equal(f.writes.length,0);}finally{delete globalThis.__extractorSave;}
});

test('editing extraction settings invalidates the preview and both export destinations', () => {
  const input = new EventTarget();
  input.value = '16';
  input.validity = {valid: true};
  const oldOutput = {};
  const view = Object.assign(new ViewTileExtractor(), {
    extractOutput: oldOutput, tilesetPath: 'old.qoi', tilemapPath: 'old.json',
    requiredInput: () => input, draw() {}, setStatus() {}, updateSaveButtons() {},
    renderTilebankPreview() { this.preview = this.extractOutput; },
    setResult(text) { this.result = text; },
  });
  view.bindNumberField('tile-w', 'tileW');
  input.dispatchEvent(new Event('change'));
  assert.equal(view.extractOutput, oldOutput);
  input.value = '8';
  input.dispatchEvent(new Event('input'));
  assert.deepEqual([view.tileW, view.extractOutput, view.preview, view.tilesetPath, view.tilemapPath, view.result],
    [8, null, null, '', '', 'No extraction performed']);
  view.extractOutput = oldOutput;
  input.value = '';
  input.dispatchEvent(new Event('input'));
  assert.equal(view.extractOutput, null);
});

test('a save prepared before settings change does not write stale data', async () => {
  const f = fixture();
  try {
    const save = f.save();
    f.view.extractOutput = null;
    await save;
    assert.equal(f.writes.length, 0);
  } finally { delete globalThis.__extractorSave; }
});
