/**
 * CharacterGallery - Palm-anchored character gallery using SUIK prefabs.
 *
 * Setup in Lens Studio:
 * 1. Add EstuaryCredentials to a SceneObject (set API key & server URL)
 * 2. Add this script to a SceneObject
 * 3. Wire voiceConnectionObject to a DISABLED EstuaryVoiceConnection SceneObject
 * 4. Wire cardPrefab to a PinchButton prefab from SpectaclesInteractionKit
 * 5. Wire navPrefab to a smaller PinchButton prefab for prev/next (or same as cardPrefab)
 * 6. Optionally wire defaultMaterial to GLTF.mat for GLB attempts
 */

import { setInternetModule } from '../estuary-lens-studio-sdk/src/Core/EstuaryClient';
import { EstuaryHttpClient } from '../estuary-lens-studio-sdk/src/Core/EstuaryHttpClient';
import { EstuaryConfig } from '../estuary-lens-studio-sdk/src/Core/EstuaryConfig';
import { EstuaryCredentials } from '../estuary-lens-studio-sdk/src/Components/EstuaryCredentials';
import { AgentResponse } from '../estuary-lens-studio-sdk/src/Models/AgentResponse';
import { CharacterCard } from './CharacterCard';
import { GalleryVoiceManager } from './GalleryVoiceManager';
import { PalmAnchor } from './PalmAnchor';

// ==================== Configuration Constants ====================

const CARDS_PER_PAGE = 6;
const GRID_ROWS = 3;
const GRID_COLS = 2;

/** Card spacing in cm */
const CARD_SPACING_X = 7;
const CARD_SPACING_Y = 4;

const SERVER_URL = 'https://api.estuary-ai.com';
const PLAYER_ID = 'spectacles-gallery';

// ==================== Component ====================

@component
export class CharacterGallery extends BaseScriptComponent {

    // ==================== Inputs ====================

    /** Button prefab to instantiate for each character card */
    @input
    cardPrefab: ObjectPrefab;

    /** Button prefab for prev/next navigation (can be same as cardPrefab) */
    @input
    @allowUndefined
    navPrefab: ObjectPrefab;

    /** LabelledToggle prefab for wrist toggle (show/hide gallery) */
    @input
    @allowUndefined
    togglePrefab: ObjectPrefab;

    /** DISABLED EstuaryVoiceConnection SceneObject for voice switching */
    @input
    voiceConnectionObject: SceneObject;

    /** GLTF material for GLB instantiation (optional) */
    @input
    @allowUndefined
    defaultMaterial: Material;

    // ==================== Private State ====================

    private httpClient: EstuaryHttpClient | null = null;
    private voiceManager: GalleryVoiceManager | null = null;
    private palmAnchor: PalmAnchor | null = null;
    private galleryRoot: SceneObject | null = null;
    private gridContainer: SceneObject | null = null;
    private allCharacters: AgentResponse[] = [];
    private activeCards: CharacterCard[] = [];
    private currentPage: number = 0;
    private totalPages: number = 0;

    // Nav button instances
    private prevBtnInstance: SceneObject | null = null;
    private nextBtnInstance: SceneObject | null = null;
    private pageIndicatorObj: SceneObject | null = null;
    private pageIndicator: any = null;

    // ==================== Lifecycle ====================

    onAwake(): void {
        this.createEvent('OnStartEvent').bind(() => this.initialize());
    }

    private async initialize(): Promise<void> {
        print('[Gallery] ===== INITIALIZING =====');

        if (!this.cardPrefab) {
            print('[Gallery] FATAL: cardPrefab not assigned! Drag a PinchButton prefab to this input.');
            return;
        }

        const creds = EstuaryCredentials.instance;
        if (!creds) {
            print('[Gallery] FATAL: No EstuaryCredentials in scene');
            return;
        }

        // InternetModule
        try {
            // @ts-ignore
            const internetModule = require('LensStudio:InternetModule') as InternetModule;
            setInternetModule(internetModule);
        } catch (e: any) {
            print('[Gallery] FATAL: InternetModule: ' + (e.message || e));
            return;
        }

        // HTTP client
        const config = this.buildHttpConfig(creds);
        this.httpClient = new EstuaryHttpClient(config);
        print('[Gallery] HTTP client ready: ' + config.serverUrl + ' playerId=' + config.playerId + ' apiKey=' + (config.apiKey ? config.apiKey.substring(0, 12) + '...' : 'NONE'));

        // Voice manager
        this.voiceManager = new GalleryVoiceManager(this.voiceConnectionObject, this);

        // Build gallery structure
        this.buildGalleryStructure();

        // Fetch characters
        try {
            print('[Gallery] Fetching characters...');
            const response = await this.httpClient.getCharacters(50, 0);
            this.allCharacters = response.characters;
            this.totalPages = Math.max(1, Math.ceil(this.allCharacters.length / CARDS_PER_PAGE));
            print('[Gallery] Loaded ' + this.allCharacters.length + ' characters (' + this.totalPages + ' pages)');

            if (this.allCharacters.length === 0) {
                print('[Gallery] No characters found');
                return;
            }

            this.renderPage(0);

            // Re-enforce hidden state after cards are created
            // (instantiated prefabs may not inherit parent disabled state)
            if (this.galleryRoot && !this.galleryVisible) {
                this.galleryRoot.enabled = false;
            }
        } catch (e: any) {
            print('[Gallery] ERROR fetching characters: ' + (e.message || e));
        }
    }

