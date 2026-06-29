import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { openaiRealtimeUrl, grokRealtimeUrl } from './providers';
import type {
  OaiConversationItemTruncateEvent,
  OaiServerEvent,
  OaiSessionConfig,
  OaiSessionUpdateEvent,
  RealtimeConnectOptions,
  RealtimeConnectionOptions,
  RealtimeError,
  RealtimeLogger,
  TurnspikeEvents,
} from './types';

const noopLogger: RealtimeLogger = {};

function env(name: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

function resolveConnectOptions(opts?: RealtimeConnectOptions): Required<
  Pick<RealtimeConnectOptions, 'url'>
> & { apiKey?: string; headers?: Record<string, string> } {
  if (opts?.url) return { url: opts.url, apiKey: opts.apiKey, headers: opts.headers };

  if (opts?.provider === 'grok') {
    return {
      url: grokRealtimeUrl(opts.model),
      apiKey: opts.apiKey ?? env('XAI_API_KEY'),
      headers: opts.headers,
    };
  }

  return {
    url: openaiRealtimeUrl(opts?.model),
    apiKey: opts?.apiKey ?? env('OPENAI_API_KEY'),
    headers: opts?.headers,
  };
}

export class TurnspikeConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly id: string;
  private readonly logger: RealtimeLogger;
  private lastAudioItemId: string | null = null;
  private sessionCreatedEmitted = false;
  private sessionUpdatedEmitted = false;

  constructor(opts: string | RealtimeConnectionOptions = {}) {
    super();
    this.id = typeof opts === 'string' ? opts : opts.id ?? '';
    this.logger = typeof opts === 'string' ? noopLogger : opts.logger ?? noopLogger;
  }

  override on<K extends keyof TurnspikeEvents>(
    eventName: K,
    listener: (...args: TurnspikeEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  override once<K extends keyof TurnspikeEvents>(
    eventName: K,
    listener: (...args: TurnspikeEvents[K]) => void,
  ): this {
    return super.once(eventName, listener);
  }

  override off<K extends keyof TurnspikeEvents>(
    eventName: K,
    listener: (...args: TurnspikeEvents[K]) => void,
  ): this {
    return super.off(eventName, listener);
  }

  override emit<K extends keyof TurnspikeEvents>(
    eventName: K,
    ...args: TurnspikeEvents[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }

  connect(opts?: RealtimeConnectOptions): void {
    const { url, apiKey, headers } = resolveConnectOptions(opts);

    if (!apiKey) {
      const message =
        'Realtime API key is missing; pass apiKey or set OPENAI_API_KEY/XAI_API_KEY';
      this.logger.error?.({ id: this.id, url }, message);
      queueMicrotask(() => {
        this.emit('error', {
          type: 'websocket',
          code: 'missing_api_key',
          message,
        });
        this.emit('close', 1011, 'missing_api_key');
      });
      return;
    }

    this.logger.info?.({ id: this.id, url }, 'Connecting to realtime API');

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}`, ...headers },
    });

    this.ws.on('open', () => {
      this.logger.info?.({ id: this.id, url }, 'Realtime WebSocket connected');
      this.emitSessionCreatedOnce();
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const event = JSON.parse(raw.toString()) as OaiServerEvent;
        this.handleEvent(event);
      } catch (err) {
        this.logger.error?.(
          { id: this.id, err },
          'Failed to parse realtime event',
        );
      }
    });

    this.ws.on('error', (err) => {
      this.logger.error?.({ id: this.id, err }, 'Realtime WebSocket error');
      this.emit('error', {
        type: 'websocket',
        code: 'connection_error',
        message: String(err),
      });
    });

    this.ws.on('close', (code, reason) => {
      this.logger.info?.(
        { id: this.id, code, reason: reason.toString() },
        'Realtime WebSocket closed',
      );
      this.emit('close', code, reason.toString());
    });
  }

  sendSessionUpdate(config: OaiSessionConfig): void {
    const update: OaiSessionUpdateEvent = {
      type: 'session.update',
      session: config,
    };
    this.send(update);
    this.emitSessionUpdatedOnce();
  }

  triggerGreeting(): void {
    this.send({ type: 'response.create' });
    this.logger.info?.({ id: this.id }, 'Sent response.create');
  }

  requestResponse(instructions: string): void {
    this.send({ type: 'response.create', response: { instructions } });
    this.logger.info?.(
      { id: this.id },
      'Sent response.create with one-off instructions',
    );
  }

  sendConversationItem(item: Record<string, unknown>): void {
    this.send({ type: 'conversation.item.create', item });
  }

  sendAudio(base64: string): void {
    this.send({
      type: 'input_audio_buffer.append',
      audio: base64,
    });
  }

  interrupt(itemId: string, playedMs: number): void {
    this.logger.debug?.(
      { id: this.id, itemId, playedMs },
      'Truncating assistant audio',
    );
    this.send({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: playedMs,
    } satisfies OaiConversationItemTruncateEvent);
  }

  addFunctionCallOutput(functionCallId: string, output: string): void {
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: functionCallId,
        output,
      },
    });
    this.send({ type: 'response.create' });
  }

  sendRaw(event: unknown): void {
    this.send(event);
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Already closed.
      }
      this.ws = null;
    }
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private emitSessionCreatedOnce(): void {
    if (this.sessionCreatedEmitted) return;
    this.sessionCreatedEmitted = true;
    this.emit('session_created');
  }

  private emitSessionUpdatedOnce(): void {
    if (this.sessionUpdatedEmitted) return;
    this.sessionUpdatedEmitted = true;
    this.emit('session_updated');
  }

  private send(event: unknown): void {
    const eventType = (event as { type?: string }).type ?? 'unknown';
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    } else if (eventType !== 'input_audio_buffer.append') {
      this.logger.warn?.(
        { id: this.id, eventType, readyState: this.ws?.readyState },
        'send() dropped; socket not open',
      );
    }
  }

  private handleEvent(event: OaiServerEvent): void {
    switch (event.type) {
      case 'session.created':
        this.emitSessionCreatedOnce();
        break;

      case 'session.updated':
        this.emitSessionUpdatedOnce();
        break;

      case 'response.output_audio.delta':
        this.lastAudioItemId = event.item_id;
        this.emit('audio', event.delta, event.item_id);
        break;

      case 'input_audio_buffer.speech_started':
        this.emit('speech_started');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript.trim()) {
          this.emit('transcript:user', event.transcript.trim(), event.item_id);
        }
        break;

      case 'response.output_audio.done':
        this.emit('audio_done', event.item_id);
        break;

      case 'response.output_audio_transcript.done':
        if (event.transcript.trim()) {
          this.emit(
            'transcript:assistant',
            event.transcript.trim(),
            event.item_id,
          );
        }
        break;

      case 'error':
        this.logger.error?.(
          { id: this.id, error: event.error },
          'Realtime API error',
        );
        this.emit('error', event.error);
        break;

      case 'response.done':
        this.emitFunctionCalls(event.response.output);
        if (this.lastAudioItemId) {
          this.emit('audio_done', this.lastAudioItemId);
          this.lastAudioItemId = null;
        }
        break;

      default:
        break;
    }
  }

  private emitFunctionCalls(output: unknown[]): void {
    for (const item of output) {
      const outputItem = item as Record<string, unknown>;
      if (
        outputItem.type === 'function_call' &&
        typeof outputItem.call_id === 'string' &&
        typeof outputItem.name === 'string' &&
        typeof outputItem.arguments === 'string'
      ) {
        this.emit(
          'function_call_arguments_done',
          outputItem.call_id,
          outputItem.name,
          outputItem.arguments,
        );
      }
    }
  }
}
