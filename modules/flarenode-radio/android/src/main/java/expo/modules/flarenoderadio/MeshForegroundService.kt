package expo.modules.flarenoderadio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps the mesh running when FlareNode is not on screen.
 *
 * A phone in a pocket is the normal case in the field, and a phone can only
 * pass markers on for others while its mesh is running. Left alone, Android
 * does three things to an app that leaves the screen, and this service is
 * here to stop each of them:
 *
 * - It may end the app's process. A service showing a notification (a
 *   "foreground service") is left alone.
 * - It lets the processor sleep. This service holds a wake lock.
 * - React Native stops its timers, which the mesh uses to compare notes with
 *   peers every so often. They keep running while a background JavaScript
 *   task is in progress, so this starts one that does not finish (see
 *   "FlareNodeMesh" in App.js).
 *
 * The cost is battery: the processor and radios stay awake for as long as the
 * mesh is switched on. The notification is how the responder can tell.
 */
class MeshForegroundService : HeadlessJsTaskService() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: DEFAULT_TEXT
    val notification = buildNotification(title, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // Starting again only changes the notification; one background task is enough
    if (!running) {
      running = true
      super.onStartCommand(intent, flags, startId)
    }
    // If Android ends the app, do not bring the service back by itself: the
    // mesh would not be running, and the notification would say that it was.
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  private fun buildNotification(title: String, text: String): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // Low importance: it sits in the shade without a sound or a pop-up
      val channel = NotificationChannel(CHANNEL_ID, "Mesh running", NotificationManager.IMPORTANCE_LOW)
      channel.description = "Shown while FlareNode is sharing markers with nearby responders"
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    return builder
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(open)
      .build()
  }

  companion object {
    const val TASK_NAME = "FlareNodeMesh"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val DEFAULT_TITLE = "FlareNode mesh is on"
    private const val DEFAULT_TEXT = "Sharing markers with responders nearby"
    private const val CHANNEL_ID = "flarenode-mesh"
    private const val NOTIFICATION_ID = 4101

    @Volatile var running = false
      private set
  }
}
