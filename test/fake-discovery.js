import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.request?.subtype !== 'initialize') process.exit(3);
  process.stdout.write(JSON.stringify({ type: 'control_response', response: {
    request_id: request.request_id, subtype: 'success', response: {
      models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }],
      account: { apiProvider: 'firstParty', email: 'PRIVATE_EMAIL', organization: 'PRIVATE_ORG' },
    },
  } }) + '\n');
}
