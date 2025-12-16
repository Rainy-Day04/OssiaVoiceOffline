<script setup>
import { ref, onMounted, onBeforeUnmount, defineModel } from "vue";
import micImg from '@/assets/mic-button/mic.svg';
import micHoverImg from '@/assets/mic-button/mic-hover.svg';
import micActiveImg from '@/assets/mic-button/mic-active.svg';
import { useAlertStore } from "@/stores/AlertStore.js";
import { useSettingsStore } from "@/stores/SettingsStore.js";
import { pipeline, AutoProcessor, AutoModelForAudioFrameClassification, read_audio } from "@huggingface/transformers";

let segmentationProcessor = null;
let segmentationModel = null;

/**
 * Throttle: limit the rate at which a function can execute.
 * @param {Function} func
 * @param {number} limit - milliseconds
 * @returns {Function}
 */
function throttle(func, limit) {
  let lastFunc;
  let lastRan;
  return function() {
    const context = this;
    const args = arguments;
    if (!lastRan) {
      func.apply(context, args);
      lastRan = Date.now();
    } else {
      clearTimeout(lastFunc);
      lastFunc = setTimeout(function() {
        if ((Date.now() - lastRan) >= limit) {
          func.apply(context, args);
          lastRan = Date.now();
        }
      }, limit - (Date.now() - lastRan));
    }
  };
}

/**
 * Preprocess diarization segments: drop very short/low-confidence segments
 * and ensure a label exists.
 * @param {Array} diarization
 * @returns {Array}
 */
function preprocessDiarization(diarization) {
  return diarization
    .filter(segment => segment.end - segment.start >= 0.5)
    .filter(segment => segment.confidence >= 0.8)
    .map(segment => ({
      ...segment,
      label: segment.label || `Speaker_${segment.id}`
    }));
}

/**
 * Merge transcription chunks with diarization segments to produce
 * speaker-attributed text and merged segments.
 * @param {Object} transcription
 * @param {Array} diarization
 * @returns {{formattedText: string, segments: Array, rawData: Object}}
 */
function mergeResults(transcription, diarization) {
  const validSegments = preprocessDiarization(diarization);

  const formattedSegments = transcription.chunks.reduce((acc, chunk) => {
    const speaker = findOptimalSpeaker(chunk.timestamp, validSegments);
    return mergeSegments(acc, chunk, speaker);
  }, []);

  return {
    formattedText: generateReadableText(formattedSegments),
    segments: formattedSegments,
    rawData: { diarization, transcription }
  };
}

/**
 * Choose a speaker label for a transcription chunk using a
 * containment → overlap → midpoint heuristic cascade.
 * @param {[number, number]} timestamp
 * @param {Array} segments
 * @returns {string}
 */
function findOptimalSpeaker([start, end], segments) {
  // Mode 1: segments that fully contain the chunk
  const containingSegments = segments.filter(
    segment => segment.start <= start && segment.end >= end
  );
  if (containingSegments.length === 1) {
    return containingSegments[0].label;
  }
  if (containingSegments.length > 1) {
    return containingSegments.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    ).label;
  }
  
  // Mode 2: segments with strong overlap (≥ threshold of the chunk duration)
  const overlapThreshold = 0.65; 
  const chunkDuration = end - start;
  
  const overlappingSegments = segments.filter(segment => {
    const overlapStart = Math.max(start, segment.start);
    const overlapEnd = Math.min(end, segment.end);
    const overlapDuration = Math.max(0, overlapEnd - overlapStart);
    return overlapDuration / chunkDuration >= overlapThreshold;
  });
  
  if (overlappingSegments.length > 0) {
    return overlappingSegments.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    ).label;
  }
  
  // Mode 3: closest midpoint
  const chunkMid = (start + end) / 2;
  let bestMatch = null;
  let minDistance = Infinity;

  for (const segment of segments) {
    const segmentMid = (segment.start + segment.end) / 2;
    const distance = Math.abs(segmentMid - chunkMid);
    if (distance < minDistance) {
      minDistance = distance;
      bestMatch = segment;
    }
  }
  return bestMatch?.label || 'Speaker';
}

