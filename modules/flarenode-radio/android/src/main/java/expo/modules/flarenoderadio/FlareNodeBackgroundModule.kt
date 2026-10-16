package expo.modules.flarenoderadio

import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Switches the service that keeps the mesh running off screen on and off.
 * See MeshForegroundService for what it does and what it costs.
 */
class FlareNodeBackgroundModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_BACKGROUND_NO_CONTEXT", "The app context is not available", null)

  override fun definition() = ModuleDefinition {
    Name("FlareNodeBackground")

    Constants {
      mapOf("taskName" to MeshForegroundService.TASK_NAME)
    }

    // Called while the app is on screen, which is when Android allows it.
    // Calling it again changes the notification's text.
    AsyncFunction("start") { title: String, text: String ->
      val intent = Intent(context, MeshForegroundService::class.java)
        .putExtra(MeshForegroundService.EXTRA_TITLE, title)
        .putExtra(MeshForegroundService.EXTRA_TEXT, text)
      // These return the service's name, which cannot be passed to JavaScript;
      // returning it made the call report failure after the service had started
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      Unit
    }

    AsyncFunction("stop") {
      context.stopService(Intent(context, MeshForegroundService::class.java))
      Unit
    }

    Function("isRunning") {
      MeshForegroundService.running
    }
  }
}
