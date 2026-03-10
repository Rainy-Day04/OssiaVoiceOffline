<template>
  <div :class="embedded ? 'predictor-embedded' : 'predictor-overlay'" v-if="isVisible || embedded" @click="embedded ? null : handleOverlayClick">
    <div :class="embedded ? 'predictor-container-embedded' : 'predictor-container'" @click.stop>
      <div class="header" v-if="!embedded">
        <button class="close-btn" @click="closePredictor">×</button>
      </div>

      <div class="app-container">
        <div v-if="loadingModel && !error" class="loading">
          Loading model... ({{ progress }}%)
          <div class="progress-container">
            <div class="progress-bar" :style="{ width: progress + '%' }"></div>
          </div>
        </div>

        <div v-if="error" class="error">
          <div>{{ error }}</div>
          <button class="retry-btn" @click="retryLoadModel">Retry Loading Prediction Model</button>
          <div class="error-note">Note: The keyboard below still works for manual typing.</div>
        </div>

        <div v-if="!embedded" class="text-display">
          <div class="input-text">{{ messageStore.scriberPhrase || 'Start typing...' }}</div>
        </div>

        <div v-if="suggestions.length" class="predictions-top">
          <button
            v-for="(word, idx) in suggestions"
            :key="idx"
            :class="['prediction-button', getPredictionClass(idx)]"
            @click="insertWord(word)"
          >
            {{ word }}
          </button>
        </div>

        <div class="keyboard">
          <div class="keyboard-row">
            <button v-for="key in qwertyRow1" :key="key" class="key" @click="insertChar(key)">
              {{ getKeyDisplay(key) }}
            </button>
            <button class="key key-backspace" @click="backspace">
              ⌫
            </button>
          </div>

          <div class="keyboard-row">
            <button v-for="key in qwertyRow2" :key="key" class="key" @click="insertChar(key)">
              {{ getKeyDisplay(key) }}
            </button>
            <button class="key key-enter" @click="onGenerate">
              ↵
            </button>
          </div>

          <div class="keyboard-row">
            <button class="key key-shift" @click="toggleShift" :class="{ active: isShiftPressed }">
              ⇧
            </button>
            <button v-for="key in qwertyRow3" :key="key" class="key" @click="insertChar(key)">
              {{ getKeyDisplay(key) }}
            </button>
            <button class="key key-shift" @click="toggleShift" :class="{ active: isShiftPressed }">
              ⇧
            </button>
          </div>

          <div class="keyboard-row">
            <button class="key key-space" @click="insertChar(' ')">Space</button>
            <button class="key key-nav" @click="moveCursor(-1)">‹</button>
            <button class="key key-nav" @click="moveCursor(1)">›</button>
          </div>
        </div>

      <div class="control-buttons">
        <button class="control-btn" @click="clearInput">Clear</button>
        <button class="control-btn predict-btn" :disabled="loadingModel || loading" @click="onGenerate">
          {{ loading ? "Predicting..." : "Predict" }}
        </button>
      </div>

      <div v-if="copyStatus" class="copy-status">
        {{ copyStatus }}
      </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onUnmounted, toRefs } from "vue";
import { AutoTokenizer, AutoModelForCausalLM } from "@huggingface/transformers";
import { useMessageStore } from "@/stores/MessageStore.js";
import { useSettingsStore } from "@/stores/SettingsStore.js";

if (!window.__predictorGlobalState) {
  window.__predictorGlobalState = {
    tokenizer: null,
    model: null,
    loading: false,
    loadPromise: null,
    loadAttempts: 0,
    loadedSuccessfully: false
  };
  console.log('[MyPredictor] Initialized global state');
}

const globalState = window.__predictorGlobalState;
const MAX_LOAD_ATTEMPTS = 3;

