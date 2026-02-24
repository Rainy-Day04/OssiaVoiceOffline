<template>
  <div class="uploader">
    <h2>{{ autoStart ? 'Auto Vision Analysis' : 'SmolVLM Vision Analysis' }}</h2>

    <!-- Image Upload (only show upload button if autoStart is disabled) -->
    <div class="field" v-if="!autoStart">
      <label for="fileInput">Select Image:</label>
      <div class="input-group">
        <input id="fileInput" type="file" accept="image/*" @change="onFileChange" />
        <button @click="toggleCamera" class="camera-btn" :disabled="loading">
          {{ showCamera ? 'Close Camera' : 'Use Camera' }}
        </button>
      </div>
    </div>

    <!-- Camera Section -->
    <div v-if="showCamera" class="camera-section">
      <div class="camera-container">
        <video ref="videoElement" autoplay playsinline class="camera-video"></video>
        <canvas ref="canvasElement" class="camera-canvas" style="display: none;"></canvas>
      </div>

      <div class="camera-controls" v-if="!autoStart">
        <button @click="captureImage" class="capture-btn" :disabled="!cameraReady">
          📸 Capture Image
        </button>
        <button @click="stopCamera" class="stop-camera-btn">
          Stop Camera
        </button>
      </div>

      <div v-else class="camera-status">
        <p v-if="cameraReady">Ready - capturing...</p>
        <p v-else>Starting camera...</p>
      </div>
    </div>

    <!-- Model Download Status -->
    <div v-if="downloadProgress.total > 0" class="download-progress">
      <h4>Model Loading Progress:</h4>
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: downloadProgress.percentage + '%' }"></div>
      </div>
      <p>
        {{ downloadProgress.current }}/{{ downloadProgress.total }} -
        {{ downloadProgress.percentage.toFixed(1) }}%
      </p>
      <p class="download-status">{{ downloadProgress.status }}</p>
    </div>

    <!-- Run Button (only show if auto-run is disabled) -->
    <button v-if="!autoRun" :disabled="!imageUrl || loading" @click="onRun" class="run-btn">
      {{ loading ? 'Analyzing...' : 'Run Vision Analysis' }}
    </button>

    <!-- Auto-run status (show when auto-run is enabled) -->
    <div v-if="autoRun && loading" class="auto-run-status">
      <div class="status-processing">Analyzing image...</div>
    </div>

    <!-- Error Display -->
    <div v-if="error" class="error">
      {{ error }}
    </div>

    <!-- Generated Result -->
    <div v-if="result" class="result">
      <div class="result-header">
        <h3>Generated Result:</h3>
        <button @click="copyToClipboard" class="copy-btn" :disabled="copying">
          {{ copying ? 'Copied!' : '📋 Copy' }}
        </button>
      </div>
      <p>{{ result }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, defineModel } from 'vue';
import * as ort from 'onnxruntime-web';
import { AutoConfig, AutoProcessor, load_image } from '@huggingface/transformers';
import { useSettingsStore } from '@/stores/SettingsStore.js';

/** Two-way binding for transcription result */
const model = defineModel();

const emit = defineEmits(['textAvailable']);

const props = defineProps({
  autoRun: { type: Boolean, default: false },
  autoStart: { type: Boolean, default: false },
  defaultPrompt: { type: String, default: "Can you describe what's happening in this image?" }
});

// --- Compatibility guards (keep behavior, reduce theatrics) ---
const BigIntConstructor = (() => {
  try {
    return window.BigInt || eval('BigInt');
  } catch {
    return null;
  }
})();

const BigInt64ArrayConstructor = (() => {
  try {
    return window.BigInt64Array || eval('BigInt64Array');
  } catch {
    return null;
  }
})();

if (!BigIntConstructor || !BigInt64ArrayConstructor) {
  throw new Error(
    'Browser does not support BigInt or BigInt64Array. Please use a modern browser (Chrome 67+, Firefox 68+, Safari 14+).'
  );
}

