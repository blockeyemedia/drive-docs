const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { z } = require('zod');
const config = require('./config');
const db = require('./db');

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '2mb' }));
app.use(pinoHttp({ logger: log, redact: ['req.headers.authorization'] }));

const jobRequest = z.object({
  templateIds: z.array(z.string().min(1)).min(1).max(200),
  customFields: z.record(z.unknown()).default({}),
  images: z.record(z.string()).optional().default({}),
  brand: z.record(z.unknown()).optional().default({}),
  zipMapping: z.record(z.unknown()).optional().default({}),
}).strict();

function authenticate(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(token);
  const right = Buffer.from(config.apiKey);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return res.status(401).json({ success: false, error: 'unauthorized' });
  }
  next();
}

function rowToApi(row) {
  return {
    id: row.id,
    status: row.status,
    progress: JSON.parse(row.progress_json || '{}'),
    generatedFiles: JSON.parse(row.generated_files_json || '[]'),
    ...(row.error_json ? { error: JSON.parse(row.error_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/v1/jobs/test-connection-check', authenticate, (_req, res) => res.status(404).json({ error: 'job_not_found' }));

app.post('/v1/jobs', authenticate, (req, res) => {
  const parsed = jobRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'invalid_request', details: parsed.error.flatten() });
  const key = req.get('idempotency-key') || (req.body.order_id ? `wc-order-${req.body.order_id}` : '');
  if (!key || key.length > 200) return res.status(400).json({ success: false, error: 'idempotency_key_required' });
  const body = parsed.data;
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const existing = db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(key);
  if (existing) {
    if (existing.request_hash !== requestHash) return res.status(409).json({ success: false, error: 'idempotency_key_payload_mismatch' });
    return res.status(200).json({ success: true, data: rowToApi(existing) });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    db.prepare(`INSERT INTO jobs
      (id, idempotency_key, request_hash, payload_json, status, progress_json, generated_files_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, '[]', ?, ?)`)
      .run(id, key, requestHash, JSON.stringify(body), JSON.stringify({ total: body.templateIds.length, completed: 0 }), now, now);
  } catch (err) {
    if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
    const raced = db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(key);
    if (raced && raced.request_hash === requestHash) return res.status(200).json({ success: true, data: rowToApi(raced) });
    return res.status(409).json({ success: false, error: 'idempotency_conflict' });
  }
  req.log.info({ jobId: id, templateCount: body.templateIds.length, idempotencyKey: key }, 'job accepted');
  return res.status(202).json({ success: true, data: rowToApi(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)) });
});

app.get('/v1/jobs/:id', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'job_not_found' });
  return res.json({ success: true, data: rowToApi(row) });
});

app.get('/v1/jobs/:id/download', authenticate, (req, res) => {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'job_not_found' });
  if (row.status !== 'completed' || !row.zip_path || !fs.existsSync(row.zip_path)) return res.status(409).json({ success: false, error: 'download_not_ready' });
  res.download(row.zip_path, `drive-doc-job-${row.id}.zip`);
});

app.use((err, req, res, _next) => {
  req.log.error({ err }, 'request failed');
  res.status(500).json({ success: false, error: 'internal_error', requestId: req.id });
});

app.listen(config.port, '0.0.0.0', () => log.info({ port: config.port }, 'Drive Doc API listening'));
require('./worker').start().catch(err => { log.fatal({ err }, 'background worker stopped'); process.exit(1); });
