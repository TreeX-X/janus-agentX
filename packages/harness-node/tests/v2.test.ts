import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,it,expect} from 'vitest';
import {parseNote,serializeNote} from '@janus-agent/harness-core';
import {previewHarnessInit,applyHarnessInit,NoteService,NoteChatEditor,buildNoteIndex,applyChangeSet,recoverPending} from '../src/index.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'agentx-v2-'));roots.push(root);const plan=await previewHarnessInit(root);await applyHarnessInit(plan);return {root,plan};}
it('initializes a project module and maintains/relocates/converts documents without generating a Task',async()=>{
 const {root}=await fixture(),service=new NoteService(),editor=new NoteChatEditor(service),signal=new AbortController().signal;
 const initial=await buildNoteIndex(root), owner=`note://${initial.repoId}/${initial.entries[0].note!.meta.id}`;
 await editor.write(root,'test','create',{reason:'record idea',operations:[{type:'create',kind:'idea',title:'Topic',module:owner,sections:{Intent:'Explore this.'}}]},true,signal);
 const index=await buildNoteIndex(root);expect(index.diagnostics).toEqual([]);expect(index.entries.map(e=>e.note?.meta.kind).sort()).toEqual(['idea','module']);
 const idea=index.entries.find(e=>e.note?.meta.kind==='idea')!;expect(idea.relPath).toBe('.agents/notes/topic.md');
 const uri=`note://${index.repoId}/${idea.note!.meta.id}`,read=await editor.read(root,uri), created=idea.note!.meta.created;
 await editor.write(root,'test','convert',{reason:'confirmed requirement',operations:[{type:'update',uri,expectedHash:read.expectedHash,kind:'requirement',relativePath:'requirements/topic.md',sections:{'Expected behavior':'Maintain the topic.','Acceptance criteria':'- [ ] AC-1: Kept.'}}]},true,signal);
 const current=await new NoteService().readNote(root,uri);expect(current.relPath).toBe('.agents/notes/requirements/topic.md');expect(current.note.meta.created).toBe(created);expect(current.note.meta.updated).not.toBe(idea.note!.meta.updated);expect(current.note.meta.kind).toBe('requirement');
 expect((await buildNoteIndex(root)).diagnostics).toEqual([]);
 await expect(readFile(join(root,idea.relPath))).rejects.toMatchObject({code:'ENOENT'});
});
it('rejects deleting a module with live owned documents',async()=>{
 const {root}=await fixture(),index=await buildNoteIndex(root),entry=index.entries[0],uri=`note://${index.repoId}/${entry.note!.meta.id}`;
 const editor=new NoteChatEditor(new NoteService()),signal=new AbortController().signal;
 await editor.write(root,'test','create',{reason:'record note',operations:[{type:'create',kind:'note',title:'Topic',module:uri,sections:{Description:'Keep.'}}]},true,signal);
 const read=await editor.read(root,uri);
 await expect(editor.write(root,'test','delete',{reason:'remove',operations:[{type:'delete',uri,expectedHash:read.expectedHash}]},true,signal)).rejects.toBeDefined();
 expect((await buildNoteIndex(root)).entries).toHaveLength(2);
});
it('keeps parent documents beside planned child modules and exposes navigation metadata',async()=>{
 const {root}=await fixture(),index=await buildNoteIndex(root),owner=`note://${index.repoId}/${index.entries[0].note!.meta.id}`;
 const editor=new NoteChatEditor(new NoteService()),signal=new AbortController().signal;
 await editor.write(root,'test','module',{reason:'plan parser',operations:[{type:'create',kind:'module',title:'Parser',parent:owner,relativePath:'parser/module.md',moduleState:'planned',sections:{Responsibility:'Parse sources.',Design:'Implementation is planned.'}}]},true,signal);
 await editor.write(root,'test','parent-note',{reason:'record overall design',operations:[{type:'create',kind:'note',title:'Overall design',module:owner,sections:{Description:'Parent explanation remains complete.'}}]},true,signal);
 const listing=await editor.list(root,'',undefined,{kind:'module',module:owner,moduleState:'planned'});
 expect(listing.notes).toHaveLength(1);expect(listing.notes[0]).toMatchObject({kind:'module',parent:owner,moduleState:'planned',path:'.agents/notes/parser/module.md'});
 expect(listing.truncated).toBe(false);expect(listing.notes[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
 const parentDocs=await editor.list(root,'',undefined,{kind:'note',module:owner});expect(parentDocs.notes).toHaveLength(1);
});
it('recovers both sides of a moved document after interruption',async()=>{
 const {root}=await fixture(),index=await buildNoteIndex(root),owner=`note://${index.repoId}/${index.entries[0].note!.meta.id}`;
 const editor=new NoteChatEditor(new NoteService());await editor.write(root,'test','create',{reason:'note',operations:[{type:'create',kind:'note',title:'Topic',module:owner,sections:{Description:'Kept.'}}]},true,new AbortController().signal);
 const old=(await buildNoteIndex(root)).entries.find(e=>e.note?.meta.kind==='note')!,note=parseNote(await readFile(join(root,old.relPath),'utf8'));
 const cs={id:randomUUID(),revision:1,source:{type:'manual' as const,id:'test',revision:1},operations:[{operationId:'move',type:'replace' as const,uri:`note://${index.repoId}/${note.meta.id}`,expectedHash:old.sha256,relativePath:'details/topic.md',afterMarkdown:serializeNote(note),dependsOn:[],noteDiagnostics:[]}]};
 await expect(applyChangeSet(root,cs,{requestDigest:'move',inject:{failAfter:'temp'}})).rejects.toBeDefined();
 expect((await recoverPending(root)).blocked).toEqual([]);
 await expect(readFile(join(root,old.relPath))).rejects.toMatchObject({code:'ENOENT'});
 expect((await buildNoteIndex(root)).entries.find(e=>e.note?.meta.id===note.meta.id)?.relPath).toBe('.agents/notes/details/topic.md');
});