// --- State ---
const settingsStore = useSettingsStore();

const imageFile = ref(null);
const imageUrl = ref('');
const loading = ref(false);
const error = ref('');
const result = ref('');
const copying = ref(false);

const downloadProgress = ref({
  current: 0,
  total: 0,
  percentage: 0,
  status: ''
});

// Camera state
const showCamera = ref(false);
const cameraReady = ref(false);
const videoElement = ref(null);
const canvasElement = ref(null);
const cameraStream = ref(null);

// Engine cache
const engine = ref(null);

// --- Small utilities ---
function resetOutput() {
  result.value = '';
  model.value = '';
  error.value = '';
}

function setError(msg) {
  error.value = msg;
}

function clearProgressSoon() {
  setTimeout(() => {
    downloadProgress.value = { current: 0, total: 0, percentage: 0, status: '' };
  }, 1500);
}

function updateProgress(completed, total, status) {
  downloadProgress.value.current = completed;
  downloadProgress.value.total = total;
  downloadProgress.value.percentage = total > 0 ? (completed / total) * 100 : 0;
  downloadProgress.value.status = status;
}

function revokeBlobUrl(url) {
  if (url && typeof url === 'string' && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

// --- File input ---
function onFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) {
    imageFile.value = null;
    revokeBlobUrl(imageUrl.value);
    imageUrl.value = '';
    resetOutput();
    return;
  }

  imageFile.value = file;

  revokeBlobUrl(imageUrl.value);
  imageUrl.value = URL.createObjectURL(file);

  if (showCamera.value) stopCamera();

  resetOutput();
  setTimeout(() => tryAutoRun(), 100);
}

// --- Camera ---
async function toggleCamera() {
  if (showCamera.value) {
    stopCamera();
    return;
  }
  await startCamera();
}

async function startCamera() {
  try {
    setError('');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });

    cameraStream.value = stream;
    showCamera.value = true;

    await new Promise((r) => setTimeout(r, 100));

    const video = videoElement.value;
    if (!video) return;

    video.srcObject = stream;
    video.onloadedmetadata = () => {
      cameraReady.value = true;

      // Keep original behavior: auto-capture after ~2s when autoStart
      setTimeout(() => {
        if (cameraReady.value && showCamera.value) captureImage();
      }, 2000);
    };
  } catch (err) {
    console.error('Camera access error:', err);
    setError('Unable to access camera. Please check permissions and try again.');
    showCamera.value = false;
    cameraReady.value = false;
  }
}

function stopCamera() {
  if (cameraStream.value) {
    cameraStream.value.getTracks().forEach((t) => t.stop());
    cameraStream.value = null;
  }
  showCamera.value = false;
  cameraReady.value = false;
}

