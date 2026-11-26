import { requireOptionalNativeModule } from 'expo';

type Purpose = 'enroll' | 'register' | 'fence' | 'lookup' | 'confirm_auth_revocation';
type Context = { issuer: string; userId: string; sessionId: string; nonce: string };
type Generational = { generation: string; operationId: string };
export type DeviceProofRequest = Context & (
  | { action: 'enroll-installation' }
  | { action: 'challenge'; purpose: Purpose; keyVersion: string }
  | { action: 'enroll'; keyVersion: string }
  | (Generational & { action: 'fence' | 'lookup' | 'confirm_auth_revocation'; keyVersion: string })
  | (Generational & {
      action: 'register'; keyVersion: string; token: string; platform: 'ios' | 'android'; deviceName?: string;
    })
);

type Failure = {
  status: 'unsupported' | 'unavailable' | 'uninitialized' | 'initializing' | 'key-loss' | 'corrupt' | 'invalid-request';
};
export type DeviceIdentityResult = Failure | {
  status: 'ready'; installationId: string; publicKey: string;
  protection: 'secure-enclave' | 'tee' | 'strongbox' | 'secure-hardware';
};
export type DeviceSignatureResult = Failure | { status: 'ready'; signature: string };

type NativeDeviceKey = {
  getIdentity(): Promise<DeviceIdentityResult>;
  createInstallation(): Promise<DeviceIdentityResult>;
  signDeviceProof(request: DeviceProofRequest): Promise<DeviceSignatureResult>;
};

const native = requireOptionalNativeModule<NativeDeviceKey>('ImahimaDeviceKey');
const unsupported = { status: 'unsupported' } as const;

export async function getIdentity(): Promise<DeviceIdentityResult> {
  return native ? native.getIdentity() : unsupported;
}

export async function createInstallation(): Promise<DeviceIdentityResult> {
  return native ? native.createInstallation() : unsupported;
}

export async function signDeviceProof(request: DeviceProofRequest): Promise<DeviceSignatureResult> {
  return native ? native.signDeviceProof(request) : unsupported;
}
