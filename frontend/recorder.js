let mediaRecorder;
let audioChunks = [];
let stream;
let recordingStartedAt = null;

const MAX_RECORDING_MS = 120 * 1000;
const RECORDING_TOO_LONG_USER_MSG =
  "Your recording is longer than 2 minutes. The voice cloning service cannot process it. Please record again and submit a sample under 2 minutes.";

/** Shown when /api/simulate-scam or regenerate fails — user can record again from Stage 3 */
const STAGE4_SCAM_FAIL_RETRY_HINT =
  'Press "Start Recording" again to record another sample and give the simulation another chance.';

/** When the page is opened from another port (e.g. Live Server), API and MP3s live on :3001 */
function apiUrl(path) {
  if (typeof window === "undefined") return path;
  if (!path.startsWith("/")) path = "/" + path;
  const { hostname, port, protocol } = window.location;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (isLocal && port && port !== "3001") {
    return `${protocol}//${hostname}:3001${path}`;
  }
  return path;
}

/** Same as apiUrl — use for <audio src> so MP3 is loaded from the backend */
function mediaSrc(path) {
  if (!path) return path;
  if (path.startsWith("http")) return path;
  return apiUrl(path.startsWith("/") ? path : "/" + path);
}

/** Always read body as text first — avoids res.json() failing on HTML/empty/proxy errors */
async function readJsonFromResponse(res) {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      res.ok
        ? "Empty response from server"
        : `HTTP ${res.status} (empty body)`
    );
  }
  if (trimmed.startsWith("<") || trimmed.startsWith("<!")) {
    throw new Error(
      "Server returned a web page instead of JSON. Use http://localhost:3001 with the backend running (npm start in the backend folder), or fix the API URL."
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const preview = trimmed.replace(/\s+/g, " ").slice(0, 220);
    throw new Error(`Invalid JSON (HTTP ${res.status}): ${preview}`);
  }
}

function waitForAudioReady(el) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      el.removeEventListener("canplaythrough", onReady);
      el.removeEventListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Audio failed to load"));
    };
    if (el.readyState >= 4) {
      resolve();
      return;
    }
    el.addEventListener("canplaythrough", onReady, { once: true });
    el.addEventListener("error", onError, { once: true });
  });
}

const consentCheckbox = document.getElementById("consent");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusText = document.getElementById("status");
const recordingsContainer = document.getElementById("recordings-container");
const scamResult = document.getElementById("scamResult");

function getStage4Elements() {
  return {
    section: document.getElementById("stage4"),
    processing: document.getElementById("stage4-processing"),
    modelCreated: document.getElementById("stage4-model-created"),
    footer: document.getElementById("stage4-footer-copy"),
  };
}

function resetStage4Ui() {
  const els = getStage4Elements();
  if (els.section) els.section.hidden = true;
  if (els.processing) els.processing.hidden = true;
  if (els.modelCreated) els.modelCreated.hidden = true;
  if (els.footer) els.footer.hidden = true;
}

function resetStage5Ui() {
  if (typeof window.resetStage5ParentCallCache === "function") {
    window.resetStage5ParentCallCache();
  }
  const s5 = document.getElementById("stage5");
  const wrap = document.getElementById("stage5-play-wrap");
  const status = document.getElementById("stage5-play-status");
  if (s5) s5.hidden = true;
  if (wrap) wrap.hidden = true;
  if (status) status.textContent = "";
}

function resetStage6Section() {
  if (typeof window.resetStage6Ui === "function") {
    window.resetStage6Ui();
  }
  const s6 = document.getElementById("stage6");
  if (s6) s6.hidden = true;
}

function resetStage7Section() {
  if (typeof window.resetStage7Ui === "function") {
    window.resetStage7Ui();
  }
  const s7 = document.getElementById("stage7");
  if (s7) s7.hidden = true;
  const finalLearning = document.getElementById("final-learning");
  if (finalLearning) finalLearning.hidden = true;
}

consentCheckbox.addEventListener("change", () => {
  startBtn.disabled = !consentCheckbox.checked;
});