const cleanupGlobalModel = () => {
  console.log('[MyPredictor] Cleaning up previous model resources');
  if (globalState.model) {
    try {
      if (typeof globalState.model.dispose === 'function') {
        globalState.model.dispose();
      }
    } catch (e) {
      console.warn('[MyPredictor] Error disposing model:', e);
    }
    globalState.model = null;
  }
  if (globalState.tokenizer) {
    try {
      if (typeof globalState.tokenizer.dispose === 'function') {
        globalState.tokenizer.dispose();
      }
    } catch (e) {
      console.warn('[MyPredictor] Error disposing tokenizer:', e);
    }
    globalState.tokenizer = null;
  }
  globalState.loadPromise = null;
  globalState.modelLoading = false;
  globalState.loadAttempts = 0;
  globalState.modelLoadedSuccessfully = false;

  if (typeof window !== 'undefined' && window.gc) {
    try {
      window.gc();
      console.log('[MyPredictor] Manual GC triggered');
    } catch (e) {
      console.warn('[MyPredictor] Error triggering GC:', e);
    }
  }
};

const props = defineProps({
  isVisible: {
    type: Boolean,
    default: false
  },
  embedded: {
    type: Boolean,
    default: false
  }
});

const { isVisible, embedded } = toRefs(props);

const emit = defineEmits(['close']);

const messageStore = useMessageStore();
const settingsStore = useSettingsStore();
const suggestions = ref([]);
const loadingModel = ref(true);
const loading = ref(false);
const error = ref(null);
const progress = ref(0);
const lastGeneration = ref(null);
const currentBackend = ref("WASM");
const currentModel = ref("Loading...");
const copyStatus = ref('');
const isAutoPasting = ref(false);

const isShiftPressed = ref(false);
const cursorPosition = ref(0);

const qwertyRow1 = ref(['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P']);
const qwertyRow2 = ref(['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L']);
const qwertyRow3 = ref(['Z', 'X', 'C', 'V', 'B', 'N', 'M']);

const tokenizerRef = ref(globalState.tokenizer);
const modelRef = ref(globalState.model);

const modelLoadAttempted = ref(false);
const cancelled = ref(false);
const isLoadingModel = ref(false);
let loadDebounceTimer = null;

const initializeFromCache = () => {
  console.log('[MyPredictor] initializeFromCache called');
  console.log('[MyPredictor] Global state:', {
    hasGlobalModel: !!globalState.model,
    hasGlobalTokenizer: !!globalState.tokenizer,
    loadedSuccessfully: globalState.loadedSuccessfully,
    loadAttempts: globalState.loadAttempts,
    loading: globalState.loading
  });
  console.log('[MyPredictor] Component state:', {
    hasModelRef: !!modelRef.value,
    hasTokenizerRef: !!tokenizerRef.value,
    loadingModel: loadingModel.value,
    modelLoadAttempted: modelLoadAttempted.value,
    cancelled: cancelled.value,
    error: error.value
  });

  if (globalState.model && globalState.tokenizer) {
    console.log('[MyPredictor] Syncing component refs with global cache');
    tokenizerRef.value = globalState.tokenizer;
    modelRef.value = globalState.model;
    loadingModel.value = false;
    modelLoadAttempted.value = true;
    error.value = null;
    console.log('[MyPredictor] Sync complete');
  } else {
    console.log('[MyPredictor] No global model to sync');
  }
};

console.log('[MyPredictor] Component script executing');
initializeFromCache();

const closePredictor = () => {
  emit('close');
};

const handleOverlayClick = () => {
  emit('close');
};

const detectBackend = () => (typeof navigator !== "undefined" && "gpu" in navigator) ? "WebGPU" : "WASM";

const getKeyDisplay = (key) => {
  return isShiftPressed.value ? key.toUpperCase() : key.toLowerCase();
};

const getPredictionClass = (idx) => {
  if (idx === 0) return 'primary';
  if (idx === 1) return 'secondary';
  if (idx === 2) return 'tertiary';
  return '';
};

const insertChar = (char) => {
  const actualChar = isShiftPressed.value ? char.toUpperCase() : char.toLowerCase();
  const pos = cursorPosition.value || messageStore.scriberPhrase.length;
  messageStore.scriberPhrase = messageStore.scriberPhrase.slice(0, pos) + actualChar + messageStore.scriberPhrase.slice(pos);
  cursorPosition.value = pos + 1;

  if (actualChar === ' ') {
    setTimeout(() => onGenerate(), 100);
  }
};

