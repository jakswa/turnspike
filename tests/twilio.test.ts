import { describe, expect, test } from 'bun:test';
import {
  TurnspikeConnection,
  TwilioTurnspikeSession,
  type OaiSessionConfig,
  type TwilioOutboundEvent,
} from '../src';

const sessionConfig: OaiSessionConfig = {
  type: 'realtime',
  output_modalities: ['audio'],
  audio: {
    input: { format: { type: 'audio/pcmu' } },
    output: { format: { type: 'audio/pcmu' }, voice: 'cedar' },
  },
  instructions: 'Be helpful.',
};

class TestRealtimeConnection extends TurnspikeConnection {
  audio: string[] = [];
  interrupts: Array<{ itemId: string; playedMs: number }> = [];
  sessionUpdates: OaiSessionConfig[] = [];
  functionOutputs: Array<{ callId: string; output: string }> = [];
  conversationItems: Record<string, unknown>[] = [];
  closed = 0;

  override connect(): void {}

  override close(): void {
    this.closed++;
  }

  override sendAudio(base64: string): void {
    this.audio.push(base64);
  }

  override interrupt(itemId: string, playedMs: number): void {
    this.interrupts.push({ itemId, playedMs });
  }

  override sendSessionUpdate(config: OaiSessionConfig): void {
    this.sessionUpdates.push(config);
  }

  override addFunctionCallOutput(callId: string, output: string): void {
    this.functionOutputs.push({ callId, output });
  }

  override sendConversationItem(item: Record<string, unknown>): void {
    this.conversationItems.push(item);
  }
}

function decodeSent(sent: string[]): TwilioOutboundEvent[] {
  return sent.map((msg) => JSON.parse(msg) as TwilioOutboundEvent);
}

function start(session: TwilioTurnspikeSession): void {
  session.handleTwilioEvent({
    event: 'start',
    streamSid: 'stream_1',
    start: { streamSid: 'stream_1' },
  });
}

