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

// Комплект plsql2pg для Windows: perl/ + ora2pg/ рядом с plsql2pg.exe (как в plsql2pg/ora2pg.py)
function plsql2pgBundle() {
  const s = getSettings();
  const roots = [s.plsql2pgHome, process.env.PLSQL2PG_HOME, IS_WIN ? 'C:\\plsql2pg' : ''].filter(Boolean);
  for (const root of roots) {
    const script = path.join(root, 'ora2pg', 'scripts', 'ora2pg');
    if (!fs.existsSync(script)) continue;
    const perlDir = path.join(root, 'perl');
    const perl = path.join(perlDir, 'perl', 'bin', IS_WIN ? 'perl.exe' : 'perl');
    const extra = [path.join(perlDir, 'perl', 'bin'), path.join(perlDir, 'perl', 'site', 'bin'), path.join(perlDir, 'c', 'bin')];
    return {
      root,
      cmd: fs.existsSync(perl) ? perl : 'perl',
      pre: ['-I', path.join(root, 'ora2pg', 'lib'), script],
      env: { PATH: extra.join(path.delimiter) + path.delimiter + (process.env.PATH || process.env.Path || ''), PERL5LIB: '' },
    };
  }
  return null;
}

/** Как запускать ora2pg: { cmd, pre, env, source } */
function ora2pgCmd() {
  const s = getSettings();
  if (s.ora2pgSource !== 'custom') {
    const b = plsql2pgBundle();
    if (b) return { cmd: b.cmd, pre: b.pre, env: b.env, source: `комплект plsql2pg (${b.root})` };
  }
  const cmd = s.ora2pgCommand || 'ora2pg';
  if (s.perlPath) return { cmd: s.perlPath, pre: [cmd], env: {}, source: 'свой ora2pg' };
  return { cmd, pre: [], env: {}, source: 'свой ora2pg' };
}

/** Есть ли у Perl драйвер DBD::Oracle (без него ora2pg не подключится к Oracle) */
async function perlModule(o, mod) {
  const perl = o.pre.length && o.pre[0] === '-I' ? o.cmd : (getSettings().perlPath || 'perl');
  try {
    const r = await run(perl, ['-M' + mod, '-e', `print $${mod}::VERSION`], { captureStdout: true, logStdout: false, env: o.env });
    return { ok: r.code === 0, version: r.code === 0 ? `${mod} ${r.stdout.trim()}` : `${mod} не установлен` };
  } catch (e) { return { ok: false, version: e.message }; }
}

async function toolVersion(cmd, args, env) {
  try {
    const r = await run(cmd, args, { captureStdout: true, logStdout: false, env });
    return { ok: r.code === 0, version: r.stdout.trim().split(/\r?\n/)[0] || `код ${r.code}` };
  } catch (e) { return { ok: false, version: e.message }; }
}

module.exports = { run, pgTool, findPgBin, ora2pgCmd, plsql2pgBundle, perlModule, toolVersion, IS_WIN };