/**
 * Merge adjacent chunks from the same speaker if they are close in time.
 * @param {Array} acc
 * @param {{timestamp:[number,number], text:string}} chunk
 * @param {string} speaker
 * @returns {Array}
 */
function mergeSegments(acc, chunk, speaker) {
  const last = acc[acc.length - 1];
  const newSegment = {
    start: chunk.timestamp[0],
    end: chunk.timestamp[1],
    text: chunk.text.trim(),
    speaker
  };

  if (last && last.speaker === speaker && (chunk.timestamp[0] - last.end < 1.5)) {
    last.text += ` ${newSegment.text}`;
    last.end = newSegment.end;
    return acc;
  }
  return [...acc, newSegment];
}

/**
 * Render readable speaker-attributed text.
 * @param {Array} segments
 * @returns {string}
 */
function generateReadableText(segments) {
  return segments.map(s => `${s.speaker}: ${s.text}`).join('\n\n');
}

/**
 * Run segmentation/diarization on an audio Blob using Transformers.js pyannote model.
 * @param {Blob} audioBlob
 * @returns {Promise<Array>}
 */
async function processDiarization(audioBlob) {
  try {
    const audioUrl = URL.createObjectURL(audioBlob);
    const processedAudio = await read_audio(
      audioUrl,
      segmentationProcessor.feature_extractor.config.sampling_rate
    );
    const inputs = await segmentationProcessor(processedAudio);
    const { logits } = await segmentationModel(inputs);
    const diarization = segmentationProcessor.post_process_speaker_diarization(
      logits,
      processedAudio.length
    )[0];
    return diarization;
  } catch (error) {
    console.error('Diarization error:', error);
    return [];
  }
}

/**
 * Remove known markers/tokens from partial results.
 * @param {string} text
 * @returns {string}
 */
function filterText(text) {
  if (!text) return '';
  return text.replace(/\[BLANK_AUDIO\]/g, '').trim();
}

/** ------------------------ Streaming + audio constants ------------------------ */

const WHISPER_SR = 16000;

/**
 * Sliding window buffer to maintain recent audio context for streaming transcription.
 * Keeps the last WINDOW_SECONDS of audio for better accuracy.
 */
const WINDOW_SECONDS = 60;
const MAX_WINDOW_SAMPLES = WHISPER_SR * WINDOW_SECONDS;
let windowChunks = [];
let windowSamples = 0;

/**
 * Push a new PCM chunk into the sliding window; evict old data beyond the window size.
 * @param {Float32Array} chunk
 */
function pushIntoWindow(chunk) {
  windowChunks.push(chunk);
  windowSamples += chunk.length;

  while (windowSamples > MAX_WINDOW_SAMPLES && windowChunks.length) {
    const head = windowChunks[0];
    const overflow = windowSamples - MAX_WINDOW_SAMPLES;

    if (head.length <= overflow) {
      windowChunks.shift();
      windowSamples -= head.length;
    } else {
      const kept = head.subarray(overflow);
      windowChunks[0] = kept;
      windowSamples = MAX_WINDOW_SAMPLES;
      break;
    }
  }
}

/**
 * Collect the last N samples from the sliding window.
 * @param {number} lastNSamples
 * @returns {Float32Array}
 */
function getLastSamples(lastNSamples) {
  if (windowChunks.length === 0) return new Float32Array(0);

  const need = Math.min(lastNSamples, windowSamples);
  const out = new Float32Array(need);

  let remaining = need;
  let writePos = need;

  for (let i = windowChunks.length - 1; i >= 0 && remaining > 0; i--) {
    const buf = windowChunks[i];
    const take = Math.min(buf.length, remaining);
    writePos -= take;
    out.set(buf.subarray(buf.length - take), writePos);
    remaining -= take;
  }
  return out;
}

