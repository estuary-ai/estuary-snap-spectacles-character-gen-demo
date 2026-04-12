/**
 * CharacterGenDemo - Character generation pipeline for Spectacles.
 *
 * Flow: Camera button tap → 3s countdown → snap photo → preview → confirm/cancel → upload → generate.
 *
 * Setup in Lens Studio:
 * 1. Add EstuaryCredentials to a SceneObject (set API key & server URL)
 * 2. Add this script to a SceneObject
 * 3. Assign a GLTF material to defaultMaterial (NOT PBR!)
 * 4. (Optional) Wire voiceConnectionObject to a disabled EstuaryVoiceConnection SceneObject
 * 5. Wire frameButtonPrefab to a SpectaclesUIKit FrameButton prefab for palm-anchored camera button
 * 6. Wire confirmButtonPrefab to a SpectaclesUIKit FrameButton prefab for Cancel/Send buttons
 * 7. Wire previewImageObject to a scene Image object for the capture preview
 *
 * Credentials (API key, server URL, player ID) are read from EstuaryCredentials.
 * InternetModule is obtained automatically via require().
 */

import { setInternetModule } from './estuary-lens-studio-sdk/src/Core/EstuaryClient';
import { EstuaryHttpClient, ImageToCharacterOptions } from './estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { EstuaryConfig } from './estuary-lens-studio-sdk/src/Core/EstuaryConfig';
import { EstuaryCredentials } from './estuary-lens-studio-sdk/src/Components/EstuaryCredentials';
import { ModelStatusResponse } from './estuary-lens-studio-sdk/src/Models/ModelStatusResponse';
import SIK from 'SpectaclesInteractionKit.lspkg/SIK';

// ==================== Configuration Constants ====================

const API_KEY = 'YOUR_API_KEY_HERE';
const PLAYER_ID = 'spectacles-chargen-demo';
const SERVER_URL = 'https://api.estuary-ai.com';

const LERP_ALPHA = 0.15;
const HIDE_DELAY = 1.0;
const PANEL_Z = -80;

// ==================== State Machine ====================

enum CaptureState {
    /** Camera button visible on palm */
    Idle,
    /** 3...2...1... countdown in progress */
    Countdown,
    /** Frozen photo shown, confirm/cancel buttons */
    Preview,
    /** Upload + generation in progress */
    Uploading,
}

// ==================== Component ====================

@component
export class CharacterGenDemo extends BaseScriptComponent {

    // ==================== Inputs ====================

    @input
    @allowUndefined
    defaultMaterial: Material;

    @input
    @allowUndefined
    statusTextObject: SceneObject;

    @input
    @allowUndefined
    voiceConnectionObject: SceneObject;

    @input
    @allowUndefined
    greetingMessage: string;

    /** SpectaclesUIKit FrameButton prefab for palm-anchored camera button */
    @input
    @allowUndefined
    frameButtonPrefab: ObjectPrefab;

    /** SpectaclesUIKit FrameButton prefab for Cancel/Send buttons */
    @input
    @allowUndefined
    confirmButtonPrefab: ObjectPrefab;

    /** Camera icon material for the palm camera button */
    @input
    @allowUndefined
    cameraIconMaterial: Material;

    /** Checkmark icon material for the Send button */
    @input
    @allowUndefined
    checkmarkIconMaterial: Material;

    /** X icon material for the Cancel button */
    @input
    @allowUndefined
    cancelIconMaterial: Material;

    /** Scene-created Image object for the capture preview */
    @input
    @allowUndefined
    previewImageObject: SceneObject;

    /** Custom appearance prompt (replaces default, char limit applied automatically) */
    @input
    @allowUndefined
    appearancePrompt: string;

    /** Custom voice prompt (replaces default, char limit applied automatically) */
    @input
    @allowUndefined
    voicePrompt: string;

    /** Custom persona prompt (replaces default, char limit applied automatically) */
    @input
    @allowUndefined
    personaPrompt: string;

    // ==================== Private State ====================

