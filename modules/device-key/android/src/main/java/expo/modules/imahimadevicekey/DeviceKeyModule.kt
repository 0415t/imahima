package expo.modules.imahimadevicekey

import android.content.Context
import android.os.Build
import android.os.UserManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.AtomicFile
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID

private class Failure(val status: String) : Exception()
private data class Record(val id: String, val fingerprint: String?)
private data class Identity(val record: Record, val publicKey: String, val protection: String, val key: PrivateKey) {
  fun result() = mapOf("status" to "ready", "installationId" to record.id,
    "publicKey" to publicKey, "protection" to protection)
}

class DeviceKeyModule : Module() {
  // All entry points share one lock, including across module instances.
  companion object { private val monitor = Any() }

  override fun definition() = ModuleDefinition {
    Name("ImahimaDeviceKey")
    AsyncFunction("getIdentity") { perform { getIdentity().result() } }
    AsyncFunction("createInstallation") { perform { createInstallation().result() } }
    AsyncFunction("signDeviceProof") { request: Map<String, String> ->
      perform {
        val identity = getIdentity()
        val message = try { DeviceProof.message(request, identity.record.id, identity.publicKey) }
        catch (_: IllegalArgumentException) { throw Failure("invalid-request") }
        val signature = Signature.getInstance("SHA256withECDSA").run {
          initSign(identity.key)
          update(message)
          DeviceSignature.fromDer(sign())
        }
        mapOf("status" to "ready", "signature" to DeviceProof.encode(signature))
      }
    }
  }

  private fun perform(call: Store.() -> Map<String, String>): Map<String, String> = synchronized(monitor) {
    try {
      val context = appContext.reactContext ?: throw Failure("unavailable")
      if (context.getSystemService(UserManager::class.java)?.isUserUnlocked != true) throw Failure("unavailable")
      Store(context).call()
    } catch (failure: Failure) {
      mapOf("status" to failure.status)
    } catch (error: Exception) {
      val invalidated = generateSequence<Throwable>(error) { it.cause }.take(8)
        .any { it is KeyPermanentlyInvalidatedException }
      mapOf("status" to if (invalidated) "key-loss" else "unavailable")
    }
  }
}

private class Store(context: Context) {
  private val file = File(context.noBackupFilesDir, "imahima-device-key-v1.json")
  private val storage = AtomicFile(file)
  private val marker = AtomicFile(File(context.noBackupFilesDir, "imahima-device-key-v1.marker"))
  private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun readBytes(target: AtomicFile): ByteArray? {
    val base = target.baseFile
    return try {
      target.openRead().use { stream ->
        val data = ByteArray(1025)
        var size = 0
        while (size < data.size) {
          val read = stream.read(data, size, data.size - size)
          if (read < 0) break
          size += read
        }
        data.copyOf(size)
      }
    }
    catch (error: FileNotFoundException) {
      if (base.exists() || File(base.path + ".bak").exists()) throw error
      return null
    }
  }

  private fun read(): Record? {
    val known = readBytes(marker)?.toString(Charsets.UTF_8)
    val raw = readBytes(storage) ?: if (known == null) return null else throw Failure("corrupt")
    if (raw.size > 1024) throw Failure("corrupt")
    return try {
      val json = JSONObject(raw.toString(Charsets.UTF_8))
      val id = json.get("id") as String
      val stage = json.get("stage") as String
      val fingerprint = if (stage == "ready") json.get("fingerprint") as String else null
      if (!DeviceProof.validUuid(id) || stage !in setOf("reserved", "ready") ||
        (fingerprint != null && !Regex("[A-Za-z0-9_-]{43}").matches(fingerprint)) ||
        (known != null && known != id) || (stage == "ready" && known == null) ||
        json.length() != (if (fingerprint == null) 2 else 3)) throw Failure("corrupt")
      Record(id, fingerprint)
    } catch (_: Exception) { throw Failure("corrupt") }
  }

  private fun write(record: Record) {
    val json = JSONObject().put("id", record.id)
      .put("stage", if (record.fingerprint == null) "reserved" else "ready")
      .put("fingerprint", record.fingerprint)
    writeBytes(storage, json.toString().toByteArray(Charsets.UTF_8))
    if (read() != record) throw Failure("unavailable")
  }

  private fun writeBytes(target: AtomicFile, data: ByteArray) {
    val stream = target.startWrite()
    try {
      stream.write(data)
      target.finishWrite(stream)
    } catch (error: Exception) {
      target.failWrite(stream)
      throw error
    }
    // AtomicFile may log a failed rename instead of throwing it.
    if (readBytes(target)?.contentEquals(data) != true) throw Failure("unavailable")
  }

  private fun alias(id: String) = "imahima.device-key.v1.$id"

  private fun keyAt(id: String): PrivateKey? {
    val name = alias(id)
    val key = keys.getKey(name, null)
    if (key == null && keys.getCertificate(name) == null) return null
    return key as? PrivateKey ?: throw Failure("corrupt")
  }

  fun getIdentity(): Identity {
    val record = read() ?: throw Failure("uninitialized")
    if (record.fingerprint == null) throw Failure("initializing")
    return load(record).first
  }

  fun createInstallation(): Identity {
    val record = read() ?: Record(UUID.randomUUID().toString(), null).also {
      if (keyAt(it.id) != null) throw Failure("corrupt")
      write(it)
    }
    if (record.fingerprint != null) return load(record).first
    if (readBytes(marker) == null) writeBytes(marker, record.id.toByteArray(Charsets.UTF_8))
    val keyAlias = alias(record.id)
    if (keyAt(record.id) == null) {
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
        initialize(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .build())
        generateKeyPair()
      }
    }
    val (identity, fingerprint) = load(record)
    val ready = record.copy(fingerprint = fingerprint)
    write(ready)
    return identity.copy(record = ready)
  }

  @Suppress("DEPRECATION") // API 24–30 exposes only the secure-hardware boolean.
  private fun load(record: Record): Pair<Identity, String> {
    val alias = alias(record.id)
    val privateKey = keyAt(record.id) ?: throw Failure("key-loss")
    val info = KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore")
      .getKeySpec(privateKey, KeyInfo::class.java)
    val protection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        else -> throw Failure("unsupported")
      }
    } else {
      if (!info.isInsideSecureHardware) throw Failure("unsupported")
      "secure-hardware"
    }
    if (info.origin != KeyProperties.ORIGIN_GENERATED || info.keySize != 256 ||
      info.purposes != KeyProperties.PURPOSE_SIGN || !info.digests.contentEquals(arrayOf(KeyProperties.DIGEST_SHA256))) {
      throw Failure("corrupt")
    }
    val publicKey = keys.getCertificate(alias)?.publicKey as? ECPublicKey ?: throw Failure("corrupt")
    val point = byteArrayOf(4) + DeviceSignature.coordinate(publicKey.w.affineX) + DeviceSignature.coordinate(publicKey.w.affineY)
    val fingerprint = DeviceProof.encode(MessageDigest.getInstance("SHA-256").digest(point))
    if (record.fingerprint != null && record.fingerprint != fingerprint) throw Failure("corrupt")
    return Identity(record, DeviceProof.encode(point), protection, privateKey) to fingerprint
  }
}
