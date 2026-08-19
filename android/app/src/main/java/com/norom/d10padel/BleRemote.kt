package com.norom.d10padel

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.UUID

/**
 * The remote's other half.
 *
 * The D10's S button is an HID keyboard key, which the activity receives as a
 * volume press. A and B are not keys, and where their presses go — if anywhere —
 * is not known. So this does not guess: it connects to the remote and subscribes
 * to **every characteristic that can notify**, on every service.
 *
 * That matters because a button whose reports land somewhere unexpected is
 * exactly the case that listening to one likely characteristic will miss. Where
 * a signal came from is carried alongside its bytes, so two characteristics
 * emitting the same short payload stay distinguishable.
 *
 * No scanning is involved. The remote is already bonded, so it is reached from
 * the bonded list — which also means no location permission. Devices are tried
 * strictly one at a time: Android allows only a handful of GATT connections, and
 * a phone with a car stereo, headphones and a watch paired will use them all up
 * before it ever reaches the remote.
 */
class BleRemote(
    private val context: Context,
    private val onPayload: (String, String) -> Unit,
    private val onTrace: (String) -> Unit,
) {
    companion object {
        private const val TAG = "D10Ble"
        private const val PREFS = "d10-ble"
        private const val KEY_ADDRESS = "remote-address"

        /** Long enough for a sleepy remote, short enough to work through a list. */
        private const val ATTEMPT_TIMEOUT_MS = 7000L

        private val VENDOR_SERVICE = uuid16("CE80")
        private val CLIENT_CONFIG = uuid16("2902")

        private const val NOTIFY_OR_INDICATE =
            BluetoothGattCharacteristic.PROPERTY_NOTIFY or
                BluetoothGattCharacteristic.PROPERTY_INDICATE

        /** The standard characteristics worth naming when they are reported. */
        private val WELL_KNOWN = mapOf(
            "2a00" to "device name",
            "2a24" to "model",
            "2a25" to "serial",
            "2a26" to "firmware",
            "2a27" to "hardware",
            "2a28" to "software",
            "2a29" to "manufacturer",
            "2a4a" to "HID info",
            "2a4b" to "HID report map",
            "2a50" to "PnP id",
        )

        private fun uuid16(short: String): UUID =
            UUID.fromString("0000$short-0000-1000-8000-00805f9b34fb")

        /** 0000ce80-0000-1000-8000-00805f9b34fb reads better as "ce80". */
        private fun shortForm(uuid: UUID): String {
            val text = uuid.toString()
            return if (text.startsWith("0000") && text.endsWith("-0000-1000-8000-00805f9b34fb")) {
                text.substring(4, 8)
            } else {
                text.substring(0, 8)
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private var queue: List<BluetoothDevice> = emptyList()
    private var next = 0
    private var gatt: BluetoothGatt? = null
    private var listening = false

    /**
     * GATT allows one operation in flight at a time, so the subscriptions are
     * queued — issuing a second descriptor write before the first returns
     * silently loses it, which with a dozen characteristics means most of them.
     */
    private val pending = ArrayDeque<() -> Unit>()

    private val giveUpOnThisOne = Runnable {
        onTrace("No answer, moving on")
        dropCurrent()
        tryNext()
    }

    fun start() {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter

        if (adapter == null) {
            onTrace("This phone has no Bluetooth adapter")
            return
        }
        if (!adapter.isEnabled) {
            onTrace("Bluetooth is switched off")
            return
        }

        val bonded = try {
            adapter.bondedDevices.filter {
                it.type == BluetoothDevice.DEVICE_TYPE_LE || it.type == BluetoothDevice.DEVICE_TYPE_DUAL
            }
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
            return
        }

        if (bonded.isEmpty()) {
            onTrace("Nothing suitable is paired — pair the D10 in Bluetooth settings")
            return
        }

        queue = mostLikelyFirst(bonded)
        next = 0
        tryNext()
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        pending.clear()
        dropCurrent()
        listening = false
        queue = emptyList()
    }

    /**
     * The remembered remote first, then anything whose name looks like it, then
     * the rest. Most phones match on the first entry and never touch the
     * headphones at all.
     */
    private fun mostLikelyFirst(devices: List<BluetoothDevice>): List<BluetoothDevice> {
        val remembered = prefs.getString(KEY_ADDRESS, null)

        return devices.sortedBy {
            when {
                it.address == remembered -> 0
                safeName(it).contains("d10", ignoreCase = true) -> 1
                else -> 2
            }
        }
    }

    /**
     * Accepted if it carries the vendor service, is named like the remote, or is
     * the one that worked last time. Without this it would latch onto the first
     * paired thing with a notification to offer, such as a watch.
     */
    private fun looksLikeTheRemote(
        device: BluetoothDevice,
        services: List<BluetoothGattService>,
    ): Boolean =
        services.any { it.uuid == VENDOR_SERVICE } ||
            safeName(device).contains("d10", ignoreCase = true) ||
            device.address == prefs.getString(KEY_ADDRESS, null)

    private fun tryNext() {
        if (next >= queue.size) {
            onTrace("None of the paired devices looks like the remote")
            return
        }

        val device = queue[next++]
        onTrace("Trying ${safeName(device)}…")

        try {
            // Direct connect: the remote is already linked to the phone for HID
            // and is not advertising, so there is nothing to wait around for.
            gatt = device.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE)
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
            return
        }

        handler.postDelayed(giveUpOnThisOne, ATTEMPT_TIMEOUT_MS)
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(connection: BluetoothGatt, status: Int, newState: Int) {
            val name = safeName(connection.device)

            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    handler.removeCallbacks(giveUpOnThisOne)
                    handler.postDelayed(giveUpOnThisOne, ATTEMPT_TIMEOUT_MS)
                    refreshServiceCache(connection)
                    try {
                        connection.discoverServices()
                    } catch (denied: SecurityException) {
                        onTrace("Bluetooth permission was refused")
                    }
                }

                BluetoothProfile.STATE_DISCONNECTED -> {
                    handler.removeCallbacks(giveUpOnThisOne)
                    pending.clear()

                    if (listening && connection.device.address == prefs.getString(KEY_ADDRESS, null)) {
                        // The remote sleeps between points. Now it is worth
                        // waiting in the background for it to come back.
                        onTrace("$name asleep — press a button to wake it")
                        dropCurrent()
                        handler.postDelayed({ reconnectRemembered(connection.device) }, 800)
                    } else {
                        dropCurrent()
                        tryNext()
                    }
                }
            }
        }

        override fun onServicesDiscovered(connection: BluetoothGatt, status: Int) {
            handler.removeCallbacks(giveUpOnThisOne)

            val name = safeName(connection.device)
            val services = connection.services.orEmpty()

            val notifiable = services
                .flatMap { it.characteristics.orEmpty() }
                .filter { it.properties and NOTIFY_OR_INDICATE != 0 }

            if (!looksLikeTheRemote(connection.device, services)) {
                dropCurrent()
                tryNext()
                return
            }

            onTrace("$name has " + services.joinToString(" ") { shortForm(it.uuid) })

            services.forEach { service ->
                val members = service.characteristics.orEmpty().joinToString(" ") {
                    shortForm(it.uuid) + properties(it)
                }
                if (members.isNotEmpty()) onTrace("  ${shortForm(service.uuid)}: $members")
            }

            if (notifiable.isEmpty()) {
                onTrace("$name has nothing that can notify")
                dropCurrent()
                tryNext()
                return
            }

            listening = true
            prefs.edit().putString(KEY_ADDRESS, connection.device.address).apply()
            onTrace("Listening on " + notifiable.joinToString(" ") { shortForm(it.uuid) })

            notifiable.forEach { characteristic ->
                enqueue { subscribe(connection, characteristic) }
            }

            // Then read everything the remote is willing to show. The HID
            // report map is the prize: it declares every usage the device can
            // ever send, so it says whether A and B exist as HID buttons at all
            // rather than leaving it to be inferred from silence.
            services
                .flatMap { it.characteristics.orEmpty() }
                .filter { it.properties and BluetoothGattCharacteristic.PROPERTY_READ != 0 }
                .forEach { characteristic -> enqueue { read(connection, characteristic) } }
        }

        override fun onCharacteristicChanged(
            connection: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) = deliver(characteristic, value)

        @Deprecated("Kept for Android 12 and earlier, which call this form.")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            connection: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) = deliver(characteristic, characteristic.value ?: ByteArray(0))

        override fun onCharacteristicRead(
            connection: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            reportRead(characteristic, status, value)
            operationFinished()
        }

        @Deprecated("Kept for Android 12 and earlier, which call this form.")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            connection: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            reportRead(characteristic, status, characteristic.value ?: ByteArray(0))
            operationFinished()
        }

        override fun onDescriptorWrite(
            connection: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                // Android reserves the HID service for itself, so being turned
                // away there is expected and worth saying plainly.
                onTrace("${shortForm(descriptor.characteristic.uuid)} refused ($status)")
            }
            operationFinished()
        }
    }

    // ------------------------------------------------------------ operations

    private fun enqueue(operation: () -> Unit) {
        pending.addLast(operation)
        if (pending.size == 1) operation()
    }

    private fun operationFinished() {
        pending.removeFirstOrNull()
        pending.firstOrNull()?.invoke()
    }

    private fun subscribe(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
        try {
            if (!connection.setCharacteristicNotification(characteristic, true)) {
                onTrace("${shortForm(characteristic.uuid)} refused")
                operationFinished()
                return
            }

            // Turning on notification is only half of it; writing the descriptor
            // is what actually starts the stream. Some report characteristics
            // have no descriptor and notify regardless.
            val config = characteristic.getDescriptor(CLIENT_CONFIG)
            if (config == null) {
                operationFinished()
                return
            }

            val enable =
                if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
                    BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                } else {
                    BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                }

            if (Build.VERSION.SDK_INT >= 33) {
                connection.writeDescriptor(config, enable)
            } else {
                @Suppress("DEPRECATION")
                config.value = enable
                @Suppress("DEPRECATION")
                connection.writeDescriptor(config)
            }
        } catch (denied: SecurityException) {
            operationFinished()
        }
    }

    private fun read(connection: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
        try {
            if (!connection.readCharacteristic(characteristic)) operationFinished()
        } catch (denied: SecurityException) {
            operationFinished()
        }
    }

    private fun reportRead(
        characteristic: BluetoothGattCharacteristic,
        status: Int,
        value: ByteArray,
    ) {
        val short = shortForm(characteristic.uuid)
        val label = WELL_KNOWN[short]?.let { "$short ($it)" } ?: short

        if (status != BluetoothGatt.GATT_SUCCESS) {
            val why = if (status == 5 || status == 15) " — needs pairing" else ""
            onTrace("$label unreadable ($status)$why")
            return
        }
        if (value.isEmpty()) return

        onTrace("$label = ${readable(value)}")
    }

    /** Printable text if it is text, hex if it is not. */
    private fun readable(bytes: ByteArray): String {
        val text = String(bytes, Charsets.UTF_8)
        val printable = text.isNotEmpty() && text.all { it.code in 32..126 }

        return if (printable) text else bytes.joinToString("") { "%02x".format(it) }
    }

    private fun reconnectRemembered(device: BluetoothDevice) {
        try {
            gatt = device.connectGatt(context, true, callback, BluetoothDevice.TRANSPORT_LE)
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
        }
    }

    /**
     * Android caches a bonded device's services. The D10 was bonded as a
     * keyboard, so that cache can describe only the HID service and discovery
     * then never reports the others. The refresh that clears it has no public
     * API, so it is reached by reflection and skipped if unavailable.
     */
    private fun refreshServiceCache(connection: BluetoothGatt) {
        try {
            val refresh = connection.javaClass.getMethod("refresh")
            Log.d(TAG, "service cache refresh: ${refresh.invoke(connection)}")
        } catch (unavailable: Exception) {
            Log.d(TAG, "no service cache refresh: ${unavailable.javaClass.simpleName}")
        }
    }

    private fun deliver(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        if (value.isEmpty()) return

        val source = shortForm(characteristic.uuid)
        val hex = value.joinToString("") { "%02x".format(it) }
        Log.d(TAG, "notify $source $hex")
        onPayload(source, hex)
    }

    /** r=read w=write n=notify i=indicate, so the dump shows what each can do. */
    private fun properties(characteristic: BluetoothGattCharacteristic): String {
        val p = characteristic.properties
        val flags = buildString {
            if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) append("r")
            if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) append("w")
            if (p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) append("W")
            if (p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) append("n")
            if (p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) append("i")
        }
        return if (flags.isEmpty()) "" else "[$flags]"
    }

    private fun dropCurrent() {
        val open = gatt ?: return
        gatt = null
        try {
            open.disconnect()
            open.close()
        } catch (ignored: SecurityException) {
            // Losing the handle on the way out is not worth crashing over.
        }
    }

    private fun safeName(device: BluetoothDevice): String =
        try {
            device.name ?: device.address
        } catch (denied: SecurityException) {
            device.address
        }
}
