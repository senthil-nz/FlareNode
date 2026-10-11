# FlareNode: Technical Gap Analysis & Roadmap

## 🚩 Overview
This document tracks the delta between the "Competition Vision" (the high-impact claims made in the proposal) and the "Current Implementation." It serves as a priority list for final polishing to ensure the project's operational readiness.

## 📉 Gap Analysis

### 1. UX/UI for High-Stress Environments
- **The Claim:** "Zero-Friction Engagement," "Saliency-Based Alerts," and "Low-Symmetry Interaction."
- **Current Status:** Done. Emergency Mode darkens the map and enlarges markers; a new hazard from another responder raises a full-screen alert with vibration.
- **The Gap:** Alert sound; field testing in poor light.
- **Priority:** 🔴 High (Visual impact is key for demos).

### 2. Edge-Derived Intelligence (Connectivity Mapping)
- **The Claim:** Using mesh metadata to la identify "connectivity dead-zones."
- **Current Status:** Done. Dead zones are logged at the phone's GPS position when it loses the mesh, drawn on the phone map, synced to the Mothership dashboard and exportable as GeoJSON.
- **The Gap:** Field testing over a real area.
- **Priority:** 🟡 Medium (High-innovation value, but not a core rescue function).

### 3. Adaptive Resource Management (Battery Opt.)
- **The Claim:** Adaptive polling intervals based on movement speed and urgency.
- **Current Status:** Standard SDK polling intervals.
- **The Gap:** No logic linking device accelerometer/GPS speed to the synchronization frequency.
- **Priority:** 🟢 Low (Technical detail, less visible in a demo).

---

## 🛠️ "Quick Win" Implementation Path
If time permits, implement these three specific tasks to bridge the gap:

### Task A: The "Saliency" Alert System
- **Action:** Create a simple listener for new 'Hazard' markers in the `tactical_markers` collection.
- **Result:** Trigger a full-screen, high-contrast toast notification when a red marker is received via mesh.

### Task B: High-Visibility "Emergency Mode"
- **Action:** Implement a CSS/Style toggle that switches the map to a high-contrast theme and increases marker size.
- **Result:** Directly supports the "Operational Readiness" claim for poor-lighting/outdoor use.

### Task C: Dead-Zone Logging
- **Action:** Log a timestamped coordinate whenever the P2P mesh loses all peers for > 60 seconds.
- **Result:** Creates a raw dataset that can be exported as a "Connectivity Gap" GeoJSON layer, proving the "Novel Data" claim.

## 📅 Timeline Status
**Updated:** 2026-10-08
**Status:** Tasks A, B and C are implemented. Remaining work is listed under "Not done yet" in the README; the Ditto SDK has been replaced by FlareNode's own mesh (see `DITTO_REPLACEMENT.md`).

---

## 🔭 Next: reaching responders who are far apart

Phone radios reach tens of metres: roughly 30-50 m for Bluetooth and up to about 100 m for direct Wi-Fi in the open. Responders in the field will often be much further apart than that, and a chain of phones relaying for each other is too fragile to plan around. Three things follow from that, in this order. The second is a possible integration, not a commitment.

### 1. Finish the phone radios (in progress)
FlareNode's own Bluetooth, Wi-Fi Aware and local network transports are written and run in the Mesh Lab build next to Google Nearby. They have not been run on phones yet. See stage 4 in `DITTO_REPLACEMENT.md`.

Still to do: test on phones, measure the real range of each radio on the test phones, a three-phone chain test, and keeping the mesh running when the app is in the background.

### 2. Long-range broadcast over LoRa (possible integration)
**Why:** not all responders will be near each other. A hazard reported in one valley should reach a team in the next.

**What:** each team carries a small LoRa radio paired to a phone over Bluetooth. LoRa reaches about 1-5 km per hop in suburbs or bush and 10 km or more with clear line of sight, on a battery that lasts days. A few fixed relays on high ground extend it further.

**How FlareNode will use it: as a broadcaster only.** LoRa is very slow, about 1 kilobit per second in packets of roughly 200 bytes, so it will not carry the normal sync conversation.

- A new marker or a removal is sent out once as a short, signed broadcast. Receiving phones check the signature and the rules exactly as they do for any other record.
- Nothing else goes over LoRa: no comparing of what each phone holds, no catching up, no maps, no quake feed.
- Catching up stays with Bluetooth, Wi-Fi and the Mothership, when phones meet or get a connection. A broadcast that is missed is picked up then.

**Work needed (roughly 2-4 weeks, plus hardware):**
- A compact binary form of a signed record that fits in one or two LoRa packets. Today's records are several hundred bytes of JSON.
- A way for a phone to check a broadcast from a responder it has never met. Certificates are too large to send with every broadcast, so phones will need to already hold them (from the Mothership or an earlier meeting) or the certificate must be sent separately and rarely.
- A broadcast-only path in the mesh, next to the two-way transports, with a limit on how often a phone transmits so the shared airtime is not used up.
- A transport that talks to the LoRa radio over Bluetooth. The likely route is Meshtastic, open-source firmware for these radios that already relays between nodes.
- Deciding which records are worth the airtime: hazards first, probably not every marker.

**Open questions:**
- Meshtastic's firmware is GPL. Using it as a separate device the app talks to should be compatible with FlareNode's code, but this needs checking before it is relied on.
- Which radio band and settings to use. In New Zealand the licence-free band is 915-928 MHz; boards must be the 915 MHz version.
- Real range in the terrain FlareNode is meant for. To be measured, not assumed.

**Hardware to start:** two LoRa boards (for example Heltec LoRa 32 V3 or LilyGO T-Beam, roughly US$20-45 each; prices not checked recently).

**Status:** under consideration. There is no LoRa hardware to develop or test against yet, so nothing has been built or tried. It would start after the phone radios in step 1 are proven on phones.

### 3. iPhone (not started)
The local network, Bluetooth data channels and, from iOS 26, Wi-Fi Aware exist on iPhone, so FlareNode's own radios are the route to phone-to-phone sync there. The iPhone side is not written, and the app has never been run on iOS.
