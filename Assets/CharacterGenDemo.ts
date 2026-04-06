/**
 * CharacterGenDemo - Full character generation pipeline demo for Spectacles.
 *
 * Demonstrates: viewfinder crop -> image upload -> character creation -> model generation -> GLB display -> voice.
 *
 * Setup in Lens Studio:
 * 1. Add EstuaryCredentials to a SceneObject (set API key & server URL)
 * 2. Add this script to a SceneObject
 * 3. Drag Paper-San.png to paperSanTexture input (fallback when camera unavailable)
 * 4. Assign a GLTF material to defaultMaterial (NOT PBR!)
 * 5. (Optional) Set existingCharacterId to load a character instead of generating
 * 6. (Optional) Wire voiceConnectionObject to a disabled EstuaryVoiceConnection SceneObject
 * 7. (Optional) Wire generateButtonObject to a PinchButton (legacy fallback)
 * 8. (New) Wire roundButtonPrefab to a SIK RoundButton prefab for palm-anchored viewfinder toggle
 * 9. (New) Wire pinchButtonPrefab to a SIK PinchButton prefab for Cancel/Send buttons
 * 10. (New) Wire cropRenderTarget to the CropRenderTarget asset (512x512)
 * 11. (New) Wire cropMaterial to a flat material for the crop quad
 *
 * Credentials (API key, server URL, player ID) are read from EstuaryCredentials.
 * InternetModule is obtained automatically via require().
 */

import { setInternetModule } from './estuary-lens-studio-sdk/src/Core/EstuaryClient';
import { EstuaryHttpClient } from './estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { EstuaryConfig } from './estuary-lens-studio-sdk/src/Core/EstuaryConfig';
import { EstuaryCredentials } from './estuary-lens-studio-sdk/src/Components/EstuaryCredentials';
import { ModelStatusResponse } from './estuary-lens-studio-sdk/src/Models/ModelStatusResponse';
import SIK from 'SpectaclesInteractionKit.lspkg/SIK';

// ==================== Configuration Constants ====================

/** Replace with your Estuary API key */
const API_KEY = 'YOUR_API_KEY_HERE';

/** Player ID for this demo session */
const PLAYER_ID = 'spectacles-chargen-demo';

/** Estuary API server URL */
const SERVER_URL = 'https://api.estuary-ai.com';

/** Lerp alpha for palm anchor smoothing */
const LERP_ALPHA = 0.15;

/** Hide hysteresis delay for palm anchor (seconds) */
const HIDE_DELAY = 1.0;

/** Distance from camera for the viewfinder overlay plane (cm) */
const OVERLAY_Z = -50;

/** Distance from camera for the confirmation panel (cm) */
const PANEL_Z = -80;

/** Minimum crop rectangle size (in screen-space [0,1]) to accept as valid */
const MIN_CROP_SIZE = 0.05;

/** Border quad thickness for the rectangle overlay (cm) */
const BORDER_THICKNESS = 0.3;

// ==================== Viewfinder State Machine ====================

enum ViewfinderState {
    /** No viewfinder, RoundButton visible on palm */
    Inactive,
    /** Viewfinder active, waiting for pinch to start drag */
    Ready,
    /** User is pinch-dragging to define a crop rectangle */
    Dragging,
    /** Crop captured, confirmation panel showing preview */
    Preview,
    /** Upload + generation in progress */
    Uploading,
}

// ==================== Component ====================

@component
export class CharacterGenDemo extends BaseScriptComponent {

    // ==================== Inputs (set in Inspector) ====================

    /** Paper-San.png texture from Resources panel (fallback when camera unavailable) */
    @input
    paperSanTexture: Texture;

    /** Any PBR material from the scene (GLB embeds its own materials, so this is a formality) */
    @input
    @allowUndefined
    defaultMaterial: Material;

    /** Optional: SceneObject with a Text3D component for status display */
    @input
    @allowUndefined
    statusTextObject: SceneObject;

    /** Optional: SceneObject with a PinchButton from SpectaclesInteractionKit (legacy fallback) */
    @input
    @allowUndefined
    generateButtonObject: SceneObject;

    /** SceneObject with EstuaryVoiceConnection script (initially DISABLED in scene).
     *  After GLB loads, CharacterGenDemo enables this to start voice conversation. */
    @input
    @allowUndefined
    voiceConnectionObject: SceneObject;

    /** Greeting message sent to the character after voice connects. Set empty to skip. */
    @input
    @allowUndefined
    greetingMessage: string;

    /** Existing character ID to load instead of generating new. Skips photo upload + model generation. */
    @input
    @allowUndefined
    existingCharacterId: string;

    /** SIK RoundButton prefab to instantiate on right palm for viewfinder toggle */
    @input
    @allowUndefined
    roundButtonPrefab: ObjectPrefab;

    /** SIK PinchButton prefab for Cancel/Send buttons on confirmation panel */
    @input
    @allowUndefined
    pinchButtonPrefab: ObjectPrefab;

    /** The 512x512 CropRenderTarget asset (assigned in Inspector) */
    @input
    @allowUndefined
    cropRenderTarget: Texture;

    /** Material clone source for the crop quad */
    @input
    @allowUndefined
    cropMaterial: Material;

    // ==================== Private State ====================

    /** Cached Text3D component from statusTextObject */
    private statusText3D: any = null;

    /** Whether a generation is currently in progress */
    private isGenerating: boolean = false;

    /** Current viewfinder state */
    private _viewfinderState: ViewfinderState = ViewfinderState.Inactive;

    /** Right hand reference from SIK */
    private _rightHand: any = null;

    /** Palm anchor root SceneObject for the RoundButton */
    private _palmAnchorRoot: SceneObject | null = null;

    /** RoundButton instance on the palm */
    private _roundButtonInstance: SceneObject | null = null;

    /** Whether we have initial palm position (avoids lerping from origin) */
    private _hasPalmInitialPos: boolean = false;

    /** Last time the palm was visible (for hide hysteresis) */
    private _lastPalmShowTime: number = 0;

    /** Whether palm children are currently visible */
    private _palmVisible: boolean = false;

    /** Camera texture from CameraModule */
    private _cameraTexture: Texture | null = null;

    /** Whether camera is ready and receiving frames */
    private _cameraReady: boolean = false;

    /** Drag start position in screen space [0,1] */
    private _dragStartScreen: vec2 | null = null;

    /** Viewfinder overlay root (contains 4 border quads) */
    private _viewfinderOverlay: SceneObject | null = null;

    /** The 4 border quad SceneObjects [top, bottom, left, right] */
    private _borderQuads: SceneObject[] = [];

    /** Crop quad for RenderTarget capture */
    private _cropQuad: SceneObject | null = null;

    /** Crop camera for RenderTarget capture */
    private _cropCamera: SceneObject | null = null;

    /** Captured image base64 from the viewfinder crop */
    private _capturedImageBase64: string | null = null;

    /** Confirmation panel root SceneObject */
    private _confirmationPanel: SceneObject | null = null;

    /** CameraModule reference */
    private _cameraModule: any = null;

    // ==================== Lifecycle ====================

    /** Build HTTP client config from EstuaryCredentials */
    private buildHttpConfig(): EstuaryConfig {
        const creds = EstuaryCredentials.instance;
        let serverUrl = creds?.serverUrl || SERVER_URL;
        // Convert ws:// to http:// for REST calls
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
        // Defer initialization to let EstuaryCredentials.onAwake() register the singleton first
        this.createEvent('OnStartEvent').bind(() => this.initialize());
    }

