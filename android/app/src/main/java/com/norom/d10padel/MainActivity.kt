package com.norom.d10padel

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.content.pm.ApplicationInfo
import android.media.AudioManager
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.JavascriptInterface
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

private const val BLUETOOTH_REQUEST = 1

/**
 * The scoreboard, wrapped so it can hear the remote.
 *
 * The D10 sends volume keys, which Chrome never delivers to a web page. An
 * activity, unlike a page, is offered every key before the system acts on it,
 * so the native job is: read the key, hand the code to the page, and swallow it
 * so the volume does not move.
 *
 * Three routes are needed, because the remote's buttons do not all travel the
 * same way:
 *
 *  - `dispatchKeyEvent` receives ordinary keys, volume included. This is S.
 *  - Media keys (play, pause, next, record…) never reach an activity at all.
 *    The system routes them to whichever MediaSession is active, so the app
 *    holds one purely to be a legitimate recipient of those presses.
 *  - A and B are not keys at all. They are only spoken over the remote's own
 *    BLE service, which `BleRemote` subscribes to.
 *
 * Everything above the key code — scoring, undo, persistence, the display — is
 * the same web app, served from the APK's assets.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var session: MediaSession? = null
    private var ble: BleRemote? = null

    /**
     * What the BLE channel has reported so far. Connection starts before the
     * page has loaded, so the early steps would otherwise be dropped and the
     * trace would begin halfway through.
     */
    private val bleTrace = mutableListOf<String>()
    private var pageReady = false

    /** Key codes seen going down, so a key that only reports up is not missed. */
    private val pressed = mutableSetOf<Int>()

    /** ES modules are blocked on file://, so assets are served over an origin. */
    private val origin = "https://appassets.androidplatform.net"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Debug builds only: lets `chrome://inspect` and CDP attach to the page.
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    bleTrace.forEach { publishBleStatus(it) }
                }
            }

            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.userAgentString = settings.userAgentString + " D10Wrapper/1.0"

            setBackgroundColor(0xFF080D13.toInt())
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }

        // Lets the diagnostics screen put its report on the clipboard. Long hex
        // dumps are unusable if the only way to relay them is a screenshot.
        web.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun copy(text: String) {
                    val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newPlainText("D10 diagnostics", text))
                }
            },
            "D10Native",
        )

        setContentView(web)
        web.loadUrl("$origin/assets/index.html")

        startMediaSession()
        startBleWhenAllowed()
    }

    // ---------------------------------------------------------- vendor channel

    /**
     * A and B are not keyboard keys; they only reach an app over the remote's
     * own BLE service. Connecting to an already-bonded device needs no scan, so
     * this asks for Bluetooth alone and never for location.
     */
    private fun startBleWhenAllowed() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasBluetoothPermission()) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), BLUETOOTH_REQUEST)
            return
        }
        startBle()
    }

    private fun hasBluetoothPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED

    private fun startBle() {
        if (ble != null) return

        ble = BleRemote(
            context = this,
            onPayload = { source, hex ->
                runOnUiThread { sendToPage("window.d10Remote.ble('$source', '$hex')") }
            },
            onTrace = { text -> runOnUiThread { reportBleStatus(text) } },
        ).also { it.start() }
    }

    private fun reportBleStatus(text: String) {
        bleTrace.add(text)
        if (pageReady) publishBleStatus(text)
    }

    private fun publishBleStatus(text: String) {
        sendToPage("window.d10Remote.bleStatus(${JSONObject.quote(text)})")
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != BLUETOOTH_REQUEST) return

        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            startBle()
        } else {
            // The scoreboard still works from S and the on-screen buttons.
            reportBleStatus("Bluetooth not allowed, so A and B cannot be read")
        }
    }

    // ------------------------------------------------------------ ordinary keys

    /**
     * Back is left alone so the app can be closed. Everything else goes to the
     * page and is consumed: while a scoreboard is on screen the remote's buttons
     * are score buttons, not volume buttons.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)

        when (event.action) {
            KeyEvent.ACTION_DOWN -> {
                if (event.repeatCount == 0) {
                    pressed.add(event.keyCode)
                    forwardToPage(event.keyCode, event.scanCode)
                }
            }
            // Some remotes report only the release. Treat an unmatched up as a press.
            KeyEvent.ACTION_UP -> {
                if (!pressed.remove(event.keyCode)) {
                    forwardToPage(event.keyCode, event.scanCode)
                }
            }
        }
        return true
    }

    // --------------------------------------------------------------- media keys

    /**
     * Media buttons bypass activities entirely — the system hands them to an
     * active MediaSession. Holding one is the only way a record or play button
     * on the remote can ever be seen.
     */
    private fun startMediaSession() {
        val created = MediaSession(this, "D10PadelRemote").apply {
            @Suppress("DEPRECATION")
            setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or
                    MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
            )

            setCallback(object : MediaSession.Callback() {
                override fun onMediaButtonEvent(intent: Intent): Boolean {
                    val event: KeyEvent? = if (Build.VERSION.SDK_INT >= 33) {
                        intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
                    }

                    if (event != null && event.action == KeyEvent.ACTION_DOWN) {
                        runOnUiThread { forwardToPage(event.keyCode, event.scanCode) }
                    }
                    return true
                }
            })

            // Claiming to be playing is what makes this session the one the
            // system routes media buttons to.
            setPlaybackState(
                PlaybackState.Builder()
                    .setActions(
                        PlaybackState.ACTION_PLAY or
                            PlaybackState.ACTION_PAUSE or
                            PlaybackState.ACTION_PLAY_PAUSE or
                            PlaybackState.ACTION_SKIP_TO_NEXT or
                            PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                            PlaybackState.ACTION_STOP
                    )
                    .setState(PlaybackState.STATE_PLAYING, 0L, 1.0f)
                    .build()
            )
            isActive = true
        }

        session = created
    }

    /**
     * Media button routing follows audio focus, so the session needs it to be
     * chosen. Held only while the scoreboard is in front, and given back on the
     * way out so nothing else stays interrupted.
     */
    @Suppress("DEPRECATION")
    private fun setAudioFocus(hold: Boolean) {
        val audio = getSystemService(AUDIO_SERVICE) as AudioManager

        if (hold) {
            audio.requestAudioFocus(
                null,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            )
        } else {
            audio.abandonAudioFocus(null)
        }
    }

    // ------------------------------------------------------------------ bridge

    private fun forwardToPage(keyCode: Int, scanCode: Int) {
        val name = KeyEvent.keyCodeToString(keyCode).removePrefix("KEYCODE_")
        val quoted = JSONObject.quote(name)

        sendToPage("window.d10Remote.key($keyCode, $quoted, $scanCode)")
    }

    /** Guarded so a message arriving before the page has loaded is simply dropped. */
    private fun sendToPage(call: String) {
        web.evaluateJavascript("window.d10Remote && $call;", null)
    }

    // ----------------------------------------------------------------- lifecycle

    override fun onResume() {
        super.onResume()
        session?.isActive = true
        setAudioFocus(true)
    }

    override fun onPause() {
        super.onPause()
        setAudioFocus(false)
    }

    override fun onDestroy() {
        ble?.stop()
        ble = null
        session?.isActive = false
        session?.release()
        session = null
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    /** A scoreboard should be all scoreboard. */
    private fun goImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(android.view.WindowInsets.Type.systemBars())
                it.systemBarsBehavior =
                    android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        }
    }
}
