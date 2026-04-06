/**
 * CharacterCard - Wraps an instantiated PinchButton prefab to display a character.
 *
 * NOT a @component. Created by CharacterGallery for each card slot.
 * The prefab provides all visual geometry (SUIK handles rendering).
 * This class just updates the label text and binds the tap callback.
 */

import { AgentResponse } from '../estuary-lens-studio-sdk/src/Models/AgentResponse';

/**
 * A single character card backed by an instantiated SUIK PinchButton prefab.
 */
export class CharacterCard {

    /** The instantiated prefab root SceneObject */
    public readonly sceneObject: SceneObject;

    /** The agent data associated with this card */
    public readonly agent: AgentResponse;

    constructor(
        prefabInstance: SceneObject,
        agent: AgentResponse,
        onSelect: (agent: AgentResponse) => void
    ) {
        this.sceneObject = prefabInstance;
        this.agent = agent;

        // Update the PinchButton's label text to the character name
        this.setLabel(agent.name);

        // Load avatar into the Image component (ImageButton prefab has an Image child)
        this.loadAvatar(agent);

        // Bind the tap handler via duck-typing (same pattern as CharacterGenDemo)
        this.bindTapHandler(onSelect);
    }

    /**
     * Find and update any Text or Text3D component in the prefab hierarchy.
     */
    private setLabel(name: string): void {
        if (!this.findAndSetText(this.sceneObject, name)) {
            print('[CharacterCard] WARNING: No text component found in prefab for "' + name + '"');
        }
    }

    private findAndSetText(obj: SceneObject, text: string): boolean {
        // Check this object for Text or Text3D
        try {
            const t = obj.getComponent('Component.Text') as any;
            if (t) { t.text = text; return true; }
        } catch (_: any) {}
        try {
            const t = obj.getComponent('Component.Text3D') as any;
            if (t) { t.text = text; return true; }
        } catch (_: any) {}

        // Recurse into children
        const count = obj.getChildrenCount();
        for (let i = 0; i < count; i++) {
            if (this.findAndSetText(obj.getChild(i), text)) return true;
        }
        return false;
    }

    /**
     * Bind tap handler using duck-typing. UIKit buttons (RectangleButton etc.)
     * expose onTriggerUp/onTriggerDown from Element.ts base class.
     * SIK PinchButton exposes onButtonPinched.
     */
    private bindTapHandler(onSelect: (agent: AgentResponse) => void): void {
        const scripts = this.sceneObject.getComponents('Component.ScriptComponent') as any[];

        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;

            // UIKit buttons: onTriggerUp (from Element.ts → BaseButton → RectangleButton)
            if (sc && sc.onTriggerUp && sc.onTriggerUp.add) {
                sc.onTriggerUp.add(() => {
                    print('[CharacterCard] Card tapped: "' + this.agent.name + '"');
                    onSelect(this.agent);
                });
                return;
            }

            // SIK PinchButton: onButtonPinched
            if (sc && sc.onButtonPinched) {
                sc.onButtonPinched.add(() => {
                    print('[CharacterCard] Card pinched: "' + this.agent.name + '"');
                    onSelect(this.agent);
                });
                return;
            }
        }

        print('[CharacterCard] WARNING: No tap handler found on prefab for "' + this.agent.name + '"');
    }

    /**
     * Load the character's avatar into the Image component in the prefab.
     * ImageButton prefab has a child SceneObject "Image" with Component.Image.
     */
    private loadAvatar(agent: AgentResponse): void {
        const imageUrl = agent.avatar || agent.sourceImageUrl || null;
        if (!imageUrl) {
            print('[CharacterCard] No avatar URL for "' + agent.name + '"');
            return;
        }

        // Find the Image component in the prefab hierarchy
        const imageComp = this.findImageComponent(this.sceneObject);
        if (!imageComp) {
            print('[CharacterCard] No Image component found in prefab for "' + agent.name + '"');
            return;
        }

        try {
            // @ts-ignore - Lens Studio module system
            const internetModule = require('LensStudio:InternetModule') as InternetModule;
            // @ts-ignore
            const remoteMediaModule = require('LensStudio:RemoteMediaModule');

            const resource = internetModule.makeResourceFromUrl(imageUrl);
            remoteMediaModule.loadResourceAsImageTexture(
                resource,
                (texture: Texture) => {
                    print('[CharacterCard] Avatar loaded for "' + agent.name + '"');
                    try {
                        // Clone the material so each card has its own texture
                        // (shared material = last texture wins for all cards)
                        const mat = imageComp.mainMaterial.clone();
                        mat.mainPass.baseTex = texture;
                        imageComp.mainMaterial = mat;
                    } catch (_: any) {
                        // Try alternative property names
                        try {
                            (imageComp as any).texture = texture;
                        } catch (_2: any) {
                            print('[CharacterCard] Could not assign texture to Image for "' + agent.name + '"');
                        }
                    }
                },
                (error: string) => {
                    print('[CharacterCard] Avatar load failed for "' + agent.name + '": ' + error);
                }
            );
        } catch (e: any) {
            print('[CharacterCard] Avatar load error: ' + (e.message || e));
        }
    }

    /**
     * Recursively find a Component.Image in the SceneObject hierarchy.
     */
    private findImageComponent(obj: SceneObject): any {
        try {
            const img = obj.getComponent('Component.Image');
            if (img) return img;
        } catch (_: any) {}

        const count = obj.getChildrenCount();
        for (let i = 0; i < count; i++) {
            const found = this.findImageComponent(obj.getChild(i));
            if (found) return found;
        }
        return null;
    }

    /**
     * Destroy the card and its prefab instance.
     */
    public destroy(): void {
        try {
            this.sceneObject.destroy();
        } catch (e: any) {
            print('[CharacterCard] Error destroying card: ' + (e.message || e));
        }
    }
}
