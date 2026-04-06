/**
 * PalmAnchor - Anchors its SceneObject to the user's non-dominant (left) hand palm.
 *
 * Uses SIK hand tracking to:
 * - Position the SceneObject at the palm center with lerp smoothing
 * - Show/hide based on whether the palm is facing the camera
 * - Support a forceShow override for the wrist toggle button
 *
 * The gallery root should be a child of this component's SceneObject.
 * PalmAnchor controls the root's position and visibility.
 */

import SIK from 'SpectaclesInteractionKit.lspkg/SIK';

@component
export class PalmAnchor extends BaseScriptComponent {

    // ==================== Configuration ====================

    /** Lerp alpha for smooth position tracking (lower = smoother, higher = more responsive) */
    private readonly LERP_ALPHA: number = 0.15;

    // ==================== Public State ====================

    /**
     * When true, skip the isFacingCamera() check and always show while hand is tracked.
     * Used by the wrist toggle to keep the gallery visible regardless of palm orientation.
     */
    public forceShow: boolean = false;

    // ==================== Private State ====================

    /** Reference to the non-dominant (left) hand tracked by SIK */
    private trackedHand: any = null;

    /** Whether the gallery is currently visible */
    private _isVisible: boolean = false;

    /** Whether we have initialized position (to avoid lerping from origin on first frame) */
    private _hasInitialPosition: boolean = false;

    /** Timestamp (seconds) of last "shouldShow=true" frame, used for hide hysteresis */
    private _lastShowTime: number = 0;

    /** How long to keep gallery visible after hand tracking drops (seconds) */
    private readonly HIDE_DELAY: number = 1.0;

    // ==================== Lifecycle ====================

    onAwake(): void {
        // Get the non-dominant hand (left hand by default)
        const handInputData = SIK.HandInputData;
        this.trackedHand = handInputData.getNonDominantHand();

        if (!this.trackedHand) {
            print('[PalmAnchor] WARNING: Could not get non-dominant hand from SIK');
            return;
        }

        print('[PalmAnchor] Initialized - tracking non-dominant hand');

        // Hide children (gallery content) but keep THIS SceneObject enabled
        // so the UpdateEvent keeps firing and can detect when hand appears.
        this.setChildrenEnabled(false);
        this._isVisible = false;

        // Bind per-frame update for palm tracking
        this.createEvent('UpdateEvent').bind(() => this.onUpdate());
    }

    // ==================== Per-Frame Update ====================

    /** Frame counter for throttled debug logging */
    private _debugCounter: number = 0;

    private onUpdate(): void {
        this._debugCounter++;
        const shouldLog = false; // Debug off

        if (!this.trackedHand) {
            if (shouldLog) print('[PalmAnchor] No trackedHand reference');
            this.hide();
            return;
        }

        // Check if hand is tracked at all
        const isTracked = this.trackedHand.isTracked();
        if (!isTracked) {
            if (shouldLog) print('[PalmAnchor] Hand not tracked');
            if (!this.forceShow) {
                this.hide();
            }
            this._hasInitialPosition = false;
            return;
        }

        // Get wrist position (more stable than getPalmCenter, directly on the arm)
        let wristPos: vec3 | null = null;
        try {
            wristPos = this.trackedHand.wrist.position;
        } catch (_: any) {}

        this._lastWristPos = wristPos;

        if (!wristPos) {
            if (shouldLog) print('[PalmAnchor] wrist position unavailable');
            if (!this.forceShow) {
                this.hide();
            }
            return;
        }

        // Always show when hand is tracked (no facing-camera gate — wrist is always accessible)
        const shouldShow = true;

        if (shouldLog) {
            print('[PalmAnchor] tracked=true wrist=(' + wristPos.x.toFixed(1) + ',' + wristPos.y.toFixed(1) + ',' + wristPos.z.toFixed(1) + ')');
        }

        // @ts-ignore - Lens Studio getTime global
        const now: number = getTime();

        if (shouldShow) {
            this._lastShowTime = now;
        }

        // Hysteresis: keep showing for HIDE_DELAY seconds after hand tracking drops
        if (!shouldShow && (now - this._lastShowTime > this.HIDE_DELAY)) {
            this.hide();
            return;
        }

        // Show the gallery and update position
        this.show();

        // Offset to the right (pinky side) of the left wrist so it doesn't
        // overlap with fingers. Use hand orientation for a proper lateral offset.
        let rightOffset = new vec3(-22, 15, 0); // fallback: world-space left+up
        try {
            // Hand right vector: index knuckle to pinky knuckle direction
            const indexPos = this.trackedHand.indexKnuckle.position;
            const pinkyPos = this.trackedHand.pinkyKnuckle.position;
            if (indexPos && pinkyPos) {
                const handRight = pinkyPos.sub(indexPos).normalize();
                // 22cm to the right (pinky side), 15cm up
                rightOffset = handRight.uniformScale(22).add(new vec3(0, 15, 0));
            }
        } catch (_: any) {}
        const anchorPos = wristPos.add(rightOffset);

        const transform = this.getSceneObject().getTransform();

        if (!this._hasInitialPosition) {
            transform.setWorldPosition(anchorPos);
            this._hasInitialPosition = true;
        } else {
            const currentPos = transform.getWorldPosition();
            const smoothed = vec3.lerp(currentPos, anchorPos, this.LERP_ALPHA);
            transform.setWorldPosition(smoothed);
        }

        // Orient the gallery to face the camera
        this.faceCamera(transform, anchorPos);
    }

