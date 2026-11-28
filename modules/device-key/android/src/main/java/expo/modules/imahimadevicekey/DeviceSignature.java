package expo.modules.imahimadevicekey;

import java.math.BigInteger;
import java.util.Arrays;

final class DeviceSignature {
  private static final BigInteger ORDER =
      new BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16);

  private DeviceSignature() {}

  static byte[] coordinate(BigInteger value) {
    require(value.signum() >= 0 && value.bitLength() <= 256);
    byte[] bytes = value.toByteArray();
    int start = bytes.length == 33 ? 1 : 0;
    byte[] result = new byte[32];
    System.arraycopy(bytes, start, result, 32 - (bytes.length - start), bytes.length - start);
    return result;
  }

  static byte[] fromDer(byte[] der) {
    require(der.length >= 8 && der.length <= 72 && der[0] == 0x30 && der[1] == der.length - 2);
    byte[] result = new byte[64];
    int offset = 2;
    for (int scalar = 0; scalar < 2; scalar++) {
      require(offset + 2 <= der.length && der[offset++] == 2);
      int size = der[offset++];
      require(size >= 1 && size <= 33 && offset + size <= der.length && der[offset] >= 0);
      require(size == 1 || der[offset] != 0 || der[offset + 1] < 0);
      BigInteger value = new BigInteger(Arrays.copyOfRange(der, offset, offset + size));
      require(value.signum() > 0 && value.compareTo(ORDER) < 0);
      System.arraycopy(coordinate(value), 0, result, scalar * 32, 32);
      offset += size;
    }
    require(offset == der.length);
    return result;
  }

  private static void require(boolean condition) {
    if (!condition) throw new IllegalArgumentException("Invalid P-256 value");
  }
}
