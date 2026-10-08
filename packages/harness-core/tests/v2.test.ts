import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parseNote,serializeNote,validateNote,taskContractHash,noteInputDigest,patchTaskExecution} from '../src/index.js';
import {canonical} from '../src/workflowx-v2/reference.js';
const file=(name:string)=>readFileSync(new URL('../../../standards/harness-note/2/'+name,import.meta.url),'utf8');
describe('WorkflowX v2 conformance',()=>{
  it('accepts all six kinds and preserves metadata through serialization',()=>{
    for(const kind of ['module','note','idea','requirement','decision','task']) {
      const note=parseNote(file('fixtures/valid-'+kind+'.md'));
      expect(validateNote(note)).toEqual([]);
      expect(parseNote(serializeNote(note)).meta).toEqual(note.meta);
    }
  });
  it('matches the upstream hash locks and preserves execution literals',()=>{
    const locks=JSON.parse(file('fixtures/expected-hashes.json'));
    for(const row of locks) { const note=parseNote(file(row.path)); expect(row.kind==='task'?taskContractHash(note):noteInputDigest(note)).toBe(row.sha256); }
    const a=parseNote(file('fixtures/valid-task.md')), b=structuredClone(a);
    a.meta.work!.verification[0].args=['- [x] literal']; b.meta.work!.verification[0].args=['- [ ] literal'];
    expect(taskContractHash(a)).not.toBe(taskContractHash(b));
    const raw=file('fixtures/valid-task.md');
    expect(taskContractHash(parseNote(raw.replace('# Delivery task','# Handle `alpha`')))).not.toBe(taskContractHash(parseNote(raw.replace('# Delivery task','# Handle `beta`'))));
    expect(canonical({'\u{10000}':1,'\uE000':2})).toBe('{"\uE000":2,"\u{10000}":1}');
    const req=file('fixtures/valid-requirement.md');
    expect(noteInputDigest(parseNote(req))).toBe(noteInputDigest(parseNote(req.replace('- [ ] AC-1','- [x] AC-1'))));
  });
  it('patches JSON execution while preserving its contract and refreshing maintenance time',()=>{
    const raw=file('fixtures/valid-task.md'), note=parseNote(raw);
    const updated=parseNote(patchTaskExecution(raw,{mode:'xdo',state:'queued',attempt:1,receipts:[],closeout:'commit-required',baseline:{taskContractHash:taskContractHash(note),inputs:[]}}));
    expect(updated.meta.updated).not.toBe(note.meta.updated);
    expect(taskContractHash(updated)).toBe(taskContractHash(note));
  });
  it('writes compact metadata without changing command literals, body or BOM/EOL',()=>{
    const note=parseNote(file('fixtures/valid-task.md'));
    note.meta.work!.verification[0].args=['- [x] literal', '引号 " 和换行\n', '', '  '];
    note.bom=true;note.eol='\r\n';
    const encoded=serializeNote(note), roundtrip=parseNote(encoded);
    expect(encoded.startsWith('\uFEFF---\r\n')).toBe(true);
    expect(roundtrip.meta).toEqual(note.meta);
    expect(taskContractHash(roundtrip)).toBe(taskContractHash(note));
    expect(roundtrip.body.replace(/\r\n/g,'\n')).toBe(note.body.replace(/\r\n/g,'\n'));
    expect(serializeNote(roundtrip)).toBe(encoded);
    expect(encoded.length).toBeLessThan(JSON.stringify(note.meta,null,2).length+note.body.length+80);
  });
});
