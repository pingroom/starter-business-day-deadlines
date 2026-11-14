import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson } from './storage.js';
import { step, exportAnalysis, exportDeadlines } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/input.json', import.meta.url), 262144);
for (const [scenario, choices] of [['scheduled',['normal','normal']],['coverage-exhausted',['short','normal']],['unknown',['unknown','normal']]]) {
  const directory=await mkdtemp(join(tmpdir(),'pingroom-deadlines-demo-'));
  try {
    const now=()=> '2026-01-01T09:00:00.000Z',api=mockApi(now),options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};
    let result;
    for(const choice of choices){const pending=await step(options),question=pending.answers.find(row=>row.status==='pending');api.answer(question.questionId,choice);result=await step(options);}
    assert.equal(api.calls.filter(call=>call.method==='POST').length,2);
    if(scenario==='unknown'){
      assert.equal(result.status,'unknown');assert.equal(result.analysis,null);await assert.rejects(exportAnalysis(directory,input));await assert.rejects(exportDeadlines(directory,input));
    }else{
      assert.equal(result.status,'complete');assert.equal(result.analysis.allScheduled,scenario==='scheduled');await exportAnalysis(directory,input);
      if(scenario==='scheduled')await exportDeadlines(directory,input);else await assert.rejects(exportDeadlines(directory,input));
    }
    console.log(JSON.stringify({scenario,status:result.status,analysis:result.analysis,unknownRequestIds:result.unknownRequestIds,mockOnly:true,remindersSent:false,calendarModified:false},null,2));
  }finally{await rm(directory,{recursive:true,force:true});}
}
