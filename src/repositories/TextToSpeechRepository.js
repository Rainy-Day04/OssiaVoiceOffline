import { AutoTokenizer, AutoProcessor, SpeechT5ForTextToSpeech, SpeechT5HifiGan, Tensor, AutoModel, read_audio } from '@huggingface/transformers';

export default async function speak(text) {


  // const synthesizer = await pipeline('text-to-speech', 'Xenova/speecht5_tts', { dtype: 'fp32' });
  // const vocoder = await SpeechT5HifiGan.from_pretrained('Xenova/speecht5_hifigan', { dtype: 'q8' });

  // Load the tokenizer and processor
  const tokenizer = await AutoTokenizer.from_pretrained('Xenova/speecht5_tts');
  const processor = await AutoProcessor.from_pretrained('Xenova/speecht5_tts');

  // Load the models
  // NOTE: We use the unquantized versions as they are more accurate
  const model = await SpeechT5ForTextToSpeech.from_pretrained('Xenova/speecht5_tts', { dtype: 'fp32' });
  const vocoder = await SpeechT5HifiGan.from_pretrained('Xenova/speecht5_hifigan', { dtype: 'fp32' });


  // const { speaker_embeddings } = await encoderModel(inputs);
  // console.log(speaker_embeddings)

  // Base Model for TTS
  // const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin');

  // const speaker_embeddings_data = new Float32Array(
  //   await (await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin')).arrayBuffer()
  // );
  const speaker_embeddings_data = new Float32Array(
    await (await fetch('/custom_speaker_embedding_single.bin')).arrayBuffer()
  );
  const speaker_embeddings = new Tensor(
      'float32',
      speaker_embeddings_data,
      [1, speaker_embeddings_data.length]
  )

  const { input_ids } = tokenizer(text);
  const { waveform } = await model.generate_speech(input_ids, speaker_embeddings, { vocoder });
  console.log(waveform)

  const sampleRate = 16000; // Replace with your actual sampling rate if different

  // Create an AudioContext
  const audioContext = new AudioContext();

  // Create an AudioBuffer with 1 channel, length equal to waveform.size, and the desired sample rate
  const audioBuffer = audioContext.createBuffer(1, waveform.size, sampleRate);

  // Copy the waveform data into the AudioBuffer (assumes waveform.data is a Float32Array)
  audioBuffer.copyToChannel(waveform.data, 0, 0);

  // Create a buffer source node and set its buffer to the AudioBuffer
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;

  // Connect the source node to the AudioContext's destination (the speakers)
  source.connect(audioContext.destination);

  // Start playback. (Browsers require a user gesture to start AudioContext if it is suspended.)
  source.start();
}