/** Reset the sliding window. */
function resetWindow() {
  windowChunks = [];
  windowSamples = 0;
}

/** ------------------------ Global state & stores ------------------------ */

const alertStore = useAlertStore();
const settingsStore = useSettingsStore();

/** Two-way bound output text for the parent component. */
const model = defineModel();

/** UI/state refs */
const micActive = ref(false);
const micBtnImage = ref(micImg);
const currentModelName = ref('');
const isLoading = ref(true);
const loadProgress = ref(0);
const isProcessing = ref(false);
const isProcessing_normalpipeline = ref(false);
let transcriber = null;
const partialResult = ref('');
const accumulatedText = ref('');
const processingSpeed = ref(0);

/** Emit events to parent */
const emit = defineEmits(["textAvailable", "audioProcessingComplete"]);

/** Audio/worker resources */
let audioContext = null;
let mediaStreamSource = null;
let scriptProcessor = null; // Note: ScriptProcessorNode is deprecated; consider AudioWorklet in future.
let audioStream = null;
let worker = null;
let initTimeout = null;
let lastSendTime = 0;
const BUFFER_SEND_INTERVAL = 300; // ms

/** Keep the entire session audio for final high-quality pass. */
let completeAudioData = [];

/** Auto-stop recording feature variables */
let silenceStartTime = null;
let lastTranscribedText = '';
const AUTO_STOP_RMS_THRESHOLD = 0.01; // RMS threshold for silence detection
let isStoppingRecording = false; // Flag to prevent race conditions during stop

/**
 * Get auto-stop settings from the settings store.
 * @returns {{enabled: boolean, delay: number}} Auto-stop configuration
 */
const getAutoStopSettings = () => ({
  enabled: settingsStore.sttAutoStop,
  delay: (settingsStore.sttAutoStopDelay || 3) * 1000 // Convert seconds to milliseconds
});

/** Available model map (adjust to your app's selections) */
const modelMap = {
  'Choice 1': 'Xenova/whisper-tiny.en',
  'Choice 2': 'Xenova/whisper-base.en',
  'Choice 3': 'Xenova/whisper-small.en'
};

/**
 * Centralized error handler: logs + user-facing alert + cleanup.
 * @param {string} context
 * @param {Error} error
 */
const handleError = (context, error) => {
  const message = error?.message || 'Unknown error';
  console.error(`[ERROR] ${context}`, message);
  alertStore.showAlert("error", context,
    message.includes('FeatureExtractor') ? 
    'Audio processing initialization failed, please refresh and try again.' : 
    message
  );
  stopRecording();
  cleanup();
};

/** ------------------------ Lifecycle: mount ------------------------ */

