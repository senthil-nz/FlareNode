package expo.modules.flarenoderadio

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * The local network as a FlareNode mesh transport.
 *
 * Phones on the same Wi-Fi network, or joined to one phone's hotspot, find
 * each other and exchange messages directly. No internet and no server is
 * involved, and nothing here depends on Google Play services: it uses only
 * what Android itself provides.
 *
 * - Finding each other: every phone announces a "_flarenode._tcp" service
 *   with Android's service discovery (mDNS, the same thing printers use) and
 *   looks for others announcing it.
 * - Talking: every phone listens on a TCP port. Of two phones, the one with
 *   the smaller node id connects to the other. What travels over the
 *   connection is described in StreamLinks.
 */
class FlareNodeLanModule : Module() {
  private val links = StreamLinks("wifi", "local network") { name, body -> sendEvent(name, body) }

  private val lock = Any()
  private var nodeId = ""
  private var server: ServerSocket? = null
  private var io: ExecutorService? = null
  private var timer: ScheduledExecutorService? = null
  private var registration: NsdManager.RegistrationListener? = null
  private var discovery: NsdManager.DiscoveryListener? = null

  // Phones announcing themselves on the network, by node id
  private val announced = mutableMapOf<String, NsdServiceInfo>()
  private val connecting = mutableSetOf<String>()
  // Android looks up one service address at a time, so requests wait in line
  private val lookups = ArrayDeque<Pair<String, NsdServiceInfo>>()
  private var lookingUp = false

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_LAN_NO_CONTEXT", "The app context is not available", null)

  private val nsd: NsdManager
    get() = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
      ?: throw CodedException("ERR_LAN_NO_NSD", "Service discovery is not available on this phone", null)

  override fun definition() = ModuleDefinition {
    Name("FlareNodeLan")

    Events("onPeerConnected", "onPeerDisconnected", "onMessage", "onLog")

    Constants {
      mapOf("maxPayloadBytes" to StreamLinks.MAX_PAYLOAD_BYTES, "serviceType" to SERVICE_TYPE)
    }

    AsyncFunction("start") { id: String, name: String ->
      stopEverything()
      synchronized(lock) {
        nodeId = id
        val manager = nsd
        val listening = ServerSocket(0)
        server = listening
        io = Executors.newCachedThreadPool()
        timer = Executors.newSingleThreadScheduledExecutor()
        links.start(id, name)
        io?.execute { acceptLoop(listening) }
        announce(manager, listening.localPort)
        discover(manager)
        timer?.scheduleWithFixedDelay({ connectToMissingPeers() }, SWEEP_INTERVAL_MS, SWEEP_INTERVAL_MS, TimeUnit.MILLISECONDS)
        links.log("listening on port ${listening.localPort} as $id")
      }
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

  private fun announce(manager: NsdManager, port: Int) {
    val info = NsdServiceInfo().apply {
      serviceName = "$NAME_PREFIX$nodeId"
      serviceType = SERVICE_TYPE
      setPort(port)
    }
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(registered: NsdServiceInfo) {}
      override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) = links.log("could not announce this phone (error $errorCode)")
      override fun onServiceUnregistered(info: NsdServiceInfo) {}
      override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
    }
    registration = listener
    manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
  }

  private fun discover(manager: NsdManager) {
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = links.log("could not look for other phones (error $errorCode)")
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}

      override fun onServiceFound(info: NsdServiceInfo) {
        val peerId = peerIdOf(info) ?: return
        synchronized(lock) {
          if (!links.running || peerId == nodeId) return
          val isNew = !announced.containsKey(peerId)
          announced[peerId] = info
          if (isNew) links.log("found $peerId")
        }
        connectIfMine(peerId)
      }