function captureImage() {
  if (!videoElement.value || !canvasElement.value || !cameraReady.value) {
    setError('Camera not ready. Please try again.');
    return;
  }

  const video = videoElement.value;
  const canvas = canvasElement.value;
  const ctx = canvas.getContext('2d');

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(
    (blob) => {
      if (!blob) return;

      revokeBlobUrl(imageUrl.value);

      imageFile.value = new File([blob], `camera-capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
      imageUrl.value = URL.createObjectURL(blob);

      resetOutput();
      stopCamera();

      setTimeout(() => tryAutoRun(), 100);
    },
    'image/jpeg',
    0.8
  );
}

// --- SmolVLM Engine ---
class SmolVLMInference {
  constructor(config) {
    this.modelId = 'HuggingFaceTB/SmolVLM-256M-Instruct';
    this.config = {
      text_config: {
        num_key_value_heads: config.text_config.num_key_value_heads,
        head_dim: config.text_config.head_dim,
        num_hidden_layers: config.text_config.num_hidden_layers,
        eos_token_id: config.text_config.eos_token_id,
        hidden_size: config.text_config.hidden_size
      },
      image_token_id: config.image_token_id
    };

    this.numKeyValueHeads = this.config.text_config.num_key_value_heads;
    this.headDim = this.config.text_config.head_dim;
    this.numHiddenLayers = this.config.text_config.num_hidden_layers;
    this.eosTokenId = this.config.text_config.eos_token_id;
    this.imageTokenId = this.config.image_token_id;
    this.hiddenSize = this.config.text_config.hidden_size;

    this.visionSession = null;
    this.embedSession = null;
    this.decoderSession = null;
    this.processor = null;
  }

  async loadModels() {
    try {
      updateProgress(0, 3, 'Initializing runtime...');

      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.logLevel = 'warning';

      if (typeof BigInt64ArrayConstructor === 'undefined') {
        throw new Error('BigInt64Array not supported in this browser.');
      }

      const modelId = this.modelId;
      const baseUrl = `https://huggingface.co/${modelId}/resolve/main/onnx/`;

      const modelFiles = [
        { name: 'vision_encoder_q4.onnx', fallback: 'vision_encoder.onnx', label: 'Vision Encoder' },
        { name: 'embed_tokens_q4.onnx', fallback: 'embed_tokens.onnx', label: 'Embed Tokens' },
        { name: 'decoder_model_merged_q4.onnx', fallback: 'decoder_model_merged.onnx', label: 'Decoder' }
      ];

      const sessionOptions = {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        executionMode: 'sequential',
        enableProfiling: false,
        enableCpuMemArena: false,
        enableMemPattern: false
      };

      // Optional WebGPU
      try {
        if (navigator.gpu && (await navigator.gpu.requestAdapter())) {
          sessionOptions.executionProviders.unshift('webgpu');
        }
      } catch {
        // ignore
      }

      const loadWithFallback = async (file, idx) => {
        updateProgress(idx, 3, `Downloading ${file.label}...`);
        const primaryUrl = baseUrl + file.name;

        try {
          return await ort.InferenceSession.create(primaryUrl, sessionOptions);
        } catch (err) {
          if (!file.fallback) throw err;
          const fallbackUrl = baseUrl + file.fallback;
          return await ort.InferenceSession.create(fallbackUrl, sessionOptions);
        }
      };

      this.visionSession = await loadWithFallback(modelFiles[0], 0);
      this.embedSession = await loadWithFallback(modelFiles[1], 1);
      this.decoderSession = await loadWithFallback(modelFiles[2], 2);

      updateProgress(3, 3, 'All models loaded.');
      clearProgressSoon();
      return true;
    } catch (err) {
      console.error('Error loading models:', err);

      const msg = String(err?.message || err);
      let friendly = `Loading failed: ${msg}`;

      if (msg.includes('fetch') || msg.includes('not found') || msg.includes('404')) {
        friendly = 'Model download failed. Please check your internet connection and try again.';
      } else if (msg.includes('BigInt64Array')) {
        friendly = 'Browser compatibility issue: BigInt64Array not supported. Please use Chrome 67+, Firefox 68+, or Safari 14+';
      } else if (msg.includes('WebAssembly')) {
        friendly = 'WebAssembly initialization failed. Please refresh the page or try a different browser.';
      } else if (msg.includes('webgpu')) {
        friendly = 'WebGPU initialization failed, falling back to CPU processing.';
      } else if (msg.includes('Aborted')) {
        friendly = 'Model loading was interrupted. The ONNX files may be corrupted or incompatible.';
      }

      downloadProgress.value.status = friendly;
      setError(friendly);
      return false;
    }
  }

  async officialPreprocessing(imageUrl, question) {
    const image = await load_image(imageUrl);

    if (!this.processor) {
      this.processor = await AutoProcessor.from_pretrained(this.modelId);
    }

    const messages = [
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: question }] }
    ];

    const prompt = this.processor.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true
    });

    return await this.processor(prompt, [image]);
  }

  getTensorData(t) {
    return t.data;
  }

  getNextToken(logits) {
    const logitsData = this.getTensorData(logits);
    const vocab = logits.dims[2];
    const lastTokenIndex = (logits.dims[1] - 1) * vocab;

    const lastLogits = Array.from(logitsData.slice(lastTokenIndex, lastTokenIndex + vocab));

    const temperature = 0.7;
    const topP = 0.9;

    const scaled = lastLogits.map((v) => v / temperature);
    const maxLogit = Math.max(...scaled);

    const exps = scaled.map((l) => Math.exp(l - maxLogit));
    const sumExps = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map((e) => e / sumExps);

    const sorted = probs
      .map((prob, idx) => ({ prob, idx }))
      .sort((a, b) => b.prob - a.prob);

    let cumulative = 0;
    let cutoff = sorted.length - 1;
    for (let i = 0; i < sorted.length; i++) {
      cumulative += sorted[i].prob;
      if (cumulative >= topP) {
        cutoff = i;
        break;
      }
    }

    const candidates = sorted.slice(0, cutoff + 1);
    const norm = candidates.reduce((acc, x) => acc + x.prob, 0);
    const normalized = candidates.map((x) => ({ idx: x.idx, prob: x.prob / norm }));

    const r = Math.random();
    let p = 0;
    for (const c of normalized) {
      p += c.prob;
      if (p >= r) return c.idx;
    }
    return normalized[0]?.idx ?? 0;
  }

  replaceImageEmbeddings(inputsEmbeds, inputIds, imageFeatures) {
    const ids = this.getTensorData(inputIds);
    const embedsData = new Float32Array(this.getTensorData(inputsEmbeds));
    const feats = this.getTensorData(imageFeatures);

    let featureIndex = 0;
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === BigIntConstructor(this.imageTokenId)) {
        const dst = i * this.hiddenSize;
        const src = featureIndex * this.hiddenSize;
        for (let j = 0; j < this.hiddenSize; j++) {
          embedsData[dst + j] = feats[src + j];
        }
        featureIndex++;
      }
    }

    return new ort.Tensor('float32', embedsData, inputsEmbeds.dims);
  }

  async generateText(imageUrl, question, maxNewTokens = 256) {
    const inputs = await this.officialPreprocessing(imageUrl, question);

    const batchSize = 1;

    const pastKeyValues = {};
    for (let layer = 0; layer < this.numHiddenLayers; layer++) {
      pastKeyValues[`past_key_values.${layer}.key`] = new ort.Tensor(
        'float32',
        new Float32Array(0),
        [batchSize, this.numKeyValueHeads, 0, this.headDim]
      );
      pastKeyValues[`past_key_values.${layer}.value`] = new ort.Tensor(
        'float32',
        new Float32Array(0),
        [batchSize, this.numKeyValueHeads, 0, this.headDim]
      );
    }

    let inputIds = inputs.input_ids;
    let attentionMask = inputs.attention_mask;

    const attentionData = this.getTensorData(attentionMask);
    const positionIdsData = new Array(attentionData.length);
    let pos = 0;
    for (let i = 0; i < attentionData.length; i++) {
      positionIdsData[i] = pos;
      pos += Number(attentionData[i]);
    }

    let positionIds = new ort.Tensor(
      'int64',
      new BigInt64ArrayConstructor(positionIdsData.map((x) => BigIntConstructor(x))),
      attentionMask.dims
    );

    const visionResult = await this.visionSession.run({
      pixel_values: inputs.pixel_values,
      pixel_attention_mask: new ort.Tensor(
        'bool',
        Array.from(this.getTensorData(inputs.pixel_attention_mask)).map((v) => v !== 0),
        inputs.pixel_attention_mask.dims
      )
    });

    const imageFeatures = visionResult.image_features;

    const generatedTokens = [];
    let outputText = '';

    let lastToken = null;
    let repeatCount = 0;
    const maxRepeat = 5;

    for (let i = 0; i < maxNewTokens; i++) {
      const embedResult = await this.embedSession.run({ input_ids: inputIds });
      let inputsEmbeds = embedResult.inputs_embeds;

      if (i === 0) {
        inputsEmbeds = this.replaceImageEmbeddings(inputsEmbeds, inputIds, imageFeatures);
      }

      const decoderResults = await this.decoderSession.run({
        inputs_embeds: inputsEmbeds,
        attention_mask: attentionMask,
        position_ids: positionIds,
        ...pastKeyValues
      });

      for (let layer = 0; layer < this.numHiddenLayers; layer++) {
        pastKeyValues[`past_key_values.${layer}.key`] = decoderResults[`present.${layer}.key`];
        pastKeyValues[`past_key_values.${layer}.value`] = decoderResults[`present.${layer}.value`];
      }

      const nextToken = this.getNextToken(decoderResults.logits);

      if (nextToken === lastToken) {
        repeatCount++;
        if (repeatCount > maxRepeat) break;
      } else {
        repeatCount = 0;
        lastToken = nextToken;
      }

      if (nextToken === this.eosTokenId) break;

      generatedTokens.push(nextToken);

      // next step inputs
      inputIds = new ort.Tensor(
        'int64',
        new BigInt64ArrayConstructor([BigIntConstructor(nextToken)]),
        [1, 1]
      );

      const lastPosition = Number(this.getTensorData(positionIds).at(-1));
      positionIds = new ort.Tensor(
        'int64',
        new BigInt64ArrayConstructor([BigIntConstructor(lastPosition + 1)]),
        [1, 1]
      );

      const maskOld = attentionMask.data;
      const newMask = new Array(maskOld.length + 1);
      for (let j = 0; j < maskOld.length; j++) newMask[j] = Number(maskOld[j]);
      newMask[newMask.length - 1] = 1;

      attentionMask = new ort.Tensor(
        'int64',
        new BigInt64ArrayConstructor(newMask.map((x) => BigIntConstructor(x))),
        [1, newMask.length]
      );

      // live partial output
      const currentText = this.processor.decode(generatedTokens, { skip_special_tokens: true });
      if (currentText.length > outputText.length) {
        outputText = currentText;
        result.value = outputText + '...';
        model.value = result.value;
      }
    }

    result.value = outputText.replace(/<[^>]+>/g, '').trim();
    model.value = result.value;
    return result.value;
  }
}

