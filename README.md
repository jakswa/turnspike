# turnspike

Small TypeScript helper for realtime AI voice-agent turn-taking.

It normalizes the OpenAI Realtime event shape used by OpenAI and xAI Grok into a practical event emitter for apps that need to stream audio, receive transcripts, handle tool calls, interrupt assistant audio, and coordinate clean call endings.

```ts
import { TurnspikeConnection, providers } from 'turnspike';

const conn = new TurnspikeConnection({ id: callSid });

conn.on('audio', (base64, itemId) => sendAudioToCaller(base64, itemId));
conn.on('transcript:user', (text) => console.log('user:', text));
conn.on('function_call_arguments_done', async (callId, name, argsJson) => {
  const result = await runTool(name, JSON.parse(argsJson));
  conn.addFunctionCallOutput(callId, JSON.stringify(result));
});

conn.connect(providers.openai({ apiKey: process.env.OPENAI_API_KEY }));

conn.sendSessionUpdate({
  type: 'realtime',
  model: 'gpt-realtime-1.5',
  output_modalities: ['audio'],
  instructions: 'You are a helpful receptionist.',
  audio: {
    input: {
      format: { type: 'audio/pcmu' },
      turn_detection: { type: 'server_vad', create_response: true },
    },
    output: { format: { type: 'audio/pcmu' }, voice: 'cedar' },
  },
  tools: [
    {
      type: 'function',
      name: 'hang_up',
      description: 'Hang up after saying goodbye.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  ],
});

conn.sendAudio(base64PcmuFromCaller);
```

## Providers

```ts
conn.connect(providers.openai({ apiKey: process.env.OPENAI_API_KEY }));
conn.connect(providers.grok({ apiKey: process.env.XAI_API_KEY }));
```

You can also pass any OpenAI-compatible websocket URL directly:

```ts
conn.connect({ url: 'wss://example.com/v1/realtime?model=...', apiKey });
```

## Events

- `session_created`: websocket opened or upstream session-created event arrived.
- `session_updated`: `session.update` was sent or upstream acknowledged it.
- `audio`: assistant audio delta as base64 plus assistant item id.
- `audio_done`: assistant item finished streaming audio.
- `transcript:user`: completed or cumulative user transcript.
- `transcript:assistant`: completed assistant transcript.
- `speech_started`: caller speech detected by upstream VAD.
- `function_call_arguments_done`: tool call id, name, and JSON argument string.
- `error`: normalized upstream or websocket error.
- `close`: websocket close code and reason.

## Notes

The core connection intentionally does not know about Twilio, databases, call records, or your tool implementations. Your app owns transport-specific audio plumbing and business logic.

## Optional Twilio Session

If you are using Twilio Media Streams, the opt-in session orchestrator can handle the Twilio-specific websocket juggling plus realtime session ordering: provider connect, `session.update`, Twilio/OpenAI PCMU audio defaults, inbound media forwarding, outbound media writes, `clear` on barge-in, final `mark` messages, fixed greeting playback, silence detection after Twilio confirms playback, and optional AI-owned hangup.

```ts
import {
  TwilioTurnspikeSession,
  providers,
} from 'turnspike';

const agent = new TwilioTurnspikeSession({
  twilioWs,
  provider: providers.openai({ apiKey: process.env.OPENAI_API_KEY }),
  session: ({ start }) => ({
    type: 'realtime',
    instructions: `You are a helpful receptionist for call ${start.start.callSid}.`,
    audio: { output: { voice: 'cedar' } },
    tools: [saveMessageTool],
  }),
  fixedGreeting: 'Thanks for calling. How can I help?',
  silence: { gracePeriodMs: 500 },
  allowAIHangup: true,
});

agent.on('tool_call', async ({ callId, name, arguments: argsJson }) => {
  const result = await runTool(name, JSON.parse(argsJson));
  agent.realtime.addFunctionCallOutput(callId, JSON.stringify(result));
});

agent.on('ended', ({ reason }) => console.log('call ended:', reason));

agent.handleTwilioMessage(rawMessage);
```

When `fixedGreeting` is set, the session renders the text to Twilio-ready 8kHz μ-law audio, streams it to Twilio in 20ms frames, sends a final greeting `mark`, and drops inbound caller audio until Twilio echoes that mark. It also inserts the greeting as an assistant conversation item so the realtime model continues with the right context.

When `allowAIHangup` is enabled, the session owns the `hang_up` tool. After the model asks to hang up, the session sends the tool result, waits for the next mark-backed silence window, closes the Twilio websocket, and emits `hangup` / `ended`. If the caller hangs up first, Twilio `stop` ends the session instead. Transfer, persistence, prompts, and custom tool implementations stay in your app.

Start-of-call nuance: Twilio `start` captures `streamSid` and builds the session config before connecting. The orchestrator sends `session.update` only after the realtime provider emits `session_created`, so built-in tools like `hang_up` are present before the model can use them.
