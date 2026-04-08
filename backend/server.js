import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { exec } from "child_process";

dotenv.config();

console.log("SERVER STARTED");
console.log("ElevenLabs key loaded:", !!process.env.ELEVENLABS_API_KEY);

if (!process.env.ELEVENLABS_API_KEY) {
  throw new Error("ELEVENLABS_API_KEY missing");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));

let currentVoiceId = null;

/** ElevenLabs voice cloning fails on oversized / long samples; keep under this (seconds). */
const MAX_VOICE_SAMPLE_SECONDS = 120;

const RECORDING_TOO_LONG_MESSAGE =
  "Your recording is longer than 2 minutes. The voice cloning service cannot process it. Please record again and submit a sample under 2 minutes.";

// Multer
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({ storage });

/** All JSON APIs under /api so POST routes are never shadowed by express.static */
const api = express.Router();

// Upload endpoint
api.post("/upload", upload.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  console.log("Uploaded:", req.file.filename);
  res.json({ success: true });
});

// --------------------
// Convert WebM → WAV
// --------------------

function convertWebMToWav(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath.replace(".webm", ".wav");

    const cmd = `ffmpeg -y -i "${inputPath}" -ac 1 -ar 44100 "${outputPath}"`;

    exec(cmd, (error) => {
      if (error) reject(error);
      else resolve(outputPath);
    });
  });
}

function getWavDurationSec(wavPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${wavPath}"`;
    exec(cmd, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const sec = parseFloat(String(stdout).trim(), 10);
      if (!Number.isFinite(sec) || sec < 0) {
        reject(new Error("Could not read audio duration"));
        return;
      }
      resolve(sec);
    });
  });
}

function isElevenLabsSampleTooLargeError(status, responseText) {
  if (status === 413) return true;
  const t = String(responseText || "").toLowerCase();
  if (!t) return false;
  if (t.includes("file too large") || t.includes("payload too large")) return true;
  if (t.includes("too long") && (t.includes("sample") || t.includes("audio") || t.includes("file")))
    return true;
  if (t.includes("maximum") && (t.includes("size") || t.includes("length") || t.includes("duration")))
    return true;
  if (t.includes("exceed") && (t.includes("limit") || t.includes("size") || t.includes("length")))
    return true;
  return false;
}

// --------------------
// ElevenLabs helpers
// --------------------

function getLatestRecording() {
  const files = fs.readdirSync(uploadsDir);
  if (!files.length) return null;

  return path.join(
    uploadsDir,
    files.sort(
      (a, b) =>
        fs.statSync(path.join(uploadsDir, b)).mtime -
        fs.statSync(path.join(uploadsDir, a)).mtime
    )[0]
  );
}

async function cloneVoice(filePath) {
  const buffer = fs.readFileSync(filePath);

  const form = new FormData();
  form.append("name", "Temporary Scam Simulation Voice");

  form.append(
    "files",
    new Blob([buffer], { type: "audio/wav" }),
    path.basename(filePath)
  );

  const response = await fetch(
    "https://api.elevenlabs.io/v1/voices/add",
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY
      },
      body: form
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error("Clone failed:", text);
    const err = new Error("Voice clone failed");
    err.detail = text;
    if (isElevenLabsSampleTooLargeError(response.status, text)) {
      err.code = "RECORDING_TOO_LONG";
    }
    throw err;
  }

  const data = JSON.parse(text);
  return data.voice_id;
}

const SCRIPT = `
Hey Mom… it’s me... I’m really sorry...uhm...to call like this, but something’s gone wrong with my university payment and they’ve frozen my account!
<break time="2s"/>
They said if the tuition isn’t cleared today I could lose my enrollment for the term.
<break time="2s"/>
Can you please just help me sort this out quickly? I’ll explain everything properly later. Byee love you!
`;

// Same TTS pipeline as SCRIPT; use plain ASCII punctuation for API compatibility.
const PARENT_SCAM_SCRIPT = `Hey Mom… it’s me.
<break time="2s"/>
I know this is a bit sudden, but I’m in the middle of sorting out my university tuition and something’s gone wrong with the payment system!
<break time="2s"/>
They’ve locked my student account and I can’t access my portal or bank anymore.
<break time="1s"/>
The university said they’re going to send you a message... with a payment link or something so the fees can be cleared quickly.
<break time="2s"/>
Could you pleaseee take a look at it when it comes and approve it? I really don’t want this to delay anything!
<break time="2s"/>
I can’t stay on the call for long because I’m speaking with the university support team, but I’ll call you properly and explain everything later!
<break time="3s"/>
Thanks Mom… I really appreciate it.`;

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

