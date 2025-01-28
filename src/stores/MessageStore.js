import {ref} from 'vue'
import {defineStore} from 'pinia'
import OpenAI from "openai";
import {useSettingsStore} from "@/stores/SettingsStore.js";
import {useAlertStore} from "@/stores/AlertStore.js";
import {useLoadingStore} from "@/stores/LoadingStore.js";
import {CreateMLCEngine} from "@mlc-ai/web-llm";

export const useMessageStore = defineStore('messages', () => {
  const interlocutorPhrase = ref('')
  const scriberPhrase = ref('')
  const messageTab = ref('build')
  const messageHistory = ref([])
  const activeEditHistory = ref([])
  const wordSuggestions = ref([
    'hi', 'how', 'you', 'weather', 'nice', 'hungry', 'dinner', 'today', 'i',
    'work', 'rugby', 'jazz', 'cold', 'warm', 'thirsty', 'bored', 'good'])
  const previousWordSuggestions = ref([])
  const sentenceSuggestions = ref([
    "Hi, how are you doing?", "What's on for your day?",
    "I'm a little cold", "Get up to anything interesting today?"])
  const editInstruction = ref(null)
  const settingStore = useSettingsStore()
  const alertStore = useAlertStore()
  const loadingStore = useLoadingStore()

  class TextGenerator {
    constructor(additionalDependencies = []) {
      this.additionalDependencies = additionalDependencies;
    }

    async getResponse(messages, wordLoading = false, sentenceLoading = false) {
      if (!this.checkDependencies(this.additionalDependencies)) return
      if (wordLoading) loadingStore.newWordsLoading++
      if (sentenceLoading) loadingStore.newSentenceLoading++
      try {
        return await this.create(messages)
      } catch (err) {
        alertStore.showAlert('error', `Error (${err.type})`, err.message)
      } finally {
        if (wordLoading) loadingStore.newWordsLoading--
        if (sentenceLoading) loadingStore.newSentenceLoading--
      }
    }

    async create() {
      throw "Abstract method create not implemented";
    }

    checkDependencies(additionalDependencies = []) {
      let dependencies = [settingStore.backstory.length > 0, settingStore.liabilityAgreement === true]
      dependencies = dependencies.concat(additionalDependencies)
      if (!dependencies.every(Boolean)) {
        settingStore.showSettingsOverlay = true
        settingStore.showSettingsWarning = true
        return false
      }
      return true
    }

  }

  class OpenAIImplementation extends TextGenerator {
    constructor() {
      super([settingStore.openAIAPIKeyIsValid]);
      this.model = "gpt-4o" // "gpt-4-turbo"
      this.client = new OpenAI({
        apiKey: settingStore.openAIAPIKey, dangerouslyAllowBrowser: true
      });
    }

    async create(messages) {
      const completion = await this.client.chat.completions.create({
        messages,
        model: this.model,
        temperature: 0.5,
        top_p: 0.5,
        response_format: {"type": "json_object"}
      });
      return JSON.parse(completion.choices[0].message.content)['suggestions']
    }
  }

  class WebLLMImplementation extends TextGenerator {
    constructor() {
      super();
      this.engine = null;
    }

    async setup() {
      const initProgressCallback = (initProgress) => {
        console.log(initProgress);
      }
      const selectedModel = "Llama-3.1-8B-Instruct-q4f32_1-MLC";

      this.engine = await CreateMLCEngine(
        selectedModel,
        {initProgressCallback}, // engineConfig
      );
    }

    async create(messages) {
      try {
        // WEB LLM
        // Callback function to update model loading progress
        if (this.engine === null) {await this.setup()}

        const completion = await this.engine.chat.completions.create({
          messages,
        });
        return JSON.parse(completion.choices[0].message.content)['suggestions']

      } catch (err) {
        console.log(err)
      }
    }
  }

  const chatCompletionModel = new WebLLMImplementation() // OpenAIImplementation() WebLLMImplementation()

  function assembleHistory(command) {
    const systemMessage = {role: "system", content: getSystemMessage()};

    let finalCommand = ""
    let messages = [systemMessage]
    if (messageHistory.value.length !== 0) {
      messages = messages.concat(messageHistory.value)
    }
    if (activeEditHistory.value.length !== 0) {
      messages = messages.concat(activeEditHistory.value)
    } // todo check active edit history is reset

    var now = new Date();
    finalCommand += `Here is some background context to the users current situation. You do not necessarily 
    need to use it:\nDate and Time: ${now}\n`

    if (settingStore.context) {
      finalCommand += `${settingStore.context}\n`
    }

    finalCommand += command
    messages = messages.concat([{role: "system", content: finalCommand}])
    return messages
  }

  // Respond
  async function generateSentences() {
    const command = `Given the conversation history, generate a list of 3 to 5 short generic sentences the 
      assistant may want to say`
    sentenceSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWords() {
    const command = `Given the conversation history, generate a short list of key words or 
    very short phrases the assistant can select from to build a new sentence`
    wordSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), true, false)
  }

  // Build Sentences
  async function generateSentencesFromWords(words) {
    const command = `Given the following list of words, generate between 3-5 sentences that the assistant 
    might be trying to say. Keep them generic but use all the words:\n${words}`
    sentenceSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateMoreWordsFromWords(words) {
    const command = `Given the following list of words and the conversation history, generate another 
    list of related words that the assistant could select from to build a sentence:\n${words}`
    wordSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), true, false)
  }

  // New Sentence
  async function generateWordSuggestionsFromNewTopic(topic) {
    const command = `Ignore all previous conversation. Generate a short list of key words 
      the assistant can select from to build a new sentence, based around this new topic: '${topic}'`
    wordSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), true, false)
  }

  async function generateSentenceSuggestionsFromNewTopic(topic) {
    const command = `Ignore all previous conversation. Generate a list of 3 to 5 short generic sentences the 
      assistant may want to say, based around this new topic: '${topic}'`
    sentenceSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  // Edit Sentence
  async function editSingleResponseWithHint(response, hint) {
    const command = `The response '${response}' was close. Suggest similar sentences based on the following hint':
    \n'${hint}'`
    sentenceSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWordsForSingleResponseFromHint(response, hint) {
    const command = `The response '${response}' was close. Generate a short list of key words or 
    very short phrases the assistant can select from to build a similar sentence, based on the hint: '${hint}'`
    wordSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), true, false)
  }

  async function editAllResponsesWithHint(hint) {
    const command = `Try again, using the following hint:\n'${hint}'`
    sentenceSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWordsForAllResponsesFromHint(hint) {
    const command = `None of those suggestions were very useful. This time, instead of full sentences, generate 
    a short list of key words or very short phrases, that the assistant can select from to build 
    alternative sentences. Here is a hint to help guide you: '${hint}'`
    wordSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), true, false)
  }

  // Generate Response
  async function generateNewResponses() {
    const command = `Try again, providing 3 to 5 alternative suggestions`
    sentenceSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWordSuggestionsFromHint(hint) {
    const command = `Given the conversation history, generate a short list of key words or 
    very short phrases the assistant can select from to build a new sentence, based on the hint: '${hint}'`
    wordSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), true, false)
  }

  async function generateSentenceSuggestionsFromHint(hint) {
    const command = `Given the conversation history, generate a list of 3 to 5 short generic sentences the 
      assistant may want to say, based on the hint: '${hint}'`
    sentenceSuggestions.value = await chatCompletionModel.getResponse(assembleHistory(command), false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  function getSystemMessage() {
    return `
You are an AI Bot for someone living with Motor Neurone Disease (MND) (hereafter referred to as the 'assistant'). You 
receive a conversation between the assistant and another person (the 'user') . Your job 
is to suggest various likely short sentences that the assistant might want to say to continue the conversation, or a short 
list of key words and phrases the assistant can use to build a sentence.

Here are the rules for the generated suggestions:

- suggestions SHOULD cover a broad range of emotions or affirmative and negative options where it is suitable
- suggestions SHOULD reflect the personality and interests of the user given in the assistant's backstory, but only where appropriate.
- suggestions SHOULD reflect any current context given.
- suggestions SHOULD be tailored to the person you are speaking with
- suggestions MUST be numerous enough to give variety, but not overwhelming in choice. Around 5 is often appropriate for sentences, about 10-15 for key words.
- suggestions MUST not be so specific that they assume any information not given in the backstory
- suggestions MUST not assume the user is always positive and polite. The user may often be frustrated, negative or tired 

Here is the assistant's backstory:
${settingStore.backstory}

The format of the conversation will be a list of previous messages between 'user' and 'assistant', followed by an instruction. 
The instruction could be to generate suggested sentences or a likely words list, or to modify previous suggestions for example.

All your generated suggestions MUST be a valid JSON list.
Below are some examples of inputs and outputs in the correct format. You will be playing the role of the assistant:
user:
just going to the bar, want anything?

system:
Given the conversation history, generate a list of 3 to 5 short generic sentences the assistant may want to say

assistant:
{
  "suggestions": [
    "No I'm okay thanks",
    "Oh go on then, a beer would be great thanks",
    "Well, maybe a glass of water?"
  ]
}
-----
user:
have you seen Dune yet?

system:
Given the following list of words, generate between 3-5 sentences that the assistant might be trying to say. 
Keep them generic but use all the words:
['recommend', 'watching']

assistant:
{
  "suggestions": [
    "No not yet, would you recommend watching it?",
    "Yes it was great, I'd really recommend watching it!",
    "Yes. It wasn't that good, wouldn't really recommend watching it",
  ]
}

-----
user:
did you have a good day at work?

system:
Given the conversation history, generate a short list of key words or very short phrases the assistant can 
select from to build a new sentence

assistant:
{
  "suggestions": [
    "not",
    "good",
    "bad",
    "stressful",
    "fun",
    "boring",
    "tired",
    "weekend",
    "boss",
    "colleagues",
    "office",
    "hate",
    "love",
    "deadline",
    "meeting",
    "pressure",
    "day off",
  ]
}
`
  }

  return {
    messageTab,
    interlocutorPhrase,
    scriberPhrase,
    messageHistory,
    activeEditHistory,
    wordSuggestions,
    previousWordSuggestions,
    sentenceSuggestions,
    editInstruction,
    generateSentences,
    generateWords,
    generateSentencesFromWords,
    generateMoreWordsFromWords,
    generateWordSuggestionsFromNewTopic,
    generateSentenceSuggestionsFromNewTopic,
    editSingleResponseWithHint,
    generateWordsForSingleResponseFromHint,
    editAllResponsesWithHint,
    generateWordsForAllResponsesFromHint,
    generateNewResponses,
    generateWordSuggestionsFromHint,
    generateSentenceSuggestionsFromHint,
  }
})
