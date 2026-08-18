package com.norom.d10padel

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
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
 * The D10 is two devices in one. Its S button is an HID keyboard key, which the
 * activity receives as a volume press. Its A and B buttons are not keys at all:
 * they speak the vendor service 0xCE80, the private channel the camera app
 * uses, which is why nothing Android exposes as input ever saw them.
 *
 * Finding which bonded device is the remote means connecting and looking, and
 * that is done strictly **one at a time**. Android allows only a handful of GATT
 * connections at once, and a phone with a car stereo, headphones and a watch
 * paired will use them all up before it ever reaches the remote.
 *
 * The address that works is remembered, so later launches go straight to it.
 */
class BleRemote(
    private val context: Context,
    private val onPayload: (String) -> Unit,
    private val onTrace: (String) -> Unit,
) {
    companion object {
        private const val TAG = "D10Ble"
        private const val PREFS = "d10-ble"
        private const val KEY_ADDRESS = "remote-address"

        /** Long enough for a sleepy remote, short enough to work through a list. */
        private const val ATTEMPT_TIMEOUT_MS = 7000L

        private val SERVICE = uuid16("CE80")
        private val COMMAND = uuid16("CE81")
        private val NOTIFY = uuid16("CE82")
        private val INFO = uuid16("CE83")
        private val CLIENT_CONFIG = uuid16("2902")
        private val USER_DESCRIPTION = uuid16("2901")

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
     * GATT allows one operation in flight at a time, so reads are queued rather
     * than fired together — issuing a second before the first returns silently
     * loses it.
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
        dropCurrent()
        listening = false
        queue = emptyList()
    }

    /**
     * The remembered remote first, then anything whose name looks like it, then
     * the rest. Most phones will match on the first entry and never touch the
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

    private fun tryNext() {
        if (next >= queue.size) {
            onTrace("None of the paired devices offers the ce80 service")
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
            val characteristic = connection.getService(SERVICE)?.getCharacteristic(NOTIFY)

            if (characteristic == null) {
                val found = connection.services.orEmpty().joinToString(" ") { shortForm(it.uuid) }
                onTrace("$name: no ce80 (has $found)")
                dropCurrent()
                tryNext()
                return
            }

            onTrace("$name has ce80 — switching on notifications")
            subscribe(connection, characteristic, name)
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

        override fun onDescriptorRead(
            connection: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
            value: ByteArray,
        ) {
            reportDescription(descriptor, status, value)
            operationFinished()
        }

        @Deprecated("Kept for Android 12 and earlier, which call this form.")
        @Suppress("DEPRECATION")
        override fun onDescriptorRead(
            connection: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            reportDescription(descriptor, status, descriptor.value ?: ByteArray(0))
            operationFinished()
        }

        override fun onCharacteristicRead(
            connection: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            reportValue(characteristic, status, value)
            operationFinished()
        }

        @Deprecated("Kept for Android 12 and earlier, which call this form.")
        @Suppress("DEPRECATION")
        override fun onCharacteristicRead(
            connection: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            status: Int,
        ) {
            reportValue(characteristic, status, characteristic.value ?: ByteArray(0))
            operationFinished()
        }

        override fun onDescriptorWrite(
            connection: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                listening = true
                prefs.edit().putString(KEY_ADDRESS, connection.device.address).apply()
                onTrace("Listening on ce82 — press A or B")
                describeService(connection)
            } else {
                onTrace("Could not switch on notifications (status $status)")
                dropCurrent()
                tryNext()
            }
        }
    }

    /**
     * Asks the remote to describe itself.
     *
     * Each characteristic carries a user-description descriptor, which on these
     * devices is often a plain word naming what it is for. If ce82 stays silent
     * this is the difference between guessing at a handshake and knowing what
     * the vendor called the thing we would be writing to.
     */
    private fun describeService(connection: BluetoothGatt) {
        val service = connection.getService(SERVICE) ?: return

        for (uuid in listOf(COMMAND, NOTIFY, INFO)) {
            val characteristic = service.getCharacteristic(uuid) ?: continue

            characteristic.getDescriptor(USER_DESCRIPTION)?.let { descriptor ->
                enqueue { readDescriptor(connection, descriptor) }
            }
        }

        // ce83 is readable, so whatever it holds is meant to be looked at.
        service.getCharacteristic(INFO)?.let { info ->
            enqueue { readCharacteristic(connection, info) }
        }
    }

    private fun enqueue(operation: () -> Unit) {
        pending.addLast(operation)
        if (pending.size == 1) operation()
    }

    private fun operationFinished() {
        pending.removeFirstOrNull()
        pending.firstOrNull()?.invoke()
    }

    private fun readDescriptor(connection: BluetoothGatt, descriptor: BluetoothGattDescriptor) {
        try {
            if (!connection.readDescriptor(descriptor)) operationFinished()
        } catch (denied: SecurityException) {
            operationFinished()
        }
    }

    private fun readCharacteristic(
        connection: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
    ) {
        try {
            if (!connection.readCharacteristic(characteristic)) operationFinished()
        } catch (denied: SecurityException) {
            operationFinished()
        }
    }

    /** Printable text if it is text, hex if it is not. */
    private fun readable(bytes: ByteArray): String {
        val text = String(bytes, Charsets.UTF_8)
        val printable = text.isNotEmpty() && text.all { it.code in 32..126 }

        return if (printable) "\"$text\"" else bytes.joinToString("") { "%02x".format(it) }
    }

    private fun reconnectRemembered(device: BluetoothDevice) {
        try {
            gatt = device.connectGatt(context, true, callback, BluetoothDevice.TRANSPORT_LE)
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
        }
    }

    private fun subscribe(
        connection: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        name: String,
    ) {
        try {
            if (!connection.setCharacteristicNotification(characteristic, true)) {
                onTrace("$name: the phone refused to listen to ce82")
                dropCurrent()
                tryNext()
                return
            }

            // Telling the characteristic to notify is only half of it; writing
            // the descriptor is what actually turns the stream on.
            val config = characteristic.getDescriptor(CLIENT_CONFIG)
            if (config == null) {
                onTrace("$name: ce82 has no notify switch")
                dropCurrent()
                tryNext()
                return
            }

            if (Build.VERSION.SDK_INT >= 33) {
                connection.writeDescriptor(config, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                @Suppress("DEPRECATION")
                config.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                connection.writeDescriptor(config)
            }
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
        }
    }

    /**
     * Android caches a bonded device's services. The D10 was bonded as a
     * keyboard, so that cache can describe only the HID service and discovery
     * then never reports the vendor one. The refresh that clears it has no
     * public API, so it is reached by reflection and skipped if unavailable.
     */
    private fun refreshServiceCache(connection: BluetoothGatt) {
        try {
            val refresh = connection.javaClass.getMethod("refresh")
            Log.d(TAG, "service cache refresh: ${refresh.invoke(connection)}")
        } catch (unavailable: Exception) {
            Log.d(TAG, "no service cache refresh: ${unavailable.javaClass.simpleName}")
        }
    }

    private fun reportDescription(
        descriptor: BluetoothGattDescriptor,
        status: Int,
        value: ByteArray,
    ) {
        if (status != BluetoothGatt.GATT_SUCCESS || value.isEmpty()) return
        onTrace("${shortForm(descriptor.characteristic.uuid)} is called ${readable(value)}")
    }

    private fun reportValue(
        characteristic: BluetoothGattCharacteristic,
        status: Int,
        value: ByteArray,
    ) {
        if (status != BluetoothGatt.GATT_SUCCESS || value.isEmpty()) return
        onTrace("${shortForm(characteristic.uuid)} holds ${readable(value)}")
    }

    private fun deliver(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        if (characteristic.uuid != NOTIFY || value.isEmpty()) return

        val hex = value.joinToString("") { "%02x".format(it) }
        Log.d(TAG, "notify $hex")
        onPayload(hex)
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
