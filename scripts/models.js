import { getConfig, loadEnv } from '../src/config.js';
import { withDiscoveredModels } from '../src/models.js';
loadEnv();
const config = await withDiscoveredModels(getConfig(), { includeRetired: process.argv.includes('--all') });
if (process.argv.includes('--json')) console.log(JSON.stringify({ discoveredAt: config.modelsDiscoveredAt, provider: config.apiProvider, models: config.modelCatalog }, null, 2));
else {
  console.log(`Claude Code 模型菜单及对应 ID/别名（${config.apiProvider}，${config.modelsDiscoveredAt}）`);
  console.table(config.modelCatalog.map(m => ({ model: m.id, effort: m.effortLevels.join('/') || '不支持', thinkingOff: m.canDisableThinking ? (m.thinkingOffUnavailableAt.length ? '允许（effort≤high）' : '允许') : '不允许/未核实', source: m.source, lifecycle: m.lifecycle || '菜单模型', availability: m.availability })));
  console.log(`最新菜单 + 官方仍在服务的旧版目录。菜单可见/API active 不等于账号一定能用；verified 为最近 ${config.modelCheckMaxAgeMs / 3600000} 小时内的生成校验，failed 为最近一次失败。--all 同时列出已停用模型。`);
}
