import { modelInfo, EFFORT_LEVELS } from './models.js';

// Keep this independent of prompt.js to avoid a circular dependency.
export function normalizeThinking(body, model, config, fail) {
  const canonical = value => ['off', 'none'].includes(value) ? 'none' : value === 'auto' ? undefined : value;
  for (const key of ['effort', 'reasoning_effort']) {
    if (body[key] !== undefined && ![...EFFORT_LEVELS, 'none', 'off', 'auto'].includes(body[key])) fail(`${key} must be low, medium, high, xhigh, max, auto, none or off`);
  }
  if (body.effort !== undefined && body.reasoning_effort !== undefined && canonical(body.effort) !== canonical(body.reasoning_effort)) fail('effort and reasoning_effort conflict');
  let effort = canonical(body.effort ?? body.reasoning_effort);
  let thinking;
  let budgetTokens;
  if (body.thinking !== undefined) {
    if (typeof body.thinking === 'boolean') thinking = body.thinking ? 'enabled' : 'disabled';
    else if (body.thinking && typeof body.thinking === 'object' && !Array.isArray(body.thinking)) {
      const value = body.thinking;
      if (Object.keys(value).some(key => !['type', 'enabled', 'budget_tokens', 'budgetTokens'].includes(key))) fail('Unsupported thinking field');
      if (value.type !== undefined && !['enabled', 'disabled', 'adaptive'].includes(value.type)) fail('thinking.type must be enabled, disabled or adaptive');
      if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail('thinking.enabled must be boolean');
      const fromEnabled = value.enabled === undefined ? undefined : value.enabled ? 'enabled' : 'disabled';
      if (value.type && fromEnabled && (value.type === 'disabled') !== (fromEnabled === 'disabled')) fail('thinking.type and thinking.enabled conflict');
      thinking = value.type ?? fromEnabled;
      if (value.budget_tokens !== undefined && value.budgetTokens !== undefined && value.budget_tokens !== value.budgetTokens) fail('Thinking budgets conflict');
      budgetTokens = value.budget_tokens ?? value.budgetTokens;
      if (!thinking && budgetTokens === undefined) fail('thinking needs type, enabled or budget_tokens');
    } else fail('thinking must be a boolean or object');
  }
  if (effort === 'none') {
    if (thinking && thinking !== 'disabled') fail('effort=none/off conflicts with enabled thinking');
    thinking = 'disabled'; effort = undefined;
  }
  const caps = modelInfo(model, config);
  if (effort && !caps.effortLevels.includes(effort)) fail(`${model} supports effort levels: ${caps.effortLevels.join(', ') || 'none (effort is not supported)'}`);
  if (thinking === 'disabled') {
    if (!caps.canDisableThinking) fail(`${model}: ${caps.thinkingOffReason}`);
    if (effort && caps.thinkingOffUnavailableAt.includes(effort)) fail(`${model} cannot disable thinking at effort=${effort}; choose low, medium or high`);
  } else if (thinking && !caps.supportsThinking) fail(`Thinking support for ${model} is unknown`);
  if (thinking === 'adaptive' && !caps.supportsEffort) fail(`${model} does not support adaptive thinking through this bridge`);
  if (!effort && thinking !== 'disabled' && budgetTokens === undefined && caps.bridgeDefaultEffort) effort = caps.bridgeDefaultEffort;
  if (budgetTokens !== undefined) {
    if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1024 || budgetTokens > 128000) fail('thinking.budget_tokens must be an integer between 1024 and 128000');
    if (thinking === 'disabled' || thinking === 'adaptive') fail('Thinking budget conflicts with the requested thinking mode');
    if (!/^claude-(?:haiku-4-5|sonnet-4-[05]|opus-4-[015]|3-7-sonnet)(?:-|\[|$)/.test(caps.resolvedModel)) fail('Fixed thinking budget is supported here only for known non-adaptive models (for example Haiku 4.5)');
    if (body.max_completion_tokens !== undefined || body.max_tokens !== undefined) {
      if (budgetTokens >= (body.max_completion_tokens ?? body.max_tokens)) fail('thinking.budget_tokens must be less than max_tokens');
    }
    thinking = 'enabled';
  }
  return { effort, thinking, thinkingBudget: budgetTokens, thinkingControl: body.effort !== undefined || body.reasoning_effort !== undefined || body.thinking !== undefined };
}

export function thinkingEnvironment(request, inherited) {
  const env = { ...inherited };
  // Explicit per-request controls must not be overridden by shell-wide settings.
  if (request.thinkingControl || request.effort || request.thinking || request.thinkingBudget !== undefined) {
    delete env.MAX_THINKING_TOKENS;
    delete env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING;
    env.CLAUDE_CODE_EFFORT_LEVEL = request.effort || 'auto';
  }
  if (request.thinking === 'disabled') {
    env.MAX_THINKING_TOKENS = '0';
    // Do not inherit an account effort above the allowed thinking-off level.
    env.CLAUDE_CODE_EFFORT_LEVEL = request.effort || 'high';
  } else if (request.thinkingBudget !== undefined) env.MAX_THINKING_TOKENS = String(request.thinkingBudget);
  return env;
}
