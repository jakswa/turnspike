import { EventEmitter } from 'node:events';
import { TurnspikeConnection } from './connection';
import { AssistantSilenceDetector } from './silence';
import { renderGreetingPcmu } from './tts';
import type {
  OaiSessionConfig,
  OaiToolDefinition,
  RealtimeConnectOptions,
} from './types';

export interface TwilioWsLike {
  send(data: string | object): void;
  close?(): void;
}

export interface TwilioConnectedEvent {
  event: 'connected';
  protocol?: string;
  version?: string;
}

export interface TwilioStartEvent {
  event: 'start';
  streamSid: string;
  sequenceNumber?: string;
  start: {
    streamSid: string;
    accountSid?: string;
    callSid?: string;
    tracks?: string[];
    mediaFormat?: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
    customParameters?: Record<string, string>;
  };
}

export interface TwilioMediaEvent {
  event: 'media';
  streamSid: string;
  sequenceNumber?: string;
  media: {
    track?: 'inbound' | 'outbound';
    chunk?: string;
    timestamp?: string;
    payload: string;
  };
}

export interface TwilioMarkEvent {
  event: 'mark';
  streamSid: string;
  sequenceNumber?: string;
  mark: { name: string };
}

export interface TwilioStopEvent {
  event: 'stop';
  streamSid: string;
  sequenceNumber?: string;
  stop?: { accountSid?: string; callSid?: string };
}

export type TwilioStreamEvent =
  | TwilioConnectedEvent
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioMarkEvent
  | TwilioStopEvent;

export interface TwilioOutboundMedia {
  event: 'media';
  streamSid: string;
  media: { payload: string };
}

export interface TwilioOutboundMark {
  event: 'mark';
  streamSid: string;
  mark: { name: string };
}

export interface TwilioOutboundClear {
  event: 'clear';
  streamSid: string;
}

export type TwilioOutboundEvent =
  | TwilioOutboundMedia
  | TwilioOutboundMark
  | TwilioOutboundClear;

export type FixedGreetingAudio =
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | Promise<Buffer | Uint8Array | ArrayBuffer>;

export interface FixedGreetingOptions {
  text: string;
  voice?: string;
  audio?: FixedGreetingAudio;
  openaiModel?: string;
}

export interface TwilioTurnspikeSessionOptions {
  twilioWs: TwilioWsLike;
  provider: RealtimeConnectOptions;
  session:
    | OaiSessionConfig
    | ((ctx: { start: TwilioStartEvent }) => OaiSessionConfig | Promise<OaiSessionConfig>);
  realtime?: TurnspikeConnection;
  silence?: AssistantSilenceDetector | { gracePeriodMs?: number };
  allowAIHangup?: boolean | AIHangupOptions;
  fixedGreeting?: string | FixedGreetingOptions;
  clearOnUserSpeech?: boolean;
  connectOnStart?: boolean;
  markPrefix?: string;
}

export interface AIHangupOptions {
  toolName?: string;
  gracePeriodMs?: number;
  watchdogMs?: number;
  toolOutput?: string;
  cancelOnUserSpeech?: boolean;
}

export interface TwilioTurnspikeSessionEvents {
  start: [event: TwilioStartEvent];
  stop: [event: TwilioStopEvent];
  mark: [event: TwilioMarkEvent];
  clear: [];
  playback_done: [info: { itemId: string }];
  silence: [info: { itemId: string }];
  silence_ended: [info: { reason: 'assistant_audio' | 'user_speech' }];
  fixed_greeting_started: [
    info: { text: string; markName: string; durationMs: number },
  ];
  fixed_greeting_done: [info: { text: string; markName: string }];
  session_update_sent: [config: OaiSessionConfig];
  tool_call: [call: { callId: string; name: string; arguments: string }];
  ai_hangup_requested: [call: { callId: string; name: string; arguments: string }];
  hangup: [ctx: { reason: 'ai_hang_up'; toolCallId: string }];
  ended: [ctx: { reason: 'ai_hang_up' | 'twilio_stop' | 'realtime_close' | 'disposed' }];
  error: [error: unknown];
}

