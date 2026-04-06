/**
 * GalleryVoiceManager - Manages voice connection lifecycle when switching characters.
 *
 * Reuses the proven disable/update-creds/re-enable pattern from CharacterGenDemo.ts.
 * Also handles GLB model spawning with graceful fallback on the known
 * tryInstantiateAsync failure (unresolved Lens Studio bug).
 */

import { EstuaryCredentials } from '../estuary-lens-studio-sdk/src/Components/EstuaryCredentials';
import { EstuaryHttpClient } from '../estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { AgentResponse } from '../estuary-lens-studio-sdk/src/Models/AgentResponse';

/**
 * Manages voice connection switching and GLB model lifecycle for the gallery.
 */
export class GalleryVoiceManager {

    /** The SceneObject containing the EstuaryVoiceConnection component (toggled to connect/disconnect) */
    private voiceConnectionObject: SceneObject;

    /** Reference to the gallery component for creating events */
    private galleryComponent: BaseScriptComponent;

    /** Currently active agent ID */
    private currentAgentId: string | null = null;

    /** Currently spawned GLB model SceneObject (if any) */
    private currentModelObject: SceneObject | null = null;

    // ==================== Constructor ====================

    /**
     * @param voiceConnectionObject The disabled EstuaryVoiceConnection SceneObject from the scene
     * @param galleryComponent The gallery BaseScriptComponent (needed for createEvent)
     */
    constructor(voiceConnectionObject: SceneObject, galleryComponent: BaseScriptComponent) {
        this.voiceConnectionObject = voiceConnectionObject;
        this.galleryComponent = galleryComponent;
    }

    // ==================== Public API ====================

    /**
     * Get the currently active agent ID, or null if none.
     */
    public getCurrentAgentId(): string | null {
        return this.currentAgentId;
    }

    /**
     * Switch to a new character. Updates credentials and reconnects voice.
     *
     * Uses the proven pattern from CharacterGenDemo.ts lines 543-601:
     * 1. Update EstuaryCredentials.characterId
     * 2. Disable voiceConnectionObject (triggers disconnect)
     * 3. Wait 2-3 frames for cleanup
     * 4. Re-enable voiceConnectionObject (triggers fresh connect)
     * 5. Poll for connection, then send greeting
     *
     * @param agentId The character ID to switch to
     * @param agentName The character display name (used in greeting message)
     */
    public switchCharacter(agentId: string, agentName: string): void {
        print('[Gallery] Switching voice to "' + agentName + '" (' + agentId + ')');

        // Update credentials with the new character ID
        const creds = EstuaryCredentials.instance;
        if (!creds) {
            print('[Gallery] ERROR: No EstuaryCredentials singleton found');
            return;
        }
        creds.characterId = agentId;
        this.currentAgentId = agentId;

        const wasActive = this.voiceConnectionObject.enabled;

        if (wasActive) {
            // Voice is currently active: disable, wait frames, re-enable
            this.voiceConnectionObject.enabled = false;
            print('[Gallery] Voice connection disabled - waiting frames before reconnect');

            // Wait 3 frames using an UpdateEvent counter
            let frameCount = 0;
            const waitEvent = this.galleryComponent.createEvent('UpdateEvent');
            waitEvent.bind(() => {
                frameCount++;
                if (frameCount >= 3) {
                    waitEvent.enabled = false;
                    this.enableVoiceAndGreet(agentId, agentName);
                }
            });
        } else {
            // Voice was not active: just enable
            this.enableVoiceAndGreet(agentId, agentName);
        }
    }

    /**
     * Destroy the currently spawned GLB model, if any.
     * Should be called before switching characters to clean up the scene.
     */
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

    /**
     * Attempt to download and instantiate a GLB model for the selected character.
     * Gracefully handles the known tryInstantiateAsync failure in Lens Studio.
     *
     * @param httpClient The HTTP client for downloading GLBs
     * @param agent The character whose model to spawn
     * @param parentSceneObject Where to parent the spawned model
     * @param material Material required by downloadAndInstantiateGlb (null skips the attempt)
     */
    public async attemptGlbSpawn(
        httpClient: EstuaryHttpClient,
        agent: AgentResponse,
        parentSceneObject: SceneObject,
        material: Material | null
    ): Promise<void> {
        const modelUrl = agent.modelUrl || agent.modelPreviewUrl;
        if (!modelUrl) {
            print('[Gallery] No model URL for "' + agent.name + '" - voice-only experience');
            return;
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
            // Known Lens Studio bug: tryInstantiateAsync fails with
            // "glTF asset does not contain a root SceneObject" on ALL GLBs.
            // This is documented in project MEMORY.md as UNRESOLVED.
            print('[Gallery] GLB instantiation failed (known LS bug) - voice-only mode');
            print('[Gallery] Error: ' + (e.message || e));
        }
    }

    // ==================== Private Helpers ====================

    /**
     * Enable the voice connection and send a greeting after it establishes.
     * Polls for connection readiness with a 30-second timeout.
     */
    private enableVoiceAndGreet(agentId: string, agentName: string): void {
        this.voiceConnectionObject.enabled = true;
        print('[Gallery] Voice connection enabled for "' + agentName + '"');

        const greeting = 'Hello! I\'m ready to chat. Introduce yourself as ' + agentName + '!';

        // Poll for the voice connection to establish (same pattern as CharacterGenDemo)
        // @ts-ignore - Lens Studio getTime global
        const greetStart = getTime();
        const greetEvent = this.galleryComponent.createEvent('UpdateEvent');
        greetEvent.bind(() => {
            // @ts-ignore
            const elapsed = getTime() - greetStart;

            // Timeout after 30 seconds
            if (elapsed > 30) {
                greetEvent.enabled = false;
                print('[Gallery] Greeting timeout - voice connection did not establish in 30s');
                return;
            }

            // Find EstuaryVoiceConnection script and check if connected
            const scripts = this.voiceConnectionObject.getComponents('Component.ScriptComponent') as any[];
            for (let i = 0; i < scripts.length; i++) {
                const sc = scripts[i] as any;
                if (sc && typeof sc.sendMessage === 'function' && typeof sc.getCharacter === 'function') {
                    const character = sc.getCharacter();
                    if (character && character.isConnected) {
                        greetEvent.enabled = false;
                        print('[Gallery] Voice connected after ' + elapsed.toFixed(1) + 's - sending greeting');
                        sc.sendMessage(greeting);
                        return;
                    }
                }
            }
        });
    }
}
