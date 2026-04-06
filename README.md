# Estuary Character Gen Demo for Snap Spectacles

A Lens Studio project that demonstrates the full [Estuary](https://estuary-ai.com) character generation pipeline on Snap Spectacles: snap a photo of any object, generate an AI character from it, and have a real-time voice conversation with your creation in <30s.

## Features

- **Camera Capture** -- Right palm-anchored camera button with 3-second countdown, photo preview, and confirm/cancel flow
- **Character Generation** -- Upload photos to Estuary's image-to-character API, which creates a persona and 3D model
- **Character Gallery** -- Browse and select previously created characters from a left hand-tracked gallery UI
- **Voice Conversation** -- Voice chat with any character via WebSocket audio streaming

## Requirements

- [Lens Studio](https://developers.snap.com/lens-studio/home) 5.15+
- Snap Spectacles smartglasses
- An [Estuary](https://estuary-ai.com) API key

## Getting Started

### 1. Clone

```bash
git clone https://github.com/estuary-ai/estuary-snap-spectacles-character-gen-demo.git
cd estuary-snap-spectacles-character-gen-demo
git submodule update --init --recursive
```

### 2. Open in Lens Studio

Open `Estuary-Character-Gen.esproj` in Lens Studio.

### 3. Configure Credentials

Select the **EstuaryCredentials** SceneObject in the hierarchy and set:

| Field | Value |
|-------|-------|
| `apiKey` | Your Estuary API key (`est_...`) |
| `characterId` | *(leave empty -- set dynamically by the demo)* |

### 4. Enable Permissions

In **Project Settings > Permissions**, enable **Extended Permissions** (required for simultaneous camera + network access).

### 5. Deploy

Deploy to Spectacles. CameraModule and MicrophoneRecorder do not work in Lens Studio Preview -- device deployment is required.

## Usage

### Camera Capture Flow

1. Look at your right palm -- a camera button appears
2. Tap the camera button -- 3-second countdown begins
3. Photo is captured and a preview panel appears
4. Tap **Send** to upload, or **Cancel** to retake
5. Character is generated (persona + 3D model)
6. Model spawns in front of you, voice conversation begins

### Gallery Flow

1. Look at your left wrist -- a gallery toggle button appears
2. Tap to open the character gallery
3. Tap any character card to select it
4. Model spawns in front of you, voice conversation begins
5. Tap another card to switch characters

## Project Structure

```
Assets/
  CharacterGenDemo.ts           -- Camera capture + character generation pipeline
  CharacterGallery/
    CharacterGallery.ts         -- Palm-anchored gallery UI with card grid
    CharacterCard.ts            -- Individual gallery card with avatar loading
    GalleryVoiceManager.ts      -- Voice connection switching + GLB lifecycle
    PalmAnchor.ts               -- Hand-tracked palm anchor for gallery positioning
  estuary-lens-studio-sdk/      -- Estuary SDK (git submodule)
    src/Components/
      EstuaryManager.ts         -- Singleton coordinator
      EstuaryCharacter.ts       -- Per-character WebSocket connection
      EstuaryMicrophone.ts      -- Audio capture with chunking
      EstuaryCredentials.ts     -- API key + config
    src/Core/
      EstuaryClient.ts          -- Socket.IO v4 client
      EstuaryHttpClient.ts      -- REST API (image-to-character, model polling, GLB download)
    Examples/
      EstuaryVoiceConnection.ts -- Full voice pipeline (mic + audio + action manager)
      EstuaryCamera.ts          -- On-demand camera capture for VLM
Packages/
  SpectaclesInteractionKit.lspkg -- Hand tracking + pinch detection
  SpectaclesUIKit.lspkg          -- UI components (FrameButton, RoundButton)
  RemoteServiceGateway.lspkg     -- MicrophoneRecorder + DynamicAudioOutput
```

## License

MIT -- see [LICENSE](LICENSE).