const backspace = () => {
  if (messageStore.scriberPhrase.length > 0) {
    const pos = cursorPosition.value || messageStore.scriberPhrase.length;
    if (pos > 0) {
      messageStore.scriberPhrase = messageStore.scriberPhrase.slice(0, pos - 1) + messageStore.scriberPhrase.slice(pos);
      cursorPosition.value = pos - 1;
    }
  }
};

const toggleShift = () => {
  isShiftPressed.value = !isShiftPressed.value;
};

const moveCursor = (direction) => {
  const newPos = Math.max(0, Math.min(messageStore.scriberPhrase.length, cursorPosition.value + direction));
  cursorPosition.value = newPos;
};

const clearInput = () => {
  messageStore.scriberPhrase = "";
  suggestions.value = [];
  cursorPosition.value = 0;
};

const loadModel = async () => {
  if (globalState.model && globalState.tokenizer) {
    console.log('[MyPredictor] Model already exists globally, reusing');
    tokenizerRef.value = globalState.tokenizer;
    modelRef.value = globalState.model;
    loadingModel.value = false;
    modelLoadAttempted.value = true;
    return;
  }

  if (globalState.loadAttempts >= MAX_LOAD_ATTEMPTS) {
    console.error('[MyPredictor] Max load attempts reached:', globalState.loadAttempts);
    error.value = 'Model loading failed after multiple attempts. Please refresh the page to try again.';
    loadingModel.value = false;
    return;
  }

  if (globalState.loadPromise) {
    console.log('[MyPredictor] Load already in progress, waiting');
    try {
      await globalState.loadPromise;
      tokenizerRef.value = globalState.tokenizer;
      modelRef.value = globalState.model;
      loadingModel.value = false;
      return;
    } catch (e) {
      return;
    }
  }

  if (modelLoadAttempted.value || cancelled.value || isLoadingModel.value || globalState.loading) {
    console.log('[MyPredictor] Load skipped:', {
      modelLoadAttempted: modelLoadAttempted.value,
      cancelled: cancelled.value,
      isLoadingModel: isLoadingModel.value,
      globalLoading: globalState.loading
    });
    return;
  }

  globalState.loadAttempts++;
  modelLoadAttempted.value = true;
  isLoadingModel.value = true;
  globalState.modelLoading = true;
  console.log('[MyPredictor] Starting model load:', globalState.loadAttempts, '/', MAX_LOAD_ATTEMPTS);

  globalState.loadPromise = (async () => {
    try {
      progress.value = 0;
      error.value = '';
      currentBackend.value = detectBackend();

      const opts = {
        dtype: 'q4',
        device: 'wasm',
        progress_callback: (p) => {
          if (cancelled.value) return;
          if (p?.loaded && p?.total) {
            const pct = Math.floor((p.loaded / p.total) * 100);
            progress.value = pct;
          }
        },
      };
      const modelId = "onnx-community/Qwen2.5-0.5B-Instruct";
      console.log('[MyPredictor] Loading tokenizer');
      const tok = await AutoTokenizer.from_pretrained(modelId, opts);

      console.log('[MyPredictor] Loading model');
      const mdl = await AutoModelForCausalLM.from_pretrained(modelId, opts);

      console.log('[MyPredictor] Storing model in global cache');
      globalState.tokenizer = tok;
      globalState.model = mdl;
      globalState.modelLoadedSuccessfully = true;
      console.log('[MyPredictor] Global cache updated:', {
        hasGlobalTokenizer: !!globalState.tokenizer,
        hasGlobalModel: !!globalState.model,
        successFlag: globalState.modelLoadedSuccessfully
      });

      if (!cancelled.value) {
        tokenizerRef.value = tok;
        modelRef.value = mdl;
        currentModel.value = modelId.split("/").pop();
        loadingModel.value = false;
      }

      isLoadingModel.value = false;
      globalState.modelLoading = false;
      console.log('[MyPredictor] Model loaded successfully');
    } catch (e) {
      console.error('[MyPredictor] Model loading error:', e);
      globalState.modelLoading = false;
      globalState.loadPromise = null;
      if (!cancelled.value && e.message !== 'Cancelled') {
        error.value = `Model loading failed: ${e?.message || e}. Try clicking Retry or closing other browser tabs to free up memory.`;
        loadingModel.value = false;
        isLoadingModel.value = false;
      }
      throw e;
    }
  })();

  try {
    await globalState.loadPromise;
  } finally {
    globalState.loadPromise = null;
  }
};