    private initialize(): void {
        print('[CharacterGenDemo] ===== INITIALIZING =====');

        // Pull credentials from EstuaryCredentials singleton
        const creds = EstuaryCredentials.instance;
        if (!creds) {
            print('[CharacterGenDemo] FATAL: No EstuaryCredentials found in scene!');
            print('[CharacterGenDemo] Add an EstuaryCredentials component to a SceneObject.');
            return;
        }

        // Resolve server URL: EstuaryCredentials uses wss://, we need https:// for REST
        let httpServerUrl = creds.serverUrl || SERVER_URL;
        if (httpServerUrl.startsWith('wss://')) {
            httpServerUrl = 'https://' + httpServerUrl.substring(6);
        } else if (httpServerUrl.startsWith('ws://')) {
            httpServerUrl = 'http://' + httpServerUrl.substring(5);
        }

        print('[CharacterGenDemo] Server: ' + httpServerUrl + ' (from EstuaryCredentials)');
        print('[CharacterGenDemo] API Key: ' + (creds.apiKey ? creds.apiKey.substring(0, 8) + '...' : 'NOT SET'));
        print('[CharacterGenDemo] Player ID: ' + (creds.userId || PLAYER_ID));

        // Log input state
        print('[CharacterGenDemo] Inputs:');
        print('[CharacterGenDemo]   paperSanTexture: ' + (this.paperSanTexture ? 'SET' : 'not set (needed for generation only)'));
        print('[CharacterGenDemo]   defaultMaterial: ' + (this.defaultMaterial ? 'SET' : 'not set (will auto-discover)'));
        print('[CharacterGenDemo]   statusTextObject: ' + (this.statusTextObject ? 'SET' : 'not set (will auto-create)'));
        print('[CharacterGenDemo]   generateButtonObject: ' + (this.generateButtonObject ? 'SET' : 'not set (will auto-start)'));
        print('[CharacterGenDemo]   existingCharacterId: ' + (this.existingCharacterId || 'not set (will generate new)'));
        print('[CharacterGenDemo]   roundButtonPrefab: ' + (this.roundButtonPrefab ? 'SET' : 'not set'));
        print('[CharacterGenDemo]   pinchButtonPrefab: ' + (this.pinchButtonPrefab ? 'SET' : 'not set'));
        print('[CharacterGenDemo]   cropRenderTarget: ' + (this.cropRenderTarget ? 'SET' : 'not set'));
        print('[CharacterGenDemo]   cropMaterial: ' + (this.cropMaterial ? 'SET' : 'not set'));

        // Set up InternetModule via require() (needed for GLB download)
        try {
            // @ts-ignore - Lens Studio module system
            const internetModule = require('LensStudio:InternetModule') as InternetModule;
            setInternetModule(internetModule);
            print('[CharacterGenDemo] InternetModule configured via require()');
        } catch (e: any) {
            print('[CharacterGenDemo] FATAL: Could not load InternetModule: ' + (e.message || e));
            return;
        }

        // Set up status text display
        if (this.statusTextObject) {
            this.statusText3D = this.statusTextObject.getComponent('Component.Text3D');
            if (this.statusText3D) {
                this.statusText3D.text = 'Tap to Generate';
                print('[CharacterGenDemo] Status text configured');
            } else {
                print('[CharacterGenDemo] WARNING: statusTextObject has no Text3D component');
            }
        } else {
            print('[CharacterGenDemo] No statusTextObject -- status will be logged only');
        }

        // Check for existing character ID -- skip generation if set
        if (this.existingCharacterId) {
            print('[CharacterGenDemo] existingCharacterId set: ' + this.existingCharacterId);
            print('[CharacterGenDemo] Skipping generation -- loading existing character');
            this.loadExistingCharacter(this.existingCharacterId);
            return;
        }

        // Set up CameraModule for viewfinder (only when not using existingCharacterId)
        this.setupCameraModule();

        // Set up right-hand palm anchor with RoundButton (viewfinder toggle)
        if (this.roundButtonPrefab) {
            this.setupPalmAnchor();
            this.setupViewfinderOverlay();
            this.setupCropPipeline();
            this.setupConfirmationPanel();
            this.setupPinchDragTracking();
        }

        // Legacy: discover and bind PinchButton, or auto-start after delay
        if (this.generateButtonObject) {
            this.bindPinchButton();
        } else if (!this.roundButtonPrefab) {
            // Pure legacy mode: no RoundButton, no generateButton -> auto-start in 3s
            print('[CharacterGenDemo] No generateButtonObject or roundButtonPrefab assigned');
            print('[CharacterGenDemo] Auto-starting generation in 3 seconds...');
            this.setStatus('Starting in 3s...');

            // @ts-ignore - Lens Studio getTime global
            const startTime = getTime();
            const delayEvent = this.createEvent('UpdateEvent');
            delayEvent.bind(() => {
                // @ts-ignore - Lens Studio getTime global
                if (getTime() - startTime >= 3.0) {
                    delayEvent.enabled = false;
                    this.startGeneration();
                }
            });
        }

        // Start per-frame update
        this.createEvent('UpdateEvent').bind(() => this.onUpdate());
    }

    // ==================== CameraModule Setup ====================

    /**
     * Set up CameraModule for viewfinder capture.
     * MUST be called in OnStartEvent (NOT onAwake) per Lens Studio requirements.
     */
    private setupCameraModule(): void {
        try {
            // @ts-ignore - Lens Studio module system
            this._cameraModule = require('LensStudio:CameraModule');
        } catch (e: any) {
            print('[CharacterGenDemo] CameraModule not available (expected in Preview): ' + (e.message || e));
            return;
        }

        if (!this._cameraModule) {
            print('[CharacterGenDemo] CameraModule is null -- camera features disabled');
            return;
        }

        try {
            // @ts-ignore - Lens Studio API
            const cameraRequest = CameraModule.createCameraRequest();
            // @ts-ignore - Lens Studio API
            cameraRequest.cameraId = CameraModule.CameraId.Default_Color;
            cameraRequest.imageSmallerDimension = 512;

            this._cameraTexture = this._cameraModule.requestCamera(cameraRequest);

            if (!this._cameraTexture) {
                print('[CharacterGenDemo] Camera request returned null texture');
                return;
            }

            // Register onNewFrame to detect camera readiness
            // @ts-ignore - Lens Studio API
            const provider = this._cameraTexture.control as CameraTextureProvider;
            if (provider && provider.onNewFrame) {
                provider.onNewFrame.add(() => {
                    if (!this._cameraReady) {
                        this._cameraReady = true;
                        print('[CharacterGenDemo] Camera ready and receiving frames');
                    }
                });
            } else {
                // Fallback: assume ready
                this._cameraReady = true;
            }

            print('[CharacterGenDemo] CameraModule set up successfully');
        } catch (e: any) {
            print('[CharacterGenDemo] Camera setup failed: ' + (e.message || e));
        }
    }

    // ==================== Right-Hand Palm Anchor ====================

