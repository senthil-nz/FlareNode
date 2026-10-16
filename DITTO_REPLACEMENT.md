# Replacing the Ditto SDK: Options and Effort

**Status:** stages 0 to 3 are done. From 3.0.0-rc.1 the app runs on its own mesh (`src/mesh`) over Google Nearby Connections, and the Ditto SDK, its token and its licence terms are gone. Stage 4, an open-source radio layer in place of Nearby Connections, is under way: FlareNode's own radios shipped in 3.0.0-rc.2, switched on in the Mesh Lab build only. The last version to use Ditto was 2.0.0-beta.1. Commit ids and branch names in this document refer to the project's original development repository, which is not public. The sections below the table were written before the work started and are kept as the record of why and how.
**Written:** 2026-10-05, against `@dittolive/ditto` 4.5.0. **Updated:** 2026-10-06.

## Chosen approach: staged

Google Nearby Connections first, an open-source transport later, with a fixed interface between the radio layer and everything else so the second step does not redo the first.

The reasoning: about two-thirds of the work (storage, sync rules, relaying, presence, wiring into the app) does not depend on which radio library is used. Building that on a transport that already works gets Ditto out of the app sooner, and leaves the open-source radio layer as a contained swap of one component.

| Stage | What | Effort | State |
|---|---|---|---|
| 0 | Sync core: store, versions, sync protocol, transport interface, pretend radio for tests | 2-3 days | **Done.** 17 tests pass (`npm run test:mesh`). See `src/mesh/README.md`. |
| 1 | Spike: two phones exchange a message over Nearby Connections with no network | 1-2 days | **Done (2026-10-06).** In the separate "Mesh Lab" app, a Galaxy S20 FE and S24+ found each other and exchanged notes through the real sync engine: in about 1 second over shared Wi-Fi, and in about 7 seconds over Bluetooth with Wi-Fi off on one phone. After a fix to redial dropped peers, the owner confirmed they reconnect on their own when Wi-Fi is switched off. Not yet tried: three phones in a chain, range limits, the app in the background. |
| 2 | Nearby transport behind the interface; store saved to the phone; `MeshService` with the same functions as `DittoService`; swap it in | 2-3 weeks | **Done (2026-10-07).** The Mesh Lab build ran the whole app on the new mesh on a Galaxy S20 FE and S24+: sign-in as two responders, the sealed handshake, markers filled in from the Mothership, database storage, reconnection, and signed records crossing in both directions over Bluetooth with Wi-Fi off. The S24+ log for the signed build showed two batches received, one sent, none refused and no save or send errors. A responder being refused another's marker, and an admin removing one, were seen on screen by the project owner; they are also covered by the tests. |
| 3 | Remove Ditto and its token from the app | 1-2 days | **Done (2026-10-07), as 3.0.0-rc.1.** The SDK, `DittoService`, the Ditto `.env` values and the iOS framework script are removed; the APK went from about 120 MB to 44 MB. 81 mesh tests and 18 Mothership tests pass and the release build installs. Installed over 2.0.0-beta.1 on both phones and checked by the project owner with two responders; the S20 FE log shows records crossing both ways with nothing refused. Markers from the Ditto version are not carried over. iOS has no radio layer yet. |
| 4 | Open-source transport behind the same interface, run alongside Nearby until proven | 3-6 weeks | **Started (2026-10-07).** See the steps below. |

Stage 4 in steps. Android's own Bluetooth and Wi-Fi APIs are part of the operating system, not Google Play services, so the radio layer is written on those. No existing open mesh library fits React Native well enough to adopt (see Transport options).

