/**
 * Web Worker for Whisper Speech Recognition
 * -----------------------------------------
 * This worker handles offline speech-to-text processing using Hugging Face's Transformers.js
 * and the Whisper model. It runs in a separate thread to keep the main UI responsive
 * while performing computationally intensive speech recognition tasks.
 * 
 * Communication with main thread:
 * - Main thread sends messages with {type, data}
 * - Worker responds with {status, ...additionalData}
 * 
 * @module whisper-worker
 * @author OssiaVoiceOffline Team
 */

/**
 * ATTRIBUTION NOTICE:
 * ------------------
 * This implementation uses techniques inspired by the AlphaCache protocol
 * developed by xenova.
 * Original work: https://github.com/huggingface/transformers.js/blob/main/examples/webgpu-whisper/src/worker.js
 * License:  Apache License Version 2.0
 */
import {
  AutoTokenizer,
  AutoProcessor,
  WhisperForConditionalGeneration,
  TextStreamer,
  full,
} from '@huggingface/transformers';

/**
 * Maximum number of tokens to generate for each audio segment
 * Limits the length of transcription to prevent excessive processing time
 * @constant {number}
 */
const MAX_NEW_TOKENS = 64;

/**
 * Singleton class that manages the Whisper speech recognition pipeline
 * Ensures model resources are loaded only once and reused across processing requests
 * @class AutomaticSpeechRecognitionPipeline
 */
class AutomaticSpeechRecognitionPipeline {
  /** @type {string|null} ID of the model to load */
  static model_id = null;
  
  /** @type {Object|null} Tokenizer instance for text processing */
  static tokenizer = null;
  
  /** @type {Object|null} Processor for audio feature extraction */
  static processor = null;
  
  /** @type {Object|null} The Whisper model instance */
  static model = null;

  /**
   * Gets or creates pipeline components (tokenizer, processor, model)
   * Uses the nullish coalescing operator (??) to implement lazy loading
   * 
   * @param {Function|null} progress_callback - Optional callback for loading progress updates
   * @returns {Promise<Array>} Promise resolving to [tokenizer, processor, model]
   */
  static async getInstance(progress_callback = null) {
      this.model_id = 'onnx-community/whisper-base';

      this.tokenizer ??= AutoTokenizer.from_pretrained(this.model_id, {
          progress_callback,
      });
      this.processor ??= AutoProcessor.from_pretrained(this.model_id, {
          progress_callback,
      });

      this.model ??= WhisperForConditionalGeneration.from_pretrained(this.model_id, {
          dtype: {
              encoder_model: 'fp32', // 'fp16' works too but may affect quality
              decoder_model_merged: 'q4', // or 'fp32' ('fp16' is broken in current implementations)
          },
          device: 'webgpu', // Uses GPU acceleration when available
          progress_callback,
      });

      return Promise.all([this.tokenizer, this.processor, this.model]);
  }
}

/**
 * Flag indicating whether audio processing is currently in progress
 * Prevents concurrent processing of multiple audio streams
 * @type {boolean}
 */
let processing = false;

/**
 * Buffer for storing audio data between processing cycles
 * @type {Array}
 */
let audioBuffer = [];

/**
 * Process audio data and generate transcription
 * Sends incremental updates to main thread during processing
 * 
 * @async
 * @param {Object} params - Processing parameters
 * @param {Float32Array} params.audio - Audio data as float array
 * @param {string} params.language - Language code (e.g., 'en')
 * @returns {Promise<void>}
 */
async function generate({ audio, language }) {
  // Skip if already processing
  if (processing) return;
  processing = true;

  // Tell the main thread we are starting
  self.postMessage({ status: 'start' });

  // Retrieve the text-generation pipeline
  const [tokenizer, processor, model] = await AutomaticSpeechRecognitionPipeline.getInstance();

  // Performance tracking variables
  let startTime;
  let numTokens = 0;
  
  /**
   * Callback function for streaming intermediate results
   * Calculates tokens per second for performance monitoring
   * @param {string} output - Current partial transcription text
   */
  const callback_function = (output) => {
      // Initialize startTime on first token
      startTime ??= performance.now();

      let tps;
      if (numTokens++ > 0) {
          tps = numTokens / (performance.now() - startTime) * 1000;
      }
      
      // Send update to main thread with partial result
      self.postMessage({
          status: 'update',
          output, 
          tps, 
          numTokens,
      });
  }

  // Create a text streamer for incremental results
  const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function,
  });

  // Process audio features
  const inputs = await processor(audio);

  // Generate transcription with streaming updates
  const outputs = await model.generate({
      ...inputs,
      max_new_tokens: MAX_NEW_TOKENS,
      language,
      streamer,
  });

  // Decode the final output tokens to text
  const outputText = tokenizer.batch_decode(outputs, { skip_special_tokens: true });

  // Send the final result back to the main thread
  self.postMessage({
      status: 'complete',
      output: outputText,
  });
  
  // Reset processing state
  processing = false;
}

/**
 * Initialize and load the speech recognition model
 * Includes model warm-up to compile WebGPU shaders
 * 
 * @async
 * @returns {Promise<void>}
 */
async function load() {
  // Notify main thread that loading has started
  self.postMessage({
      status: 'loading',
      data: 'Loading model...'
  });

  // Load the pipeline with progress reporting
  const [tokenizer, processor, model] = await AutomaticSpeechRecognitionPipeline.getInstance(x => {
      // Forward progress updates to main thread
      self.postMessage(x);
  });

  self.postMessage({
      status: 'loading',
      data: 'Compiling shaders and warming up model...'
  });

  // Run model with dummy input to initialize WebGPU shaders
  // This prevents delays during the first real inference
  await model.generate({
      input_features: full([1, 80, 3000], 0.0), // Empty spectrogram of standard size
      max_new_tokens: 1,
  });
  
  // Notify main thread that model is ready
  self.postMessage({ status: 'ready' });
} 

/**
 * Message event handler for the Web Worker
 * Dispatches different actions based on message type
 * 
 * Message types:
 * - 'load': Initialize the model
 * - 'generate': Process audio data
 * - 'finalize': Clean up resources
 */
self.addEventListener('message', async (e) => {
  const { type, data } = e.data;

  switch (type) {
      case 'load':
          // Initialize the model
          load();
          break;

      case 'generate':
          // Process audio data for transcription
          if (data && data.audio) {
              await generate(data);
          }
          break;

      case 'finalize':
          // Reset state and clean up
          processing = false;
          audioBuffer = []; 
          // No explicit termination - allows for future reuse
          break;
  }
});