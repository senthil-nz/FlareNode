import { requireOptionalNativeModule, EventEmitter } from 'expo-modules-core';

/**
 * Thin JavaScript handle on the native Nearby Connections module.
 * `NearbyNative` is null where the module is not built in (iOS, or an older
 * Android build), so callers must check before use.
 */
export const NearbyNative = requireOptionalNativeModule('FlareNodeNearby');
export const nearbyEvents = NearbyNative ? new EventEmitter(NearbyNative) : null;
