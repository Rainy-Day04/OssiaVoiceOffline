<script setup>
import { ref, onMounted, onBeforeUnmount, defineModel } from "vue";
import micImg from '@/assets/mic-button/mic.svg';
import micHoverImg from '@/assets/mic-button/mic-hover.svg';
import micActiveImg from '@/assets/mic-button/mic-active.svg';
import { useAlertStore } from "@/stores/AlertStore.js";
import { useSettingsStore } from "@/stores/SettingsStore.js";
import { pipeline } from "@huggingface/transformers";

/**
 * Limits the rate at which a function can fire
 * @param {Function} func - The function to throttle
 * @param {number} limit - Time limit in milliseconds
 * @returns {Function} - Throttled function
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
 * Removes unwanted markers from transcription text
 * @param {string} text - Raw transcription text
 * @returns {string} - Cleaned text
 */
function filterText(text) {
  if (!text) return '';
  return text.replace(/\[BLANK_AUDIO\]/g, '').trim();
}

/** Sample rate for Whisper model audio processing */
const WHISPER_SR = 16000;
const alertStore = useAlertStore();
const settingsStore = useSettingsStore();

/** Two-way binding for transcription result */
const model = defineModel();

// State management
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
/** Emit transcription result with audio data */
const emit = defineEmits(["textAvailable"]);

// Audio processing resources
let audioContext = null;
let mediaStreamSource = null;
let scriptProcessor = null;
let audioStream = null;
let worker = null;
let initTimeout = null;
let audioBuffers = [];
let lastSendTime = 0;
const BUFFER_SEND_INTERVAL = 1000;

/** Stores complete audio recording for final processing */
let completeAudioData = [];

/** Available speech recognition models */
const modelMap = {
  'Choice 1': 'Xenova/whisper-tiny.en',
  'Choice 2': 'Xenova/whisper-base.en',
  'Choice 3': 'Xenova/whisper-small.en'
};

/**
 * Handles errors consistently throughout the component
 * @param {string} context - Description of where error occurred
 * @param {Error} error - Error object
 */
const handleError = (context, error) => {
  const message = error?.message || 'Unknown error';
  console.error(`[ERROR] ${context}`, message);
  alertStore.showAlert("error", context,
    message.includes('FeatureExtractor') ? 
    'Audio processing initialization failed, please refresh the page and try again' : 
    message
  );
  stopRecording();
  cleanup();
};

/**
 * Initialize component, load speech recognition model and worker
 */
onMounted(async () => {
  const selectedModel_full = modelMap[settingsStore.selectedSTTModel] || modelMap['Choice 1'];

  try {
    isLoading.value = true;
    loadProgress.value = 10;
    
    currentModelName.value = selectedModel_full ;
    loadProgress.value = 30;
    transcriber = await pipeline(
      "automatic-speech-recognition",
      selectedModel_full ,
    );
  } catch (error) {
    alertStore.showAlert("error", "Model Load Failed", error.message);
  } 
  loadProgress.value = 99;
  try {
    console.group('[Main] Initialization start');
    loadProgress.value = 1;    
    worker = new Worker(new URL('@/workers/whisper-worker.js?worker&inline', import.meta.url), {
      type: 'module'
    });

    worker.onmessage = (e) => {
      console.log(`[Main] Received message: ${e.data.status}`, e.data);
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
            if (e.data.output) {
              const filteredText = filterText(e.data.output);
              if (filteredText) {
                throttledUpdate(filteredText);
              }
              
              if (e.data.tps) {
                processingSpeed.value = e.data.tps;
              }
            }
            break;
          case 'complete': {
            const finalText = e.data.output && Array.isArray(e.data.output) ? 
              e.data.output[0] : e.data.output || '';
            
            const filteredFinal = filterText(finalText);
            console.log(`[Main] Complete result: "${filteredFinal}"`);
            
            const filteredPartial = filterText(partialResult.value);
            if (filteredPartial) {
              accumulatedText.value += filteredPartial + ' ';
            }
            partialResult.value = '';
            
            if (model !== undefined) {
              model.value = accumulatedText.value.replace(/\s+/g, ' ').trim();
            }
            
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
      if (isLoading.value) handleError("Initialization timeout", new Error("Model loading took too long, exceeded 60 seconds"));
    }, 60000);

    const selectedModel = 'onnx-community/whisper-base';
    worker.postMessage({ 
      type: 'load',
      data: { modelId: selectedModel }
    });

    console.groupEnd();
  } catch (error) {
    handleError("Initialization failed", error);
  }
});

/**
 * Begin audio recording and real-time transcription
 * Captures microphone input and sends to worker for processing
 */
