import { spawn as spawnProcess, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const stopService = unit => exec('systemctl', ['--user', 'stop', unit], { timeout: 10000 });

export class CloudflareSession {
  constructor({ binary, proxyUrl, lifetimeMs = 3600000, now = Date.now, spawn = spawnProcess, stopUnit = stopService, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const url = new URL(proxyUrl);
    if (!isAbsolute(binary) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !Number.isInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 3600000) throw new Error('Cloudflare requires an absolute binary, a loopback proxy origin and lifetime <= 1 hour');
    Object.assign(this, { binary, proxyUrl: url.origin, lifetimeMs, now, spawn, stopUnit, setTimer, clearTimer });
  }
  current() {
    const s = this.session;
    if (!s?.ready) return null;
    if (this.now() >= s.expiresAt) { void this.close(); return null; }
    return { origin: s.origin, expiresAt: s.expiresAt };
  }
  ensure() {
    const live = this.current();
    if (live) return Promise.resolve(live);
    if (!this.pending) {
      const start = () => this.start();
      this.pending = (this.closing ? this.closing.then(start) : start()).finally(() => { this.pending = null; });
    }
    return this.pending;
  }
  start() {
    return new Promise((resolve, reject) => {
      const s = { unit: `openclaw-artifacts-session-${randomBytes(8).toString('hex')}`, expiresAt: this.now() + this.lifetimeMs, reject };
      this.session = s;
      // The systemd watchdog survives a hung/crashed Gateway. Do not restart the unit.
      const args = ['--user', '--quiet', '--pipe', '--wait', '--collect', `--unit=${s.unit}`, `--property=RuntimeMaxSec=${this.lifetimeMs / 1000}s`, '--property=TimeoutStopSec=5s', '--property=KillMode=control-group', '--property=Restart=no', this.binary, 'tunnel', '--config', '/dev/null', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url', this.proxyUrl];
      const fail = () => {
        if (this.session !== s) return;
        reject(new Error('Cloudflare tunnel stopped or failed to start'));
        void this.close();
      };
      try {
        const child = this.spawn('systemd-run', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        s.child = child;
        child.once('error', fail);
        child.once('exit', fail);
        s.startTimer = setTimeout(fail, 45000);
        s.startTimer.unref();
        s.timer = this.setTimer(() => this.close(), this.lifetimeMs);
        s.timer.unref?.();
        let output = '';
        const read = chunk => {
          if (this.session !== s || s.ready) return;
          output = (output + chunk.toString()).slice(-8192);
          const match = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com(?=[\s/|]|$)/.exec(output);
          if (match) s.origin = match[0];
          if (output.includes('Registered tunnel connection')) s.connected = true;
          if (!s.origin || !s.connected) return;
          s.ready = true;
          clearTimeout(s.startTimer);
          const live = this.current();
          if (!live) { fail(); return; }
          resolve(live);
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
      } catch { fail(); }
    });
  }
  close() {
    const s = this.session;
    if (!s) return this.closing ?? Promise.resolve();
    this.session = null;
    clearTimeout(s.startTimer);
    this.clearTimer(s.timer);
    if (!s.ready) s.reject(new Error('Cloudflare tunnel closed during startup'));
    // Do not throw from an unattended deadline callback. OS watchdog is independent.
    const closing = this.stopUnit(s.unit).catch(() => {}).finally(() => {
      if (this.closing === closing) this.closing = null;
    });
    this.closing = closing;
    return closing;
  }
}
