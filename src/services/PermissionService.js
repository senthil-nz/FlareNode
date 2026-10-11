import { Platform, PermissionsAndroid } from 'react-native';
import * as Location from 'expo-location';

/**
 * PermissionService handles runtime permissions for location and
 * P2P Mesh networking (Bluetooth and Wi-Fi Direct).
 */
export const PermissionService = {
  async requestMeshPermissions() {
    try {
      if (Platform.OS === 'android') {
        // Location is only used to place dead zones at the phone's real
        // position; the mesh itself does not need it (BLE scanning is declared
        // neverForLocation). Asked once, with no follow-up if it is declined.
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);

        // Request Bluetooth / Nearby Devices permissions
        const bluetoothPermissions = [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        ];

        if (Platform.Version >= 33) {
          bluetoothPermissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);
        }

        const granted = await PermissionsAndroid.requestMultiple(bluetoothPermissions);
        const btGranted = Object.values(granted).every(
          res => res === PermissionsAndroid.RESULTS.GRANTED
        );

        return btGranted;
      } else {
        const { status } = await Location.requestForegroundPermissionsAsync();
        return status === 'granted';
      }
    } catch (err) {
      console.error('Permission request failed:', err);
      return false;
    }
  },

  async getCurrentLocation() {
    try {
      if (Platform.OS === 'android') {
        const hasFine = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        const hasCoarse = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION
        );

        // Not requested here: this runs on a timer and must not prompt
        if (!hasFine && !hasCoarse) {
          return null;
        }
      } else {
        let { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted' && canAskAgain) {
          const req = await Location.requestForegroundPermissionsAsync();
          status = req.status;
        }
        if (status !== 'granted') {
          return null;
        }
      }

      let location = await Location.getLastKnownPositionAsync({});
      if (!location) {
        location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
      }
      return location;
    } catch (err) {
      console.error('Failed to get current location:', err?.message || err);
      return null;
    }
  }
};
