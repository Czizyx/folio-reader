import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,PDFHexString} from 'pdf-lib';
import {contentId} from '../src/identity.js';
test('modified PDF with preserved embedded ID has a separate note namespace',async()=>{
 const original=await PDFDocument.create();original.addPage([200,200]);
 original.context.trailerInfo.ID=original.context.obj([PDFHexString.of('abcdef0123456789'),PDFHexString.of('abcdef0123456789')]);
 const bytes=await original.save();
 const changed=await PDFDocument.load(bytes);changed.getPages()[0].drawText('Flattened annotation');const exported=await changed.save();
 const reloaded=await PDFDocument.load(exported);
 assert.equal(original.context.trailerInfo.ID.toString(),reloaded.context.trailerInfo.ID.toString());
 assert.notEqual(await contentId(bytes),await contentId(exported));
 assert.equal(await contentId(bytes),await contentId(bytes.slice()));
});
