# OssiaVoice
Ossia is an accessibility tool for those unable to speak or type; Ossia enables whole sentence creation with as few clicks as possible and targets <1 word typed per sentence.

Experience it for yourself at [ossiavoice.com](https://ossiavoice.com/)

## Currently Missing Features
- Switch control (and keyboard navigation) is sorely missing in the current version which is still in beta. The idea is to release Ossia in its current state to collect feedback and ideas while accessibilty is being better implemented. If you feel you can help with this please reach out

## Licence: 
  Attribution-NonCommercial 4.0 International (CC BY-NC 4.0 DEED)
  In addition, the contributor agreement below applies.

  If these terms do not suit your needs, please reach out for suitable collaboration

## Contributor Agreement
  **The following agreement is required to prevent ownership ambiguity as described [here](https://choosealicense.com/no-permission/). Such ambiguity leads to no one being able to contribute to the project (including the original author) (which would be very bad):**
  
  Any contributor, by adding to or adapting the contents of this repository, accepts that the original author (@arneyjfs) retains full ownership over it's contents

# To run the program:
First you need to install Node.js from https://nodejs.org/en
1.For standard version:
1. git clone https://github.com/Rainy-Day04/OssiaVoiceOffline.git
2. cd OssiaVoiceOffline
3. npm install
4. npm run dev

2.For diarization version:
1. git clone https://github.com/Rainy-Day04/OssiaVoiceOffline.git
2. cd OssiaVoiceOffline
3. git checkout stt-diarization
4. git pull
5. npm install
6. npm run dev

3.For realtime stt version:
1. git clone https://github.com/Rainy-Day04/OssiaVoiceOffline.git
2. cd OssiaVoiceOffline
3. git checkout stt-realtime-whisper 
4. git pull
5. npm install
6. npm run dev

Third-Party Attributions
[AlphaCache Protocol: The stt-realtime-whisper uses worker file developed by xenova and the concept of chunk processing. Original work: GitHub Repository  - Licensed under Apache License Version 2.0.](https://github.com/huggingface/transformers.js/blob/main/examples/webgpu-whisper/src/worker.js)![image](https://github.com/user-attachments/assets/e86fbb73-6568-4d5c-8b6e-a98f1bd2e692)



