import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GROK_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_MODEL,
  TurnspikeConnection,
  grokRealtimeUrl,
  openaiRealtimeUrl,
  providers,
} from '../src';
import { resolveConnectOptions } from '../src/connection';

function emitServerEvent(
  conn: TurnspikeConnection,
  event: Record<string, unknown>,
): void {
  (
    conn as unknown as {
      handleEvent(event: Record<string, unknown>): void;
    }
  ).handleEvent(event);
}

describe('provider helpers', () => {
  test('builds default OpenAI and Grok realtime URLs', () => {
    expect(openaiRealtimeUrl()).toBe(
      `wss://api.openai.com/v1/realtime?model=${DEFAULT_OPENAI_REALTIME_MODEL}`,
    );
    expect(grokRealtimeUrl()).toBe(
      `wss://api.x.ai/v1/realtime?model=${DEFAULT_GROK_REALTIME_MODEL}`,
    );
  });

  test('provider options include API key and encoded model URL', () => {
    expect(providers.openai({ apiKey: 'oa', model: 'gpt test' })).toEqual({
      provider: 'openai',
      apiKey: 'oa',
      model: 'gpt test',
      url: 'wss://api.openai.com/v1/realtime?model=gpt%20test',
    });
    expect(providers.grok({ apiKey: 'xai', model: 'grok test' })).toEqual({
      provider: 'grok',
      apiKey: 'xai',
      model: 'grok test',
      url: 'wss://api.x.ai/v1/realtime?model=grok%20test',
    });
  });
});

