import { requireOptionalNativeModule, EventEmitter } from 'expo-modules-core';

/**
 * Thin JavaScript handles on FlareNode's own radios: the local network,
 * Wi-Fi Aware and Bluetooth. Each is null where the module is not built in
 * (iOS, or an older Android build), so callers must check before use.
 */
const handle = (name) => {
  const native = requireOptionalNativeModule(name);
  return { native, events: native ? new EventEmitter(native) : null };
};

export const Lan = handle('FlareNodeLan');
export const Aware = handle('FlareNodeAware');
export const Bluetooth = handle('FlareNodeBluetooth');
