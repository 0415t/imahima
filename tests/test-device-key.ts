import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as DeviceKey from '../modules/device-key';
import { deviceSigningBytes, logoutRecoverySigningBytes } from '../server/device-verifier';
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
  assert.equal((await deviceKey.signLogoutRecoveryProof({
    action: 'discover', issuer: fields[0]!, keyVersion: '1', nonce: fields[10]!,
  })).status, 'unsupported');
});

const vectors = readFileSync('tests/fixtures/device-proof-vectors.tsv', 'utf8').trimEnd().split(/\r?\n/).map(row => {
  const [name, mode, installation, expected, ...entries] = row.split('\t');
  const input = Object.fromEntries(entries.map(entry => {
    const split = entry.indexOf('=');
    return [entry.slice(0, split), entry.slice(split + 1)];
  }));
  assert.ok(name && mode && installation && expected);
  return { name, mode, installation, expected, input };
});

test('shared native vectors agree with both Express signature domains', () => {
  const accepted = vectors.filter(({ expected }) => expected !== 'reject');
  assert.equal(accepted.length, 10);
  for (const { name, mode, installation, expected, input } of accepted) {
    const common = [input.action, input.purpose ?? input.action];
    const actual = mode === 'recovery'
      ? logoutRecoverySigningBytes([input.issuer, installation, input.keyVersion, ...common,
        input.recoveryId ?? null, input.nonce, input.issuedAt ?? null])
      : deviceSigningBytes([input.issuer, input.userId, input.sessionId, installation, ...common,
        input.keyVersion, input.generation ?? null, input.operationId ?? null, input.nonce,
        input.token ?? null, input.platform ?? null, input.deviceName ?? null, null]);
    assert.equal(actual.toString('utf8'), expected, name);
  }
});

test('recovery signature rejects the normal domain and changed scope', () => {
  const fixture = vectors.find(row => row.name === 'issue-confirm');
  assert.ok(fixture);
  const { input, installation, expected } = fixture;
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const scope = [input.issuer, installation, input.keyVersion, input.action, input.purpose,
    input.recoveryId, input.nonce, input.issuedAt];
  const signature = sign('sha256', Buffer.from(expected), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
  const key = { key: pair.publicKey, dsaEncoding: 'ieee-p1363' as const };
  assert.equal(verify('sha256', logoutRecoverySigningBytes(scope), key, signature), true);
  assert.equal(verify('sha256', deviceSigningBytes(scope), key, signature), false);
  const normalSignature = sign('sha256', deviceSigningBytes(scope),
    { key: pair.privateKey, dsaEncoding: 'ieee-p1363' });
  assert.equal(verify('sha256', logoutRecoverySigningBytes(scope), key, normalSignature), false);
  for (const [index, field] of scope.entries()) {
    const changed = scope.slice();
    changed[index] = field + 'x';
    assert.equal(verify('sha256', logoutRecoverySigningBytes(changed), key, signature), false);
  }
});

test('recovery passes no JWT fields and propagates key loss without creating a key', async () => {
  const input: DeviceKey.LogoutRecoveryProofRequest = {
    action: 'confirm', issuer: fields[0]!, keyVersion: '1', nonce: fields[10]!, recoveryId: fields[9]!,
  };
  let calls = 0;
  const deviceKey = loadSource<typeof DeviceKey>('modules/device-key/index.ts', {
    expo: {
      requireOptionalNativeModule: () => ({
        createInstallation: () => assert.fail('Recovery cannot generate a replacement key'),
        signDeviceProof: () => assert.fail('Recovery must use its own native entry point'),
        signLogoutRecoveryProof: (request: DeviceKey.LogoutRecoveryProofRequest) => {
          assert.equal(request, input);
          assert.equal('userId' in request || 'sessionId' in request, false);
          calls++;
          return Promise.resolve({ status: 'key-loss' });
        },
      }),
    },
  });
  assert.equal((await deviceKey.signLogoutRecoveryProof(input)).status, 'key-loss');
  assert.equal(calls, 1);
  const olderBuild = loadSource<typeof DeviceKey>('modules/device-key/index.ts', {
    expo: { requireOptionalNativeModule: () => ({ signDeviceProof: () => assert.fail('Wrong signature domain') }) },
  });
  assert.equal((await olderBuild.signLogoutRecoveryProof(input)).status, 'unsupported');
});
