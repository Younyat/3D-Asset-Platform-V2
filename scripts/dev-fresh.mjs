import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const portArgIndex = args.findIndex((arg) => arg === '--port');
const port = Number(portArgIndex >= 0 ? args[portArgIndex + 1] : args.find((arg) => /^\d+$/.test(arg)) ?? 5187);
const dryRun = args.includes('--dry-run');
const root = resolve('.');
const bundledNpmCli = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCli = process.env.npm_execpath || (existsSync(bundledNpmCli) ? bundledNpmCli : null);

const runNpm = (npmArgs, options = {}) => {
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...npmArgs], options);
  }

  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, {
    ...options,
    shell: process.platform === 'win32',
  });
};

const dependenciesAreInstalled = () => {
  if (!existsSync(resolve('node_modules'))) return false;

  const check = runNpm(['ls', '--depth=0', '--silent'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });

  return check.status === 0;
};

const ensureDependencies = () => {
  if (dependenciesAreInstalled()) return;

  if (dryRun) {
    console.log('Dependencies are missing or incomplete; npm install would run.');
    return;
  }

  console.log('Dependencies are missing or incomplete. Installing them now...');
  const install = runNpm(['install'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  if (install.error) {
    console.error(`Unable to start npm install: ${install.error.message}`);
    process.exit(1);
  }

  if (install.status !== 0) {
    console.error(`npm install failed with exit code ${install.status ?? 'unknown'}.`);
    process.exit(install.status ?? 1);
  }

  if (!dependenciesAreInstalled()) {
    console.error('Dependencies are still incomplete after npm install.');
    process.exit(1);
  }

  console.log('Dependencies installed successfully.');
};

const runPowerShell = (command) =>
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();

const getWindowsPortOwners = () => {
  const command = `
    $connections = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue;
    $connections | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue;
      if ($process) {
        [PSCustomObject]@{
          ProcessId = $process.ProcessId;
          Name = $process.Name;
          CommandLine = $process.CommandLine
        }
      }
    } | ConvertTo-Json -Compress
  `;
  const output = runPowerShell(command);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
};

const isProjectDevServer = (processInfo) => {
  const commandLine = String(processInfo.CommandLine ?? '').toLowerCase();
  const name = String(processInfo.Name ?? '').toLowerCase();
  const normalizedRoot = root.toLowerCase();

  return (
    (name.includes('node') || name.includes('npm')) &&
    commandLine.includes('vite') &&
    (commandLine.includes(normalizedRoot) || commandLine.includes('3d asset platform'))
  );
};

const stopProcess = (processId) => {
  runPowerShell(`Stop-Process -Id ${processId} -Force`);
};

if (!Number.isFinite(port) || port <= 0) {
  console.error('Invalid port. Usage: npm.cmd run dev:fresh -- --port 5187');
  process.exit(1);
}

if (!existsSync('package.json')) {
  console.error('Run this command from the project root.');
  process.exit(1);
}

ensureDependencies();

if (process.platform === 'win32') {
  const owners = getWindowsPortOwners();
  owners.forEach((owner) => {
    if (!isProjectDevServer(owner)) {
      console.log(`Port ${port} is used by PID ${owner.ProcessId}; not stopping it because it does not look like this project.`);
      return;
    }

    console.log(`${dryRun ? 'Would stop' : 'Stopping'} previous dev server on port ${port} (PID ${owner.ProcessId})`);
    if (!dryRun) stopProcess(owner.ProcessId);
  });
} else if (dryRun) {
  console.log('Dry run only checks Windows port owners in this script.');
}

if (dryRun) process.exit(0);

const viteBin = resolve('node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error('Vite is unavailable after dependency verification.');
  process.exit(1);
}

const child = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
