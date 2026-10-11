package expo.modules.flarenoderadio

import android.os.SystemClock
import expo.modules.kotlin.Promise
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Phones talking over two-way streams, whatever carries the stream.
 *
 * A TCP connection on the local network and a Bluetooth channel both give a
 * pair of streams, and from there everything is the same. This class is that
 * shared part; each radio only has to find phones and open streams to them.
 *
 * On the wire, each message is its length (4 bytes) followed by UTF-8 text.
 * The first message each way is "<node id>|<name>". A length of zero is a
 * keep-alive: one is sent every few seconds, and a phone that has been silent
 * for too long is taken to be gone.
 *
 * Anyone in range can open a stream and say it is a phone. The mesh above
 * seals and signs what it sends, and ignores peers that cannot read it.
 */
internal class StreamLinks(
  // What peers reached this way report as their link: "wifi", "bluetooth"
  private val linkLabel: String,
  // Start of every log line, so the radios can be told apart
  private val logPrefix: String,
  private val emit: (String, Map<String, Any?>) -> Unit
) {
  private class Link(rawIn: InputStream, rawOut: OutputStream, private val closer: () -> Unit) {
    val input = DataInputStream(BufferedInputStream(rawIn))
    val output = DataOutputStream(BufferedOutputStream(rawOut))
    // One writer per connection keeps messages in the order they were sent
    val writer: ExecutorService = Executors.newSingleThreadExecutor()
    @Volatile var peerId: String? = null
    @Volatile var peerName = ""
    @Volatile var closed = false
    @Volatile var lastHeard = SystemClock.elapsedRealtime()

    fun shut() {
      closed = true
      runCatching { closer() }
      writer.shutdownNow()
    }
  }

  private val lock = Any()
  private val links = mutableMapOf<String, Link>()
  private var timer: ScheduledExecutorService? = null
  @Volatile private var nodeId = ""
  @Volatile private var displayName = ""
  @Volatile var running = false
    private set

  fun start(id: String, name: String) {
    synchronized(lock) {
      nodeId = id
      displayName = name.take(MAX_NAME_LENGTH)
      running = true
      timer = Executors.newSingleThreadScheduledExecutor().also {
        it.scheduleWithFixedDelay({ keepAlive() }, KEEP_ALIVE_MS, KEEP_ALIVE_MS, TimeUnit.MILLISECONDS)
      }
    }
  }

  fun stop() {
    val open: List<Link>
    synchronized(lock) {
      running = false
      timer?.shutdownNow()
      timer = null
      open = links.values.toList()
      links.clear()
    }
    for (link in open) {
      link.shut()
      link.peerId?.let { emit("onPeerDisconnected", mapOf("id" to it)) }
    }
  }

  fun isLinked(peerId: String) = synchronized(lock) { links.containsKey(peerId) }

  fun log(message: String) = emit("onLog", mapOf("message" to "$logPrefix: $message"))

  /**
   * Runs one connection from its first byte to its last. Call it on a thread
   * of its own: it returns when the connection is over.
   */
  fun serve(rawIn: InputStream, rawOut: OutputStream, closer: () -> Unit) {
    val link = Link(rawIn, rawOut, closer)
    try {
      link.writer.execute {
        runCatching { write(link, "$nodeId$NAME_SEPARATOR$displayName".toByteArray(Charsets.UTF_8)) }.onFailure { close(link) }
      }
      val hello = String(readFrame(link) ?: throw IllegalStateException("no greeting"), Charsets.UTF_8)
      val separator = hello.indexOf(NAME_SEPARATOR)
      val peerId = if (separator < 0) hello else hello.substring(0, separator)
      val peerName = if (separator < 0) hello else hello.substring(separator + 1)
      if (peerId.isEmpty() || peerId == nodeId) throw IllegalStateException("unusable greeting")

      val replaced = synchronized(lock) {
        if (!running) throw IllegalStateException("stopped")
        link.peerId = peerId
        link.peerName = peerName
        links.put(peerId, link)
      }
      // A phone that reconnects before its old connection was noticed dead
      if (replaced != null) {
        replaced.shut()
        emit("onPeerDisconnected", mapOf("id" to peerId))
      }
      log("connected to $peerName")
      emit("onPeerConnected", mapOf("id" to peerId, "name" to peerName, "link" to linkLabel))

      while (!link.closed) {
        val bytes = readFrame(link) ?: continue
        emit("onMessage", mapOf("id" to peerId, "text" to String(bytes, Charsets.UTF_8)))
      }
    } catch (error: Exception) {
      // The usual way a connection ends: the other phone left or went out of range
    } finally {
      close(link)
    }
  }

  fun send(peerId: String, text: String, promise: Promise) {
    val link = synchronized(lock) { links[peerId] }
    if (link == null) {
      promise.reject("ERR_RADIO_NOT_CONNECTED", "Not connected to $peerId", null)
      return
    }
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size > MAX_PAYLOAD_BYTES) {
      promise.reject("ERR_RADIO_TOO_LARGE", "Message is ${bytes.size} bytes; the limit is $MAX_PAYLOAD_BYTES", null)
      return
    }
    try {
      link.writer.execute {
        try {
          write(link, bytes)
          promise.resolve(null)
        } catch (error: Exception) {
          promise.reject("ERR_RADIO_SEND", error.message ?: "Send failed", error)
          close(link)
        }
      }
    } catch (error: Exception) {
      // The connection closed between finding it and using it
      promise.reject("ERR_RADIO_NOT_CONNECTED", "Not connected to $peerId", error)
    }
  }

  /** The next message, or null for a keep-alive. */
  private fun readFrame(link: Link): ByteArray? {
    val length = link.input.readInt()
    link.lastHeard = SystemClock.elapsedRealtime()
    if (length == 0) return null
    if (length < 0 || length > MAX_FRAME_BYTES) throw IllegalStateException("bad message length $length")
    val bytes = ByteArray(length)
    link.input.readFully(bytes)
    link.lastHeard = SystemClock.elapsedRealtime()
    return bytes
  }

  private fun write(link: Link, bytes: ByteArray) {
    link.output.writeInt(bytes.size)
    link.output.write(bytes)
    link.output.flush()
  }

  private fun keepAlive() {
    val now = SystemClock.elapsedRealtime()
    val open = synchronized(lock) { links.values.toList() }
    for (link in open) {
      if (now - link.lastHeard > SILENCE_LIMIT_MS) {
        close(link)
        continue
      }
      runCatching {
        link.writer.execute { runCatching { write(link, ByteArray(0)) }.onFailure { close(link) } }
      }
    }
  }

  private fun close(link: Link) {
    if (link.closed) return
    link.shut()
    val peerId = link.peerId ?: return
    val wasCurrent = synchronized(lock) {
      if (links[peerId] === link) {
        links.remove(peerId)
        true
      } else false
    }
    if (wasCurrent) {
      log("disconnected from ${link.peerName}")
      emit("onPeerDisconnected", mapOf("id" to peerId))
    }
  }

  companion object {
    const val NAME_SEPARATOR = '|'
    // What the mesh may send in one message, and the most this will read in one
    const val MAX_PAYLOAD_BYTES = 30000
    private const val MAX_NAME_LENGTH = 60
    private const val MAX_FRAME_BYTES = 256 * 1024
    private const val KEEP_ALIVE_MS = 5000L
    private const val SILENCE_LIMIT_MS = 20000L
  }
}