function resetForNewRecording() {
  recordingsContainer.innerHTML = "";
  scamResult.innerHTML = "";

  resetStage4Ui();
  resetStage5Ui();
  resetStage6Section();
  resetStage7Section();

  statusText.textContent = "";

  startBtn.disabled = !consentCheckbox.checked;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", async () => {
  audioChunks = [];

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    statusText.textContent = "Microphone access denied.";
    return;
  }

  mediaRecorder = new MediaRecorder(stream);
  mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);

  mediaRecorder.onstop = async () => {
    const elapsedMs =
      recordingStartedAt != null ? Date.now() - recordingStartedAt : 0;
    recordingStartedAt = null;

    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    const audioUrl = URL.createObjectURL(audioBlob);

    const div = document.createElement("div");
    div.className = "recording";

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = audioUrl;

    div.appendChild(audio);
    recordingsContainer.appendChild(div);

    startBtn.disabled = false;
    stopBtn.disabled = true;

    stream.getTracks().forEach((t) => t.stop());

    if (elapsedMs > MAX_RECORDING_MS) {
      statusText.textContent = RECORDING_TOO_LONG_USER_MSG;
      return;
    }

    statusText.textContent = "Recording saved. Processing your voice sample…";

    try {
      await uploadAudio(audioBlob);
      await runStage4ScamGeneration();
    } catch (e) {
      statusText.textContent =
        e?.message || "Upload or voice processing failed. Check the backend on port 3001.";
    }
  };

  recordingStartedAt = Date.now();
  mediaRecorder.start();
  statusText.textContent = "Recording… speak naturally.";
  startBtn.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener("click", () => {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
});

async function uploadAudio(blob) {
  const formData = new FormData();
  formData.append("audio", blob, "recording.webm");

  const res = await fetch(apiUrl("/api/upload"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    let msg = `Upload failed (HTTP ${res.status})`;
    try {
      const data = await readJsonFromResponse(res);
      if (data.error) msg = data.error;
    } catch (e) {
      if (e?.message) msg = e.message;
    }
    throw new Error(msg);
  }
}

async function runStage4ScamGeneration() {
  const els = getStage4Elements();
  if (els.section) els.section.hidden = false;
  if (els.footer) els.footer.hidden = true;
  if (els.modelCreated) els.modelCreated.hidden = true;
  if (els.processing) els.processing.hidden = false;
  if (scamResult) scamResult.innerHTML = "";
  els.section?.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const res = await fetch(apiUrl("/api/simulate-scam"), {
      method: "POST",
      headers: { Accept: "application/json" },
    });

    const data = await readJsonFromResponse(res);
    if (!res.ok) {
      if (data.code === "RECORDING_TOO_LONG" && data.error) {
        throw new Error(data.error);
      }
      throw new Error(
        data.error || data.detail || `Server error (${res.status})`
      );
    }
    if (!data.audio) {
      throw new Error("Server response missing audio URL");
    }

    if (els.processing) els.processing.hidden = true;
    if (els.modelCreated) els.modelCreated.hidden = false;

    await new Promise((r) => setTimeout(r, 450));

    showScamAudio(data.audio);

    if (els.footer) els.footer.hidden = false;

    statusText.textContent = "";
  } catch (err) {
    if (els.processing) els.processing.hidden = true;
    const tooLong =
      err?.message &&
      (err.message.includes("longer than 2 minutes") ||
        err.message.includes("under 2 minutes"));
    if (scamResult) {
      scamResult.innerHTML = "";
      const errP = document.createElement("p");
      errP.className = "scam-generation-error";
      errP.textContent = tooLong
        ? err.message
        : `Failed to generate scam call.${err?.message ? " " + err.message : ""}`;
      scamResult.appendChild(errP);
      if (!tooLong) {
        const hintP = document.createElement("p");
        hintP.className = "scam-generation-error scam-generation-retry-hint";
        hintP.textContent = STAGE4_SCAM_FAIL_RETRY_HINT;
        scamResult.appendChild(hintP);
      }
    }
    statusText.textContent = tooLong ? err.message : "";
  }
}

