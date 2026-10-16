# FlareNode mesh

FlareNode's phone-to-phone sync. It replaced the Ditto SDK in 3.0.0-rc.1, and is built so the radio layer can be swapped.

**Status:** this is what the app runs on. It was checked on a Galaxy S20 FE and S24+ on 2026-10-07 in the Mesh Lab build: two signed-in responders, the sealed handshake, markers between phones and through the Mothership, database storage, reconnection, and signed records crossing over Bluetooth with Wi-Fi off. The radio layer is Google Nearby Connections, on Android only; an open-source one is still to come.

## The idea

Replacing Ditto is two jobs of very different kinds:

| Job | Depends on the radio? | Where |
|---|---|---|
| Store records, decide which copy wins, pass records between phones, track who is connected | No | `store.js`, `clock.js`, `syncEngine.js` |
| Find nearby phones and move bytes between them | Yes | a `Transport` |

Everything in the first row is written once. Only the second row changes when the radio library changes, which is how Google Nearby Connections can come first and an open-source transport later without redoing the rest.

```
        app (map, markers, dead zones)
                    |
              MeshService            the functions the screens call      
                    |
   +----------------+----------------+
   |                                 |
MeshStore  <------------------>  SyncEngine
records + versions            hello / digest / docs
                                     |
                               Transport            the only radio-specific part
                    +----------------+----------------+
                    |                |                |
             LoopbackTransport  NearbyTransport   open-source transport
               (tests, done)     (next)             (later)
```

## Files

| File | What it does |
|---|---|
| `clock.js` | Hybrid logical clock. Gives every write a version that orders the same way on every phone, even when phone clocks disagree. |
| `store.js` | The on-device records. Local writes merge fields and get a new version; a record from a peer replaces the stored one only if its version is higher. |
| `syncEngine.js` | The protocol. Catches two phones up when they meet, then spreads changes, including through phones in between. |
| `transport.js` | The interface a radio layer must provide. Read this first when writing a transport. |
| `loopbackTransport.js` | A pretend radio for tests, where the test decides who is in range of whom. |
| `meshService.js` | The mesh as the app sees it: `saveMarker`, `subscribeToMarkers`, `observePeers` and the rest, with the names and record shapes the app used on Ditto. |
| `sqlPersistence.js` | Saves the store in a SQLite database, one row per record, a batch per transaction. |
| `identity.js` | Per-responder signing: certificates from the Mothership, signing and checking records. |
| `policy.js` | The rules for who may write what, checked on every phone. |
| `bytes.js` | Base64, UTF-8 and the fixed JSON form signatures are made over. |
| `cipher.js` | Who may join, and privacy: derives a key from the operational token and seals every message with it. |
| `multiTransport.js` | Several radios shown to the engine as one: one peer per phone however many ways reach it, the preferred radio used first, and a fall back to the others. Used by the Mesh Lab build. |
| `radioTransports.js` | FlareNode's own radios as transports: the local network, Wi-Fi Aware and Bluetooth. Open source all the way down; the radio work is in `modules/flarenode-radio` (Kotlin). Mesh Lab build only. On 2026-10-08 all three connected between two phones, and markers crossed over the local network and, in both directions, over Bluetooth. Wi-Fi Aware by itself was reported working but is not confirmed from logs (see `DITTO_REPLACEMENT.md`). |
| `nearbyTransport.js` | Google Nearby Connections as a transport. Needs a phone; the radio work is in `modules/flarenode-nearby` (Kotlin). |
| `emitter.js` | Small event helper. |
| `__tests__/mesh.test.js` | The sync core's behaviour, as runnable examples. |
| `__tests__/meshService.test.js` | The app-facing behaviour: markers, removals, dead zones, the quake feed, peers, restarts. |
| `__tests__/cipher.test.js` | Sealing, and what a phone with the wrong token can and cannot do. |
| `__tests__/identity.test.js` | Signing and the rules, including phones that cheat. |
| `__tests__/lossy.test.js` | Recovery when messages are lost. |
| `__tests__/multiTransport.test.js` | Several radios at once: preferring one, losing one, falling back. |
| `__tests__/storage.test.js` | Saving, the database, cleaning up removed records, and cheap reconnects. |