    // ==================== Orientation ====================

    /**
     * Orient the SceneObject to face the camera.
     * Computes a look-at rotation from the gallery position to the camera.
     */
    private faceCamera(transform: Transform, position: vec3): void {
        try {
            // Get camera position from the scene's main camera
            // @ts-ignore - Lens Studio global scene API
            const cam = global.scene.getRootObject(0).getTransform();
            const camPos = cam.getWorldPosition();

            // Compute direction from gallery to camera
            const direction = camPos.sub(position);
            if (direction.length < 0.001) return;

            // Build a rotation that faces toward the camera
            const forward = direction.normalize();
            const worldUp = new vec3(0, 1, 0);
            const right = worldUp.cross(forward).normalize();
            const up = forward.cross(right).normalize();

            // Set rotation using lookAt-style computation
            const rot = quat.lookAt(forward, up);
            transform.setWorldRotation(rot);
        } catch (e: any) {
            // Camera access may fail in some contexts - silently ignore
        }
    }

    // ==================== Visibility Helpers ====================

    /** Tracks which children were enabled before PalmAnchor hid them */
    private _childStatesBeforeHide: boolean[] = [];

    private show(): void {
        if (!this._isVisible) {
            // Restore only children that were enabled before PalmAnchor hid them.
            // Don't force-enable children that were explicitly hidden by other code
            // (e.g., CharacterGallery toggling galleryRoot off).
            const obj = this.getSceneObject();
            const count = obj.getChildrenCount();
            for (let i = 0; i < count; i++) {
                if (i < this._childStatesBeforeHide.length && this._childStatesBeforeHide[i]) {
                    obj.getChild(i).enabled = true;
                }
            }
            this._isVisible = true;
        }
    }

    private hide(): void {
        if (this._isVisible) {
            // Snapshot each child's current enabled state before hiding
            const obj = this.getSceneObject();
            const count = obj.getChildrenCount();
            this._childStatesBeforeHide = [];
            for (let i = 0; i < count; i++) {
                this._childStatesBeforeHide.push(obj.getChild(i).enabled);
            }
            this.setChildrenEnabled(false);
            this._isVisible = false;
        }
    }

    /**
     * Show/hide all children of this SceneObject without disabling
     * PalmAnchor itself (which would kill the UpdateEvent).
     */
    private setChildrenEnabled(enabled: boolean): void {
        const obj = this.getSceneObject();
        const count = obj.getChildrenCount();
        for (let i = 0; i < count; i++) {
            obj.getChild(i).enabled = enabled;
        }
    }

    // ==================== Public API ====================

    /** Last known wrist position (raw, no offset) */
    private _lastWristPos: vec3 | null = null;

    /**
     * Returns whether the gallery is currently visible.
     */
    public isVisible(): boolean {
        return this._isVisible;
    }

    /**
     * Returns the raw wrist position (no gallery offset applied).
     * Used by the toggle button to stay near the carpal.
     */
    public getWristPosition(): vec3 | null {
        return this._lastWristPos;
    }
}