onMounted(async () => {
  const selectedModel_full = modelMap[settingsStore.selectedSTTModel] || modelMap['Choice 1'];
  model.value = '';
  try {
    isLoading.value = true;
    loadProgress.value = 10;
    
    currentModelName.value = selectedModel_full;
    loadProgress.value = 30;

    // Offline/full-pass ASR pipeline for final transcription
    transcriber = await pipeline(
      "automatic-speech-recognition",
      selectedModel_full
    );
  } catch (error) {
    alertStore.showAlert("error", "Model Load Failed", error.message);
  } 
  try {
    loadProgress.value = 60;
    segmentationProcessor = await AutoProcessor.from_pretrained('onnx-community/pyannote-segmentation-3.0');
    loadProgress.value = 80;
    segmentationModel = await AutoModelForAudioFrameClassification.from_pretrained(
      'onnx-community/pyannote-segmentation-3.0', 
      { device: 'wasm', dtype: 'fp32' }
    );
  } catch (error) {
    alertStore.showAlert("error", "Segmentation Model Load Failed", error.message);
  }
  loadProgress.value = 90;
  try {
    console.group('[Main] Initialization start');

    // Streaming worker for partial/real-time updates
    worker = new Worker(new URL('@/workers/whisper-worker.js?worker&inline', import.meta.url), {
      type: 'module'
    });

    worker.onmessage = (e) => {
      try {
        switch (e.data.status) {
          case 'start':
            isProcessing.value = true;
            processingSpeed.value = 0;
            break;
          case 'loading':
            loadProgress.value = e.data.progress || 0;
            currentModelName.value = e.data.file || '';
            break;
          case 'ready':
            clearTimeout(initTimeout);
            isLoading.value = false;
            break;
          case 'update':
            isProcessing.value = true;
            if (e.data.output && e.data.tps) {
              processingSpeed.value = e.data.tps;
              // Update last transcribed text for auto-stop logic
              const currentText = Array.isArray(e.data.output) ? 
                e.data.output[0] : e.data.output || '';
              if (currentText.trim()) {
                lastTranscribedText = filterText(currentText);
                console.log(`[Auto-stop Debug] Updated text from worker: "${lastTranscribedText}"`);
              }
            }
            break;
          case 'complete': {
            const finalText = e.data.output && Array.isArray(e.data.output) ? 
              e.data.output[0] : e.data.output || '';
            const filteredFinal = filterText(finalText);
            
            // Update last transcribed text for auto-stop logic
            if (filteredFinal.trim()) {
              lastTranscribedText = filteredFinal;
              console.log(`[Auto-stop Debug] Updated text from worker (complete): "${lastTranscribedText}"`);
            }
            
            throttledUpdate(filteredFinal);
            setTimeout(() => {
              isProcessing.value = false;
            }, 1000);
            break;
          }
          case 'error':
            handleError("Worker error", new Error(e.data.error));
            break;
        }
      } catch (error) {
        handleError("Message processing failed", error);
      }
    };

    worker.onerror = (e) => handleError("Worker runtime error", e.error);

    initTimeout = setTimeout(() => {
      if (isLoading.value) handleError("Initialization timeout", new Error("Model loading exceeded 60 seconds"));
    }, 60000);

    // Load the same model family as the offline pipeline for consistency.
    worker.postMessage({ 
      type: 'load',
      data: { modelId: selectedModel_full }
    });

    console.groupEnd();
  } catch (error) {
    handleError("Initialization failed", error);
  }
});

/** ------------------------ Recording control ------------------------ */

/**
 * Start capturing microphone audio and stream it to the Whisper worker for real-time transcription.
 * Audio processing chain: microphone → noise reduction → low-pass filter → analysis
 * Implements auto-stop feature that detects silence after sentence-ending punctuation.
 */
