/**
 * CharacterGenDemo - Full character generation pipeline demo for Spectacles.
 *
 * Demonstrates: image upload -> character creation -> model generation -> GLB display.
 *
 * Setup in Lens Studio:
 * 1. Add this script to a SceneObject in your scene
 * 2. Drag Paper-San.png from Resources to the paperSanTexture input
 * 3. (Optional) Create a Material and drag to defaultMaterial input
 *    - If omitted, a material is auto-discovered from existing scene objects
 * 4. (Optional) Add a PinchButton prefab and drag to generateButtonObject
 *    - If omitted, generation auto-starts after 3 seconds
 * 5. (Optional) Create a SceneObject with Text3D for status display
 *    - If omitted, a Text3D is created at runtime
 * 6. Replace API_KEY constant with your Estuary API key
 * 7. Deploy to Spectacles (network calls don't work in Preview)
 *
 * InternetModule is obtained automatically via require().
 */

import { setInternetModule } from './estuary-lens-studio-sdk/src/Core/EstuaryClient';
import { EstuaryHttpClient } from './estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { EstuaryConfig } from './estuary-lens-studio-sdk/src/Core/EstuaryConfig';
import { ModelStatusResponse } from './estuary-lens-studio-sdk/src/Models/ModelStatusResponse';

// ==================== Configuration Constants ====================

/** Replace with your Estuary API key */
const API_KEY = 'YOUR_API_KEY_HERE';

/** Player ID for this demo session */
const PLAYER_ID = 'spectacles-chargen-demo';

/** Estuary API server URL */
const SERVER_URL = 'https://api.estuary-ai.com';

// ==================== Component ====================

@component
export class CharacterGenDemo extends BaseScriptComponent {

    // ==================== Inputs (set in Inspector) ====================

    /** Paper-San.png texture from Resources panel */
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

    /** Optional: SceneObject with a PinchButton from SpectaclesInteractionKit */
    @input
    @allowUndefined
    generateButtonObject: SceneObject;

    // ==================== Private State ====================

    /** Cached Text3D component from statusTextObject */
    private statusText3D: any = null;

    /** Whether a generation is currently in progress */
    private isGenerating: boolean = false;

    // ==================== Lifecycle ====================

    onAwake() {
        print('[CharacterGenDemo] Initializing...');

        // Set up InternetModule via require() (needed for GLB download)
        // @ts-ignore - Lens Studio module system
        const internetModule = require('LensStudio:InternetModule') as InternetModule;
        setInternetModule(internetModule);
        print('[CharacterGenDemo] InternetModule configured via require()');

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
            // Create a Text3D component at runtime
            print('[CharacterGenDemo] No statusTextObject provided, creating Text3D at runtime');
            try {
                // @ts-ignore - Lens Studio global.scene API
                const textObj = global.scene.createSceneObject('StatusText');
                textObj.setParent(this.getSceneObject());
                textObj.getTransform().setLocalPosition(new vec3(0, 10, -50));
                this.statusText3D = textObj.createComponent('Component.Text3D');
                if (this.statusText3D) {
                    this.statusText3D.text = 'Starting...';
                    this.statusText3D.size = 12;
                    print('[CharacterGenDemo] Runtime Text3D created');
                }
            } catch (e: any) {
                print('[CharacterGenDemo] Could not create Text3D: ' + (e.message || e));
            }
        }

        // Discover and bind PinchButton, or auto-start after delay
        if (this.generateButtonObject) {
            this.bindPinchButton();
        } else {
            print('[CharacterGenDemo] No generateButtonObject assigned');
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
    }

    // ==================== Button Binding ====================

