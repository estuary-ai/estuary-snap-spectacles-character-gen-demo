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

/** Card spacing in cm — equal in both axes */
const CARD_SPACING = 7;

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
        this.galleryRoot.getTransform().setLocalPosition(new vec3(0, 8, 0));

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

    /** Whether the gallery is currently shown */
    private galleryVisible: boolean = false;

    private buildWristToggle(): void {
        if (!this.togglePrefab) {
            print('[Gallery] No togglePrefab — wrist toggle disabled');
            return;
        }

        // Instantiate the RoundButton prefab as a child of the PalmAnchor root
        // so it tracks with the hand but sits at wrist level
        const anchorObj = this.galleryRoot!.getParent();
        this.wristToggleObj = this.togglePrefab.instantiate(anchorObj);
        // Position well below the gallery, at wrist level
        this.wristToggleObj.getTransform().setLocalPosition(new vec3(0, -5, 0));
        this.wristToggleObj.getTransform().setLocalScale(new vec3(0.7, 0.7, 0.7));

        // Set label to "Gallery"
        this.findAndSetText(this.wristToggleObj, 'Gallery');

        // Bind toggle via onValueChange (fires once with 1=on, 0=off)
        // Falls back to onTriggerUp if onValueChange isn't available
        const scripts = this.wristToggleObj.getComponents('Component.ScriptComponent') as any[];
        let bound = false;
        for (let i = 0; i < scripts.length; i++) {
            const sc = scripts[i] as any;
            if (sc && sc.onValueChange && sc.onValueChange.add) {
                sc.onValueChange.add((value: number) => {
                    this.galleryVisible = value === 1;
                    if (this.galleryRoot) {
                        this.galleryRoot.enabled = this.galleryVisible;
                    }
                    print('[Gallery] Toggle: gallery ' + (this.galleryVisible ? 'SHOWN' : 'HIDDEN'));
                });
                bound = true;
                break;
            }
        }
        if (!bound) {
            // Fallback for non-toggle buttons
            this.bindPrefabTap(this.wristToggleObj, () => {
                this.galleryVisible = !this.galleryVisible;
                if (this.galleryRoot) {
                    this.galleryRoot.enabled = this.galleryVisible;
                }
                print('[Gallery] Toggle: gallery ' + (this.galleryVisible ? 'SHOWN' : 'HIDDEN'));
            });
        }

        print('[Gallery] Wrist toggle created');
    }

    private findAndSetText(obj: SceneObject, text: string): boolean {
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
            if (this.findAndSetText(obj.getChild(i), text)) return true;
        }
        return false;
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
        const totalW = (GRID_COLS - 1) * CARD_SPACING;
        const totalH = (GRID_ROWS - 1) * CARD_SPACING;

        for (let i = 0; i < pageChars.length; i++) {
            const agent = pageChars[i];
            const row = Math.floor(i / GRID_COLS);
            const col = i % GRID_COLS;

            // Instantiate the prefab
            const instance = this.cardPrefab.instantiate(this.gridContainer!);

            // Position in grid (centered)
            const x = col * CARD_SPACING - totalW / 2;
            const y = -row * CARD_SPACING + totalH / 2;
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

        // Parent nav to the PalmAnchor root (not galleryRoot) so it sits at wrist level
        // @ts-ignore
        const navContainer = global.scene.createSceneObject('NavContainer');
        const anchorObj = this.galleryRoot!.getParent();
        navContainer.setParent(anchorObj);
        // Position near carpal — PalmAnchor adds +5 above wrist, so -4 brings it back down
        navContainer.getTransform().setLocalPosition(new vec3(0, -4, 0));

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
                const cam = this.getSceneObject().getTransform();
                const pos = cam.getWorldPosition().add(cam.forward.uniformScale(-100));
                modelParent.getTransform().setWorldPosition(pos);
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
