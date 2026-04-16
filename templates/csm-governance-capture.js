#!/usr/bin/env node
/**
 * CSM Governance Event Capture
 *
 * PreToolUse/PostToolUse hookとして動作し、ガバナンスイベントを
 * ~/.claude/governance-events.jsonl に記録する。
 *
 * ECCのgovernance-capture.jsと同じ検知パターンを持つが、
 * 出力先がJSONLファイル（CSMから参照可能）。
 *
 * 設計原則: VSIXインストール時に自動デプロイ、csm/プレフィックスで名前空間分離
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 検知パターン（ECCのgovernance-capture.jsと同一）
const SECRET_PATTERNS = [
  { name: 'aws_key', pattern: /(?:AKIA|ASIA)[A-Z0-9]{16}/i },
  { name: 'generic_secret', pattern: /(?:secret|password|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}/i },
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
];

const APPROVAL_COMMANDS = [
  /git\s+push\s+.*--force/,
  /git\s+reset\s+--hard/,
  /rm\s+-rf?\s/,
  /DROP\s+(?:TABLE|DATABASE)/i,
  /DELETE\s+FROM\s+\w+\s*(?:;|$)/i,
];

const SENSITIVE_PATHS = [
  /\.env(?:\.|$)/,
  /credentials/i,
  /secrets?\./i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
];

const EVENTS_FILE = path.join(os.homedir(), '.claude', 'governance-events.jsonl');
const MAX_STDIN = 1024 * 1024;

function generateEventId() {
  return `gov-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function detectSecrets(text) {
  if (!text || typeof text !== 'string') return [];
  const findings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ name });
    }
  }
  return findings;
}

function detectApprovalRequired(command) {
  if (!command || typeof command !== 'string') return [];
  const findings = [];
  for (const pattern of APPROVAL_COMMANDS) {
    if (pattern.test(command)) {
      findings.push({ pattern: pattern.source });
    }
  }
  return findings;
}

function detectSensitivePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return SENSITIVE_PATHS.some(pattern => pattern.test(filePath));
}

function appendEvent(event) {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf-8');
  } catch {
    // ファイル書き込みエラーは無視
  }
}

function main() {
  let rawInput = '';
  try {
    rawInput = fs.readFileSync(0, 'utf-8').slice(0, MAX_STDIN);
  } catch {
    process.stdout.write('{}');
    return;
  }

  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    process.stdout.write('{}');
    return;
  }

  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || process.env.ECC_SESSION_ID || null;
  const hookPhase = (input.hook_event_name || '').includes('Pre') ? 'pre' : 'post';
  const timestamp = new Date().toISOString();
  const cwd = input.cwd || process.cwd();

  // 1. 秘密鍵検知
  const inputText = typeof toolInput === 'object' ? JSON.stringify(toolInput) : String(toolInput);
  const secrets = detectSecrets(inputText);
  if (secrets.length > 0) {
    appendEvent({
      id: generateEventId(),
      sessionId,
      eventType: 'secret_detected',
      toolName,
      hookPhase,
      payload: { secretTypes: secrets.map(s => s.name), location: 'input' },
      cwd,
      timestamp,
    });
  }

  // 2. 危険コマンド検知
  if (toolName === 'Bash') {
    const command = toolInput.command || '';
    const approvals = detectApprovalRequired(command);
    if (approvals.length > 0) {
      appendEvent({
        id: generateEventId(),
        sessionId,
        eventType: 'approval_requested',
        toolName,
        hookPhase,
        payload: {
          commandName: command.trim().split(/\s+/)[0] || null,
          matchedPatterns: approvals.map(f => f.pattern),
        },
        cwd,
        timestamp,
      });
    }
  }

  // 3. 機密ファイル操作検知
  const filePath = toolInput.file_path || toolInput.path || '';
  if (filePath && detectSensitivePath(filePath)) {
    appendEvent({
      id: generateEventId(),
      sessionId,
      eventType: 'policy_violation',
      toolName,
      hookPhase,
      payload: { filePath: filePath.slice(0, 200), reason: 'sensitive_file_access' },
      cwd,
      timestamp,
    });
  }

  // 4. 権限昇格コマンド検知
  if (toolName === 'Bash' && hookPhase === 'post') {
    const command = toolInput.command || '';
    if (/sudo\s|chmod\s|chown\s/.test(command)) {
      appendEvent({
        id: generateEventId(),
        sessionId,
        eventType: 'security_finding',
        toolName,
        hookPhase,
        payload: {
          commandName: command.trim().split(/\s+/)[0] || null,
          reason: 'elevated_privilege_command',
        },
        cwd,
        timestamp,
      });
    }
  }

  // パススルー（hookとしてブロックしない）
  process.stdout.write('{}');
}

main();
