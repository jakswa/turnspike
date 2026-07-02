import { EventEmitter } from 'node:events';

export interface AssistantSilenceDetectorOptions {
  /** Milliseconds after confirmed assistant playback completion before silence is actionable. */
  gracePeriodMs?: number;
}

export interface AssistantSilenceDetectorEvents {
  silence: [info: { itemId: string }];
  silence_ended: [info: { reason: 'assistant_audio' | 'user_speech' }];
}

type SilenceState =
  | { kind: 'idle' }
  | { kind: 'playing'; itemId: string; doneSending: boolean }
  | { kind: 'pending'; itemId: string; timer: ReturnType<typeof setTimeout> }
  | { kind: 'silent'; itemId: string };

/**
 * Transport-neutral assistant silence state machine.
 *
 * The transport adapter decides when assistant playback is truly complete
 * (Twilio mark echo, browser audio ended, jitter-buffer drain, etc.) and calls
 * `onAssistantPlaybackDone`. This class only decides when that becomes
 * actionable silence and when caller/assistant activity breaks it.
 */
export class AssistantSilenceDetector extends EventEmitter {
  private state: SilenceState = { kind: 'idle' };
  private gracePeriodMs: number;

  constructor(opts: AssistantSilenceDetectorOptions = {}) {
    super();
    this.gracePeriodMs = opts.gracePeriodMs ?? 1500;
  }

  override on<K extends keyof AssistantSilenceDetectorEvents>(
    eventName: K,
    listener: (...args: AssistantSilenceDetectorEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  override once<K extends keyof AssistantSilenceDetectorEvents>(
    eventName: K,
    listener: (...args: AssistantSilenceDetectorEvents[K]) => void,
  ): this {
    return super.once(eventName, listener);
  }

  override off<K extends keyof AssistantSilenceDetectorEvents>(
    eventName: K,
    listener: (...args: AssistantSilenceDetectorEvents[K]) => void,
  ): this {
    return super.off(eventName, listener);
  }

  override emit<K extends keyof AssistantSilenceDetectorEvents>(
    eventName: K,
    ...args: AssistantSilenceDetectorEvents[K]
  ): boolean {
    return super.emit(eventName, ...args);
  }

  setGracePeriodMs(ms: number): void {
    this.gracePeriodMs = ms;
  }

  getGracePeriodMs(): number {
    return this.gracePeriodMs;
  }

  isSilent(): boolean {
    return this.state.kind === 'silent';
  }

  onAssistantAudio(itemId: string): void {
    this.cancelPending('assistant_audio');
    if (this.state.kind === 'playing' && this.state.itemId === itemId) return;
    this.state = { kind: 'playing', itemId, doneSending: false };
  }

  onAssistantAudioDone(itemId: string): void {
    if (this.state.kind === 'playing' && this.state.itemId === itemId) {
      this.state = { ...this.state, doneSending: true };
    }
  }

  onAssistantPlaybackDone(itemId: string): void {
    if (this.state.kind !== 'playing') return;
    if (this.state.itemId !== itemId) return;
    if (!this.state.doneSending) return;

    const timer = setTimeout(() => {
      this.state = { kind: 'silent', itemId };
      this.emit('silence', { itemId });
    }, this.gracePeriodMs);
    if (typeof timer.unref === 'function') timer.unref();

    this.state = { kind: 'pending', itemId, timer };
  }

  onUserSpeechStarted(): void {
    this.cancelPending('user_speech');
  }

  dispose(): void {
    if (this.state.kind === 'pending') clearTimeout(this.state.timer);
    this.state = { kind: 'idle' };
    this.removeAllListeners();
  }

  private cancelPending(reason: 'assistant_audio' | 'user_speech'): void {
    if (this.state.kind === 'pending') {
      clearTimeout(this.state.timer);
      this.state = { kind: 'idle' };
      this.emit('silence_ended', { reason });
    } else if (this.state.kind === 'silent') {
      this.state = { kind: 'idle' };
      this.emit('silence_ended', { reason });
    }
  }
}
