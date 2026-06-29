import type { RealtimeConnectOptions } from './types';

export const DEFAULT_OPENAI_REALTIME_MODEL = 'gpt-realtime-1.5';
export const DEFAULT_GROK_REALTIME_MODEL = 'grok-voice-think-fast-1.0';

export function openaiRealtimeUrl(
  model = DEFAULT_OPENAI_REALTIME_MODEL,
): string {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

export function grokRealtimeUrl(model = DEFAULT_GROK_REALTIME_MODEL): string {
  return `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`;
}

export const providers = {
  openai(opts: Omit<RealtimeConnectOptions, 'provider' | 'url'> = {}) {
    return {
      ...opts,
      provider: 'openai' as const,
      url: openaiRealtimeUrl(opts.model),
    };
  },

  grok(opts: Omit<RealtimeConnectOptions, 'provider' | 'url'> = {}) {
    return {
      ...opts,
      provider: 'grok' as const,
      url: grokRealtimeUrl(opts.model),
    };
  },
};
