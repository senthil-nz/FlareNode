package expo.modules.flarenoderadio

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.ParcelUuid
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Bluetooth as a FlareNode mesh transport.
 *
 * Phones in Bluetooth range find each other and exchange messages with no
 * network of any kind. Nothing here depends on Google Play services: it uses
 * only the Bluetooth Low Energy support Android itself provides.
 *
 * - Finding each other: every phone advertises FlareNode's service, with its
 *   node id and the number of the channel it is listening on, and scans for
 *   other phones advertising it.
 * - Talking: every phone listens on a Bluetooth data channel (L2CAP, part of
 *   Bluetooth Low Energy since Android 10, and available on iPhones too). Of
 *   two phones, the one with the smaller node id connects to the other. A
 *   channel is a two-way stream, so from there it is the same as the local
 *   network: see StreamLinks.
 *
 * The channels are not paired or encrypted by Bluetooth. The mesh above seals
 * and signs what it sends.
 *
 * Needs Android 10 or later and the Bluetooth permissions the app asks for.
 */
@SuppressLint("MissingPermission")
class FlareNodeBluetoothModule : Module() {
  private class Sighting(val device: BluetoothDevice, val channel: Int, val seenAt: Long)

  private val links = StreamLinks("bluetooth", "bluetooth") { name, body -> sendEvent(name, body) }

  private val lock = Any()
  private var nodeId = ""
  private var adapter: BluetoothAdapter? = null
  private var server: BluetoothServerSocket? = null
  private var io: ExecutorService? = null
  private var timer: ScheduledExecutorService? = null
  private var advertising: AdvertiseCallback? = null
  private var scanning: ScanCallback? = null

  // Phones heard advertising, by node id
  private val sightings = mutableMapOf<String, Sighting>()
  private val connecting = mutableSetOf<String>()
  // When each phone may next be tried, so a phone that cannot be reached is not hammered
  private val nextAttempt = mutableMapOf<String, Long>()

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_BLUETOOTH_NO_CONTEXT", "The app context is not available", null)

