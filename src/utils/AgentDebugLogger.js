/**
 * AgentDebugLogger — lightweight file logger to trace agent tool calls
 * Writes newline-delimited JSON entries to the project root `agent_debug.log`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LOG_PATH = path.join(PROJECT_ROOT, 'agent_debug.log');

async function log(entry) {
    try {
        const payload = Object.assign({}, entry, {
            timestamp: new Date().toISOString(),
            pid: process.pid,
            pid_title: process.title
        });
        const line = JSON.stringify(payload) + '\n';
        await fs.promises.appendFile(LOG_PATH, line, { encoding: 'utf8' });
    } catch (err) {
        try {
            // Best-effort fallback: synchronous append
            fs.appendFileSync(LOG_PATH, JSON.stringify({ fallback_error: err.message, timestamp: new Date().toISOString() }) + '\n');
        } catch (_) { /* swallow */ }
    }
}

module.exports = { log };
