package expo.modules.flarenoderadio

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareNetworkInfo
import android.net.wifi.aware.WifiAwareNetworkSpecifier
import android.net.wifi.aware.WifiAwareSession
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.ServerSocket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Wi-Fi Aware as a FlareNode mesh transport.
 *
 * Wi-Fi Aware lets phones find each other and open a fast Wi-Fi connection
 * directly, with no router, hotspot or internet. Wi-Fi must be switched on,
 * but need not be connected to anything. Nothing here depends on Google Play
 * services. Not every phone has it; `start` fails on one that does not.
 *
 * - Finding each other: every phone publishes FlareNode's service, carrying
 *   its node id, and subscribes to it.
 * - Agreeing to connect: of two phones, the one with the smaller node id asks
 *   ("ask|<id>"). The other opens a port, offers a Wi-Fi Aware network on
 *   it, and answers ("ready|<id>"). The asker then joins that network.
 * - Talking: a TCP connection over that network. From there it is the same
 *   as the local network: see StreamLinks.
 *
 * The network needs a passphrase to carry a port number; it is fixed and not
 * a secret. The mesh above seals and signs what it sends.
 *
 * Needs Android 10 or later. Phones support only a few of these connections
 * at once (often one or two), so this suits a handful of phones, not a crowd.
 */
@SuppressLint("MissingPermission")
class FlareNodeAwareModule : Module() {
  private val links = StreamLinks("wifi-aware", "wifi aware") { name, body -> sendEvent(name, body) }

  private val lock = Any()
  private val handler = Handler(Looper.getMainLooper())
  private var nodeId = ""
  private var manager: WifiAwareManager? = null
  private var connectivity: ConnectivityManager? = null
  private var session: WifiAwareSession? = null
  private var attaching = false
  // So "not available" is logged when it becomes so, not on every sweep
  private var saidUnavailable = false
  private var publishing: PublishDiscoverySession? = null
  private var subscribing: SubscribeDiscoverySession? = null
  private var io: ExecutorService? = null
  private var timer: ScheduledExecutorService? = null
  private var nextMessageId = 1

  // Phones found publishing, by node id, with the handle used to reach them
  private val found = mutableMapOf<String, PeerHandle>()
  // When each phone may next be asked, so one that does not answer is not hammered
  private val nextAsk = mutableMapOf<String, Long>()
  private val networks = mutableSetOf<ConnectivityManager.NetworkCallback>()

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_AWARE_NO_CONTEXT", "The app context is not available", null)