watch(() => (isVisible?.value || embedded?.value), (visible) => {
  console.log('[MyPredictor] Visibility changed:', visible);
  console.log('[MyPredictor] Watch state:', {
    visible,
    isVisible: isVisible?.value,
    embedded: embedded?.value,
    globalModelExists: !!(globalState.model && globalState.tokenizer),
    globalLoadedSuccessfully: globalState.loadedSuccessfully,
    globalLoadAttempts: globalState.loadAttempts,
    globalLoading: globalState.loading,
    componentModelLoadAttempted: modelLoadAttempted.value,
    componentCancelled: cancelled.value,
    componentError: error.value,
    aiEnabled: settingsStore.predictorEnableAI
  });

  if (!visible) {
    console.log('[MyPredictor] Component hiding, clearing debounce timer');
    if (loadDebounceTimer) {
      clearTimeout(loadDebounceTimer);
      loadDebounceTimer = null;
    }
    return;
  }

  console.log('[MyPredictor] Component visible, checking load state');

  cancelled.value = false;

  if (globalState.modelLoadedSuccessfully || (globalState.model && globalState.tokenizer)) {
    console.log('[MyPredictor] Model already loaded globally, syncing from cache');
    initializeFromCache();
    return;
  }

  if (error.value && globalState.loadAttempts > 0) {
    console.log('[MyPredictor] Previous load failed, waiting for manual retry');
    loadingModel.value = false;
    return;
  }

  if (loadDebounceTimer) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }

  if (globalState.loadAttempts === 0 && !isLoadingModel.value && !globalState.modelLoading) {
    console.log('[MyPredictor] First load, starting debounce');
    loadDebounceTimer = setTimeout(() => {
      if ((isVisible?.value || embedded?.value) && !cancelled.value && !isLoadingModel.value) {
        console.log('[MyPredictor] Debounce complete, calling loadModel');
        loadModel();
      } else {
        console.log('[MyPredictor] Debounce complete, load skipped');
      }
    }, 300);
  } else {
    console.log('[MyPredictor] Load conditions not met:', {
      globalLoadAttempts: globalState.loadAttempts,
      isLoadingModel: isLoadingModel.value,
      globalLoading: globalState.loading
    });
  }
}, { immediate: true });

onUnmounted(() => {
  console.log('[MyPredictor] Component unmounting');

  if (loadDebounceTimer) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }

  cancelled.value = true;
  isLoadingModel.value = false;

  console.log('[MyPredictor] Component unmounted, global model preserved:', !!globalState.model);
});

const retryLoadModel = () => {
  console.log('[MyPredictor] Retry requested');

  if (loadDebounceTimer) {
    clearTimeout(loadDebounceTimer);
    loadDebounceTimer = null;
  }

  cleanupGlobalModel();

  modelLoadAttempted.value = false;
  cancelled.value = false;
  isLoadingModel.value = false;
  globalState.modelLoading = false;
  globalState.loadPromise = null;
  loadingModel.value = true;
  error.value = '';

  setTimeout(() => {
    loadModel();
  }, 500);
};

const decodeId = (tok, id) => tok.decode([id], { clean_up_tokenization_spaces: false, skip_special_tokens: true });

const softmaxTopKWithLogits = (row, k) => {
  let maxVal = -Infinity;
  for (let i = 0; i < row.length; i++) if (row[i] > maxVal) maxVal = row[i];
  const exps = new Float32Array(row.length);
  let sum = 0;
  for (let i = 0; i < row.length; i++) { const v = Math.exp(row[i] - maxVal); exps[i] = v; sum += v; }
  const probs = new Float32Array(row.length);
  for (let i = 0; i < row.length; i++) probs[i] = exps[i] / sum;
  const idxs = Array.from({ length: row.length }, (_, i) => i).sort((a,b)=>probs[b]-probs[a]);
  return idxs.slice(0, k).map(id => ({ id, prob: probs[id] }));
};

