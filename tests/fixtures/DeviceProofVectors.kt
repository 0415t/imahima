package expo.modules.imahimadevicekey

import java.io.File

// Run alongside DeviceProof on Android. A standalone JVM needs a test-only
// android.util.Base64 implementation; the app supplies the platform API.
object DeviceProofVectors {
  @JvmStatic
  fun main(args: Array<String>) {
    var checked = 0
    File(args[0]).forEachLine(Charsets.UTF_8) { row ->
      val cells = row.split('\t')
      val mode = cells[1]
      if (mode != "ios") {
        val request = cells.drop(4).associate { field ->
          field.substringBefore('=') to field.substringAfter('=')
        }
        val actual = try {
          if (mode == "recovery") DeviceProof.recoveryMessage(request, cells[2])
          else DeviceProof.message(request, cells[2], "")
        } catch (_: IllegalArgumentException) { null }
        check(if (cells[3] == "reject") actual == null else
          actual?.contentEquals(cells[3].toByteArray(Charsets.UTF_8)) == true) { cells[0] }
        checked++
      }
    }
    check(checked > 0)
    println("Kotlin codec vectors: $checked")
  }
}
