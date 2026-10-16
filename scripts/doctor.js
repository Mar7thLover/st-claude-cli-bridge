import { spawnSync } from 'node:child_process';
import { describeConfig, getConfig, loadEnv } from '../src/config.js';
import { withDiscoveredModels } from '../src/models.js';

loadEnv();
let config;
try { config = getConfig(); }
catch (error) {
  console.error(`Configuration error: ${error.message}`);
  process.exit(1);
}
for (const line of describeConfig(config)) console.log(line);
let ok = true;
for (const args of [['--version'], ['auth', 'status']]) {
  const result = spawnSync(config.claudeBin, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error || result.status !== 0) {
    console.error(`${args.join(' ')} failed: ${result.error?.message || 'check Claude Code installation/login'}`);
    ok = false; continue;
  }
  if (args[0] === '--version') console.log(`Claude Code: ${result.stdout.trim()}`);
  else {
    try {
      const status = JSON.parse(result.stdout);
      console.log(`Logged in: ${status.loggedIn}; auth: ${status.authMethod}; provider: ${status.apiProvider}`);
      if (!status.loggedIn) ok = false;
    } catch { console.error('Unrecognized auth status'); ok = false; }
  }
}
console.log(`Node: ${process.version}; executable: ${config.claudeBin}`);
if (ok) {
  try {
    const runtime = await withDiscoveredModels(config);
    console.log(`CLI model IDs/aliases: ${runtime.models.join(', ')}`);
  } catch (error) { console.error(error.message); ok = false; }
}
if (!ok) console.error('Run claude auth login in your own terminal if login is required.');
process.exitCode = ok ? 0 : 1;
