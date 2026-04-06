# Estuary Character Gen Demo for Snap Spectacles

A Lens Studio project that demonstrates the full [Estuary](https://estuary-ai.com) character generation pipeline on Snap Spectacles: snap a photo of any object, generate an AI character from it, and have a real-time voice conversation with your creation.

## Features

- **Camera Capture** -- Palm-anchored camera button with 3-second countdown, photo preview, and confirm/cancel flow
- **Character Generation** -- Upload photos to Estuary's image-to-character API, which creates a persona and 3D model
- **Character Gallery** -- Browse and select previously created characters from a hand-tracked gallery UI
- **Voice Conversation** -- Full-duplex voice chat with any character via WebSocket audio streaming
- **3D Models** -- GLB models download and spawn in front of the user in AR

## Requirements

- [Lens Studio](https://developers.snap.com/lens-studio/home) 5.9+
- Snap Spectacles hardware (CameraModule and MicrophoneRecorder require device deployment)
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

### 4. Wire Inspector Inputs

#### CharacterGenDemo (camera capture flow)

| Input | What to assign |
|-------|---------------|
| `frameButtonPrefab` | SpectaclesUIKit **FrameButton** prefab (palm camera button) |
| `confirmButtonPrefab` | SpectaclesUIKit **FrameButton** prefab (Cancel/Send buttons) |
| `cameraIconMaterial` | Material with camera icon texture |
| `checkmarkIconMaterial` | Material with checkmark icon texture |
| `cancelIconMaterial` | Material with X icon texture |
| `previewImageObject` | Scene Image object (for capture preview) |
| `defaultMaterial` | GLTF material (for GLB instantiation) |
| `voiceConnectionObject` | Disabled EstuaryVoiceConnection SceneObject |

#### CharacterGallery (gallery flow)

| Input | What to assign |
|-------|---------------|
| `cardPrefab` | SIK **PinchButton** prefab (gallery card) |
| `togglePrefab` | SpectaclesUIKit **FrameButton** prefab (gallery toggle) |
| `voiceConnectionObject` | Same disabled EstuaryVoiceConnection SceneObject |
| `defaultMaterial` | GLTF material (for GLB instantiation) |

#### EstuaryVoiceConnection

| Input | What to assign |
|-------|---------------|
| `credentialsObject` | EstuaryCredentials SceneObject |
| `microphoneRecorderObject` | SceneObject with MicrophoneRecorder script |
| `dynamicAudioOutputObject` | SceneObject with DynamicAudioOutput script |
| `internetModule` | InternetModule from the scene |

### 5. Enable Permissions

In **Project Settings > Permissions**, enable **Extended Permissions** (required for simultaneous camera + network access).

### 6. Deploy

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

## Platform Notes

- **Audio**: Mic input is hardware-locked to 16kHz mono. TTS playback is 24kHz.
- **WebSocket**: Lens Studio's WebSocket concatenates rapid sends -- the SDK enforces a 100ms minimum gap via an internal send queue.
- **Camera**: CameraModule is Spectacles-only. `Base64.encodeTextureAsync` does not support RenderTarget textures -- the demo captures full camera frames.
- **GLB**: Uses the three-step Lens Studio pipeline: `InternetModule.makeResourceFromUrl()` > `RemoteMediaModule.loadResourceAsGltfAsset()` > `GltfAsset.tryInstantiateAsync()`.

## License

MIT -- see [LICENSE](LICENSE).
