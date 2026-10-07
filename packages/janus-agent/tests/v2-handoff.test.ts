import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {it,expect} from 'vitest';
import {previewHarnessInit,applyHarnessInit,buildNoteIndex,collectTaskBaseline,runGit} from '@janus-agent/harness-node';
import {parseNote,serializeNote,taskContractHash} from '@janus-agent/harness-core';
import {dispatchRun,startRun} from '../src/harness/dispatcher.js';
import {readLease} from '../src/harness/run-store.js';
import {executeTaskExecution,type TaskVerificationPorts} from '../src/harness/task-execution.js';
it('fresh v2 xdo task retains independent review and checkpoints the shared Task before every handoff',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentx-v2-run-'));
 try {
  const plan=await previewHarnessInit(root);await applyHarnessInit(plan);
  const index=await buildNoteIndex(root), owner=`note://${plan.repoId}/${index.entries[0].note!.meta.id}`;
  const note=parseNote(await readFile(new URL('../../../standards/harness-note/2/fixtures/valid-task.md',import.meta.url),'utf8'));
  note.meta.module=owner;note.meta.lifecycle='accepted';
  const uri=`note://${plan.repoId}/${note.meta.id}`;
  note.meta.work={scope:[{repoId:plan.repoId,paths:['src/']}],acceptanceRefs:[{uri,criterionId:'AC-1'}],verification:[{id:'check',kind:'command',required:true,repoId:plan.repoId,cwd:'.',program:process.execPath,args:['-e','process.exit(0)']}],review:'independent'};
  note.body=note.body.replace('Use work.acceptanceRefs for stable clauses.','- [ ] AC-1: source works');
  const path=join(root,'.agents/notes/task.md');await writeFile(path,serializeNote(note));
  await mkdir(join(root,'src'));await writeFile(join(root,'src/file.txt'),'original');runGit(root,['init']);runGit(root,['add','src/file.txt']);
  const base=await collectTaskBaseline(root,uri);if(!base.ok)throw new Error(JSON.stringify(base));
  const run=await dispatchRun(root,{...base.baseline,mode:'xdo',closeout:'working-tree-authorized',authorizationRef:'test'});
  expect(run.ok).toBe(true);const runId=run.data.runId;
  expect((await startRun(root,runId,'main',{baselineValid:true,dependenciesReady:true,authorization:{by:'test'}})).ok).toBe(true);
  const token=(await readLease(root,runId))!.token,seen:string[]=[];
  const review:NonNullable<TaskVerificationPorts['review']>=async input=>{
    seen.push(input.kind);const task=parseNote(await readFile(path,'utf8'));expect(task.sections.find(s=>s.name==='Handoff')!.text).toContain(input.kind==='independent'?'Independent review':'Self-review');
    expect(await readFile(join(root,'src/file.txt'),'utf8')).toBe('implemented');
    return {review:{kind:input.kind,verdict:'approved',actor:input.actor,reviewedManifestHash:input.manifestHash},coverage:input.criteria.map(c=>({...c,checkIds:['check']}))};
  };
  const result=await executeTaskExecution(root,runId,token,{command:async step=>{execFileSync(step.program!,step.args!);return {ok:true,exitCode:0,summary:'process exited successfully'};},review,independentReview:review,implement:async()=>{
    expect(parseNote(await readFile(path,'utf8')).sections.find(s=>s.name==='Handoff')!.text).toContain('Implement or repair');
    await writeFile(join(root,'src/file.txt'),'implemented');return {cancelled:false};
  }});
  expect(result.errors).toEqual([]);expect(result.completed).toBe(true);expect(seen).toEqual(['self','independent']);expect(result.receipt.review.actor).not.toBe(result.receipt.actor);
  expect(taskContractHash(parseNote(await readFile(path,'utf8')))).toBe(base.baseline.taskContractHash);
 } finally {await rm(root,{recursive:true,force:true});}
},30000);
