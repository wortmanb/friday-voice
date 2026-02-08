/**
 * Friday Voice Bridge v2.0
 * 
 * A voice webhook bridge between Home Assistant Assist and Friday (OpenClaw).
 * 
 * Modes:
 *   - relay (default): Forward to OpenClaw wake webhook, respond async via HA TTS
 *   - direct: Call Claude API directly, return immediate TTS response
 * 
 * TTS Providers:
 *   - elevenlabs: ElevenLabs API (requires ELEVENLABS_API_KEY)
 *   - ha-cloud: Home Assistant Cloud TTS (default fallback)
 */

import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFile, mkdir, unlink } from "fs/promises";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "10mb" }));

// Configuration
const CONFIG = {
  port: parseInt(process.env.PORT || "18790"),
  voiceApiKey: process.env.VOICE_API_KEY,
  
  // OpenClaw (for relay mode)
  openclawUrl: process.env.OPENCLAW_URL || "http://localhost:18789",
  openclawHookToken: process.env.OPENCLAW_HOOK_TOKEN,
  
  // Claude (for direct mode)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514",
  
  // ElevenLabs TTS
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
  elevenlabsVoiceId: process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM", // Rachel
  elevenlabsModel: process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5",
  
  // Home Assistant
  haUrl: process.env.HA_URL || "http://homeassistant.local:8123",
  haToken: process.env.HA_TOKEN,
  haMediaPlayer: process.env.HA_MEDIA_PLAYER || "media_player.home_assistant_voice_0a480f_media_player",
  haTtsVoice: process.env.HA_TTS_VOICE || "en-AU-NatashaNeural",
  
  // Mode settings
  defaultMode: process.env.VOICE_MODE || "relay", // "relay" or "direct"
  audioDir: process.env.AUDIO_DIR || join(__dirname, "..", "audio"),
  maxContextMessages: 10,
};

// Conversation context (in-memory, per device)
const conversationHistory = new Map();

// Request logging
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const dataStr = Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${dataStr}`);
}

// Authenticate request
function authenticate(req) {
  if (!CONFIG.voiceApiKey) return true; // No auth configured
  
  const authHeader = req.headers.authorization;
  const queryKey = req.query.key;
  const pathKey = req.params.key;
  const providedKey = pathKey || queryKey || (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);
  
  return providedKey === CONFIG.voiceApiKey;
}

// Get or create conversation context for a device
function getContext(deviceId) {
  if (!conversationHistory.has(deviceId)) {
    conversationHistory.set(deviceId, []);
  }
  return conversationHistory.get(deviceId);
}

// Add message to conversation context
function addToContext(deviceId, role, content) {
  const context = getContext(deviceId);
  context.push({ role, content });
  
  // Trim to max length
  while (context.length > CONFIG.maxContextMessages) {
    context.shift();
  }
}

// Clear conversation context for a device
function clearContext(deviceId) {
  conversationHistory.delete(deviceId);
}

/**
 * Relay Mode: Forward to OpenClaw wake webhook
 */
async function handleRelayMode(query, deviceName, deviceId) {
  const prompt = `🎤 Voice query from ${deviceName}: "${query}"

Respond via TTS to the HA Voice speaker (${CONFIG.haMediaPlayer}) using ${CONFIG.haTtsVoice} voice.
Keep responses concise and conversational (1-3 sentences).`;

  try {
    const response = await fetch(`${CONFIG.openclawUrl}/hooks/wake`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.openclawHookToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: prompt, mode: "now" }),
    });
    
    if (response.ok) {
      log("info", "Relayed to OpenClaw", { deviceId });
      return { success: true, output: "One moment..." };
    } else {
      log("error", "OpenClaw relay failed", { status: response.status });
      return { success: false, output: "Sorry, I couldn't process that right now." };
    }
  } catch (error) {
    log("error", "OpenClaw relay error", { error: error.message });
    return { success: false, output: "Sorry, I'm having trouble connecting." };
  }
}

/**
 * Direct Mode: Call Claude API and return response immediately
 */
async function handleDirectMode(query, deviceName, deviceId) {
  if (!CONFIG.anthropicApiKey) {
    log("warn", "Direct mode requested but ANTHROPIC_API_KEY not set");
    return handleRelayMode(query, deviceName, deviceId);
  }
  
  const client = new Anthropic({ apiKey: CONFIG.anthropicApiKey });
  const context = getContext(deviceId);
  
  // Build messages array with context
  const messages = [
    ...context,
    { role: "user", content: query }
  ];
  
  try {
    const response = await client.messages.create({
      model: CONFIG.claudeModel,
      max_tokens: 300,
      system: `You are Friday, a witty and helpful AI assistant. You're responding to voice queries through a Home Assistant voice device.