    // ==================== Gallery Structure ====================

    private buildGalleryStructure(): void {
        // PalmAnchor root — tracks the hand, controls child visibility
        // @ts-ignore
        const anchorObj = global.scene.createSceneObject('PalmAnchorRoot');
        anchorObj.setParent(this.getSceneObject());

        try {
            this.palmAnchor = anchorObj.createComponent(PalmAnchor.getTypeName()) as PalmAnchor;
            print('[Gallery] PalmAnchor created');
        } catch (e: any) {
            print('[Gallery] PalmAnchor failed: ' + (e.message || e));
        }

        // Gallery root — offset above palm
        // @ts-ignore
        this.galleryRoot = global.scene.createSceneObject('GalleryRoot');
        this.galleryRoot.setParent(anchorObj);
        this.galleryRoot.getTransform().setLocalPosition(new vec3(0, 0, 5));

        // Grid container for cards
        // @ts-ignore
        this.gridContainer = global.scene.createSceneObject('GridContainer');
        this.gridContainer.setParent(this.galleryRoot);

        // Navigation (prev / page indicator / next)
        this.buildNavigation();

        // Wrist toggle button (show/hide gallery)
        this.buildWristToggle();

        // Start gallery hidden — user toggles it on via wrist button
        this.galleryVisible = false;
        this.galleryRoot.enabled = false;

        print('[Gallery] Structure built (gallery hidden by default)');
    }

    // ==================== Wrist Toggle ====================

    /** Wrist toggle button SceneObject */
    private wristToggleObj: SceneObject | null = null;

    /** Toggle button script reference for syncing isOn state */
    private _toggleButtonScript: any = null;

    /** Whether the gallery is currently shown */
    private galleryVisible: boolean = false;

