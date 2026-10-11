import NearbyMeshService from './NearbyMeshService';
import { NearbyNative } from '../../modules/flarenode-nearby';

/**
 * The mesh the app runs on: FlareNode's own sync engine (src/mesh) over
 * Google Nearby Connections. The rest of the app imports this file, so a
 * different transport can be swapped in here without touching the screens.
 */
export default NearbyMeshService;

// The "Mesh Lab" build (app id ending in .meshlab) installs next to the normal
// app and adds a raw test bench for the mesh. See scripts/build-mesh-lab.bat.
export const IS_MESH_LAB_BUILD = !!NearbyNative?.packageName?.endsWith('.meshlab');
