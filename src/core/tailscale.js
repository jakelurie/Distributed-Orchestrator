import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { loginPath } from './tools.js';

/** Explicit configuration wins; otherwise retain the legacy daemon when available. */
export async function tailscaleCommand(env = process.env, platform = process.platform, execute = promisify(execFile)) {
  const socket = env.ORCHESTRATOR_TAILSCALE_SOCKET;
  if (socket !== undefined) return ['tailscale', ...(socket ? ['--socket', socket] : [])];
  if (platform !== 'darwin') return ['tailscale'];
  const legacy = ['tailscale', '--socket', path.join(os.homedir(), '.tailscale-harness', 'tailscaled.sock')];
  try {
    await execute(legacy[0], [...legacy.slice(1), 'status', '--json'], { timeout: 4000, env });
    return legacy;
  } catch {
    return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  }
}

export async function tailscale(args, timeout) {
  const env = { ...process.env, PATH: await loginPath() };
  const [command, ...prefix] = await tailscaleCommand(env);
  return promisify(execFile)(command, [...prefix, ...args], { timeout, env });
}