These files import nothing from React Native, so they run under plain Node.

## How sync works

When two phones connect, each sends:

1. `hello` with the protocol version. A peer on a different version is ignored.
2. `summary`: a short fingerprint of each collection.
3. `digest`: for collections whose fingerprints differ, the id and version of every record it holds in them.
4. `docs`: in reply to the other's digest, the records the other is missing or holds an older copy of.

Step 2 keeps reconnecting cheap. Phones lose and regain each other often, and usually nothing changed in between. Two phones holding the same records get the same fingerprints and stop there, exchanging four small messages however many records they hold.

After that:

- a local write goes to every connected peer immediately;
- a record received from a peer is passed on to the other peers **only if it was newer** than the copy already held.

That last rule does two things. It makes the mesh multi-hop with no routing: if A reaches B and B reaches C, B passes A's records to C. And it stops records circulating forever, because a phone that already has a record does not pass it on again.

## Which copy wins

The record with the higher version wins, whole record at a time. A version is `wall-clock milliseconds : counter : node id`, so:

- a later write beats an earlier one;
- two writes in the same millisecond are ordered by the counter, then by node id, identically on every phone;
- a phone whose clock is slow still writes versions newer than anything it has seen.

Nothing is physically deleted. A removed marker is a record with `deleted: true`, as the app already does, so a phone that missed the removal cannot bring the marker back.

Known limits of this rule:

- If two people edit different fields of the same record while apart, one edit is lost. Ditto merges per field; this does not. It suits the current data, where records are created and flagged rather than edited.
- A phone with a clock set far in the future wins every conflict until others catch up to it.

## Storage

On a phone the store is a SQLite database (`expo-sqlite`), one row per record.

- A change writes only the records it touched, not the whole store.
- Records arriving together from a peer are written in one transaction: all of them land, or none.
- If the database cannot be opened, the store falls back to a single JSON file so the app still works. An earlier build kept everything in that file; its records are copied into the database the first time it is used.

`sqlPersistence.js` reaches the database through three small functions, so the same code is tested under Node's built-in SQLite and runs on expo-sqlite on a phone. On the two test phones no fallback warning was logged, so the database is assumed to be in use; the app's storage was not inspected directly.

### Cleaning up removed records

A removed marker leaves a flagged record behind (a tombstone), which is what stops a phone that missed the removal from bringing the marker back. Left alone these pile up for ever, so the store tidies them each time the app opens:

- after a day, a tombstone is trimmed to who removed it and when;
- after 90 days, it is dropped.

Dropping a tombstone would normally reopen the door to an old copy. So a phone also refuses records older than 90 days that it does not already hold.

The trade-off: a phone that was out of contact for more than 90 days cannot deliver its records from before that, and a phone whose clock is more than 90 days behind cannot deliver anything. The period is set in `src/services/NearbyMeshService.js`.

## Who wrote what

The mesh key in the next section says a record came from *someone holding the operational token*. It cannot say which responder. Per-responder signing adds that, so the mesh itself can enforce who may change what.

- Each phone makes its own signing key pair and keeps the private half in the device's secure storage.
- When a responder signs in, the Mothership issues a **certificate** for the public half: this key belongs to responder `alpha`, role `responder`. It signs the certificate with its own key (the "authority").
- Every record a responder writes is **signed** with their private key.
- Every phone checks every record it is offered: the signature, the certificate, and whether that responder is allowed to make that change. A record that fails is not stored and not passed on.

The rules:

| Collection | Who may do what |
|---|---|
| Markers | Add as yourself; change or remove your own. An admin may change or remove any. |
| Dead zones | Log one as yourself. Only an admin may change or clear one. |
| Anything else | Any responder with a valid certificate. |

A marker's id starts with its author's id (`alpha-1791355529521`), and a dead zone's with its reporter's. That closes a loophole: without it, someone could add a record reusing another responder's id while naming themselves as author, and overwrite the original on any phone that had not seen it yet.

