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

        // Start hidden until we get a valid palm position
        this.getSceneObject().enabled = false;
        this._isVisible = false;

        // Bind per-frame update for palm tracking
        this.createEvent('UpdateEvent').bind(() => this.onUpdate());
    }

    // ==================== Per-Frame Update ====================

    private onUpdate(): void {
        if (!this.trackedHand) {
            this.hide();
            return;
        }

        // Check if hand is tracked at all
        if (!this.trackedHand.isTracked()) {
            this.hide();
            this._hasInitialPosition = false;
            return;
        }

        // Get palm center position
        const palmCenter = this.trackedHand.getPalmCenter();
        if (!palmCenter) {
            this.hide();
            return;
        }

        // Determine visibility: either forceShow is on, or palm must face camera
        const shouldShow = this.forceShow || this.trackedHand.isFacingCamera();

        if (!shouldShow) {
            this.hide();
            return;
        }

        // Show the gallery and update position
        this.show();

        const transform = this.getSceneObject().getTransform();

        if (!this._hasInitialPosition) {
            // First frame: snap directly to palm position (no lerp from origin)
            transform.setWorldPosition(palmCenter);
            this._hasInitialPosition = true;
        } else {
            // Subsequent frames: lerp for smooth following
            const currentPos = transform.getWorldPosition();
            const smoothed = vec3.lerp(currentPos, palmCenter, this.LERP_ALPHA);
            transform.setWorldPosition(smoothed);
        }

        // Orient the gallery to face the camera
        this.faceCamera(transform, palmCenter);
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

    private show(): void {
        if (!this._isVisible) {
            this.getSceneObject().enabled = true;
            this._isVisible = true;
        }
    }

    private hide(): void {
        if (this._isVisible) {
            this.getSceneObject().enabled = false;
            this._isVisible = false;
        }
    }

    // ==================== Public API ====================

    /**
     * Returns whether the gallery is currently visible.
     */
    public isVisible(): boolean {
        return this._isVisible;
    }
}