    /**
     * Set up right-hand palm anchor with RoundButton for viewfinder toggle.
     * Adapts the PalmAnchor.ts pattern for the right hand.
     */
    private setupPalmAnchor(): void {
        try {
            const handInputData = SIK.HandInputData;
            this._rightHand = handInputData.getHand('right');
        } catch (e: any) {
            print('[CharacterGenDemo] SIK HandInputData not available: ' + (e.message || e));
            return;
        }

        if (!this._rightHand) {
            print('[CharacterGenDemo] WARNING: Could not get right hand from SIK');
            return;
        }

        // Create palm anchor root as child of this SceneObject
        // @ts-ignore - Lens Studio global.scene API
        this._palmAnchorRoot = global.scene.createSceneObject('ViewfinderPalmAnchor');
        this._palmAnchorRoot.setParent(this.getSceneObject());

        // Instantiate RoundButton as child of palm anchor
        this._roundButtonInstance = this.roundButtonPrefab!.instantiate(this._palmAnchorRoot);
        this._roundButtonInstance.getTransform().setLocalPosition(new vec3(0, 0, 0));

        // Bind RoundButton tap via duck-typing
        this.bindPrefabTap(this._roundButtonInstance, () => this.toggleViewfinder());

        // Start with children hidden until hand is detected
        this.setPalmChildrenEnabled(false);
        this._palmVisible = false;

        print('[CharacterGenDemo] Right-hand palm anchor created with RoundButton');
    }

    /**
     * Per-frame update for palm anchor position tracking and hand visibility.
     */
    private updatePalmAnchor(): void {
        if (!this._rightHand || !this._palmAnchorRoot) return;

        const isTracked = this._rightHand.isTracked();
        if (!isTracked) {
            this._hasPalmInitialPos = false;
            // Hysteresis: hide after delay
            // @ts-ignore
            const now: number = getTime();
            if (this._palmVisible && (now - this._lastPalmShowTime > HIDE_DELAY)) {
                this.setPalmChildrenEnabled(false);
                this._palmVisible = false;
            }
            return;
        }

        let wristPos: vec3 | null = null;
        try {
            wristPos = this._rightHand.wrist.position;
        } catch (_: any) {}

        if (!wristPos) return;

        // @ts-ignore
        const now: number = getTime();
        this._lastPalmShowTime = now;

        // Show palm anchor
        if (!this._palmVisible) {
            this.setPalmChildrenEnabled(true);
            this._palmVisible = true;
        }

        // Update position with lerp smoothing
        const transform = this._palmAnchorRoot.getTransform();
        if (!this._hasPalmInitialPos) {
            transform.setWorldPosition(wristPos);
            this._hasPalmInitialPos = true;
        } else {
            const currentPos = transform.getWorldPosition();
            const smoothed = vec3.lerp(currentPos, wristPos, LERP_ALPHA);
            transform.setWorldPosition(smoothed);
        }

        // Orient to face camera
        this.faceCameraTransform(transform, wristPos);

        // Control RoundButton visibility based on viewfinder state
        if (this._roundButtonInstance) {
            const hideButton = this._viewfinderState === ViewfinderState.Dragging ||
                               this._viewfinderState === ViewfinderState.Uploading;
            this._roundButtonInstance.enabled = !hideButton;
        }
    }

    /**
     * Orient a transform to face the camera (adapted from PalmAnchor.ts).
     */
    private faceCameraTransform(transform: Transform, position: vec3): void {
        try {
            // @ts-ignore - Lens Studio global scene API
            const cam = global.scene.getRootObject(0).getTransform();
            const camPos = cam.getWorldPosition();
            const direction = camPos.sub(position);
            if (direction.length < 0.001) return;

            const forward = direction.normalize();
            const worldUp = new vec3(0, 1, 0);
            const right = worldUp.cross(forward).normalize();
            const up = forward.cross(right).normalize();
            const rot = quat.lookAt(forward, up);
            transform.setWorldRotation(rot);
        } catch (_: any) {}
    }

    /**
     * Show/hide all children of the palm anchor root.
     */
    private setPalmChildrenEnabled(enabled: boolean): void {
        if (!this._palmAnchorRoot) return;
        const count = this._palmAnchorRoot.getChildrenCount();
        for (let i = 0; i < count; i++) {
            this._palmAnchorRoot.getChild(i).enabled = enabled;
        }
    }

    // ==================== Viewfinder State Machine ====================

    /**
     * Toggle the viewfinder mode on/off.
     * Called when the RoundButton on the palm is tapped.
     */
    private toggleViewfinder(): void {
        if (this._viewfinderState === ViewfinderState.Inactive) {
            this.transitionState(ViewfinderState.Ready);
            this.setStatus('Pinch & drag to crop');
        } else if (this._viewfinderState === ViewfinderState.Ready ||
                   this._viewfinderState === ViewfinderState.Preview) {
            this.transitionState(ViewfinderState.Inactive);
            this.setStatus('Viewfinder off');
        }
        // Ignore taps during Dragging or Uploading
    }

    /**
     * Transition to a new viewfinder state with logging and UI updates.
     */
    private transitionState(newState: ViewfinderState): void {
        const oldState = this._viewfinderState;
        this._viewfinderState = newState;
        print('[CharacterGenDemo] State: ' + ViewfinderState[oldState] + ' -> ' + ViewfinderState[newState]);

        // Update UI based on state
        this.updateViewfinderUI();
    }

    /**
     * Update UI element visibility based on the current viewfinder state.
     */
    private updateViewfinderUI(): void {
        const state = this._viewfinderState;

        // Viewfinder overlay: show in Ready and Dragging
        if (this._viewfinderOverlay) {
            this._viewfinderOverlay.enabled = (state === ViewfinderState.Ready || state === ViewfinderState.Dragging);
        }

        // Confirmation panel: show in Preview
        if (this._confirmationPanel) {
            this._confirmationPanel.enabled = (state === ViewfinderState.Preview);
        }

        // Clear border quads when entering Ready (clean slate)
        if (state === ViewfinderState.Ready) {
            this.clearRectangleOverlay();
        }
    }

    // ==================== Viewfinder Overlay (4 Border Quads) ====================

    /**
     * Create the viewfinder overlay with 4 border quads for rectangle display.
     */
    private setupViewfinderOverlay(): void {
        // @ts-ignore
        this._viewfinderOverlay = global.scene.createSceneObject('ViewfinderOverlay');
        this._viewfinderOverlay.setParent(this.getSceneObject());
        this._viewfinderOverlay.enabled = false;

        // Create 4 border quads: top, bottom, left, right
        const borderNames = ['TopBorder', 'BottomBorder', 'LeftBorder', 'RightBorder'];
        for (let i = 0; i < 4; i++) {
            // @ts-ignore
            const quad = global.scene.createSceneObject(borderNames[i]);
            quad.setParent(this._viewfinderOverlay);

            try {
                const image = quad.createComponent('Component.Image') as any;
                if (image) {
                    // Set a flat white color by adjusting the material
                    try {
                        const mat = image.mainMaterial.clone();
                        mat.mainPass.baseColor = new vec4(1, 1, 1, 0.9);
                        image.mainMaterial = mat;
                    } catch (_: any) {}
                }
            } catch (e: any) {
                print('[CharacterGenDemo] Border quad Image creation failed: ' + (e.message || e));
            }

            this._borderQuads.push(quad);
        }

        print('[CharacterGenDemo] Viewfinder overlay created with 4 border quads');
    }

