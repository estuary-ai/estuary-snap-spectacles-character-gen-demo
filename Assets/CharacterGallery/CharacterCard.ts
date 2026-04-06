/**
 * CharacterCard - A plain TypeScript class representing a single card in the gallery grid.
 *
 * NOT a @component. Cards are data-driven instances created by CharacterGallery.
 * Each card has:
 * - A tappable area (ColliderComponent + Interactable from SIK)
 * - A Text3D name label
 * - Async thumbnail loading attempt (graceful fallback to name-only)
 *
 * Cards are immediately interactive upon creation -- thumbnail loading is async
 * and does not block tap interaction.
 */

import { AgentResponse } from '../estuary-lens-studio-sdk/src/Models/AgentResponse';

// Import Interactable for SIK tap interaction
const Interactable = require('SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable');

/**
 * A single character card in the gallery grid.
 */
export class CharacterCard {

    /** The root SceneObject for this card, used for positioning by the grid layout */
    public readonly sceneObject: SceneObject;

    /** The agent data associated with this card */
    public readonly agent: AgentResponse;

    // ==================== Private State ====================

    /** Text3D component for the character name */
    private nameLabel: any = null;

    /** Whether thumbnail has been loaded */
    private thumbnailLoaded: boolean = false;

    // ==================== Constructor ====================

    /**
     * Create a new character card.
     * @param parent Parent SceneObject to attach the card to
     * @param agent Character data from the backend
     * @param onSelect Callback invoked when the card is tapped
     */
    constructor(
        parent: SceneObject,
        agent: AgentResponse,
        onSelect: (agent: AgentResponse) => void
    ) {
        this.agent = agent;

        // Create the card container SceneObject
        // @ts-ignore - Lens Studio global.scene API
        this.sceneObject = global.scene.createSceneObject('Card_' + agent.name);
        this.sceneObject.setParent(parent);

        // Set up the collider for SIK interaction
        this.setupCollider();

        // Set up the Interactable component for tap detection
        this.setupInteractable(onSelect);

        // Create the name label
        this.setupNameLabel(agent.name);

        // Attempt to load thumbnail asynchronously (non-blocking)
        this.attemptThumbnailLoad(agent);
    }

    // ==================== Setup Methods ====================

    /**
     * Create a BoxCollider on a child SceneObject.
     * SIK's InteractionManager auto-discovers colliders in the hierarchy.
     */
    private setupCollider(): void {
        // @ts-ignore - Lens Studio global.scene API
        const colliderObj = global.scene.createSceneObject('CardCollider');
        colliderObj.setParent(this.sceneObject);

        const collider = colliderObj.createComponent('Physics.ColliderComponent') as ColliderComponent;
        collider.fitVisual = false;

        // @ts-ignore - Lens Studio Shape API
        const shape = Shape.createBoxShape();
        shape.size = new vec3(14, 10, 1); // 14cm wide x 10cm tall x 1cm deep
        collider.shape = shape;
    }

    /**
     * Create an Interactable on the card container.
     * SIK auto-discovers the collider in the hierarchy.
     */
    private setupInteractable(onSelect: (agent: AgentResponse) => void): void {
        try {
            const interactable = this.sceneObject.createComponent(
                Interactable.getTypeName()
            ) as any;

            // targetingMode 3 = Direct + Indirect targeting
            interactable.targetingMode = 3;

            // Bind tap handler (onTriggerEnd = pinch release = tap)
            interactable.onTriggerEnd.add(() => {
                print('[CharacterCard] Card tapped: "' + this.agent.name + '" (' + this.agent.id + ')');
                onSelect(this.agent);
            });
        } catch (e: any) {
            print('[CharacterCard] WARNING: Failed to create Interactable: ' + (e.message || e));
            print('[CharacterCard] Card "' + this.agent.name + '" will not be tappable');
        }
    }

    /**
     * Create a Text3D label displaying the character name.
     * Positioned at the bottom-center of the card.
     */
    private setupNameLabel(name: string): void {
        // @ts-ignore - Lens Studio global.scene API
        const labelObj = global.scene.createSceneObject('Label_' + name);
        labelObj.setParent(this.sceneObject);
        labelObj.getTransform().setLocalPosition(new vec3(0, -3, -0.1));

        try {
            const text3d = labelObj.createComponent('Component.Text3D') as any;
            text3d.text = name;

            // Style the text for readability at arm's length
            try {
                text3d.size = 1.5;                 // Font size in cm
                text3d.horizontalAlignment = 1;    // Center alignment
                text3d.verticalAlignment = 1;      // Center
            } catch (_: any) {
                // Text3D property names may differ across LS versions
            }

            this.nameLabel = text3d;
        } catch (e: any) {
            print('[CharacterCard] WARNING: Failed to create Text3D for "' + name + '": ' + (e.message || e));
        }
    }

    /**
     * Attempt to load the character thumbnail asynchronously.
     * Falls back gracefully to name-only card if loading fails.
     *
     * Priority: agent.avatar > agent.sourceImageUrl > skip
     */
    private attemptThumbnailLoad(agent: AgentResponse): void {
        const imageUrl = agent.avatar || agent.sourceImageUrl || null;
        if (!imageUrl) {
            print('[CharacterCard] No thumbnail URL for "' + agent.name + '" - name-only card');
            return;
        }

        try {
            // Require modules inside the method body per Pitfall 6
            // @ts-ignore - Lens Studio module system
            const internetModule = require('LensStudio:InternetModule') as InternetModule;
            // @ts-ignore - Lens Studio module system
            const remoteMediaModule = require('LensStudio:RemoteMediaModule');

            const resource = internetModule.makeResourceFromUrl(imageUrl);
            remoteMediaModule.loadResourceAsImageTexture(
                resource,
                (texture: Texture) => {
                    this.thumbnailLoaded = true;
                    print('[CharacterCard] Thumbnail loaded for "' + agent.name + '"');
                    // Note: Applying texture to a visual requires a RenderMeshVisual with a mesh.
                    // Programmatic quad mesh creation is not reliably available in Lens Studio,
                    // so the texture is loaded but we rely on the name label for display.
                    // The loaded texture could be applied if a material/mesh input is provided
                    // in a future enhancement.
                },
                (error: string) => {
                    print('[CharacterCard] Thumbnail load failed for "' + agent.name + '": ' + error);
                    // Graceful degradation: name-only card is already visible
                }
            );
        } catch (e: any) {
            print('[CharacterCard] Thumbnail load error for "' + agent.name + '": ' + (e.message || e));
        }
    }

    // ==================== Public API ====================

    /**
     * Destroy this card and clean up its SceneObject hierarchy.
     * Called on page change to remove old cards before creating new ones.
     */
    public destroy(): void {
        try {
            this.sceneObject.destroy();
        } catch (e: any) {
            print('[CharacterCard] Error destroying card: ' + (e.message || e));
        }
    }
}
