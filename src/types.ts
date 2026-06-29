/**
 * OpenAI Realtime API WebSocket events (GA API), plus compatible xAI Grok events.
 * Only the events consumed by the connection helper are typed here.
 */

export type RealtimeProvider = 'openai' | 'grok';

export interface RealtimeConnectionOptions {
  /** Optional ID included in logs, usually a call/session ID. */
  id?: string;
  logger?: RealtimeLogger;
}

export interface RealtimeLogger {
  debug?(data: Record<string, unknown>, message: string): void;
  info?(data: Record<string, unknown>, message: string): void;
  warn?(data: Record<string, unknown>, message: string): void;
  error?(data: Record<string, unknown>, message: string): void;
}

export interface RealtimeConnectOptions {
  provider?: RealtimeProvider;
  url?: string;
  apiKey?: string;
  model?: string;
  headers?: Record<string, string>;
}

export interface TurnspikeEvents {
  audio: [base64: string, itemId: string];
  audio_done: [itemId: string];
  'transcript:user': [text: string, itemId: string];
  'transcript:assistant': [text: string, itemId: string];
  speech_started: [];
  function_call_arguments_done: [callId: string, name: string, args: string];
  session_created: [];
  session_updated: [];
  error: [error: RealtimeError];
  close: [code: number, reason: string];
}

export interface RealtimeError {
  type: string;
  code: string;
  message: string;
  param?: string | null;
}

// Server events received from OpenAI-compatible realtime APIs.

export interface OaiSessionCreatedEvent {
  type: 'session.created';
  event_id: string;
  session: OaiSessionResource;
}

export interface OaiSessionUpdatedEvent {
  type: 'session.updated';
  event_id: string;
  session: OaiSessionResource;
}

export interface OaiResponseOutputAudioDeltaEvent {
  type: 'response.output_audio.delta';
  event_id: string;
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface OaiResponseOutputAudioDoneEvent {
  type: 'response.output_audio.done';
  event_id: string;
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
}

export interface OaiInputAudioBufferSpeechStartedEvent {
  type: 'input_audio_buffer.speech_started';
  event_id: string;
  audio_start_ms: number;
  item_id: string;
}

export interface OaiInputAudioBufferSpeechStoppedEvent {
  type: 'input_audio_buffer.speech_stopped';
  event_id: string;
  audio_end_ms: number;
  item_id: string;
}

export interface OaiInputAudioTranscriptionCompletedEvent {
  type: 'conversation.item.input_audio_transcription.completed';
  event_id: string;
  item_id: string;
  content_index: number;
  transcript: string;
}

export interface OaiResponseOutputAudioTranscriptDoneEvent {
  type: 'response.output_audio_transcript.done';
  event_id: string;
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  transcript: string;
}

export interface OaiResponseDoneEvent {
  type: 'response.done';
  event_id: string;
  response: {
    id: string;
    status: string;
    output: unknown[];
  };
}

export interface OaiErrorEvent {
  type: 'error';
  event_id: string;
  error: RealtimeError;
}

export interface OaiRateLimitsUpdatedEvent {
  type: 'rate_limits.updated';
  event_id: string;
  rate_limits: Array<{
    name: string;
    limit: number;
    remaining: number;
    reset_seconds: number;
  }>;
}

export type OaiServerEvent =
  | OaiSessionCreatedEvent
  | OaiSessionUpdatedEvent
  | OaiResponseOutputAudioDeltaEvent
  | OaiResponseOutputAudioDoneEvent
  | OaiInputAudioBufferSpeechStartedEvent
  | OaiInputAudioBufferSpeechStoppedEvent
  | OaiInputAudioTranscriptionCompletedEvent
  | OaiResponseOutputAudioTranscriptDoneEvent
  | OaiResponseDoneEvent
  | OaiErrorEvent
  | OaiRateLimitsUpdatedEvent;

// Client events sent to OpenAI-compatible realtime APIs.

export interface OaiSessionUpdateEvent {
  type: 'session.update';
  session: OaiSessionConfig;
}

export interface OaiInputAudioBufferAppendEvent {
  type: 'input_audio_buffer.append';
  audio: string;
}

export interface OaiInputAudioBufferClearEvent {
  type: 'input_audio_buffer.clear';
}

export interface OaiConversationItemTruncateEvent {
  type: 'conversation.item.truncate';
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export interface OaiResponseCreateEvent {
  type: 'response.create';
  response?: { instructions?: string };
}

export interface OaiConversationItemCreateEvent {
  type: 'conversation.item.create';
  item: Record<string, unknown>;
}

export type OaiClientEvent =
  | OaiSessionUpdateEvent
  | OaiInputAudioBufferAppendEvent
  | OaiInputAudioBufferClearEvent
  | OaiConversationItemTruncateEvent
  | OaiResponseCreateEvent
  | OaiConversationItemCreateEvent;

export interface OaiSessionResource {
  id: string;
  model: string;
  [key: string]: unknown;
}

export interface OaiToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OaiAudioFormat {
  type: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma';
  rate?: number;
}

export interface OaiAudioTranscription {
  model?: string;
  language?: string;
  prompt?: string;
}

export interface OaiTurnDetection {
  type: 'server_vad' | 'semantic_vad';
  create_response?: boolean;
  interrupt_response?: boolean;
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  idle_timeout_ms?: number;
  eagerness?: 'low' | 'medium' | 'high' | 'auto';
}

export interface OaiSessionConfig {
  type: 'realtime';
  model?: string;
  output_modalities?: ('audio' | 'text')[];
  audio?: {
    input?: {
      format?: OaiAudioFormat;
      transcription?: OaiAudioTranscription;
      turn_detection?: OaiTurnDetection;
      noise_reduction?: { type: string };
    };
    output?: {
      format?: OaiAudioFormat;
      voice?: string;
      speed?: number;
    };
  };
  instructions?: string;
  tools?: OaiToolDefinition[];
  tool_choice?: string | { type: string; name: string };
  max_output_tokens?: number | 'inf';
}