What this means in practice:

- A responder cannot remove someone else's marker. The app refuses straight away, and if a modified app signs the removal anyway, every other phone refuses it. The tests include exactly that.
- Phones that have never met a responder can still check their records, because certificates travel through the mesh ahead of the records they vouch for.
- The Mothership relays records with their signatures intact, and phones check them like any others. It carries them; it cannot add, alter or remove one unnoticed.
- The first sign-in must be online, to get a certificate. After that the phone works offline until the certificate runs out (90 days); it is renewed whenever the Mothership is reachable, which is also how a change of role arrives.
- A phone with no certificate can neither write records nor be given any.

What it does not do:

- **Cancelling takes time to spread.** An admin can cancel a responder's certificate (see Cancelling below), but a phone only refuses the cancelled key once the cancellation reaches it, through the Mothership or another phone. Until then it accepts what that key signs, and drops it when the cancellation arrives. A cancelled key could also back-date what it signs to before the cancellation; those records would be accepted. Neither is solved.
- **Admins are fully trusted.** An admin can change or remove anything, and can write a marker naming someone else as author.
- **The authority key is the root of trust.** Anyone who obtains the Mothership's authority key can mint an admin certificate. It lives in the Mothership's database (or `MESH_AUTHORITY_KEY`).
- **A phone trusts the authority key it is given at sign-in**, over plain HTTP on the local network. Someone able to impersonate the Mothership at that moment could hand it a different one.
- **Signature checks cost time.** Each is a few milliseconds on a laptop and more on a phone; a first sync of hundreds of records will take noticeably longer than before. Not measured on a phone yet.
- **Refused records are offered again.** A phone holding a record the others refuse will offer it at every sync and be refused each time. Harmless, but wasteful.

### Cancelling

An admin can cancel a responder's mesh access from the dashboard ("Cancel mesh access"), for a lost or stolen phone. Removing a responder, or changing their role, does it as well, so a former admin cannot go on acting as one until their certificate runs out.

- The Mothership signs a **cancellation** naming the certificate and the moment it was cancelled. It travels through the mesh like a certificate, ahead of the records it decides on.
- Every phone refuses anything that key signs after that moment. What it signed before stays valid, so a departing responder's hazard markers do not vanish with them.
- A record a phone took before the cancellation reached it goes when the cancellation arrives.
- A cancelled key is never certified again. The responder's phone makes a new key the next time it reaches the Mothership, if they still have an account.

## Who may join, and privacy

Every phone derives the same secret key from the **operational token** (the one the app already asks for before joining the mesh), and every message is sealed with it before it leaves the sync engine.

- A phone without the token cannot read what it overhears.
- A phone without the token cannot produce a message the others accept, so it cannot add, change or remove records. It is not listed as a peer either.
- A message altered in transit is rejected.
- A message sealed for one phone is rejected if replayed to another, or bounced back at its sender.

A connected phone only counts as a peer once it has sent something that opens with the key. Phones started with different tokens form separate meshes that ignore each other.

This is in the sync layer on purpose: it does not change when the transport does, and it does not rely on the transport's own link encryption.

What it does not do:

- **It does not tell responders apart.** Everyone holding the token can read the mesh. Who may *change* what is the job of the signatures described above.
- **A short token is a weak key.** Someone who records traffic can try tokens offline. The key derivation slows that down; it does not prevent it. Use a long random token for real use. The default `OP-2026-S1` is public in this repository and protects nothing.
- **Removing someone means changing the token** on every other phone.
- **The Mesh Lab test bench is unsealed.** It is for looking at the transport, and phones running the app ignore it.

Algorithms: PBKDF2-SHA256 (token to key) and XChaCha20-Poly1305 (sealing), from the audited `@noble/hashes` and `@noble/ciphers` libraries. Random nonces come from the phone's secure random source (`expo-crypto`).

## The Mothership as a relay