    private statusText3D: any = null;
    private isGenerating: boolean = false;
    private _state: CaptureState = CaptureState.Idle;

    // Palm anchor
    private _rightHand: any = null;
    private _palmAnchorRoot: SceneObject | null = null;
    private _cameraButtonInstance: SceneObject | null = null;
    private _hasPalmInitialPos: boolean = false;
    private _lastPalmShowTime: number = 0;
    private _palmVisible: boolean = false;

    // Camera
    private _cameraModule: any = null;
    private _cameraTexture: Texture | null = null;
    private _cameraReady: boolean = false;

    // Capture
    private _capturedImageBase64: string | null = null;
    private _confirmationPanel: SceneObject | null = null;
    private _previewImage: any = null;

    // ==================== Lifecycle ====================

    private buildHttpConfig(): EstuaryConfig {
        const creds = EstuaryCredentials.instance;
        let serverUrl = creds?.serverUrl || SERVER_URL;
        if (serverUrl.startsWith('wss://')) serverUrl = 'https://' + serverUrl.substring(6);
        else if (serverUrl.startsWith('ws://')) serverUrl = 'http://' + serverUrl.substring(5);

        return {
            serverUrl: serverUrl,
            apiKey: (creds?.apiKey || API_KEY).trim(),
            characterId: '',
            playerId: creds?.userId || PLAYER_ID,
            debugLogging: true,
        };
    }

    onAwake() {
        this.createEvent('OnStartEvent').bind(() => this.initialize());
    }

    private initialize(): void {
        print('[CharacterGenDemo] ===== INITIALIZING =====');

        const creds = EstuaryCredentials.instance;
        if (!creds) {
            print('[CharacterGenDemo] FATAL: No EstuaryCredentials found in scene!');
            return;
        }

        print('[CharacterGenDemo] Server: ' + (creds.serverUrl || SERVER_URL));
        print('[CharacterGenDemo] API Key: ' + (creds.apiKey ? creds.apiKey.substring(0, 8) + '...' : 'NOT SET'));

        // InternetModule
        try {
            // @ts-ignore
            const internetModule = require('LensStudio:InternetModule') as InternetModule;
            setInternetModule(internetModule);
            print('[CharacterGenDemo] InternetModule configured');
        } catch (e: any) {
            print('[CharacterGenDemo] FATAL: Could not load InternetModule: ' + (e.message || e));
            return;
        }

        // Status text
        if (this.statusTextObject) {
            this.statusText3D = this.statusTextObject.getComponent('Component.Text3D');
            if (this.statusText3D) {
                this.setStatus('Ready');
            }
        }

        // Camera
        this.setupCameraModule();

        // Palm anchor with camera button
        if (this.frameButtonPrefab) {
            this.setupPalmAnchor();
            this.setupConfirmationPanel();
        } else {
            print('[CharacterGenDemo] WARNING: No frameButtonPrefab — camera button disabled');
        }

        // Per-frame update
        this.createEvent('UpdateEvent').bind(() => this.onUpdate());
    }

    // ==================== CameraModule ====================

    private setupCameraModule(): void {
        try {
            // @ts-ignore
            this._cameraModule = require('LensStudio:CameraModule');
        } catch (e: any) {
            print('[CharacterGenDemo] CameraModule not available: ' + (e.message || e));
            return;
        }

        if (!this._cameraModule) return;

        try {
            // @ts-ignore
            const cameraRequest = CameraModule.createCameraRequest();
            // @ts-ignore
            cameraRequest.cameraId = CameraModule.CameraId.Default_Color;
            cameraRequest.imageSmallerDimension = 512;

            this._cameraTexture = this._cameraModule.requestCamera(cameraRequest);
            if (!this._cameraTexture) {
                print('[CharacterGenDemo] Camera request returned null');
                return;
            }

            // @ts-ignore
            const provider = this._cameraTexture.control as CameraTextureProvider;
            if (provider && provider.onNewFrame) {
                provider.onNewFrame.add(() => {
                    if (!this._cameraReady) {
                        this._cameraReady = true;
                        print('[CharacterGenDemo] Camera ready');
                    }
                });
            } else {
                this._cameraReady = true;
            }

            print('[CharacterGenDemo] CameraModule set up');
        } catch (e: any) {
            print('[CharacterGenDemo] Camera setup failed: ' + (e.message || e));
        }
    }

