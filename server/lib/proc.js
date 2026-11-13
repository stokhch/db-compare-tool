'use strict';
// Запуск внешних утилит (pg_dump, pg_restore, ora2pg) с выводом в журнал задачи.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getSettings } = require('./store');

const IS_WIN = process.platform === 'win32';

function quoteWin(a) {
  a = String(a);
  return /[\s"&|<>^]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}

/**
 * @returns {Promise<{code:number, stdout:string}>}
 */
function run(cmd, args, { env = {}, cwd, ctx, captureStdout = false, logStdout = true, stdoutFile } = {}) {
  return new Promise((resolve, reject) => {
    const useShell = IS_WIN && /\.(bat|cmd)$/i.test(cmd);
    const spawnCmd = useShell ? [quoteWin(cmd), ...args.map(quoteWin)].join(' ') : cmd;
    const proc = spawn(spawnCmd, useShell ? [] : args, {
      cwd, env: { ...process.env, ...env }, shell: useShell, windowsHide: true,
    });
    if (ctx) { ctx.addChild(proc); ctx.log(`$ ${[cmd, ...args].map(maskArg).join(' ')}`); }
    let out = '';
    const outStream = stdoutFile ? fs.createWriteStream(stdoutFile) : null;
    const lines = (level) => {
      let buf = '';
      return chunk => {
        buf += chunk.toString('utf8');
        const parts = buf.split(/\r?\n/);
        buf = parts.pop();
        for (const l of parts) if (l.trim() && ctx) ctx.log(l, level);
      };
    };
    const errLines = lines('info');
    const outLines = lines('info');
    proc.stdout.on('data', d => {
      if (captureStdout) out += d.toString('utf8');
      if (outStream) outStream.write(d);
      if (logStdout) outLines(d);
    });
    proc.stderr.on('data', d => errLines(d));
    proc.on('error', e => {
      reject(new Error(e.code === 'ENOENT' ? `Не найдена программа «${cmd}». Укажите путь в Настройках.` : e.message));
    });
    proc.on('close', code => {
      if (outStream) outStream.end();
      resolve({ code, stdout: out });
    });
  });
}

function maskArg(a) { return /password|pwd/i.test(String(a)) ? '***' : a; }

// ---------- Поиск утилит PostgreSQL ----------
function findPgBin() {
  const s = getSettings();
  if (s.pgBinPath) return s.pgBinPath;
  if (IS_WIN) {
    for (const base of ['C:\\Program Files\\PostgreSQL', 'C:\\Program Files (x86)\\PostgreSQL']) {
      try {
        const vers = fs.readdirSync(base).filter(v => fs.existsSync(path.join(base, v, 'bin', 'pg_dump.exe')))
          .sort((a, b) => parseFloat(b) - parseFloat(a));
        if (vers.length) return path.join(base, vers[0], 'bin');
      } catch { /* нет папки */ }
    }
  }
  return ''; // ищем в PATH
}
function pgTool(name) {
  const bin = findPgBin();
  const exe = IS_WIN ? name + '.exe' : name;
  return bin ? path.join(bin, exe) : exe;
}

function ora2pgCmd() {
  const s = getSettings();
  const cmd = s.ora2pgCommand || 'ora2pg';
  if (s.perlPath) return { cmd: s.perlPath, pre: [cmd] };
  return { cmd, pre: [] };
}

async function toolVersion(cmd, args) {
  try {
    const r = await run(cmd, args, { captureStdout: true, logStdout: false });
    return { ok: r.code === 0, version: r.stdout.trim().split(/\r?\n/)[0] || `код ${r.code}` };
  } catch (e) { return { ok: false, version: e.message }; }
}

module.exports = { run, pgTool, findPgBin, ora2pgCmd, toolVersion, IS_WIN };
