// Hermes Agent, the separate AI program older versions of Talaria needed. Talaria finds it (to bring
// sign-ins over once, and to offer existing users to remove it) and removes it on request: first
// with Hermes's own full uninstaller, which also clears its PATH entries and background services,
// then by deleting whatever that couldn't remove while it was running.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where Hermes keeps everything. HERMES_HOME, when set, is the only place looked at. */
function candidates(): string[] {
  if (process.env.HERMES_HOME) return [process.env.HERMES_HOME];
  const home = os.homedir();
  return [process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'hermes') : '', path.join(home, '.hermes'), path.join(home, '.local', 'share', 'hermes')].filter(Boolean);
}

/** A folder only counts as Hermes when it holds Hermes's own files, so nothing else is ever touched. */
function looksLikeHermes(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const has = (p: string) => fs.existsSync(path.join(dir, p));
  return has('hermes-agent') || (has('config.yaml') && (has('auth.json') || has('profiles') || has('bin') || has('sessions')));
}

export interface HermesInstall {
  home: string;
  exe?: string; // the hermes command, when Talaria can find it
}

export function findHermes(): HermesInstall | null {
  const home = candidates().find(looksLikeHermes);
  if (!home) return null;
  // Only a hermes command inside this very folder is ever run, so the uninstaller can't act on another install.
  const win = process.platform === 'win32';
  const local = win
    ? [path.join(home, 'bin', 'hermes.exe'), path.join(home, 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'), path.join(home, 'hermes-agent', '.venv', 'Scripts', 'hermes.exe')]
    : [path.join(home, 'bin', 'hermes'), path.join(home, 'hermes-agent', 'venv', 'bin', 'hermes'), path.join(home, 'hermes-agent', '.venv', 'bin', 'hermes')];
  return { home, exe: local.find(p => fs.existsSync(p)) };
}

/** Total size of a folder in bytes (links aren't followed). */
export async function folderSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async e => {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) return;
        if (e.isDirectory()) return walk(p);
        try {
          // Read the size first: `total += await …` would read total before waiting and lose parallel adds.
          const bytes = (await fs.promises.lstat(p)).size;
          total += bytes;
        } catch {}
      }),
    );
  };
  await walk(dir);
  return total;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    execFile(cmd, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(`${stdout || ''}${stderr || ''}${err ? `\n(${err.message.split('\n')[0]})` : ''}`);
    });
  });
}

export interface RemoveResult {
  ok: boolean;
  freedBytes: number;
  message: string;
  leftover?: string;
}

/**
 * `knownSize` is the folder's size when it was already counted (counting several GB of small files
 * takes a while, so it isn't done twice). `stage` reports progress in plain words.
 */
export async function removeHermes(
  log: (text: string) => void = () => {},
  opts: { knownSize?: Promise<number>; stage?: (text: string) => void } = {},
): Promise<RemoveResult> {
  const found = findHermes();
  if (!found) return { ok: true, freedBytes: 0, message: 'Hermes Agent is already gone.' };
  const { home, exe } = found;
  const stage = opts.stage || (() => {});
  stage('Getting ready');
  const before = await (opts.knownSize ?? folderSize(home));

  // 1. Hermes's own full uninstaller: removes its services, PATH entries and settings it made outside its folder.
  //    Most of the time goes here: it deletes Hermes's many thousands of small files one by one.
  if (exe) {
    stage('Hermes Agent’s own uninstaller is removing its files');
    log(`Running Hermes's uninstaller (${exe} uninstall --full --yes)`);
    const out = await run(exe, ['uninstall', '--full', '--yes'], { ...process.env, HERMES_HOME: home, NO_COLOR: '1', HERMES_ACCEPT_HOOKS: '1' }, 15 * 60_000);
    log(out.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-15).join('\n'));
  }

  // 2. Whatever is left (files it couldn't delete while it was running, other profiles), checked again first.
  if (fs.existsSync(home)) stage('Deleting the files that were left');
  if (fs.existsSync(home) && looksLikeHermes(home)) {
    log(`Deleting what's left in ${home}`);
    await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }).catch(err => log(`Couldn't delete everything: ${err.message}`));
  } else if (fs.existsSync(home)) {
    // Only leftovers that no longer look like Hermes (its own markers are gone): delete only if it's Hermes's usual folder name.
    if (/^\.?hermes$/i.test(path.basename(home))) await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }).catch(() => {});
  }

  if (fs.existsSync(home)) stage('Checking what’s left');
  const after = fs.existsSync(home) ? await folderSize(home) : 0;
  const freedBytes = Math.max(0, before - after);
  if (after > 0) {
    return { ok: false, freedBytes, leftover: home, message: `Most of Hermes Agent is removed, but some files are still in use. Restart your computer and delete the folder ${home} yourself.` };
  }
  return { ok: true, freedBytes, message: 'Hermes Agent is removed.' };
}