    // ==================== Palm Anchor ====================

    private setupPalmAnchor(): void {
        try {
            this._rightHand = SIK.HandInputData.getHand('right');
        } catch (e: any) {
            print('[CharacterGenDemo] SIK HandInputData not available: ' + (e.message || e));
            return;
        }

        if (!this._rightHand) return;

        // @ts-ignore
        this._palmAnchorRoot = global.scene.createSceneObject('CameraPalmAnchor');
        this._palmAnchorRoot.setParent(this.getSceneObject());

        this._cameraButtonInstance = this.frameButtonPrefab!.instantiate(this._palmAnchorRoot);
        this._cameraButtonInstance.getTransform().setLocalPosition(new vec3(0, 0, 0));

        this.initializeFrameButton(this._cameraButtonInstance, this.cameraIconMaterial);
        this.bindPrefabTap(this._cameraButtonInstance, () => this.onCameraButtonTap());

        this.setPalmChildrenEnabled(false);
        this._palmVisible = false;

        print('[CharacterGenDemo] Palm anchor created with camera button');
    }

    private setPalmChildrenEnabled(enabled: boolean): void {
        if (!this._palmAnchorRoot) return;
        const count = this._palmAnchorRoot.getChildrenCount();
        for (let i = 0; i < count; i++) {
            this._palmAnchorRoot.getChild(i).enabled = enabled;
        }
    }

    private updatePalmAnchor(): void {
        if (!this._rightHand || !this._palmAnchorRoot) return;

        const isTracked = this._rightHand.isTracked();
        if (!isTracked) {
            // @ts-ignore
            const now: number = getTime();
            if (now - this._lastPalmShowTime > HIDE_DELAY && this._palmVisible) {
                this.setPalmChildrenEnabled(false);
                this._palmVisible = false;
                this._hasPalmInitialPos = false;
            }
            return;
        }

        let wristPos: vec3 | null = null;
        try { wristPos = this._rightHand.wrist.position; } catch (_: any) {}
        if (!wristPos) return;

        // @ts-ignore
        this._lastPalmShowTime = getTime();

        if (!this._palmVisible) {
            this.setPalmChildrenEnabled(true);
            this._palmVisible = true;
        }

        // Offset to the left (pinky side) of the right hand
        let offset = new vec3(-8, 0, 0); // fallback
        try {
            const indexPos = this._rightHand.indexKnuckle.position;
            const pinkyPos = this._rightHand.pinkyKnuckle.position;
            if (indexPos && pinkyPos) {
                // For right hand, left side = toward pinky
                const handLeft = pinkyPos.sub(indexPos).normalize();
                offset = handLeft.uniformScale(8);
            }
        } catch (_: any) {}
        const anchorPos = wristPos.add(offset);
        const transform = this._palmAnchorRoot.getTransform();

        if (!this._hasPalmInitialPos) {
            transform.setWorldPosition(anchorPos);
            this._hasPalmInitialPos = true;
        } else {
            const current = transform.getWorldPosition();
            transform.setWorldPosition(vec3.lerp(current, anchorPos, LERP_ALPHA));
        }

        // Rotate to face camera
        try {
            // @ts-ignore
            const camPos = global.scene.getRootObject(0).getTransform().getWorldPosition();
            const dir = camPos.sub(anchorPos);
            if (dir.length > 0.001) {
                const forward = dir.normalize();
                const worldUp = new vec3(0, 1, 0);
                const right = worldUp.cross(forward).normalize();
                const up = forward.cross(right).normalize();
                transform.setWorldRotation(quat.lookAt(forward, up));
            }
        } catch (_: any) {}
    }

    // ==================== State Machine ====================

