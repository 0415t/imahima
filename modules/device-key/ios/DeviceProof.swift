import Foundation

enum DeviceKeyFailure: String, Error {
  case unsupported, unavailable, uninitialized, initializing, corrupt
  case keyLoss = "key-loss"
  case invalidRequest = "invalid-request"
}

enum DeviceProof {
  private static let purposes: Set<String> = ["enroll", "register", "fence", "lookup", "confirm_auth_revocation"]
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
    func number(_ name: String) throws -> String {
      let value = try field(name)
      guard matches(value, "[1-9][0-9]{0,18}"), Int64(value) != nil else { throw DeviceKeyFailure.invalidRequest }
      return value
    }
    let action = try field("action")
    let bootstrap = action == "enroll-installation"
    let challenge = action == "challenge"
    guard bootstrap || challenge || purposes.contains(action) else { throw DeviceKeyFailure.invalidRequest }
    let purpose = challenge ? try field("purpose") : action
    guard !challenge || purposes.contains(purpose) else { throw DeviceKeyFailure.invalidRequest }
    let issuer = try field("issuer")
    guard issuer.utf8.count <= 512, issuer.utf8.allSatisfy({ (33...126).contains($0) }),
          let url = URLComponents(string: issuer), ["https", "http"].contains(url.scheme ?? ""),
          let host = url.host, !host.isEmpty, url.user == nil, url.password == nil, url.query == nil,
          url.fragment == nil, url.percentEncodedPath == "/auth/v1" else { throw DeviceKeyFailure.invalidRequest }
    let nonce = try field("nonce")
    guard matches(nonce, "[A-Za-z0-9_-]{43}"),
          let nonceBytes = Data(base64Encoded: nonce.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "="),
          encode(nonceBytes) == nonce else { throw DeviceKeyFailure.invalidRequest }
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
    let fields: [String?] = try [
      "imahima-device-proof-v1", issuer, id("userId"), id("sessionId"), installation, action, purpose,
      bootstrap ? "1" : number("keyVersion"), generational ? number("generation") : nil,
      generational ? id("operationId") : nil, nonce, token, platform, deviceName, bootstrap ? publicKey : nil
    ]
    return Data(fields.map { field in field.map { "\($0.utf8.count):\($0)" } ?? "-:" }.joined().utf8)
  }
}
