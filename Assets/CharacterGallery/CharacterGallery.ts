/**
 * CharacterGallery - Main orchestrator for the palm-anchored character gallery UI.
 *
 * This @component fetches the user's characters from the Estuary backend,
 * displays them in a tappable 3x2 grid, supports pagination for large collections,
 * and switches voice conversations when a card is tapped.
 *
 * Setup in Lens Studio:
 * 1. Add EstuaryCredentials to a SceneObject (set API key & server URL)
 * 2. Add this script to a SceneObject
 * 3. Wire voiceConnectionObject to a disabled EstuaryVoiceConnection SceneObject
 * 4. Optionally wire defaultMaterial to a GLTF material for GLB attempts
 * 5. Optionally wire toggleButtonObject to a PinchButton for wrist toggle
 *
 * All UI is created programmatically -- no Scene.scene YAML editing required.
 */

import { setInternetModule, getInternetModule } from '../estuary-lens-studio-sdk/src/Core/EstuaryClient';
import { EstuaryHttpClient } from '../estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { EstuaryConfig } from '../estuary-lens-studio-sdk/src/Core/EstuaryConfig';
import { EstuaryCredentials } from '../estuary-lens-studio-sdk/src/Components/EstuaryCredentials';
import { AgentResponse } from '../estuary-lens-studio-sdk/src/Models/AgentResponse';
import { CharacterCard } from './CharacterCard';
import { GalleryVoiceManager } from './GalleryVoiceManager';
import { PalmAnchor } from './PalmAnchor';
import SIK from 'SpectaclesInteractionKit.lspkg/SIK';

// Import Interactable for programmatic button creation
const Interactable = require('SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable');

// ==================== Configuration Constants ====================

/** Maximum number of characters to fetch from the backend */
const MAX_CHARACTERS = 50;

/** Characters per page in the gallery grid */
const CARDS_PER_PAGE = 6;

/** Grid layout: 3 rows x 2 columns */
const GRID_ROWS = 3;
const GRID_COLS = 2;

/** Card dimensions and spacing in cm */
const CARD_WIDTH = 14;
const CARD_HEIGHT = 10;
const CARD_GAP_X = 1;
const CARD_GAP_Y = 1;

/** Fallback server URL for REST calls */
const SERVER_URL = 'https://api.estuary-ai.com';

/** Fallback player ID */
const PLAYER_ID = 'spectacles-gallery';

// ==================== Component ====================

@component
export class CharacterGallery extends BaseScriptComponent {

    // ==================== Inputs (set in Inspector) ====================

    /**
     * SceneObject with EstuaryVoiceConnection script (initially DISABLED in scene).
     * Required for voice switching when cards are tapped.
     */
    @input
    voiceConnectionObject: SceneObject;

    /**
     * Material for GLB instantiation attempts.
     * Use a GLTF material. Optional -- GLB spawning is skipped without it.
     */
    @input
    @allowUndefined
    defaultMaterial: Material;

    /**
     * Optional SceneObject with a PinchButton for wrist toggle.
     * If not provided, a programmatic toggle is created near the wrist.
     */
    @input
    @allowUndefined
    toggleButtonObject: SceneObject;

    // ==================== Private State ====================

    /** HTTP client for API calls */
    private httpClient: EstuaryHttpClient | null = null;

    /** Voice connection lifecycle manager */
    private voiceManager: GalleryVoiceManager | null = null;

    /** PalmAnchor component controlling gallery visibility and position */
    private palmAnchor: PalmAnchor | null = null;

    /** Root SceneObject for the gallery grid (child of the palm-anchored object) */
    private galleryRoot: SceneObject | null = null;

    /** Container for character cards within the gallery */
    private gridContainer: SceneObject | null = null;

    /** All characters fetched from the backend */
    private allCharacters: AgentResponse[] = [];

    /** Currently displayed CharacterCard instances */
    private activeCards: CharacterCard[] = [];

    /** Current page index (0-based) */
    private currentPage: number = 0;

    /** Total number of pages */
    private totalPages: number = 0;

    /** Page indicator Text3D component */
    private pageIndicator: any = null;

    /** Prev button SceneObject */
    private prevButton: SceneObject | null = null;

    /** Next button SceneObject */
    private nextButton: SceneObject | null = null;

    /** Pagination container SceneObject */
    private paginationContainer: SceneObject | null = null;

    /** Model spawn parent SceneObject (positioned in front of camera) */
    private modelParent: SceneObject | null = null;

    // ==================== Lifecycle ====================