// --- Run ---
async function onRun() {
  await runLocalVision();
}

async function runLocalVision() {
  setError('');
  resetOutput();

  if (!imageFile.value) {
    setError('Please upload an image first');
    return;
  }

  loading.value = true;

  try {
    if (!engine.value) {
      const config = await AutoConfig.from_pretrained('HuggingFaceTB/SmolVLM-256M-Instruct');
      engine.value = new SmolVLMInference(config);

      const ok = await engine.value.loadModels();
      if (!ok) return;
    } else {
      // keep original behavior: hide lingering progress if any
      downloadProgress.value = { current: 0, total: 0, percentage: 0, status: '' };
    }

    await engine.value.generateText(imageUrl.value, settingsStore.visionPrompt, 256);

    if (result.value && result.value.trim()) {
      model.value = result.value;
      emit('textAvailable', result.value.trim());
    }
  } catch (err) {
    console.error(err);
    const msg = String(err?.message || err);
    setError(msg.includes('WebGPU') ? 'WebGPU unavailable. Please check browser compatibility or try a different one.' : `Inference error: ${msg}`);
  } finally {
    loading.value = false;
  }
}

async function tryAutoRun() {
  const shouldAutoRun = props.autoRun || settingsStore.visionAutoAnalysis;
  if (shouldAutoRun && imageFile.value && !loading.value && !result.value) {
    await onRun();
  }
}

