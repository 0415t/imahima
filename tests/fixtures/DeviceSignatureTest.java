package expo.modules.imahimadevicekey;

import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.Base64;
import java.util.HexFormat;

public final class DeviceSignatureTest {
  public static void main(String[] args) throws Exception {
    var hex = HexFormat.of();
    var raw = DeviceSignature.fromDer(hex.parseHex("300702020080020101"));
    if (!hex.formatHex(raw).equals("00".repeat(31) + "80" + "00".repeat(31) + "01")) {
      throw new AssertionError("DER positive sign padding");
    }
    for (String invalid : new String[] {
      "3006020180020101", "300702020001020101", "3006020100020101",
      "300702010102010100", "308106020101020101", "300702210001020101"
    }) {
      try {
        DeviceSignature.fromDer(hex.parseHex(invalid));
        throw new AssertionError("Accepted malformed DER");
      } catch (IllegalArgumentException expected) {
        // Expected.
      }
    }
    var generator = KeyPairGenerator.getInstance("EC");
    generator.initialize(new ECGenParameterSpec("secp256r1"));
    var pair = generator.generateKeyPair(); // JVM test only. Never used by the Expo module.
    var publicKey = (ECPublicKey) pair.getPublic();
    var point = new byte[65];
    point[0] = 4;
    System.arraycopy(DeviceSignature.coordinate(publicKey.getW().getAffineX()), 0, point, 1, 32);
    System.arraycopy(DeviceSignature.coordinate(publicKey.getW().getAffineY()), 0, point, 33, 32);
    var signer = Signature.getInstance("SHA256withECDSA");
    signer.initSign(pair.getPrivate());
    signer.update(hex.parseHex(args[0]));
    var encoder = Base64.getUrlEncoder().withoutPadding();
    System.out.println(encoder.encodeToString(point));
    System.out.println(encoder.encodeToString(DeviceSignature.fromDer(signer.sign())));
  }
}