async function startRecording() {
  try {
    console.group('[Main] Start recording');
    accumulatedText.value = '';
    model.value = '';
    partialResult.value = '';
    completeAudioData = [];
    resetWindow();
    lastSendTime = 0;
    
    // Reset auto-stop logic variables
    silenceStartTime = null;
    lastTranscribedText = '';
    isStoppingRecording = false;
    
    audioStream = await navigator.mediaDevices.getUserMedia({ 
      audio: { 
        sampleRate: WHISPER_SR,
        noiseSuppression: true,
        echoCancellation: true
      }
    });
    
    audioContext = new AudioContext({ 
      sampleRate: WHISPER_SR,
      latencyHint: 'interactive'
    });

    mediaStreamSource = audioContext.createMediaStreamSource(audioStream);
    
    // Audio processing chain: compressor for noise reduction → low-pass filter for clarity
    const noiseGate = audioContext.createDynamicsCompressor();
    noiseGate.threshold.value = -50;
    noiseGate.knee.value = 40;     
    noiseGate.ratio.value = 12;    
    noiseGate.attack.value = 0.003;
    noiseGate.release.value = 0.25;

    const lowPassFilter = audioContext.createBiquadFilter();
    lowPassFilter.type = 'lowpass';
    lowPassFilter.frequency.value = 8000;

    mediaStreamSource.connect(noiseGate);
    noiseGate.connect(lowPassFilter);
    
    // ScriptProcessorNode is deprecated; consider AudioWorkletNode in future.
    scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);

    // Avoid feedback/loopback: route through a muted gain node
    const mute = audioContext.createGain();
    mute.gain.value = 0;

    lowPassFilter.connect(scriptProcessor);
    scriptProcessor.connect(mute).connect(audioContext.destination);

    scriptProcessor.onaudioprocess = e => {
      const chunk = e.inputBuffer.getChannelData(0);

      // Calculate RMS (Root Mean Square) for volume/silence detection
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      const rms = Math.sqrt(sum / chunk.length);
      
      // Auto-stop feature: detect silence after sentence-ending punctuation
      const now = Date.now();
      
      // Prevent processing if stop is already in progress
      if (isStoppingRecording) {
        return;
      }
      
      if (rms < AUTO_STOP_RMS_THRESHOLD) {
        // Silent audio detected
        if (silenceStartTime === null) {
          silenceStartTime = now;
          console.log(`[Auto-stop] Silence detected. RMS: ${rms.toFixed(6)}, Last text: "${lastTranscribedText}"`);
        } else {
          const autoStopSettings = getAutoStopSettings();
          const silenceDuration = now - silenceStartTime;
          
          // Auto-stop if enabled and silence duration threshold is met
          if (autoStopSettings.enabled && silenceDuration >= autoStopSettings.delay) {
            // Only auto-stop if the last transcribed text ends with sentence-ending punctuation
            const endsWithPunctuation = /[.?]$/.test(lastTranscribedText.trim());
            console.log(`[Auto-stop] Silence duration: ${silenceDuration}ms, Ends with punctuation: ${endsWithPunctuation}, Text: "${lastTranscribedText}"`);
            if (endsWithPunctuation) {
              console.log('[Auto-stop] Triggered: stopping recording after sentence completion');
              // Schedule stop to allow current audio chunk to be processed
              setTimeout(() => {
                if (micActive.value) {
                  stopRecording();
                }
              }, 0);
            }
          }
        }
      } else {
        // Audio with content detected, reset silence timer
        if (silenceStartTime !== null) {
          console.log(`[Auto-stop] Audio detected, resetting silence timer. RMS: ${rms.toFixed(6)}`);
        }
        silenceStartTime = null;
      }
      
      // Process audio for transcription (skip only extremely quiet noise)
      if (rms < 1e-6) return;

      try {
        const chunkCopy = new Float32Array(chunk);
        // 1) Push into sliding window for streaming context
        pushIntoWindow(chunkCopy);
        // 2) Keep complete audio for final high-quality transcription
        completeAudioData.push(chunkCopy);

        const now = Date.now();
        if (now - lastSendTime >= BUFFER_SEND_INTERVAL) {
          lastSendTime = now;

          // Send sliding window buffer to Worker for real-time transcription
          const mergedBuffer = getLastSamples(MAX_WINDOW_SAMPLES);

          if (mergedBuffer.length > 0) {
            worker.postMessage({
              type: 'generate',
              data: { 
                audio: mergedBuffer,
                language: settingsStore.selectedLanguage || 'en'
              }
            });
          }
        }
      } catch (error) {
        handleError("Audio sending failed", error);
      }
    };

    console.groupEnd();
  } catch (error) {
    handleError("Microphone access failed", error);
  }
}

/**
 * Stop audio capture and perform final high-quality transcription with speaker diarization.
 * Creates a WAV file from the complete session audio and processes it through:
 * 1. Whisper ASR for transcription with timestamps
 * 2. Pyannote segmentation for speaker diarization
 * 3. Merges results to produce speaker-attributed transcription
 */
