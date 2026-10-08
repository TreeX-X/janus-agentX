import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {previewHarnessInit,applyHarnessInit,buildNoteIndex,collectTaskBaseline,runGit} from '@janus-agent/harness-node';
import {parseNote,serializeNote,taskContractHash} from '@janus-agent/harness-core';
import {dispatchRun,startRun} from '../src/harness/dispatcher.js';
import {readLease} from '../src/harness/run-store.js';
import {executeTaskExecution,type TaskVerificationPorts} from '../src/harness/task-execution.js';
it.each(['xdo', 'xdel', 'xflow'] as const)('v2 %s preserves Main Agent ownership and retained review obligations',async mode=>{
 const root=await mkdtemp(join(tmpdir(),'agentx-v2-run-'));
 try {
  const plan=await previewHarnessInit(root);await applyHarnessInit(plan);
  const index=await buildNoteIndex(root), owner=`note://${plan.repoId}/${index.entries[0].note!.meta.id}`;
  const note=parseNote(await readFile(new URL('../../../standards/harness-note/2/fixtures/valid-task.md',import.meta.url),'utf8'));
  note.meta.module=owner;note.meta.lifecycle='accepted';
  const uri=`note://${plan.repoId}/${note.meta.id}`;
  note.meta.work={scope:[{repoId:plan.repoId,paths:['src/']}],acceptanceRefs:[{uri,criterionId:'AC-1'}],verification:[{id:'check',kind:'command',required:true,repoId:plan.repoId,cwd:'.',program:process.execPath,args:['-e','process.exit(0)']}],review:'independent'};
  note.body=note.body.replace('Use work.acceptanceRefs for stable clauses.','- [ ] AC-1: source works');
  note.body=note.body.replace('## Progress', '## Progress\n\nUnverified implementation claim.\n\n<!-- agentx-checkpoint -->\nExecution state: obsolete\n<!-- agentx-checkpoint-end -->');
  note.body=note.body.replace('## Evidence', '## Evidence\n\nAuthored evidence reference.\n\n<!-- agentx-checkpoint -->\nRecorded receipts: obsolete\n<!-- agentx-checkpoint-end -->');
  const path=join(root,'.agents/notes/task.md');await writeFile(path,serializeNote(note));
  await mkdir(join(root,'src'));await writeFile(join(root,'src/file.txt'),'original');runGit(root,['init']);runGit(root,['add','src/file.txt']);
  const base=await collectTaskBaseline(root,uri);if(!base.ok)throw new Error(JSON.stringify(base));
  const run=await dispatchRun(root,{...base.baseline,mode,closeout:'working-tree-authorized',authorizationRef:'test'});
  expect(run.ok).toBe(true);const runId=run.data.runId;
  expect((await startRun(root,runId,'main',{baselineValid:true,dependenciesReady:true,authorization:{by:'test'}})).ok).toBe(true);
  const token=(await readLease(root,runId))!.token,seen:string[]=[];
  const review:NonNullable<TaskVerificationPorts['review']>=async input=>{
    seen.push(input.kind);const task=parseNote(await readFile(path,'utf8'));expect(task.sections.find(s=>s.name==='Handoff')!.text).toContain(input.kind==='independent'?'Independent review':'Self-review');
    expect(await readFile(join(root,'src/file.txt'),'utf8')).toBe('implemented');
    if(input.kind==='independent') expect(input.turn.systemPromptPrefix).not.toContain('Unverified implementation claim.');
    return {review:{kind:input.kind,verdict:'approved',actor:input.actor,reviewedManifestHash:input.manifestHash},coverage:input.criteria.map(c=>({...c,checkIds:['check']}))};
  };
  const result=await executeTaskExecution(root,runId,token,{command:async step=>{execFileSync(step.program!,step.args!);return {ok:true,exitCode:0,summary:'process exited successfully'};},review,...(mode==='xdel'?{}:{independentReview:review}),implement:async turn=>{
    expect(parseNote(await readFile(path,'utf8')).sections.find(s=>s.name==='Handoff')!.text).toContain('Implement or repair');
    const before=await readFile(path,'utf8');
    for(const name of ['workspace_edit','workspace_create','workspace_delete','note_write']) {
      expect(await turn.toolGate!({name,arguments:{path:'.agents/notes/task.md',content:'unauthorized'}})).toMatchObject({block:true});
    }
    expect(await readFile(path,'utf8')).toBe(before);
    await writeFile(join(root,'src/file.txt'),'implemented');return {cancelled:false,text:'Change Summary: implemented.\nNote draft: preserve this result.'};
  }});
  expect(result.implementationResult).toContain('Note draft: preserve this result.');
  expect(result.completed).toBe(mode!=='xdel');expect(seen).toEqual(mode==='xdel'?['self']:['self','independent']);
  if(mode==='xdel') {
    expect(result.errors.join(' ')).toContain('independent review remains pending');
    expect(result.receipt.review.kind).toBe('self');
  } else {expect(result.errors).toEqual([]);expect(result.receipt.review.actor).not.toBe(result.receipt.actor);}
  const after=await readFile(path,'utf8');const saved=parseNote(after);
  expect(saved.meta.work!.review).toBe('independent');
  expect(after.match(/<!-- agentx-checkpoint -->/g)).toHaveLength(1);
  expect(saved.sections.find(s=>s.name==='Progress')!.text).toContain('Unverified implementation claim.');
  expect(saved.sections.find(s=>s.name==='Evidence')!.text).toContain('Authored evidence reference.');
  expect(after).not.toContain('obsolete');
  if(mode==='xdel') expect(saved.sections.find(s=>s.name==='Handoff')!.text).toContain('arranges the required independent evaluation');
  else expect(saved.sections.find(s=>s.name==='Handoff')!.text).toContain('Main Agent integrates Change Summary');
  expect(taskContractHash(parseNote(await readFile(path,'utf8')))).toBe(base.baseline.taskContractHash);
 } finally {await rm(root,{recursive:true,force:true});}
},30000);