    /**
     * Update the rectangle overlay positions based on screen-space start/end points.
     */
    private updateRectangleOverlay(start: vec2, end: vec2): void {
        if (this._borderQuads.length !== 4) return;

        // Normalize coordinates
        const minX = Math.min(start.x, end.x);
        const maxX = Math.max(start.x, end.x);
        const minY = Math.min(start.y, end.y);
        const maxY = Math.max(start.y, end.y);

        // Convert screen-space [0,1] to world-space positions at OVERLAY_Z from camera
        // Screen (0,0) is top-left, (1,1) is bottom-right in Lens Studio
        // We'll map to a plane at z=OVERLAY_Z, with a reasonable world-space extent
        const worldExtent = 60; // cm, half-extent of the viewable area at OVERLAY_Z

        const worldMinX = (minX - 0.5) * 2 * worldExtent;
        const worldMaxX = (maxX - 0.5) * 2 * worldExtent;
        // Flip Y: screen Y increases downward, world Y increases upward
        const worldMinY = (0.5 - maxY) * 2 * worldExtent;
        const worldMaxY = (0.5 - minY) * 2 * worldExtent;

        const worldWidth = worldMaxX - worldMinX;
        const worldHeight = worldMaxY - worldMinY;
        const centerX = (worldMinX + worldMaxX) / 2;
        const centerY = (worldMinY + worldMaxY) / 2;

        // Top border
        this._borderQuads[0].getTransform().setLocalPosition(new vec3(centerX, worldMaxY, OVERLAY_Z));
        this._borderQuads[0].getTransform().setLocalScale(new vec3(worldWidth, BORDER_THICKNESS, 1));

        // Bottom border
        this._borderQuads[1].getTransform().setLocalPosition(new vec3(centerX, worldMinY, OVERLAY_Z));
        this._borderQuads[1].getTransform().setLocalScale(new vec3(worldWidth, BORDER_THICKNESS, 1));

        // Left border
        this._borderQuads[2].getTransform().setLocalPosition(new vec3(worldMinX, centerY, OVERLAY_Z));
        this._borderQuads[2].getTransform().setLocalScale(new vec3(BORDER_THICKNESS, worldHeight, 1));

        // Right border
        this._borderQuads[3].getTransform().setLocalPosition(new vec3(worldMaxX, centerY, OVERLAY_Z));
        this._borderQuads[3].getTransform().setLocalScale(new vec3(BORDER_THICKNESS, worldHeight, 1));
    }

    /**
     * Clear/reset the rectangle overlay (hide border quads).
     */
    private clearRectangleOverlay(): void {
        for (const quad of this._borderQuads) {
            quad.getTransform().setLocalScale(new vec3(0, 0, 0));
        }
    }

    // ==================== Pinch-Drag Rectangle Tracking ====================

    /**
     * Set up pinch-drag tracking on the right hand for crop rectangle definition.
     */
    private setupPinchDragTracking(): void {
        if (!this._rightHand) return;

        this._rightHand.onPinchDown.add(() => {
            // Only process when in Ready state to avoid conflicts with SIK buttons
            if (this._viewfinderState !== ViewfinderState.Ready) return;

            try {
                this._dragStartScreen = this._rightHand.indexTip.screenPosition;
                if (this._dragStartScreen) {
                    this.transitionState(ViewfinderState.Dragging);
                    print('[CharacterGenDemo] Pinch-drag started at (' +
                        this._dragStartScreen.x.toFixed(3) + ', ' +
                        this._dragStartScreen.y.toFixed(3) + ')');
                }
            } catch (e: any) {
                print('[CharacterGenDemo] Could not get indexTip.screenPosition: ' + (e.message || e));
            }
        });

        this._rightHand.onPinchUp.add(() => {
            // Only process when in Dragging state
            if (this._viewfinderState !== ViewfinderState.Dragging) return;

            try {
                const endScreen = this._rightHand.indexTip.screenPosition;
                if (endScreen && this._dragStartScreen) {
                    const cropRect = this.computeCropRect(this._dragStartScreen, endScreen);
                    print('[CharacterGenDemo] Pinch-drag ended. Crop rect: x=' +
                        cropRect.x.toFixed(3) + ' y=' + cropRect.y.toFixed(3) +
                        ' w=' + cropRect.w.toFixed(3) + ' h=' + cropRect.h.toFixed(3));

                    // Minimum size guard
                    if (cropRect.w < MIN_CROP_SIZE || cropRect.h < MIN_CROP_SIZE) {
                        print('[CharacterGenDemo] Crop rect too small -- treating as accidental tap');
                        this.transitionState(ViewfinderState.Ready);
                        return;
                    }

                    // Valid crop -- capture
                    this.captureFromRect(cropRect);
                }
            } catch (e: any) {
                print('[CharacterGenDemo] Pinch-up processing failed: ' + (e.message || e));
                this.transitionState(ViewfinderState.Ready);
            }

            this._dragStartScreen = null;
        });

        print('[CharacterGenDemo] Pinch-drag tracking set up on right hand');
    }

    /**
     * Compute the crop rectangle from screen-space start/end coordinates.
     * Returns { x, y, w, h } clamped to [0, 1].
     */
    private computeCropRect(start: vec2, end: vec2): { x: number; y: number; w: number; h: number } {
        let x = Math.min(start.x, end.x);
        let y = Math.min(start.y, end.y);
        let w = Math.abs(end.x - start.x);
        let h = Math.abs(end.y - start.y);

        // Clamp to [0, 1]
        x = Math.max(0, Math.min(1, x));
        y = Math.max(0, Math.min(1, y));
        w = Math.max(0, Math.min(1 - x, w));
        h = Math.max(0, Math.min(1 - y, h));

        return { x, y, w, h };
    }

    // ==================== RenderTarget Crop Pipeline ====================

    /**
     * Set up the crop pipeline: dedicated crop camera + crop quad on a separate layer.
     * Created once during initialize() and reused per capture.
     */
    private setupCropPipeline(): void {
        if (!this.cropRenderTarget) {
            print('[CharacterGenDemo] No cropRenderTarget assigned -- crop pipeline disabled');
            return;
        }

        // Create crop quad SceneObject
        // @ts-ignore
        this._cropQuad = global.scene.createSceneObject('CropQuad');
        this._cropQuad.setParent(this.getSceneObject());

        try {
            const image = this._cropQuad.createComponent('Component.Image') as any;
            if (image && this.cropMaterial) {
                const mat = this.cropMaterial.clone();
                image.mainMaterial = mat;
            }
        } catch (e: any) {
            print('[CharacterGenDemo] Crop quad Image creation failed: ' + (e.message || e));
        }

        // Set crop quad to a dedicated render layer (layer 30 to avoid main camera)
        try {
            this._cropQuad.layer = 30;
        } catch (_: any) {
            print('[CharacterGenDemo] Could not set crop quad layer');
        }

        // Create crop camera
        // @ts-ignore
        this._cropCamera = global.scene.createSceneObject('CropCamera');
        this._cropCamera.setParent(this.getSceneObject());

        try {
            const cam = this._cropCamera.createComponent('Component.Camera') as any;
            if (cam) {
                // Orthographic projection for the crop
                cam.cameraType = 1; // Orthographic
                cam.renderTarget = this.cropRenderTarget;
                // Render only layer 30 (the crop quad)
                try {
                    cam.renderLayer = 30;
                } catch (_: any) {
                    print('[CharacterGenDemo] Could not set crop camera render layer');
                }
                cam.size = 1.0; // Orthographic size -- will be adjusted per capture
            }
        } catch (e: any) {
            print('[CharacterGenDemo] Crop camera creation failed: ' + (e.message || e));
        }

        // Start disabled -- only enable during capture
        this._cropQuad.enabled = false;
        this._cropCamera.enabled = false;

        print('[CharacterGenDemo] Crop pipeline set up (quad on layer 30, ortho camera)');
    }

