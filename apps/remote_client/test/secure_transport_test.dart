import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/json.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/secure_transport.dart';
import 'package:universal_agent_remote/src/security.dart';

/// The shared file is produced from the Node implementation. Every value here
/// must reproduce exactly, or the phone and the computer would silently fail to
/// agree a key.
Future<JsonMap> loadVectors() async {
  final file = File(
      '../../packages/protocol/test_vectors/secure_transport_vectors.json');
  return jsonMap(jsonDecode(await file.readAsString()),
      name: 'secure transport vectors');
}

PairedHost hostFrom(JsonMap vectors) => PairedHost(
      hostId: requireString(vectors, 'hostId'),
      hostPublicKeyPem: requireString(vectors, 'hostPublicKeyPem'),
      endpoint: 'wss://relay.example.com/relay',
      deviceId: requireString(vectors, 'deviceId'),
      devicePrivateKey:
          decodeBase64Url(requireString(vectors, 'devicePrivateKeyRaw')),
      devicePublicKey: ed25519RawPublicKeyFromPem(
          requireString(vectors, 'devicePublicKeyPem')),
      credential: SignedCredential.fromJson(vectors['credential']),
    );

Future<SecureTransportKeys> keysFrom(JsonMap vectors) async {
  final derivation = jsonMap(jsonList(vectors['keyDerivation']).first);
  final input = jsonMap(derivation['input']);
  return deriveSecureTransportKeys(
    sharedSecret: decodeBase64Url(requireString(input, 'sharedSecret')),
    hostId: requireString(input, 'hostId'),
    deviceId: requireString(input, 'deviceId'),
    hostEphemeralPublicKey: requireString(input, 'hostEphemeralPublicKey'),
    deviceEphemeralPublicKey: requireString(input, 'deviceEphemeralPublicKey'),
  );
}