const nextWordSuggestions = async (prompt, k = 5) => {
  const tok = tokenizerRef.value, model = modelRef.value;
  const normalized = /\s$/.test(prompt) ? prompt : prompt + " ";
  const inputs = await tok(normalized, { return_tensors: "pt" });
  const outputs = await model(inputs);
  const logits = outputs.logits;
  const [/* batch */, seq, vocab] = logits.dims;
  const row = logits.data.subarray((seq - 1) * vocab, seq * vocab);

  const topN = softmaxTopKWithLogits(row, 40);

  const out = [];
  const seen = new Set();
  for (const { id } of topN) {
    const piece = decodeId(tok, id);
    if (!/^ [A-Za-z]/.test(piece)) continue;

    let text = normalized + piece;
    let built = piece.trim();

    for (let step = 0; step < 3; step++) {
      if (/\s$/.test(built) || /[^\p{L}'’-]$/.test(built)) break;
      const tmp = await tok(text, { return_tensors: "pt" });
      const out2 = await model(tmp);
      const logits2 = out2.logits;
      const [/* batch */, seq2, voc2] = logits2.dims;
      const row2 = logits2.data.subarray((seq2 - 1) * voc2, seq2 * voc2);
      let best = 0, bestVal = -Infinity;
      for (let i=0;i<row2.length;i++) if (row2[i]>bestVal){bestVal=row2[i];best=i;}
      const nextPiece = decodeId(tok, best);
      text += nextPiece;
      built += nextPiece;
    }

    const word = built.split(/\s+/)[0];
    if (word.length>1 && !seen.has(word.toLowerCase())) {
      out.push(word);
      seen.add(word.toLowerCase());
    }
    if (out.length >= k) break;
  }
  return out;
};

const buildPrompt = () => {
  let prompt = "";

  if (settingsStore.predictorUseBackstory && settingsStore.backstory?.trim()) {
    prompt += settingsStore.backstory.trim() + "\n\n";
  }

  if (settingsStore.predictorUseVisionContext && settingsStore.context && settingsStore.context.trim()) {
    console.log('[MyPredictor] Adding vision/context to prompt:', settingsStore.context);
    prompt += "Vision/context:\n" + settingsStore.context.trim() + "\n\n";
  }

  if (settingsStore.predictorUseHistory && messageStore.messageHistory && messageStore.messageHistory.length > 0) {
    console.log('[MyPredictor] Full message history:', messageStore.messageHistory);

    prompt += "Recent conversation:\n";

    const recentMessages = messageStore.messageHistory.slice(-5);
    console.log('[MyPredictor] Recent messages used for context:', recentMessages);

    for (const msg of recentMessages) {
      const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
      prompt += `${role}: ${msg.content}\n`;
    }
    prompt += "\n";
  } else {
    console.log('[MyPredictor] No message history available or disabled in settings');
  }

  if (messageStore.scriberPhrase.trim()) {
    prompt += "Current input: " + messageStore.scriberPhrase.trim();
  }

  console.log('[MyPredictor] Final prompt for prediction:', prompt);
  return prompt;
};

const onGenerate = async () => {
  if (!messageStore.scriberPhrase.trim()) { error.value = "Please type something"; return; }
  if (!modelRef.value || !tokenizerRef.value) { error.value = "Model not loaded yet!"; return; }

  loading.value = true; error.value = null; suggestions.value = [];
  const start = Date.now();
  try {
    const words = await nextWordSuggestions(buildPrompt(), 8);
    suggestions.value = words;
    lastGeneration.value = { time: Date.now()-start };
  } catch (e) {
    error.value = `Prediction failed: ${e.message}`;
  } finally {
    loading.value = false;
  } 
};

const insertWord = (word) => {
  const pos = cursorPosition.value || messageStore.scriberPhrase.length;
  const sep = (pos === 0 || messageStore.scriberPhrase[pos-1] === " ") ? "" : " ";
  messageStore.scriberPhrase = messageStore.scriberPhrase.slice(0, pos) + sep + word + messageStore.scriberPhrase.slice(pos);
  cursorPosition.value = pos + sep.length + word.length;
  setTimeout(()=>onGenerate(),100);
};

const copyAllSuggestions = async () => {
  try {
    const inputText = messageStore.scriberPhrase.trim();
    if (!inputText) return;
    await navigator.clipboard.writeText(inputText);
    copyStatus.value = 'Copied!';
    setTimeout(() => {
      copyStatus.value = '';
    }, 2000);
  } catch (error) {
    const textArea = document.createElement('textarea');
    textArea.value = messageStore.scriberPhrase.trim();
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
    copyStatus.value = 'Copied!';
    setTimeout(() => {
      copyStatus.value = '';
    }, 2000);
  }
};

const copyToCurrentList = async () => {
  try {
    const inputText = messageStore.interlocutorPhrase.trim();
    if (!inputText) {
      copyStatus.value = 'No text to copy';
      setTimeout(() => copyStatus.value = '', 3000);
      return;
    }

    isAutoPasting.value = true;
    copyStatus.value = 'Copying & Pasting...';

    await navigator.clipboard.writeText(inputText);

    const words = inputText.split(/\s+/).filter(word => word.length > 0);
    const addedWords = messageStore.addWordsWithPreselection(words);

    if (addedWords.length > 0) {
      copyStatus.value = `Added ${addedWords.length} words to suggestions!`;
    } else {
      copyStatus.value = 'All words already in suggestions!';
    }

    setTimeout(() => {
      emit('close');
    }, 1000);

    setTimeout(() => {
      copyStatus.value = '';
      isAutoPasting.value = false;
    }, 3000);

  } catch (error) {
    console.error('Copy to current list failed:', error);

    try {
      const inputText = messageStore.scriberPhrase.trim();
      if (inputText) {
        const words = inputText.split(/\s+/).filter(word => word.length > 0);
        const addedWords = messageStore.addWordsWithPreselection(words);

        if (addedWords.length > 0) {
          copyStatus.value = `Added ${addedWords.length} words to suggestions!`;
        } else {
          copyStatus.value = 'All words already in suggestions!';
        }

        setTimeout(() => {
          emit('close');
        }, 1000);
      }
    } catch (fallbackError) {
      copyStatus.value = 'Paste failed';
    }

    setTimeout(() => {
      copyStatus.value = '';
      isAutoPasting.value = false;
    }, 3000);
  }
};
</script>

<style scoped lang="scss">
@use '@/assets/theme';


.predictor-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: transparent;
  z-index: 1000;
  display: flex;
  align-items: flex-end;
}

.predictor-container {
  width: 100%;
  height: 50vh;
  background: theme.$ossia-white;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  overflow-y: auto;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.15);
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: theme.$ossia-text-light-1;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px 20px 10px;
  border-bottom: 1px solid theme.$ossia-divider-light-1;
  background: theme.$ossia-light-background-2;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;

  h1 {
    font-size: 1.4rem;
    color: theme.$primary;
    margin: 0;
    font-weight: 600;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.8rem;
    color: theme.$ossia-text-light-2;
    cursor: pointer;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    transition: all 0.2s ease;

    &:hover {
      background: theme.$ossia-divider-light-1;
      color: theme.$ossia-text-light-1;
    }
  }
}

