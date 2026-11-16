import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { diskInfo } from './paths.js';

const exec = promisify(execFile);

type CpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };

export type Telemetry = {
  sampledAt: number;
  hostname: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  cpu: { model: string; percent: number; cores: number[] };
  memory: { usedBytes: number; totalBytes: number };
  processRssBytes: number;
  volumes: { mount: string; usedBytes: number; totalBytes: number; holdsStorage: boolean }[];
  gpus: { name: string; utilization: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; temperatureC: number | null }[];
  gpuNote: string | null;
};

let cached: { at: number; data: Telemetry } | null = null;
let inflight: Promise<Telemetry> | null = null;

export function readTelemetry(storageDir: string) {
  if (cached && Date.now() - cached.at < 2000) return Promise.resolve(cached.data);
  if (inflight) return inflight;
  inflight = collect(storageDir)
    .then((data) => {
      cached = { at: Date.now(), data };
      inflight = null;
      return data;
    })
    .catch((error: unknown) => {
      inflight = null;
      throw error;
    });
  return inflight;
}

async function collect(storageDir: string): Promise<Telemetry> {
  const before = cpuTimes();
  const gpuPromise = readGpus();
  await delay(250);
  const cpu = cpuPercent(before, cpuTimes());
  const gpus = await gpuPromise;
  const memoryTotal = os.totalmem();
  const memoryUsed = Math.max(0, memoryTotal - os.freemem());
  const first = os.cpus()[0];
  return {
    sampledAt: Date.now(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptimeSeconds: os.uptime(),
    cpu: { model: first?.model?.trim() || 'Processor', percent: cpu.percent, cores: cpu.cores },
    memory: { usedBytes: memoryUsed, totalBytes: memoryTotal },
    processRssBytes: process.memoryUsage().rss,
    volumes: volumes(storageDir),
    gpus: gpus.devices,
    gpuNote: gpus.note,
  };
}

function cpuTimes(): CpuTimes[] {
  return os.cpus().map((cpu) => cpu.times);
}

function cpuPercent(before: CpuTimes[], after: CpuTimes[]) {
  let idle = 0;
  let total = 0;
  const cores: number[] = [];
  for (let i = 0; i < after.length; i += 1) {
    const start = before[i] ?? after[i]!;
    const end = after[i]!;
    const idleDelta = end.idle - start.idle;
    const totalDelta = end.user - start.user + (end.nice - start.nice) + (end.sys - start.sys) + idleDelta + (end.irq - start.irq);
    idle += idleDelta;
    total += totalDelta;
    cores.push(totalDelta > 0 ? round1((1 - idleDelta / totalDelta) * 100) : 0);
  }
  return { percent: total > 0 ? round1((1 - idle / total) * 100) : 0, cores };
}

function volumes(storageDir: string) {
  const storageRoot = path.parse(path.resolve(storageDir)).root.toLowerCase();
  const mounts = process.platform === 'win32' ? windowsMounts() : unixMounts();
  const seen = new Set<string>();
  const rows: Telemetry['volumes'] = [];
  for (const mount of mounts) {
    const key = process.platform === 'win32' ? path.parse(path.resolve(mount)).root.toLowerCase() : mount;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const stats = fs.statfsSync(mount);
      const block = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * block;
      if (totalBytes <= 0) continue;
      const freeBytes = Number(stats.bavail) * block;
      rows.push({
        mount: process.platform === 'win32' ? path.parse(mount).root.replace(/\\$/, '') : mount,
        usedBytes: Math.max(0, totalBytes - freeBytes),
        totalBytes,
        holdsStorage: path.parse(path.resolve(mount)).root.toLowerCase() === storageRoot,
      });
    } catch {
      // Missing drive letters and unreadable mounts are skipped.
    }
  }
  if (rows.length === 0) {
    const info = diskInfo(storageDir);
    rows.push({ mount: storageDir, usedBytes: Math.max(0, info.totalBytes - info.freeBytes), totalBytes: info.totalBytes, holdsStorage: true });
  }
  return rows;
}

function windowsMounts() {
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\`);
}

function unixMounts() {
  const skip = new Set(['proc', 'sysfs', 'devtmpfs', 'tmpfs', 'devpts', 'cgroup', 'cgroup2', 'overlay', 'squashfs', 'securityfs', 'bpf', 'tracefs', 'debugfs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'autofs', 'ramfs', 'pstore']);
  try {
    return fs
      .readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((line) => line.split(' '))
      .filter((parts) => parts.length >= 3 && !skip.has(parts[2] ?? ''))
      .map((parts) => (parts[1] ?? '/').replace(/\\040/g, ' '))
      .filter((mount) => mount.startsWith('/'));
  } catch {
    return ['/'];
  }
}

async function readGpus(): Promise<{ devices: Telemetry['gpus']; note: string | null }> {
  const nvidia = await nvidiaGpus();
  if (nvidia.length > 0) return { devices: nvidia, note: null };
  if (process.platform === 'win32') {
    const windows = await windowsGpus();
    if (windows.length > 0) return { devices: windows, note: null };
  }
  return { devices: [], note: 'No GPU usage counters were available on this computer.' };
}

async function nvidiaGpus(): Promise<Telemetry['gpus']> {
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, util, used, total, temp] = line.split(',').map((part) => part.trim());
        return {
          name: name || 'NVIDIA GPU',
          utilization: numberOrNull(util),
          memoryUsedBytes: mebibytes(used),
          memoryTotalBytes: mebibytes(total),
          temperatureC: numberOrNull(temp),
        };
      });
  } catch {
    return [];
  }
}

const WINDOWS_GPU = `
$names = @(Get-CimInstance Win32_VideoController | ForEach-Object { [string]$_.Name })
$byPhys = @{}
try {
  foreach ($sample in (Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples) {
    if ($sample.InstanceName -match 'phys_(\\d+)_eng_\\d+_engtype_3D') {
      $index = [int]$Matches[1]
      $value = [math]::Round([double]$sample.CookedValue, 1)
      if (-not $byPhys.ContainsKey($index) -or $byPhys[$index] -lt $value) { $byPhys[$index] = $value }
    }
  }
} catch {}
$rows = @()
for ($index = 0; $index -lt $names.Count; $index++) {
  $util = $null
  if ($byPhys.ContainsKey($index)) { $util = $byPhys[$index] }
  $rows += [ordered]@{ name = $names[$index]; utilization = $util }
}
if ($rows.Count -eq 0) { '[]' } else { @($rows) | ConvertTo-Json -Compress }
`;

async function windowsGpus(): Promise<Telemetry['gpus']> {
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_GPU], {
      timeout: 8000,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout.trim() || '[]') as unknown;
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const record = row as { name?: unknown; utilization?: unknown };
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      if (!name) return [];
      const utilization = typeof record.utilization === 'number' ? round1(record.utilization) : null;
      return [{ name, utilization, memoryUsedBytes: null, memoryTotalBytes: null, temperatureC: null }];
    });
  } catch {
    return [];
  }
}

function mebibytes(value: string | undefined) {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n * 1024 * 1024);
}

function numberOrNull(value: string | undefined) {
  if (!value || value.toLowerCase() === 'n/a' || value === '[not supported]') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value: number) {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
