import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__', 'unknown'].includes(value);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const POLICY = Object.freeze({ name: 'bounded-civil-working-day-v1', years: [2000,2099], weekday: 'ISO Monday=1 through Sunday=7', start: 'excluded', overrides: 'explicit open/closed replaces weekday membership', horizon: 'inclusive supplied coverage only', unknown: 'withhold complete batch analysis' });
export const POLICY_HASH = hash(POLICY);
export const isLeap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthLengths = year => [31,isLeap(year)?29:28,31,30,31,30,31,31,30,31,30,31];
const beforeYear = year => { const y=year-1; return 365*y+Math.floor(y/4)-Math.floor(y/100)+Math.floor(y/400); };
export function civilDate(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}(?![\s\S])/.test(value)) throw new Error('Dates must be exact YYYY-MM-DD within 2000–2099.');
  const [year,month,day]=value.split('-').map(Number), months=monthLengths(year);
  if (month<1 || month>12 || day<1 || day>months[month-1]) throw new Error('Invalid Gregorian civil date.');
  const ordinal=beforeYear(year)+months.slice(0,month-1).reduce((a,b)=>a+b,0)+day;
  return {year,month,day,ordinal,weekday:(ordinal-1)%7+1};
}
export function dateFromOrdinal(ordinal) {
  if (!Number.isInteger(ordinal) || ordinal<=beforeYear(2000) || ordinal>beforeYear(2100)) throw new Error('Ordinal is outside 2000–2099.');
  let year=2000;
  while (ordinal>beforeYear(year+1)) year++;
  let remaining=ordinal-beforeYear(year),month=1;
  for (const days of monthLengths(year)) { if (remaining<=days) break; remaining-=days; month++; }
  return `${year}-${String(month).padStart(2,'0')}-${String(remaining).padStart(2,'0')}`;
}
const promptFor = (input, request) => `${input.title}\n${request.id}: ${request.context}\nStart ${request.start}; count ${request.workingDays} workdays strictly after start. Choose a reviewed calendar or Unknown.\n${input.calendars.map(c=>`${c.id}: ${c.reference}; ${c.from}..${c.through}; days ${c.weekdays.join(',')}; overrides ${c.exceptions.length}; ${hash(c).slice(0,8)}`).join('\n')}`;
export function validateInput(input) {
  if (!keys(input,['batchId','title','calendars','requests']) || !word(input.batchId) || !line(input.title,40)
    || !Array.isArray(input.calendars) || input.calendars.length<1 || input.calendars.length>3
    || !Array.isArray(input.requests) || input.requests.length<1 || input.requests.length>8) throw new Error('Supply a batch ID, title, 1–3 calendars and 1–8 work requests.');
  const calendarIds=new Set();
  const calendars=Array.from(input.calendars,c=>{
    if (!keys(c,['id','label','reference','from','through','weekdays','exceptions']) || !safeId(c.id) || calendarIds.has(c.id) || !line(c.label,24) || !line(c.reference,24)
      || !Array.isArray(c.weekdays) || c.weekdays.length<1 || c.weekdays.length>7 || new Set(c.weekdays).size!==c.weekdays.length
      || Array.from(c.weekdays).some(day=>!Number.isInteger(day)||day<1||day>7)
      || !Array.isArray(c.exceptions) || c.exceptions.length>366) throw new Error('Calendar IDs, labels, references, weekdays and exceptions must be explicit and bounded.');
    const first=civilDate(c.from).ordinal,last=civilDate(c.through).ordinal;
    if (last<first || last-first+1>366) throw new Error('Calendar coverage must contain 1–366 inclusive civil dates.');
    const dates=new Set();
    const exceptions=Array.from(c.exceptions,e=>{
      if (!keys(e,['date','open']) || typeof e.open!=='boolean') throw new Error('An exception requires an exact date and Boolean open flag.');
      const day=civilDate(e.date).ordinal;
      if (day<first || day>last || dates.has(e.date)) throw new Error('Exception dates must be unique and inside calendar coverage.');
      dates.add(e.date); return {...e};
    }).sort((a,b)=>order(a.date,b.date));
    calendarIds.add(c.id); return {...c,weekdays:[...c.weekdays].sort((a,b)=>a-b),exceptions};
  }).sort((a,b)=>order(a.id,b.id));
  const requestIds=new Set();
  const requests=Array.from(input.requests,r=>{
    if (!keys(r,['id','context','start','workingDays']) || !safeId(r.id) || requestIds.has(r.id) || !line(r.context,60)
      || !Number.isInteger(r.workingDays) || r.workingDays<1 || r.workingDays>30) throw new Error('Requests need unique IDs, context, exact start dates and 1–30 working days.');
    const start=civilDate(r.start).ordinal;
    if (calendars.some(c=>start<civilDate(c.from).ordinal||start>civilDate(c.through).ordinal)) throw new Error('Every request start must be covered by every offered calendar.');
    requestIds.add(r.id); return {...r};
  }).sort((a,b)=>order(a.id,b.id));
  const result={batchId:input.batchId,title:input.title,calendars,requests};
  if (requests.some(r=>promptFor(result,r).length>500)) throw new Error('Calendar-selection prompt exceeds 500 UTF-16 units; shorten metadata.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config,['participant']) || !keys(config.participant,['id','label']) || !isId(config.participant.id) || !line(config.participant.label,60)) throw new Error('Config requires an exact calendar owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => validateInput(input).requests;
export function requestFor(rawInput,config,itemId,attemptId) {
  const input=validateInput(rawInput); validateConfig(config); const request=input.requests.find(r=>r.id===itemId);
  if (!request || !isId(attemptId)) throw new Error('Invalid work request or attempt.');
  const key=`deadline-${attemptId}`;
  return {prompt:promptFor(input,request),context:`To ${config.participant.id}`,
    options:[...input.calendars.map(c=>({value:c.id,label:`${c.id}: ${c.label}`,style:'default'})),{value:'unknown',label:'Unknown',style:'default'}],
    responder_scope:'direct',target_user_id:config.participant.id,ttl:TTL,correlation_id:key,
    data:{input_hash:hash(input),request_hash:hash(request),policy_hash:POLICY_HASH,item_id:request.id,attempt_id:attemptId},idempotencyKey:key};
}
/** Calculate against explicit civil dates, with no locale, timezone or holiday lookup. */
export function analyzeDeadlines(rawInput,selections) {
  const input=validateInput(rawInput), ids=input.requests.map(r=>r.id), calendarIds=input.calendars.map(c=>c.id);
  if (!keys(selections,ids) || ids.some(id=>!calendarIds.includes(selections[id]))) throw new Error('Every request needs one known calendar choice.');
  const results=input.requests.map(request=>{
    const calendar=input.calendars.find(c=>c.id===selections[request.id]), overrides=new Map(calendar.exceptions.map(e=>[e.date,e.open])), trail=[];
    const start=civilDate(request.start).ordinal,end=civilDate(calendar.through).ordinal; let counted=0,dueDate=null;
    for(let ordinal=start+1;ordinal<=end && counted<request.workingDays;ordinal++) {
      const date=dateFromOrdinal(ordinal),weekday=(ordinal-1)%7+1,override=overrides.get(date),open=override??calendar.weekdays.includes(weekday);
      if(open)counted++;
      trail.push({date,weekday,open,reason:override===undefined?(open?'weekday_open':'weekday_closed'):(open?'override_open':'override_closed'),counted});
      if(counted===request.workingDays)dueDate=date;
    }
    return {requestId:request.id,calendarId:calendar.id,calendarHash:hash(calendar),start:request.start,workingDays:request.workingDays,
      status:dueDate===null?'coverage_exhausted':'scheduled',dueDate,counted,remaining:request.workingDays-counted,coveredThrough:calendar.through,trail};
  });
  const allScheduled=results.every(r=>r.status==='scheduled');
  return {version:1,sourceHash:hash(input),policyHash:POLICY_HASH,allScheduled,results,
    deadlines:allScheduled?results.map(({requestId,calendarId,start,workingDays,dueDate})=>({requestId,calendarId,start,workingDays,dueDate})):null};
}
export function deadlinePlan(rawInput,answers) {
  const input=validateInput(rawInput),calendarIds=input.calendars.map(c=>c.id);
  if (!Array.isArray(answers) || answers.length!==input.requests.length || Array.from(answers).some((row,index)=>!keys(row,['requestId','choice'])||row.requestId!==input.requests[index].id||row.choice!==null&&row.choice!=='unknown'&&!calendarIds.includes(row.choice))) throw new Error('Supply one ordered permitted calendar choice, Unknown, or null per work request.');
  const missingRequestIds=answers.filter(row=>row.choice===null).map(row=>row.requestId),unknownRequestIds=answers.filter(row=>row.choice==='unknown').map(row=>row.requestId);
  const status=missingRequestIds.length?'incomplete':unknownRequestIds.length?'unknown':'complete';
  return {status,missingRequestIds,unknownRequestIds,analysis:status==='complete'?analyzeDeadlines(input,Object.fromEntries(answers.map(row=>[row.requestId,row.choice]))):null};
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed work requests or calendars. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved calendar selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}



export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = input.requests.map(request => {
    const attempt = state.attempts.find(row => row.itemId === request.id), answer = attempt?.observation?.answer;
    return { requestId: request.id, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = deadlinePlan(input, answers.map(({ requestId, choice }) => ({ requestId, choice })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  return { version: 1, batchId: input.batchId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status,
    remindersSent: false, calendarModified: false };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved calendar selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered calendar selections must not contain calendar selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
