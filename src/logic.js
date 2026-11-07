'use strict';
const {OPENING_PROMPT} = require('./live-prompts');
const COUNTS = [5, 8, 10];

function questionCount(value) {
  const n = Number(value);
  return COUNTS.includes(n) ? n : 8;
}

function makeSession(requestedCount) {
  const count = questionCount(requestedCount);
  const instructions = [
    'Ты Александр, виртуальный технический интервьюер. Веди на русском языке реалистичное, уважительное пробное собеседование Junior Python Developer, ориентируясь на вакансию в Яндексе. Ты не сотрудник Яндекса, это неофициальная симуляция.',
    'Начни с короткого знакомства и первого вопроса. Каждый НОВЫЙ основной вопрос начинай коротким маркером «Вопрос N:» (например, «Вопрос 1:»), где N — его номер. Это единственный способ приложению проверять количество. Номера идут строго от 1 до '+count+', без пропусков и повторений. Уточняющие вопросы НЕ нумеруй. Вопросы задавай по одному, дожидаясь ответа.',
    'Проведи ровно ' + count + ' ОСНОВНЫХ вопросов. Из них 1–2 общих (мотивация, обучение, работа в команде), другие технические: Python, mutable/immutable, коллекции, функции, исключения, генераторы, ООП, async/await, SQL, HTTP, тесты. Выбирай по уровню Junior и не пытайся охватить все темы.',
    'Если кандидат ответил неполно, можешь задать не более одного краткого УТОЧНЯЮЩЕГО вопроса на тот же основной. Уточнение не увеличивает счёт основных. Если кандидат говорит "не знаю", просто переходи к следующему.',
    'Не подсказывай правильные ответы в ходе интервью. Не требуй писать код — задача голосовая. Будь живым и естественным, избегай шаблонных похвал и длинных объяснений.',
    'После ответа на основной вопрос '+count+' скажи «Интервью завершено. Нажмите Завершить и оценить». Больше не задавай ни основных, ни уточняющих вопросов. Не называй оценку голосом.',
    'Сохраняй ход разговора и проверяй техническую корректность, при необходимости делегируй задачу backend-модели. Никогда не называй выдуманные вопросы реальными вопросами Яндекса.'
  ].join('\n');
  return {
    model: 'gpt-live-1', store: false, instructions,
    input: [{type:'message',role:'developer',content:[{type:'input_text',text:OPENING_PROMPT}]}],
    audio: { output: { voice: 'marin' } },
    delegation: {
      type: 'responses',
      responses: {
        model: 'gpt-6-luna',
        instructions: 'Помоги голосовому интервьюеру проверять техническую корректность ответов кандидата на уровень Junior Python. При необходимости предложи ОДНО короткое уточнение, либо следующий основной вопрос. Следи за точной нумерацией «Вопрос N:» для основных вопросов от 1 до ' + count + ', не нумеруй уточнения и не предлагай вопрос с номером больше '+count+'. Не выдумывай опыт кандидата и не выдавай неофициальные вопросы за официальные вопросы Яндекса.',
        reasoning: { effort: 'low' },
        max_output_tokens: 450
      }
    }
  };
}

function makeGradeRequest(turns, requestedCount, observedMainQuestions=null) {
  if (!Array.isArray(turns) || turns.length > 2000) throw new Error('Некорректная расшифровка.');
  const cleaned = turns.filter(t => t && ['interviewer','candidate'].includes(t.role) && typeof t.text === 'string')
    .map(t => ({role:t.role,text:t.text.trim()})).filter(t=>t.text);
  // Never silently discard part of a candidate's answer to save tokens.
  // Oversized transcripts remain in the local archive and can be exported.
  const totalChars=cleaned.reduce((total,t)=>total+t.text.length,0);
  if(totalChars>250000)throw new Error(
    'Расшифровка превышает 250 000 символов. Полный текст сохранён локально, автоматическая оценка ограничена по размеру.'
  );
  const answers=cleaned.filter(t=>t.role==='candidate');
  // "Не знаю" is a legitimate (weak) interview answer. Only an entirely
  // missing candidate transcript makes objective grading impossible.
  if(!answers.length)
    throw new Error('Нет распознанных ответов кандидата. Расшифровка сохранена локально; проверь микрофон.');
  return {
    model: 'gpt-6-luna', store: false,
    instructions: 'Ты объективный оценщик тренировочного голосового собеседования Junior Python Developer (неофициальная симуляция для Яндекса). Короткие ответы, включая «не знаю», являются ответами и должны получать честную, возможно низкую оценку. Не отказывай в оценке из-за краткости ответов. Оцени ТОЛЬКО ответы кандидата: техническую корректность, понимание и ясность. Не выдумывай опыт, ответы или вопросы. Оценка 1–10 с честным пояснением. Если прозвучало меньше '+questionCount(requestedCount)+' основных вопросов, сообщи об ограничении оценки. Напиши по-русски 2–4 сильные стороны, 2–4 слабости и 2–4 конкретных шага. Будь доброжелательным, но строгим.',
    input: JSON.stringify({
      target_questions: questionCount(requestedCount),
      // A lower bound based only on explicit numbered questions, not a guess
      // from question marks in the transcript.
      observed_numbered_main_questions:
        Number.isInteger(observedMainQuestions) &&
        observedMainQuestions >= 0 &&
        observedMainQuestions <= questionCount(requestedCount)
          ? observedMainQuestions : null,
      transcript: cleaned
    }),
    text: {format:{type:'json_schema',name:'evaluation',strict:true,schema:{
      type:'object',additionalProperties:false,properties:{
        score:{type:'integer',minimum:1,maximum:10},
        verdict:{type:'string'},
        strengths:{type:'array',items:{type:'string'}},
        improve:{type:'array',items:{type:'string'}},
        next_steps:{type:'array',items:{type:'string'}}
      },required:['score','verdict','strengths','improve','next_steps']
    }}}
  };
}

function parseGrade(data) {
  if (!data || !Array.isArray(data.output)) throw new Error('Сервис оценки не вернул ответ.');
  const raw = data.output.flatMap(x=>Array.isArray(x.content)?x.content:[])
    .filter(x=>x.type==='output_text'&&typeof x.text==='string').map(x=>x.text).join('');
  if (!raw) throw new Error('В ответе API отсутствует оценка.');
  let value;
  try { value=JSON.parse(raw); } catch { throw new Error('Не удалось прочитать оценку API.'); }
  if (!Number.isInteger(value.score)||value.score<1||value.score>10 ||
      typeof value.verdict!=='string' ||
      !Array.isArray(value.strengths)||!Array.isArray(value.improve)||!Array.isArray(value.next_steps))
    throw new Error('Некорректная структура итоговой оценки.');
  return value;
}
module.exports = {questionCount,makeSession,makeGradeRequest,parseGrade};
