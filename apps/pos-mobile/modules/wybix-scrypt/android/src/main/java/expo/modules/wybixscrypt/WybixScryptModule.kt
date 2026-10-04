package expo.modules.wybixscrypt

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.bouncycastle.crypto.generators.SCrypt
import java.util.Arrays

/**
 * scrypt NATIVO para el PIN de Wybix POS Mobile.
 *
 * Mismo algoritmo y mismos parámetros que el POS de Windows
 * (`crypto.scryptSync(pin, sal, 32, { N: 16384, r: 8, p: 1 })`): la contraseña
 * y la sal entran como TEXTO en UTF-8. Solo cambia dónde se calcula: en Java,
 * en un hilo de fondo (AsyncFunction), en vez de JavaScript interpretado.
 *
 * Nunca se escribe en un log ni el PIN ni el resultado; los arreglos con el
 * PIN se borran al terminar.
 */
class WybixScryptModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("WybixScrypt")

    AsyncFunction("scryptHex") { password: String, salt: String, n: Int, r: Int, p: Int, dkLen: Int ->
      require(n > 1 && (n and (n - 1)) == 0) { "N debe ser potencia de 2" }
      require(r in 1..32 && p in 1..16 && dkLen in 16..128) { "parámetros fuera de rango" }
      val pass = password.toByteArray(Charsets.UTF_8)
      val sal = salt.toByteArray(Charsets.UTF_8)
      try {
        val dk = SCrypt.generate(pass, sal, n, r, p, dkLen)
        val hex = StringBuilder(dk.size * 2)
        for (b in dk) hex.append(String.format("%02x", b.toInt() and 0xff))
        Arrays.fill(dk, 0)
        hex.toString()
      } finally {
        Arrays.fill(pass, 0)
      }
    }
  }
}
