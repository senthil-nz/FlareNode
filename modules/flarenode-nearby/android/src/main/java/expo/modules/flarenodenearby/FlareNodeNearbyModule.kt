package expo.modules.flarenodenearby

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Google Nearby Connections as a FlareNode mesh transport.
 *
 * This is the only place that knows about Nearby. It does what
 * src/mesh/transport.js asks of any transport: find peers, tell JavaScript
 * when one connects or leaves, and move text messages. Everything about what
 * the messages mean lives in JavaScript.
 *
 * Every phone both advertises and discovers (the "cluster" strategy), so any
 * phone can connect to any other without one being in charge.
 *
 * Not yet handled: checking who the other phone is before accepting. Any
 * device running this service is accepted.
 */
class FlareNodeNearbyModule : Module() {
  private data class Peer(val id: String, val name: String)

  private var nodeId = ""
  private var endpointName = ""
  private var running = false

  // Nearby identifies a connection by an endpoint id that changes every
  // session. The mesh identifies a phone by its own node id. These maps
  // translate between the two.
  private val peerByEndpoint = mutableMapOf<String, Peer>()
  private val endpointByNode = mutableMapOf<String, String>()
  private val namesDuringHandshake = mutableMapOf<String, String>()
  private val dialing = mutableSetOf<String>()

  // Endpoints with a retry already scheduled. Without this, the periodic sweep
  // and the redial after a disconnect each start their own run of attempts at
  // the same phone, and the overlapping requests get in each other's way.
  private val awaitingRetry = mutableSetOf<String>()

  // Phones currently in radio range, connected or not. Nearby reports a phone
  // once when it first appears, so this is what lets us dial it again after a
  // connection drops (for example when Wi-Fi goes away and only Bluetooth is left).
  private val inRange = mutableMapOf<String, Peer>()

  // Messages that arrive before the connection has finished being set up.
  // The other phone may send the moment its side is ready, which can be just
  // before ours is; those messages are held and delivered once it is.
  private val earlyMessages = mutableMapOf<String, MutableList<String>>()

  private val mainHandler = Handler(Looper.getMainLooper())

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NEARBY_NO_CONTEXT", "The app context is not available", null)

  private val client: ConnectionsClient
    get() = Nearby.getConnectionsClient(context)