describe('resolveConnectOptions', () => {
  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const previous = Object.fromEntries(
      Object.keys(vars).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      fn();
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  test('falls back to provider env keys for providers.* options with a url', () => {
    withEnv({ OPENAI_API_KEY: 'oa_env', XAI_API_KEY: 'xai_env' }, () => {
      expect(resolveConnectOptions(providers.openai()).apiKey).toBe('oa_env');
      expect(resolveConnectOptions(providers.grok()).apiKey).toBe('xai_env');
      expect(resolveConnectOptions(providers.openai({ apiKey: 'explicit' })).apiKey).toBe(
        'explicit',
      );
    });
  });

  test('never applies env keys to a custom url without a named provider', () => {
    withEnv({ OPENAI_API_KEY: 'oa_env', XAI_API_KEY: 'xai_env' }, () => {
      expect(
        resolveConnectOptions({ url: 'wss://example.test/realtime' }).apiKey,
      ).toBeUndefined();
    });
  });
});

describe('TurnspikeConnection', () => {
  test('queues non-audio sends while connecting and flushes them on open', async () => {
    const received: string[] = [];
    let connections = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response('expected websocket', { status: 400 });
      },
      websocket: {
        open() {
          connections++;
        },
        message(_ws, message) {
          received.push(String(message));
        },
      },
    });

    const conn = new TurnspikeConnection({ id: 'call_queue' });
    conn.on('error', () => {});
    conn.connect({ url: `ws://127.0.0.1:${server.port}`, apiKey: 'key' });
    // Second connect while the first is still in flight must be ignored.
    conn.connect({ url: `ws://127.0.0.1:${server.port}`, apiKey: 'key' });
    conn.sendSessionUpdate({ type: 'realtime', instructions: 'Hi.' });
    conn.sendAudio('ZHJvcHBlZA=='); // realtime audio is dropped, not queued

    await new Promise<void>((resolve) => conn.on('session_created', resolve));
    const deadline = Date.now() + 2000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    conn.close();
    server.stop(true);

    expect(connections).toBe(1);
    expect(received.map((msg) => (JSON.parse(msg) as { type: string }).type)).toEqual([
      'session.update',
    ]);
  });

  test('does not re-emit audio_done on response.done after output_audio.done', () => {
    const conn = new TurnspikeConnection();
    const events: unknown[] = [];
    conn.on('audio_done', (itemId) => events.push(['audio_done', itemId]));

    emitServerEvent(conn, {
      type: 'response.output_audio.delta',
      delta: 'abc',
      item_id: 'assistant_item',
    });
    emitServerEvent(conn, {
      type: 'response.output_audio.done',
      item_id: 'assistant_item',
    });
    emitServerEvent(conn, {
      type: 'response.done',
      response: { id: 'resp_1', status: 'completed', output: [] },
    });

    expect(events).toEqual([['audio_done', 'assistant_item']]);
  });

  test('emits asynchronous error and close when API key is missing', async () => {
    const conn = new TurnspikeConnection({ id: 'call_1' });
    const events: unknown[] = [];
    conn.on('error', (error) => events.push(error));
    conn.on('close', (code, reason) => events.push([code, reason]));

    conn.connect({ url: 'wss://example.test/realtime' });
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(events).toEqual([
      {
        type: 'websocket',
        code: 'missing_api_key',
        message:
          'Realtime API key is missing; pass apiKey or set OPENAI_API_KEY/XAI_API_KEY',
      },
      [1011, 'missing_api_key'],
    ]);
  });

  test('normalizes audio, transcript, speech, and error events', () => {
    const conn = new TurnspikeConnection();
    const events: unknown[] = [];
    conn.on('audio', (base64, itemId) => events.push(['audio', base64, itemId]));
    conn.on('audio_done', (itemId) => events.push(['audio_done', itemId]));
    conn.on('speech_started', () => events.push(['speech_started']));
    conn.on('transcript:user', (text, itemId) =>
      events.push(['user', text, itemId]),
    );
    conn.on('transcript:assistant', (text, itemId) =>
      events.push(['assistant', text, itemId]),
    );
    conn.on('error', (error) => events.push(['error', error]));

    emitServerEvent(conn, {
      type: 'response.output_audio.delta',
      delta: 'abc',
      item_id: 'assistant_item',
    });
    emitServerEvent(conn, {
      type: 'input_audio_buffer.speech_started',
      item_id: 'user_item',
    });
    emitServerEvent(conn, {
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: ' hello ',
      item_id: 'user_item',
    });
    emitServerEvent(conn, {
      type: 'response.output_audio_transcript.done',
      transcript: ' hi ',
      item_id: 'assistant_item',
    });
    emitServerEvent(conn, {
      type: 'response.output_audio.done',
      item_id: 'assistant_item',
    });
    emitServerEvent(conn, {
      type: 'error',
      error: { type: 'invalid_request', code: 'bad', message: 'Bad' },
    });

    expect(events).toEqual([
      ['audio', 'abc', 'assistant_item'],
      ['speech_started'],
      ['user', 'hello', 'user_item'],
      ['assistant', 'hi', 'assistant_item'],
      ['audio_done', 'assistant_item'],
      [
        'error',
        { type: 'invalid_request', code: 'bad', message: 'Bad' },
      ],
    ]);
  });

  test('normalizes tool calls and emits xAI audio_done fallback on response.done', () => {
    const conn = new TurnspikeConnection();
    const events: unknown[] = [];
    conn.on('audio', (base64, itemId) => events.push(['audio', base64, itemId]));
    conn.on('audio_done', (itemId) => events.push(['audio_done', itemId]));
    conn.on('function_call_arguments_done', (callId, name, args) =>
      events.push(['tool', callId, name, args]),
    );

    emitServerEvent(conn, {
      type: 'response.output_audio.delta',
      delta: 'abc',
      item_id: 'assistant_item',
    });
    emitServerEvent(conn, {
      type: 'response.done',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'hang_up',
            arguments: '{}',
          },
        ],
      },
    });

    expect(events).toEqual([
      ['audio', 'abc', 'assistant_item'],
      ['tool', 'call_1', 'hang_up', '{}'],
      ['audio_done', 'assistant_item'],
    ]);
  });
});