const PCMU_BYTES_PER_MS = 8;

export const HANG_UP_TOOL: OaiToolDefinition = {
  type: 'function',
  name: 'hang_up',
  description:
    'Hang up the call after saying goodbye. Call this in the same turn as your goodbye; the line drops once you finish speaking.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * High-level Twilio Media Streams + realtime AI voice session.
 *
 * It owns the provider/session ordering, Twilio media/mark plumbing, barge-in,
 * mark-backed silence detection, and optional `hang_up` tool handling. Your app
 * still owns prompts, custom tools, persistence, and external call records.
 */
export class TwilioTurnspikeSession extends EventEmitter {
  readonly realtime: TurnspikeConnection;
  readonly silence: AssistantSilenceDetector;
  private readonly twilioWs: TwilioWsLike;
  private readonly provider: RealtimeConnectOptions;
  private readonly sessionInput: TwilioTurnspikeSessionOptions['session'];
  private readonly fixedGreeting: FixedGreetingOptions | null;
  private readonly clearOnUserSpeech: boolean;
  private readonly connectOnStart: boolean;
  private readonly markPrefix: string;
  private readonly hangup: Required<AIHangupOptions> | null;
  private streamSid: string | null = null;
  private startEvent: TwilioStartEvent | null = null;
  private sessionConfigPromise: Promise<OaiSessionConfig> | null = null;
  private greetingAudioPromise: Promise<Buffer> | null = null;
  private greetingDeafened = false;
  private greetingFinalMarkName: string | null = null;
  private sessionUpdateSent = false;
  private lastAssistantItemId: string | null = null;
  private itemAudioSentMs = new Map<string, number>();
  private itemAudioStartedAt = new Map<string, number>();
  private pendingHangupCallId: string | null = null;
  private hangupTimer: ReturnType<typeof setTimeout> | null = null;
  private hangupSilenceListener: (() => void) | null = null;
  private ended = false;

  constructor(opts: TwilioTurnspikeSessionOptions) {
    super();
    this.twilioWs = opts.twilioWs;
    this.provider = opts.provider;
    this.sessionInput = opts.session;
    this.realtime = opts.realtime ?? new TurnspikeConnection();
    this.fixedGreeting = this.normalizeFixedGreeting(opts.fixedGreeting);
    this.clearOnUserSpeech = opts.clearOnUserSpeech ?? true;
    this.connectOnStart = opts.connectOnStart ?? true;
    this.markPrefix = opts.markPrefix ?? 'item:';
    this.silence =
      opts.silence instanceof AssistantSilenceDetector
        ? opts.silence
        : new AssistantSilenceDetector(opts.silence);
    this.hangup = this.normalizeHangupOptions(opts.allowAIHangup);

    this.bindRealtime();
    this.bindSilence();
  }

  override on<K extends keyof TwilioTurnspikeSessionEvents>(
    eventName: K,
    listener: (...args: TwilioTurnspikeSessionEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  override once<K extends keyof TwilioTurnspikeSessionEvents>(
    eventName: K,
    listener: (...args: TwilioTurnspikeSessionEvents[K]) => void,
  ): this {
    return super.once(eventName, listener);
  }

  override off<K extends keyof TwilioTurnspikeSessionEvents>(
    eventName: K,
    listener: (...args: TwilioTurnspikeSessionEvents[K]) => void,
  ): this {
    return super.off(eventName, listener);
  }

  override emit<K extends keyof TwilioTurnspikeSessionEvents>(
    eventName: K,
    ...args: TwilioTurnspikeSessionEvents[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }

  get currentStreamSid(): string | null {
    return this.streamSid;
  }

  handleTwilioMessage(raw: string | Buffer | TwilioStreamEvent): void {
    const event =
      typeof raw === 'string' || Buffer.isBuffer(raw)
        ? (JSON.parse(raw.toString()) as TwilioStreamEvent)
        : raw;
    this.handleTwilioEvent(event);
  }

  handleTwilioEvent(event: TwilioStreamEvent): void {
    switch (event.event) {
      case 'connected':
        break;

      case 'start':
        this.startEvent = event;
        this.streamSid = event.streamSid || event.start.streamSid;
        this.sessionConfigPromise = this.buildSessionConfig(event);
        this.emit('start', event);
        if (this.connectOnStart) this.realtime.connect(this.provider);
        break;

      case 'media':
        if (this.greetingDeafened) return;
        this.realtime.sendAudio(event.media.payload);
        break;

      case 'mark':
        this.emit('mark', event);
        if (
          this.greetingFinalMarkName &&
          event.mark.name === this.greetingFinalMarkName
        ) {
          const markName = event.mark.name;
          const text = this.fixedGreeting?.text ?? '';
          this.greetingDeafened = false;
          this.greetingFinalMarkName = null;
          this.emit('fixed_greeting_done', { text, markName });
          break;
        }
        if (event.mark.name.startsWith(this.markPrefix)) {
          const itemId = event.mark.name.slice(this.markPrefix.length);
          this.silence.onAssistantPlaybackDone(itemId);
          this.emit('playback_done', { itemId });
        }
        break;

      case 'stop':
        this.emit('stop', event);
        this.cancelPendingHangup('call stopped');
        this.endOnce('twilio_stop');
        break;
    }
  }

  connect(): void {
    this.realtime.connect(this.provider);
  }

  sendClear(): void {
    if (!this.streamSid) return;
    this.sendToTwilio({ event: 'clear', streamSid: this.streamSid });
    this.emit('clear');
  }

  closeTwilio(): void {
    this.twilioWs.close?.();
  }

  dispose(): void {
    this.cancelPendingHangup('disposed');
    this.silence.dispose();
    this.realtime.close();
    this.endOnce('disposed');
    this.removeAllListeners();
  }

  private bindRealtime(): void {
    this.realtime.on('session_created', () => {
      this.sendSessionUpdate().catch((err) => this.emit('error', err));
    });

    this.realtime.on('audio', (base64, itemId) => {
      this.lastAssistantItemId = itemId;
      if (!this.streamSid) return;

      this.sendToTwilio({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: base64 },
      });

      const audioBytes = Math.floor((base64.length * 3) / 4);
      const deltaMs = Math.floor(audioBytes / PCMU_BYTES_PER_MS);
      this.itemAudioSentMs.set(
        itemId,
        (this.itemAudioSentMs.get(itemId) ?? 0) + deltaMs,
      );
      if (!this.itemAudioStartedAt.has(itemId)) {
        this.itemAudioStartedAt.set(itemId, Date.now());
      }
      this.silence.onAssistantAudio(itemId);
    });

    this.realtime.on('audio_done', (itemId) => {
      this.lastAssistantItemId = null;
      this.silence.onAssistantAudioDone(itemId);
      if (this.streamSid) {
        this.sendToTwilio({
          event: 'mark',
          streamSid: this.streamSid,
          mark: { name: `${this.markPrefix}${itemId}` },
        });
      }
      this.itemAudioSentMs.delete(itemId);
      this.itemAudioStartedAt.delete(itemId);
    });

    this.realtime.on('speech_started', () => {
      if (this.greetingDeafened) return;
      this.silence.onUserSpeechStarted();
      const itemId = this.lastAssistantItemId;
      if (itemId) {
        const startedAt = this.itemAudioStartedAt.get(itemId);
        const sentMs = this.itemAudioSentMs.get(itemId) ?? 0;
        if (startedAt != null) {
          const playedMs = Math.max(
            0,
            Math.min(Date.now() - startedAt - 100, sentMs),
          );
          this.realtime.interrupt(itemId, playedMs);
        }
      }
      if (this.clearOnUserSpeech) this.sendClear();
    });

    this.realtime.on('function_call_arguments_done', (callId, name, args) => {
      if (this.hangup && name === this.hangup.toolName) {
        this.handleAIHangup(callId, name, args);
        return;
      }
      this.emit('tool_call', { callId, name, arguments: args });
    });

    this.realtime.on('error', (error) => this.emit('error', error));
    this.realtime.on('close', () => {
      this.cancelPendingHangup('realtime closed');
      this.endOnce('realtime_close');
    });
  }

  private bindSilence(): void {
    this.silence.on('silence', (info) => this.emit('silence', info));
    this.silence.on('silence_ended', (info) => {
      if (
        this.pendingHangupCallId &&
        this.hangup?.cancelOnUserSpeech &&
        info.reason === 'user_speech'
      ) {
        this.cancelPendingHangup('caller spoke');
      }
      this.emit('silence_ended', info);
    });
  }

  private async buildSessionConfig(start: TwilioStartEvent): Promise<OaiSessionConfig> {
    const base =
      typeof this.sessionInput === 'function'
        ? await this.sessionInput({ start })
        : this.sessionInput;
    const config = this.withBuiltInTools(this.withTwilioAudioDefaults(base));
    this.prerenderFixedGreeting(config);
    return config;
  }

  private async sendSessionUpdate(): Promise<void> {
    if (this.sessionUpdateSent) return;
    if (!this.sessionConfigPromise) {
      if (!this.startEvent) throw new Error('Cannot send session.update before Twilio start');
      this.sessionConfigPromise = this.buildSessionConfig(this.startEvent);
    }
    const config = await this.sessionConfigPromise;
    this.realtime.sendSessionUpdate(config);
    this.sessionUpdateSent = true;
    this.emit('session_update_sent', config);
    this.startFixedGreeting().catch((err) => this.emit('error', err));
  }

  private withTwilioAudioDefaults(config: OaiSessionConfig): OaiSessionConfig {
    return {
      ...config,
      output_modalities: config.output_modalities ?? ['audio'],
      audio: {
        ...config.audio,
        input: {
          ...config.audio?.input,
          format: config.audio?.input?.format ?? { type: 'audio/pcmu' },
          turn_detection: config.audio?.input?.turn_detection ?? {
            type: 'server_vad',
          },
        },
        output: {
          ...config.audio?.output,
          format: config.audio?.output?.format ?? { type: 'audio/pcmu' },
          voice: config.audio?.output?.voice ?? this.defaultGreetingVoice(),
        },
      },
    };
  }

  private withBuiltInTools(config: OaiSessionConfig): OaiSessionConfig {
    if (!this.hangup) return config;
    const tools = config.tools ?? [];
    if (tools.some((tool) => tool.name === this.hangup?.toolName)) return config;
    return { ...config, tools: [...tools, { ...HANG_UP_TOOL, name: this.hangup.toolName }] };
  }

  private handleAIHangup(callId: string, name: string, args: string): void {
    if (!this.hangup) return;
    if (this.pendingHangupCallId) {
      this.realtime.addFunctionCallOutput(callId, 'Already hanging up.');
      return;
    }

    this.pendingHangupCallId = callId;
    this.silence.setGracePeriodMs(this.hangup.gracePeriodMs);
    this.emit('ai_hangup_requested', { callId, name, arguments: args });

    const perform = () => this.performHangup(callId);
    this.hangupSilenceListener = perform;
    this.silence.once('silence', perform);
    this.hangupTimer = setTimeout(perform, this.hangup.watchdogMs);
    if (typeof this.hangupTimer.unref === 'function') this.hangupTimer.unref();

    this.realtime.addFunctionCallOutput(callId, this.hangup.toolOutput);
  }

  private normalizeFixedGreeting(
    input: TwilioTurnspikeSessionOptions['fixedGreeting'],
  ): FixedGreetingOptions | null {
    if (!input) return null;
    const greeting =
      typeof input === 'string'
        ? { text: input.trim() }
        : { ...input, text: input.text.trim() };
    return greeting.text ? greeting : null;
  }

  private prerenderFixedGreeting(config: OaiSessionConfig): void {
    const greeting = this.fixedGreeting;
    if (!greeting || this.greetingAudioPromise) return;
    if (!greeting.text) return;
    const voice =
      greeting.voice ?? config.audio?.output?.voice ?? this.defaultGreetingVoice();
    this.greetingAudioPromise = Promise.resolve(
      greeting.audio ??
        renderGreetingPcmu({
          text: greeting.text,
          voice,
          provider: this.provider,
          openaiModel: greeting.openaiModel,
        }),
    ).then((audio) => this.toBuffer(audio));
    this.greetingAudioPromise.catch(() => {});
  }

  private toBuffer(audio: Buffer | Uint8Array | ArrayBuffer): Buffer {
    if (Buffer.isBuffer(audio)) return audio;
    if (audio instanceof ArrayBuffer) return Buffer.from(new Uint8Array(audio));
    return Buffer.from(audio);
  }

  private async startFixedGreeting(): Promise<void> {
    const greeting = this.fixedGreeting;
    if (!greeting) return;
    if (!this.streamSid) {
      throw new Error('Cannot play fixed greeting before Twilio start');
    }
    if (!this.greetingAudioPromise) {
      throw new Error('fixed greeting audio was not rendered');
    }

    this.greetingDeafened = true;
    let pcmu: Buffer;
    try {
      pcmu = await this.greetingAudioPromise;
    } catch (err) {
      this.greetingDeafened = false;
      this.greetingFinalMarkName = null;
      throw err;
    }
    this.realtime.sendConversationItem({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: greeting.text }],
    });

    const chunkBytes = 160;
    let cumulativeMs = 0;
    for (let i = 0; i < pcmu.length; i += chunkBytes) {
      const slice = pcmu.subarray(i, i + chunkBytes);
      this.sendToTwilio({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: slice.toString('base64') },
      });
      cumulativeMs += Math.floor(slice.length / PCMU_BYTES_PER_MS);
    }

    const markName = `greeting:${cumulativeMs}`;
    this.greetingFinalMarkName = markName;
    this.sendToTwilio({
      event: 'mark',
      streamSid: this.streamSid,
      mark: { name: markName },
    });
    this.emit('fixed_greeting_started', {
      text: greeting.text,
      markName,
      durationMs: cumulativeMs,
    });
  }

  private defaultGreetingVoice(): string {
    if (this.provider.provider === 'grok') return 'ara';
    if (this.provider.url?.includes('api.x.ai')) return 'ara';
    return 'alloy';
  }

  private performHangup(toolCallId: string): void {
    if (this.pendingHangupCallId !== toolCallId) return;
    this.cancelPendingHangup('hangup performed', false);
    const ctx = { reason: 'ai_hang_up' as const, toolCallId };
    this.emit('hangup', ctx);
    this.closeTwilio();
    this.endOnce('ai_hang_up');
  }

  private cancelPendingHangup(_reason: string, clearCallId = true): void {
    if (this.hangupTimer) {
      clearTimeout(this.hangupTimer);
      this.hangupTimer = null;
    }
    if (this.hangupSilenceListener) {
      this.silence.off('silence', this.hangupSilenceListener);
      this.hangupSilenceListener = null;
    }
    if (clearCallId) this.pendingHangupCallId = null;
  }

  private endOnce(reason: 'ai_hang_up' | 'twilio_stop' | 'realtime_close' | 'disposed'): void {
    if (this.ended) return;
    this.ended = true;
    this.emit('ended', { reason });
  }

  private normalizeHangupOptions(
    opts: TwilioTurnspikeSessionOptions['allowAIHangup'],
  ): Required<AIHangupOptions> | null {
    if (!opts) return null;
    const input = opts === true ? {} : opts;
    return {
      toolName: input.toolName ?? 'hang_up',
      gracePeriodMs: input.gracePeriodMs ?? 500,
      watchdogMs: input.watchdogMs ?? 15_000,
      toolOutput: input.toolOutput ?? 'Say a brief goodbye.',
      cancelOnUserSpeech: input.cancelOnUserSpeech ?? true,
    };
  }

  private sendToTwilio(event: TwilioOutboundEvent): void {
    this.twilioWs.send(JSON.stringify(event));
  }
}
