import {ref} from 'vue'
import {defineStore} from 'pinia'

export const useLoadingStore = defineStore('loading', () => {
  const newWordsLoading = ref(0)
  const newSentenceLoading = ref(0)
  const additionalLoadingBars = {} // e.g {id: '', displayName: '', value: 0.9}

  return {
    newWordsLoading,
    newSentenceLoading,
    additionalLoadingBars,
  }
})
