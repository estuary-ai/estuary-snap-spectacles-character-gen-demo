/**
 * CharacterGenDemo - Full character generation pipeline demo for Spectacles.
 *
 * Demonstrates: image upload -> character creation -> model generation -> GLB display.
 *
 * Setup in Lens Studio:
 * 1. Add EstuaryCredentials to a SceneObject (set API key & server URL)
 * 2. Add this script to a SceneObject
 * 3. Drag Paper-San.png to paperSanTexture input (for generation mode)
 * 4. Assign a GLTF material to defaultMaterial (NOT PBR!)
 * 5. (Optional) Set existingCharacterId to load a character instead of generating
 * 6. (Optional) Wire voiceConnectionObject to a disabled EstuaryVoiceConnection SceneObject
 * 7. (Optional) Wire generateButtonObject to a PinchButton (otherwise auto-starts in 3s)
 *
 * Credentials (API key, server URL, player ID) are read from EstuaryCredentials.
 * InternetModule is obtained automatically via require().
 */

import { setInternetModule } from './estuary-lens-studio-sdk/src/Core/EstuaryClient';
import { EstuaryHttpClient } from './estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { EstuaryConfig } from './estuary-lens-studio-sdk/src/Core/EstuaryConfig';
import { EstuaryCredentials } from './estuary-lens-studio-sdk/src/Components/EstuaryCredentials';
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

    // ==================== Private State ====================

    /** Cached Text3D component from statusTextObject */
    private statusText3D: any = null;

    /** Whether a generation is currently in progress */
    private isGenerating: boolean = false;

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

    // ==================== Lifecycle ====================

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
            print('[CharacterGenDemo] No statusTextObject — status will be logged only');
        }

        // Check for existing character ID — skip generation if set
        if (this.existingCharacterId) {
            print('[CharacterGenDemo] existingCharacterId set: ' + this.existingCharacterId);
            print('[CharacterGenDemo] Skipping generation — loading existing character');
            this.loadExistingCharacter(this.existingCharacterId);
            return;
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
        // @ts-ignore - Lens Studio getTime global
        const pipelineStart = getTime();
        print('[CharacterGenDemo] ===== PIPELINE START =====');

        try {
            // Step 1: Encode Paper-San texture to base64
            print('[CharacterGenDemo] [1/5] Encoding texture to base64...');
            this.setStatus('Encoding image...');
            // @ts-ignore
            const encodeStart = getTime();
            const imageBase64Raw = await this.encodeTexture(this.paperSanTexture);
            // @ts-ignore
            print(`[CharacterGenDemo] [1/5] Encode complete (${((getTime() - encodeStart) * 1000).toFixed(0)}ms)`);

            // Strip data URI prefix if present (pitfall from research)
            let imageBase64 = imageBase64Raw;
            const prefixIndex = imageBase64.indexOf(',');
            if (prefixIndex !== -1 && prefixIndex < 100) {
                print('[CharacterGenDemo] [1/5] Stripped data URI prefix: "' + imageBase64Raw.substring(0, Math.min(prefixIndex, 60)) + '"');
                imageBase64 = imageBase64.substring(prefixIndex + 1);
            }

            print(`[CharacterGenDemo] [1/5] Base64 payload: ${Math.round(imageBase64.length / 1024)}KB (${imageBase64.length} chars)`);

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
                    // onStatusChanged
                    // @ts-ignore
                    const elapsed = ((getTime() - pollStart)).toFixed(1);
                    this.setStatus(`Generating model (${status.progress}%)...`);
                    print(`[CharacterGenDemo] [5/5] Poll update [${elapsed}s]: status=${status.modelStatus}, progress=${status.progress}%`);
                    if (status.modelUrl) print(`[CharacterGenDemo] [5/5]   modelUrl: ${status.modelUrl.substring(0, 80)}`);
                    if (status.modelPreviewUrl) print(`[CharacterGenDemo] [5/5]   previewUrl: ${status.modelPreviewUrl.substring(0, 80)}`);
                    if (status.thumbnailUrl) print(`[CharacterGenDemo] [5/5]   thumbnailUrl: ${status.thumbnailUrl.substring(0, 80)}`);
                },
                (status: ModelStatusResponse) => {
                    // onCompleted
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
                }
            );
        } catch (error: any) {
            const errMsg = error.message || String(error);
            print('[CharacterGenDemo] ===== PIPELINE ERROR =====');
            print('[CharacterGenDemo] ' + errMsg);
            if (error.stack) print('[CharacterGenDemo] Stack: ' + error.stack);
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

            // Start voice conversation with the generated character
            this.startVoiceConnection(agentId, agentName);
        } catch (error: any) {
            const errMsg = error.message || String(error);
            print('[CharacterGenDemo] ===== GLB DOWNLOAD ERROR =====');
            print('[CharacterGenDemo] ' + errMsg);
            if (error.stack) print('[CharacterGenDemo] Stack: ' + error.stack);
            this.setStatus('Download failed - tap to retry');
            this.isGenerating = false;
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
                print('[CharacterGenDemo] Character has no 3D model — starting voice only');
                this.setStatus('No 3D model — connecting voice...');
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
            print('[CharacterGenDemo] No voiceConnectionObject assigned — skipping voice connection');
            return;
        }

        print('[CharacterGenDemo] ===== STARTING VOICE CONNECTION =====');
        print(`[CharacterGenDemo] Character: "${agentName}" (${agentId})`);

        // Update EstuaryCredentials with the generated character ID
        const creds = EstuaryCredentials.instance;
        if (creds) {
            creds.characterId = agentId;
            // serverUrl on credentials is already in wss:// format
            print(`[CharacterGenDemo] Credentials updated: characterId=${agentId}, serverUrl=${creds.serverUrl}`);
        } else {
            print('[CharacterGenDemo] WARNING: No EstuaryCredentials singleton found');
            print('[CharacterGenDemo] Make sure EstuaryCredentials is in the scene and enabled');
        }

        // Enable the voice connection SceneObject — this triggers its onAwake()
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
                print('[CharacterGenDemo] Greeting timeout — voice connection did not establish in 30s');
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
                        print(`[CharacterGenDemo] Voice connected after ${elapsed.toFixed(1)}s — sending greeting`);
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
