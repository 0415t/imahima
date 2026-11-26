import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type * as DeviceKey from '../modules/device-key';
import { deviceSigningBytes } from '../server/device-verifier';
import { loadSource } from './helpers/load-source';

const fields = [
  'http://127.0.0.1/auth/v1', '01000000-0000-0000-0000-000000000001',
  '02000000-0000-0000-0000-000000000002', '03000000-0000-0000-0000-000000000003',
  'register', 'register', '1', '9007199254740993', '04000000-0000-0000-0000-000000000004',
  'A'.repeat(43), 'ExpoPushToken[offline]', 'android', '\u00e9\u7aef\u672b', null,
];
const vector = '23:imahima-device-proof-v124:http://127.0.0.1/auth/v1' +
  '36:01000000-0000-0000-0000-00000000000136:02000000-0000-0000-0000-000000000002' +
  '36:03000000-0000-0000-0000-0000000000038:register8:register1:116:9007199254740993' +
  '36:04000000-0000-0000-0000-00000000000443:' + 'A'.repeat(43) +
  '22:ExpoPushToken[offline]7:android8:\u00e9\u7aef\u672b-:';

test('canonical proof uses UTF-8 byte lengths and exact bigint strings', () => {
  assert.equal(deviceSigningBytes(fields).toString(), vector);
  assert.notDeepEqual(deviceSigningBytes(fields.map(field => field?.normalize('NFD') ?? null)),
    Buffer.from(vector));
});

test('Express signing bytes accept SEC1 and P1363 and reject modified data', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const point = spki.subarray(-65);
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), point,
  ]), format: 'der', type: 'spki' });
  const signature = sign('sha256', Buffer.from(vector), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
  assert.equal(point[0], 4);
  assert.equal(signature.length, 64);
  assert.equal(verify('sha256', deviceSigningBytes(fields), { key, dsaEncoding: 'ieee-p1363' }, signature), true);
  assert.equal(verify('sha256', deviceSigningBytes([...fields.slice(0, -1), '']), { key, dsaEncoding: 'ieee-p1363' }, signature), false);
});

test('Expo Go or web without the native module never generates or signs a key', async () => {
  const deviceKey = loadSource<typeof DeviceKey>('modules/device-key/index.ts', {
    expo: { requireOptionalNativeModule: () => null },
  });
  assert.equal((await deviceKey.getIdentity()).status, 'unsupported');
  assert.equal((await deviceKey.createInstallation()).status, 'unsupported');
  assert.equal((await deviceKey.signDeviceProof({
    action: 'enroll-installation', issuer: fields[0]!, userId: fields[1]!, sessionId: fields[2]!, nonce: fields[10]!,
  })).status, 'unsupported');
});