    /**
     * Discover PinchButton on the generateButtonObject using duck-typing.
     * Iterates ScriptComponents looking for one with onButtonPinched property.
     */
    private bindPinchButton(): void {
        const scripts = this.generateButtonObject.getComponents('Component.ScriptComponent') as any[];
        let buttonFound = false;

        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && sc.onButtonPinched) {
                sc.onButtonPinched.add(() => this.startGeneration());
                buttonFound = true;
                print('[CharacterGenDemo] PinchButton bound successfully');
                break;
            }
            // Also check .api property (some SIK versions expose it there)
            if (sc && sc.api && sc.api.onButtonPinched) {
                sc.api.onButtonPinched.add(() => this.startGeneration());
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
     * Start the full character generation pipeline.
     * Triggered by PinchButton tap.
     */
    private async startGeneration(): Promise<void> {
        if (this.isGenerating) {
            print('[CharacterGenDemo] Generation already in progress, ignoring tap');
            return;
        }

        this.isGenerating = true;

        try {
            // Step 1: Encode Paper-San texture to base64
            this.setStatus('Uploading image...');
            const imageBase64Raw = await this.encodeTexture(this.paperSanTexture);

            // Strip data URI prefix if present (pitfall from research)
            let imageBase64 = imageBase64Raw;
            const prefixIndex = imageBase64.indexOf(',');
            if (prefixIndex !== -1 && prefixIndex < 100) {
                imageBase64 = imageBase64.substring(prefixIndex + 1);
            }

            print(`[CharacterGenDemo] Texture encoded: ${Math.round(imageBase64.length / 1024)}KB base64`);

            // Step 2: Create HTTP client
            const config: EstuaryConfig = {
                serverUrl: SERVER_URL,
                apiKey: API_KEY,
                characterId: '', // not needed for character creation
                playerId: PLAYER_ID,
                debugLogging: true,
            };
            const httpClient = new EstuaryHttpClient(config);

            // Step 3: Upload image and create character
            this.setStatus('Creating character...');
            const agent = await httpClient.uploadImageToCharacter(imageBase64, 'image/png');
            this.setStatus(`Character "${agent.name}" created!`);
            print(`[CharacterGenDemo] Character created: ${agent.id} "${agent.name}"`);

            // Step 4: Trigger model generation
            this.setStatus('Starting 3D model generation...');
            await httpClient.generateModel(agent.id);
            print('[CharacterGenDemo] Model generation triggered');

            // Step 5: Poll for model completion (callback-based)
            this.setStatus('Generating model (0%)...');
            httpClient.pollModelStatus(
                agent.id,
                (status: ModelStatusResponse) => {
                    // onStatusChanged
                    this.setStatus(`Generating model (${status.progress}%)...`);
                    print(`[CharacterGenDemo] Model status: ${status.modelStatus} ${status.progress}%`);
                },
                (status: ModelStatusResponse) => {
                    // onCompleted - trigger GLB download
                    this.setStatus('Downloading 3D model...');
                    this.downloadAndDisplayModel(httpClient, status);
                },
                (error: string) => {
                    // onError
                    print(`[CharacterGenDemo] ERROR: ${error}`);
                    this.setStatus('Failed - tap to retry');
                    this.isGenerating = false;
                }
            );
        } catch (error: any) {
            print('[CharacterGenDemo] ERROR: ' + (error.message || String(error)));
            this.setStatus('Failed - tap to retry');
            this.isGenerating = false;
        }
    }

    // ==================== Model Download & Display ====================

    /**
     * Download and display the completed 3D model in the scene.
     * Places the model ~100cm in front of the camera.
     */
    private async downloadAndDisplayModel(
        httpClient: EstuaryHttpClient,
        status: ModelStatusResponse
    ): Promise<void> {
        try {
            // Determine URL: prefer modelUrl, fall back to modelPreviewUrl (for texture_failed)
            const modelUrl = status.modelUrl || status.modelPreviewUrl;
            if (!modelUrl) {
                this.setStatus('Error: No model URL');
                print('[CharacterGenDemo] ERROR: No model URL in completed status');
                this.isGenerating = false;
                return;
            }

            print(`[CharacterGenDemo] Downloading model from: ${modelUrl.substring(0, 100)}`);

            // Create a parent SceneObject for the model
            // @ts-ignore - Lens Studio global.scene API
            const modelParent = global.scene.createSceneObject('GeneratedCharacter');

            // Position ~100cm in front of the camera
            try {
                const camTransform = this.getSceneObject().getTransform();
                const camPos = camTransform.getWorldPosition();
                const forward = camTransform.forward;
                // Place 100cm in front (forward is -Z for camera in Lens Studio)
                const modelPos = camPos.add(forward.uniformScale(-100));
                modelParent.getTransform().setWorldPosition(modelPos);
            } catch (posError: any) {
                // Fallback: place at fixed world position 100cm in front of origin
                print('[CharacterGenDemo] Could not use camera transform, using fallback position');
                modelParent.getTransform().setWorldPosition(new vec3(0, 0, -100));
            }

            // Resolve material: use @input if provided, otherwise search scene
            let material = this.defaultMaterial;
            if (!material) {
                print('[CharacterGenDemo] No defaultMaterial set, searching scene...');
                try {
                    // @ts-ignore - Lens Studio global.scene API
                    const rootCount = global.scene.getRootObjectsCount();
                    for (let r = 0; r < rootCount && !material; r++) {
                        // @ts-ignore
                        const root = global.scene.getRootObject(r);
                        const rmvs = root.getComponentsRecursive('Component.RenderMeshVisual') as any[];
                        for (let i = 0; i < rmvs.length && !material; i++) {
                            if (rmvs[i] && rmvs[i].getMaterial) {
                                const m = rmvs[i].getMaterial(0);
                                if (m) {
                                    material = m;
                                    print('[CharacterGenDemo] Found fallback material from scene');
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
                print('[CharacterGenDemo] ERROR: No material for GLB. Assign one to defaultMaterial.');
                this.isGenerating = false;
                return;
            }

            // Download and instantiate the GLB model
            this.setStatus('Loading 3D model...');
            const sceneObj = await httpClient.downloadAndInstantiateGlb(
                modelUrl,
                modelParent,
                material,
                (progress: number) => {
                    this.setStatus(`Loading model (${Math.round(progress * 100)}%)...`);
                }
            );

            this.setStatus('Done!');
            this.isGenerating = false;
            print('[CharacterGenDemo] Model instantiated successfully!');
        } catch (error: any) {
            print('[CharacterGenDemo] ERROR downloading model: ' + (error.message || String(error)));
            this.setStatus('Download failed - tap to retry');
            this.isGenerating = false;
        }
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