describe('TwilioTurnspikeSession', () => {
  test('captures streamSid on start and forwards inbound Twilio media to realtime audio', () => {
    const sent: string[] = [];
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: (data) => sent.push(String(data)) },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      connectOnStart: false,
    });

    start(agent);
    agent.handleTwilioEvent({
      event: 'media',
      streamSid: 'stream_1',
      media: { payload: 'caller_audio' },
    });

    expect(agent.currentStreamSid).toBe('stream_1');
    expect(realtime.audio).toEqual(['caller_audio']);
    expect(sent).toEqual([]);
  });

  test('sends session.update after Twilio start and realtime session_created', async () => {
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: () => {} },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: ({ start }) => ({
        ...sessionConfig,
        instructions: `Call ${start.start.streamSid}`,
      }),
      realtime,
      allowAIHangup: true,
      connectOnStart: false,
    });

    start(agent);
    realtime.emit('session_created');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(realtime.sessionUpdates).toHaveLength(1);
    expect(realtime.sessionUpdates[0].instructions).toBe('Call stream_1');
    expect(realtime.sessionUpdates[0].audio?.input?.format).toEqual({
      type: 'audio/pcmu',
    });
    expect(realtime.sessionUpdates[0].audio?.input?.turn_detection).toEqual({
      type: 'server_vad',
    });
    expect(realtime.sessionUpdates[0].audio?.output?.format).toEqual({
      type: 'audio/pcmu',
    });
    expect(realtime.sessionUpdates[0].tools?.map((tool) => tool.name)).toEqual([
      'hang_up',
    ]);
  });

  test('sends assistant audio to Twilio and sends final mark on audio_done', () => {
    const sent: string[] = [];
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: (data) => sent.push(String(data)) },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      connectOnStart: false,
    });
    start(agent);

    realtime.emit('audio', 'assistant_audio', 'item_1');
    realtime.emit('audio_done', 'item_1');

    expect(decodeSent(sent)).toEqual([
      {
        event: 'media',
        streamSid: 'stream_1',
        media: { payload: 'assistant_audio' },
      },
      {
        event: 'mark',
        streamSid: 'stream_1',
        mark: { name: 'item:item_1' },
      },
    ]);
  });

  test('emits silence only after Twilio echoes the final item mark and grace elapses', async () => {
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: () => {} },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      silence: { gracePeriodMs: 5 },
      connectOnStart: false,
    });
    const events: unknown[] = [];
    agent.on('silence', (info) => events.push(['silence', info]));
    start(agent);

    realtime.emit('audio', 'assistant_audio', 'item_1');
    realtime.emit('audio_done', 'item_1');
    expect(events).toEqual([]);

    agent.handleTwilioEvent({
      event: 'mark',
      streamSid: 'stream_1',
      mark: { name: 'item:item_1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events).toEqual([['silence', { itemId: 'item_1' }]]);
  });

  test('speech_started interrupts in-flight assistant audio and sends Twilio clear', () => {
    const sent: string[] = [];
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: (data) => sent.push(String(data)) },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      connectOnStart: false,
    });
    start(agent);

    realtime.emit('audio', 'A'.repeat(160), 'item_1');
    realtime.emit('speech_started');

    expect(realtime.interrupts).toHaveLength(1);
    expect(realtime.interrupts[0].itemId).toBe('item_1');
    expect(decodeSent(sent).at(-1)).toEqual({
      event: 'clear',
      streamSid: 'stream_1',
    });
  });

  test('owns AI hangup: tool call waits for mark-backed silence then closes Twilio', async () => {
    const realtime = new TestRealtimeConnection();
    const closed: string[] = [];
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: () => {}, close: () => closed.push('closed') },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      allowAIHangup: { gracePeriodMs: 5, watchdogMs: 100 },
      connectOnStart: false,
    });
    const events: unknown[] = [];
    agent.on('hangup', (ctx) => events.push(['hangup', ctx]));
    agent.on('ended', (ctx) => events.push(['ended', ctx]));
    start(agent);

    realtime.emit('function_call_arguments_done', 'call_1', 'hang_up', '{}');
    expect(realtime.functionOutputs).toEqual([
      { callId: 'call_1', output: 'Say a brief goodbye.' },
    ]);
    realtime.emit('audio', 'bye', 'item_1');
    realtime.emit('audio_done', 'item_1');
    agent.handleTwilioEvent({
      event: 'mark',
      streamSid: 'stream_1',
      mark: { name: 'item:item_1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.resolve();

    expect(closed).toEqual(['closed']);
    expect(events).toEqual([
      ['hangup', { reason: 'ai_hang_up', toolCallId: 'call_1' }],
      ['ended', { reason: 'ai_hang_up' }],
    ]);
  });

  test('AI hangup waits for new goodbye silence even if the session was already silent', async () => {
    const realtime = new TestRealtimeConnection();
    const closed: string[] = [];
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: () => {}, close: () => closed.push('closed') },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      allowAIHangup: { gracePeriodMs: 5, watchdogMs: 100 },
      silence: { gracePeriodMs: 5 },
      connectOnStart: false,
    });
    start(agent);

    realtime.emit('audio', 'hello', 'item_1');
    realtime.emit('audio_done', 'item_1');
    agent.handleTwilioEvent({
      event: 'mark',
      streamSid: 'stream_1',
      mark: { name: 'item:item_1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    realtime.emit('function_call_arguments_done', 'call_1', 'hang_up', '{}');
    realtime.emit('audio', 'bye', 'item_2');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(closed).toEqual([]);

    realtime.emit('audio_done', 'item_2');
    agent.handleTwilioEvent({
      event: 'mark',
      streamSid: 'stream_1',
      mark: { name: 'item:item_2' },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(closed).toEqual(['closed']);
  });

  test('Twilio stop ends the session and cancels pending AI hangup', () => {
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: () => {} },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      allowAIHangup: true,
      connectOnStart: false,
    });
    const events: unknown[] = [];
    agent.on('ended', (ctx) => events.push(ctx));
    start(agent);

    realtime.emit('function_call_arguments_done', 'call_1', 'hang_up', '{}');
    agent.handleTwilioEvent({
      event: 'stop',
      streamSid: 'stream_1',
      stop: {},
    });

    expect(events).toEqual([{ reason: 'twilio_stop' }]);
    expect(realtime.closed).toBe(1);
  });

  test('restores the silence grace period when a pending hangup is cancelled', () => {
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: () => {} },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      silence: { gracePeriodMs: 1500 },
      allowAIHangup: { gracePeriodMs: 5 },
      connectOnStart: false,
    });
    start(agent);

    realtime.emit('function_call_arguments_done', 'call_1', 'hang_up', '{}');
    expect(agent.silence.getGracePeriodMs()).toBe(5);

    agent.handleTwilioEvent({ event: 'stop', streamSid: 'stream_1', stop: {} });
    expect(agent.silence.getGracePeriodMs()).toBe(1500);
  });

  test('malformed Twilio messages emit error instead of throwing', () => {
    const realtime = new TestRealtimeConnection();
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: () => {} },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: sessionConfig,
      realtime,
      connectOnStart: false,
    });
    const errors: unknown[] = [];
    agent.on('error', (err) => errors.push(err));

    expect(() => agent.handleTwilioMessage('{not json')).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  test('fixed greeting streams Twilio-ready audio, seeds history, and deafens until mark echo', async () => {
    const sent: string[] = [];
    const realtime = new TestRealtimeConnection();
    const greetingAudio = Buffer.concat([
      Buffer.alloc(160, 1),
      Buffer.alloc(80, 2),
    ]);
    const agent = new TwilioTurnspikeSession({
      twilioWs: { send: (data) => sent.push(String(data)) },
      provider: { url: 'wss://example.test/realtime', apiKey: 'key' },
      session: { type: 'realtime', instructions: 'Be helpful.' },
      realtime,
      connectOnStart: false,
      fixedGreeting: { text: 'Thanks for calling.', audio: greetingAudio },
    });
    start(agent);
    realtime.emit('session_created');
    await new Promise((resolve) => setTimeout(resolve, 0));

    agent.handleTwilioEvent({
      event: 'media',
      streamSid: 'stream_1',
      media: { payload: 'caller_audio' },
    });

    expect(realtime.audio).toEqual([]);
    expect(realtime.conversationItems).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Thanks for calling.' }],
      },
    ]);
    expect(decodeSent(sent)).toEqual([
      {
        event: 'media',
        streamSid: 'stream_1',
        media: { payload: Buffer.alloc(160, 1).toString('base64') },
      },
      {
        event: 'media',
        streamSid: 'stream_1',
        media: { payload: Buffer.alloc(80, 2).toString('base64') },
      },
      {
        event: 'mark',
        streamSid: 'stream_1',
        mark: { name: 'greeting:30' },
      },
    ]);

    agent.handleTwilioEvent({
      event: 'mark',
      streamSid: 'stream_1',
      mark: { name: 'greeting:30' },
    });
    agent.handleTwilioEvent({
      event: 'media',
      streamSid: 'stream_1',
      media: { payload: 'caller_audio' },
    });

    expect(realtime.audio).toEqual(['caller_audio']);
  });
});