async function stopRecording() {
  if (isStoppingRecording) {
    console.log('[MicButton] Stop already in progress, ignoring duplicate call');
    return;
  }
  
  if (!micActive.value) {
    console.log('[MicButton] Mic already stopped, ignoring call');
    return;
  }
  
  isStoppingRecording = true;
  micActive.value = false;
  micBtnImage.value = micImg;
  
  console.log(`[MicButton] Stopping recording, collected ${completeAudioData.length} audio chunks`);
  
  try {
    // Immediately disconnect scriptProcessor to prevent further audio processing
    if (scriptProcessor) {
      scriptProcessor.onaudioprocess = null;
      scriptProcessor.disconnect();
    }
    if (mediaStreamSource) {
      mediaStreamSource.disconnect();
    }
    
    // Brief grace period to allow final processing to complete
    await new Promise(r => setTimeout(r, 120));

    // Clean up remaining audio connections
    [scriptProcessor, mediaStreamSource].forEach(node => {
      if (node && node.disconnect) {
        try {
          node.disconnect();
        } catch (e) {
          // Already disconnected
        }
      }
    });
    if (audioContext && audioContext.state !== 'closed') {
      await audioContext.close();
    }
    audioStream?.getTracks().forEach(track => track.stop());
    resetWindow();
    
    // Process complete session audio for final high-quality transcription
    if (completeAudioData.length > 0) {
      const totalLength = completeAudioData.reduce((sum, buf) => sum + buf.length, 0);
      const fullAudio = new Float32Array(totalLength);

      let offset = 0;
      completeAudioData.forEach(buffer => {
        fullAudio.set(buffer, offset);
        offset += buffer.length;
      });

      const durationSec = fullAudio.length / WHISPER_SR;
      console.log(`[Audio Processing] Chunks: ${completeAudioData.length}, Samples: ${fullAudio.length}, Duration: ${durationSec.toFixed(2)}s`);
      
      if (transcriber) {
        try {
          isProcessing_normalpipeline.value = true;
          
          // Convert PCM float32 to WAV format for processing
          const audioBlob = await float32ArrayToWavBlob(fullAudio);
          const audioUrl = URL.createObjectURL(audioBlob);
          
          // Run transcription and diarization in parallel for efficiency
          const [transcription, diarization] = await Promise.all([
            transcriber(audioUrl, {
              return_timestamps: 'true',
            }),
            processDiarization(audioBlob)
          ]);
          
          // Merge transcription with speaker diarization
          const mergedResults = mergeResults(transcription, diarization);
          model.value = mergedResults.formattedText;
          isProcessing_normalpipeline.value = false;
          
          emit("textAvailable", mergedResults);
          emit("audioProcessingComplete");
        } catch (error) {
          handleError("Complete audio processing failed", error);
        }
      } else {
        // Fallback to worker if transcriber not available
        worker?.postMessage({ 
          type: 'finalize',
          data: { fullAudio }
        });
        emit("textAvailable");
      }
    }
    
  } catch (error) {
    handleError("Stop recording failed", error);
  } finally {
    isStoppingRecording = false;
    console.log('[MicButton] Stop recording completed, flag reset');
  }
}

/** ------------------------ Utilities ------------------------ */

/**
 * Convert a Float32 PCM buffer into a 16-bit PCM WAV Blob.
 * Applies volume normalization and proper WAV header formatting.
 * @param {Float32Array} float32Array - Raw audio samples
 * @returns {Promise<Blob>} WAV-formatted audio blob
 */
