const path = require('node:path');
require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  apiKey: required('API_KEY'),
  databasePath: path.resolve(process.env.DATABASE_PATH || './data/jobs.sqlite'),
  workDir: path.resolve(process.env.WORK_DIR || './data/work'),
  serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  outputFolderId: process.env.GOOGLE_DRIVE_OUTPUT_FOLDER_ID || '',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1500),
  maxParallelJobs: Math.max(1, Number(process.env.MAX_PARALLEL_JOBS || 1)),
};