/**
 * Same ElevenLabs TTS pipeline for every output file: randomised speed, stability,
 * similarity_boost, and style on each call (short scam, regenerate, or parent script).
 */
async function generateScamAudioToFile(voiceId, text, outFilename) {
  const speed = Number(randomInRange(1.07, 1.17).toFixed(2));
  const stability = Number(randomInRange(0.30, 0.50).toFixed(2));
  const similarityBoost = Number(randomInRange(0.75, 0.90).toFixed(2));
  const styleExaggeration = Number(randomInRange(0.15, 0.30).toFixed(2));

  console.log("Voice settings (same randomisation for all scripts) →", {
    speed,
    stability,
    similarity_boost: similarityBoost,
    style: styleExaggeration,
    outFilename
  });

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability,
          similarity_boost: similarityBoost,
          style: styleExaggeration,
          use_speaker_boost: true,
          speed
        }
      })
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error("TTS error:", errText);
    const err = new Error("TTS failed");
    err.detail = errText;
    throw err;
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const outPath = path.join(__dirname, outFilename);
  fs.writeFileSync(outPath, buffer);
}

async function generateScamAudio(voiceId) {
  await generateScamAudioToFile(voiceId, SCRIPT, "generated_scam_call.mp3");
}

// --------------------
// First simulation
// --------------------

api.post("/simulate-scam", async (req, res) => {
  try {
    const latest = getLatestRecording();

    if (!latest) {
      return res.status(400).json({ error: "No recording found" });
    }

    console.log("Latest recording:", latest);

    const wavPath = await convertWebMToWav(latest);
    console.log("Converted to WAV:", wavPath);

    let durationSec = null;
    try {
      durationSec = await getWavDurationSec(wavPath);
      console.log("WAV duration (s):", durationSec);
    } catch (probeErr) {
      console.warn("ffprobe duration failed:", probeErr?.message || probeErr);
    }
    if (
      durationSec !== null &&
      durationSec > MAX_VOICE_SAMPLE_SECONDS
    ) {
      return res.status(400).json({
        error: RECORDING_TOO_LONG_MESSAGE,
        code: "RECORDING_TOO_LONG",
      });
    }

    currentVoiceId = await cloneVoice(wavPath);
    console.log("Voice cloned:", currentVoiceId);

    await generateScamAudio(currentVoiceId);

    res.json({
      success: true,
      audio: "/generated_scam_call.mp3"
    });

  } catch (err) {
    console.error("Simulation error:", err);
    if (err.code === "RECORDING_TOO_LONG") {
      return res.status(400).json({
        error: RECORDING_TOO_LONG_MESSAGE,
        code: "RECORDING_TOO_LONG",
      });
    }
    res.status(500).json({ error: "Simulation failed" });
  }
});

// --------------------
// Try again (same voice)
// --------------------

api.post("/generate-again", async (req, res) => {
  try {

    if (!currentVoiceId) {
      return res.status(400).json({
        error: "No voice clone available"
      });
    }

    console.log("Regenerating with voice:", currentVoiceId);

    await generateScamAudio(currentVoiceId);

    res.json({
      success: true,
      audio: "/generated_scam_call.mp3"
    });

  } catch (err) {
    console.error("Generate again error:", err);
    res.status(500).json({
      error: "Generate again failed"
    });
  }
});

// --------------------
// Stage 5 — longer parent scam call (same cloned voice)
// --------------------

api.post("/parent-scam-call", async (req, res) => {
  try {
    if (!currentVoiceId) {
      return res.status(400).json({
        error: "No voice clone available. Complete Stage 4 first."
      });
    }

    console.log("Parent scam TTS with voice:", currentVoiceId);

    await generateScamAudioToFile(
      currentVoiceId,
      PARENT_SCAM_SCRIPT,
      "generated_parent_scam_call.mp3"
    );

    res.json({
      success: true,
      audio: "/generated_parent_scam_call.mp3"
    });
  } catch (err) {
    console.error("Parent scam call error:", err);
    const detail =
      err && typeof err.detail === "string"
        ? err.detail.slice(0, 500)
        : err?.message || "";
    res.status(500).json({
      error: "Parent scam call generation failed",
      detail
    });
  }
});

app.use("/api", api);

// Static files last
app.use(express.static(path.join(__dirname, "../frontend")));
app.use(express.static(__dirname));

app.listen(PORT, () =>
  console.log(`Backend running → http://localhost:${PORT}`)
);