async function float32ArrayToWavBlob(float32Array) {
  const numChannels = 1; // mono
  const sampleRate = WHISPER_SR;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = float32Array.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt subchunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Convert float32 samples to int16 with volume adjustment and clamping
  let offset = 44;
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i] * 0.8));
    const int16Sample = (s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF));
    view.setInt16(offset, int16Sample, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Write ASCII string into a DataView at a given offset for WAV header.
 * @param {DataView} view - Target data view
 * @param {number} offset - Byte offset to start writing
 * @param {string} string - ASCII string to write
 */
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/** Clean up UI state after recording stops. */
function cleanup() {
  partialResult.value = '';
  processingSpeed.value = 0;
  micBtnImage.value = micImg;
}

/** ------------------------ Lifecycle: unmount ------------------------ */

onBeforeUnmount(() => {
  try {
    clearTimeout(initTimeout);
    worker?.terminate();
    stopRecording();
    audioContext = null;
    mediaStreamSource = null;
    scriptProcessor = null;
    audioStream = null;
  } catch (error) {
    handleError("Unmount failed", error);
  }
});

/** ------------------------ UI handlers ------------------------ */

/**
 * Toggle microphone recording on/off.
 * Handles state management and prevents operations during loading or processing.
 */
const micClick = async () => {
  try {
    if (micActive.value) {
      console.log('[MicButton] Manual stop requested');
      // Let stopRecording handle the micActive.value change
      await stopRecording();
      return;
    }
    if (isLoading.value || isProcessing.value || isStoppingRecording) {
      console.log('[MicButton] Cannot start - loading, processing, or stopping');
      return;
    }
    console.log('[MicButton] Manual start requested');
    micActive.value = true;
    micBtnImage.value = micActiveImg;
    await startRecording();
  } catch (error) {
    handleError("Microphone operation failed", error);
  }
};

/**
 * Update the transcription output with throttling to prevent excessive UI updates.
 * Uses overwrite mode to avoid duplicated text from streaming updates.
 * @param {string} text - New transcription text
 */
const throttledUpdate = throttle((text) => {
  if (text == null) return;

  if (model !== undefined) {
    // Clear first to prevent duplicated prefix from streaming updates
    model.value = '';
    // Write the new text on the next microtask
    queueMicrotask(() => {
      model.value = text;
    });
  }

  // Store the latest partial result
  partialResult.value = text;
}, 200);

/** Handle microphone button hover - show hover image */
const micHover = () => !micActive.value && (micBtnImage.value = micHoverImg);

/** Handle microphone button mouse leave - show default image */
const micUnhover = () => !micActive.value && (micBtnImage.value = micImg);
</script>

<template>
  <div id="mic-btn-container">
    <div v-show="isLoading" class="loading-overlay">
      <div class="progress-bar">
        <div class="progress" :style="{ width: loadProgress + '%' }"></div>
      </div>
      <div class="loading-text">Initializing: {{ currentModelName }}</div>
    </div>

    <!-- Full-screen overlay while running the final offline pass -->
    <div v-show="isProcessing_normalpipeline" class="processing-animation">
      <div class="processing-spinner"></div>
      <div class="processing-text">Processing Audio...</div>
    </div>

    <img 
      id="mic-btn"
      :class="{ 
        haloGrow: micActive,
        'loading-state': isLoading 
      }"
      :src="micBtnImage"
      @click="micClick"
      @mouseenter="!isLoading && micHover()"
      @mouseleave="!isLoading && micUnhover()"
    />
  </div>
</template>

<style scoped>
#mic-btn-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: start;
  height: 100%;
}

#mic-btn {
  box-sizing: content-box;
  height: 75%;
  cursor: pointer;
  position: relative;
}

.haloGrow {
  border-style: solid;
  animation-name: halo;
  animation-duration: 1.1s;
  animation-iteration-count: infinite;
  animation-timing-function: ease-out;
}

@keyframes halo {
  from {
    border-color: rgba(69, 189, 69, 0.9);
    border-width: 0;
    border-radius: 100%;
  }
  to {
    border-color: transparent;
    border-width: 20px;
    border-radius: 100%;
  }
}

/* Full-screen processing overlay */
.processing-animation {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.processing-spinner {
  width: 50px;
  height: 50px;
  border: 6px solid #f3f3f3;
  border-top: 6px solid #41b883;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

.processing-text {
  font-size: 1.2em;
  font-weight: 500;
  color: #e6e6e6;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Loading overlay styles */

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.95);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 1001;
}

.progress-bar {
  width: 200px;
  height: 8px;
  background: #eee;
  border-radius: 4px;
  overflow: hidden;
}

.progress {
  height: 100%;
  background: linear-gradient(90deg, #41b883, #35495e);
  transition: width 0.3s ease;
}

.loading-text {
  margin-top: 8px;
  color: #2c3e50;
  font-size: 0.9em;
}

.loading-state {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>