    private buildWristToggle(): void {
        if (!this.togglePrefab) {
            print('[Gallery] No togglePrefab — wrist toggle disabled');
            return;
        }

        // Instantiate the toggle button as a child of CharacterGallery (NOT PalmAnchor)
        // so we can position it at the raw wrist position independently of the gallery offset
        this.wristToggleObj = this.togglePrefab.instantiate(this.getSceneObject());
        this.wristToggleObj.getTransform().setLocalPosition(new vec3(0, 0, 0));
        this.wristToggleObj.getTransform().setLocalScale(new vec3(0.7, 0.7, 0.7));

        // Set label to "Gallery"
        this.findAndSetText(this.wristToggleObj, 'Gallery');

        // Configure button: Direct targeting only, toggleable, start in OFF state
        try {
            const toggleScripts = this.wristToggleObj.getComponents('Component.ScriptComponent') as any[];
            for (let i = 0; i < toggleScripts.length; i++) {
                const sc = toggleScripts[i] as any;
                // Set on the Element/Interactable if it has targetingMode
                if (sc && sc.interactable && sc.interactable.targetingMode !== undefined) {
                    sc.interactable.targetingMode = 1; // Direct only
                }
                if (sc && sc.targetingMode !== undefined) {
                    sc.targetingMode = 1;
                }
                // Make toggleable and start OFF (highlighted = gallery active)
                if (sc && typeof sc.setIsToggleable === 'function') {
                    sc.setIsToggleable(true);
                    sc.isOn = false; // OFF = gallery hidden
                    this._toggleButtonScript = sc;
                }
            }
        } catch (_: any) {}

        // Use onTriggerUp with manual toggle + debounce.
        // Do NOT use onValueChange — it fires spuriously when hand tracking drops.
        let lastToggleTime = 0;
        this.bindPrefabTap(this.wristToggleObj, () => {
            // @ts-ignore
            const now: number = getTime();
            // Debounce: ignore triggers within 0.3 seconds of each other
            if (now - lastToggleTime < 0.3) return;
            lastToggleTime = now;

            this.galleryVisible = !this.galleryVisible;
            if (this.galleryRoot) {
                this.galleryRoot.enabled = this.galleryVisible;
            }

            // Sync toggle button visual: ON = gallery active (highlighted)
            if (this._toggleButtonScript && typeof this._toggleButtonScript.isOn !== 'undefined') {
                this._toggleButtonScript.isOn = this.galleryVisible;
            }

            // Coordinate with PalmAnchor — prevent hand tracking from overriding toggle
            try {
                const parent = this.getSceneObject().getParent();
                if (parent) {
                    const palmScripts = parent.getComponents('Component.ScriptComponent') as any[];
                    for (const sc of palmScripts) {
                        if (sc && typeof sc.forceShow !== 'undefined') {
                            sc.forceShow = this.galleryVisible;
                            break;
                        }
                    }
                }
            } catch (_: any) {}

            print('[Gallery] Toggle: gallery ' + (this.galleryVisible ? 'SHOWN' : 'HIDDEN'));
        });

        // Track toggle button to raw wrist position (not PalmAnchor's offset position)
        this.createEvent('UpdateEvent').bind(() => {
            if (!this.wristToggleObj || !this.palmAnchor) return;
            const wristPos = this.palmAnchor.getWristPosition();
            if (wristPos) {
                // 5cm to the right of the carpal
                const buttonPos = wristPos.add(new vec3(8, 0, -2));
                this.wristToggleObj.getTransform().setWorldPosition(buttonPos);

                // Face camera
                try {
                    // @ts-ignore
                    const camPos = global.scene.getRootObject(0).getTransform().getWorldPosition();
                    const dir = camPos.sub(buttonPos).normalize();
                    const worldUp = new vec3(0, 1, 0);
                    const right = worldUp.cross(dir).normalize();
                    const up = dir.cross(right).normalize();
                    this.wristToggleObj.getTransform().setWorldRotation(quat.lookAt(dir, up));
                } catch (_: any) {}

                if (!this.wristToggleObj.enabled) {
                    this.wristToggleObj.enabled = true;
                }
            }
        });

        print('[Gallery] Wrist toggle created');
    }

    private findAndSetText(obj: SceneObject, text: string): boolean {
        // First try to find and update existing text components
        if (this.findAndUpdateText(obj, text)) return true;

        // Fallback: create a new Text3D in front of the button
        try {
            // @ts-ignore
            const labelObj = global.scene.createSceneObject('Label_' + text);
            labelObj.setParent(obj);
            // Position in front of the button to avoid z-fighting
            labelObj.getTransform().setLocalPosition(new vec3(0, 0, -1.5));
            const t3d = labelObj.createComponent('Component.Text3D') as any;
            if (t3d) {
                t3d.text = text;
                try { t3d.size = 1.5; } catch (_: any) {}
                try { t3d.horizontalAlignment = 1; } catch (_: any) {} // Center
            }
            return true;
        } catch (_: any) {}
        return false;
    }

    private findAndUpdateText(obj: SceneObject, text: string): boolean {
        try {
            const t = obj.getComponent('Component.Text') as any;
            if (t) { t.text = text; return true; }
        } catch (_: any) {}
        try {
            const t = obj.getComponent('Component.Text3D') as any;
            if (t) { t.text = text; return true; }
        } catch (_: any) {}
        const count = obj.getChildrenCount();
        for (let i = 0; i < count; i++) {
            if (this.findAndUpdateText(obj.getChild(i), text)) return true;
        }
        return false;
    }

