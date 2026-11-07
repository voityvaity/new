'use strict';

// GPT-Live transcripts do not carry turn IDs or a "turn completed" event.
// Accumulate each speaker independently, and use timeline gaps only to infer
// rough utterance boundaries. Never switch the owner of a fragment because the
// other speaker spoke in the meantime.
function createTranscriptTracker({gapMs = 1800} = {}) {
  let serial = 0;
  const streams = {candidate:[], interviewer:[]};
  const seenEvents = new Set();

  function append(role, delta, start, end, eventId) {
    if (!(role in streams) || typeof delta !== 'string' || delta === '') return false;
    if (typeof eventId === 'string' && eventId && seenEvents.has(eventId)) return false;
    if (typeof eventId === 'string' && eventId) seenEvents.add(eventId);
    const a = Number.isFinite(start) ? Math.max(0,start) : null;
    const b = Number.isFinite(end) ? Math.max(a ?? 0,end) : a;
    const chunks = streams[role];
    const last = chunks[chunks.length-1];
    // An unavailable timestamp is not evidence of temporal proximity.
    // Delivery still belongs to the correct speaker, but starts a new segment.
    const opposite=streams[role==='candidate'?'interviewer':'candidate'];
    // A complete utterance from the other speaker between these fragments
    // is evidence of a turn boundary, even when the gap is under 1.8 seconds.
    // Overlapping interjections are allowed without changing speaker ownership.
    const interrupted=!!last && a!==null && last.end!==null &&
      opposite.some(x=>x.start!==null && x.end!==null &&
        x.start>=last.end && x.end<=a && x.end>x.start);
    const merge = !!last && !interrupted && a !== null && last.end !== null &&
      a >= last.start - 300 && a - last.end <= gapMs;
    if (merge) {
      // Preserve ASR fragments, but separate clear sentence boundaries.
      const boundary=/[.!?…]$/.test(last.text) && /^[А-ЯЁA-Z]/.test(delta);
      last.text += boundary && !/\s$/.test(last.text) ? ' '+delta : delta;
      last.end = Math.max(last.end,b ?? last.end);
    } else {
      chunks.push({role, text:delta, start:a, end:b, order:serial++});
    }
    return true;
  }

  function turns() {
    return [...streams.candidate,...streams.interviewer]
      .sort((a,b) => (a.start ?? Number.MAX_SAFE_INTEGER) -
                      (b.start ?? Number.MAX_SAFE_INTEGER) || a.order-b.order)
      .map(({role,text,start,end})=>({role,text,start,end}));
  }
  function reset() {
    streams.candidate.length=0;streams.interviewer.length=0;
    seenEvents.clear();serial=0;
  }
  return {append,turns,reset};
}

// A label is required on each NEW main question; follow-ups are not numbered.
// Only explicitly observed sequential numbers change the count, so ordinary
// question marks or interviewer clarifications cannot inflate it.
const MAIN_LABEL = /(?:^|[\s,.!?;:])(?:основной\s+)?вопрос\s*№?\s*(\d{1,2})(?:\s*из\s*\d{1,2})?\s*[:.?!—-]/giu;
function createQuestionTracker(total) {
  const target=[5,8,10].includes(total)?total:8;
  let confirmed=0;
  const seen = new Set();
  let overLimit=false;
  let gapDetected=false;
  function inspect(turns) {
    // Question headers may be split across audio packets, including a long
    // pause that created two visible segments ("Вопрос" and "1:").
    // The counter parses the full interviewer stream, not UI turn boundaries.
    const interviewerText=turns
      .filter(turn=>turn?.role==='interviewer' && typeof turn.text==='string')
      .map(turn=>turn.text).join(' ');
    const marked=[];
    for(const match of interviewerText.matchAll(new RegExp(MAIN_LABEL.source,MAIN_LABEL.flags)))
      marked.push(Number(match[1]));
    for (const number of marked) {
      if (seen.has(number)) continue;
      seen.add(number);
      if (number > target) overLimit = true;
      else if (number > confirmed+1) gapDetected=true;
    }
    while (seen.has(confirmed+1) && confirmed<target) confirmed++;
    return {confirmed,target,overLimit,gapDetected,
      complete:confirmed===target};
  }
  function reset() {confirmed=0;seen.clear();overLimit=false;gapDetected=false;}
  return {inspect,reset,get confirmed(){return confirmed;},get target(){return target;}};
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports={createTranscriptTracker,createQuestionTracker};
}
if (typeof window !== 'undefined') {
  window.LiveTranscript={createTranscriptTracker,createQuestionTracker};
}