    onAwake(): void {
        // Defer initialization to let EstuaryCredentials.onAwake() register first
        this.createEvent('OnStartEvent').bind(() => this.initialize());
    }

    // ==================== Initialization ====================

    private async initialize(): Promise<void> {
        print('[Gallery] ===== INITIALIZING CHARACTER GALLERY =====');

        // Verify EstuaryCredentials singleton exists
        const creds = EstuaryCredentials.instance;
        if (!creds) {
            print('[Gallery] FATAL: No EstuaryCredentials found in scene!');
            return;
        }

        // Set up InternetModule
        try {
            // @ts-ignore - Lens Studio module system
            const internetModule = require('LensStudio:InternetModule') as InternetModule;
            setInternetModule(internetModule);
            print('[Gallery] InternetModule configured');
        } catch (e: any) {
            print('[Gallery] FATAL: Could not load InternetModule: ' + (e.message || e));
            return;
        }

        // Build HTTP client config from EstuaryCredentials
        const config = this.buildHttpConfig(creds);
        this.httpClient = new EstuaryHttpClient(config);
        print('[Gallery] HTTP client created - server: ' + config.serverUrl);

        // Create voice manager
        this.voiceManager = new GalleryVoiceManager(this.voiceConnectionObject, this);
        print('[Gallery] Voice manager created');

        // Create the palm-anchored gallery root
        this.setupGalleryStructure();

        // Set up the wrist toggle
        this.setupWristToggle();

        // Create model parent for GLB spawning (positioned in front of camera)
        this.setupModelParent();

        // Fetch characters from the backend
        try {
            print('[Gallery] Fetching characters (limit=' + MAX_CHARACTERS + ')...');
            const response = await this.httpClient.getCharacters(MAX_CHARACTERS, 0);
            this.allCharacters = response.characters;
            this.totalPages = Math.ceil(this.allCharacters.length / CARDS_PER_PAGE);

            print('[Gallery] Loaded ' + this.allCharacters.length + ' characters (' + this.totalPages + ' pages)');

            if (this.allCharacters.length === 0) {
                this.showMessage('No characters yet');
                return;
            }

            // Render first page
            this.renderPage(0);
        } catch (e: any) {
            print('[Gallery] ERROR fetching characters: ' + (e.message || e));
            this.showMessage('Failed to load characters');
        }
    }

    // ==================== Gallery Structure ====================

    /**
     * Create the gallery SceneObject hierarchy:
     * - PalmAnchor SceneObject (tracks palm, controls visibility)
     *   - Gallery Root (contains grid + pagination)
     *     - Grid Container (holds CharacterCard instances)
     *     - Pagination Container (prev/next/indicator)
     */
    private setupGalleryStructure(): void {
        // Create the PalmAnchor SceneObject as a child of this component's SceneObject
        // @ts-ignore - Lens Studio global.scene API
        const palmAnchorObj = global.scene.createSceneObject('PalmAnchorRoot');
        palmAnchorObj.setParent(this.getSceneObject());

        // Add PalmAnchor component
        try {
            this.palmAnchor = palmAnchorObj.createComponent(PalmAnchor.getTypeName()) as PalmAnchor;
            print('[Gallery] PalmAnchor component created');
        } catch (e: any) {
            print('[Gallery] WARNING: Could not create PalmAnchor component: ' + (e.message || e));
            print('[Gallery] Gallery will not track palm - using static position');
        }

        // Create gallery root as child of the palm anchor
        // @ts-ignore
        this.galleryRoot = global.scene.createSceneObject('GalleryRoot');
        this.galleryRoot.setParent(palmAnchorObj);

        // Offset the gallery slightly above the palm
        this.galleryRoot.getTransform().setLocalPosition(new vec3(0, 5, 0));

        // Create grid container
        // @ts-ignore
        this.gridContainer = global.scene.createSceneObject('GridContainer');
        this.gridContainer.setParent(this.galleryRoot);

        // Create pagination container below the grid
        // @ts-ignore
        this.paginationContainer = global.scene.createSceneObject('PaginationContainer');
        this.paginationContainer.setParent(this.galleryRoot);

        // Position pagination below the grid: 3 rows * (card height + gap)
        const paginationY = -(GRID_ROWS * (CARD_HEIGHT + CARD_GAP_Y)) - 2;
        this.paginationContainer.getTransform().setLocalPosition(new vec3(0, paginationY, 0));

        // Create pagination buttons
        this.setupPagination();

        print('[Gallery] Gallery structure created');
    }

    // ==================== Grid Rendering ====================

