'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {normalizeInterviewContext} = require('./interview-context');

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TURNS = 2000;
const MAX_TRANSCRIPT_CHARS = 500000;
function cleanTurns(turns) {
  if (!Array.isArray(turns)) return [];
  if (turns.length > MAX_TURNS)
    throw new Error('Слишком много фрагментов расшифровки: требуется объединение, а не обрезание.');
  let totalChars=0;
  const cleaned=turns
    .filter(t => t && ['candidate', 'interviewer'].includes(t.role) && typeof t.text === 'string')
    .map(t => {
      totalChars+=t.text.length;
      return {
        role:t.role, text:t.text,
        start:Number.isFinite(t.start)?t.start:null,
        end:Number.isFinite(t.end)?t.end:null
      };
    }).filter(t => t.text.trim());
  if (totalChars > MAX_TRANSCRIPT_CHARS)
    throw new Error('Расшифровка слишком велика для одного файла, данные не были обрезаны.');
  return cleaned;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function durationLabel(record) {
  const end = record.endedAt || record.updatedAt || record.startedAt;
  const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(record.startedAt)) / 1000));
  const value = seconds >= 60 ? Math.floor(seconds / 60) + ' мин ' + seconds % 60 + ' сек' : seconds + ' сек';
  return record.endedAt ? value : 'около ' + value + ' (до последнего сохранения)';
}

function reportHtml(record) {
  const evaluated = record.evaluation && Number.isInteger(record.evaluation.score);
  const escapeItems = values => (Array.isArray(values) ? values : [])
    .map(v => '<li>' + escapeHtml(v) + '</li>').join('');
  const dialogue = (record.transcript || []).map(t =>
    '<div class="turn"><div class="speaker">' +
    (t.role === 'candidate' ? 'Кандидат' : 'Александр · интервьюер') +
    '</div><p>' + escapeHtml(t.text).replace(/\n/g, '<br>') + '</p></div>'
  ).join('');
  const gradeSection = evaluated
    ? '<section class="score"><strong>' + record.evaluation.score + ' / 10</strong><p>' +
        escapeHtml(record.evaluation.verdict) + '</p></section>' +
        '<h2>Сильные стороны</h2><ul>' + escapeItems(record.evaluation.strengths) + '</ul>' +
        '<h2>Что улучшить</h2><ul>' + escapeItems(record.evaluation.improve) + '</ul>' +
        '<h2>Следующие шаги</h2><ul>' + escapeItems(record.evaluation.next_steps) + '</ul>'
    : '<section class="score"><strong>Без оценки</strong><p>Интервью прервано или оценка не была получена. ' +
      'Сохранена доступная расшифровка.</p></section>';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Итоги собеседования</title>' +
    '<style>@page{size:A4;margin:17mm 16mm}*{box-sizing:border-box}body{font-family:"Segoe UI",Arial,sans-serif;color:#17243a;font-size:11pt;line-height:1.45}' +
    'h1{font-size:24pt;margin:0 0 8px;color:#163a61}h2{font-size:14pt;margin:24px 0 8px;color:#163a61}' +
    'p{margin:6px 0 12px;overflow-wrap:anywhere}.meta{color:#4b5e73;font-size:10pt}' +
    '.score{background:#eaf3fa;padding:14px;border-radius:8px;margin-top:18px}.score strong{font-size:22pt}' +
    '.turn{break-inside:avoid;border-left:3px solid #c4dbe7;padding:4px 0 5px 12px;margin:14px 0}' +
    '.speaker{font-weight:700;color:#276b83;font-size:9pt}ul{padding-left:20px}li{margin-bottom:5px;overflow-wrap:anywhere}' +
    '.footer{margin-top:24px;font-size:9pt;color:#607185}</style></head><body>' +
    '<h1>Тренировочное собеседование</h1><div class="meta">Python Junior Mock · ' +
    escapeHtml(new Date(record.startedAt).toLocaleString('ru-RU')) +
    ' · Длительность разговора: ' + escapeHtml(durationLabel(record)) +
    ' · ' + record.questionsRequested + ' плановых вопросов</div>' +
    gradeSection + '<h2>Расшифровка интервью</h2>' +
    (dialogue || '<p>Распознанных реплик нет.</p>') +
    '<div class="footer">Неофициальная тренировка. Аудио не сохраняется.</div></body></html>';
}

function filenameFor(record) {
  const date = new Date(record.startedAt);
  const part = value => String(value).padStart(2, '0');
  const stamp = [date.getFullYear(), part(date.getMonth() + 1), part(date.getDate())].join('-') +
    '_' + [part(date.getHours()), part(date.getMinutes()), part(date.getSeconds())].join('-');
  const grade = record.evaluation ? 'Оценка-' + record.evaluation.score : 'Без-оценки';
  return stamp + '_' + grade + '_' + record.id;
}

async function atomicWrite(filename, content) {
  await fs.mkdir(path.dirname(filename), {recursive:true});
  const temp = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, content, {mode:0o600, flag:'wx'});
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, {force:true});
  }
}