    /**
     * Capture the cropped region from the camera texture using the RenderTarget pipeline.
     * Uses the quad-transform approach: positions the crop quad so the orthographic camera
     * captures only the desired region.
     */
    private captureFromRect(cropRect: { x: number; y: number; w: number; h: number }): void {
        if (!this._cropQuad || !this._cropCamera || !this.cropRenderTarget) {
            print('[CharacterGenDemo] Crop pipeline not available');
            // Fallback: if camera texture is available, try direct encode
            if (this._cameraTexture && this._cameraReady) {
                this.directCaptureAndPreview();
            }
            return;
        }

        if (!this._cameraTexture || !this._cameraReady) {
            print('[CharacterGenDemo] Camera not ready -- cannot capture');
            this.transitionState(ViewfinderState.Ready);
            return;
        }

        print('[CharacterGenDemo] Starting RenderTarget crop capture...');

        // Set the camera texture on the crop quad
        try {
            const image = this._cropQuad.getComponent('Component.Image') as any;
            if (image && image.mainMaterial) {
                image.mainMaterial.mainPass.baseTex = this._cameraTexture;
            }
        } catch (e: any) {
            print('[CharacterGenDemo] Could not set camera texture on crop quad: ' + (e.message || e));
        }

        // Position and scale the crop quad so the ortho camera captures only the desired region
        // Quad center offset: shift so crop center aligns with camera center
        const cropCenterX = cropRect.x + cropRect.w / 2;
        const cropCenterY = cropRect.y + cropRect.h / 2;

        // Offset from center (0.5, 0.5) mapped to quad position
        const offsetX = -(cropCenterX - 0.5) / cropRect.w;
        const offsetY = (cropCenterY - 0.5) / cropRect.h; // Flip Y

        // Scale: zoom in so only cropped region fills the frame
        const scaleX = 1.0 / cropRect.w;
        const scaleY = 1.0 / cropRect.h;

        this._cropQuad.getTransform().setLocalPosition(new vec3(offsetX, offsetY, -10));
        this._cropQuad.getTransform().setLocalScale(new vec3(scaleX, scaleY, 1));

        // Enable crop pipeline
        this._cropQuad.enabled = true;
        this._cropCamera.enabled = true;

        // Wait one frame for the render pipeline to produce the cropped output
        const waitEvent = this.createEvent('UpdateEvent');
        let frameCount = 0;
        waitEvent.bind(() => {
            frameCount++;
            if (frameCount < 2) return; // Wait at least 2 frames for render

            waitEvent.enabled = false;

            // Disable crop pipeline
            this._cropQuad!.enabled = false;
            this._cropCamera!.enabled = false;

            // Encode the cropped render target
            this.encodeCroppedTexture();
        });
    }

    /**
     * Fallback: direct capture without crop pipeline (captures full frame).
     */
    private directCaptureAndPreview(): void {
        if (!this._cameraTexture) return;

        print('[CharacterGenDemo] Direct capture (no crop pipeline)...');
        this.encodeTexture(this._cameraTexture).then((base64) => {
            this._capturedImageBase64 = base64;
            print('[CharacterGenDemo] Direct capture encoded: ' + Math.round(base64.length / 1024) + 'KB');
            this.transitionState(ViewfinderState.Preview);
        }).catch((err: any) => {
            print('[CharacterGenDemo] Direct capture encoding failed: ' + (err.message || err));
            this.transitionState(ViewfinderState.Ready);
        });
    }

    /**
     * Encode the cropped render target texture to base64.
     */
    private encodeCroppedTexture(): void {
        if (!this.cropRenderTarget) {
            print('[CharacterGenDemo] No cropRenderTarget to encode');
            this.transitionState(ViewfinderState.Ready);
            return;
        }

        print('[CharacterGenDemo] Encoding cropped texture...');
        this.encodeTexture(this.cropRenderTarget).then((base64) => {
            this._capturedImageBase64 = base64;
            print('[CharacterGenDemo] Crop encoded: ' + Math.round(base64.length / 1024) + 'KB');
            this.transitionState(ViewfinderState.Preview);
        }).catch((err: any) => {
            print('[CharacterGenDemo] Crop encoding failed: ' + (err.message || err));
            this.transitionState(ViewfinderState.Ready);
        });
    }

    // ==================== Confirmation Panel ====================

    /**
     * Create the confirmation panel with preview image and Cancel/Send buttons.
     */
    private setupConfirmationPanel(): void {
        if (!this.pinchButtonPrefab) {
            print('[CharacterGenDemo] No pinchButtonPrefab -- confirmation panel disabled');
            return;
        }

        // @ts-ignore
        this._confirmationPanel = global.scene.createSceneObject('ConfirmationPanel');
        this._confirmationPanel.setParent(this.getSceneObject());
        this._confirmationPanel.getTransform().setLocalPosition(new vec3(0, 0, PANEL_Z));
        this._confirmationPanel.enabled = false;

        // Preview image showing the cropRenderTarget texture
        if (this.cropRenderTarget) {
            // @ts-ignore
            const previewObj = global.scene.createSceneObject('CropPreview');
            previewObj.setParent(this._confirmationPanel);
            previewObj.getTransform().setLocalPosition(new vec3(0, 5, 0));
            previewObj.getTransform().setLocalScale(new vec3(15, 15, 1));

            try {
                const image = previewObj.createComponent('Component.Image') as any;
                if (image) {
                    try {
                        const mat = image.mainMaterial.clone();
                        mat.mainPass.baseTex = this.cropRenderTarget;
                        image.mainMaterial = mat;
                    } catch (_: any) {}
                }
            } catch (e: any) {
                print('[CharacterGenDemo] Preview Image creation failed: ' + (e.message || e));
            }
        }

        // Cancel button
        const cancelBtn = this.pinchButtonPrefab.instantiate(this._confirmationPanel);
        cancelBtn.getTransform().setLocalPosition(new vec3(-8, -8, 0));
        this.bindPrefabTap(cancelBtn, () => this.cancelCapture());

        // Cancel label
        // @ts-ignore
        const cancelLabel = global.scene.createSceneObject('CancelLabel');
        cancelLabel.setParent(cancelBtn);
        try {
            const text3d = cancelLabel.createComponent('Component.Text3D') as any;
            if (text3d) {
                text3d.text = 'Cancel';
                try { text3d.size = 2.0; } catch (_: any) {}
            }
        } catch (e: any) {
            print('[CharacterGenDemo] Cancel label failed: ' + (e.message || e));
        }

        // Send button
        const sendBtn = this.pinchButtonPrefab.instantiate(this._confirmationPanel);
        sendBtn.getTransform().setLocalPosition(new vec3(8, -8, 0));
        this.bindPrefabTap(sendBtn, () => this.sendCapture());

        // Send label
        // @ts-ignore
        const sendLabel = global.scene.createSceneObject('SendLabel');
        sendLabel.setParent(sendBtn);
        try {
            const text3d = sendLabel.createComponent('Component.Text3D') as any;
            if (text3d) {
                text3d.text = 'Send';
                try { text3d.size = 2.0; } catch (_: any) {}
            }
        } catch (e: any) {
            print('[CharacterGenDemo] Send label failed: ' + (e.message || e));
        }

        print('[CharacterGenDemo] Confirmation panel created with Cancel/Send buttons');
    }

    /**
     * Cancel the captured image and return to viewfinder Ready state for retake.
     */
    private cancelCapture(): void {
        print('[CharacterGenDemo] Capture cancelled -- returning to viewfinder');
        this._capturedImageBase64 = null;
        this.transitionState(ViewfinderState.Ready);
        this.setStatus('Pinch & drag to crop');
    }

