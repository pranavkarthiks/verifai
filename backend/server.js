import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

ffmpeg.setFfmpegPath(ffmpegPath);

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

    ffmpeg(inputPath)
      .audioChannels(1)
      .audioFrequency(44100)
      .toFormat("wav")
      .on("start", commandLine => {
        console.log("FFmpeg started:", commandLine);
      })
      .on("end", () => {
        console.log("FFmpeg conversion complete:", outputPath);
        resolve(outputPath);
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        reject(err);
      })
      .save(outputPath);
  });
}

function getWavDurationSec(wavPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(wavPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const duration = metadata?.format?.duration;

      if (!duration || duration < 0) {
        reject(new Error("Could not read audio duration"));
        return;
      }

      resolve(duration);
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

// (rest of file remains exactly the same)