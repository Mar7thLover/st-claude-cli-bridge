// Official Anthropic lifecycle table, checked 2026-09-24:
// https://platform.claude.com/docs/en/about-claude/model-deprecations
// API lifecycle is distinct from access through a particular Claude Code account.
export const HISTORY_CHECKED_AT = '2026-09-24';
export const HISTORICAL_MODELS = [
  ['claude-fable-5', 'Fable 5'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-6', 'Opus 4.6'],
  ['claude-opus-4-5-20251101', 'Opus 4.5'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
].map(([id, name]) => ({ id, name, lifecycle: 'active', lifecycleCheckedAt: HISTORY_CHECKED_AT }));

export const RETIRED_MODELS = [
  ['claude-opus-4-1-20250805', '2026-08-05'],
  ['claude-opus-4-20250514', '2026-06-15'],
  ['claude-sonnet-4-20250514', '2026-06-15'],
  ['claude-3-7-sonnet-20250219', '2026-02-19'],
  ['claude-3-5-haiku-20241022', '2026-02-19'],
  ['claude-3-haiku-20240307', '2026-04-20'],
  ['claude-3-5-sonnet-20240620', '2025-10-28'],
  ['claude-3-5-sonnet-20241022', '2025-10-28'],
  ['claude-3-opus-20240229', '2026-01-05'],
  ['claude-3-sonnet-20240229', '2025-07-21'],
  ['claude-2.0', '2025-07-21'],
  ['claude-2.1', '2025-07-21'],
  ...['claude-1.0', 'claude-1.1', 'claude-1.2', 'claude-1.3', 'claude-instant-1.0', 'claude-instant-1.1', 'claude-instant-1.2'].map(id => [id, '2024-11-06']),
].map(([id, retiredAt]) => ({ id, name: id, lifecycle: 'retired', retiredAt, lifecycleCheckedAt: HISTORY_CHECKED_AT }));
