# iOS Build Reference

## Builds so far

iOS is built in the cloud with Expo's EAS Build. Three builds have been made, all with the `ios-simulator` profile, and all finished successfully.

| Build | Date | App at that point | Build time |
|---|---|---|---|
| 1 and 2 | 2026-10-05 | With the Ditto SDK (2.0.0-beta.1) | About 5 and 7 minutes |
| 3 | 2026-10-08 | After Ditto was removed (the code of 3.0.0-rc.2) | About 5 minutes |

Build 3 is the first since the Ditto SDK was removed, and shows the app still compiles and links for iOS without it.

EAS keeps build files for about two weeks, and build pages are visible only to the Expo account that made them, so no links are kept here. When a build finishes, EAS prints "Open this link on your iOS devices (or scan the QR code) to install the app". That message is shown for every internal build; for a simulator build there is nothing to install on a phone.

## What these builds are, and are not

- Each is an **iOS Simulator build**. Builds 1 and 2 are the app as it was on October 5, 2026, with the Ditto SDK; build 3 is the app without it. Each proved that version compiled and linked for iOS.
- **No phone-to-phone sync on iOS yet.** Every radio layer the mesh has (Google Nearby Connections, and FlareNode's own Bluetooth, Wi-Fi Aware and local network radios) is written for Android only. On iOS markers would travel only through the Mothership.
- It **cannot be installed on an iPhone**. Simulator builds only run in the iOS Simulator on a Mac. There is no install QR code for this kind of build.
- It has **not been run**. Nobody has opened the app on iOS yet, so nothing about how it behaves there is known: the map, the mesh, the app lock and the login are all untested on iOS.
- It was built **without the `.env` values**, so even in a simulator it would start with no Mothership address.

## To get a build that installs on an iPhone

1. Join the Apple Developer Program (about US$99 a year).
2. Register the test iPhone with EAS. This prints a link and QR code to open on the phone:
   ```
   npx.cmd eas-cli device:create
   ```
3. Give EAS the app's settings from `.env` (once per environment):
   ```
   npx.cmd eas-cli env:push --environment preview --path .env
   ```
4. Build with the `preview` profile, which uses internal (ad hoc) distribution:
   ```
   npx.cmd eas-cli build -p ios --profile preview
   ```
5. When it finishes, the build page shows an **Install** button and a QR code. Open that on the registered iPhone to install.

Each new iPhone has to be registered (step 2) and the app rebuilt before it can install.

## What made the iOS build work

- The stale `ios/` project that used to be committed was removed from git, so EAS generates the native project from `app.json`.
- `app.json` declares local network use, Bonjour (`_http-alt._tcp.`), Face ID, and local-network HTTP for the Mothership.
- `.easignore` keeps `demo/` and `mothership-server/` out of the upload. Without it the upload was 1.5 GB instead of 13 MB.

## Rebuilding the simulator build

```
npx.cmd eas-cli build -p ios --profile ios-simulator
```

No Apple Developer account is needed for this profile. Use it as a quick check that the app still compiles for iOS after dependency changes.