    /**
     * Disable depth test on a text/visual component so it renders on top of button surfaces.
     * Text3D doesn't expose mainPass directly — find the RenderMeshVisual it uses internally.
     */
    private disableDepthOnComponent(component: any, obj: SceneObject): void {
        try {
            // Try mainPass directly on the component
            if (component.mainPass) {
                component.mainPass.depthTest = false;
                component.mainPass.depthWrite = false;
            }
            // Try via mainMaterial
            if (component.mainMaterial && component.mainMaterial.mainPass) {
                component.mainMaterial.mainPass.depthTest = false;
                component.mainMaterial.mainPass.depthWrite = false;
            }
            // Try getMaterial(0) for multi-material components
            if (typeof component.getMaterial === 'function') {
                const mat = component.getMaterial(0);
                if (mat && mat.mainPass) {
                    mat.mainPass.depthTest = false;
                    mat.mainPass.depthWrite = false;
                }
            }
            // Text3D uses a RenderMeshVisual internally — find it on the same or child objects
            const rmv = obj.getComponent('Component.RenderMeshVisual') as any;
            if (rmv) {
                const matCount = typeof rmv.getMaterialsCount === 'function' ? rmv.getMaterialsCount() : 1;
                for (let m = 0; m < matCount; m++) {
                    try {
                        const mat = rmv.getMaterial(m);
                        if (mat && mat.mainPass) {
                            mat.mainPass.depthTest = false;
                            mat.mainPass.depthWrite = false;
                        }
                    } catch (_: any) {}
                }
            }
            // Also check children for RenderMeshVisual (Text3D may put it on a child)
            const childCount = obj.getChildrenCount();
            for (let c = 0; c < childCount; c++) {
                const child = obj.getChild(c);
                const childRmv = child.getComponent('Component.RenderMeshVisual') as any;
                if (childRmv) {
                    const matCount = typeof childRmv.getMaterialsCount === 'function' ? childRmv.getMaterialsCount() : 1;
                    for (let m = 0; m < matCount; m++) {
                        try {
                            const mat = childRmv.getMaterial(m);
                            if (mat && mat.mainPass) {
                                mat.mainPass.depthTest = false;
                                mat.mainPass.depthWrite = false;
                            }
                        } catch (_: any) {}
                    }
                }
            }
        } catch (_: any) {}
    }

    // ==================== Grid Rendering ====================

    private renderPage(pageIndex: number): void {
        // Destroy old cards
        for (const card of this.activeCards) {
            card.destroy();
        }
        this.activeCards = [];
        this.currentPage = pageIndex;

        const startIdx = pageIndex * CARDS_PER_PAGE;
        const pageChars = this.allCharacters.slice(startIdx, startIdx + CARDS_PER_PAGE);

        print('[Gallery] Rendering page ' + (pageIndex + 1) + '/' + this.totalPages + ' (' + pageChars.length + ' cards)');

        // Center the grid
        const totalW = (GRID_COLS - 1) * CARD_SPACING_X;
        const totalH = (GRID_ROWS - 1) * CARD_SPACING_Y;

        for (let i = 0; i < pageChars.length; i++) {
            const agent = pageChars[i];
            const row = Math.floor(i / GRID_COLS);
            const col = i % GRID_COLS;

            // Instantiate the prefab
            const instance = this.cardPrefab.instantiate(this.gridContainer!);

            // Position in grid (centered)
            const x = col * CARD_SPACING_X - totalW / 2;
            const y = -row * CARD_SPACING_Y + totalH / 2;
            instance.getTransform().setLocalPosition(new vec3(x, y, 0));

            // Wrap in CharacterCard (binds tap handler + updates label)
            const card = new CharacterCard(
                instance,
                agent,
                (selectedAgent: AgentResponse) => this.onCardSelect(selectedAgent)
            );

            this.activeCards.push(card);
        }

        this.updateNav();
    }

    // ==================== Navigation ====================

    private buildNavigation(): void {
        const prefab = this.navPrefab || this.cardPrefab;

        // Parent nav to galleryRoot so it shows/hides with the gallery
        // @ts-ignore
        const navContainer = global.scene.createSceneObject('NavContainer');
        navContainer.setParent(this.galleryRoot!);
        // Position below the grid: 3 rows * 4cm spacing = 8cm total, cards span +4 to -4, so -7 clears bottom
        navContainer.getTransform().setLocalPosition(new vec3(0, -7, 0));

        // Prev button — tight spacing near center
        this.prevBtnInstance = prefab.instantiate(navContainer);
        this.prevBtnInstance.getTransform().setLocalPosition(new vec3(-5, 0, 0));
        this.prevBtnInstance.getTransform().setLocalScale(new vec3(0.5, 0.5, 0.5));
        this.setTextOnPrefab(this.prevBtnInstance, '< Prev');
        this.bindPrefabTap(this.prevBtnInstance, () => {
            if (this.currentPage > 0) this.renderPage(this.currentPage - 1);
        });

        // Page indicator
        // @ts-ignore
        this.pageIndicatorObj = global.scene.createSceneObject('PageIndicator');
        this.pageIndicatorObj.setParent(navContainer);
        try {
            this.pageIndicator = this.pageIndicatorObj.createComponent('Component.Text3D') as any;
            this.pageIndicator.text = '1 / 1';
            try {
                this.pageIndicator.size = 1.5;
                this.pageIndicator.horizontalAlignment = 1;
            } catch (_: any) {}
        } catch (e: any) {
            print('[Gallery] Page indicator Text3D failed: ' + (e.message || e));
        }

        // Next button
        this.nextBtnInstance = prefab.instantiate(navContainer);
        this.nextBtnInstance.getTransform().setLocalPosition(new vec3(5, 0, 0));
        this.nextBtnInstance.getTransform().setLocalScale(new vec3(0.5, 0.5, 0.5));
        this.setTextOnPrefab(this.nextBtnInstance, 'Next >');
        this.bindPrefabTap(this.nextBtnInstance, () => {
            if (this.currentPage < this.totalPages - 1) this.renderPage(this.currentPage + 1);
        });
    }