    /**
     * Render a page of character cards in the 3x2 grid.
     * Destroys existing cards and creates new ones for the requested page.
     */
    private renderPage(pageIndex: number): void {
        // Destroy existing cards
        for (const card of this.activeCards) {
            card.destroy();
        }
        this.activeCards = [];

        this.currentPage = pageIndex;

        // Slice characters for this page
        const startIdx = pageIndex * CARDS_PER_PAGE;
        const pageCharacters = this.allCharacters.slice(startIdx, startIdx + CARDS_PER_PAGE);

        print('[Gallery] Rendering page ' + (pageIndex + 1) + ' of ' + this.totalPages +
            ' (' + pageCharacters.length + ' cards)');

        // Create cards in a 3-row x 2-column grid
        for (let i = 0; i < pageCharacters.length; i++) {
            const agent = pageCharacters[i];
            const row = Math.floor(i / GRID_COLS);
            const col = i % GRID_COLS;

            const card = new CharacterCard(
                this.gridContainer!,
                agent,
                (selectedAgent: AgentResponse) => this.onCardSelect(selectedAgent)
            );

            // Position: col * (width + gap) for X, row * -(height + gap) for Y
            // Center the grid horizontally: offset by half the total grid width
            const totalGridWidth = GRID_COLS * CARD_WIDTH + (GRID_COLS - 1) * CARD_GAP_X;
            const xOffset = -totalGridWidth / 2 + CARD_WIDTH / 2;
            const x = xOffset + col * (CARD_WIDTH + CARD_GAP_X);
            const y = -row * (CARD_HEIGHT + CARD_GAP_Y);

            card.sceneObject.getTransform().setLocalPosition(new vec3(x, y, 0));
            this.activeCards.push(card);
        }

        // Update pagination UI
        this.updatePagination();
    }

    // ==================== Pagination ====================

    /**
     * Create prev/next buttons and page indicator below the grid.
     * Each button is a SceneObject with ColliderComponent + Interactable + Text3D.
     */
    private setupPagination(): void {
        if (!this.paginationContainer) return;

        // Prev button
        this.prevButton = this.createPaginationButton(
            '< Prev',
            new vec3(-10, 0, 0),
            () => {
                if (this.currentPage > 0) {
                    this.renderPage(this.currentPage - 1);
                }
            }
        );
        this.prevButton.setParent(this.paginationContainer);

        // Page indicator
        // @ts-ignore
        const indicatorObj = global.scene.createSceneObject('PageIndicator');
        indicatorObj.setParent(this.paginationContainer);
        indicatorObj.getTransform().setLocalPosition(new vec3(0, 0, 0));

        try {
            this.pageIndicator = indicatorObj.createComponent('Component.Text3D') as any;
            this.pageIndicator.text = 'Page 1 of 1';
            try {
                this.pageIndicator.size = 1.2;
                this.pageIndicator.horizontalAlignment = 1; // Center
            } catch (_: any) {
                // Property names may vary
            }
        } catch (e: any) {
            print('[Gallery] WARNING: Could not create page indicator Text3D: ' + (e.message || e));
        }

        // Next button
        this.nextButton = this.createPaginationButton(
            'Next >',
            new vec3(10, 0, 0),
            () => {
                if (this.currentPage < this.totalPages - 1) {
                    this.renderPage(this.currentPage + 1);
                }
            }
        );
        this.nextButton.setParent(this.paginationContainer);
    }

    /**
     * Create a single pagination button with collider, interactable, and text.
     */
    private createPaginationButton(
        label: string,
        position: vec3,
        onClick: () => void
    ): SceneObject {
        // @ts-ignore
        const btnObj = global.scene.createSceneObject('Btn_' + label.replace(/[^a-zA-Z]/g, ''));
        btnObj.getTransform().setLocalPosition(position);

        // Collider
        // @ts-ignore
        const colliderObj = global.scene.createSceneObject('BtnCollider');
        colliderObj.setParent(btnObj);
        const collider = colliderObj.createComponent('Physics.ColliderComponent') as ColliderComponent;
        collider.fitVisual = false;
        // @ts-ignore
        const shape = Shape.createBoxShape();
        shape.size = new vec3(8, 4, 1);
        collider.shape = shape;

        // Interactable
        try {
            const interactable = btnObj.createComponent(Interactable.getTypeName()) as any;
            interactable.targetingMode = 3;
            interactable.onTriggerEnd.add(() => onClick());
        } catch (e: any) {
            print('[Gallery] WARNING: Failed to create pagination Interactable: ' + (e.message || e));
        }

        // Text label
        // @ts-ignore
        const labelObj = global.scene.createSceneObject('BtnLabel');
        labelObj.setParent(btnObj);
        labelObj.getTransform().setLocalPosition(new vec3(0, 0, -0.1));
        try {
            const text3d = labelObj.createComponent('Component.Text3D') as any;
            text3d.text = label;
            try {
                text3d.size = 1.2;
                text3d.horizontalAlignment = 1;
            } catch (_: any) {}
        } catch (e: any) {
            print('[Gallery] WARNING: Could not create button Text3D: ' + (e.message || e));
        }

        return btnObj;
    }

