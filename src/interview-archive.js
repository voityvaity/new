'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

function cleanTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.slice(0, 2000).filter(t => t && ['candidate', 'interviewer'].includes(t.role) && typeof t.text === 'string')
    .map(t => ({
      role: t.role,
      text: t.text.slice(0, 2500),
      start: Number.isFinite(t.start) ? t.start : null,
      end: Number.isFinite(t.end) ? t.end : null
    })).filter(t => t.text.trim());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function reportHtml(report) {
  const date = new Date(report.startedAt).toLocaleString('ru-RU');
  const duration = Math.max(0, Math.round((Date.parse(report.endedAt) - Date.parse(report.startedAt)) / 60000));
  const score = report.evaluation.score;
  const items = (values) => values.map(v => '<li>' + escapeHtml(v) + '</li>').join('');
  const dialogue = report.transcript.map(t => (
    '<div class="turn"><div class="speaker">' +
    (t.role === 'candidate' ? 'Кандидат' : 'Александр · интервьюер') +
    '</div><p>' + escapeHtml(t.text).replace(/\n/g, '<br>') + '</p></div>'
  )).join('');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Итоги собеседования</title>' +
    '<style>@page{size:A4;margin:17mm 16mm}*{box-sizing:border-box}body{font-family:"Segoe UI",Arial,sans-serif;color:#17243a;font-size:11pt;line-height:1.45}' +
    'h1{font-size:24pt;margin:0 0 8px;color:#163a61}h2{font-size:14pt;margin:24px 0 8px;color:#163a61}p{margin:6px 0 12px;white-space:normal;overflow-wrap:anywhere}' +
    '.meta{color:#4b5e73;font-size:10pt}.score{background:#eaf3fa;padding:14px;border-radius:8px;margin-top:18px}.score strong{font-size:22pt}' +
    '.turn{break-inside:avoid;border-left:3px solid #c4dbe7;padding:4px 0 5px 12px;margin:14px 0}.speaker{font-weight:700;color:#276b83;font-size:9pt}' +
    'ul{padding-left:20px}li{margin-bottom:5px;overflow-wrap:anywhere}.footer{margin-top:24px;font-size:9pt;color:#607185}</style></head><body>' +
    '<h1>Тренировочное собеседование</h1><div class="meta">Python Junior Mock · ' + escapeHtml(date) +
    ' · ' + duration + ' мин · ' + report.questionsRequested + ' плановых вопросов</div>' +
    '<section class="score"><strong>' + score + ' / 10</strong><p>' + escapeHtml(report.evaluation.verdict) + '</p></section>' +
    '<h2>Сильные стороны</h2><ul>' + items(report.evaluation.strengths) + '</ul>' +
    '<h2>Что улучшить</h2><ul>' + items(report.evaluation.improve) + '</ul>' +
    '<h2>Следующие шаги</h2><ul>' + items(report.evaluation.next_steps) + '</ul>' +
    '<h2>Расшифровка интервью</h2>' + dialogue +
    '<div class="footer">Автоматический отчёт. Интервью тренировочное, неофициальное. Аудио не сохраняется.</div>' +
    '</body></html>';
}

function filenameFor(report) {
  const d = new Date(report.startedAt);
  const part = n => String(n).padStart(2, '0');
  const local = [d.getFullYear(), part(d.getMonth() + 1), part(d.getDate())].join('-') +
    '_' + [part(d.getHours()), part(d.getMinutes()), part(d.getSeconds())].join('-');
  return local + '_Оценка-' + report.evaluation.score + '_' + report.id;
}

async function atomicWrite(filename, data) {
  await fs.mkdir(path.dirname(filename), {recursive: true});
  const tmp = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, data, {mode: 0o600, flag: 'wx'});
    await fs.rename(tmp, filename);
  } finally {
    await fs.rm(tmp, {force: true});
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
  function draftPath(interview) {
    return path.join(draftDirectory, interview.id + '.json');
  }
  function draftData(interview) {
    return {schemaVersion: 1, status: 'in_progress', id: interview.id,
      startedAt: interview.startedAt, questionsRequested: interview.questionsRequested,
      updatedAt: new Date().toISOString(), transcript: interview.transcript};
  }
  function start(questionsRequested) {
    return enqueue(async () => {
      active = {
        id: randomUUID(), startedAt: new Date().toISOString(),
        questionsRequested, transcript: []
      };
      await atomicWrite(draftPath(active), JSON.stringify(draftData(active), null, 2));
      return {id: active.id};
    });
  }
  function snapshot(turns) {
    return enqueue(async () => {
      if (!active) return null;
      active.transcript = cleanTurns(turns);
      await atomicWrite(draftPath(active), JSON.stringify(draftData(active), null, 2));
      return {draftFile: draftPath(active)};
    });
  }
  function finalize({turns, evaluation, reportDirectory, saveJson = true}) {
    return enqueue(async () => {
      if (!active) throw new Error('Не найдено активное интервью для сохранения.');
      if (typeof reportDirectory !== 'string' || !path.isAbsolute(reportDirectory))
        throw new Error('Не выбрана корректная папка для отчётов.');
      active.transcript = cleanTurns(turns);
      await atomicWrite(draftPath(active), JSON.stringify(draftData(active), null, 2));
      const report = {
        schemaVersion: 1, id: active.id, startedAt: active.startedAt,
        endedAt: new Date().toISOString(), questionsRequested: active.questionsRequested,
        transcript: active.transcript, evaluation
      };
      const base = filenameFor(report);
      const pdfFile = path.join(reportDirectory, base + '.pdf');
      const jsonFile = saveJson ? path.join(reportDirectory, base + '.json') : null;
      if (jsonFile) await atomicWrite(jsonFile, JSON.stringify(report, null, 2));
      const pdf = await generatePdf(reportHtml(report));
      if (!Buffer.isBuffer(pdf) || pdf.length === 0) throw new Error('Не удалось сформировать PDF.');
      await atomicWrite(pdfFile, pdf);
      await fs.rm(draftPath(active), {force: true});
      active = null;
      return {pdfFile, jsonFile, directory: reportDirectory};
    });
  }
  return {start, snapshot, finalize};
}

module.exports = {createInterviewArchive, cleanTurns, escapeHtml, reportHtml, filenameFor, atomicWrite};
