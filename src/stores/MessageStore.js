import {ref} from 'vue'
import {defineStore} from 'pinia'
import OpenAI from "openai";
import {useSettingsStore} from "@/stores/SettingsStore.js";
import {useAlertStore} from "@/stores/AlertStore.js";
import {useLoadingStore} from "@/stores/LoadingStore.js";
import {CreateMLCEngine} from "@mlc-ai/web-llm";
import {sleep} from "openai/core";

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
        const responses = await this.create(messages)
        console.debug(responses)
        return responses
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
      this.engineLoading  = false;
    }

    async setup() {
      const initProgressCallback = (initProgress) => {
        console.log(initProgress);
        if (initProgress.text.includes('Loading model from cache')) {
          let progress = /\[(\d+\/\d+)]/.exec(initProgress.text)[1].split("/")
          progress = (progress[0] /progress[1]) * 100
          loadingStore.additionalLoadingBars['WebLLMBar'] = {
            message: `loading model from cache - ${Math.round(progress)}%`,
            value: progress
          }
        }
        else {
          loadingStore.additionalLoadingBars['WebLLMBar'] = {
            message: `downloading offline model (only happens once) - ${Math.round(initProgress.progress * 100)}%`,
            value: initProgress.progress * 100
          }
        }
      }
      const selectedModel = settingStore.selectedLLMModel==="9b Model"
        ? "gemma-2-9b-it-q4f16_1-MLC"
        : "gemma-2-2b-it-q4f16_1-MLC";
      //const selectedModel = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

      this.engine = await CreateMLCEngine(
        selectedModel,
        {initProgressCallback}, // engineConfig
      );
      delete loadingStore.additionalLoadingBars['WebLLMBar']
    }

    async create(messages, retryCount = 3) {
      try {
        while (this.engineLoading) {
          await sleep(100);
        }
    
        
        if (this.engine === null) {
          this.engineLoading = true;
          try {
            await this.setup();
          } finally {
            this.engineLoading = false;
          }
        }
    
        console.log(messages);
    
        
        const completion = await this.engine.chat.completions.create({
          messages,
        });
    
        console.log(completion);
        console.log('The result is', completion.choices[0].message.content);
    
        
        return JSON.parse(
          completion.choices[0].message.content.trim()
            .replace(/(^[^[]+|[^\]]+$)/g, '')     
            .replace(/,\s*]$/, ']')               
            .replace(/"\s+"/g, '", "')            
            .replace(/(?<=\{)\s*([^"]+?)\s*:/g, '"$1":')
        );
    
      } catch (err) {
        console.log(`Error, retrying count ${3-retryCount}`, err);
        
        if (retryCount > 0) { 
          await sleep(1000); 
          return this.create(messages, retryCount - 1); 
        } else {
          throw new Error("failed to generate response");
        }
      }
    }
  }

  console.log(settingStore.selectedLLMModel);
  const chatCompletionModel = settingStore.selectedLLMModel === "OpenAI"
    ? new OpenAIImplementation()
    : new WebLLMImplementation();
  //const chatCompletionModel = new WebLLMImplementation() // OpenAIImplementation() WebLLMImplementation() HFTransformersImplementation()

  // Respond
  async function generateSentences() {
    const command = `Given the Current Conversation History, generate a list of 3 to 5 short generic sentences the 
      assistant may want to say. You must respond only with a valid JSON list of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getSentenceSystemMessage()},
      {role: "user", content: command}
    ]
    sentenceSuggestions.value = await chatCompletionModel.getResponse(messages, false, true) || sentenceSuggestions.value
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWords() {
    const command = `Given the Current Conversation History, generate a short list of key words or 
    very short phrases the user can select from to build a new sentence. You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getKeywordSystemMessage()},
      {role: "user", content: command}
    ]
    wordSuggestions.value = await chatCompletionModel.getResponse(messages, true, false) || wordSuggestions.value
  }

  // Build Sentences
  async function generateSentencesFromWords(words) {
    const command = `Given the following list of words, generate between 3-5 sentences that the assistant 
    might be trying to say. Keep them generic but use all the words:\n${words},You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getSentenceSystemMessage()},
      {role: "user", content: command}
    ]
    sentenceSuggestions.value = await chatCompletionModel.getResponse(messages, false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateMoreWordsFromWords(words) {
    const command = `Given the following list of words and the Current Conversation History, generate another 
    list of related words that the assistant could select from to build a sentence:\n${words},You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getKeywordSystemMessage()},
      {role: "user", content: command}
    ]
    wordSuggestions.value = await chatCompletionModel.getResponse(messages, true, false) || wordSuggestions.value
  }

  // New Sentence
  async function generateWordSuggestionsFromNewTopic(topic) {
    const command = `Ignore all previous conversation. Generate a short list of key words 
      the assistant can select from to build a new sentence, based around this new topic: '${topic}',You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getKeywordSystemMessage()},
      {role: "user", content: command}
    ]
    wordSuggestions.value = await chatCompletionModel.getResponse(messages, true, false) || wordSuggestions.value
  }

  async function generateSentenceSuggestionsFromNewTopic(topic) {
    const command = `Ignore all previous conversation. Generate a list of 3 to 5 short generic sentences the 
      assistant may want to say, based around this new topic: '${topic}',You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getSentenceSystemMessage()},
      {role: "user", content: command}
    ]
    sentenceSuggestions.value = await chatCompletionModel.getResponse(messages, false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  // Edit Sentence
  async function editSingleResponseWithHint(response, hint) {
    const command = `The response '${response}' was close. Suggest similar sentences based on the following hint':
    \n'${hint}',You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getSentenceSystemMessage()},
      {role: "user", content: command}
    ]
    sentenceSuggestions.value = await chatCompletionModel.getResponse(messages, false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWordsForSingleResponseFromHint(response, hint) {
    const command = `The response '${response}' was close. Generate a short list of key words or 
    very short phrases the assistant can select from to build a similar sentence, based on the hint: '${hint}',You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getKeywordSystemMessage()},
      {role: "user", content: command}
    ]
    wordSuggestions.value = await chatCompletionModel.getResponse(messages, true, false) || wordSuggestions.value
  }

  async function editAllResponsesWithHint(hint) {
    const command = `Try again, using the following hint:\n'${hint}'`
    let messages = [
      {role: "system", content: getSentenceSystemMessage()},
      {role: "user", content: command}
    ]
    sentenceSuggestions.value = await chatCompletionModel.getResponse(messages, false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWordsForAllResponsesFromHint(hint) {
    const command = `None of those suggestions were very useful. This time, instead of full sentences, generate 
    a short list of key words or very short phrases, that the assistant can select from to build 
    alternative sentences. Here is a hint to help guide you: '${hint}',You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getKeywordSystemMessage()},
      {role: "user", content: command}
    ]
    wordSuggestions.value = await chatCompletionModel.getResponse(messages, true, false) || wordSuggestions.value
  }

  // Generate Response
  async function generateNewResponses() {
    const command = `Try again, providing 3 to 5 alternative suggestions`
    let messages = [
      {role: "system", content: getSentenceSystemMessage()},
      {role: "user", content: command}
    ]
    sentenceSuggestions.value = await chatCompletionModel.getResponse(messages, false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  async function generateWordSuggestionsFromHint(hint) {
    const command = `Given the Current Conversation History, generate a short list of key words or 
    very short phrases the assistant can select from to build a new sentence, based on the hint: '${hint}',You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getKeywordSystemMessage()},
      {role: "user", content: command}
    ]
    wordSuggestions.value = await chatCompletionModel.getResponse(messages, true, false) || wordSuggestions.value
  }

  async function generateSentenceSuggestionsFromHint(hint) {
    const command = `Given the Current Conversation History, generate a list of 3 to 5 short generic sentences the 
      assistant may want to say, based on the hint: '${hint}',You must respond only with a valid JSON list 
    of suggestions and NOTHING else.`
    let messages = [
      {role: "system", content: getSentenceSystemMessage()},
      {role: "user", content: command}
    ]
    sentenceSuggestions.value = await chatCompletionModel.getResponse(messages, false, true)
    activeEditHistory.value = activeEditHistory.value.concat([
      {role: "system", content: command},
      {role: "assistant", content: `{"suggestions": ["${sentenceSuggestions.value.join('", "')}"]}`}
    ])
  }

  function getKeywordSystemMessage() {
    let systemMessage = `
You are an AI Bot designed to assist someone living with Motor Neurone Disease (MND) (hereafter referred to as the 'user'). 
You will receive a Current Conversation History between the user and another person (the 'interlocutor'). 
Your role is to generate **key words and phrases** that may be relevant to the user's next sentence.'.  

**The user’s backstory is**:

${settingStore.backstory}

**Rules for Suggestions**:  
Follow these rules when creating suggestions:

1. Include a variety of options reflecting different moods, opinions and perspectives.
2. Tailor suggestions based on the assistant's personality, backstory, and current context, but avoid assuming details not provided.
3. Keep suggestions concise, manageable, likely and useful for communication.

**Examples**:

**Input Example**  
*User:* "Hello, glad you're home"  
*assistant:* "Yeah good to be back"
*User:* "Did you have a good day at work?"  
*User:* "Prompt: Generate 10-15 key words for a response."  

**Output Example**  
\`\`\`json
[
  "not",
  "good",
  "stressful",
  "fun",
  "tired",
  "colleagues",
  "deadline",
  "meeting",
  "boring",
  "day off"
]
\`\`\`
`
    let now = new Date();
    systemMessage += `Here is some background context to the users current situation. You do not necessarily 
need to use it:\nDate and Time: ${now}\n`

    if (settingStore.context) {
      systemMessage += `${settingStore.context}\n`
    }

    systemMessage += `
**Current Conversation History**
\`\`\`json
${JSON.stringify(messageHistory.value)}
\`\`\`
`

    if (activeEditHistory.value.length !== 0) {
      systemMessage += `
**Edit History**
\`\`\`json
${JSON.stringify(activeEditHistory.value)}
\`\`\`
`
    }

    systemMessage += `
The next message you receive will be the instruction for generating suggestions.
`
    return systemMessage
  }

  function getSentenceSystemMessage() {
    let systemMessage = `
You are an AI Bot designed to assist someone living with Motor Neurone Disease (MND) (hereafter referred to as the 'user'). 
You will receive a Current Conversation History between the user and another person (the 'interlocutor'). 
Your role is to generate **short example sentences** that the user may want to use to respond.'.  

**The user’s backstory is**:

${settingStore.backstory}

**Rules for Suggestions**:  
Follow these rules when creating suggestions:

1. Include a variety of options reflecting different moods, opinions and perspectives.
2. Tailor suggestions based on the assistant's personality, backstory, and current context, but avoid assuming details not provided.
3. Keep suggestions concise, manageable, likely and useful for communication.

**Examples**:

**Input Example**
*User:* "Fantastic game today hey?"  
*assistant:* "Yeah it was brilliant. What a way to end the week"
*User:* "just going to the bar, want anything?"  
*User:* "Prompt: Given the conversation history, generate a list of 3 to 5 short generic sentences the assistant may want to say"  

**Output Example**
\`\`\`json
[
  "No I'm okay thanks",
  "Oh go on then, a beer would be great thanks",
  "Well, maybe a glass of water?"
]
\`\`\`

-----
**Input Example**
*User:* "I'm about to head to the cinema"  
*assistant:* "Oh what are you watching"
*User:* "Dune, have you seen it yet?"  
*User:* "Given the following list of words, generate between 3-5 sentences that the assistant might be trying to say. 
Keep them generic but use all the words:
['recommend', 'watching']
"  

**Output Example**
\`\`\`json
[
  "No not yet, would you recommend watching it?",
  "Yes it was great, I'd really recommend watching it!",
  "Yes. It wasn't that good, wouldn't really recommend watching it",
]
\`\`\`
`
    let now = new Date();
    systemMessage += `Here is some background context to the users current situation. You do not necessarily 
need to use it:\nDate and Time: ${now}\n`

    if (settingStore.context) {
      systemMessage += `${settingStore.context}\n`
    }

    systemMessage += `
**Current Conversation History**
\`\`\`json
${JSON.stringify(messageHistory.value)}
\`\`\`
`

    if (activeEditHistory.value.length !== 0) {
      systemMessage += `
**Edit History**
\`\`\`json
${JSON.stringify(activeEditHistory.value)}
\`\`\`
`
    }

    systemMessage += `
The next message you receive will be the instruction for generating suggestions.
`
    return systemMessage
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