    /**
     * Update pagination visibility and page indicator text.
     */
    private updatePagination(): void {
        // Hide pagination entirely if only 1 page or no pages
        if (this.paginationContainer) {
            this.paginationContainer.enabled = this.totalPages > 1;
        }

        // Update page indicator
        if (this.pageIndicator) {
            this.pageIndicator.text = 'Page ' + (this.currentPage + 1) + ' of ' + this.totalPages;
        }

        // Show/hide prev/next based on page bounds
        if (this.prevButton) {
            this.prevButton.enabled = this.currentPage > 0;
        }
        if (this.nextButton) {
            this.nextButton.enabled = this.currentPage < this.totalPages - 1;
        }
    }

    // ==================== Wrist Toggle ====================

    /**
     * Set up the wrist toggle button.
     * If toggleButtonObject is provided, bind to its PinchButton.
     * Otherwise, create a programmatic toggle near the wrist.
     */
    private setupWristToggle(): void {
        if (this.toggleButtonObject) {
            // Use existing PinchButton via duck-typing pattern (from CharacterGenDemo)
            this.bindExistingToggle();
        } else {
            // Create programmatic wrist toggle
            this.createProgrammaticToggle();
        }
    }

    /**
     * Bind to an existing PinchButton on toggleButtonObject.
     * Uses the CharacterGenDemo duck-typing pattern to find onButtonPinched.
     */
    private bindExistingToggle(): void {
        const scripts = this.toggleButtonObject.getComponents('Component.ScriptComponent') as any[];
        let found = false;

        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && sc.onButtonPinched) {
                sc.onButtonPinched.add(() => this.toggleGallery());
                found = true;
                print('[Gallery] PinchButton bound for wrist toggle');
                break;
            }
            if (sc && sc.api && sc.api.onButtonPinched) {
                sc.api.onButtonPinched.add(() => this.toggleGallery());
                found = true;
                print('[Gallery] PinchButton bound via .api for wrist toggle');
                break;
            }
        }

        if (!found) {
            print('[Gallery] WARNING: No PinchButton found on toggleButtonObject');
        }
    }

    /**
     * Create a programmatic toggle button near the wrist.
     * Tracks the wrist position per-frame and uses Interactable for tap.
     */
    private createProgrammaticToggle(): void {
        // @ts-ignore
        const toggleObj = global.scene.createSceneObject('WristToggle');
        toggleObj.setParent(this.getSceneObject());

        // Create collider for the toggle
        // @ts-ignore
        const colliderObj = global.scene.createSceneObject('ToggleCollider');
        colliderObj.setParent(toggleObj);
        const collider = colliderObj.createComponent('Physics.ColliderComponent') as ColliderComponent;
        collider.fitVisual = false;
        // @ts-ignore
        const shape = Shape.createBoxShape();
        shape.size = new vec3(4, 4, 1); // ~4cm x 4cm button
        collider.shape = shape;

        // Create interactable
        try {
            const interactable = toggleObj.createComponent(Interactable.getTypeName()) as any;
            interactable.targetingMode = 3;
            interactable.onTriggerEnd.add(() => this.toggleGallery());
        } catch (e: any) {
            print('[Gallery] WARNING: Failed to create wrist toggle Interactable: ' + (e.message || e));
        }

        // Create "Gallery" label
        // @ts-ignore
        const labelObj = global.scene.createSceneObject('ToggleLabel');
        labelObj.setParent(toggleObj);
        labelObj.getTransform().setLocalPosition(new vec3(0, 0, -0.1));
        try {
            const text3d = labelObj.createComponent('Component.Text3D') as any;
            text3d.text = 'Gallery';
            try {
                text3d.size = 1.0;
                text3d.horizontalAlignment = 1;
            } catch (_: any) {}
        } catch (e: any) {
            print('[Gallery] WARNING: Could not create toggle Text3D: ' + (e.message || e));
        }

        // Track wrist position per-frame
        const handInputData = SIK.HandInputData;
        const nonDomHand = handInputData.getNonDominantHand();

        this.createEvent('UpdateEvent').bind(() => {
            if (!nonDomHand || !nonDomHand.isTracked()) {
                toggleObj.enabled = false;
                return;
            }

            try {
                const wristPos = nonDomHand.wrist.position;
                if (wristPos) {
                    toggleObj.enabled = true;
                    // Position 3cm above the wrist
                    const togglePos = wristPos.add(new vec3(0, 3, 0));
                    toggleObj.getTransform().setWorldPosition(togglePos);
                }
            } catch (_: any) {
                toggleObj.enabled = false;
            }
        });

        print('[Gallery] Programmatic wrist toggle created');
    }

    /**
     * Toggle gallery visibility via PalmAnchor's forceShow property.
     */
    private toggleGallery(): void {
        if (this.palmAnchor) {
            this.palmAnchor.forceShow = !this.palmAnchor.forceShow;
            print('[Gallery] Gallery forceShow toggled: ' + this.palmAnchor.forceShow);
        } else if (this.galleryRoot) {
            // Fallback: directly toggle the gallery root
            this.galleryRoot.enabled = !this.galleryRoot.enabled;
            print('[Gallery] Gallery visibility toggled: ' + this.galleryRoot.enabled);
        }
    }

    // ==================== Card Selection ====================

    /**
     * Callback invoked when a character card is tapped.
     * Switches voice and attempts GLB spawn.
     */
    private onCardSelect(agent: AgentResponse): void {
        print('[Gallery] ===== CARD SELECTED =====');
        print('[Gallery] Character: "' + agent.name + '" (' + agent.id + ')');

        if (!this.voiceManager) {
            print('[Gallery] ERROR: Voice manager not initialized');
            return;
        }

        // Clean up existing model
        this.voiceManager.destroyCurrentModel();

        // Switch voice connection
        this.voiceManager.switchCharacter(agent.id, agent.name);

        // Attempt GLB spawn (non-blocking, graceful failure)
        if (this.httpClient && this.modelParent) {
            this.voiceManager.attemptGlbSpawn(
                this.httpClient,
                agent,
                this.modelParent,
                this.defaultMaterial || null
            );
        }
    }

    // ==================== Model Parent Setup ====================

    /**
     * Create a SceneObject for spawning GLB models.
     * Positioned ~100cm in front of the camera (same pattern as CharacterGenDemo).
     */
    private setupModelParent(): void {
        // @ts-ignore
        this.modelParent = global.scene.createSceneObject('GalleryModelParent');

        try {
            const camTransform = this.getSceneObject().getTransform();
            const camPos = camTransform.getWorldPosition();
            const forward = camTransform.forward;
            const modelPos = camPos.add(forward.uniformScale(-100));
            this.modelParent.getTransform().setWorldPosition(modelPos);
        } catch (_: any) {
            // Fallback position
            this.modelParent.getTransform().setWorldPosition(new vec3(0, 0, -100));
        }
    }

    // ==================== Helper Methods ====================

    /**
     * Build HTTP client config from EstuaryCredentials singleton.
     * Converts wss:// to https:// for REST calls.
     */
    private buildHttpConfig(creds: EstuaryCredentials): EstuaryConfig {
        let serverUrl = creds.serverUrl || SERVER_URL;
        if (serverUrl.startsWith('wss://')) serverUrl = 'https://' + serverUrl.substring(6);
        else if (serverUrl.startsWith('ws://')) serverUrl = 'http://' + serverUrl.substring(5);

        return {
            serverUrl: serverUrl,
            apiKey: (creds.apiKey || '').trim(),
            characterId: '',
            playerId: creds.userId || PLAYER_ID,
            debugLogging: true,
        };
    }

    /**
     * Show a message in the gallery grid area (for errors or empty state).
     */
    private showMessage(message: string): void {
        if (!this.galleryRoot) return;

        // @ts-ignore
        const msgObj = global.scene.createSceneObject('GalleryMessage');
        msgObj.setParent(this.galleryRoot);
        msgObj.getTransform().setLocalPosition(new vec3(0, -10, 0));

        try {
            const text3d = msgObj.createComponent('Component.Text3D') as any;
            text3d.text = message;
            try {
                text3d.size = 2.0;
                text3d.horizontalAlignment = 1;
            } catch (_: any) {}
        } catch (e: any) {
            print('[Gallery] Could not create message Text3D: ' + (e.message || e));
        }

        print('[Gallery] Message: ' + message);
    }
}