    private transitionState(newState: CaptureState): void {
        const oldState = this._state;
        this._state = newState;
        print('[CharacterGenDemo] State: ' + CaptureState[oldState] + ' -> ' + CaptureState[newState]);

        // Show camera button only in Idle
        if (this._cameraButtonInstance) {
            this._cameraButtonInstance.enabled = (newState === CaptureState.Idle);
        }

        // Show confirmation panel only in Preview, positioned in front of camera
        if (this._confirmationPanel) {
            if (newState === CaptureState.Preview) {
                // Position panel in front of wherever the user is currently looking
                try {
                    // @ts-ignore - Lens Studio global scene API
                    const camTransform = global.scene.getRootObject(0).getTransform();
                    const camPos = camTransform.getWorldPosition();
                    const forward = camTransform.forward;
                    // Place 80cm in front of camera (forward is -Z in Lens Studio)
                    const panelPos = camPos.add(forward.uniformScale(PANEL_Z));
                    this._confirmationPanel.getTransform().setWorldPosition(panelPos);

                    // Orient panel to face the camera
                    const direction = camPos.sub(panelPos).normalize();
                    const worldUp = new vec3(0, 1, 0);
                    const right = worldUp.cross(direction).normalize();
                    const up = direction.cross(right).normalize();
                    this._confirmationPanel.getTransform().setWorldRotation(quat.lookAt(direction, up));
                } catch (e: any) {
                    print('[CharacterGenDemo] Could not position panel at camera: ' + (e.message || e));
                }
            }
            this._confirmationPanel.enabled = (newState === CaptureState.Preview);
        }
    }

    // ==================== Camera Button Tap → Countdown ====================

    private onCameraButtonTap(): void {
        if (this._state !== CaptureState.Idle) return;
        if (this.isGenerating) return;

        print('[CharacterGenDemo] Camera button tapped — starting countdown');
        this.startCountdown();
    }

    private startCountdown(): void {
        this.transitionState(CaptureState.Countdown);

        let count = 3;
        this.setStatus(String(count));

        // @ts-ignore
        let lastTick: number = getTime();
        const countdownEvent = this.createEvent('UpdateEvent');
        countdownEvent.bind(() => {
            // @ts-ignore
            const now: number = getTime();
            if (now - lastTick >= 1.0) {
                lastTick = now;
                count--;
                if (count > 0) {
                    this.setStatus(String(count));
                } else {
                    countdownEvent.enabled = false;
                    this.setStatus('');
                    this.capturePhoto();
                }
            }
        });
    }

    // ==================== Photo Capture ====================

    private capturePhoto(): void {
        if (!this._cameraTexture || !this._cameraReady) {
            print('[CharacterGenDemo] Camera not ready');
            this.setStatus('Camera not ready');
            this.transitionState(CaptureState.Idle);
            return;
        }

        print('[CharacterGenDemo] Capturing photo...');

        // Freeze the camera texture for preview using ProceduralTextureProvider
        if (this._previewImage) {
            try {
                // @ts-ignore - Lens Studio ProceduralTextureProvider
                const staticTex = ProceduralTextureProvider.createFromTexture(this._cameraTexture);
                const mat = this._previewImage.mainMaterial.clone();
                mat.mainPass.baseTex = staticTex;
                this._previewImage.mainMaterial = mat;
                print('[CharacterGenDemo] Preview frozen');
            } catch (e: any) {
                print('[CharacterGenDemo] Preview freeze failed: ' + (e.message || e));
                // Fallback: show live feed (better than nothing)
                try {
                    this._previewImage.mainMaterial.mainPass.baseTex = this._cameraTexture;
                } catch (_: any) {}
            }
        }

        // Encode full frame for upload
        this.encodeTexture(this._cameraTexture).then((base64) => {
            this._capturedImageBase64 = base64;
            print('[CharacterGenDemo] Photo encoded: ' + Math.round(base64.length / 1024) + 'KB');
            this.transitionState(CaptureState.Preview);
        }).catch((err: any) => {
            print('[CharacterGenDemo] Encode failed: ' + (err.message || err));
            this.setStatus('Capture failed');
            this.transitionState(CaptureState.Idle);
        });
    }

