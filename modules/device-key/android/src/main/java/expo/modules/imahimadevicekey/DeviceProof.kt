package expo.modules.imahimadevicekey

import android.util.Base64
import java.net.URI
import java.text.Normalizer

internal object DeviceProof {
  private val actions = setOf("enroll", "register", "fence", "lookup", "confirm_auth_revocation")
  private val generations = actions - "enroll"
  private val uuid = Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
  private val decimal = Regex("[1-9][0-9]{0,18}")
  private val token = Regex("(Expo|Exponent)PushToken\\[[A-Za-z0-9_-]+\\]")
  private val base64url = Regex("[A-Za-z0-9_-]+")
  private val categoryC = Regex("\\p{C}")

  fun validUuid(value: String) = uuid.matches(value)
  fun encode(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  fun message(request: Map<String, String>, installation: String, publicKey: String): ByteArray {
    fun field(name: String) = requireNotNull(request[name])
    fun number(name: String) = field(name).also { require(decimal.matches(it) && it.toLongOrNull() != null) }
    fun id(name: String) = field(name).also { require(validUuid(it)) }
    val action = field("action")
    val bootstrap = action == "enroll-installation"
    val challenge = action == "challenge"
    require(bootstrap || challenge || action in actions)
    val purpose = if (challenge) field("purpose").also { require(it in actions) } else action
    val issuer = field("issuer")
    require(issuer.length <= 512 && issuer.all { it.code in 33..126 })
    val url = URI.create(issuer)
    require(url.scheme in setOf("https", "http") && url.host != null && url.userInfo == null &&
      url.query == null && url.fragment == null && url.rawPath == "/auth/v1")
    val nonce = field("nonce")
    require(nonce.length == 43 && base64url.matches(nonce) && encode(Base64.decode(nonce, Base64.URL_SAFE)) == nonce)
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
    val fields = listOf(
      "imahima-device-proof-v1", issuer, id("userId"), id("sessionId"), installation, action, purpose,
      if (bootstrap) "1" else number("keyVersion"),
      if (generational) number("generation") else null, if (generational) id("operationId") else null,
      nonce, if (registration) field("token").also { require(it.length <= 256 && token.matches(it)) } else null,
      if (registration) field("platform").also { require(it == "android") } else null,
      deviceName, if (bootstrap) publicKey else null
    )
    return fields.joinToString("") { it?.let { value -> "${value.toByteArray(Charsets.UTF_8).size}:$value" } ?: "-:" }
      .toByteArray(Charsets.UTF_8)
  }
}