// --- Clipboard ---
async function copyToClipboard() {
  if (!result.value) return;

  try {
    await navigator.clipboard.writeText(result.value);
    copying.value = true;
    setTimeout(() => (copying.value = false), 2000);
  } catch (err) {
    console.error('Failed to copy text:', err);

    // fallback
    const textArea = document.createElement('textarea');
    textArea.value = result.value;
    document.body.appendChild(textArea);
    textArea.select();

    try {
      document.execCommand('copy');
      copying.value = true;
      setTimeout(() => (copying.value = false), 2000);
    } catch (fallbackErr) {
      console.error('Fallback copy failed:', fallbackErr);
    } finally {
      document.body.removeChild(textArea);
    }
  }
}

onMounted(async () => {
  if (props.autoStart) {
    await startCamera();
  }
});

onUnmounted(() => {
  stopCamera();
  revokeBlobUrl(imageUrl.value);
});
</script>

<style scoped lang="scss">
@use '@/assets/theme';

.uploader {
  max-width: 600px;
  margin: 2rem auto;
  padding: 25px;
  background: theme.$ossia-light-background-2;
  color: theme.$ossia-text-light-1;
  border-radius: 7px;
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Fira Sans',
    'Droid Sans', 'Helvetica Neue', sans-serif;
  box-shadow: 0 3px 1px -2px rgba(0, 0, 0, 0.2), 0 2px 2px 0 rgba(0, 0, 0, 0.14),
    0 1px 5px 0 rgba(0, 0, 0, 0.12);
}

