# Friday Voice Bridge v2.0

Voice webhook bridge that connects Home Assistant Assist to Friday (OpenClaw). Say "Hey, Friday" to your HA voice device and talk to your AI assistant.

## Features

- **Two Operating Modes**
  - **Relay Mode** (default): Forwards queries to OpenClaw wake webhook for async processing
  - **Direct Mode**: Calls Claude API directly for faster synchronous responses

- **TTS Providers**
  - ElevenLabs for high-quality voice synthesis
  - Home Assistant Cloud TTS as fallback

- **Conversation Context**
  - Tracks conversation history per device
  - Voice commands to clear context: "clear context", "forget that", "start over"

- **Full API**
  - `/webhook` - Main voice query endpoint
  - `/tts` - Generate audio from text
  - `/speak` - Play text on HA speaker
  - `/context/:deviceId` - Manage conversation context
  - `/health` - Health check with feature status
  - `/config` - Current configuration

## Installation

```bash
cd ~/git/friday-voice
npm install
```

## Configuration

Set environment variables or create a `.env` file:

```bash
# Required for authentication
VOICE_API_KEY=your-secret-key

# OpenClaw (for relay mode)
OPENCLAW_URL=http://localhost:18789
OPENCLAW_HOOK_TOKEN=your-openclaw-token

# Claude API (for direct mode)
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-sonnet-4-20250514

# ElevenLabs (optional, for better TTS)
ELEVENLABS_API_KEY=your-elevenlabs-key
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM  # Rachel (default)
ELEVENLABS_MODEL=eleven_turbo_v2_5

# Home Assistant
HA_URL=http://homeassistant.local:8123
HA_TOKEN=your-long-lived-access-token
HA_MEDIA_PLAYER=media_player.home_assistant_voice_0a480f_media_player
HA_TTS_VOICE=en-AU-NatashaNeural

# Server settings
PORT=18790
VOICE_MODE=relay  # or "direct"
```

## Running

```bash
# Start the server
npm start

# Development mode with auto-reload
npm run dev
```

## Systemd Service

```bash
# Copy the service file
cp friday-voice.service ~/.config/systemd/user/

# Enable and start
systemctl --user daemon-reload
systemctl --user enable friday-voice
systemctl --user start friday-voice

# Check status
systemctl --user status friday-voice
```

## Home Assistant Setup

### 1. Create a Webhook Conversation Agent

In Home Assistant, go to Settings → Voice assistants → Add assistant:

- **Name**: Friday
- **Conversation agent**: Webhook Conversation
- **Webhook URL**: `https://your-domain.com/voice/webhook/YOUR_API_KEY`

### 2. Set Up a Voice Pipeline

Create an Assist pipeline that uses the "Friday" conversation agent:

- **Speech-to-text**: Home Assistant Cloud (or Whisper)
- **Conversation agent**: Friday (webhook)
- **Text-to-speech**: Home Assistant Cloud (the bridge handles TTS responses)

### 3. Wake Word Configuration

If using multiple wake words:
- "Hey, Jarvis" → Default HA assistant
- "Hey, Friday" → Friday conversation agent

## API Examples

### Voice Query (Relay Mode)

```bash
curl -X POST http://localhost:18790/webhook \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What'\''s the weather like?",
    "device_info": {"name": "Office Voice", "id": "office"},
    "mode": "relay"
  }'
```

### Voice Query (Direct Mode)

```bash
curl -X POST http://localhost:18790/webhook \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Tell me a joke",
    "device_info": {"name": "Office Voice", "id": "office"},
    "mode": "direct"
  }'
```

### Generate TTS Audio

```bash
curl -X POST http://localhost:18790/tts \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is Friday speaking!", "provider": "elevenlabs"}' \
  --output speech.mp3
```

### Speak on HA Device

```bash
curl -X POST http://localhost:18790/speak \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "This will play on the Home Assistant speaker"}'
```

### View Conversation Context

```bash
curl http://localhost:18790/context/office \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Clear Conversation Context

```bash
curl -X DELETE http://localhost:18790/context/office \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Architecture

```
┌─────────────────────┐
│  HA Voice Device    │
│  (Wake word: Hey,   │
│   Friday)           │
└──────────┬──────────┘
           │ Speech-to-text
           ▼
┌─────────────────────┐
│  Home Assistant     │
│  Assist Pipeline    │
│  (Webhook Agent)    │
└──────────┬──────────┘
           │ POST /webhook
           ▼
┌─────────────────────┐
│  Friday Voice       │◄──── Relay Mode ────► OpenClaw
│  Bridge             │                        (async)
│                     │◄──── Direct Mode ───► Claude API
└──────────┬──────────┘                        (sync)
           │ TTS
           ▼
┌─────────────────────┐
│  ElevenLabs or      │
│  HA Cloud TTS       │
└──────────┬──────────┘
           │ Audio
           ▼
┌─────────────────────┐
│  HA Voice Device    │
│  (Speaker output)   │
└─────────────────────┘
```

## Troubleshooting

### No response from webhook
- Check that `VOICE_API_KEY` matches in both HA and the bridge
- Verify the bridge is running: `curl http://localhost:18790/health`
- Check logs: `journalctl --user -u friday-voice -f`

### TTS not working
- Ensure `HA_TOKEN` is a valid long-lived access token
- Verify `HA_MEDIA_PLAYER` entity ID is correct
- Test with curl to `/speak` endpoint

### Slow responses in direct mode
- This uses Claude API; response time depends on the model
- Use `claude-3-haiku-20240307` for faster (but less capable) responses

## License

MIT
