import Foundation

// Compile with DeviceProof.swift to exercise the production codec without hardware.
@main
enum DeviceProofVectors {
  static func main() throws {
    let rows = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    var checked = 0
    for row in rows.split(whereSeparator: \.isNewline) {
      let cells = row.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
      let mode = cells[1]
      if mode == "android" { continue }
      let request = Dictionary(uniqueKeysWithValues: cells.dropFirst(4).map { field in
        let part = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        return (String(part[0]), String(part[1]))
      })
      do {
        let actual = try mode == "recovery" ?
          DeviceProof.recoveryMessage(request, installation: cells[2]) :
          DeviceProof.message(request, installation: cells[2], publicKey: "")
        precondition(cells[3] != "reject" && actual == Data(cells[3].utf8), cells[0])
      } catch DeviceKeyFailure.invalidRequest {
        precondition(cells[3] == "reject", cells[0])
      }
      checked += 1
    }
    precondition(checked > 0)
    print("Swift codec vectors: \(checked)")
  }
}
