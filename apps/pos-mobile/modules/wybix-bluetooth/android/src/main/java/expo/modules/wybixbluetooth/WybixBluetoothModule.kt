package expo.modules.wybixbluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Bluetooth clásico (SPP / RFCOMM) para impresoras térmicas de tickets.
 *
 * Por qué un módulo propio y no una librería: las opciones de npm para
 * Bluetooth clásico (react-native-bluetooth-classic, react-native-bluetooth-
 * escpos-printer, etc.) son módulos del puente antiguo, sin config plugin y
 * con mantenimiento irregular; la app corre con la arquitectura nueva. Lo que
 * hace falta para imprimir es poco (listar emparejados, abrir un socket SPP,
 * escribir bytes, cerrar) y así no hay dependencias nativas de terceros.
 *
 * Contrato:
 *   - Solo dispositivos YA emparejados en Ajustes de Android; no escanea.
 *   - Cada `enviar` conecta, escribe y cierra. No se deja la conexión abierta:
 *     si la impresora se apaga o se duerme entre ventas, el siguiente ticket
 *     simplemente vuelve a conectar (la "reconexión" es el caso normal).
 *   - Los trabajos van en UNA cola (un hilo): nunca dos conexiones a la vez.
 *   - Errores con código estable (BT_*) para que JavaScript decida si reintenta.
 */
class WybixBluetoothModule : Module() {
  private val cola = Executors.newSingleThreadExecutor()
  private val reloj = Executors.newSingleThreadScheduledExecutor()

  override fun definition() = ModuleDefinition {
    Name("WybixBluetooth")

    OnDestroy {
      cola.shutdownNow()
      reloj.shutdownNow()
    }

    AsyncFunction("estado") {
      val a = adaptador()
      when {
        a == null -> "NO_SOPORTADO"
        a.isEnabled -> "ENCENDIDO"
        else -> "APAGADO"
      }
    }

    AsyncFunction("emparejados") {
      val a = listo()
      try {
        @SuppressLint("MissingPermission")
        val lista = a.bondedDevices.orEmpty().map { d ->
          mapOf(
            "nombre" to (d.name ?: d.address),
            "direccion" to d.address,
            // Clase "imaging" = impresoras. Algunas genéricas no la reportan,
            // por eso no se filtra; solo se ordenan primero.
            "esImpresora" to (d.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.IMAGING),
          )
        }
        lista.sortedWith(compareBy({ it["esImpresora"] != true }, { (it["nombre"] as String).lowercase() }))
      } catch (e: SecurityException) {
        throw CodedException("BT_PERMISO", "Falta el permiso de Bluetooth.", e)
      }
    }

    AsyncFunction("enviar") { direccion: String, datos: List<Int>, timeoutMs: Int, promise: Promise ->
      cola.execute {
        try {
          enviarBloqueante(direccion, ByteArray(datos.size) { datos[it].toByte() }, timeoutMs.toLong())
          promise.resolve(null)
        } catch (e: CodedException) {
          promise.reject(e)
        } catch (e: SecurityException) {
          promise.reject(CodedException("BT_PERMISO", "Falta el permiso de Bluetooth.", e))
        } catch (e: Throwable) {
          promise.reject(CodedException("BT_ENVIO", e.message ?: "Error de Bluetooth.", e))
        }
      }
    }
  }

  private fun adaptador(): BluetoothAdapter? {
    val ctx = appContext.reactContext ?: return null
    return (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
  }

  private fun tienePermiso(nombre: String): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val ctx = appContext.reactContext ?: return false
    return ctx.checkSelfPermission(nombre) == PackageManager.PERMISSION_GRANTED
  }

  private fun listo(): BluetoothAdapter {
    val a = adaptador() ?: throw CodedException("BT_NO_SOPORTADO", "Este dispositivo no tiene Bluetooth.", null)
    if (!tienePermiso("android.permission.BLUETOOTH_CONNECT")) {
      throw CodedException("BT_PERMISO", "Falta el permiso de Bluetooth.", null)
    }
    if (!a.isEnabled) throw CodedException("BT_APAGADO", "El Bluetooth está apagado.", null)
    return a
  }