The mesh has no cloud of its own, so the Mothership relays between phones that never meet when a phone can reach it. A phone uploads its markers with their versions and signatures; the Mothership keeps them whole and hands them, with the certificates needed to check them, to any phone that asks. The receiving phone runs them through the same checks as records from another phone.

This also fills in a freshly installed phone.

Markers written before signing was introduced have no signature. The Mothership still shows them on the dashboard, but phones on the signed mesh do not take them, and a phone drops its own unsigned records the first time it starts with an identity.

## Running the tests

```
npm run test:mesh
```

90 tests, in seven files:

- **sync core (17):** version ordering, merging, two-phone catch-up, live updates, three-phone relay, reconnecting after being apart, conflicts, removals surviving a stale phone, a ring of four phones going quiet, records larger than the radio's limit, the peer list, protocol version mismatch, malformed input, and surviving a restart;
- **the app-facing service (10):** a marker reaching the other phone with its author, removal, ordering, the peer list, dead zones, the quake feed, switching the mesh off and on, changing the signed-in name, and surviving a restart;
- **the cipher (10)**, **storage (16)**, **lost messages (7)** and **identities and rules (21)**, each described in its section below;
- **several radios at once (9):** a phone reachable two ways counting as one peer, the preferred radio carrying the traffic, sync carrying on when one radio drops, a message lost with its radio being recovered over the other, a chain made of different radios, a radio that fails to send or to start.

They all run on the pretend radio.

## What is not done

- **Testing further.** Still to try: three phones in a chain, phones moving out of range and back, larger amounts of data over Bluetooth, and the app in the background.
- **iOS.** Nearby Connections is built in for Android only, so an iPhone has no radio layer and would sync only through the Mothership.
- **Faster reconnection.** After Wi-Fi was switched off the phones took about 27 seconds and several failed attempts to find each other again over Bluetooth. Overlapping attempts have since been removed, which should help; it has not been re-measured.
- **Spreading a cancellation faster** than ordinary sync, and refusing back-dated records from a cancelled key.
- **Very large stores.** Everything is held in memory, and when two phones differ in a collection they list every record in it. Fine for thousands of records; tens of thousands would want something smarter.
- **Moving existing data.** Markers from the Ditto build are not signed, so they do not carry over to the signed mesh at all. The move off Ditto started with an empty map.

## Writing a transport

Implement the five things in `transport.js`. The rules that matter:

- Report peers by their own mesh node id, not by a connection handle that changes each session.
- `send` delivers a whole message or rejects; never part of one.
- Messages to one peer arrive in the order sent.
- State the true `maxPayloadBytes`. The engine splits anything larger.

Then run the same scenarios as the tests with two real phones.

## Mesh Lab: trying it on phones

The Mesh Lab is a second build of the app that installs next to FlareNode under its own app id and does not touch its data. It is the same app with a test bench added, and is the place to try a change to the mesh without replacing the app on the phone.

```
scriptsuild-mesh-lab.bat
```

builds it and installs it on every connected phone.

The Mesh Lab build also runs FlareNode's own radios next to Nearby, and uses them in preference, fastest first:

| Link in the log | Radio | Works when |
|---|---|---|
| `wifi` | Local network | Both phones are on the same Wi-Fi network, or one is on the other's hotspot |
| `wifi-aware` | Wi-Fi Aware | Both phones have Wi-Fi Aware and Wi-Fi switched on; no network needed |
| `bluetooth` | Bluetooth Low Energy | Both phones have Bluetooth on (Android 10 or later) |
| `nearby` | Google Nearby Connections | The fallback, as in the normal build |

A radio that cannot start on a phone is left out and logged.

Both builds run the same mesh, so with the same operational token a phone on the normal build and a phone on the Mesh Lab build do connect and share markers. Sign in as a different responder in each. The transport is chosen in `src/services/MeshBackend.js`; the rest of the app imports that file and does not know which radio it has.

The login screen of the Mesh Lab build has a link to the **mesh test bench**: a bare screen that starts the mesh, lists connected phones, sends notes and shows the radio log. Use it to look at the transport on its own. Open it before signing in, since the app starts its own mesh afterwards.
