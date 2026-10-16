import { mkdir, writeFile } from 'node:fs/promises';
import { getConfig, loadEnv } from '../src/config.js';
import { withDiscoveredModels, modelChecksFile } from '../src/models.js';
import { HISTORICAL_MODELS } from '../src/model-history.js';
import { normalizeRequest } from '../src/prompt.js';
import { runClaude } from '../src/claude.js';

loadEnv();
const config = await withDiscoveredModels(getConfig());
const report = { provider: config.apiProvider, checks: [] };
// One tiny real bridge-format generation per model. Serial to limit account load.
for (const historical of HISTORICAL_MODELS) {
  const check = { model: historical.id, checkedAt: new Date().toISOString() };
  const request = normalizeRequest({ model: historical.id, max_tokens: 256, messages: [{ role: 'user', content: 'Reply exactly OK.' }] }, config);
  let answer = '';
  try {
    for await (const event of runClaude(request, config, new AbortController().signal)) {
      if (event.type === 'text') answer += event.text;
      if (event.type === 'result') check.actualModel = event.actualModel;
    }
    if (!answer.includes('OK')) { check.status = 'failed'; check.errorCode = 'unexpected_answer'; }
    else if (check.actualModel !== historical.id) { check.status = 'model-mismatch'; check.errorCode = 'model_mismatch'; }
    else check.status = 'verified';
  } catch (error) { check.status = 'failed'; check.errorCode = error.code || 'unknown_error'; }
  report.checks.push(check);
  console.log(JSON.stringify(check));
}
await mkdir(new URL('../.runtime/', import.meta.url), { recursive: true });
await writeFile(modelChecksFile, JSON.stringify(report, null, 2));
console.log('校验结果已保存；重启桥接器后在前端刷新模型列表即可看到最新状态。');
if (report.checks.some(check => check.status !== 'verified')) process.exitCode = 1;