void main() {
  test('draft journal key is generated once and persists securely', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    const storage = FlutterSecureStorage();
    final security = DeviceSecurity(storage: storage);

    final concurrent = await Future.wait<List<int>>(
      List<Future<List<int>>>.generate(4, (_) => security.loadKey()),
    );
    final first = concurrent.first;
    expect(first, hasLength(32));
    expect(concurrent.skip(1), everyElement(first));
    expect(() => first[0] = first[0] ^ 0xff, throwsUnsupportedError);

    final restarted = DeviceSecurity(storage: storage);
    expect(await restarted.loadKey(), first);
    expect(
      await storage.read(key: 'uar.draft_journal_aes256_key.v1'),
      base64UrlNoPadding(first),
    );
  });

  test('malformed stored draft journal key fails closed', () async {
    const storageKey = 'uar.draft_journal_aes256_key.v1';
    FlutterSecureStorage.setMockInitialValues(<String, String>{
      storageKey: 'malformed-key',
    });
    const storage = FlutterSecureStorage();

    await expectLater(
      DeviceSecurity(storage: storage).loadKey(),
      throwsA(isA<StateError>()),
    );
    expect(await storage.read(key: storageKey), 'malformed-key');
  });

  test('removing a paired host clears its secure transport requirement',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    const storage = FlutterSecureStorage();
    final host = hostFrom(await loadVectors());
    final security = DeviceSecurity(storage: storage);

    await security.saveHost(host);
    await security.markSecureTransportRequired(host);
    expect(await security.readSecureTransportRequired(host), true);

    await security.removeHost(host.hostId);

    final restarted = DeviceSecurity(storage: storage);
    expect(await restarted.readHosts(), isEmpty);
    expect(await restarted.readSecureTransportRequired(host), false);
  });

  test('the signed handshake bind matches the Node canonical bytes', () async {
    final vectors = await loadVectors();
    final cases = jsonList(vectors['handshakeBind']);
    expect(cases.length, greaterThanOrEqualTo(3));
    for (final entry in cases) {
      final vector = jsonMap(entry);
      final input = jsonMap(vector['input']);
      final actual = handshakeBind(
        role: requireString(input, 'role'),
        hostId: requireString(input, 'hostId'),
        deviceId: optionalString(input, 'deviceId'),
        hostEphemeralPublicKey: requireString(input, 'hostEphemeralPublicKey'),
        deviceEphemeralPublicKey:
            optionalString(input, 'deviceEphemeralPublicKey'),
      );
      expect(utf8.decode(actual), requireString(vector, 'expected'));
    }
  });

  test('key derivation matches the Node implementation', () async {
    final vectors = await loadVectors();
    for (final entry in jsonList(vectors['keyDerivation'])) {
      final vector = jsonMap(entry);
      final input = jsonMap(vector['input']);
      final keys = await deriveSecureTransportKeys(
        sharedSecret: decodeBase64Url(requireString(input, 'sharedSecret')),
        hostId: requireString(input, 'hostId'),
        deviceId: requireString(input, 'deviceId'),
        hostEphemeralPublicKey: requireString(input, 'hostEphemeralPublicKey'),
        deviceEphemeralPublicKey:
            requireString(input, 'deviceEphemeralPublicKey'),
      );
      expect(base64UrlNoPadding(keys.hostToDevice),
          requireString(vector, 'hostToDevice'));
      expect(base64UrlNoPadding(keys.deviceToHost),
          requireString(vector, 'deviceToHost'));
    }
  });

  test('the phone produces the same ciphertext the computer expects', () async {
    final vectors = await loadVectors();
    final channel = SecureChannel(await keysFrom(vectors));
    for (final entry in jsonList(vectors['deviceFrames'])) {
      final vector = jsonMap(entry);
      final frame = await channel.seal(requireString(vector, 'plaintext'));
      expect(frame['counter'], vector['counter']);
      expect(frame['ciphertext'], requireString(vector, 'ciphertext'));
    }
  });

  test('the phone reads frames the computer sealed', () async {
    final vectors = await loadVectors();
    final channel = SecureChannel(await keysFrom(vectors));
    for (final entry in jsonList(vectors['hostFrames'])) {
      final vector = jsonMap(entry);
      final plaintext = await channel.open(<String, Object?>{
        'kind': 'secure',
        'counter': vector['counter'],
        'ciphertext': requireString(vector, 'ciphertext'),
      });
      expect(plaintext, requireString(vector, 'plaintext'));
    }
  });

  test('a tampered or replayed frame is refused', () async {
    final vectors = await loadVectors();
    final first = jsonMap(jsonList(vectors['hostFrames']).first);
    final channel = SecureChannel(await keysFrom(vectors));
    final ciphertext = requireString(first, 'ciphertext');
    final flipped =
        (ciphertext.startsWith('A') ? 'B' : 'A') + ciphertext.substring(1);
    await expectLater(
      channel.open(<String, Object?>{
        'kind': 'secure',
        'counter': first['counter'],
        'ciphertext': flipped
      }),
      throwsA(anything),
    );

    final fresh = SecureChannel(await keysFrom(vectors));
    await fresh.open(<String, Object?>{
      'kind': 'secure',
      'counter': first['counter'],
      'ciphertext': ciphertext
    });
    await expectLater(
      fresh.open(<String, Object?>{
        'kind': 'secure',
        'counter': first['counter'],
        'ciphertext': ciphertext
      }),
      throwsA(isA<SecureTransportException>()),
    );
  });

  test('the phone accepts a genuine host offer and rejects a forged one',
      () async {
    final vectors = await loadVectors();
    final host = hostFrom(vectors);
    final offer = SecureHandshakeOffer.tryParse(vectors['hostOffer']);
    expect(offer, isNotNull);

    final result = await acceptSecureHandshake(offer: offer!, host: host);
    expect(result.accept['kind'], 'secure_handshake');
    expect(result.accept['deviceId'], host.deviceId);
    expect(result.accept['scheme'], secureTransportScheme);
    expect(result.accept['ephemeralPublicKey'], isA<String>());

    // A relay that swaps in its own key cannot forge the host signature over it.
    final forged = SecureHandshakeOffer(
      ephemeralPublicKey: requireString(vectors, 'deviceEphemeralPublicKey'),
      signature: requireString(jsonMap(vectors['hostOffer']), 'signature'),
    );
    await expectLater(
      acceptSecureHandshake(offer: forged, host: host),
      throwsA(isA<SecureTransportException>()),
    );
  });

  test('an unsupported scheme is refused rather than downgraded', () async {
    expect(SecureHandshakeOffer.tryParse(null), isNull);
    expect(SecureHandshakeOffer.tryParse('nope'), isNull);
    expect(
      () => SecureHandshakeOffer.tryParse(<String, Object?>{
        'scheme': 'rot13',
        'version': 1,
        'ephemeralPublicKey': 'a',
        'signature': 'b'
      }),
      throwsA(isA<SecureTransportException>()),
    );
  });

  test('two handshakes never reuse a key', () async {
    final vectors = await loadVectors();
    final host = hostFrom(vectors);
    final offer = SecureHandshakeOffer.tryParse(vectors['hostOffer'])!;
    final first = await acceptSecureHandshake(offer: offer, host: host);
    final second = await acceptSecureHandshake(offer: offer, host: host);
    expect(first.accept['ephemeralPublicKey'],
        isNot(second.accept['ephemeralPublicKey']));
    expect(await first.channel.fingerprint(),
        isNot(await second.channel.fingerprint()));
  });
}
