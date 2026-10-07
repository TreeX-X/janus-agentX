import {readFileSync, existsSync} from 'node:fs';
import {buildNoteIndex} from '../packages/harness-node/dist/index.js';
const root=process.cwd(), index=await buildNoteIndex(root);
const inventory=JSON.parse(readFileSync('docs/migrations/note-v2.json','utf8'));
const errors=[...index.diagnostics];
for(const row of inventory.sources) {
 if(existsSync(row.source)) errors.push({message:'legacy source remains: '+row.source});
 if(!index.entries.some(e=>e.relPath===row.target&&e.note?.meta.id===row.id)) errors.push({message:'missing migrated identity: '+row.target});
}
for(const entry of index.entries) {
 const excluded=inventory.deferred?.find(row=>row.path===entry.relPath);
 if(excluded) {if(entry.sourceHash!==excluded.sha256)errors.push({message:'protected source changed: '+entry.relPath});continue;}
 if(entry.note?.meta.schema!=='harness-note/2') errors.push({message:'unmigrated source: '+entry.relPath});
}
for(const problem of errors) console.error(problem);
console.log(`${index.entries.filter(e=>e.note?.meta.schema==='harness-note/2').length} v2 documents; ${inventory.sources.length} migrated originals; ${errors.length} errors; ${index.readDiagnostics.length} read-side diagnostics (including external references). Protected untracked sources are excluded by exact hash.`);
process.exitCode=errors.length?1:0;