    // ==================== Confirmation Panel ====================

    private setupConfirmationPanel(): void {
        if (!this.confirmButtonPrefab) {
            print('[CharacterGenDemo] No confirmButtonPrefab — confirmation panel disabled');
            return;
        }

        // @ts-ignore
        this._confirmationPanel = global.scene.createSceneObject('ConfirmationPanel');
        this._confirmationPanel.setParent(this.getSceneObject());
        this._confirmationPanel.getTransform().setLocalPosition(new vec3(0, 0, PANEL_Z));
        this._confirmationPanel.enabled = false;

        // Preview image
        if (this.previewImageObject) {
            this.previewImageObject.setParent(this._confirmationPanel);
            this.previewImageObject.getTransform().setLocalPosition(new vec3(0, 5, 0));
            this.previewImageObject.getTransform().setLocalScale(new vec3(15, 15, 1));
            try {
                this._previewImage = this.previewImageObject.getComponent('Component.Image');
                if (this._previewImage) {
                    print('[CharacterGenDemo] Preview image wired');
                }
            } catch (e: any) {
                print('[CharacterGenDemo] Preview setup failed: ' + (e.message || e));
            }
        }

        // Cancel button
        const cancelBtn = this.confirmButtonPrefab.instantiate(this._confirmationPanel);
        cancelBtn.getTransform().setLocalPosition(new vec3(-8, -8, 0));
        this.initializeFrameButton(cancelBtn, this.cancelIconMaterial);
        this.bindPrefabTap(cancelBtn, () => this.cancelCapture());

        // Send button
        const sendBtn = this.confirmButtonPrefab.instantiate(this._confirmationPanel);
        sendBtn.getTransform().setLocalPosition(new vec3(8, -8, 0));
        this.initializeFrameButton(sendBtn, this.checkmarkIconMaterial);
        this.bindPrefabTap(sendBtn, () => this.sendCapture());

        print('[CharacterGenDemo] Confirmation panel created');
    }

    private cancelCapture(): void {
        print('[CharacterGenDemo] Capture cancelled');
        this._capturedImageBase64 = null;
        this.transitionState(CaptureState.Idle);
        this.setStatus('Ready');
    }

    private sendCapture(): void {
        if (!this._capturedImageBase64) {
            print('[CharacterGenDemo] No captured image to send');
            this.transitionState(CaptureState.Idle);
            return;
        }

        print('[CharacterGenDemo] Sending captured image...');
        this.transitionState(CaptureState.Uploading);

        const imageBase64 = this._capturedImageBase64;
        this._capturedImageBase64 = null;

        this.runGenerationPipeline(imageBase64);
    }

    // ==================== Per-Frame Update ====================

    private onUpdate(): void {
        this.updatePalmAnchor();
    }

    // ==================== Button Helpers ====================