  override fun definition() = ModuleDefinition {
    Name("FlareNodeBluetooth")

    Events("onPeerConnected", "onPeerDisconnected", "onMessage", "onLog")

    Constants {
      mapOf("maxPayloadBytes" to StreamLinks.MAX_PAYLOAD_BYTES, "serviceUuid" to SERVICE_UUID.toString())
    }

    AsyncFunction("start") { id: String, name: String ->
      stopEverything()
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        throw CodedException("ERR_BLUETOOTH_TOO_OLD", "Bluetooth data channels need Android 10 or later", null)
      }
      val idBytes = hexToBytes(id)
        ?: throw CodedException("ERR_BLUETOOTH_NODE_ID", "The node id must be $NODE_ID_BYTES bytes written as hexadecimal", null)
      val bluetooth = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        ?: throw CodedException("ERR_BLUETOOTH_NONE", "This phone has no Bluetooth", null)
      if (!bluetooth.isEnabled) throw CodedException("ERR_BLUETOOTH_OFF", "Bluetooth is switched off", null)
      val advertiser = bluetooth.bluetoothLeAdvertiser
        ?: throw CodedException("ERR_BLUETOOTH_NO_ADVERTISING", "This phone cannot advertise over Bluetooth", null)
      val scanner = bluetooth.bluetoothLeScanner
        ?: throw CodedException("ERR_BLUETOOTH_NO_SCANNING", "This phone cannot scan over Bluetooth", null)

      synchronized(lock) {
        nodeId = id
        adapter = bluetooth
        val listening = bluetooth.listenUsingInsecureL2capChannel()
        server = listening
        val channel = listening.psm
        io = Executors.newCachedThreadPool()
        timer = Executors.newSingleThreadScheduledExecutor()
        links.start(id, name)
        io?.execute { acceptLoop(listening) }

        // The advertisement says "FlareNode is here"; the reply to a scan adds who and on which channel
        val service = ParcelUuid(SERVICE_UUID)
        val settings = AdvertiseSettings.Builder()
          .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
          .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
          .setConnectable(true)
          .build()
        val announcement = AdvertiseData.Builder().addServiceUuid(service).setIncludeDeviceName(false).build()
        val details = AdvertiseData.Builder()
          .addServiceData(service, idBytes + byteArrayOf((channel shr 8).toByte(), channel.toByte()))
          .setIncludeDeviceName(false)
          .build()
        val advertiseCallback = object : AdvertiseCallback() {
          override fun onStartFailure(errorCode: Int) = links.log("could not advertise (error $errorCode)")
        }
        advertising = advertiseCallback
        advertiser.startAdvertising(settings, announcement, details, advertiseCallback)

        val scanCallback = object : ScanCallback() {
          override fun onScanResult(callbackType: Int, result: ScanResult) = onSighting(result)
          override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach { onSighting(it) }
          override fun onScanFailed(errorCode: Int) = links.log("could not scan (error $errorCode)")
        }
        scanning = scanCallback
        scanner.startScan(
          listOf(ScanFilter.Builder().setServiceUuid(service).build()),
          ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build(),
          scanCallback
        )

        timer?.scheduleWithFixedDelay({ connectToMissingPeers() }, SWEEP_INTERVAL_MS, SWEEP_INTERVAL_MS, TimeUnit.MILLISECONDS)
        links.log("advertising and scanning as $id, listening on channel $channel")
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

  private fun onSighting(result: ScanResult) {
    val data = result.scanRecord?.getServiceData(ParcelUuid(SERVICE_UUID)) ?: return
    if (data.size < NODE_ID_BYTES + 2) return
    val peerId = bytesToHex(data, NODE_ID_BYTES)
    val channel = ((data[NODE_ID_BYTES].toInt() and 0xff) shl 8) or (data[NODE_ID_BYTES + 1].toInt() and 0xff)
    synchronized(lock) {
      if (!links.running || peerId == nodeId) return
      val isNew = !sightings.containsKey(peerId)
      sightings[peerId] = Sighting(result.device, channel, SystemClock.elapsedRealtime())
      if (isNew) links.log("found $peerId")
    }
    connectIfMine(peerId)
  }

  /** Of two phones, the one with the smaller node id connects. */
  private fun connectIfMine(peerId: String) {
    val now = SystemClock.elapsedRealtime()
    val sighting: Sighting
    val pool: ExecutorService
    synchronized(lock) {
      if (!links.running || nodeId >= peerId) return
      if (links.isLinked(peerId) || connecting.contains(peerId)) return
      if (now < (nextAttempt[peerId] ?: 0L)) return
      sighting = sightings[peerId] ?: return
      // A phone not heard from lately has probably gone, and its channel number may have changed
      if (now - sighting.seenAt > SIGHTING_FRESH_MS) return
      pool = io ?: return
      connecting.add(peerId)
      nextAttempt[peerId] = now + RETRY_AFTER_MS
    }
    pool.execute {
      var socket: BluetoothSocket? = null
      try {
        links.log("connecting to $peerId")
        socket = sighting.device.createInsecureL2capChannel(sighting.channel)
        socket.connect()
        synchronized(lock) { connecting.remove(peerId) }
        serve(socket)
      } catch (error: Exception) {
        links.log("could not connect to $peerId (${error.message})")
        runCatching { socket?.close() }
      } finally {
        synchronized(lock) { connecting.remove(peerId) }
      }
    }
  }

  private fun connectToMissingPeers() {
    val missing = synchronized(lock) { sightings.keys.filter { !links.isLinked(it) } }
    missing.forEach { connectIfMine(it) }
  }

  // ---- talking

  private fun acceptLoop(listening: BluetoothServerSocket) {
    while (links.running) {
      try {
        val socket = listening.accept()
        io?.execute { serve(socket) }
      } catch (error: Exception) {
        if (links.running) links.log("stopped accepting connections (${error.message})")
        return
      }
    }
  }

  private fun serve(socket: BluetoothSocket) {
    try {
      links.serve(socket.inputStream, socket.outputStream) { socket.close() }
    } catch (error: Exception) {
      runCatching { socket.close() }
    }
  }

  private fun stopEverything() {
    synchronized(lock) {
      val bluetooth = adapter
      advertising?.let { callback -> runCatching { bluetooth?.bluetoothLeAdvertiser?.stopAdvertising(callback) } }
      scanning?.let { callback -> runCatching { bluetooth?.bluetoothLeScanner?.stopScan(callback) } }
      advertising = null
      scanning = null
      runCatching { server?.close() }
      server = null
      timer?.shutdownNow()
      timer = null
      io?.shutdownNow()
      io = null
      adapter = null
      sightings.clear()
      connecting.clear()
      nextAttempt.clear()
    }
    links.stop()
  }

  private fun hexToBytes(hex: String): ByteArray? {
    if (hex.length != NODE_ID_BYTES * 2) return null
    return try {
      ByteArray(NODE_ID_BYTES) { index -> hex.substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    } catch (error: NumberFormatException) {
      null
    }
  }

  private fun bytesToHex(bytes: ByteArray, count: Int) =
    (0 until count).joinToString("") { index -> "%02x".format(bytes[index].toInt() and 0xff) }

  companion object {
    // Made up for FlareNode; phones only see each other if they advertise the same one
    private val SERVICE_UUID: UUID = UUID.fromString("6f1a0e52-9c3b-4d7a-8e21-f1a2e0de0001")
    // The mesh node id is 12 hexadecimal characters
    private const val NODE_ID_BYTES = 6
    private const val SWEEP_INTERVAL_MS = 8000L
    private const val RETRY_AFTER_MS = 6000L
    private const val SIGHTING_FRESH_MS = 30000L
  }
}