function createInterviewArchive({draftDirectory, generatePdf}) {
  let active = null;
  let pending = Promise.resolve();
  function enqueue(task) {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  }
  function recordPath(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('Некорректный идентификатор интервью.');
    return path.join(draftDirectory, id + '.json');
  }
  async function read(id) {
    const data = JSON.parse(await fs.readFile(recordPath(id), 'utf8'));
    if (data.id !== id || !Array.isArray(data.transcript)) throw new Error('Повреждённая запись интервью.');
    return data;
  }
  async function write(record) {
    record.updatedAt = new Date().toISOString();
    await atomicWrite(recordPath(record.id), JSON.stringify(record, null, 2));
  }
  function start(questionsRequested,context={}) {
    const reference=normalizeInterviewContext(context);
    return enqueue(async () => {
      const next = {
        schemaVersion:3, status:'in_progress', id:randomUUID(),
        startedAt:new Date().toISOString(), questionsRequested,
        interviewContext:reference, transcript:[]
      };
      await write(next);
      active = next;
      return {id:next.id};
    });
  }
  function discardEmpty(id) {
    return enqueue(async()=>{
      const record=await read(id);
      if(record.transcript.length||record.endedAt||record.evaluation)
        throw new Error('Нельзя удалить интервью с данными.');
      await fs.rm(recordPath(id));
      if(active?.id===id)active=null;
      return {removed:true};
    });
  }
  function snapshot(id, turns) {
    return enqueue(async () => {
      if (!active || active.id !== id || active.endedAt) return null;
      active.transcript = cleanTurns(turns);
      await write(active);
      return {saved:true};
    });
  }
  function end(id, turns, endedAt = new Date().toISOString()) {
    return enqueue(async () => {
      const record = await read(id);
      if (!record.endedAt) {
        const parsed = Date.parse(endedAt);
        if (!Number.isFinite(parsed) || parsed < Date.parse(record.startedAt))
          throw new Error('Некорректное время окончания интервью.');
        record.endedAt = new Date(parsed).toISOString();
      }
      record.transcript = cleanTurns(turns);
      if (!record.evaluation) record.status = 'unfinished';
      await write(record);
      if (active?.id === id) active = null;
      return {saved:true};
    });
  }
  function getContext(id) {
    return enqueue(async()=>{
      const record=await read(id);
      return normalizeInterviewContext(record.interviewContext||{});
    });
  }
  function getEvaluation(id) {
    return enqueue(async () => {
      const record=await read(id);
      return record.evaluation || null;
    });
  }
  function storeEvaluation(id, evaluation) {
    return enqueue(async () => {
      const record = await read(id);
      if (!record.endedAt) record.endedAt = new Date().toISOString();
      record.evaluation = evaluation;
      record.status = 'evaluated';
      await write(record);
      return {saved:true};
    });
  }
  function list() {
    return enqueue(async () => {
      await fs.mkdir(draftDirectory, {recursive:true});
      const names = (await fs.readdir(draftDirectory)).filter(name => ID_PATTERN.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
      const all = await Promise.all(names.map(async name => {
        try {
          const item = await read(name.slice(0, -5));
          return {
            id:item.id, startedAt:item.startedAt, endedAt:item.endedAt || null,
            duration:durationLabel(item), questionsRequested:item.questionsRequested,
            turns:item.transcript.length, hasEvaluation:Boolean(item.evaluation),
            score:item.evaluation?.score ?? null, status:item.status,
            lastExport:item.lastExport || null
          };
        } catch { return null; }
      }));
      return all.filter(Boolean).sort((a,b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 150);
    });
  }
  function exportReport(id, reportDirectory, saveJson = true) {
    return enqueue(async () => {
      if (typeof reportDirectory !== 'string' || !path.isAbsolute(reportDirectory))
        throw new Error('Не выбрана корректная папка для отчётов.');
      const record = await read(id);
      const base = filenameFor(record);
      const pdfFile = path.join(reportDirectory, base + '.pdf');
      const jsonFile = saveJson ? path.join(reportDirectory, base + '.json') : null;
      // The recovery record already holds the evaluation before either export starts.
      if (jsonFile) await atomicWrite(jsonFile, JSON.stringify(record, null, 2));
      const pdf = await generatePdf(reportHtml(record));
      if (!Buffer.isBuffer(pdf) || pdf.length < 1024 || pdf.subarray(0,5).toString() !== '%PDF-')
        throw new Error('Не удалось сформировать корректный PDF.');
      await atomicWrite(pdfFile, pdf);
      record.status = 'exported';
      record.lastExport = {pdfFile, jsonFile, at:new Date().toISOString()};
      await write(record);
      return {pdfFile, jsonFile, directory:reportDirectory};
    });
  }
  return {start, discardEmpty, snapshot, end, getContext, getEvaluation, storeEvaluation, list, exportReport};
}

module.exports = {createInterviewArchive, cleanTurns, escapeHtml, durationLabel, reportHtml, filenameFor, atomicWrite};