| Step | What | Effort | Status |
|---|---|---|---|
| 4a | Several radios at once behind the one interface (`src/mesh/multiTransport.js`) | 1-2 days | **Done (2026-10-07).** 9 tests on pretend radios. Not wired into the app yet. |
| 4b | Local network transport: phones on the same Wi-Fi network or hotspot find each other (Android's service discovery, mDNS) and sync over TCP | 3-5 days | **Working on two phones (2026-10-08):** connects, and a marker crossed over it. See the first phone run below. |
| 4c | Bluetooth Low Energy transport: phones advertise and scan to find each other, then open a Bluetooth data channel (L2CAP). No network of any kind. Android 10+ | 2-3 weeks | **Working on two phones (2026-10-08):** connects in half a second, carried markers in both directions with Wi-Fi off. One 15-minute gap in which it did not reconnect is not yet explained. Using L2CAP channels instead of hand-built packets made it far smaller than estimated. |
| 4d | Run them next to Nearby in the Mesh Lab build until proven, then remove Nearby | 1 week | In progress. The Mesh Lab build runs all three with Nearby as the fallback. |
| 4e | Wi-Fi Aware transport: direct Wi-Fi between phones with no router or hotspot, for speed. Android 10+, and only on phones that have it | 2-3 weeks | **Connects on two phones (2026-10-08).** Carrying markers by itself was reported working by the project owner; not confirmed from logs. Phones support only a few such connections at once. Wi-Fi Direct was left out: it asks the other phone's user to accept, and allows one group at a time. |

All three are in one native module, `modules/flarenode-radio` (Kotlin), and share the code that moves messages over a connection (`StreamLinks.kt`); each radio only finds phones and opens connections. On the JavaScript side they are in `src/mesh/radioTransports.js`. The native code has no automated tests; it is checked on phones.

The local network, Bluetooth data channels and (from iOS 26) Wi-Fi Aware all exist on iPhone too, so this is also the route to phone-to-phone sync on iOS. The iPhone side is not written.

### First phone run of FlareNode's own radios (2026-10-08)

Mesh Lab build `cfe4b16d` on a Galaxy S20 FE (Android 13, signed in as `alpha`) and a Galaxy S24+ (Android 16, `bravo`), both on the same Wi-Fi network with Bluetooth on. The normal app was closed on both. Times are from the S24+ log, counted from the moment its radios started; the S20 FE was already running.

| Radio | Link in the log | Connected after |
|---|---|---|
| Bluetooth Low Energy (L2CAP channel) | `bluetooth` | 0.5 s |
| Local network (mDNS and TCP) | `wifi` | 1.0 s |
| Wi-Fi Aware | `wifi-aware` | 2.3 s |
| Google Nearby Connections (the fallback) | `nearby` | 7.0 s |

What it shows:

- All three radios started on both phones and connected at the first attempt, with no errors, failed attempts or drops in the 15 seconds logged.
- The mesh listed the peer `via bluetooth` first and changed to `via wifi` half a second later when the faster link came up, without the peer leaving the list. That is `MultiTransport` choosing the preferred radio on real phones.
- All three were up before Nearby had finished connecting.
- Started alone on the S20 FE with Wi-Fi off, Bluetooth and the local network started and Wi-Fi Aware reported itself unavailable and kept retrying, as intended. It was on by the time the S24+ joined.

Later in the same session, with markers:

| Time | What happened | Seen in |
|---|---|---|
| 16:21:16 | Both phones on Wi-Fi. A marker dropped on the S24+ arrived on the S20 FE, with the peer listed `via wifi`. | S20 FE log |
| 16:21:42 | Wi-Fi switched off on the S20 FE. The local network and Wi-Fi Aware links dropped and the mesh carried on `via bluetooth`. The peer count stayed at 1 on both phones. | Both logs |
| 16:21:51 | Google Nearby dropped too, and reconnected 9 seconds later. FlareNode's Bluetooth link did not drop. | Both logs |
| 16:22:28, 16:22:34, 16:22:42 | Three markers dropped on the S24+ each arrived on the S20 FE, new, within about a second. The S20 FE's Wi-Fi was confirmed off. | S20 FE log |
| 16:28 | The Bluetooth link had been up for nine minutes without a drop. | S20 FE log |

So markers crossed over FlareNode's own Bluetooth radio with no Wi-Fi on the receiving phone. One caveat: the log names the radio in use for a peer, not the radio each message arrived on. Bluetooth was the only one of FlareNode's radios still connected and is preferred over Nearby, so the markers went over it, but Nearby was also connected in the background from 16:22:00.

Later still, Bluetooth in the other direction and an unexplained gap:

| Time | What happened | Seen in |
|---|---|---|
| 17:04:27 | The Bluetooth link dropped. The peer stayed listed, `via nearby`. | S20 FE log |
| 17:04 to 17:19 | The Bluetooth link did not come back for 15 minutes. Nearby held the connection, so nothing was lost. Not explained: the phones may have been idle or locked, and the mesh does not run properly when the app is not on screen. To be looked at. | S20 FE log |
| 17:19:39 | Bluetooth reconnected, and a marker from the S24+ arrived a second later. | S20 FE log |
| 17:19:51, 17:20:35 | Two markers dropped on the S20 FE (Wi-Fi off) with the peer listed `via bluetooth`. The project owner saw them arrive on the S24+. The S24+ log could not be read, as that phone was off Wi-Fi and not on USB. | S20 FE log, project owner |
| 17:20:26 | Both links to the S24+ dropped together and Bluetooth was back 6 seconds later, consistent with the app restarting or being reopened on the S24+. | S20 FE log |

So markers have now crossed over Bluetooth in both directions.

Fault found: Wi-Fi Aware logged "not available" every 10 seconds while Wi-Fi was off. Fixed to log once per change.

What it does not show:

- **Wi-Fi Aware carrying the traffic by itself** (Wi-Fi switched on but not joined to a network, on both phones). The project owner reported this working. It is not confirmed from a log: the S20 FE log read afterwards covered 16:53 onwards, showed that phone's Wi-Fi off, and had no Wi-Fi Aware activity.
- **Bluetooth with Nearby switched off altogether**, which would remove the caveat above.
- Reconnecting after going out of range, range itself, more than two phones, long sessions, and battery use.

### First run with three phones (2026-10-13)

A Galaxy A10 (Android 11, 32-bit, 1.8 GB of memory, no Wi-Fi Aware, no fingerprint sensor) joined the Galaxy S20 FE and S24+, signed in as the admin. It needs its own 32-bit build. All three in one place, in the Mesh Lab build.

Faults found within minutes, none of which two phones had shown:

| Fault | Cause | Fix |
|---|---|---|
| The new phone showed only markers added after it joined. It refused the rest: 2,112 refusals in a few minutes. | Each time a phone came online it was issued a certificate starting "now" that replaced the one before. Everything its responder had written earlier then looked as if it predated their certificate. Phones that already held those markers never noticed. | Only the end of a certificate's life is enforced. A start date protected nothing and broke whenever it moved. A first attempt, starting certificates at the account's creation date, failed because reseeding the demo accounts had reset that date. |
| The same refused records were sent again about every 20 seconds, for as long as the phones were in range. | Nothing told the sender they had been refused. | A phone says which records it declined and is not sent those exact versions again for ten minutes. |
| The A10 stopped accepting Bluetooth connections. | Its Bluetooth dropped the listening channel and nothing reopened it. | The channel is reopened and its new number advertised. |
| The Bluetooth link between the S20 FE and the A10 dropped and reconnected about every 25 seconds. | Not known. | None yet. Disconnections are now logged with their reason. |

After the fixes, on the A10 and S24+ (the S20 FE had not yet been updated to the final build): the A10 loaded what it had, took 11 records from the Mothership, connected to both other phones, and refused nothing; the project owner confirmed the markers appeared. Still to do: the 25-second Bluetooth drop, and the relay test with the end phones out of each other's range.


Rules adopted from the start so the transport can be swapped later:

- **Own the identity.** Each phone has its own mesh node id and name; a transport's temporary connection handles are never used above the transport.
- **Own the security.** Sealing and signing are both in the sync layer, so neither changes with the transport. Messages are sealed with a key shared by everyone holding the operational token; records are signed by the responder who wrote them and checked against a certificate from the Mothership.
- **Small, self-contained messages.** The engine splits anything larger than the transport allows, so low-throughput Bluetooth-only transports work.
- **Relay in the sync layer.** Each phone passes on records it did not already have. That gives multi-hop on any transport and avoids relying on one transport's connection limits.
- **Versioned protocol.** A peer on a different protocol version is ignored rather than misread.

Limits of the staged route:

- Until stage 4, the app depends on Google Play services and is not fully open source.
- A phone on Nearby and a phone on the open transport cannot see each other unless a build runs both at once.
- Nearby hides problems the open transport will have to solve itself (reconnection, Bluetooth-to-Wi-Fi upgrade, pairing quirks), so stage 4 is still the hard part. It is isolated, not removed.
- Total effort is not lower. The gain is a working Ditto-free app after stage 3 and less risk in stage 4.

The sections below are the original assessment.

## Why consider it

- Ditto is proprietary (Ditto Binary License), and every APK built from this project ships it. See the licensing section of the README.
- The app uses a Ditto development token, which is compiled into the APK and gives full access to the database.
- Version 4.5.0 of the React Native SDK is an early release with gaps the app works around: no transactions, no DQL writes, no real deletes, no offline identity.

An alternative to replacing it is upgrading to the latest Ditto 4.x (1–2 days), which fixes the third point but not the first two.

## What Ditto does for FlareNode today

| Job | How the app uses it |
|---|---|
| Discovery | Finds nearby phones over Bluetooth LE and the local network |
| Transport | Connects phones and moves data between them |
| Sync and conflict handling | Merges markers, dead zones and the quake feed across phones |
| Presence | Reports connected peers, used for the peer count, joined/left notices and dead-zone detection |
| Local storage | Holds the on-device copy of all collections |
| Cloud relay | Syncs through Ditto's cloud when phones have internet |

A replacement has to cover the first five. The Mothership sync already covers the same need as the cloud relay.

## What makes it manageable

- All Ditto calls go through `src/services/DittoService.js` (about 400 lines, around 20 functions). No screen or hook touches Ditto directly, so a replacement can sit behind the same functions.
- The data is small and simple: `tactical_markers`, `connectivity_logs` and the quake feed.
- Removals are already soft deletes (a `deleted` flag), which is what a simple sync protocol needs anyway.
- The Mothership already implements "newest wins, removals remembered" for markers.

## Work breakdown

| Piece | Effort | Notes |
|---|---|---|
| Spike: two phones find each other and exchange data with no network | 1–2 days | Do this first. It decides whether the rest of the estimate holds. |
| Local storage (SQLite on the phone) | 1–2 days | Replaces Ditto's on-device database. |
| Sync logic: exchange records, newest wins, removals remembered | 2–4 days | Each phone passing on everything it holds also gives multi-hop relay. |
| Transport: discovery and connections over Bluetooth and Wi-Fi | 1–4 weeks | The hard and uncertain part. Depends on the option chosen below. |
| Swap in behind `DittoService`: presence, peer notices, dead-zone logic | 2–3 days | Keep the existing function names so screens do not change. |
| Field testing with two and three phones, fixes | 3–5 days | Background behaviour and Android permission quirks usually surface here. |

## Transport options

| Option | Total effort | For | Against |
|---|---|---|---|
| **A. Google Nearby Connections** | 2–3 weeks | Free, built into Android, handles Bluetooth and Wi-Fi Direct | Not open source. Android only. React Native wrappers are patchy, so it may need a small native module. |
| **B. Own Bluetooth and Wi-Fi layer** | 4–8 weeks | No third-party dependency, fully open source | Rebuilds the hardest part of Ditto. High risk. |
| **C. Existing open mesh stack** (Briar's Bramble, Berty's Wesh, libp2p) | 4+ weeks, uncertain | Proven mesh technology, open source | React Native integration is immature. Needs its own spike before any estimate can be trusted. |

**Suggested choice:** A if the driver is licence cost or the proprietary dependency. B or C only if the project must be fully open source.

## What would be lost

- Ditto's cloud relay between phones that have internet but are not near each other. The Mothership would need to push markers back down to phones to replace this; today it only receives them.
- An easier path to iOS. Option A is Android only.
- Ditto's conflict handling for concurrent edits to the same record. "Newest wins" is enough for the current data, where records are created and removed but rarely edited.

## Risks

- Bluetooth and Wi-Fi Direct behave differently across phone models and Android versions.
- Android restricts background radio use; syncing with the screen off may not be possible without a foreground service.
- Clock differences between phones affect "newest wins". A logical counter per record avoids this.
- Existing data on phones lives in Ditto's store and would need a one-off migration, or be re-entered.

## Open questions before starting

1. What is driving the replacement: licence cost, the proprietary dependency, or a requirement that the project be fully open source?
2. Is iOS a target?
3. Must phones sync with the screen off or the app in the background?
4. How many phones should a mesh support, and over how many hops?

## Caveat on the estimates

These figures come from knowledge of this codebase, not from having built any of these transports in this project. The 1–2 day spike is what would firm them up.