    private updateNav(): void {
        if (this.pageIndicator) {
            this.pageIndicator.text = (this.currentPage + 1) + ' / ' + this.totalPages;
        }
        if (this.prevBtnInstance) this.prevBtnInstance.enabled = this.currentPage > 0;
        if (this.nextBtnInstance) this.nextBtnInstance.enabled = this.currentPage < this.totalPages - 1;

        // Hide nav entirely if only 1 page
        const showNav = this.totalPages > 1;
        if (this.prevBtnInstance) this.prevBtnInstance.getParent().enabled = showNav;
    }

    // ==================== Prefab Helpers ====================

    /**
     * Find and update any Text/Text3D component in a prefab instance.
     */
    private setTextOnPrefab(obj: SceneObject, text: string): void {
        if (!this.findAndSetText(obj, text)) {
            print('[Gallery] WARNING: No text component found on prefab for "' + text + '"');
        }
    }

    /**
     * Bind a tap callback to a prefab instance via duck-typing.
     */
    private bindPrefabTap(obj: SceneObject, callback: () => void): void {
        const scripts = obj.getComponents('Component.ScriptComponent') as any[];
        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            // UIKit buttons: onTriggerUp (from Element.ts base class)
            if (sc && sc.onTriggerUp && sc.onTriggerUp.add) { sc.onTriggerUp.add(callback); return; }
            // SIK PinchButton
            if (sc && sc.onButtonPinched) { sc.onButtonPinched.add(callback); return; }
        }
        print('[Gallery] WARNING: No tap handler found on prefab');
    }

    // ==================== Card Selection ====================

    private onCardSelect(agent: AgentResponse): void {
        print('[Gallery] ===== SELECTED: "' + agent.name + '" =====');

        if (!this.voiceManager) return;

        // Skip if same character already active
        if (this.voiceManager.getCurrentAgentId() === agent.id) {
            print('[Gallery] Already active — ignoring');
            return;
        }

        // Deactivate current character (voice + model) before switching
        this.voiceManager.destroyCurrentModel();
        this.voiceManager.switchCharacter(agent.id, agent.name);

        // Hide gallery after selection to prevent double-taps
        this.galleryVisible = false;
        if (this.galleryRoot) {
            this.galleryRoot.enabled = false;
        }
        print('[Gallery] Gallery hidden after selection');

        // Attempt GLB (best-effort)
        if (this.httpClient && this.defaultMaterial) {
            // @ts-ignore
            const modelParent = global.scene.createSceneObject('CharModel_' + agent.name);
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
            // Scale down the model (GLBs from Tripo tend to be large)
            modelParent.getTransform().setLocalScale(new vec3(0.3, 0.3, 0.3));

            this.voiceManager.attemptGlbSpawn(
                this.httpClient, agent, modelParent, this.defaultMaterial
            );
        }
    }

    // ==================== Helpers ====================

    private buildHttpConfig(creds: EstuaryCredentials): EstuaryConfig {
        let serverUrl = creds.serverUrl || SERVER_URL;
        if (serverUrl.startsWith('wss://')) serverUrl = 'https://' + serverUrl.substring(6);
        else if (serverUrl.startsWith('ws://')) serverUrl = 'http://' + serverUrl.substring(5);

        return {
            serverUrl,
            apiKey: (creds.apiKey || '').trim(),
            characterId: '',
            playerId: creds.userId || PLAYER_ID,
            debugLogging: true,
        };
    }
}
