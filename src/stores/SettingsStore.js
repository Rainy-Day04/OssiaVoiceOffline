import {computed, ref, watch} from 'vue'
import {defineStore} from 'pinia'

export const useSettingsStore = defineStore('settings', () => {

  const openAIAPIKey = ref(localStorage.getItem('openAIAPIKey') || '')
  const context = ref(localStorage.getItem('context') || '')
  const backstory = ref(localStorage.getItem('backstory') || '')
  const voiceClips = ref([])
  const selectedSTTModel = ref(localStorage.getItem('selectedSTTModel') || 'Choice 1'); // Default: Choice 1
  const selectedLLMModel = ref(localStorage.getItem('selectedLLMModel') || 'OpenAI'); // Default: OpenAI
  
  // Speech-to-Text Settings
  const sttAutoStop = ref(localStorage.getItem('sttAutoStop') !== null ? localStorage.getItem('sttAutoStop') === 'true' : true);
  const sttAutoStopDelay = ref(parseInt(localStorage.getItem('sttAutoStopDelay')) || 3)

  // Predictor Settings
  const predictorUseHistory = ref(localStorage.getItem('predictorUseHistory') === 'true')
  const predictorUseBackstory = ref(localStorage.getItem('predictorUseBackstory') === 'true')
  const predictorUseVisionContext = ref(localStorage.getItem('predictorUseVisionContext') === 'true')

  // Vision Settings
  const visionModel = ref('local') // Always use local model - ChatGPT vision disabled
  const visionAutoAnalysis = ref(localStorage.getItem('visionAutoAnalysis') === 'true')
  const visionAutoAddContext = ref(localStorage.getItem('visionAutoAddContext') === 'true')
  const visionAutoTriggerOnMicStop = ref(localStorage.getItem('visionAutoTriggerOnMicStop') === 'true')
  const visionPrompt = ref(localStorage.getItem('visionPrompt') || 'Describe what you see in this image in detail.')
  const visionGPTModel = ref(localStorage.getItem('visionGPTModel') || 'gpt-4o')
  const visionMaxTokens = ref(parseInt(localStorage.getItem('visionMaxTokens')) || 300)
  
  try {
    const storedClips = JSON.parse(localStorage.getItem('voiceClips'));
    if (Array.isArray(storedClips) && storedClips.length > 0) {
      voiceClips.value = storedClips;
    } else {
      voiceClips.value = []; // Ensure no empty or invalid item appears
    }
  } catch (error) {
    console.error("Error parsing voiceClips from localStorage:", error);
    voiceClips.value = []; // Reset on error
  }
  

  function saveVoiceClips(clips) {
    const clipNames = clips.map(clip => ({ name: clip.name })); // Store only names
    localStorage.setItem('voiceClips', JSON.stringify(clipNames));
    voiceClips.value = clips;
  }
  

  function cloneVoice() {
    if (voiceClips.value.length === 0) {
      console.error("No voice clips uploaded");
      return;
    }
    console.log("Cloning voice with clips: ", voiceClips.value);
    alert("Voice cloning complete! ✅");

  }

  function saveSelectedSTTModel(model) {
    selectedSTTModel.value = model;
    localStorage.setItem('selectedSTTModel', model);
    window.location.reload(); // Reload the page to apply the new model
  }

  function saveSelectedLLMModel(model) {
    selectedLLMModel.value = model;
    localStorage.setItem('selectedLLMModel', model);

    window.location.reload(); // Reload the page to apply the new model
  }

  const openAIAPIKeyIsValid = computed(() => {
    return openAIAPIKey.value.length > 0
  })
  const exampleContext = ref(
    `Time: 20:37
Date: Monday 25 December 2023
Location: Glasgow`)

  const exampleBackstory = ref(`
- Name: James
- Age: 47
- From: Edinburgh, Scotland
- Lives currently: Edinburgh, Scotland
- Dialect: East coast scottish, moderate
- Job: (prior to condition): Aerospace engineer
- Spouse: Lucy
- Children: Daughter, Abigail (abby), 10 years old. Timothy (Tim), Son, 5 years old
- Current state of MND: In a wheelchair, lack of movement of any limbs. Muscle in cheek used to interface with 
assistive system. Cannot talk.
- Hobbies (prior to condition): Rugby, woodwork, played the saxophone
- Hobbies (now): reading fiction, listening to jazz music, spending time with family
- Political leaning: Liberal. Voting history, Scottish National Party
- Character: Demoralised. Pretty short tempered a lot of the time, especially when talking about MND. Enjoys getting 
into debates, especially concerning politics. Especially short tempered and angry when people are patronising or if he 
senses pity.
- Religion: None.
`)

  const liabilityAgreement = ref(localStorage.getItem('liabilityAgreement') === "true" || false)

  const cookieAgreement = ref(localStorage.getItem('cookieAgreement') === "true" || false)

  function save() {
    if (!(cookieAgreement.value && liabilityAgreement.value)) {
      showSettingsOverlay.value = true
      showSettingsWarning.value = true
      return
    }
    localStorage.setItem('openAIAPIKey', openAIAPIKey.value)
    localStorage.setItem('context', context.value)
    localStorage.setItem('backstory', backstory.value)
    localStorage.setItem('liabilityAgreement', liabilityAgreement.value.toString())
    localStorage.setItem('cookieAgreement', cookieAgreement.value.toString())
    
    // Vision settings
    // visionModel is always 'local' - ChatGPT vision disabled
    localStorage.setItem('visionAutoAnalysis', visionAutoAnalysis.value.toString())
    localStorage.setItem('visionAutoAddContext', visionAutoAddContext.value.toString())
    localStorage.setItem('visionAutoTriggerOnMicStop', visionAutoTriggerOnMicStop.value.toString())
    localStorage.setItem('visionPrompt', visionPrompt.value)
    localStorage.setItem('visionGPTModel', visionGPTModel.value)
    localStorage.setItem('visionMaxTokens', visionMaxTokens.value.toString())
    
    // STT settings
    localStorage.setItem('sttAutoStop', sttAutoStop.value.toString())
    localStorage.setItem('sttAutoStopDelay', sttAutoStopDelay.value.toString())
    
    // Predictor settings
    localStorage.setItem('predictorUseHistory', predictorUseHistory.value.toString())
    localStorage.setItem('predictorUseBackstory', predictorUseBackstory.value.toString())
    localStorage.setItem('predictorUseVisionContext', predictorUseVisionContext.value.toString())
    
    showSettingsWarning.value = false
    console.log('settings saved')
  }

  watch(context, async (newContext) => {
    if (!(cookieAgreement.value && liabilityAgreement.value)) {
      showSettingsOverlay.value = true
      showSettingsWarning.value = true
      return
    }
    localStorage.setItem('context', newContext)
  })

  const showSettingsOverlay = ref(!(liabilityAgreement.value && cookieAgreement.value))
  const showSettingsWarning = ref(false)

  return {
    showSettingsOverlay,
    showSettingsWarning,
    openAIAPIKey,
    openAIAPIKeyIsValid,
    context,
    backstory,
    selectedSTTModel,
    saveSelectedSTTModel,
    selectedLLMModel,
    saveSelectedLLMModel,
    voiceClips,
    saveVoiceClips,
    cloneVoice,
    exampleContext,
    exampleBackstory,
    liabilityAgreement,
    cookieAgreement,
    save,
    // Vision settings
    visionModel,
    visionAutoAnalysis,
    visionAutoAddContext,
    visionAutoTriggerOnMicStop,
    visionPrompt,
    visionGPTModel,
    visionMaxTokens,
    // STT settings
    sttAutoStop,
    sttAutoStopDelay,
    // Predictor settings
    predictorUseHistory,
    predictorUseBackstory,
    predictorUseVisionContext,
  }
})