Keep responses concise and conversational (1-3 sentences max).
Be helpful but not overly formal. Light humor is welcome when appropriate.
Current time: ${new Date().toISOString()}
Device: ${deviceName}`,
      messages,
    });
    
    const reply = response.content[0].text;
    
    // Update context
    addToContext(deviceId, "user", query);
    addToContext(deviceId, "assistant", reply);
    
    log("info", "Claude response generated", { 
      deviceId, 
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens 
    });
    
    return { success: true, output: reply };
  } catch (error) {
    log("error", "Claude API error", { error: error.message });
    return { success: false, output: "Sorry, I couldn't process that right now." };
  }
}

/**
 * Generate TTS audio with ElevenLabs
 */
async function generateElevenLabsAudio(text) {
  if (!CONFIG.elevenlabsApiKey) {
    return null;
  }
  
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.elevenlabsVoiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": CONFIG.elevenlabsApiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: CONFIG.elevenlabsModel,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );
    
    if (!response.ok) {
      log("error", "ElevenLabs API error", { status: response.status });
      return null;
    }
    
    const audioBuffer = await response.arrayBuffer();
    return Buffer.from(audioBuffer);
  } catch (error) {
    log("error", "ElevenLabs error", { error: error.message });
    return null;
  }
}

/**
 * Play audio on Home Assistant speaker via media_player.play_media
 */
async function playAudioOnHA(audioUrl) {
  if (!CONFIG.haToken) {
    log("warn", "Cannot play on HA: HA_TOKEN not set");
    return false;
  }
  
  try {
    const response = await fetch(`${CONFIG.haUrl}/api/services/media_player/play_media`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.haToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entity_id: CONFIG.haMediaPlayer,
        media_content_id: audioUrl,
        media_content_type: "music",
      }),
    });
    
    return response.ok;
  } catch (error) {
    log("error", "HA play_media error", { error: error.message });
    return false;
  }
}

/**
 * Speak text via Home Assistant Cloud TTS
 */
async function speakViaHACloud(text) {
  if (!CONFIG.haToken) {
    log("warn", "Cannot speak via HA: HA_TOKEN not set");
    return false;
  }
  
  try {
    const response = await fetch(`${CONFIG.haUrl}/api/services/tts/speak`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${CONFIG.haToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entity_id: "tts.home_assistant_cloud",
        media_player_entity_id: CONFIG.haMediaPlayer,
        message: text,
        options: {
          voice: CONFIG.haTtsVoice,
        },
      }),
    });
    
    return response.ok;
  } catch (error) {
    log("error", "HA Cloud TTS error", { error: error.message });
    return false;
  }
}

// Main webhook endpoint
app.post(["/webhook", "/webhook/:key", "/voice/webhook", "/voice/webhook/:key"], async (req, res) => {
  const startTime = Date.now();
  
  // Authenticate
  if (!authenticate(req)) {
    log("warn", "Unauthorized request", { ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const { query, device_info, conversation_id, mode: requestMode } = req.body;
  const deviceName = device_info?.name || "Voice";
  const deviceId = conversation_id || device_info?.id || "default";
  const mode = requestMode || CONFIG.defaultMode;
  
  if (!query?.trim()) {
    return res.status(400).json({ error: "Missing query" });
  }
  
  log("info", "Voice request", { query, deviceName, deviceId, mode });
  
  // Handle special commands
  const lowerQuery = query.toLowerCase().trim();
  if (lowerQuery === "clear context" || lowerQuery === "forget that" || lowerQuery === "start over") {
    clearContext(deviceId);
    log("info", "Context cleared", { deviceId });
    return res.json({ output: "Conversation cleared. What would you like to talk about?" });
  }
  
  // Process based on mode
  let result;
  if (mode === "direct") {
    result = await handleDirectMode(query, deviceName, deviceId);
  } else {
    result = await handleRelayMode(query, deviceName, deviceId);
  }
  
  log("info", "Request completed", { 
    duration: Date.now() - startTime,
    mode,
    success: result.success 
  });
  
  res.json({ output: result.output });
});

// TTS endpoint - generate audio from text
app.post("/tts", async (req, res) => {
  if (!authenticate(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const { text, provider = "elevenlabs" } = req.body;
  
  if (!text?.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }
  
  if (provider === "elevenlabs") {
    const audio = await generateElevenLabsAudio(text);
    if (audio) {
      res.set("Content-Type", "audio/mpeg");
      return res.send(audio);
    }
  }
  
  // Fallback: trigger HA Cloud TTS
  const spoke = await speakViaHACloud(text);
  res.json({ success: spoke, provider: "ha-cloud" });
});

// Speak endpoint - directly play on HA speaker
app.post("/speak", async (req, res) => {
  if (!authenticate(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const { text, provider = "ha-cloud" } = req.body;
  
  if (!text?.trim()) {
    return res.status(400).json({ error: "Missing text" });
  }
  
  log("info", "Speak request", { text: text.substring(0, 50) + "...", provider });
  
  if (provider === "elevenlabs" && CONFIG.elevenlabsApiKey) {
    // Generate audio, save to temp file, serve and play
    const audio = await generateElevenLabsAudio(text);
    if (audio) {
      await mkdir(CONFIG.audioDir, { recursive: true });
      const filename = `tts-${Date.now()}.mp3`;
      const filepath = join(CONFIG.audioDir, filename);
      await writeFile(filepath, audio);
      
      // Serve audio file
      const audioUrl = `http://localhost:${CONFIG.port}/audio/${filename}`;
      const played = await playAudioOnHA(audioUrl);
      
      // Clean up after 30 seconds
      setTimeout(() => unlink(filepath).catch(() => {}), 30000);
      
      return res.json({ success: played, provider: "elevenlabs", audioUrl });
    }
  }
  
  // Fallback to HA Cloud TTS
  const spoke = await speakViaHACloud(text);
  res.json({ success: spoke, provider: "ha-cloud" });
});

