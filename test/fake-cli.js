import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
if (model === 'hang') {
  output({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'started' } } });
  setInterval(() => {}, 1000);
} else if (model === 'bad-json') {
  process.stdout.write('invalid JSON\n');
} else if (model === 'failed') {
  output({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'PRIVATE_SECRET' });
} else if (model === 'filtered') {
  output({ type: 'assistant', error: 'invalid_request', message: { content: [{ type: 'text', text: 'safeguards flagged this message [reasoning_extraction] PRIVATE_SECRET' }] } });
} else if (model === 'no-result') {
  output({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } });
} else {
  const system = readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
  if (!system.includes('角色卡') || !prompt.includes('世界书')) process.exit(9);
  const text = '你好😺';
  if (model !== 'fallback') output({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  output({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  output({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 }, stop_reason: 'max_tokens' });
}
