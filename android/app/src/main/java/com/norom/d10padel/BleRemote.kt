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
import android.util.Log
import java.util.UUID

/**
 * The remote's other half.
 *
 * The D10 is two devices in one. Its S button is an HID keyboard key, which the
 * activity receives as a volume press. Its A and B buttons are not keys at all:
 * they talk to the camera over a vendor service, which is why nothing Android
 * exposes as input ever saw them.
 *
 * This subscribes to that service's notify characteristic and hands whatever
 * bytes arrive to the page, where they are matched against bindings exactly
 * like a key press.
 *
 * No scanning is involved. The remote is already bonded, so it can be reached
 * straight from the bonded list — which also means no location permission.
 */
class BleRemote(
    private val context: Context,
    private val onPayload: (String) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    companion object {
        private const val TAG = "D10Ble"

        /** Vendor control service seen on the D10, and its notify characteristic. */
        private val SERVICE = uuid16("CE80")
        private val NOTIFY = uuid16("CE82")
        private val CLIENT_CONFIG = uuid16("2902")

        private fun uuid16(short: String): UUID =
            UUID.fromString("0000$short-0000-1000-8000-00805f9b34fb")
    }

    private val connections = mutableListOf<BluetoothGatt>()
    private var subscribed = false

    /**
     * Opens a connection to every bonded low-energy device and keeps only those
     * carrying the vendor service. Bonded phones typically have a handful of
     * devices; the ones without the service are dropped as soon as discovery
     * says so.
     */
    fun start() {
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val adapter = manager?.adapter

        if (adapter == null || !adapter.isEnabled) {
            onStatus("Bluetooth is off")
            return
        }

        val candidates = try {
            adapter.bondedDevices.filter {
                it.type == BluetoothDevice.DEVICE_TYPE_LE || it.type == BluetoothDevice.DEVICE_TYPE_DUAL
            }
        } catch (denied: SecurityException) {
            onStatus("Bluetooth permission not granted")
            return
        }

        if (candidates.isEmpty()) {
            onStatus("No paired remote found — pair the D10 in Bluetooth settings")
            return
        }

        onStatus("Looking for the remote…")
        candidates.forEach(::connect)
    }

    fun stop() {
        connections.forEach {
            try {
                it.close()
            } catch (ignored: SecurityException) {
                // Losing the handle on the way out is not worth crashing over.
            }
        }
        connections.clear()
        subscribed = false
    }

    private fun connect(device: BluetoothDevice) {
        try {
            // autoConnect so the link comes back by itself when the remote sleeps
            // between points and wakes on the next press.
            val gatt = device.connectGatt(context, true, callback)
            if (gatt != null) connections.add(gatt)
        } catch (denied: SecurityException) {
            onStatus("Bluetooth permission not granted")
        }
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                try {
                    gatt.discoverServices()
                } catch (denied: SecurityException) {
                    onStatus("Bluetooth permission not granted")
                }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED && subscribed) {
                // autoConnect reconnects on its own; say so rather than going quiet.
                onStatus("Remote asleep — press a button to wake it")
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val characteristic = gatt.getService(SERVICE)?.getCharacteristic(NOTIFY)

            if (characteristic == null) {
                // Some other bonded device, not the remote.
                try {
                    gatt.disconnect()
                    gatt.close()
                } catch (ignored: SecurityException) {
                }
                connections.remove(gatt)
                return
            }

            subscribe(gatt, characteristic)
        }

        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
        ) {
            deliver(characteristic, value)
        }

        @Deprecated("Kept for Android 12 and earlier, which call this form.")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
        ) {
            deliver(characteristic, characteristic.value ?: ByteArray(0))
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                subscribed = true
                onStatus("Remote connected — press A or B")
            } else {
                onStatus("Could not subscribe to the remote (status $status)")
            }
        }
    }

    private fun subscribe(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
        try {
            gatt.setCharacteristicNotification(characteristic, true)

            // Telling the characteristic to notify is only half of it; the
            // descriptor is what actually turns the stream on.
            val config = characteristic.getDescriptor(CLIENT_CONFIG)
            if (config == null) {
                onStatus("Remote found, but it will not report button presses")
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
            onStatus("Bluetooth permission not granted")
        }
    }

    private fun deliver(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        if (characteristic.uuid != NOTIFY || value.isEmpty()) return

        val hex = value.joinToString("") { "%02x".format(it) }
        Log.d(TAG, "notify $hex")
        onPayload(hex)
    }
}