  override fun definition() = ModuleDefinition {
    Name("FlareNodeNearby")

    Events("onPeerConnected", "onPeerDisconnected", "onMessage", "onLog")

    Constants {
      mapOf(
        // Nearby allows 32 KB per message; stay a little under it
        "maxPayloadBytes" to MAX_PAYLOAD_BYTES,
        "serviceId" to SERVICE_ID,
        "packageName" to (appContext.reactContext?.packageName ?: "")
      )
    }

    AsyncFunction("start") { id: String, name: String, promise: Promise ->
      stopEverything()
      nodeId = id
      // The advertised name carries the node id, so a peer knows who this is
      // before any message is exchanged.
      endpointName = "$id$NAME_SEPARATOR${name.take(MAX_NAME_LENGTH)}"

      val advertising = AdvertisingOptions.Builder().setStrategy(STRATEGY).build()
      val discovery = DiscoveryOptions.Builder().setStrategy(STRATEGY).build()

      client.startAdvertising(endpointName, SERVICE_ID, connectionCallback, advertising)
        .addOnSuccessListener {
          client.startDiscovery(SERVICE_ID, discoveryCallback, discovery)
            .addOnSuccessListener {
              running = true
              log("advertising and discovering as $endpointName")
              mainHandler.postDelayed(reconnectSweep, SWEEP_INTERVAL_MS)
              promise.resolve(null)
            }
            .addOnFailureListener { error ->
              client.stopAdvertising()
              promise.reject("ERR_NEARBY_DISCOVERY", error.message ?: "Could not start discovery", error)
            }
        }
        .addOnFailureListener { error ->
          promise.reject("ERR_NEARBY_ADVERTISING", error.message ?: "Could not start advertising", error)
        }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("stop") {
      stopEverything()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("send") { peerId: String, text: String, promise: Promise ->
      val endpointId = endpointByNode[peerId]
      if (endpointId == null) {
        promise.reject("ERR_NEARBY_NOT_CONNECTED", "Not connected to $peerId", null)
        return@AsyncFunction
      }
      val bytes = text.toByteArray(Charsets.UTF_8)
      if (bytes.size > MAX_PAYLOAD_BYTES) {
        promise.reject("ERR_NEARBY_TOO_LARGE", "Message is ${bytes.size} bytes; the limit is $MAX_PAYLOAD_BYTES", null)
        return@AsyncFunction
      }
      client.sendPayload(endpointId, Payload.fromBytes(bytes))
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { error ->
          promise.reject("ERR_NEARBY_SEND", error.message ?: "Send failed", error)
        }
    }.runOnQueue(Queues.MAIN)

    OnDestroy {
      mainHandler.post { stopEverything() }
    }
  }

  private fun stopEverything() {
    mainHandler.removeCallbacksAndMessages(null)
    if (running || peerByEndpoint.isNotEmpty()) {
      client.stopAdvertising()
      client.stopDiscovery()
      client.stopAllEndpoints()
    }
    running = false
    val connected = peerByEndpoint.values.map { it.id }.distinct()
    peerByEndpoint.clear()
    endpointByNode.clear()
    namesDuringHandshake.clear()
    dialing.clear()
    awaitingRetry.clear()
    inRange.clear()
    earlyMessages.clear()
    connected.forEach { sendEvent("onPeerDisconnected", mapOf("id" to it)) }
  }

  private fun log(message: String) {
    sendEvent("onLog", mapOf("message" to message))
  }

  private fun parseName(raw: String): Peer {
    val separator = raw.indexOf(NAME_SEPARATOR)
    return if (separator < 0) Peer(raw, raw) else Peer(raw.substring(0, separator), raw.substring(separator + 1))
  }

  private fun dial(endpointId: String, peer: Peer, attempt: Int, isRetry: Boolean = false) {
    if (!running || endpointByNode.containsKey(peer.id)) return
    // One run of attempts per phone at a time
    if (!isRetry && awaitingRetry.contains(endpointId)) return
    if (!dialing.add(endpointId)) return
    log("connecting to ${peer.name} (attempt $attempt)")
    client.requestConnection(endpointName, endpointId, connectionCallback)
      .addOnFailureListener { error ->
        dialing.remove(endpointId)
        log("could not connect to ${peer.name}: ${error.message}")
        // Radios are busy while both phones scan, and for a while after a link
        // drops; waiting a little longer each time usually gets through.
        if (attempt < MAX_DIAL_ATTEMPTS) {
          awaitingRetry.add(endpointId)
          mainHandler.postDelayed({
            awaitingRetry.remove(endpointId)
            dial(endpointId, peer, attempt + 1, isRetry = true)
          }, RETRY_DELAY_MS * attempt)
        }
      }
  }

  /** Dials every phone in range that should be connected and is not. */
  private fun dialMissingPeers() {
    if (!running) return
    for ((endpointId, peer) in inRange.toMap()) {
      // Same rule as on discovery: the smaller node id does the dialing
      if (nodeId < peer.id && !endpointByNode.containsKey(peer.id)) dial(endpointId, peer, 1)
    }
  }

  // Catches anything the event-driven paths miss, such as a dial that used up
  // its retries while the radios were busy.
  private val reconnectSweep = object : Runnable {
    override fun run() {
      if (!running) return
      dialMissingPeers()
      mainHandler.postDelayed(this, SWEEP_INTERVAL_MS)
    }
  }

  private val discoveryCallback = object : EndpointDiscoveryCallback() {
    override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
      if (info.serviceId != SERVICE_ID) return
      val peer = parseName(info.endpointName)
      if (peer.id == nodeId) return
      // A phone that restarts its radio comes back under a new endpoint id;
      // forget the old one so it is not dialled as well.
      inRange.entries.removeAll { it.value.id == peer.id && it.key != endpointId }
      inRange[endpointId] = peer
      log("found ${peer.name}")
      // Both phones find each other at about the same time. If both asked to
      // connect, the two requests would collide, so only the phone with the
      // smaller node id asks; the other waits to be asked.
      if (nodeId < peer.id) dial(endpointId, peer, 1)
    }

    override fun onEndpointLost(endpointId: String) {
      dialing.remove(endpointId)
      awaitingRetry.remove(endpointId)
      inRange.remove(endpointId)?.let { log("${it.name} went out of range") }
    }
  }

  private val connectionCallback = object : ConnectionLifecycleCallback() {
    override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
      namesDuringHandshake[endpointId] = info.endpointName
      client.acceptConnection(endpointId, payloadCallback)
        .addOnFailureListener { error -> log("could not accept ${info.endpointName}: ${error.message}") }
    }

    override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
      dialing.remove(endpointId)
      val raw = namesDuringHandshake.remove(endpointId)
      if (!result.status.isSuccess || raw == null) {
        earlyMessages.remove(endpointId)
        log("connection failed: ${result.status.statusMessage ?: result.status.statusCode}")
        return
      }
      val peer = parseName(raw)
      // A phone that reconnects gets a new endpoint id; drop the old one quietly
      val previous = endpointByNode[peer.id]
      if (previous != null && previous != endpointId) {
        peerByEndpoint.remove(previous)
        client.disconnectFromEndpoint(previous)
      }
      peerByEndpoint[endpointId] = peer
      endpointByNode[peer.id] = endpointId
      log("connected to ${peer.name}")
      sendEvent("onPeerConnected", mapOf("id" to peer.id, "name" to peer.name, "link" to "nearby"))
      earlyMessages.remove(endpointId)?.forEach { text ->
        sendEvent("onMessage", mapOf("id" to peer.id, "text" to text))
      }
    }

