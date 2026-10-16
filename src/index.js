import { createBridge } from './server.js';
import { describeConfig, getConfig, loadEnv, localUrl } from './config.js';
import { withDiscoveredModels } from './models.js';

let config;
try {
  loadEnv();
  config = await withDiscoveredModels(getConfig());
} catch (error) {
  // Configuration and discovery errors are user-actionable; skip the stack trace.
  console.error(`[ClaudeBridge] Startup failed: ${error.message}`);
  console.error('[ClaudeBridge] Check config.json / .env, then run npm run doctor');
  process.exit(1);
}
const server = createBridge(config);
server.on('error', error => { console.error(`[ClaudeBridge] ${error.message}`); process.exitCode = 1; });
server.listen(config.port, config.host, () => {
  console.log(`[ClaudeBridge] ${localUrl(config)}/v1`);
  for (const line of describeConfig(config)) console.log(`[ClaudeBridge] ${line}`);
  console.log(`[ClaudeBridge] Claude Code: ${config.claudeBin}`);
  console.log(`[ClaudeBridge] Discovered ${config.models.length} model IDs/aliases from Claude Code`);
  console.log('[ClaudeBridge] OpenAI Chat Completions compatible | Ctrl+C to stop');
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await server.shutdown();
});