// Serve generated audio files
app.use("/audio", express.static(CONFIG.audioDir));

// Context management endpoints
app.get("/context/:deviceId", (req, res) => {
  if (!authenticate(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  const context = getContext(req.params.deviceId);
  res.json({ deviceId: req.params.deviceId, messages: context });
});

app.delete("/context/:deviceId", (req, res) => {
  if (!authenticate(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  clearContext(req.params.deviceId);
  res.json({ success: true, deviceId: req.params.deviceId });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    service: "friday-voice",
    version: "2.0.0",
    mode: CONFIG.defaultMode,
    features: {
      elevenlabs: !!CONFIG.elevenlabsApiKey,
      directMode: !!CONFIG.anthropicApiKey,
      haIntegration: !!CONFIG.haToken,
    },
    activeContexts: conversationHistory.size,
  });
});

// Config endpoint (non-sensitive)
app.get("/config", (req, res) => {
  if (!authenticate(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  res.json({
    mode: CONFIG.defaultMode,
    claudeModel: CONFIG.claudeModel,
    elevenlabsVoiceId: CONFIG.elevenlabsVoiceId,
    elevenlabsModel: CONFIG.elevenlabsModel,
    haMediaPlayer: CONFIG.haMediaPlayer,
    haTtsVoice: CONFIG.haTtsVoice,
    maxContextMessages: CONFIG.maxContextMessages,
  });
});

// Start server
app.listen(CONFIG.port, () => {
  log("info", "Friday Voice Bridge v2.0 started", {
    port: CONFIG.port,
    mode: CONFIG.defaultMode,
    features: {
      elevenlabs: !!CONFIG.elevenlabsApiKey,
      directMode: !!CONFIG.anthropicApiKey,
      haIntegration: !!CONFIG.haToken,
    },
  });
  console.log(`🎤 Friday Voice Bridge v2.0`);
  console.log(`   Webhook:  http://localhost:${CONFIG.port}/webhook`);
  console.log(`   Health:   http://localhost:${CONFIG.port}/health`);
  console.log(`   Mode:     ${CONFIG.defaultMode}`);
  if (CONFIG.anthropicApiKey) console.log(`   Direct:   ✓ Claude API configured`);
  if (CONFIG.elevenlabsApiKey) console.log(`   TTS:      ✓ ElevenLabs configured`);
  if (CONFIG.haToken) console.log(`   HA:       ✓ Home Assistant configured`);
});