    override fun onDisconnected(endpointId: String) {
      earlyMessages.remove(endpointId)
      val peer = peerByEndpoint.remove(endpointId) ?: return
      if (endpointByNode[peer.id] == endpointId) {
        endpointByNode.remove(peer.id)
        log("disconnected from ${peer.name}")
        sendEvent("onPeerDisconnected", mapOf("id" to peer.id))
        // The phone may still be reachable another way (Bluetooth after Wi-Fi
        // drops). Give the radios a moment, then try again.
        mainHandler.postDelayed({ dialMissingPeers() }, REDIAL_DELAY_MS)
      }
    }
  }

  private val payloadCallback = object : PayloadCallback() {
    override fun onPayloadReceived(endpointId: String, payload: Payload) {
      if (payload.type != Payload.Type.BYTES) return
      val bytes = payload.asBytes() ?: return
      val text = String(bytes, Charsets.UTF_8)
      val peer = peerByEndpoint[endpointId]
      if (peer == null) {
        // Not set up yet on this side: keep it for when it is
        val held = earlyMessages.getOrPut(endpointId) { mutableListOf() }
        if (held.size < MAX_EARLY_MESSAGES) held.add(text)
        return
      }
      sendEvent("onMessage", mapOf("id" to peer.id, "text" to text))
    }

    override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
      // Byte payloads arrive whole in onPayloadReceived; nothing to track
    }
  }

  companion object {
    // Phones only see each other if they advertise the same service id. It is
    // deliberately not the app's package name, so differently packaged builds
    // of FlareNode can still form one mesh.
    private const val SERVICE_ID = "nz.flarenode.mesh"
    private val STRATEGY = Strategy.P2P_CLUSTER
    private const val NAME_SEPARATOR = '|'
    private const val MAX_NAME_LENGTH = 60
    private const val MAX_PAYLOAD_BYTES = 30000
    private const val MAX_DIAL_ATTEMPTS = 4
    private const val RETRY_DELAY_MS = 2000L
    private const val REDIAL_DELAY_MS = 1500L
    private const val SWEEP_INTERVAL_MS = 8000L
    private const val MAX_EARLY_MESSAGES = 64
  }
}
