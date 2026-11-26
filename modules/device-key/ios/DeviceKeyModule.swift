import CryptoKit
import ExpoModulesCore
import Foundation
import Security

public final class DeviceKeyModule: Module {
  private static let queue = DispatchQueue(label: "imahima.device-key")

  public func definition() -> ModuleDefinition {
    Name("ImahimaDeviceKey")
    AsyncFunction("getIdentity") { self.perform { try $0.getIdentity().result } }
    AsyncFunction("createInstallation") { self.perform { try $0.createInstallation().result } }
    AsyncFunction("signDeviceProof") { (request: [String: String]) in
      self.perform { store in
        let identity = try store.getIdentity()
        let message = try DeviceProof.message(request, installation: identity.record.id, publicKey: identity.publicKey)
        var error: Unmanaged<CFError>?
        guard let der = SecKeyCreateSignature(identity.key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error)
        else {
          _ = error?.takeRetainedValue()
          throw DeviceKeyFailure.unavailable
        }
        let signature = try P256.Signing.ECDSASignature(derRepresentation: der as Data).rawRepresentation
        return ["status": "ready", "signature": DeviceProof.encode(signature)]
      }
    }
  }

  private func perform(_ operation: (Store) throws -> [String: String]) -> [String: String] {
    Self.queue.sync {
      do {
        guard SecureEnclave.isAvailable else { throw DeviceKeyFailure.unsupported }
        return try operation(Store())
      } catch let error as DeviceKeyFailure {
        return ["status": error.rawValue]
      } catch {
        return ["status": "unavailable"]
      }
    }
  }
}

private struct StoredIdentity: Codable, Equatable {
  let id: String
  let stage: String
  let fingerprint: String?
}

private struct Identity {
  let record: StoredIdentity
  let key: SecKey
  let publicKey: String
  let fingerprint: String
  var result: [String: String] {
    ["status": "ready", "installationId": record.id, "publicKey": publicKey, "protection": "secure-enclave"]
  }
}

private struct Store {
  private let file: URL
  private let marker: URL

  init() throws {
    let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true)
    var folder = support.appendingPathComponent("imahima-device-key", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try folder.setResourceValues(values)
    file = folder.appendingPathComponent("identity-v1.json")
    marker = folder.appendingPathComponent("identity-v1.marker")
  }

  private func readBytes(_ target: URL) throws -> Data? {
    do {
      let handle = try FileHandle(forReadingFrom: target)
      defer { try? handle.close() }
      return try handle.read(upToCount: 1025) ?? Data()
    } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError {
      return nil
    }
  }

  private func read() throws -> StoredIdentity? {
    let known = try readBytes(marker)
    guard let bytes = try readBytes(file) else {
      if known != nil { throw DeviceKeyFailure.corrupt }
      return nil
    }
    guard bytes.count <= 1024,
          let record = try? JSONDecoder().decode(StoredIdentity.self, from: bytes),
          DeviceProof.validUuid(record.id),
          known == nil || known == Data(record.id.utf8),
          record.stage != "ready" || known != nil,
          (record.stage == "reserved" && record.fingerprint == nil) ||
            (record.stage == "ready" && record.fingerprint.map({ DeviceProof.matches($0, "[A-Za-z0-9_-]{43}") }) == true)
    else { throw DeviceKeyFailure.corrupt }
    return record
  }

  private func write(_ record: StoredIdentity) throws {
    try JSONEncoder().encode(record).write(to: file, options: [.atomic, .completeFileProtection])
    guard try read() == record else { throw DeviceKeyFailure.unavailable }
  }

  private func tag(_ id: String) -> Data { Data("imahima.device-key.v1.\(id)".utf8) }

  private func find(_ id: String) throws -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag(id),
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecMatchLimit as String: kSecMatchLimitOne, kSecReturnRef as String: true
    ]
    var item: CFTypeRef?
    let result = SecItemCopyMatching(query as CFDictionary, &item)
    if result == errSecItemNotFound { return nil }
    guard result == errSecSuccess else { throw DeviceKeyFailure.unavailable }
    guard let item = item, CFGetTypeID(item) == SecKeyGetTypeID() else { throw DeviceKeyFailure.corrupt }
    return (item as! SecKey)
  }

  private func generate(_ id: String) throws -> SecKey {
    var failure: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      .privateKeyUsage, &failure) else {
      _ = failure?.takeRetainedValue()
      throw DeviceKeyFailure.unavailable
    }
    let params: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag(id),
        kSecAttrAccessControl as String: access
      ]
    ]
    guard let key = SecKeyCreateRandomKey(params as CFDictionary, &failure) else {
      _ = failure?.takeRetainedValue()
      throw DeviceKeyFailure.unavailable
    }
    return key
  }

  private func inspect(_ record: StoredIdentity, _ key: SecKey) throws -> Identity {
    guard let attributes = SecKeyCopyAttributes(key) as? [String: Any],
          attributes[kSecAttrTokenID as String] as? String == kSecAttrTokenIDSecureEnclave as String
    else { throw DeviceKeyFailure.unsupported }
    guard attributes[kSecAttrKeySizeInBits as String] as? Int == 256,
          attributes[kSecAttrKeyType as String] as? String == kSecAttrKeyTypeECSECPrimeRandom as String,
          let publicKey = SecKeyCopyPublicKey(key),
          let point = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
          point.count == 65, point.first == 4 else { throw DeviceKeyFailure.corrupt }
    let fingerprint = DeviceProof.encode(Data(SHA256.hash(data: point)))
    if let expected = record.fingerprint, expected != fingerprint { throw DeviceKeyFailure.corrupt }
    return Identity(record: record, key: key, publicKey: DeviceProof.encode(point), fingerprint: fingerprint)
  }

  func getIdentity() throws -> Identity {
    guard let record = try read() else { throw DeviceKeyFailure.uninitialized }
    guard record.stage == "ready" else { throw DeviceKeyFailure.initializing }
    guard let key = try find(record.id) else { throw DeviceKeyFailure.keyLoss }
    return try inspect(record, key)
  }

  func createInstallation() throws -> Identity {
    let record: StoredIdentity
    if let stored = try read() {
      if stored.stage == "ready" { return try getIdentity() }
      record = stored
    } else {
      record = StoredIdentity(id: UUID().uuidString.lowercased(), stage: "reserved", fingerprint: nil)
      guard try find(record.id) == nil else { throw DeviceKeyFailure.corrupt }
      try write(record)
    }
    if try readBytes(marker) == nil {
      let bytes = Data(record.id.utf8)
      try bytes.write(to: marker, options: [.atomic, .completeFileProtection])
      guard try readBytes(marker) == bytes else { throw DeviceKeyFailure.unavailable }
    }
    let key = try find(record.id) ?? generate(record.id)
    let identity = try inspect(record, key)
    let ready = StoredIdentity(id: record.id, stage: "ready", fingerprint: identity.fingerprint)
    try write(ready)
    return Identity(record: ready, key: key, publicKey: identity.publicKey, fingerprint: identity.fingerprint)
  }
}
