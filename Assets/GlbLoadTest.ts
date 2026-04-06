/**
 * GlbLoadTest - Exact copy of Snap's DownloadGltfExample pattern.
 *
 * Mirrors https://developers.snap.com/spectacles/about-spectacles-features/apis/internet-access
 * as closely as possible to isolate why tryInstantiateAsync fails.
 */

@component
export class GlbLoadTest extends BaseScriptComponent {

    @input
    material: Material;

    @input
    @allowUndefined
    cameraObject: SceneObject;

    @input
    @allowUndefined
    glbUrl: string;

    // Class-level module initialization (matching Snap's example exactly)
    // @ts-ignore
    private internetModule: InternetModule = require('LensStudio:InternetModule');
    // @ts-ignore
    private remoteMediaModule: RemoteMediaModule = require('LensStudio:RemoteMediaModule');

    onAwake() {
        // Public Khronos sample GLB — no ngrok, no auth, pure HTTPS
        const url = this.glbUrl || 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/BoxTextured/glTF-Binary/BoxTextured.glb';

        print('[GlbLoadTest] URL: ' + url);
        print('[GlbLoadTest] material: ' + (this.material ? 'SET' : 'NULL'));
        print('[GlbLoadTest] sceneObject: ' + this.sceneObject.name);

        let resource: DynamicResource = this.internetModule.makeResourceFromUrl(url);
        print('[GlbLoadTest] Resource created');

        this.remoteMediaModule.loadResourceAsGltfAsset(
            resource,
            (gltfAsset: GltfAsset) => {
                print('[GlbLoadTest] GltfAsset loaded');

                // @ts-ignore
                let gltfSettings = GltfSettings.create();
                gltfSettings.convertMetersToCentimeters = true;

                gltfAsset.tryInstantiateAsync(
                    this.sceneObject,
                    this.material,
                    (sceneObj: SceneObject) => {
                        print('[GlbLoadTest] ===== SUCCESS =====');
                        print('[GlbLoadTest] SceneObject: ' + sceneObj.name);

                        // Position in front of camera
                        if (this.cameraObject) {
                            const camPos = this.cameraObject.getTransform().getWorldPosition();
                            sceneObj.getTransform().setWorldPosition(
                                new vec3(camPos.x, camPos.y, camPos.z - 100)
                            );
                        }
                    },
                    (error: string) => {
                        print('[GlbLoadTest] ===== FAILED =====');
                        print('[GlbLoadTest] Error: ' + error);
                    },
                    (progress: number) => {
                        print('[GlbLoadTest] Progress: ' + Math.round(progress * 100) + '%');
                    },
                    gltfSettings
                );
            },
            (error: string) => {
                print('[GlbLoadTest] Load FAILED: ' + error);
            }
        );
    }
}
