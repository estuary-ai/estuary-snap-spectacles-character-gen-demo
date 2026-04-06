/**
 * GalleryVoiceManager - Manages voice connection lifecycle when switching characters.
 *
 * Uses EstuaryVoiceConnection.switchCharacter() for clean disconnect/reconnect
 * with proper event handler re-binding.
 */

import { EstuaryCredentials } from '../estuary-lens-studio-sdk/src/Components/EstuaryCredentials';
import { EstuaryHttpClient } from '../estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { AgentResponse } from '../estuary-lens-studio-sdk/src/Models/AgentResponse';

/**
 * Manages voice connection switching and GLB model lifecycle for the gallery.
 */
export class GalleryVoiceManager {

    /** The SceneObject containing the EstuaryVoiceConnection component */
    private voiceConnectionObject: SceneObject;

    /** Reference to the gallery component for creating events */
    private galleryComponent: BaseScriptComponent;

    /** Currently active agent ID */
    private currentAgentId: string | null = null;

    /** Currently spawned GLB model SceneObject (if any) */
    private currentModelObject: SceneObject | null = null;

    /** Cached reference to the EstuaryVoiceConnection script */
    private voiceScript: any = null;

    constructor(voiceConnectionObject: SceneObject, galleryComponent: BaseScriptComponent) {
        this.voiceConnectionObject = voiceConnectionObject;
        this.galleryComponent = galleryComponent;
    }

    public getCurrentAgentId(): string | null {
        return this.currentAgentId;
    }

    /**
     * Find the EstuaryVoiceConnection script on the voice SceneObject.
     */
    private getVoiceScript(): any {
        if (this.voiceScript) return this.voiceScript;

        const scripts = this.voiceConnectionObject.getComponents('Component.ScriptComponent') as any[];
        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && typeof sc.getCharacter === 'function' && typeof sc.sendMessage === 'function') {
                this.voiceScript = sc;
                return sc;
            }
        }
        return null;
    }

    /**
     * Switch to a new character.
     *
     * Strategy: Since onAwake() only fires once, we can't disable/re-enable.
     * Instead we:
     * 1. Get the EstuaryVoiceConnection script
     * 2. Disconnect its current character (stop mic, close WebSocket)
     * 3. Update credentials with the new character ID
     * 4. Enable the voice SceneObject if not already enabled (triggers first onAwake)
     * 5. If already awake, directly create a new character and connect
     */
    public switchCharacter(agentId: string, agentName: string): void {
        print('[Gallery] Switching voice to "' + agentName + '" (' + agentId + ')');

        this.currentAgentId = agentId;

        const vs = this.getVoiceScript();

        if (!this.voiceConnectionObject.enabled) {
            // First time: update creds and enable (triggers onAwake -> connect)
            const creds = EstuaryCredentials.instance;
            if (creds) creds.characterId = agentId;
            this.voiceConnectionObject.enabled = true;
            print('[Gallery] First connection — enabled voice SceneObject');
        } else if (vs && typeof vs.switchCharacter === 'function') {
            // Already connected: use the SDK's public switchCharacter method
            // This calls disconnect() + connect() internally, properly re-binding all event handlers
            vs.switchCharacter(agentId);
            print('[Gallery] Called switchCharacter on voice connection');
        } else {
            print('[Gallery] WARNING: Voice script has no switchCharacter method');
        }

        // Poll for connection then greet
        this.pollAndGreet(agentId, agentName);
    }

    /**
     * Poll for voice connection establishment, then send greeting.
     */
    private pollAndGreet(agentId: string, agentName: string): void {
        const greeting = 'Hello! Introduce yourself as ' + agentName + '!';

        // @ts-ignore
        const greetStart = getTime();
        const greetEvent = this.galleryComponent.createEvent('UpdateEvent');
        greetEvent.bind(() => {
            // @ts-ignore
            const elapsed = getTime() - greetStart;

            if (elapsed > 30) {
                greetEvent.enabled = false;
                print('[Gallery] Greeting timeout — voice did not connect in 30s');
                return;
            }

            const vs = this.getVoiceScript();
            if (vs) {
                const character = vs.getCharacter();
                if (character && character.isConnected) {
                    greetEvent.enabled = false;
                    print('[Gallery] Voice connected after ' + elapsed.toFixed(1) + 's — sending greeting');
                    vs.sendMessage(greeting);

                    // Start voice session + mic
                    try {
                        character.startVoiceSession();
                        vs.setMuted(false);
                    } catch (_: any) {}

                    return;
                }
            }

        });
    }

    // ==================== Model Management ====================

    public destroyCurrentModel(): void {
        if (this.currentModelObject) {
            try {
                this.currentModelObject.destroy();
                print('[Gallery] Previous GLB model destroyed');
            } catch (e: any) {
                print('[Gallery] Error destroying model: ' + (e.message || e));
            }
            this.currentModelObject = null;
        }
    }

    public async attemptGlbSpawn(
        httpClient: EstuaryHttpClient,
        agent: AgentResponse,
        parentSceneObject: SceneObject,
        material: Material | null
    ): Promise<void> {
        let modelUrl = agent.modelUrl || agent.modelPreviewUrl;
        if (!modelUrl) {
            print('[Gallery] No model URL for "' + agent.name + '" - voice-only experience');
            return;
        }

        // Rewrite localhost URLs to use the actual server URL from credentials
        const creds = EstuaryCredentials.instance;
        if (creds && modelUrl.includes('localhost')) {
            let serverBase = creds.serverUrl || '';
            if (serverBase.startsWith('wss://')) serverBase = 'https://' + serverBase.substring(6);
            else if (serverBase.startsWith('ws://')) serverBase = 'http://' + serverBase.substring(5);
            serverBase = serverBase.replace(/\/$/, '');
            modelUrl = modelUrl.replace(/https?:\/\/localhost(:\d+)?/, serverBase);
            print('[Gallery] Rewrote model URL to: ' + modelUrl);
        }

        if (!material) {
            print('[Gallery] No material provided - skipping GLB instantiation');
            return;
        }

        try {
            print('[Gallery] Attempting GLB download for "' + agent.name + '"');
            const sceneObj = await httpClient.downloadAndInstantiateGlb(
                modelUrl,
                parentSceneObject,
                material,
                (progress: number) => {
                    print('[Gallery] GLB progress: ' + Math.round(progress * 100) + '%');
                }
            );
            this.currentModelObject = sceneObj;
            print('[Gallery] GLB model spawned for "' + agent.name + '"');
        } catch (e: any) {
            print('[Gallery] GLB instantiation failed (known LS bug) - voice-only mode');
            print('[Gallery] Error: ' + (e.message || e));
        }
    }
}