    /**
     * Send the captured image through the generation pipeline.
     */
    private sendCapture(): void {
        if (!this._capturedImageBase64) {
            print('[CharacterGenDemo] No captured image to send');
            this.transitionState(ViewfinderState.Ready);
            return;
        }

        print('[CharacterGenDemo] Sending captured image for generation...');
        this.transitionState(ViewfinderState.Uploading);

        const imageBase64 = this._capturedImageBase64;
        this._capturedImageBase64 = null;

        this.runGenerationPipeline(imageBase64);
    }

    // ==================== Per-Frame Update ====================

    /**
     * Per-frame update: palm anchor tracking and pinch-drag rectangle.
     */
    private onUpdate(): void {
        // Update palm anchor position
        this.updatePalmAnchor();

        // During Dragging: update rectangle overlay with current finger position
        if (this._viewfinderState === ViewfinderState.Dragging && this._dragStartScreen && this._rightHand) {
            try {
                const currentScreen = this._rightHand.indexTip.screenPosition;
                if (currentScreen) {
                    this.updateRectangleOverlay(this._dragStartScreen, currentScreen);
                }
            } catch (_: any) {}
        }
    }

    // ==================== Button Binding ====================

    /**
     * Bind a tap callback to a prefab instance via duck-typing.
     * Checks for UIKit onTriggerUp and SIK onButtonPinched patterns.
     * Adapted from CharacterGallery.ts.
     */
    private bindPrefabTap(obj: SceneObject, callback: () => void): void {
        const scripts = obj.getComponents('Component.ScriptComponent') as any[];
        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && sc.onTriggerUp && sc.onTriggerUp.add) { sc.onTriggerUp.add(callback); return; }
            if (sc && sc.onButtonPinched) { sc.onButtonPinched.add(callback); return; }
        }
        print('[CharacterGenDemo] WARNING: No tap handler found on prefab');
    }

    /**
     * Discover PinchButton on the generateButtonObject using duck-typing.
     * Legacy binding for the optional generateButtonObject input.
     */
    private bindPinchButton(): void {
        const scripts = this.generateButtonObject.getComponents('Component.ScriptComponent') as any[];
        let buttonFound = false;

        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && sc.onButtonPinched) {
                sc.onButtonPinched.add(() => {
                    // When camera is available, ignore legacy button (viewfinder flow takes priority)
                    if (this._cameraTexture) {
                        print('[CharacterGenDemo] Camera available -- use viewfinder instead of legacy button');
                        return;
                    }
                    this.startGeneration();
                });
                buttonFound = true;
                print('[CharacterGenDemo] PinchButton bound successfully');
                break;
            }
            if (sc && sc.api && sc.api.onButtonPinched) {
                sc.api.onButtonPinched.add(() => {
                    if (this._cameraTexture) {
                        print('[CharacterGenDemo] Camera available -- use viewfinder instead of legacy button');
                        return;
                    }
                    this.startGeneration();
                });
                buttonFound = true;
                print('[CharacterGenDemo] PinchButton bound via .api');
                break;
            }
        }

        if (!buttonFound) {
            print('[CharacterGenDemo] ERROR: No PinchButton found on generateButtonObject!');
            print('[CharacterGenDemo] Make sure a PinchButton prefab from SIK is attached.');
        }
    }

    // ==================== Texture Encoding ====================

    /**
     * Encode a Texture to base64 PNG string using Lens Studio's Base64 API.
     * Wraps the callback-based Base64.encodeTextureAsync in a Promise.
     */
    private encodeTexture(texture: Texture): Promise<string> {
        return new Promise((resolve, reject) => {
            // @ts-ignore - Lens Studio global Base64 API
            Base64.encodeTextureAsync(
                texture,
                (encoded: string) => resolve(encoded),
                () => reject(new Error('Texture encoding failed')),
                // @ts-ignore - Lens Studio global CompressionQuality
                CompressionQuality.HighQuality,
                // @ts-ignore - Lens Studio global EncodingType
                EncodingType.Png
            );
        });
    }

    // ==================== Generation Pipeline ====================

    /**
     * Start the full character generation pipeline using paperSanTexture (legacy path).
     * Triggered by PinchButton tap when camera is not available.
     */
    private async startGeneration(): Promise<void> {
        if (this.isGenerating) {
            print('[CharacterGenDemo] Generation already in progress, ignoring tap');
            return;
        }

        this.isGenerating = true;
        print('[CharacterGenDemo] ===== LEGACY PIPELINE START (paperSanTexture) =====');

        try {
            // Encode Paper-San texture to base64
            print('[CharacterGenDemo] [1/1] Encoding paperSanTexture to base64...');
            this.setStatus('Encoding image...');
            // @ts-ignore
            const encodeStart = getTime();
            const imageBase64Raw = await this.encodeTexture(this.paperSanTexture);
            // @ts-ignore
            print(`[CharacterGenDemo] [1/1] Encode complete (${((getTime() - encodeStart) * 1000).toFixed(0)}ms)`);

            // Strip data URI prefix if present
            let imageBase64 = imageBase64Raw;
            const prefixIndex = imageBase64.indexOf(',');
            if (prefixIndex !== -1 && prefixIndex < 100) {
                imageBase64 = imageBase64.substring(prefixIndex + 1);
            }

            print(`[CharacterGenDemo] [1/1] Base64 payload: ${Math.round(imageBase64.length / 1024)}KB`);

            await this.runGenerationPipeline(imageBase64);
        } catch (error: any) {
            const errMsg = error.message || String(error);
            print('[CharacterGenDemo] ===== LEGACY PIPELINE ERROR =====');
            print('[CharacterGenDemo] ' + errMsg);
            if (error.stack) print('[CharacterGenDemo] Stack: ' + error.stack);
            this.setStatus('Failed - tap to retry');
            this.isGenerating = false;
        }
    }

    /**
     * Shared generation pipeline: upload image, trigger model gen, poll, download GLB, connect voice.
     * Used by both the viewfinder flow (sendCapture) and the legacy paperSanTexture flow (startGeneration).
     *
     * @param imageBase64 Base64-encoded image data (no data URI prefix)
     */
    private async runGenerationPipeline(imageBase64: string): Promise<void> {
        this.isGenerating = true;
        // @ts-ignore - Lens Studio getTime global
        const pipelineStart = getTime();
        print('[CharacterGenDemo] ===== GENERATION PIPELINE START =====');

        try {
            // Strip data URI prefix if present
            const prefixIndex = imageBase64.indexOf(',');
            if (prefixIndex !== -1 && prefixIndex < 100) {
                print('[CharacterGenDemo] Stripped data URI prefix');
                imageBase64 = imageBase64.substring(prefixIndex + 1);
            }

            print(`[CharacterGenDemo] Image payload: ${Math.round(imageBase64.length / 1024)}KB (${imageBase64.length} chars)`);

            // Step 2: Create HTTP client from EstuaryCredentials
            print('[CharacterGenDemo] [2/5] Creating HTTP client...');
            const config = this.buildHttpConfig();
            print('[CharacterGenDemo] [2/5] Config: serverUrl=' + config.serverUrl + ', playerId=' + config.playerId + ', apiKey=' + (config.apiKey ? 'set' : 'NOT SET!'));
            const httpClient = new EstuaryHttpClient(config);
            print('[CharacterGenDemo] [2/5] HTTP client ready');

            // Step 3: Upload image and create character
            print('[CharacterGenDemo] [3/5] Uploading image to create character...');
            this.setStatus('Creating character...');
            // @ts-ignore
            const uploadStart = getTime();
            const agent = await httpClient.uploadImageToCharacter(imageBase64, 'image/png');
            // @ts-ignore
            print(`[CharacterGenDemo] [3/5] Character created in ${((getTime() - uploadStart) * 1000).toFixed(0)}ms`);
            print(`[CharacterGenDemo] [3/5] Agent ID: ${agent.id}`);
            print(`[CharacterGenDemo] [3/5] Name: "${agent.name}"`);
            print(`[CharacterGenDemo] [3/5] Tagline: "${agent.tagline || 'none'}"`);
            this.setStatus(`Character "${agent.name}" created!`);

            // Step 4: Trigger model generation
            print('[CharacterGenDemo] [4/5] Triggering 3D model generation...');
            this.setStatus('Starting 3D model generation...');
            // @ts-ignore
            const genStart = getTime();
            const genResult = await httpClient.generateModel(agent.id);
            // @ts-ignore
            print(`[CharacterGenDemo] [4/5] Generation triggered in ${((getTime() - genStart) * 1000).toFixed(0)}ms`);
            print(`[CharacterGenDemo] [4/5] Initial status: ${genResult.modelStatus}`);

            // Step 5: Poll for model completion (callback-based)
            print('[CharacterGenDemo] [5/5] Starting status polling (2s initial, 10s max, 5min timeout)...');
            this.setStatus('Generating model (0%)...');
            // @ts-ignore
            const pollStart = getTime();
            httpClient.pollModelStatus(
                agent.id,
                (status: ModelStatusResponse) => {
                    // @ts-ignore
                    const elapsed = ((getTime() - pollStart)).toFixed(1);
                    this.setStatus(`Generating model (${status.progress}%)...`);
                    print(`[CharacterGenDemo] [5/5] Poll update [${elapsed}s]: status=${status.modelStatus}, progress=${status.progress}%`);
                    if (status.modelUrl) print(`[CharacterGenDemo] [5/5]   modelUrl: ${status.modelUrl.substring(0, 80)}`);
                    if (status.modelPreviewUrl) print(`[CharacterGenDemo] [5/5]   previewUrl: ${status.modelPreviewUrl.substring(0, 80)}`);
                    if (status.thumbnailUrl) print(`[CharacterGenDemo] [5/5]   thumbnailUrl: ${status.thumbnailUrl.substring(0, 80)}`);
                },
                (status: ModelStatusResponse) => {
                    // @ts-ignore
                    const elapsed = ((getTime() - pollStart)).toFixed(1);
                    print(`[CharacterGenDemo] [5/5] Model COMPLETE after ${elapsed}s`);
                    print(`[CharacterGenDemo] [5/5] Final status: ${status.modelStatus}`);
                    print(`[CharacterGenDemo] [5/5] modelUrl: ${status.modelUrl || 'null'}`);
                    print(`[CharacterGenDemo] [5/5] previewUrl: ${status.modelPreviewUrl || 'null'}`);
                    this.setStatus('Downloading 3D model...');
                    this.downloadAndDisplayModel(httpClient, status, pipelineStart, agent.id, agent.name);
                },
                (error: string) => {
                    // @ts-ignore
                    const elapsed = ((getTime() - pollStart)).toFixed(1);
                    print(`[CharacterGenDemo] [5/5] Poll FAILED after ${elapsed}s: ${error}`);
                    this.setStatus('Failed - tap to retry');
                    this.isGenerating = false;
                    this.transitionState(ViewfinderState.Inactive);
                }
            );
        } catch (error: any) {
            const errMsg = error.message || String(error);
            print('[CharacterGenDemo] ===== PIPELINE ERROR =====');
            print('[CharacterGenDemo] ' + errMsg);
            if (error.stack) print('[CharacterGenDemo] Stack: ' + error.stack);
            this.setStatus('Failed - tap to retry');
            this.isGenerating = false;
            this.transitionState(ViewfinderState.Inactive);
        }
    }

    // ==================== Model Download & Display ====================

    /**
     * Download and display the completed 3D model in the scene.
     * Places the model ~100cm in front of the camera.
     */
    private async downloadAndDisplayModel(
        httpClient: EstuaryHttpClient,
        status: ModelStatusResponse,
        pipelineStart: number,
        agentId: string,
        agentName: string
    ): Promise<void> {
        try {
            print('[CharacterGenDemo] ===== GLB DOWNLOAD & DISPLAY =====');

            // Determine URL: prefer modelUrl, fall back to modelPreviewUrl (for texture_failed)
            const modelUrl = status.modelUrl || status.modelPreviewUrl;
            if (!modelUrl) {
                this.setStatus('Error: No model URL');
                print('[CharacterGenDemo] ERROR: No model URL in completed status');
                print('[CharacterGenDemo] Full status: modelStatus=' + status.modelStatus + ', modelUrl=' + status.modelUrl + ', previewUrl=' + status.modelPreviewUrl);
                this.isGenerating = false;
                this.transitionState(ViewfinderState.Inactive);
                return;
            }

            print('[CharacterGenDemo] GLB URL: ' + modelUrl);
            print('[CharacterGenDemo] Using ' + (status.modelUrl ? 'final model' : 'preview model (texture_failed fallback)'));

            // Create a parent SceneObject for the model
            // @ts-ignore - Lens Studio global.scene API
            const modelParent = global.scene.createSceneObject('GeneratedCharacter');
            print('[CharacterGenDemo] Created parent SceneObject: GeneratedCharacter');

            // Position ~100cm in front of the camera
            try {
                const camTransform = this.getSceneObject().getTransform();
                const camPos = camTransform.getWorldPosition();
                const forward = camTransform.forward;
                const modelPos = camPos.add(forward.uniformScale(-100));
                modelParent.getTransform().setWorldPosition(modelPos);
                print(`[CharacterGenDemo] Positioned at (${modelPos.x.toFixed(1)}, ${modelPos.y.toFixed(1)}, ${modelPos.z.toFixed(1)})`);
            } catch (posError: any) {
                print('[CharacterGenDemo] Camera transform failed: ' + (posError.message || posError));
                print('[CharacterGenDemo] Using fallback position (0, 0, -100)');
                modelParent.getTransform().setWorldPosition(new vec3(0, 0, -100));
            }

            // Resolve material: use @input if provided, otherwise search scene
            let material = this.defaultMaterial;
            if (material) {
                print('[CharacterGenDemo] Using assigned defaultMaterial');
            } else {
                print('[CharacterGenDemo] No defaultMaterial set, searching scene for any material...');
                try {
                    // @ts-ignore - Lens Studio global.scene API
                    const rootCount = global.scene.getRootObjectsCount();
                    print('[CharacterGenDemo] Searching ' + rootCount + ' root objects...');
                    for (let r = 0; r < rootCount && !material; r++) {
                        // @ts-ignore
                        const root = global.scene.getRootObject(r);
                        // @ts-ignore - getComponentsRecursive exists at runtime
                        const rmvs = root.getComponentsRecursive('Component.RenderMeshVisual') as any[];
                        print('[CharacterGenDemo]   Root ' + r + ' "' + root.name + '": ' + rmvs.length + ' RenderMeshVisuals');
                        for (let i = 0; i < rmvs.length && !material; i++) {
                            if (rmvs[i] && rmvs[i].getMaterial) {
                                const m = rmvs[i].getMaterial(0);
                                if (m) {
                                    material = m;
                                    print('[CharacterGenDemo] Found fallback material from "' + root.name + '" RMV[' + i + ']');
                                }
                            }
                        }
                    }
                } catch (e: any) {
                    print('[CharacterGenDemo] Material search failed: ' + (e.message || e));
                }
            }

            if (!material) {
                this.setStatus('Error: No material');
                print('[CharacterGenDemo] FATAL: No material found anywhere. Assign one to defaultMaterial in Inspector.');
                this.isGenerating = false;
                this.transitionState(ViewfinderState.Inactive);
                return;
            }

            // Download and instantiate the GLB model
            print('[CharacterGenDemo] Starting GLB download + instantiation...');
            this.setStatus('Loading 3D model...');
            // @ts-ignore
            const dlStart = getTime();
            const sceneObj = await httpClient.downloadAndInstantiateGlb(
                modelUrl,
                modelParent,
                material,
                (progress: number) => {
                    this.setStatus(`Loading model (${Math.round(progress * 100)}%)...`);
                    print(`[CharacterGenDemo] GLB instantiation progress: ${Math.round(progress * 100)}%`);
                }
            );

            // @ts-ignore
            const dlElapsed = ((getTime() - dlStart) * 1000).toFixed(0);
            // @ts-ignore
            const totalElapsed = ((getTime() - pipelineStart)).toFixed(1);
            print('[CharacterGenDemo] ===== PIPELINE COMPLETE =====');
            print(`[CharacterGenDemo] GLB download+instantiate: ${dlElapsed}ms`);
            print(`[CharacterGenDemo] Total pipeline time: ${totalElapsed}s`);
            print(`[CharacterGenDemo] SceneObject: ${sceneObj ? sceneObj.name : 'null'}`);

            this.setStatus('Done! Connecting voice...');
            this.isGenerating = false;
            this.transitionState(ViewfinderState.Inactive);

            // Start voice conversation with the generated character
            this.startVoiceConnection(agentId, agentName);
        } catch (error: any) {
            const errMsg = error.message || String(error);
            print('[CharacterGenDemo] ===== GLB DOWNLOAD ERROR =====');
            print('[CharacterGenDemo] ' + errMsg);
            if (error.stack) print('[CharacterGenDemo] Stack: ' + error.stack);
            this.setStatus('Download failed - tap to retry');
            this.isGenerating = false;
            this.transitionState(ViewfinderState.Inactive);
        }
    }

    // ==================== Load Existing Character ====================

    /**
     * Load an existing character by ID, download its GLB, and start voice.
     * Skips the entire generation pipeline.
     */
    private async loadExistingCharacter(characterId: string): Promise<void> {
        print('[CharacterGenDemo] ===== LOADING EXISTING CHARACTER =====');
        print(`[CharacterGenDemo] Character ID: ${characterId}`);
        this.setStatus('Loading character...');

        try {
            const config = this.buildHttpConfig();
            const httpClient = new EstuaryHttpClient(config);

            const agent = await httpClient.getCharacter(characterId);
            print(`[CharacterGenDemo] Character loaded: "${agent.name}" (${agent.id})`);
            print(`[CharacterGenDemo]   modelUrl: ${agent.modelUrl || 'null'}`);
            print(`[CharacterGenDemo]   modelPreviewUrl: ${agent.modelPreviewUrl || 'null'}`);
            print(`[CharacterGenDemo]   modelStatus: ${agent.modelStatus || 'null'}`);
            this.setStatus(`Loaded "${agent.name}"`);

            const modelUrl = agent.modelUrl || agent.modelPreviewUrl;
            if (!modelUrl) {
                print('[CharacterGenDemo] Character has no 3D model -- starting voice only');
                this.setStatus('No 3D model -- connecting voice...');
                this.startVoiceConnection(agent.id, agent.name);
                return;
            }

            // Reuse the download + display + voice flow
            // @ts-ignore
            const pipelineStart = getTime();
            const status = {
                modelUrl: agent.modelUrl,
                modelPreviewUrl: agent.modelPreviewUrl,
                modelStatus: agent.modelStatus || 'completed',
                thumbnailUrl: null,
                progress: 100,
            } as ModelStatusResponse;

            await this.downloadAndDisplayModel(httpClient, status, pipelineStart, agent.id, agent.name);
        } catch (error: any) {
            print('[CharacterGenDemo] ===== LOAD CHARACTER ERROR =====');
            print('[CharacterGenDemo] ' + (error.message || String(error)));
            if (error.stack) print('[CharacterGenDemo] Stack: ' + error.stack);
            this.setStatus('Failed to load character');
        }
    }

    // ==================== Voice Connection ====================

    /**
     * Start voice conversation with the generated character.
     * Sets the character ID on EstuaryCredentials, then enables the
     * EstuaryVoiceConnection SceneObject so it auto-connects.
     */
    private startVoiceConnection(agentId: string, agentName: string): void {
        if (!this.voiceConnectionObject) {
            print('[CharacterGenDemo] No voiceConnectionObject assigned -- skipping voice connection');
            return;
        }

        print('[CharacterGenDemo] ===== STARTING VOICE CONNECTION =====');
        print(`[CharacterGenDemo] Character: "${agentName}" (${agentId})`);

        // Update EstuaryCredentials with the generated character ID
        const creds = EstuaryCredentials.instance;
        if (creds) {
            creds.characterId = agentId;
            print(`[CharacterGenDemo] Credentials updated: characterId=${agentId}, serverUrl=${creds.serverUrl}`);
        } else {
            print('[CharacterGenDemo] WARNING: No EstuaryCredentials singleton found');
            print('[CharacterGenDemo] Make sure EstuaryCredentials is in the scene and enabled');
        }

        // Enable the voice connection SceneObject -- this triggers its onAwake()
        this.voiceConnectionObject.enabled = true;
        print('[CharacterGenDemo] Voice connection SceneObject enabled');

        // Send greeting after a short delay (let voice connection establish first)
        const greeting = this.greetingMessage || `Hello! I just created you from a photo. Introduce yourself as ${agentName}!`;
        print(`[CharacterGenDemo] Will send greeting after connection: "${greeting}"`);

        // Poll for the voice connection to be ready, then send greeting
        // @ts-ignore
        const greetStart = getTime();
        const greetEvent = this.createEvent('UpdateEvent');
        greetEvent.bind(() => {
            // @ts-ignore
            const elapsed = getTime() - greetStart;

            // Timeout after 30 seconds
            if (elapsed > 30) {
                greetEvent.enabled = false;
                print('[CharacterGenDemo] Greeting timeout -- voice connection did not establish in 30s');
                return;
            }

            // Find the EstuaryVoiceConnection script and check if it's connected
            const scripts = this.voiceConnectionObject.getComponents('Component.ScriptComponent') as any[];
            for (let i = 0; i < scripts.length; i++) {
                const sc = scripts[i] as any;
                if (sc && typeof sc.sendMessage === 'function' && typeof sc.getCharacter === 'function') {
                    const character = sc.getCharacter();
                    if (character && character.isConnected) {
                        greetEvent.enabled = false;
                        print(`[CharacterGenDemo] Voice connected after ${elapsed.toFixed(1)}s -- sending greeting`);
                        this.setStatus('Talking...');
                        sc.sendMessage(greeting);
                        return;
                    }
                }
            }
        });
    }

    // ==================== Status Display ====================

    /**
     * Update the status text display and log to console.
     */
    private setStatus(text: string): void {
        if (this.statusText3D) {
            this.statusText3D.text = text;
        }
        print('[CharacterGenDemo] Status: ' + text);
    }
}