async function startRecording() {
  try {
    console.group('[Main] Start recording');
    accumulatedText.value = ''
    model.value = '';
    completeAudioData = [];
    
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
    scriptProcessor = audioContext.createScriptProcessor(2048, 1, 1);

    mediaStreamSource.connect(scriptProcessor);
    scriptProcessor.connect(audioContext.destination);

    audioBuffers = [];
    lastSendTime = 0;

    scriptProcessor.onaudioprocess = e => {
      const chunk = e.inputBuffer.getChannelData(0);
      // Skip empty or silent chunks
      if (!chunk.some(s => s !== 0)) return;

      try {
        // Add audio fragments to buffer
        const chunkCopy = new Float32Array(chunk);
        audioBuffers.push(chunkCopy);
        
        // Also save to complete audio data array
        completeAudioData.push(new Float32Array(chunk));
        
        const now = Date.now();
        // Send batch data at regular intervals
        if (now - lastSendTime >= BUFFER_SEND_INTERVAL && audioBuffers.length > 0) {
          lastSendTime = now;
          
          // Merge audio data in the buffer
          const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.length, 0);
          const mergedBuffer = new Float32Array(totalLength);
          
          let offset = 0;
          audioBuffers.forEach(buffer => {
            mergedBuffer.set(buffer, offset);
            offset += buffer.length;
          });
          
          // Clear the buffer
          audioBuffers = [];
          
          worker.postMessage({
            type: 'generate',
            data: { 
              audio: mergedBuffer,
              language: 'en'
            }
          });
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
 * Stop recording and process complete audio
 * Performs final high-quality transcription on full audio data
 */
async function stopRecording() {
  try {
    [scriptProcessor, mediaStreamSource].forEach(node => node?.disconnect());
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close();
    }
    audioStream?.getTracks().forEach(track => track.stop());
    
    // Merge complete audio data
    let fullAudio = null;
    if (completeAudioData.length > 0) {
      // Calculate total length
      const totalLength = completeAudioData.reduce((sum, buf) => sum + buf.length, 0);
      fullAudio = new Float32Array(totalLength);
      
      // Merge all fragments
      let offset = 0;
      completeAudioData.forEach(buffer => {
        fullAudio.set(buffer, offset);
        offset += buffer.length;
      });
      
      // Process complete audio with the loaded model
      if (transcriber) {
        try {
          console.log("[Main] Processing complete audio with pipeline...");
          isProcessing_normalpipeline.value = true;
          
          const result = await transcriber(fullAudio);
          
          const finalText = filterText(result.text || '');
          console.log(`[Main] Pipeline complete result: "${finalText}"`);
          
          model.value = finalText;
          
          emit("textAvailable", {
            text: finalText,
            audio: fullAudio,
            sampleRate: WHISPER_SR
          });
          
          isProcessing_normalpipeline.value = false;
        } catch (error) {
          handleError("Complete audio processing failed", error);
        }
      } else {
        // Fallback to worker if pipeline isn't available
        worker?.postMessage({ 
          type: 'finalize',
          data: { fullAudio }
        });
        
        if (accumulatedText.value) {
          const cleanText = accumulatedText.value.replace(/\s+/g, ' ').trim();
          model.value = cleanText;
          
          emit("textAvailable", {
            text: cleanText,
            audio: fullAudio,
            sampleRate: WHISPER_SR
          });
        }
      }
    }
    
    micActive.value = false;
  } catch (error) {
    handleError("Stop recording failed", error);
  }
}

/**
 * Reset UI elements and partial results 
 */
function cleanup() {
  partialResult.value = '';
  processingSpeed.value = 0;
  micBtnImage.value = micImg;
}

/**
 * Clean up resources when component is destroyed
 */
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

/**
 * Handle microphone button click
 * Toggles recording state
 */
const micClick = async () => {
  try {
    // If mic is already active, allow turning it off even during processing
    if (micActive.value) {
      micActive.value = false;
      micBtnImage.value = micImg;
      stopRecording();
      return;
    }
    
    // Otherwise, only allow turning ON if not loading or processing
    if (isLoading.value || isProcessing.value) return;
    
    micActive.value = true;
    micBtnImage.value = micActiveImg;
    await startRecording();
  } catch (error) {
    handleError("Microphone operation failed", error);
  }
};

/**
 * Handle partial transcription results with throttling
 * Updates model value with intermediate results for responsive UI
 */
const throttledUpdate = throttle((text) => {
  if (!text) return;
  
  partialResult.value = text;
  
  if (model !== undefined) {
    model.value = accumulatedText.value + text;
  }
}, 200);

/** Handle microphone button hover state */
const micHover = () => !micActive.value && (micBtnImage.value = micHoverImg);

/** Handle microphone button hover exit state */
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

    <!-- Full-Screen Processing Animation -->
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
    border-radius: 100%; /* Maintain circular border */
  }
  to {
    border-color: transparent;
    border-width: 20px;
    border-radius: 100%; /* Maintain circular border */
  }
}

/* Full-Screen Processing Animation */
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

/* Loading interface styles */
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