function showScamAudio(audioPath) {
  scamResult.innerHTML = "<h3>Simulated Scam Call</h3>";

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = mediaSrc(audioPath) + "?t=" + Date.now();

  scamResult.appendChild(audio);

  const tryAgainBtn = document.createElement("button");
  tryAgainBtn.textContent = "Try Again";
  tryAgainBtn.style.marginTop = "16px";

  tryAgainBtn.addEventListener("click", async () => {
    tryAgainBtn.disabled = true;

    scamResult.innerHTML = `
    <h3>Simulated Scam Call</h3>
    <div class="loading-box">
      <div class="spinner"></div>
      <p>Generating new scam voice...</p>
    </div>
  `;

    try {
      const res = await fetch(apiUrl("/api/generate-again"), {
        method: "POST",
        headers: { Accept: "application/json" },
      });

      const data = await readJsonFromResponse(res);
      if (!res.ok) {
        throw new Error(
          data.error || data.detail || `Server error (${res.status})`
        );
      }
      if (!data.audio) {
        throw new Error("Server response missing audio URL");
      }

      showScamAudio(data.audio);
    } catch {
      scamResult.innerHTML = "";
      const errP = document.createElement("p");
      errP.className = "scam-generation-error";
      errP.textContent = "Failed to regenerate scam call.";
      scamResult.appendChild(errP);
      const hintP = document.createElement("p");
      hintP.className = "scam-generation-error scam-generation-retry-hint";
      hintP.textContent = STAGE4_SCAM_FAIL_RETRY_HINT;
      scamResult.appendChild(hintP);
      tryAgainBtn.disabled = false;
    }
  });

  scamResult.appendChild(tryAgainBtn);

  const sampleAgainBtn = document.createElement("button");
  sampleAgainBtn.textContent = "Sample Voice Again";
  sampleAgainBtn.style.marginTop = "16px";
  sampleAgainBtn.style.marginLeft = "12px";

  sampleAgainBtn.addEventListener("click", () => {
    resetForNewRecording();
  });

  scamResult.appendChild(sampleAgainBtn);

  const stage5 = document.getElementById("stage5");
  if (stage5) stage5.hidden = false;
  const stage6 = document.getElementById("stage6");
  if (stage6) stage6.hidden = false;
  const stage7 = document.getElementById("stage7");
  if (stage7) stage7.hidden = false;
  const finalLearning = document.getElementById("final-learning");
  if (finalLearning) finalLearning.hidden = false;
}

window.resetStage5ParentCallCache = function () {
  const audio = document.getElementById("stage5-audio");
  window.__parentScamAudioUrl = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
  }
};

(function initStage5() {
  const accept = document.getElementById("stage5-accept");
  const decline = document.getElementById("stage5-decline");
  const playWrap = document.getElementById("stage5-play-wrap");
  const playBtn = document.getElementById("stage5-play-call");
  const audioEl = document.getElementById("stage5-audio");
  const statusEl = document.getElementById("stage5-play-status");

  if (decline) {
    decline.addEventListener("click", (e) => {
      e.preventDefault();
    });
  }

  if (accept && playWrap) {
    accept.addEventListener("click", () => {
      playWrap.hidden = false;
    });
  }

  if (playBtn && audioEl) {
    playBtn.addEventListener("click", async () => {
      try {
        if (!window.__parentScamAudioUrl) {
          if (statusEl) statusEl.textContent = "Generating call…";
          playBtn.disabled = true;
          const res = await fetch(apiUrl("/api/parent-scam-call"), {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: "{}",
          });
          const data = await readJsonFromResponse(res);
          if (!res.ok) {
            const msg = data.detail || data.error || `HTTP ${res.status}`;
            throw new Error(msg);
          }
          if (!data.audio) {
            throw new Error("Server response missing audio URL");
          }
          window.__parentScamAudioUrl = data.audio;
        }
        const url = mediaSrc(window.__parentScamAudioUrl) + "?t=" + Date.now();
        audioEl.src = url;
        audioEl.load();
        await waitForAudioReady(audioEl);
        await audioEl.play();
        if (statusEl) statusEl.textContent = "";
      } catch (err) {
        console.error("Play Call:", err);
        if (statusEl) {
          const hint = err?.message
            ? String(err.message).slice(0, 180)
            : "Could not load or play call.";
          statusEl.textContent = hint + " Try again.";
        }
      } finally {
        playBtn.disabled = false;
      }
    });
  }
})();