.app-container {
  padding: 15px 20px 20px;
  height: calc(100% - 70px);
  overflow-y: auto;
}

.predictor-embedded .app-container {
  padding: 15px 20px 20px;
  height: 100%;
  overflow-y: auto;
}

.loading {
  text-align: center;
  padding: 15px;
  color: theme.$ossia-text-light-2;

  .progress-container {
    margin-top: 10px;
    background: theme.$ossia-white-mute;
    border-radius: 4px;
    height: 6px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: theme.$secondary;
    border-radius: 4px;
    transition: width 0.3s ease;
  }
}

.error {
  background: #fee2e2;
  border: 1px solid #fca5a5;
  color: #dc2626;
  padding: 15px;
  border-radius: 6px;
  margin-bottom: 15px;

  div {
    margin-bottom: 10px;
  }

  .error-note {
    font-size: 0.85rem;
    margin-top: 10px;
    color: #991b1b;
    font-style: italic;
  }

  .retry-btn {
    background: theme.$primary;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: background 0.2s;

    &:hover {
      background: darken(theme.$primary, 10%);
    }
  }
}

.text-display {
  background: theme.$ossia-white;
  border: 2px solid theme.$ossia-divider-light-1;
  border-radius: 8px;
  padding: 15px;
  margin-bottom: 12px;
  min-height: 50px;

  .input-text {
    font-size: 1.1rem;
    line-height: 1.4;
    color: theme.$ossia-text-light-1;

    &:empty::before {
      content: 'Start typing...';
      color: theme.$ossia-text-light-2;
    }
  }
}

