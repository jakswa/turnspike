import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GROK_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_MODEL,
  TurnspikeConnection,
  grokRealtimeUrl,
  openaiRealtimeUrl,
  providers,
} from '../src';

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

describe('TurnspikeConnection', () => {
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
