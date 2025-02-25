import { pipeline } from '@huggingface/transformers';

// window.voice = null;
// window.speechSynthesis.onvoiceschanged = function() {
//   window.voice = speechSynthesis.getVoices()[1];// };

export default async function speak(text) {

  const synthesizer = await pipeline('text-to-speech', 'Xenova/speecht5_tts', { dtype: 'fp32' });

  // const response = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin');
  const response = await fetch('/custom_speaker_embeddings.bin');
  
  // const response = await fetch('/custom_speaker_embeddings_single.bin');

  const buffer = await response.arrayBuffer();
  console.log(buffer.length)
  let speaker_embeddings = new Float32Array(buffer);
  if (speaker_embeddings.length !== 512) {
    speaker_embeddings = speaker_embeddings.slice(0, 512);
  }
  const result = await synthesizer(text, { speaker_embeddings: speaker_embeddings });
  console.log(result);

  const audioContext = new AudioContext();

  // Create an AudioBuffer with 1 channel, length equal to the audio array length, and the provided sample rate
  const audioBuffer = audioContext.createBuffer(1, result.audio.length, result.sampling_rate);

  // Copy the Float32Array data into the AudioBuffer
  audioBuffer.copyToChannel(result.audio, 0, 0);

  // Create a source node from the AudioBuffer
  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;

  // Connect the source to the audio context’s destination (the speakers)
  source.connect(audioContext.destination);

  // Start playback (note: browsers may require a user gesture to resume the AudioContext)
  source.start();
}