package com.norom.d10padel

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/**
 * The scoreboard, wrapped so it can hear the remote.
 *
 * The D10 sends volume keys. Chrome on Android never delivers those to a web
 * page, which is why the browser version cannot be scored from the remote and
 * why this wrapper exists. An activity, unlike a page, is offered every key
 * before the system acts on it — so the whole native job is: read the key,
 * hand the code to the page, and swallow it so the volume does not move.
 *
 * Everything else — scoring, undo, persistence, the display — is the same web
 * app served from the APK's assets.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    /** Serving assets over a real origin, because ES modules are blocked on file://. */
    private val origin = "https://appassets.androidplatform.net"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
            }

            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            // The page checks for this to skip its service worker and to correct
            // the note about Chrome swallowing volume keys.
            settings.userAgentString = settings.userAgentString + " D10Wrapper/1.0"

            setBackgroundColor(0xFF080D13.toInt())
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
        }

        setContentView(web)
        web.loadUrl("$origin/assets/index.html")
    }

    /**
     * Every key press the remote produces arrives here first.
     *
     * Back is left alone so the app can be closed. Everything else is forwarded
     * to the page and consumed: while a scoreboard is on screen the remote's
     * buttons are score buttons, not volume buttons.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) return super.dispatchKeyEvent(event)

        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            forwardToPage(event.keyCode)
        }
        return true
    }

    private fun forwardToPage(keyCode: Int) {
        val name = KeyEvent.keyCodeToString(keyCode).removePrefix("KEYCODE_")
        val quoted = JSONObject.quote(name)

        web.evaluateJavascript(
            "window.d10Remote && window.d10Remote.key($keyCode, $quoted);",
            null
        )
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
