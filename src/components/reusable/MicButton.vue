<script setup>
import { ref, onMounted } from "vue";
import { pipeline, AutoProcessor, AutoModelForAudioFrameClassification, read_audio } from "@huggingface/transformers";
import micImg from '@/assets/mic-button/mic.svg';
import micHoverImg from '@/assets/mic-button/mic-hover.svg';
import micActiveImg from '@/assets/mic-button/mic-active.svg';
import { useAlertStore } from "@/stores/AlertStore.js";
import { useSettingsStore } from "@/stores/SettingsStore.js";

const alertStore = useAlertStore();
const settingsStore = useSettingsStore();

// Reactive State
const micActive = ref(false);
const micBtnImage = ref(micImg);
const model = defineModel();
const currentModelName = ref('');
const isLoading = ref(true);
const loadProgress = ref(0);
const isProcessing = ref(false);
const emit = defineEmits(["textAvailable"]);

// Model Instances
let transcriber = null;
let segmentationProcessor = null;
let segmentationModel = null;
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;

const modelMap = {
  'Choice 1': 'Xenova/whisper-tiny.en',
  'Choice 2': 'Xenova/whisper-base.en',
  'Choice 3': 'Xenova/whisper-small.en'
};

// Speaker Segmentation Processing
/**
 * Processes audio for speaker diarization
 * @param {Blob} audioBlob - The recorded audio blob to process
 * @returns {Promise<Array>} Array of speaker segments with timing information
 */
async function processDiarization(audioBlob) {
  try {
    // First, convert the blob to an ArrayBuffer
    const audioUrld = URL.createObjectURL(audioBlob);

    const processedAudio = await read_audio(audioUrld,segmentationProcessor.feature_extractor.config.sampling_rate);
    
    // Process the audio with the processor - this creates the input features
    const inputs = await segmentationProcessor(processedAudio);
    
    // Run the model with the processed inputs
    const { logits } = await segmentationModel(inputs);
    
    // Post-process to get speaker segments
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

onMounted(async () => {
  try {
    isLoading.value = true;
    loadProgress.value = 10;

    const selectedModel = modelMap[settingsStore.selectedSTTModel] || modelMap['Choice 1'];
    currentModelName.value = selectedModel;
    
    loadProgress.value = 30;
    transcriber = await pipeline("automatic-speech-recognition", selectedModel, {
      progress_callback: progress => {
        loadProgress.value = 30 + Math.floor(progress * 30);
      }
    });

    loadProgress.value = 60;
    segmentationProcessor = await AutoProcessor.from_pretrained('onnx-community/pyannote-segmentation-3.0');
    console.log('Segmentation Processor Loaded');
    
    loadProgress.value = 80;
    segmentationModel = await AutoModelForAudioFrameClassification.from_pretrained(
      'onnx-community/pyannote-segmentation-3.0', 
      { device: 'wasm', dtype: 'fp32' }
    );
    console.log('Segmentation Model Loaded');

    loadProgress.value = 100;
  } catch (error) {
    alertStore.showAlert("error", "Model load failed. Please check your internet connection or switch to Google Chrome if you are using Edge.", error.message);
  } finally {
    isLoading.value = false;
  }
});

/**
 * Initializes audio recording from the microphone
 * @returns {Promise<void>} Promise that resolves when recording setup is complete
 * @throws {Error} When microphone access is denied or other errors occur
 */
async function startRecording() {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(audioStream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      isProcessing.value = true;
      try {
        const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(audioBlob);

        const [transcription, diarization] = await Promise.all([
          transcriber(audioUrl, {
            return_timestamps: 'word',
          }),
          processDiarization(audioBlob)
        ]);

        // Debug logging for Whisper transcription results
        console.log('======= WHISPER TRANSCRIPTION RESULTS =======');
        console.log('Full text:', transcription.text);
        console.log('Number of chunks:', transcription.chunks.length);
        console.log('===========================================');

        // Debug logging for pyannote-segmentation diarization results
        console.log('======= PYANNOTE DIARIZATION RESULTS =======');
        console.log('Number of segments:', diarization.length);
        if (diarization.length > 0) {
          console.log('First 5 segments:', diarization.slice(0, 5));
          console.log('Last 5 segments:', diarization.slice(-5));
          
          // Calculate total duration and speaker stats
          const totalDuration = diarization.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
          const speakerCounts = diarization.reduce((counts, seg) => {
            counts[seg.id] = (counts[seg.id] || 0) + 1;
            return counts;
          }, {});
          
          console.log('Total audio duration from segments:', totalDuration);
          console.log('Speaker distribution:', speakerCounts);
        } else {
          console.log('No diarization segments found!');
        }
        console.log('===========================================');

        const validSegments = preprocessDiarization(diarization);
        console.log('After preprocessing:', validSegments.length, 'valid segments');
        
        const mergedResults = mergeResults(transcription, diarization);
        model.value = mergedResults.formattedText;
        emit("textAvailable", mergedResults);
      } catch (error) {
        alertStore.showAlert("error", "Processing Failed", error.message);
      } finally {
        cleanup();
        isProcessing.value = false;
      }
    };

    mediaRecorder.start();
  } catch (error) {
    alertStore.showAlert("error", "Microphone Access Denied", error.message);
    cleanup();
  }
}

// Helper Functions
/**
 * Filters and enhances diarization segments
 * @param {Array} diarization - Raw diarization segments from model
 * @returns {Array} Filtered and processed diarization segments
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
 * Merges transcription and diarization results
 * @param {Object} transcription - Whisper transcription result
 * @param {Array} diarization - Speaker diarization segments
 * @param {Blob} audioBlob - Original audio blob
 * @returns {Object} Combined results with formatted text and segments
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
 * Finds the most appropriate speaker for a given time chunk
 * @param {Array} timestamp - [start, end] timestamps for the chunk
 * @param {Array} segments - Available speaker segments
 * @returns {string} Speaker label for the chunk
 */
function findOptimalSpeaker([start, end], segments) {
  // Case 1: Find segments that completely contain this chunk
  const containingSegments = segments.filter(
    segment => segment.start <= start && segment.end >= end
  );
  if (containingSegments.length === 1) {
    return containingSegments[0].label;
  }
  
  if (containingSegments.length > 1) {
    // If multiple segments contain this chunk, use the one with highest confidence
    return containingSegments.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    ).label;
  }
  
  // Case 2: Find segments with meaningful overlap
  const overlapThreshold = 0.35; 
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
  
  // Case 3: Fall back to midpoint distance method
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
 * Merges consecutive segments from the same speaker
 * @param {Array} acc - Accumulated segments
 * @param {Object} chunk - Current chunk to process
 * @param {string} speaker - Speaker label
 * @returns {Array} Updated segments array
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
 * Generates human-readable text from processed segments
 * @param {Array} segments - Speaker segments with text
 * @returns {string} Formatted text with speaker labels
 */
function generateReadableText(segments) {
  return segments.map(s => `${s.speaker}: ${s.text}`).join('\n\n');
}

/**
 * Stops the active recording session
 */
function stopRecording() {
  if (mediaRecorder?.state === "recording") {
    mediaRecorder.stop();
  }
}

/**
 * Cleans up recording resources and resets UI state
 */
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
/**
 * Handles mouse hover effect on the microphone button
 */
const micHover = () => !micActive.value && (micBtnImage.value = micHoverImg);

/**
 * Handles mouse unhover effect on the microphone button
 */
const micUnhover = () => !micActive.value && (micBtnImage.value = micImg);
/**
 * Handles microphone button click events
 * Toggles recording state and manages audio capture
 */
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
  cursor: not-allowed;
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