  override fun definition() = ModuleDefinition {
    Name("FlareNodeAware")

    Events("onPeerConnected", "onPeerDisconnected", "onMessage", "onLog")

    Constants {
      mapOf("maxPayloadBytes" to StreamLinks.MAX_PAYLOAD_BYTES, "serviceName" to SERVICE_NAME)
    }

    AsyncFunction("start") { id: String, name: String ->
      stopEverything()
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw CodedException("ERR_AWARE_TOO_OLD", "Wi-Fi Aware connections need Android 10 or later", null)
      }
      if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)) {
        throw CodedException("ERR_AWARE_NONE", "This phone does not have Wi-Fi Aware", null)
      }
      synchronized(lock) {
        nodeId = id
        manager = context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
          ?: throw CodedException("ERR_AWARE_NONE", "This phone does not have Wi-Fi Aware", null)
        connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        io = Executors.newCachedThreadPool()
        timer = Executors.newSingleThreadScheduledExecutor()
        links.start(id, name)
        timer?.scheduleWithFixedDelay({ sweep() }, SWEEP_INTERVAL_MS, SWEEP_INTERVAL_MS, TimeUnit.MILLISECONDS)
      }
      // Wi-Fi Aware comes and goes (it is off while Wi-Fi is off), so being
      // unavailable now is not a failure: the sweep attaches when it returns.
      attach()
    }

    AsyncFunction("stop") {
      stopEverything()
    }

    AsyncFunction("send") { peerId: String, text: String, promise: Promise ->
      links.send(peerId, text, promise)
    }

    OnDestroy {
      stopEverything()
    }
  }

  // ---- finding each other

  private fun attach() {
    val aware = synchronized(lock) {
      if (!links.running || session != null || attaching) return
      val current = manager ?: return
      if (!current.isAvailable) {
        if (!saidUnavailable) links.log("not available right now (is Wi-Fi switched on?)")
        saidUnavailable = true
        return
      }
      saidUnavailable = false
      attaching = true
      current
    }
    aware.attach(object : AttachCallback() {
      override fun onAttached(attached: WifiAwareSession) {
        val keep = synchronized(lock) {
          attaching = false
          if (links.running) session = attached
          links.running
        }
        if (!keep) {
          attached.close()
          return
        }
        links.log("on, publishing and subscribing as $nodeId")
        publish(attached)
        subscribe(attached)
      }

      override fun onAttachFailed() {
        synchronized(lock) { attaching = false }
        links.log("could not be switched on")
      }

      override fun onAwareSessionTerminated() {
        synchronized(lock) {
          session = null
          publishing = null
          subscribing = null
          found.clear()
        }
        links.log("went away")
      }
    }, handler)
  }

  private fun publish(aware: WifiAwareSession) {
    val config = PublishConfig.Builder()
      .setServiceName(SERVICE_NAME)
      .setServiceSpecificInfo(nodeId.toByteArray(Charsets.UTF_8))
      .build()
    aware.publish(config, object : DiscoverySessionCallback() {
      override fun onPublishStarted(started: PublishDiscoverySession) {
        synchronized(lock) { publishing = started }
      }

      override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
        val (kind, peerId) = parse(message) ?: return
        if (kind == ASK) offerNetwork(peerId, peerHandle)
      }

      override fun onSessionTerminated() {
        synchronized(lock) { publishing = null }
      }
    }, handler)
  }

  private fun subscribe(aware: WifiAwareSession) {
    val config = SubscribeConfig.Builder().setServiceName(SERVICE_NAME).build()
    aware.subscribe(config, object : DiscoverySessionCallback() {
      override fun onSubscribeStarted(started: SubscribeDiscoverySession) {
        synchronized(lock) { subscribing = started }
      }

      override fun onServiceDiscovered(peerHandle: PeerHandle, serviceSpecificInfo: ByteArray?, matchFilter: MutableList<ByteArray>?) {
        val peerId = serviceSpecificInfo?.toString(Charsets.UTF_8)?.takeIf { it.isNotEmpty() } ?: return
        synchronized(lock) {
          if (!links.running || peerId == nodeId) return
          val isNew = !found.containsKey(peerId)
          found[peerId] = peerHandle
          if (isNew) links.log("found $peerId")
        }
        askIfMine(peerId)
      }

      override fun onMessageReceived(peerHandle: PeerHandle, message: ByteArray) {
        val (kind, peerId) = parse(message) ?: return
        if (kind == READY) joinNetwork(peerId, peerHandle)
      }

      override fun onSessionTerminated() {
        synchronized(lock) {
          subscribing = null
          found.clear()
        }
      }
    }, handler)
  }

  private fun parse(message: ByteArray): Pair<String, String>? {
    val text = message.toString(Charsets.UTF_8)
    val separator = text.indexOf(StreamLinks.NAME_SEPARATOR)
    if (separator <= 0 || separator == text.length - 1) return null
    return text.substring(0, separator) to text.substring(separator + 1)
  }

  /** Of two phones, the one with the smaller node id asks to connect. */
  private fun askIfMine(peerId: String) {
    val now = SystemClock.elapsedRealtime()
    val (discovery, peerHandle, messageId) = synchronized(lock) {
      if (!links.running || nodeId >= peerId || links.isLinked(peerId)) return
      if (now < (nextAsk[peerId] ?: 0L)) return
      val current = subscribing ?: return
      val handle = found[peerId] ?: return
      nextAsk[peerId] = now + ASK_AGAIN_AFTER_MS
      Triple(current, handle, nextMessageId++)
    }
    links.log("asking $peerId to connect")
    runCatching { discovery.sendMessage(peerHandle, messageId, "$ASK${StreamLinks.NAME_SEPARATOR}$nodeId".toByteArray(Charsets.UTF_8)) }
  }

  private fun sweep() {
    attach()
    val missing = synchronized(lock) { found.keys.filter { !links.isLinked(it) } }
    missing.forEach { askIfMine(it) }
  }

  // ---- talking

  /** The asked phone's side: open a port, offer a network on it, say so. */
  private fun offerNetwork(peerId: String, peerHandle: PeerHandle) {
    val (discovery, manager, pool, messageId) = synchronized(lock) {
      if (!links.running) return
      Quad(publishing ?: return, connectivity ?: return, io ?: return, nextMessageId++)
    }
    val listening = try {
      ServerSocket(0)
    } catch (error: Exception) {
      links.log("could not open a port for $peerId (${error.message})")
      return
    }
    val specifier = WifiAwareNetworkSpecifier.Builder(discovery, peerHandle)
      .setPskPassphrase(PASSPHRASE)
      .setPort(listening.localPort)
      .build()
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onUnavailable() {
        runCatching { listening.close() }
        release(this)
      }

      override fun onLost(network: Network) = release(this)
    }
    if (!request(manager, specifier, callback)) {
      runCatching { listening.close() }
      return
    }
    pool.execute {
      try {
        listening.soTimeout = NETWORK_TIMEOUT_MS
        val socket = listening.accept()
        listening.close()
        socket.tcpNoDelay = true
        links.serve(socket.getInputStream(), socket.getOutputStream()) {
          socket.close()
          release(callback)
        }
      } catch (error: Exception) {
        links.log("$peerId asked to connect but did not (${error.message})")
        runCatching { listening.close() }
        release(callback)
      }
    }
    runCatching { discovery.sendMessage(peerHandle, messageId, "$READY${StreamLinks.NAME_SEPARATOR}$nodeId".toByteArray(Charsets.UTF_8)) }
  }

  /** The asking phone's side: join the offered network and connect to its port. */
  private fun joinNetwork(peerId: String, peerHandle: PeerHandle) {
    val (discovery, manager, pool) = synchronized(lock) {
      if (!links.running || links.isLinked(peerId)) return
      Triple(subscribing ?: return, connectivity ?: return, io ?: return)
    }
    val specifier = WifiAwareNetworkSpecifier.Builder(discovery, peerHandle).setPskPassphrase(PASSPHRASE).build()
    val callback = object : ConnectivityManager.NetworkCallback() {
      private var connected = false

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        // Called more than once; the first time with the peer's address is the one to act on
        val info = capabilities.transportInfo as? WifiAwareNetworkInfo ?: return
        val address = info.peerIpv6Addr ?: return
        if (connected || info.port <= 0) return
        connected = true
        val self = this
        pool.execute {
          try {
            val socket = network.socketFactory.createSocket(address, info.port)
            socket.tcpNoDelay = true
            links.serve(socket.getInputStream(), socket.getOutputStream()) {
              socket.close()
              release(self)
            }
          } catch (error: Exception) {
            links.log("could not connect to $peerId (${error.message})")
            release(self)
          }
        }
      }

      override fun onUnavailable() {
        links.log("no connection to $peerId was available")
        release(this)
      }

      override fun onLost(network: Network) = release(this)
    }
    request(manager, specifier, callback)
  }

  private fun request(manager: ConnectivityManager, specifier: WifiAwareNetworkSpecifier, callback: ConnectivityManager.NetworkCallback): Boolean {
    val wanted = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
      .setNetworkSpecifier(specifier)
      .build()
    return try {
      synchronized(lock) { networks.add(callback) }
      manager.requestNetwork(wanted, callback, NETWORK_TIMEOUT_MS)
      true
    } catch (error: Exception) {
      synchronized(lock) { networks.remove(callback) }
      links.log("could not ask for a connection (${error.message})")
      false
    }
  }

  private fun release(callback: ConnectivityManager.NetworkCallback) {
    val manager = synchronized(lock) { if (networks.remove(callback)) connectivity else null } ?: return
    runCatching { manager.unregisterNetworkCallback(callback) }
  }

  private fun stopEverything() {
    synchronized(lock) {
      val manager = connectivity
      networks.forEach { callback -> runCatching { manager?.unregisterNetworkCallback(callback) } }
      networks.clear()
      runCatching { publishing?.close() }
      runCatching { subscribing?.close() }
      runCatching { session?.close() }
      publishing = null
      subscribing = null
      session = null
      attaching = false
      saidUnavailable = false
      timer?.shutdownNow()
      timer = null
      io?.shutdownNow()
      io = null
      found.clear()
      nextAsk.clear()
    }
    links.stop()
  }

  private data class Quad<A, B, C, D>(val first: A, val second: B, val third: C, val fourth: D)

  companion object {
    private const val SERVICE_NAME = "flarenode-mesh"
    private const val ASK = "ask"
    private const val READY = "ready"
    // Required by Wi-Fi Aware to carry a port number. Not a secret.
    private const val PASSPHRASE = "flarenode-mesh-link"
    private const val SWEEP_INTERVAL_MS = 10000L
    private const val ASK_AGAIN_AFTER_MS = 15000L
    private const val NETWORK_TIMEOUT_MS = 20000
  }
}
