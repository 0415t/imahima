import Foundation

enum DeviceKeyFailure: String, Error {
  case unsupported, unavailable, uninitialized, initializing, corrupt
  case keyLoss = "key-loss"
  case invalidRequest = "invalid-request"
}

enum DeviceProof {
  private static let purposes: Set<String> = ["enroll", "register", "fence", "lookup", "confirm_auth_revocation", "begin_logout"]
  private static let recoveryPurposes: Set<String> = ["discover", "confirm", "ack"]
  static func matches(_ text: String, _ regex: String) -> Bool {
    text.range(of: "\\A(?:\(regex))\\z", options: .regularExpression) != nil
  }
  static func validUuid(_ text: String) -> Bool {
    matches(text, "[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
  }
  static func encode(_ bytes: Data) -> String {
    bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private static func issuer(_ value: String) throws -> String {
    guard value.utf8.count <= 512, value.utf8.allSatisfy({ (33...126).contains($0) }),
          let url = URLComponents(string: value), ["https", "http"].contains(url.scheme ?? ""),
          let host = url.host, !host.isEmpty, url.user == nil, url.password == nil, url.query == nil,
          url.fragment == nil, url.percentEncodedPath == "/auth/v1" else { throw DeviceKeyFailure.invalidRequest }
    return value
  }

  private static func nonce(_ value: String) throws -> String {
    guard matches(value, "[A-Za-z0-9_-]{43}"),
          let bytes = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "="),
          encode(bytes) == value else { throw DeviceKeyFailure.invalidRequest }
    return value
  }

  private static func decimal(_ value: String) throws -> String {
    guard matches(value, "[1-9][0-9]{0,18}"), Int64(value) != nil else { throw DeviceKeyFailure.invalidRequest }
    return value
  }

  private static func frame(_ fields: [String?]) -> Data {
    Data(fields.map { field in field.map { "\($0.utf8.count):\($0)" } ?? "-:" }.joined().utf8)
  }

  static func message(_ request: [String: String], installation: String, publicKey: String) throws -> Data {
    func field(_ name: String) throws -> String {
      guard let value = request[name] else { throw DeviceKeyFailure.invalidRequest }
      return value
    }
    func id(_ name: String) throws -> String {
      let value = try field(name)
      guard validUuid(value) else { throw DeviceKeyFailure.invalidRequest }
      return value
    }
    let action = try field("action")
    let bootstrap = action == "enroll-installation"
    let challenge = action == "challenge"
    guard bootstrap || challenge || purposes.contains(action) else { throw DeviceKeyFailure.invalidRequest }
    let purpose = challenge ? try field("purpose") : action
    guard !challenge || purposes.contains(purpose) else { throw DeviceKeyFailure.invalidRequest }
    let generational = purposes.contains(action) && action != "enroll"
    let registration = action == "register"
    var allowed: Set<String> = ["action", "issuer", "userId", "sessionId", "nonce"]
    if !bootstrap { allowed.insert("keyVersion") }
    if challenge { allowed.insert("purpose") }
    if generational { allowed.formUnion(["generation", "operationId"]) }
    if registration { allowed.formUnion(["token", "platform", "deviceName"]) }
    guard Set(request.keys).isSubset(of: allowed) else { throw DeviceKeyFailure.invalidRequest }
    let deviceName = request["deviceName"]
    if let name = deviceName {
      guard name.utf16.count <= 128, name.range(of: "\\p{C}", options: .regularExpression) == nil,
            name.utf8.elementsEqual(name.precomposedStringWithCanonicalMapping.utf8)
      else { throw DeviceKeyFailure.invalidRequest }
    }
    let token = registration ? try field("token") : nil
    let platform = registration ? try field("platform") : nil
    if let token = token {
      guard token.utf8.count <= 256, matches(token, "(Expo|Exponent)PushToken\\[[A-Za-z0-9_-]+\\]"),
            platform == "ios" else { throw DeviceKeyFailure.invalidRequest }
    }
    return try frame([
      "imahima-device-proof-v1", issuer(field("issuer")), id("userId"), id("sessionId"), installation, action, purpose,
      bootstrap ? "1" : decimal(field("keyVersion")), generational ? decimal(field("generation")) : nil,
      generational ? id("operationId") : nil, nonce(field("nonce")), token, platform, deviceName, bootstrap ? publicKey : nil
    ])
  }

  static func recoveryMessage(_ request: [String: String], installation: String) throws -> Data {
    guard let action = request["action"], let rawIssuer = request["issuer"],
          let keyVersion = request["keyVersion"], let rawNonce = request["nonce"]
    else { throw DeviceKeyFailure.invalidRequest }
    let purpose = action == "challenge" ? (request["purpose"] ?? "") : action
    guard recoveryPurposes.contains(purpose) else { throw DeviceKeyFailure.invalidRequest }
    var expected: Set<String> = ["action", "issuer", "keyVersion", "nonce"]
    if action == "challenge" { expected.formUnion(["purpose", "issuedAt"]) }
    if purpose != "discover" { expected.insert("recoveryId") }
    guard Set(request.keys) == expected else { throw DeviceKeyFailure.invalidRequest }
    let recoveryId = request["recoveryId"]
    let issuedAt = request["issuedAt"]
    if let recoveryId, !validUuid(recoveryId) { throw DeviceKeyFailure.invalidRequest }
    if let issuedAt, !matches(issuedAt, "[1-9][0-9]{0,11}") { throw DeviceKeyFailure.invalidRequest }
    return try frame(["imahima-logout-recovery-v1", issuer(rawIssuer), installation, decimal(keyVersion),
      action, purpose, recoveryId, nonce(rawNonce), issuedAt])
  }
}