      override fun onServiceLost(info: NsdServiceInfo) {
        val peerId = peerIdOf(info) ?: return
        // The connection itself says when a phone is really gone
        synchronized(lock) { announced.remove(peerId) }
      }
    }
    discovery = listener
    manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
  }

  // Android adds " (2)" to a name it thinks is taken, so read only the id
  private fun peerIdOf(info: NsdServiceInfo): String? {
    val name = info.serviceName ?: return null
    if (!name.startsWith(NAME_PREFIX)) return null
    return name.substring(NAME_PREFIX.length).takeWhile { it.isLetterOrDigit() }.ifEmpty { null }
  }

  /** Of two phones, the one with the smaller node id connects. */
  private fun connectIfMine(peerId: String) {
    synchronized(lock) {
      if (!links.running || nodeId >= peerId) return
      if (links.isLinked(peerId) || connecting.contains(peerId)) return
      val info = announced[peerId] ?: return
      if (lookups.any { it.first == peerId }) return
      lookups.addLast(peerId to info)
    }
    nextLookup()
  }

  private fun connectToMissingPeers() {
    val missing = synchronized(lock) { announced.keys.filter { !links.isLinked(it) } }
    missing.forEach { connectIfMine(it) }
  }

  private fun nextLookup() {
    val (peerId, info) = synchronized(lock) {
      if (!links.running || lookingUp) return
      val next = lookups.removeFirstOrNull() ?: return
      lookingUp = true
      next
    }
    val done = {
      synchronized(lock) { lookingUp = false }
      nextLookup()
    }
    try {
      @Suppress("DEPRECATION")
      nsd.resolveService(info, object : NsdManager.ResolveListener {
        override fun onResolveFailed(failed: NsdServiceInfo, errorCode: Int) {
          links.log("could not get the address of $peerId (error $errorCode)")
          done()
        }

        override fun onServiceResolved(resolved: NsdServiceInfo) {
          @Suppress("DEPRECATION")
          val host = resolved.host
          val port = resolved.port
          done()
          if (host != null) dial(peerId, host, port)
        }
      })
    } catch (error: Exception) {
      links.log("could not get the address of $peerId (${error.message})")
      done()
    }
  }

  // ---- talking

  private fun dial(peerId: String, host: InetAddress, port: Int) {
    val pool = synchronized(lock) {
      if (!links.running || links.isLinked(peerId) || !connecting.add(peerId)) return
      io
    }
    if (pool == null) {
      synchronized(lock) { connecting.remove(peerId) }
      return
    }
    pool.execute {
      val socket = Socket()
      try {
        socket.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
        synchronized(lock) { connecting.remove(peerId) }
        serve(socket)
      } catch (error: Exception) {
        links.log("could not connect to $peerId (${error.message})")
        runCatching { socket.close() }
      } finally {
        synchronized(lock) { connecting.remove(peerId) }
      }
    }
  }

  private fun acceptLoop(listening: ServerSocket) {
    while (links.running && !listening.isClosed) {
      try {
        val socket = listening.accept()
        io?.execute { serve(socket) }
      } catch (error: Exception) {
        if (links.running && !listening.isClosed) links.log("stopped accepting connections (${error.message})")
        return
      }
    }
  }

  private fun serve(socket: Socket) {
    try {
      socket.tcpNoDelay = true
      links.serve(socket.getInputStream(), socket.getOutputStream()) { socket.close() }
    } catch (error: Exception) {
      runCatching { socket.close() }
    }
  }

  private fun stopEverything() {
    synchronized(lock) {
      registration?.let { listener -> runCatching { nsd.unregisterService(listener) } }
      discovery?.let { listener -> runCatching { nsd.stopServiceDiscovery(listener) } }
      registration = null
      discovery = null
      runCatching { server?.close() }
      server = null
      timer?.shutdownNow()
      timer = null
      io?.shutdownNow()
      io = null
      announced.clear()
      connecting.clear()
      lookups.clear()
      lookingUp = false
    }
    links.stop()
  }

  companion object {
    private const val SERVICE_TYPE = "_flarenode._tcp."
    private const val NAME_PREFIX = "fn-"
    private const val CONNECT_TIMEOUT_MS = 4000
    private const val SWEEP_INTERVAL_MS = 8000L
  }
}
