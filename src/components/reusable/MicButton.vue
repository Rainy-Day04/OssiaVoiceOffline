<script setup>
import { ref, onMounted } from "vue";
import { pipeline } from "@huggingface/transformers";
import micImg from '@/assets/mic-button/mic.svg';
import micHoverImg from '@/assets/mic-button/mic-hover.svg';
import micActiveImg from '@/assets/mic-button/mic-active.svg';
import { useAlertStore } from "@/stores/AlertStore.js";
import { useSettingsStore } from "@/stores/SettingsStore.js";

// State Management
const alertStore = useAlertStore();
const settingsStore = useSettingsStore();

// Reactive Variables
const micActive = ref(false);
const micBtnImage = ref(micImg);
const model = defineModel();
const currentModelName = ref('');
const isLoading = ref(true);
const loadProgress = ref(0);
const isProcessing = ref(false); // New processing state
const emit = defineEmits(["textAvailable"]);

// Audio Recording Variables
let transcriber = null;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;

// Model Configuration
const modelMap = {
  'Choice 1': 'Xenova/whisper-tiny.en',
  'Choice 2': 'Xenova/whisper-base.en',
  'Choice 3': 'Xenova/whisper-small.en'
};

// Model Initialization
onMounted(async () => {
  try {
    isLoading.value = true;
    loadProgress.value = 10;
    
    const selectedModel = modelMap[settingsStore.selectedSTTModel] || modelMap['Choice 1'];
    currentModelName.value = selectedModel;
    
    loadProgress.value = 30;
    transcriber = await pipeline(
      "automatic-speech-recognition",
      selectedModel,
      {
        progress_callback: progress => {
          loadProgress.value = 30 + Math.floor(progress * 70);
        }
      }
    );
    
    loadProgress.value = 100;
  } catch (error) {
    alertStore.showAlert("error", "Model Load Failed", error.message);
  } finally {
    isLoading.value = false;
  }
});

// Audio Recording Functions
async function startRecording() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(audioStream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      isProcessing.value = true; // Start processing
      try {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
        const output = await transcriber(URL.createObjectURL(audioBlob));
        
        if (output?.text) {
          model.value = output.text;
          emit("textAvailable", output.text);
        }
      } catch (error) {
        alertStore.showAlert("error", "Transcription Failed", error.message);
      } finally {
        cleanup();
        isProcessing.value = false; // End processing
      }
    };

    mediaRecorder.start();
  } catch (error) {
    alertStore.showAlert("error", "Microphone Access Denied", error.message);
    cleanup();
  }
}

function stopRecording() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
}

function cleanup() {
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }
  mediaRecorder = null;
  audioChunks = [];
  micActive.value = false;
  micBtnImage.value = micImg;
}

// UI Interactions
const micHover = () => !micActive.value && (micBtnImage.value = micHoverImg);
const micUnhover = () => !micActive.value && (micBtnImage.value = micImg);

const micClick = async () => {
  try {
    if (!micActive.value && !isLoading.value) {
      micActive.value = true;
      micBtnImage.value = micActiveImg;
      await startRecording();
    } else {
      micActive.value = false;
      micBtnImage.value = micImg;
      stopRecording();
    }
  } catch (error) {
    alertStore.showAlert("error", "Microphone Error", error.message);
    cleanup();
  }
};
</script>

<template>
  <div id="mic-btn-container">
    <!-- Loading Overlay -->
    <div v-show="isLoading" class="loading-overlay">
      <div class="progress-bar">
        <div class="progress" :style="{ width: loadProgress + '%' }"></div>
      </div>
      <div class="loading-text">Loading Model: {{ currentModelName }}</div>
    </div>

    <!-- Full-Screen Processing Animation -->
    <div v-show="isProcessing" class="processing-animation">
      <div class="processing-spinner"></div>
      <div class="processing-text">Processing Audio...</div>
    </div>

    <!-- Microphone Button -->
    <img 
      id="mic-btn"
      :class="{ 
        haloGrow: micActive,
        'loading-state': isLoading 
      }"
      alt="Microphone"
      :src="micBtnImage"
      @mouseenter="!isLoading && micHover()"
      @mouseleave="!isLoading && micUnhover()"
      @click="!isLoading && micClick()"
    />
  </div>
</template>

<style scoped>
#mic-btn-container {
  display: flex;
  align-items: center;
  justify-content: center;
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

/* Loading Overlay */
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

/* Progress Bar */
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

/* Loading State */
.loading-state {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>