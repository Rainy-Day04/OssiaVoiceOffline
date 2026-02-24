<script setup>
import InterlocutorPanel from "@/components/InterpreterView/InterlocutorPanel.vue";
import MessageHistory from "@/components/InterpreterView/MessageHistory/MessageHistory.vue";
import MessageBuilder from "@/components/InterpreterView/MessageBuilder/MessageBuilder.vue";
import MessageOptions from "@/components/InterpreterView/MessageOptions.vue";
import SettingsOverlay from "@/components/InterpreterView/SettingsOverlay.vue";
import TestVision from "@/components/reusable/TestVision.vue";
import {useLoadingStore} from "@/stores/LoadingStore.js";
import {useSettingsStore} from "@/stores/SettingsStore.js";
import ErrorHandling from "@/components/reusable/AlertHandling.vue";
import { ref } from 'vue';

const loadingStore = useLoadingStore()
const settingStore = useSettingsStore()
const showTestVision = ref(false)

// Handle TestVision textAvailable event
function handleVisionTextAvailable(visionText) {
  if (!visionText?.trim()) return;
  
  const timestamp = new Date().toLocaleString();
  settingStore.context += `\n[Vision Analysis - ${timestamp}]: ${visionText.trim()}`;
  settingStore.save();
  showTestVision.value = false;
  
  console.log('[InterpreterView] Vision text added to context only (no message created):', visionText);
}

// Handle auto camera capture after audio processing
function handleAudioProcessingComplete() {
  if (settingStore.visionAutoTriggerOnMicStop) {
    showTestVision.value = true;
  }
}
</script>

<template>
  <div id="interpreter-grid">
    <!-- Test Vision Overlay -->
    <v-overlay
      v-model="showTestVision"
      class="align-center justify-center"
      style="z-index: 3000;"
    >
      <TestVision 
        @textAvailable="handleVisionTextAvailable" 
        :autoStart="true"
        :autoRun="true"
      />
      <v-btn
        icon="mdi-close"
        color="white"
        style="position: absolute; top: 20px; right: 20px; z-index: 3001;"
        @click="showTestVision = false"
      />
    </v-overlay>

    <v-overlay
      v-model="settingStore.showSettingsOverlay"
      class="align-center justify-center"
    >
      <settings-overlay @close="settingStore.showSettingsOverlay=false"/>
    </v-overlay>
    <div id="top-panel">
      <div id="interlocutor-panel">
        <InterlocutorPanel @audioProcessingComplete="handleAudioProcessingComplete"/>
      </div>
      <div id="message-history">
        <MessageHistory/>
      </div>
    </div>
    <div id="bottom-panel">
      <div v-for="(bar, index) in loadingStore.additionalLoadingBars" :key="index">
        <div class="progressLoadingLabel"> {{ bar.message }}</div>
        <v-progress-linear
          :id="bar.id"
          :model-value="bar.value"
          rounded color="secondary"
          class="progressLoading"/>
      </div>
      <v-progress-linear
        v-if="(loadingStore.newSentenceLoading || loadingStore.newWordsLoading) && !Object.keys(loadingStore.additionalLoadingBars).length"
        indeterminate rounded color="primary"
        class="progressLoading"/>
      
      <div v-else id="message-panels">
        <div id="message-builder" tabindex="0" class="tabbable">
          <MessageBuilder/>
        </div>
        <div id="separator"/>
        <div id="message-options" tabindex="0" class="tabbable">
          <MessageOptions/>
        </div>
      </div>
    </div>
    
    <error-handling/>
  </div>
</template>

<style scoped lang="scss">
@use '@/assets/theme';

// ...existing styles...
#interpreter-grid {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  width: 100vw;
}

#top-panel {
  display: flex;
  width: 100%;
  height: 45dvh;
  max-height: 45dvh;
  flex-grow: 1;
  align-items: stretch;
  border-bottom-width: 1px;
  border-bottom-style: solid;
}

#wrap {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

#predictor-panel {
  height: 100%;
  width: 100%;
  position: relative;
  background: theme.$ossia-white;
  border-radius: 8px 8px 0 0;
}

.progressLoadingLabel {
  width: 100%;
  text-align: center;
  font-style: italic;
  color: theme.$text-color-inverted-muted;
}

.progressLoading {
  min-height: 4px;
}

#message-panels {
  display: flex;
  flex-grow: 1;
  max-height: calc(100% - 4px);
}

#interlocutor-panel {
  padding: 10px;
  height: 100%;
  max-height: 100%;
  width: 50%;
  min-width: 300px;
  max-width: 550px;
}

#message-history {
  background: theme.$ossia-light-background-1;;
  height: 100%;
  flex-grow: 1;
}

#message-builder {
  background-color: theme.$ossia-light-background-1;
  height: 100%;
  width: 50%;
  overflow: auto;
  flex-grow: 1;
}

#separator {
  flex-grow: 0;
  width: 2px;
  background-color: theme.$ossia-divider-light-1;
  height: 70%;
  align-self: center;
}

#message-options {
  max-height: 100%;
  width: calc(50% - 2px);
  flex-grow: 1;
  display: flex;
  overflow: auto;
  justify-items: stretch;
  background-color: theme.$ossia-light-background-1;
}

@media (max-width: 600px) {

  #top-panel {
    height: 37dvh;
    max-height: 37dvh;
  }

  #bottom-panel {
    height: 63dvh;
    max-height: 63dvh;
  }

  #message-panels {
    flex-direction: column-reverse;
  }

  #separator {
    height: 2px;
    width: 70%;
  }

  #message-options {
    width: 100%;
    height: calc(50% - 2px);
  }

  #message-builder {
    width: 100%;
    height: 50%;
  }
}

@media screen and (max-width: 600px) {

  #interlocutor-panel {
    min-width: 50%;
  }

}
</style>