.uploader h2 {
  color: theme.$ossia-indigo;
  margin-bottom: 1.5rem;
  font-size: 1.8rem;
  font-weight: 600;
  text-align: center;
}

.field {
  margin-bottom: 1rem;
}

.field-hint {
  font-size: 0.85rem;
  color: theme.$ossia-text-light-2;
  margin-top: 0.25rem;
  font-style: italic;
}

label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: theme.$ossia-text-light-1;
}

input[type='file'],
input[type='text'] {
  width: 100%;
  padding: 12px;
  border-radius: 7px;
  border: 1px solid theme.$ossia-divider-light-1;
  background: theme.$ossia-white;
  color: theme.$ossia-text-light-1;
  font-family: inherit;
  transition: border-color 0.2s;
}

input[type='file']:focus,
input[type='text']:focus {
  outline: none;
  border-color: theme.$primary;
  box-shadow: 0 0 0 2px rgba(0, 182, 0, 0.2);
}

.model-selector {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.model-btn {
  flex: 1;
  padding: 10px 16px;
  border: 2px solid theme.$ossia-divider-light-1;
  background: theme.$ossia-white;
  color: theme.$ossia-text-light-1;
  border-radius: 7px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.2s ease;
  font-family: inherit;

  &.active {
    border-color: theme.$primary;
    background: theme.$primary;
    color: white;
  }

  &:hover:not(:disabled) {
    border-color: theme.$primary;
  }

  &:disabled {
    background: theme.$ossia-white-mute;
    color: theme.$ossia-text-light-2;
    cursor: not-allowed;
    opacity: 0.6;
  }
}

.api-warning {
  margin-top: 0.5rem;
  padding: 8px 12px;
  background: rgba(255, 193, 7, 0.1);
  color: #856404;
  border: 1px solid rgba(255, 193, 7, 0.3);
  border-radius: 6px;
  font-size: 0.9rem;
}

.input-group {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.input-group input[type='file'] {
  flex: 1;
}

.camera-btn {
  padding: 12px 16px;
  background: theme.$secondary;
  color: white;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  white-space: nowrap;
  transition: background 0.2s;
  font-family: inherit;
}

.camera-btn:hover:not(:disabled) {
  background: darken(theme.$secondary, 10%);
}

.camera-btn:disabled {
  background: theme.$ossia-divider-light-1;
  cursor: not-allowed;
}

.camera-section {
  margin: 1rem 0;
  padding: 1rem;
  background: theme.$ossia-white;
  border-radius: 7px;
  border: 2px solid theme.$ossia-divider-light-1;
}

.camera-container {
  position: relative;
  display: flex;
  justify-content: center;
  margin-bottom: 1rem;
}

.camera-video {
  max-width: 100%;
  max-height: 400px;
  border-radius: 7px;
  background: #000;
}

.camera-canvas {
  position: absolute;
  top: 0;
  left: 0;
}

.camera-controls {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  flex-wrap: wrap;
}

.camera-status {
  text-align: center;
  padding: 1rem;
  color: theme.$ossia-text-light-2;
  font-style: italic;
}

.capture-btn {
  padding: 12px 20px;
  background: theme.$primary;
  color: white;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  font-weight: 600;
  transition: background 0.2s;
  font-family: inherit;
}

.capture-btn:hover:not(:disabled) {
  background: darken(theme.$primary, 10%);
}

.capture-btn:disabled {
  background: theme.$ossia-divider-light-1;
  cursor: not-allowed;
}

.stop-camera-btn {
  padding: 12px 20px;
  background: #f44336;
  color: white;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  font-weight: 600;
  transition: background 0.2s;
  font-family: inherit;
}

.stop-camera-btn:hover {
  background: darken(#f44336, 10%);
}

.run-btn {
  display: block;
  width: 100%;
  padding: 14px;
  background: theme.$primary;
  color: white;
  font-weight: 600;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.2s;
  margin-top: 1rem;
  font-family: inherit;
  font-size: 1.05rem;
}

.run-btn:disabled {
  background: theme.$ossia-divider-light-1;
  cursor: not-allowed;
}

.run-btn:hover:not(:disabled) {
  background: darken(theme.$primary, 10%);
}

.auto-run-status {
  margin-top: 1rem;
  padding: 0.75rem;
  border-radius: 7px;
  text-align: center;
  font-weight: 500;
  font-size: 0.95rem;
}

.status-processing {
  background: rgba(0, 182, 0, 0.08);
  color: theme.$primary;
  border: 1px solid rgba(0, 182, 0, 0.2);
}

.error {
  margin-top: 1rem;
  padding: 12px;
  background: rgba(244, 67, 54, 0.1);
  color: #d32f2f;
  border: 1px solid rgba(244, 67, 54, 0.3);
  border-radius: 7px;
}

.switch-to-local-btn {
  margin-top: 10px;
  padding: 8px 16px;
  background: theme.$primary;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background-color 0.2s;
}

.switch-to-local-btn:hover {
  background: darken(theme.$primary, 10%);
}

.result {
  margin-top: 1.5rem;
  padding: 1rem;
  background: theme.$ossia-white;
  border: 1px solid theme.$ossia-divider-light-1;
  border-radius: 7px;
  white-space: pre-wrap;
}

.result-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.result-actions {
  display: flex;
  gap: 0.5rem;
}

.result h3 {
  margin: 0;
  color: theme.$ossia-text-light-1;
}

.copy-btn,
.context-btn {
  padding: 8px 16px;
  background: theme.$secondary;
  color: white;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  transition: background 0.2s;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-family: inherit;
}

.context-btn {
  background: theme.$primary;
}

.copy-btn:hover:not(:disabled),
.context-btn:hover:not(:disabled) {
  opacity: 0.9;
}

.copy-btn:disabled {
  background: theme.$ossia-divider-light-1;
  cursor: not-allowed;
}

.download-progress {
  margin: 1rem 0;
  padding: 1rem;
  background: theme.$ossia-white;
  border-radius: 7px;
  border-left: 4px solid theme.$primary;
}

.download-progress h4 {
  color: theme.$ossia-text-light-1;
  margin-bottom: 0.5rem;
}

.progress-bar {
  width: 100%;
  height: 20px;
  background: theme.$ossia-divider-light-1;
  border-radius: 10px;
  overflow: hidden;
  margin: 0.5rem 0;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, theme.$primary, lighten(theme.$primary, 20%));
  border-radius: 10px;
  transition: width 0.3s ease;
}

.download-status {
  font-size: 0.9rem;
  color: theme.$ossia-text-light-2;
  font-style: italic;
}

@keyframes pulse {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
  100% {
    opacity: 1;
  }
}
</style>