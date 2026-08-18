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
 * This subscribes to that service's notify characteristic and hands whatever
 * bytes arrive to the page, where they are matched against bindings exactly
 * like a key press.
 *
 * No scanning is involved. The remote is already bonded, so it can be reached
 * straight from the bonded list — which also means no location permission.
 *
 * Every step reports itself, because when a button produces nothing there are
 * several very different reasons and they need different fixes.
 */
class BleRemote(
    private val context: Context,
    private val onPayload: (String) -> Unit,
    private val onTrace: (String) -> Unit,
) {
    companion object {
        private const val TAG = "D10Ble"

        private val SERVICE = uuid16("CE80")
        private val NOTIFY = uuid16("CE82")
        private val CLIENT_CONFIG = uuid16("2902")

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
    private val connections = mutableMapOf<String, BluetoothGatt>()
    private var subscribed = false

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

        val candidates = try {
            adapter.bondedDevices.filter {
                it.type == BluetoothDevice.DEVICE_TYPE_LE || it.type == BluetoothDevice.DEVICE_TYPE_DUAL
            }
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
            return
        }

        if (candidates.isEmpty()) {
            onTrace("Nothing suitable is paired — pair the D10 in Bluetooth settings")
            return
        }

        onTrace("Paired: " + candidates.joinToString(", ") { safeName(it) })
        candidates.forEach { connect(it, autoConnect = false) }
    }

    fun stop() {
        handler.removeCallbacksAndMessages(null)
        connections.values.forEach { closeQuietly(it) }
        connections.clear()
        subscribed = false
    }

    private fun connect(device: BluetoothDevice, autoConnect: Boolean) {
        try {
            // autoConnect=false connects now. The remote is already linked to the
            // phone for HID, so there is nothing to wait around for, and a
            // background connect can sit forever against a device that is not
            // advertising because it is already connected.
            val gatt = device.connectGatt(context, autoConnect, callback, BluetoothDevice.TRANSPORT_LE)
            if (gatt != null) connections[device.address] = gatt
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
        }
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val name = safeName(gatt.device)

            when (newState) {
                BluetoothProfile.STATE_CONNECTED -> {
                    onTrace("$name: connected")
                    refreshServiceCache(gatt)
                    try {
                        gatt.discoverServices()
                    } catch (denied: SecurityException) {
                        onTrace("Bluetooth permission was refused")
                    }
                }

                BluetoothProfile.STATE_DISCONNECTED -> {
                    if (subscribed) {
                        onTrace("$name: dropped, reconnecting")
                        // Now it is worth waiting in the background: the remote
                        // sleeps between points and wakes on the next press.
                        closeQuietly(gatt)
                        connections.remove(gatt.device.address)
                        handler.postDelayed({ connect(gatt.device, autoConnect = true) }, 1000)
                    } else {
                        onTrace("$name: could not connect (status $status)")
                        closeQuietly(gatt)
                        connections.remove(gatt.device.address)
                    }
                }
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val name = safeName(gatt.device)
            val services = gatt.services.orEmpty()

            onTrace("$name: " + services.joinToString(" ") { shortForm(it.uuid) })

            val characteristic = gatt.getService(SERVICE)?.getCharacteristic(NOTIFY)
            if (characteristic == null) {
                if (gatt.getService(SERVICE) != null) {
                    onTrace("$name: has ce80 but no ce82 to listen on")
                }
                closeQuietly(gatt)
                connections.remove(gatt.device.address)
                return
            }

            subscribe(gatt, characteristic, name)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) = deliver(characteristic, value)

        @Deprecated("Kept for Android 12 and earlier, which call this form.")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) = deliver(characteristic, characteristic.value ?: ByteArray(0))

        override fun onDescriptorWrite(
            gatt: BluetoothGatt,
            descriptor: BluetoothGattDescriptor,
            status: Int,
        ) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                subscribed = true
                onTrace("Listening on ce82 — press A or B")
            } else {
                onTrace("Could not switch on notifications (status $status)")
            }
        }
    }

    private fun subscribe(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        name: String,
    ) {
        try {
            if (!gatt.setCharacteristicNotification(characteristic, true)) {
                onTrace("$name: the phone refused to listen to ce82")
                return
            }

            // Telling the characteristic to notify is only half of it; writing
            // the descriptor is what actually turns the stream on.
            val config = characteristic.getDescriptor(CLIENT_CONFIG)
            if (config == null) {
                onTrace("$name: ce82 has no notify switch to turn on")
                return
            }

            if (Build.VERSION.SDK_INT >= 33) {
                gatt.writeDescriptor(config, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
            } else {
                @Suppress("DEPRECATION")
                config.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                @Suppress("DEPRECATION")
                gatt.writeDescriptor(config)
            }
        } catch (denied: SecurityException) {
            onTrace("Bluetooth permission was refused")
        }
    }

    /**
     * Android caches a bonded device's services. The D10 was bonded as a
     * keyboard, so that cache can describe only the HID service and discovery
     * then never reports the vendor one. The refresh that fixes it has no public
     * API, so it is reached by reflection and skipped if unavailable.
     */
    private fun refreshServiceCache(gatt: BluetoothGatt) {
        try {
            val refresh = gatt.javaClass.getMethod("refresh")
            val ok = refresh.invoke(gatt) as? Boolean ?: false
            Log.d(TAG, "service cache refresh: $ok")
        } catch (unavailable: Exception) {
            Log.d(TAG, "service cache refresh unavailable: ${unavailable.javaClass.simpleName}")
        }
    }

    private fun deliver(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        if (characteristic.uuid != NOTIFY || value.isEmpty()) return

        val hex = value.joinToString("") { "%02x".format(it) }
        Log.d(TAG, "notify $hex")
        onPayload(hex)
    }

    private fun safeName(device: BluetoothDevice): String =
        try {
            device.name ?: device.address
        } catch (denied: SecurityException) {
            device.address
        }

    private fun closeQuietly(gatt: BluetoothGatt) {
        try {
            gatt.close()
        } catch (ignored: SecurityException) {
            // Losing the handle on the way out is not worth crashing over.
        }
    }
}
