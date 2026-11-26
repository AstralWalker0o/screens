package au.supercluster.screens.launcher.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

enum class NetworkKind { NONE, WIFI, ETHERNET, OTHER }

/** What the top-bar glyph shows. [wifiLevel] is 0–4 (4 when unknown). */
data class NetworkStatus(val kind: NetworkKind, val wifiLevel: Int = 4) {
    companion object {
        val Unknown = NetworkStatus(NetworkKind.OTHER)
    }
}

/**
 * Watches the default network for the top-bar glyph. Needs only ACCESS_NETWORK_STATE, a normal
 * install-time permission that reads connection state and grants no network access (the app
 * still has no INTERNET permission). One callback for the whole process.
 */
object NetworkMonitor {
    private const val TAG = "ScreensNetwork"

    @Volatile
    private var flow: MutableStateFlow<NetworkStatus>? = null

    fun state(context: Context): StateFlow<NetworkStatus> {
        flow?.let { return it }
        synchronized(this) {
            flow?.let { return it }
            val f = MutableStateFlow(NetworkStatus.Unknown)
            flow = f
            register(context.applicationContext, f)
            return f
        }
    }

    private fun register(app: Context, f: MutableStateFlow<NetworkStatus>) {
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            f.value = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }?.let(::statusOf) ?: NetworkStatus(NetworkKind.NONE)
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    f.value = statusOf(caps)
                }

                override fun onLost(network: Network) {
                    f.value = NetworkStatus(NetworkKind.NONE)
                }
            })
        } catch (e: RuntimeException) {
            // SecurityException without ACCESS_NETWORK_STATE, or a vendor quirk: show a neutral glyph.
            Log.w(TAG, "network state unavailable", e)
        }
    }

    private fun statusOf(caps: NetworkCapabilities): NetworkStatus = when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> NetworkStatus(NetworkKind.ETHERNET)
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> NetworkStatus(NetworkKind.WIFI, wifiLevel(caps))
        else -> NetworkStatus(NetworkKind.OTHER)
    }

    private fun wifiLevel(caps: NetworkCapabilities): Int {
        if (Build.VERSION.SDK_INT < 29) return 4
        val rssi = caps.signalStrength
        return when {
            rssi == NetworkCapabilities.SIGNAL_STRENGTH_UNSPECIFIED -> 4
            rssi >= -55 -> 4
            rssi >= -66 -> 3
            rssi >= -77 -> 2
            rssi >= -88 -> 1
            else -> 0
        }
    }
}