.predictions-top {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
  padding: 12px;
  background: rgba(0, 182, 0, 0.05);
  border-radius: 8px;
  min-height: 50px;

  .prediction-button {
    padding: 10px 16px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.95rem;
    transition: all 0.2s ease;
    flex-shrink: 0;

    &.primary {
      background: #8B5CF6;
      color: white;
      font-size: 1.05rem;
    }

    &.secondary {
      background: #F59E0B;
      color: white;
    }

    &.tertiary {
      background: #10B981;
      color: white;
    }

    &:not(.primary):not(.secondary):not(.tertiary) {
      background: theme.$ossia-white;
      color: theme.$ossia-text-light-1;
      border: 2px solid theme.$ossia-divider-light-1;
    }

    &:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    &:active {
      transform: translateY(0);
    }
  }
}

.keyboard {
  background: #F5F5F5;
  padding: 10px;
  border-radius: 12px;
  margin-bottom: 15px;

  .keyboard-row {
    display: flex;
    gap: 4px;
    justify-content: stretch;
    margin-bottom: 5px;

    &:last-child {
      margin-bottom: 0;
    }
  }

  .key {
    background: white;
    border: 2px solid #ddd;
    border-radius: 6px;
    padding: 8px 4px;
    cursor: pointer;
    font-weight: 600;
    flex: 1;
    min-width: 0;
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    font-size: 1rem;

    &:hover {
      background: #f0f0f0;
      border-color: theme.$primary;
    }

    &:active {
      background: #e0e0e0;
      transform: scale(0.95);
    }

    &.key-space {
      flex: 6;
    }

    &.key-backspace,
    &.key-enter {
      flex: 1.5;
    }

    &.key-shift {
      flex: 1.5;
      background: #e0e0e0;
      font-weight: 700;

      &.active {
        background: theme.$primary;
        color: white;
        border-color: theme.$primary;
      }
    }

    &.key-backspace,
    &.key-enter {
      background: #e0e0e0;
      font-weight: 700;
    }

    &.key-nav {
      background: #c0c0c0;
      font-size: 1.2rem;
      font-weight: 700;
      flex: 1.2;
    }
  }
}.control-buttons {
  display: flex;
  gap: 8px;
  margin-bottom: 15px;

  .control-btn {
    padding: 8px 12px;
    border: 1px solid theme.$ossia-divider-light-1;
    border-radius: 6px;
    background: theme.$ossia-white;
    color: theme.$ossia-text-light-1;
    cursor: pointer;
    font-weight: 500;
    font-size: 0.9rem;
    transition: all 0.2s ease;

    &:hover:not(:disabled) {
      background: theme.$ossia-light-background-2;
    }

    &.predict-btn {
      background: theme.$primary;
      color: white;
      border-color: theme.$primary;

      &:hover:not(:disabled) {
        background: darken(theme.$primary, 5%);
      }
    }

    &.copy-paste-btn {
      background: #10B981;
      color: white;
      border-color: #10B981;

      &:hover:not(:disabled) {
        background: darken(#10B981, 5%);
      }
    }

    &:disabled {
      background: theme.$ossia-divider-light-1;
      cursor: not-allowed;
    }
  }
}

.copy-status {
  text-align: center;
  padding: 8px;
  background: #dcfce7;
  border: 1px solid #16a34a;
  color: #15803d;
  border-radius: 6px;
  margin-bottom: 15px;
  font-size: 0.9rem;
  font-weight: 500;
}

.predictor-embedded {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.predictor-container-embedded {
  width: 100%;
  height: 100%;
  background: theme.$ossia-white;
  border-radius: 8px;
  overflow-y: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: theme.$ossia-text-light-1;
  display: flex;
  flex-direction: column;
}
</style>
