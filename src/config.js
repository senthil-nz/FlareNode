// Values come from the git-ignored .env file (see .env.example). Expo inlines
// EXPO_PUBLIC_* variables at build time, so each must be referenced literally.

// Mothership server (LAN address of the machine running mothership-server)
export const MOTHERSHIP_URL = process.env.EXPO_PUBLIC_MOTHERSHIP_URL;
