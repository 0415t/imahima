package expo.modules.imahimadevicekey

import android.util.Base64
import java.net.URI
import java.text.Normalizer

internal object DeviceProof {
  private val actions = setOf("enroll", "register", "fence", "lookup", "confirm_auth_revocation", "begin_logout")
  private val recoveryPurposes = setOf("discover", "confirm", "ack")
  private val generations = actions - "enroll"
  private val uuid = Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
  private val decimal = Regex("[1-9][0-9]{0,18}")
  private val token = Regex("(Expo|Exponent)PushToken\\[[A-Za-z0-9_-]+\\]")
  private val base64url = Regex("[A-Za-z0-9_-]+")
  private val categoryC = Regex("\\p{C}")

  fun validUuid(value: String) = uuid.matches(value)
  fun encode(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  private fun issuer(value: String): String {
    require(value.length <= 512 && value.all { it.code in 33..126 })
    val url = URI.create(value)
    require(url.scheme in setOf("https", "http") && url.host != null && url.userInfo == null &&
      url.query == null && url.fragment == null && url.rawPath == "/auth/v1")
    return value
  }

  private fun nonce(value: String): String {
    require(value.length == 43 && base64url.matches(value) && encode(Base64.decode(value, Base64.URL_SAFE)) == value)
    return value
  }

  private fun number(value: String): String {
    require(decimal.matches(value) && value.toLongOrNull() != null)
    return value
  }

  private fun frame(vararg fields: String?): ByteArray =
    fields.joinToString("") { it?.let { value -> "${value.toByteArray(Charsets.UTF_8).size}:$value" } ?: "-:" }
      .toByteArray(Charsets.UTF_8)

  fun message(request: Map<String, String>, installation: String, publicKey: String): ByteArray {
    fun field(name: String) = requireNotNull(request[name])
    fun id(name: String) = field(name).also { require(validUuid(it)) }
    val action = field("action")
    val bootstrap = action == "enroll-installation"
    val challenge = action == "challenge"
    require(bootstrap || challenge || action in actions)
    val purpose = if (challenge) field("purpose").also { require(it in actions) } else action
    val generational = action in generations
    val registration = action == "register"
    val allowed = mutableSetOf("action", "issuer", "userId", "sessionId", "nonce")
    if (!bootstrap) allowed.add("keyVersion")
    if (challenge) allowed.add("purpose")
    if (generational) allowed.addAll(listOf("generation", "operationId"))
    if (registration) allowed.addAll(listOf("token", "platform", "deviceName"))
    require(request.keys.all { it in allowed })
    val deviceName = request["deviceName"]?.also {
      require(it.length <= 128 && !categoryC.containsMatchIn(it) && Normalizer.isNormalized(it, Normalizer.Form.NFC))
    }
    return frame(
      "imahima-device-proof-v1", issuer(field("issuer")), id("userId"), id("sessionId"), installation, action, purpose,
      if (bootstrap) "1" else number(field("keyVersion")),
      if (generational) number(field("generation")) else null, if (generational) id("operationId") else null,
      nonce(field("nonce")), if (registration) field("token").also { require(it.length <= 256 && token.matches(it)) } else null,
      if (registration) field("platform").also { require(it == "android") } else null,
      deviceName, if (bootstrap) publicKey else null
    )
  }

  fun recoveryMessage(request: Map<String, String>, installation: String): ByteArray {
    fun field(name: String) = requireNotNull(request[name])
    val action = field("action")
    val challenge = action == "challenge"
    val purpose = if (challenge) field("purpose") else action
    require(purpose in recoveryPurposes)
    val expected = mutableSetOf("action", "issuer", "keyVersion", "nonce")
    if (challenge) expected.addAll(listOf("purpose", "issuedAt"))
    if (purpose != "discover") expected.add("recoveryId")
    require(request.keys == expected)
    val recoveryId = request["recoveryId"]?.also { require(validUuid(it)) }
    val issuedAt = request["issuedAt"]?.also { require(Regex("[1-9][0-9]{0,11}").matches(it)) }
    return frame("imahima-logout-recovery-v1", issuer(field("issuer")), installation,
      number(field("keyVersion")), action, purpose, recoveryId, nonce(field("nonce")), issuedAt)
  }
}
