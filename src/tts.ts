import type { RealtimeConnectOptions } from './types';

export interface GreetingTTSOptions {
  text: string;
  voice: string;
  provider: RealtimeConnectOptions;
  apiKey?: string;
  openaiModel?: string;
}

function env(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

function providerKind(provider: RealtimeConnectOptions): 'openai' | 'grok' {
  if (provider.provider === 'grok') return 'grok';
  if (provider.url?.includes('api.x.ai')) return 'grok';
  return 'openai';
}

function apiKeyFor(provider: RealtimeConnectOptions, explicit?: string): string {
  const kind = providerKind(provider);
  const envName = kind === 'grok' ? 'XAI_API_KEY' : 'OPENAI_API_KEY';
  const key = explicit ?? provider.apiKey ?? env(envName);
  if (!key) throw new Error(`${envName} missing`);
  return key;
}

async function fetchGrokMulaw(opts: GreetingTTSOptions): Promise<Buffer> {
  const res = await fetch('https://api.x.ai/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKeyFor(opts.provider, opts.apiKey)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: opts.text,
      voice_id: opts.voice,
      language: 'en',
      output_format: { codec: 'mulaw', sample_rate: 8000 },
    }),
  });
  if (!res.ok) throw new Error(`xAI TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchOpenAIPcm(opts: GreetingTTSOptions): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKeyFor(opts.provider, opts.apiKey)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.openaiModel ?? 'gpt-4o-mini-tts',
      voice: opts.voice,
      input: opts.text,
      response_format: 'pcm',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function pcm24kToMulaw8k(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor(inSamples / 3);
  const out = Buffer.allocUnsafe(outSamples);
  for (let i = 0; i < outSamples; i++) {
    const base = i * 3 * 2;
    const s0 = pcm.readInt16LE(base);
    const s1 = pcm.readInt16LE(base + 2);
    const s2 = pcm.readInt16LE(base + 4);
    out[i] = linearToMulaw(((s0 + s1 + s2) / 3) | 0);
  }
  return out;
}

export async function renderGreetingPcmu(
  opts: GreetingTTSOptions,
): Promise<Buffer> {
  const text = opts.text.trim();
  if (!text) throw new Error('empty greeting text');
  const normalized = { ...opts, text };
  if (providerKind(opts.provider) === 'grok') return fetchGrokMulaw(normalized);
  return pcm24kToMulaw8k(await fetchOpenAIPcm(normalized));
}
