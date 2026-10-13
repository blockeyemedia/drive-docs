const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const archiver = require('archiver');
const config = require('./config');
const db = require('./db');
const { generateDriveFiles } = require('./drive');

fs.mkdirSync(config.workDir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function claimOne() {
  const claim = db.transaction(() => {
    const row = db.prepare("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1").get();
    if (!row) return null;
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE jobs SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(now, now, row.id);
    return result.changes === 1 ? { ...row, status: 'processing', started_at: now } : null;
  });
  return claim();
}

function update(jobId, fields) {
  const allowed = ['status', 'progress_json', 'generated_files_json', 'error_json', 'zip_path', 'updated_at', 'completed_at'];
  const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
  if (!entries.length) return;
  const sql = entries.map(([key]) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE jobs SET ${sql} WHERE id = ?`).run(...entries.map(([, value]) => value), jobId);
}

async function createZip(jobId, generated, clients) {
  const jobDir = path.join(config.workDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const zipPath = path.join(jobDir, 'documents.zip');
  const output = fs.createWriteStream(zipPath);
  const outputClosed = once(output, 'close');
  const archive = archiver('zip', { zlib: { level: 6 } });
  const archiveError = new Promise((_, reject) => archive.once('error', reject));
  archive.pipe(output);
  for (const file of generated.files) {
    let response;
    let ext = '';
    if (file.mimeType === 'application/vnd.google-apps.document') { response = await clients.drive.files.export({ fileId: file.id, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { responseType: 'stream' }); ext = '.docx'; }
    else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') { response = await clients.drive.files.export({ fileId: file.id, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, { responseType: 'stream' }); ext = '.xlsx'; }
    else if (file.mimeType === 'application/vnd.google-apps.presentation') { response = await clients.drive.files.export({ fileId: file.id, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }, { responseType: 'stream' }); ext = '.pptx'; }
    else { response = await clients.drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }); }
    const safeName = path.basename(file.name).replace(/[\\/:*?"<>|]/g, '_');
    const relative = (file.path || '').split('/').map(part => part.replace(/[\\/:*?"<>|]/g, '_')).filter(Boolean).join('/');
    archive.append(response.data, { name: `${relative ? `${relative}/` : ''}${safeName}${ext}` });
  }
  await Promise.race([archive.finalize(), archiveError]);
  await outputClosed;
  return zipPath;
}

async function runOne(row) {
  const payload = JSON.parse(row.payload_json);
  const now = new Date().toISOString();
  update(row.id, { progress_json: JSON.stringify({ total: payload.templateIds.length, completed: 0 }), updated_at: now });
  const heartbeat = setInterval(() => update(row.id, { updated_at: new Date().toISOString() }), 30_000);
  try {
    const generated = await generateDriveFiles(row.id, payload, progress => {
      update(row.id, { progress_json: JSON.stringify(progress), updated_at: new Date().toISOString() });
    });
    if (!generated.files.length) throw new Error('No files were found in the selected template folders');
    const zipPath = await createZip(row.id, generated, generated.clients);
    update(row.id, {
      status: 'completed',
      progress_json: JSON.stringify({ total: payload.templateIds.length, completed: payload.templateIds.length, folderId: generated.folder.id }),
      generated_files_json: JSON.stringify(generated.files),
      zip_path: zipPath,
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
  } catch (err) {
    update(row.id, {
      status: 'failed',
      error_json: JSON.stringify({ code: 'generation_failed', message: err.message }),
      updated_at: new Date().toISOString(),
    });
    process.stderr.write(`${JSON.stringify({ level: 'error', jobId: row.id, message: err.message, stack: err.stack })}\n`);
  } finally {
    clearInterval(heartbeat);
  }
}

function recoverStaleJobs() {
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'processing' AND updated_at < ?").run(now, staleBefore);
}

async function start() {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!stopping) {
    recoverStaleJobs();
    const active = [];
    for (let i = 0; i < config.maxParallelJobs; i++) {
      const row = claimOne();
      if (!row) break;
      active.push(runOne(row));
    }
    if (active.length) await Promise.all(active);
    else await sleep(config.pollIntervalMs);
  }
}

module.exports = { start };