  @SuppressLint("MissingPermission")
  private fun enviarBloqueante(direccion: String, datos: ByteArray, timeoutMs: Long) {
    val a = listo()
    if (!BluetoothAdapter.checkBluetoothAddress(direccion)) {
      throw CodedException("BT_DIRECCION", "La dirección de la impresora no es válida.", null)
    }
    val disp = a.getRemoteDevice(direccion)
    if (disp.bondState != BluetoothDevice.BOND_BONDED) {
      throw CodedException("BT_NO_EMPAREJADA", "La impresora ya no está emparejada.", null)
    }
    // Una búsqueda activa vuelve lenta o imposible la conexión RFCOMM.
    if (tienePermiso("android.permission.BLUETOOTH_SCAN")) {
      try { a.cancelDiscovery() } catch (_: SecurityException) { }
    }

    val actual = AtomicReference<BluetoothSocket?>(null)
    val vencido = AtomicBoolean(false)
    // connect() puede bloquear ~12 s; cerrar el socket desde otro hilo lo corta.
    val alarma = reloj.schedule({
      vencido.set(true)
      try { actual.get()?.close() } catch (_: IOException) { }
    }, timeoutMs, TimeUnit.MILLISECONDS)

    try {
      val socket = conectar(disp, actual, vencido)
      try {
        val salida = socket.outputStream
        var i = 0
        while (i < datos.size) {
          val n = minOf(BLOQUE, datos.size - i)
          salida.write(datos, i, n)
          salida.flush()
          i += n
          // Impresoras genéricas tienen búfer chico: a ráfagas pierden bytes.
          if (i < datos.size) Thread.sleep(PAUSA_BLOQUE_MS)
        }
        // Si se cierra de inmediato, algunas cortan el final (el corte de papel).
        Thread.sleep(ESPERA_FINAL_MS)
      } catch (e: IOException) {
        // BT_ENVIO (no BT_TIEMPO) aunque haya vencido: ya pudo salir parte del
        // ticket, así que JavaScript no lo reintenta solo (evita tickets dobles).
        throw CodedException("BT_ENVIO", "Se perdió la conexión con la impresora al imprimir.", e)
      }
    } finally {
      alarma.cancel(false)
      try { actual.get()?.close() } catch (_: IOException) { }
    }
  }

  /** SPP seguro, luego inseguro, luego canal 1 directo (impresoras chinas que no anuncian SDP). */
  @SuppressLint("MissingPermission")
  private fun conectar(
    d: BluetoothDevice,
    actual: AtomicReference<BluetoothSocket?>,
    vencido: AtomicBoolean,
  ): BluetoothSocket {
    val formas: List<() -> BluetoothSocket> = listOf(
      { d.createRfcommSocketToServiceRecord(SPP) },
      { d.createInsecureRfcommSocketToServiceRecord(SPP) },
      {
        d.javaClass.getMethod("createRfcommSocket", Int::class.javaPrimitiveType)
          .invoke(d, 1) as BluetoothSocket
      },
    )
    var ultimo: Exception? = null
    for (crear in formas) {
      if (vencido.get()) break
      val s = try { crear() } catch (e: Exception) { ultimo = e; continue }
      actual.set(s)
      try {
        s.connect()
        return s
      } catch (e: IOException) {
        ultimo = e
        try { s.close() } catch (_: IOException) { }
      }
    }
    if (vencido.get()) throw CodedException("BT_TIEMPO", "La impresora no respondió a tiempo.", ultimo)
    throw CodedException(
      "BT_CONEXION",
      "No se pudo conectar con la impresora. Revisa que esté encendida y cerca.",
      ultimo,
    )
  }

  companion object {
    private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private const val BLOQUE = 256
    private const val PAUSA_BLOQUE_MS = 30L
    private const val ESPERA_FINAL_MS = 600L
  }
}
