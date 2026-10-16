import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configFile, configSchema, defaultConfigData, describeConfig, getConfig, loadEnv, root } from '../src/config.js';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const schemaFile = path.join(root, 'config.schema.json');

if (process.argv.includes('--schema')) {
  await writeFile(schemaFile, json(configSchema()));
  console.log(`已生成 ${schemaFile}`);
} else if (process.argv.includes('--init')) {
  // Never overwrite a config.json the user has edited.
  if (existsSync(configFile)) {
    console.error(`${configFile} 已存在，未覆盖。要恢复默认值，请先手动备份并删除它。`);
    process.exitCode = 1;
  } else {
    await writeFile(configFile, json(defaultConfigData()));
    console.log(`已按默认值创建 ${configFile}`);
  }
} else {
  loadEnv();
  try {
    const config = getConfig();
    for (const line of describeConfig(config)) console.log(line);
    const { modelCatalog, envOverrides, configFile: _file, ...effective } = config;
    if (effective.apiKey) effective.apiKey = '******';
    console.log(json(effective).trimEnd());
    console.log('以上为生效值（环境变量 > config.json > 默认值）；修改 config.json 后重启桥接器生效。');
  } catch (error) {
    console.error(`配置无效：${error.message}`);
    process.exitCode = 1;
  }
}
