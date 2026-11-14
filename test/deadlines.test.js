import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportAnalysis, exportDeadlines } from '../src/engine.js';
import { readJson, readText, atomicJson, atomicText, acquireLock } from '../src/storage.js';
import { validateInput, validateState, deadlinePlan, analyzeDeadlines, civilDate, dateFromOrdinal, isLeap, POLICY_HASH, itemsFor, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/input.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = simple;
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-deadlines-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later selections; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'normal'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.item_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { q.is_handoff = 'false'; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a selection', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'normal'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'normal'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.analysis, null);
    await s.run(); assert.equal(sends(s.api), 2);
  }
});

test('original asker, lifetime and intent remain bound across reads and original creation intent', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'ready'); assert.equal((await localReport(s.directory, s.options.input)).analysis, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'normal');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'normal'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'normal'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing reviewer before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'normal');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'normal'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).analysis, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


test('observation time cannot regress across reads or precede a durable intent on disk',async t=>{
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  const before=await readFile(join(s.directory,'state.json'),'utf8');s.clock.value='2026-01-01T09:00:30.000Z';
  await assert.rejects(s.run(),/regressed/);assert.equal(await readFile(join(s.directory,'state.json'),'utf8'),before);
  const saved=await s.saved();saved.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';
  assert.throws(()=>validateState(saved,s.options.input),/predates/);
});
const one = (calendar={},request={}) => ({batchId:'unit',title:'Work date',calendars:[{id:'c',label:'Calendar',reference:'Explicit v1',from:'2024-01-01',through:'2024-12-31',weekdays:[1,2,3,4,5],exceptions:[],...calendar}],requests:[{id:'a',context:'Harmless work',start:'2024-01-01',workingDays:1,...request}]});
const analyze = input => analyzeDeadlines(input,{a:'c'}).results[0];
// Independent UTC reference: native Gregorian rollover and getUTCDay, not ordinals.
function utcOracle(calendar,request){
  const date=new Date(`${request.start}T00:00:00Z`),overrides=new Map(calendar.exceptions.map(e=>[e.date,e.open]));let counted=0;const trail=[];
  date.setUTCDate(date.getUTCDate()+1);
  while(date.toISOString().slice(0,10)<=calendar.through && counted<request.workingDays){
    const day=date.toISOString().slice(0,10),weekday=date.getUTCDay()||7,override=overrides.get(day),open=override===undefined?calendar.weekdays.includes(weekday):override;
    if(open)counted++;
    trail.push({date:day,weekday,open,reason:override===undefined?(open?'weekday_open':'weekday_closed'):(open?'override_open':'override_closed'),counted});date.setUTCDate(date.getUTCDate()+1);
  }
  return {dueDate:counted===request.workingDays?trail.at(-1).date:null,counted,trail};
}
test('ordinal conversion and ISO weekdays agree with UTC for every supported civil day',()=>{
  const first=civilDate('2000-01-01').ordinal,last=civilDate('2099-12-31').ordinal;let count=0;
  for(let ordinal=first;ordinal<=last;ordinal++){
    const text=dateFromOrdinal(ordinal),parsed=civilDate(text),native=new Date(`${text}T00:00:00Z`);
    assert.equal(parsed.ordinal,ordinal);assert.equal(parsed.weekday,native.getUTCDay()||7);
    assert.equal(native.toISOString().slice(0,10),text);assert.equal((native-Date.UTC(2000,0,1))/86400000,ordinal-first);count++;
  }
  assert.equal(count,36525);assert.equal(isLeap(2000),true);assert.equal(isLeap(1900),false);assert.equal(isLeap(2100),false);assert.equal(isLeap(2400),true);
});
test('independent UTC oracle agrees for 3,048 weekday, override, start and duration combinations',()=>{
  let cases=0;
  for(let mask=1;mask<128;mask++)for(const start of ['2024-02-27','2024-02-28','2024-03-01'])for(const workingDays of [1,2,7,30])for(const overridden of [false,true]){
    const weekdays=Array.from({length:7},(_,i)=>i+1).filter(day=>mask&(1<<(day-1))),input=one({from:'2024-02-01',through:'2024-03-15',weekdays,exceptions:overridden?[{date:'2024-02-29',open:false},{date:'2024-03-02',open:true}]:[]},{start,workingDays});
    const actual=analyze(input),expected=utcOracle(input.calendars[0],input.requests[0]);
    assert.deepEqual(actual.trail,expected.trail);assert.equal(actual.dueDate,expected.dueDate);assert.equal(actual.counted,expected.counted);
    assert.equal(actual.remaining,workingDays-expected.counted);assert.equal(actual.status,expected.dueDate===null?'coverage_exhausted':'scheduled');cases++;
  }
  assert.equal(cases,3048);
});
test('start is excluded even when forced open; closed starts are allowed; due horizon is inclusive',()=>{
  assert.equal(analyze(one({}, {start:'2024-01-01',workingDays:1})).dueDate,'2024-01-02');
  assert.equal(analyze(one({}, {start:'2024-01-06',workingDays:1})).dueDate,'2024-01-08');
  const startOpen=one({from:'2024-01-06',through:'2024-01-08',exceptions:[{date:'2024-01-06',open:true}]},{start:'2024-01-06'});
  assert.equal(analyze(startOpen).dueDate,'2024-01-08');
  const exhausted=analyze(one({from:'2024-01-01',through:'2024-01-01'}));assert.equal(exhausted.status,'coverage_exhausted');assert.deepEqual(exhausted.trail,[]);assert.equal(exhausted.remaining,1);
});
test('leap days, year crossings, weekends and explicit open/closed overrides count exactly',()=>{
  assert.equal(analyze(one({from:'2024-02-28',through:'2024-03-05'},{start:'2024-02-28',workingDays:2})).dueDate,'2024-03-01');
  assert.equal(analyze(one({from:'2000-02-28',through:'2000-03-03'},{start:'2000-02-28',workingDays:1})).dueDate,'2000-02-29');
  assert.equal(analyze(one({from:'2023-12-29',through:'2024-01-10'},{start:'2023-12-29',workingDays:2})).dueDate,'2024-01-02');
  const result=analyze(one({from:'2024-01-05',through:'2024-01-10',exceptions:[{date:'2024-01-06',open:true},{date:'2024-01-08',open:false}]},{start:'2024-01-05',workingDays:2}));
  assert.equal(result.dueDate,'2024-01-09');assert.deepEqual(result.trail.map(r=>[r.date,r.reason,r.counted]),[['2024-01-06','override_open',1],['2024-01-07','weekday_closed',1],['2024-01-08','override_closed',1],['2024-01-09','weekday_open',2]]);
});
test('all-closed overrides exhaust coverage without fabricating a date outside the horizon',()=>{
  const input=one({from:'2024-01-01',through:'2024-01-05',weekdays:[1,2,3,4,5,6,7],exceptions:[1,2,3,4,5].map(day=>({date:`2024-01-0${day}`,open:false}))},{start:'2024-01-01',workingDays:30});
  const result=analyze(input);assert.equal(result.dueDate,null);assert.equal(result.counted,0);assert.equal(result.remaining,30);assert.equal(result.trail.at(-1).date,input.calendars[0].through);assert.equal(result.trail.length,4);
});
test('Unknown and missing choices withhold the whole batch; known exhausted calendars are complete',()=>{
  const input=simple();for(const choice of [null,'unknown']){
    const result=deadlinePlan(input,[{requestId:'a',choice},{requestId:'b',choice:'normal'}]);assert.equal(result.analysis,null);assert.equal(result.status,choice===null?'incomplete':'unknown');
  }
  const result=deadlinePlan(input,[{requestId:'a',choice:'short'},{requestId:'b',choice:'normal'}]);assert.equal(result.status,'complete');assert.equal(result.analysis.allScheduled,false);assert.equal(result.analysis.deadlines,null);
});
test('calendar, request, weekday and override order canonicalize; changed meaning remains bound',()=>{
  const input=simple(),shuffled=structuredClone(input);shuffled.calendars.reverse();shuffled.requests.reverse();shuffled.calendars.forEach(c=>{c.weekdays.reverse();c.exceptions.reverse();});
  assert.deepEqual(validateInput(input),validateInput(shuffled));assert.deepEqual(analyzeDeadlines(input,{a:'normal',b:'short'}),analyzeDeadlines(shuffled,{a:'normal',b:'short'}));
  const changed=simple();changed.calendars[0].exceptions[0].open=true;assert.notEqual(hash(validateInput(changed)),hash(validateInput(input)));
});
test('dates reject noncanonical, impossible and out-of-range forms and numeric ordinals are bounded',()=>{
  for(const value of ['2024-2-01','2024-02-1','2023-02-29','2000-02-30','2024-04-31','2024-00-01','2024-13-01','2024-01-00','1999-12-31','2100-01-01','2024-01-01\n','2024-01-01T00:00:00Z',' 2024-01-01',null,[]])assert.throws(()=>civilDate(value));
  for(const value of [0,NaN,Infinity,1.5,civilDate('2000-01-01').ordinal-1,civilDate('2099-12-31').ordinal+1])assert.throws(()=>dateFromOrdinal(value));
});
test('strict schemas reject holes, unknown fields, conflicting overrides, invalid ranges and uncovered starts',()=>{
  const input=simple();for(const mutate of [
    x=>{x.extra=1;},x=>{x.batchId+='\n';},x=>{x.title='\ud800';},x=>{x.title='x'.repeat(41);},x=>{x.calendars=[];},x=>{x.calendars=Array(1);},x=>{x.requests=[];},x=>{x.requests=Array(1);},
    x=>{x.calendars[0].id='unknown';},x=>{x.calendars[0].id='constructor';},x=>{x.calendars[0].id='a'.repeat(13);},x=>{x.calendars[1].id=x.calendars[0].id;},x=>{x.calendars[0].reference='\u200b';},x=>{x.calendars[0].label='x'.repeat(25);},
    x=>{x.calendars[0].weekdays=[];},x=>{x.calendars[0].weekdays=[1,1];},x=>{x.calendars[0].weekdays=Array(1);},x=>{x.calendars[0].weekdays=[0];},x=>{x.calendars[0].weekdays=[8];},x=>{x.calendars[0].weekdays=['1'];},
    x=>{x.calendars[0].through='2026-10-01';},x=>{x.calendars[0].through='2027-12-01';},x=>{x.calendars[0].exceptions=Array(1);},x=>{x.calendars[0].exceptions[0].open='false';},x=>{x.calendars[0].exceptions.push({...x.calendars[0].exceptions[0]});},
    x=>{x.calendars[0].exceptions.push({...x.calendars[0].exceptions[0],open:true});},x=>{x.calendars[0].exceptions[0].date='2026-12-01';},x=>{x.requests[0].start='2026-10-31';},x=>{x.requests[0].workingDays=0;},x=>{x.requests[0].workingDays=31;},x=>{x.requests[0].workingDays=1.5;},x=>{x.requests[1].id=x.requests[0].id;},
  ]){const bad=structuredClone(input);mutate(bad);assert.throws(()=>validateInput(bad));}
  assert.throws(()=>analyzeDeadlines(input,{a:'unknown',b:'normal'}));assert.throws(()=>analyzeDeadlines(input,{'a,b':'normal'}));assert.throws(()=>deadlinePlan(input,Array(2)));assert.throws(()=>deadlinePlan(input,[{requestId:'b',choice:'normal'},{requestId:'a',choice:'normal'}]));
});
test('Questions identify calendar IDs despite identical labels and bind exact calendar semantics',()=>{
  const input=simple();input.calendars[1].label=input.calendars[0].label;const request=requestFor(input,CONFIG,'a',id(20));
  assert.notEqual(request.options[0].label,request.options[1].label);assert.ok(request.prompt.includes('2026-11-13'));assert.ok(request.prompt.includes('3 workdays'));
  for(const calendar of validateInput(input).calendars){assert.ok(request.prompt.includes(calendar.reference));assert.ok(request.prompt.includes(hash(calendar).slice(0,8)));}
  assert.equal(request.context.length,39);assert.ok(request.prompt.length<=500);assert.equal(request.data.policy_hash,POLICY_HASH);assert.equal(request.options.at(-1).value,'unknown');
  const long=simple();long.calendars.push({...long.calendars[0],id:'c'.repeat(12),reference:'r'.repeat(24)});long.title='t'.repeat(40);long.requests[0].context='x'.repeat(60);long.calendars.forEach((c,i)=>{c.reference='r'.repeat(24);c.id=String.fromCharCode(97+i).repeat(12);c.weekdays=[1,2,3,4,5,6,7];});assert.throws(()=>validateInput(long),/prompt exceeds/);
});
test('maximum 3×366 overrides and eight365-day trails fit actual input and private output bounds',async t=>{
  const start=civilDate('2024-01-01').ordinal;
  const input={batchId:'b'.repeat(40),title:'例'.repeat(40),calendars:['a','b','c'].map(letter=>({id:letter.repeat(12),label:'例'.repeat(24),reference:'例'.repeat(24),from:'2024-01-01',through:'2024-12-31',weekdays:[1],exceptions:Array.from({length:366},(_,i)=>({date:dateFromOrdinal(start+i),open:false}))})),requests:Array.from({length:8},(_,i)=>({id:`r${i}${'x'.repeat(10)}`,context:'例'.repeat(60),start:'2024-01-01',workingDays:30}))};
  validateInput(input);assert.equal(requestFor(input,CONFIG,input.requests[0].id,id(20)).prompt.length,500);assert.equal(requestFor(input,CONFIG,input.requests[0].id,id(20)).options[0].label.length,38);const raw=JSON.stringify(input,null,2)+'\n';assert.ok(Buffer.byteLength(raw)<262144);
  const s=await setup(t,input);await writeFile(join(s.directory,'input.json'),raw);assert.deepEqual(await readJson(join(s.directory,'input.json'),262144),input);
  const result=await decide(s,Array(8).fill('a'.repeat(12)));assert.equal(result.status,'complete');assert.equal(result.analysis.allScheduled,false);assert.equal(result.analysis.results[0].trail.length,365);
  await localReport(s.directory,input,{save:true});await exportAnalysis(s.directory,input);const size=(await stat(join(s.directory,'analysis.json'))).size;assert.ok(size<1024*1024);await assert.rejects(exportDeadlines(s.directory,input));
  console.log(`Maximum calendar fixture: input ${Buffer.byteLength(raw)} bytes; export ${size} bytes`);
});
test('optional SDK defaults may be absent; poll tally and nondefault flags fail',async t=>{
  const s=await setup(t);await s.run();const q=s.api.questions.get(id(1));delete q.is_handoff;delete q.results;q.options.forEach(option=>{delete option.primary;delete option.destructive;});s.api.answer(id(1),'normal');assert.equal((await s.run()).answers[0].choice,'normal');
  for(const mutate of [q=>{q.results=[];},q=>{q.results={};},q=>{q.is_handoff=true;},q=>{q.is_handoff=null;},q=>{q.options[0].primary=true;},q=>{q.options[0].destructive='false';}]){const other=await setup(t);await other.run();mutate(other.api.questions.get(id(1)));await assert.rejects(other.run());assert.equal((await other.saved()).attempts[0].status,'pending');}
});
test('changed asking registrations and input/config/credential drift cannot authorize another request',async t=>{
  const s=await setup(t);await decide(s,['normal']);s.api.controls.loseNext=true;await s.run();s.api.questions.get(id(2)).asker.id=OTHER;s.api.answer(id(2),'normal');await assert.rejects(s.run({command:'recover',attachId:id(2)}),/different asking registrations/);
  const other=await setup(t);await other.run();const calls=other.api.calls.length;const input=simple();input.calendars[0].exceptions[0].open=true;
  for(const extra of [{input},{token:'changed'},{room:`${ROOM_CODE}\n`},{config:{participant:{id:OTHER,label:'Other'}}}])await assert.rejects(other.run(extra));assert.equal(other.api.calls.length,calls);
  assert.equal(isId(`${id(1)}\n`),false);assert.equal(ROOM.test(`${ROOM_CODE}\n`),false);assert.throws(()=>validateConnection({token:'token\n',room:ROOM_CODE}));
});
test('known exhausted horizons export negative analysis; Unknown and tampered evidence cannot export',async t=>{
  const s=await setup(t),result=await decide(s,['short','normal']),calls=s.api.calls.length;assert.equal(result.analysis.results[0].status,'coverage_exhausted');
  assert.deepEqual((await exportAnalysis(s.directory,s.options.input)).analysis,result.analysis);await assert.rejects(exportDeadlines(s.directory,s.options.input),/coverage/);assert.equal(s.api.calls.length,calls);assert.equal((await stat(join(s.directory,'analysis.json'))).mode&0o777,0o600);
  const saved=await s.saved();saved.attempts[0].observation.answer.label='Wrong';await atomicJson(s.directory,'state.json',saved);await assert.rejects(exportAnalysis(s.directory,s.options.input));
  const other=await setup(t);await decide(other,['unknown','normal']);await assert.rejects(exportAnalysis(other.directory,other.options.input),/known valid/);await assert.rejects(exportDeadlines(other.directory,other.options.input));
});
