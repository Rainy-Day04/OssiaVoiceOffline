import { defineStore } from 'pinia';

export const useMicrophoneStore = defineStore('microphone', {
  state: () => ({
    isActive: false,        // microphone on/off state
    isProcessing: false,    // audio processing state
    isLoading: false,       // model loading state
    currentModel: '',       // current STT model name
    loadProgress: 0         // model loading progress
  }),
  
  actions: {
    setActive(status) {
      this.isActive = status;
    },
    setProcessing(status) {
      this.isProcessing = status;
    },
    setLoading(status) {
      this.isLoading = status;
    },
    setCurrentModel(model) {
      this.currentModel = model;
    },
    setLoadProgress(progress) {
      this.loadProgress = progress;
    }
  }
});