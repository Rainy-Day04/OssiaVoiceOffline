<script setup>
import BuildSentence from "@/components/InterpreterView/MessageBuilder/tabs/BuildSentence.vue";
import EditSentence from "@/components/InterpreterView/MessageBuilder/tabs/EditSentence.vue";
import NewSentence from "@/components/InterpreterView/MessageBuilder/tabs/NewSentence.vue";
import MyPredictor from "@/components/reusable/MyPredictor.vue";
import TestVision from "@/components/reusable/TestVision.vue";
import {useMessageStore} from "@/stores/MessageStore.js";
import {useSettingsStore} from "@/stores/SettingsStore.js";
import { ref } from 'vue';

const messageStore = useMessageStore()
const settingsStore = useSettingsStore()
const showTestVision = ref(false)

// Store the previous tab before opening camera
const previousTab = ref('build')

// Handle TestVision textAvailable event
function handleVisionTextAvailable(visionText) {
  if (visionText && visionText.trim()) {
    // Add the vision result to context only, not as a message
    const timestamp = new Date().toLocaleString();
    const contextEntry = `\n[Vision Analysis - ${timestamp}]: ${visionText.trim()}`;
    
    // Add to existing context or create new context
    const currentContext = settingsStore.context || '';
    settingsStore.context = currentContext + contextEntry;
    settingsStore.save();
    
    // Close the overlay
    closeVisionOverlay();
    
    console.log('[MessageBuilder] Vision text added to context only (no message created):', visionText);
  }
}

// Open camera overlay and save current tab
function openCameraOverlay() {
  // Save current tab before switching
  if (messageStore.messageTab !== 'camera') {
    previousTab.value = messageStore.messageTab;
  }
  showTestVision.value = true;
}

// Close camera overlay and restore previous tab
function closeVisionOverlay() {
  showTestVision.value = false;
  // Restore to previous tab (or default to predictor if it was camera)
  messageStore.messageTab = previousTab.value;
}

</script>

<template>
  <div id="message-builder-container">
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
        @click="closeVisionOverlay"
      />
    </v-overlay>

    <div id="tab-group">
      <v-tabs id="tabs" v-model="messageStore.messageTab">
        <v-tab value="build">
          <v-icon size="30" icon="mdi-comment-flash-outline"/>
        </v-tab>
        <v-tab value="edit">
          <v-icon size="30" icon="mdi-comment-edit-outline"/>
        </v-tab>
        <v-tab value="new">
          <v-icon size="30" icon="mdi-comment-plus-outline"/>
        </v-tab>
        <v-tab value="predictor">
          <v-icon size="30" icon="mdi-keyboard"/>
        </v-tab>
        <v-tab value="camera" @click="openCameraOverlay">
          <v-icon size="30" icon="mdi-camera"/>
        </v-tab>
      </v-tabs>
    </div>

    <div id="builder-controls">
      <div id="div-border">
        <div class="tab-content-wrapper">
          <BuildSentence v-if="messageStore.messageTab === 'build'"/>
          <EditSentence v-else-if="messageStore.messageTab === 'edit'"/>
          <NewSentence v-else-if="messageStore.messageTab === 'new'"/>
          <MyPredictor v-else-if="messageStore.messageTab === 'predictor'" :isVisible="true" :embedded="true" />
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>

#message-builder-container {
  display: flex;
  flex-direction: column;
  padding-top: 5px;
  gap: 1px;
  height: 100%;
}

#tab-group {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 10px;
}

#builder-controls {
  display: flex;
  overflow: auto;
  justify-content: center;
  align-items: stretch;
  flex-grow: 1;
  height: 100%;
}

#div-border {
  padding: 5px;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

#tabs {
  height: fit-content;
  flex-grow: 0;
  margin: 0;
}

.tab-content-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: auto;
}

</style>