    private bindPrefabTap(obj: SceneObject, callback: () => void): void {
        const scripts = obj.getComponents('Component.ScriptComponent') as any[];
        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && sc.onTriggerUp && sc.onTriggerUp.add) { sc.onTriggerUp.add(callback); return; }
            if (sc && sc.onButtonPinched) { sc.onButtonPinched.add(callback); return; }
        }
        print('[CharacterGenDemo] WARNING: No tap handler found on prefab');
    }

    private initializeFrameButton(obj: SceneObject, iconMaterial?: Material): void {
        try {
            const scripts = obj.getComponents('Component.ScriptComponent') as any[];

            let frameButtonScript: any = null;
            for (const sc of scripts) {
                if (sc && sc.image && typeof sc.initialize === 'function') {
                    frameButtonScript = sc;
                    break;
                }
            }

            for (const sc of scripts) {
                if (sc && typeof sc.initialize === 'function') {
                    try { sc.initialize(null); } catch (_: any) {}
                }
            }

            if (iconMaterial && frameButtonScript && frameButtonScript.image) {
                frameButtonScript.image.mainMaterial = iconMaterial;
                try {
                    const img = frameButtonScript.image;
                    if (img.mainMaterial && img.mainMaterial.mainPass) {
                        img.mainMaterial.mainPass.depthTest = false;
                        img.mainMaterial.mainPass.depthWrite = false;
                    }
                } catch (_: any) {}
            } else if (iconMaterial) {
                // @ts-ignore
                const images = obj.getComponentsRecursive('Component.Image') as any[];
                for (const img of images) {
                    try {
                        if (img) { img.mainMaterial = iconMaterial; break; }
                    } catch (_: any) {}
                }
            }
        } catch (e: any) {
            print('[CharacterGenDemo] initializeFrameButton error: ' + (e.message || e));
        }
    }

    // ==================== Texture Encoding ====================

    private encodeTexture(texture: Texture): Promise<string> {
        return new Promise((resolve, reject) => {
            // @ts-ignore
            Base64.encodeTextureAsync(
                texture,
                (encoded: string) => resolve(encoded),
                () => reject(new Error('Texture encoding failed')),
                // @ts-ignore
                CompressionQuality.HighQuality,
                // @ts-ignore
                EncodingType.Png
            );
        });
    }

    // ==================== Generation Pipeline ====================

    private async runGenerationPipeline(imageBase64: string): Promise<void> {
        this.isGenerating = true;
        // @ts-ignore
        const pipelineStart = getTime();
        print('[CharacterGenDemo] ===== GENERATION PIPELINE START =====');

        try {
            // Strip data URI prefix if present
            const prefixIndex = imageBase64.indexOf(',');
            if (prefixIndex !== -1 && prefixIndex < 100) {
                imageBase64 = imageBase64.substring(prefixIndex + 1);
            }

            print('[CharacterGenDemo] Image payload: ' + Math.round(imageBase64.length / 1024) + 'KB');

            const config = this.buildHttpConfig();
            const httpClient = new EstuaryHttpClient(config);

            // Upload image → create character
            this.setStatus('Creating character...');
            const options: ImageToCharacterOptions = {};
            if (this.appearancePrompt) options.appearancePrompt = this.appearancePrompt;
            if (this.voicePrompt) options.voicePrompt = this.voicePrompt;
            if (this.personaPrompt) options.personaPrompt = this.personaPrompt;
            const agent = await httpClient.uploadImageToCharacter(imageBase64, 'image/png', options);
            print('[CharacterGenDemo] Character created: "' + agent.name + '" (' + agent.id + ')');
            this.setStatus('Character "' + agent.name + '" created!');

            // Trigger model generation
            this.setStatus('Starting 3D model generation...');
            await httpClient.generateModel(agent.id);

            // Poll for model completion
            this.setStatus('Generating model (0%)...');
            // @ts-ignore
            const pollStart = getTime();
            httpClient.pollModelStatus(
                agent.id,
                (status: ModelStatusResponse) => {
                    this.setStatus('Generating model (' + status.progress + '%)...');
                },
                (status: ModelStatusResponse) => {
                    // @ts-ignore
                    print('[CharacterGenDemo] Model COMPLETE after ' + ((getTime() - pollStart)).toFixed(1) + 's');
                    this.setStatus('Downloading 3D model...');
                    this.downloadAndDisplayModel(httpClient, status, pipelineStart, agent.id, agent.name);
                },
                (error: string) => {
                    print('[CharacterGenDemo] Poll FAILED: ' + error);
                    this.setStatus('Failed - tap to retry');
                    this.isGenerating = false;
                    this.transitionState(CaptureState.Idle);
                }
            );
        } catch (error: any) {
            print('[CharacterGenDemo] PIPELINE ERROR: ' + (error.message || error));
            this.setStatus('Failed - tap to retry');
            this.isGenerating = false;
            this.transitionState(CaptureState.Idle);
        }
    }

    // ==================== Model Download & Display ====================

    private async downloadAndDisplayModel(
        httpClient: EstuaryHttpClient,
        status: ModelStatusResponse,
        pipelineStart: number,
        agentId: string,
        agentName: string
    ): Promise<void> {
        try {
            const modelUrl = status.modelUrl || status.modelPreviewUrl;
            if (!modelUrl) {
                this.setStatus('No model URL — connecting voice...');
                this.isGenerating = false;
                this.transitionState(CaptureState.Idle);
                this.startVoiceConnection(agentId, agentName);
                return;
            }

            // @ts-ignore
            const modelParent = global.scene.createSceneObject('GeneratedCharacter');
            try {
                // Position model in front of wherever the user is currently looking
                // @ts-ignore - Lens Studio global scene API
                const camTransform = global.scene.getRootObject(0).getTransform();
                const camPos = camTransform.getWorldPosition();
                const forward = camTransform.forward;
                const modelPos = camPos.add(forward.uniformScale(-100));
                modelParent.getTransform().setWorldPosition(modelPos);

                // Orient model to face the camera
                const direction = camPos.sub(modelPos).normalize();
                const worldUp = new vec3(0, 1, 0);
                const right = worldUp.cross(direction).normalize();
                const up = direction.cross(right).normalize();
                modelParent.getTransform().setWorldRotation(quat.lookAt(direction, up));
            } catch (_: any) {
                modelParent.getTransform().setWorldPosition(new vec3(0, 0, -100));
            }
            modelParent.getTransform().setLocalScale(new vec3(0.3, 0.3, 0.3));

            let material = this.defaultMaterial;
            if (!material) {
                print('[CharacterGenDemo] No defaultMaterial — skipping GLB');
                this.isGenerating = false;
                this.transitionState(CaptureState.Idle);
                this.startVoiceConnection(agentId, agentName);
                return;
            }

            this.setStatus('Loading 3D model...');
            await httpClient.downloadAndInstantiateGlb(modelUrl, modelParent, material);

            // @ts-ignore
            print('[CharacterGenDemo] Pipeline complete in ' + ((getTime() - pipelineStart)).toFixed(1) + 's');
            this.setStatus('Done! Connecting voice...');
            this.isGenerating = false;
            this.transitionState(CaptureState.Idle);
            this.startVoiceConnection(agentId, agentName);
        } catch (error: any) {
            print('[CharacterGenDemo] GLB error: ' + (error.message || error));
            this.setStatus('Model failed — connecting voice...');
            this.isGenerating = false;
            this.transitionState(CaptureState.Idle);
            this.startVoiceConnection(agentId, agentName);
        }
    }

    // ==================== Voice Connection ====================

    private startVoiceConnection(agentId: string, agentName: string): void {
        if (!this.voiceConnectionObject) return;

        print('[CharacterGenDemo] Starting voice for "' + agentName + '"');

        const creds = EstuaryCredentials.instance;
        if (creds) {
            creds.characterId = agentId;
        }

        this.voiceConnectionObject.enabled = true;

        const greeting = this.greetingMessage || 'Hello! I just created you from a photo. Introduce yourself as ' + agentName + '!';

        // @ts-ignore
        const greetStart = getTime();
        const greetEvent = this.createEvent('UpdateEvent');
        greetEvent.bind(() => {
            // @ts-ignore
            const elapsed = getTime() - greetStart;
            if (elapsed > 30) {
                greetEvent.enabled = false;
                return;
            }

            const scripts = this.voiceConnectionObject.getComponents('Component.ScriptComponent') as any[];
            for (let i = 0; i < scripts.length; i++) {
                const sc = scripts[i] as any;
                if (sc && typeof sc.sendMessage === 'function' && typeof sc.getCharacter === 'function') {
                    const character = sc.getCharacter();
                    if (character && character.isConnected) {
                        greetEvent.enabled = false;
                        print('[CharacterGenDemo] Voice connected — sending greeting');
                        this.setStatus('Talking...');
                        sc.sendMessage(greeting);
                        return;
                    }
                }
            }
        });
    }

    // ==================== Status Display ====================

    private setStatus(text: string): void {
        if (this.statusText3D) {
            this.statusText3D.text = text;
        }
        print('[CharacterGenDemo] Status: ' + text);
    }
}
