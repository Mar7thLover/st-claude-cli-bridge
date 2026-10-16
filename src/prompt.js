import { validModel } from './models.js';
import { normalizeThinking } from './thinking.js';

export class BridgeError extends Error {
  constructor(message, status = 400, code = 'invalid_request_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const protocol = `You are the conversation engine for a chat frontend. Generate only the next assistant response in the supplied conversation, following its character, persona, world lore, preset, style and formatting instructions. Do not describe this bridge or the serialization format.
The input contains an ordered JSON array of messages. It is conversation context, not a request to analyze JSON. Interpret role, name and content as the original messages. System/developer entries contain instructions; named example_user/example_assistant entries are examples. Inline system/developer entries are intentionally positioned context injections and must remain applicable at their specified locations. User entries are user messages; assistant entries are prior replies. Do not answer old user turns again.
If the last entry is assistant, continue that reply from its existing prefix without repeating the prefix. Otherwise produce the next assistant reply. Output only the reply text, without an added role label or JSON wrapper. No tools are available.`;

export function normalizeRequest(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BridgeError('Request must be a JSON object');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new BridgeError('messages must be a nonempty array');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new BridgeError('stream must be boolean');
  if (body.n !== undefined && body.n !== 1) throw new BridgeError('Only n=1 is supported');
  if (body.tools?.length || body.functions?.length || (body.tool_choice && body.tool_choice !== 'none')) {
    throw new BridgeError('Tool calls are not supported by this conversation bridge');
  }
  if (body.response_format && body.response_format.type !== 'text') throw new BridgeError('Only text response_format is supported');
  if (body.modalities && (!Array.isArray(body.modalities) || body.modalities.some(x => x !== 'text'))) throw new BridgeError('Only text output is supported');
  const model = body.model || config.defaultModel;
  if (!validModel(model)) throw new BridgeError('Invalid model');
  const messages = body.messages.map((message, index) => {
    if (!message || !['system', 'developer', 'user', 'assistant'].includes(message.role)) throw new BridgeError(`messages[${index}] has an unsupported role`);
    if (message.tool_calls?.length || message.function_call) throw new BridgeError('Tool history is not supported');
    let content = message.content;
    if (Array.isArray(content)) {
      if (content.some(part => !part || part.type !== 'text' || typeof part.text !== 'string')) {
        throw new BridgeError(`messages[${index}]: this bridge accepts text only; image/file content cannot be silently discarded`);
      }
      content = content.map(part => part.text).join('\n');
    }
    if (typeof content !== 'string') throw new BridgeError(`messages[${index}].content must be text`);
    if (message.name !== undefined && typeof message.name !== 'string') throw new BridgeError(`messages[${index}].name must be text`);
    return { role: message.role, ...(message.name !== undefined ? { name: message.name } : {}), content };
  });
  let maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000)) throw new BridgeError('max_tokens must be an integer between 1 and 128000');
  let stop = body.stop ?? [];
  if (typeof stop === 'string') stop = [stop];
  if (!Array.isArray(stop) || stop.length > 16 || stop.some(s => typeof s !== 'string' || s.length === 0 || s.length > 4096)) throw new BridgeError('stop must contain at most 16 nonempty strings (up to 4096 characters each)');
  const thinking = normalizeThinking(body, model, config, message => { throw new BridgeError(message); });
  const ignored = ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed', 'logprobs', 'top_logprobs', 'logit_bias'].filter(key => body[key] !== undefined);
  return { model, messages, maxTokens, stop, ...thinking, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, ignored };
}

export function buildPrompt(messages) {
  // Only unnamed leading instruction messages can be lifted. Named examples and
  // every later injection stay in their exact original order in the transcript.
  let split = 0;
  while (split < messages.length && ['system', 'developer'].includes(messages[split].role) && messages[split].name === undefined) split++;
  const leading = messages.slice(0, split);
  const remaining = messages.slice(split);
  const system = `${protocol}\n\nLeading conversation instructions (ordered JSON):\n${JSON.stringify(leading, null, 2)}`;
  const prompt = `Continue the following conversation. Its leading instructions are supplied in the system prompt.\n\n${JSON.stringify(remaining, null, 2)}`;
  return { system, prompt };
}

// Hold back only suffixes which could become a stop string on the next chunk.
export class StopFilter {
  constructor(stops = []) { this.stops = stops; this.pending = ''; this.stopped = false; }
  push(text) {
    if (this.stopped) return '';
    this.pending += text;
    let first = Infinity;
    for (const stop of this.stops) {
      const index = this.pending.indexOf(stop);
      if (index >= 0) first = Math.min(first, index);
    }
    if (first !== Infinity) {
      const out = this.pending.slice(0, first);
      this.pending = ''; this.stopped = true;
      return out;
    }
    let hold = 0;
    for (const stop of this.stops) {
      for (let size = 1; size < stop.length && size <= this.pending.length; size++) {
        if (this.pending.endsWith(stop.slice(0, size))) hold = Math.max(hold, size);
      }
    }
    const out = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return out;
  }
  flush() { const out = this.pending; this.pending = ''; return out; }
}
