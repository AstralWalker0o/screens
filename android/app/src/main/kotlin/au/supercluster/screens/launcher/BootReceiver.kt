package au.supercluster.screens.launcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import au.supercluster.screens.launcher.data.ConfigStore

/** On boot, marks the welcome screen as pending when `welcome.show_on_boot` is set. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val welcome = ConfigStore.current(context).config.welcome
        if (welcome.enabled && welcome.showOnBoot) {
            // The launcher observes this flag and shows the welcome screen as soon as it's in front
            // (it may already be resumed by the time BOOT_COMPLETED arrives).
            ConfigStore.setWelcomePending(context, true)
        }
    }
}
