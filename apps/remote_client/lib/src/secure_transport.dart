import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'json.dart';
import 'models.dart';
import 'security.dart';

/// Device half of the bridge transport encryption.
///
/// The relay forwards messages but terminates TLS, so without this layer a relay
/// operator can read task titles and message text in flight. Each connection
/// agrees a fresh key straight with the paired computer instead.
///
/// Every constant, label, and canonical string here must match
/// `packages/protocol/src/secure_transport.ts` byte for byte; the shared vectors
/// in `test/secure_transport_test.dart` pin that agreement.
const String secureTransportScheme = 'x25519-hkdf-sha256-aes256gcm';
const int secureTransportVersion = 1;

const int _keyBytes = 32;
const int _nonceBytes = 12;
const int _macBytes = 16;
const String _hostToDevice = 'host-to-device';
const String _deviceToHost = 'device-to-host';

final X25519 _x25519 = X25519();
final Ed25519 _ed25519 = Ed25519();
final Hkdf _hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: _keyBytes);
final AesGcm _aes = AesGcm.with256bits(nonceLength: _nonceBytes);

class SecureTransportException implements Exception {
  const SecureTransportException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// The host's signed offer, carried inside `protocol.hello`.
class SecureHandshakeOffer {
  const SecureHandshakeOffer(
      {required this.ephemeralPublicKey, required this.signature});

  /// Returns null when the computer did not offer encryption at all, which is
  /// how an older bridge behaves.
  static SecureHandshakeOffer? tryParse(Object? value) {
    if (value is! Map<Object?, Object?>) return null;
    final json = jsonMap(value, name: 'secure handshake offer');
    if (json['scheme'] != secureTransportScheme ||
        json['version'] != secureTransportVersion) {
      throw const SecureTransportException(
          'This computer offered an encryption scheme this app does not support');
    }
    return SecureHandshakeOffer(
      ephemeralPublicKey: requireString(json, 'ephemeralPublicKey'),
      signature: requireString(json, 'signature'),
    );
  }

  final String ephemeralPublicKey;
  final String signature;
}

/// The exact bytes each side signs. Mirrors `handshakeBind` in the TypeScript
/// module: every value that identifies the session is covered, so a relay
/// cannot substitute its own ephemeral key without breaking a signature.
Uint8List handshakeBind({
  required String role,
  required String hostId,
  String? deviceId,
  required String hostEphemeralPublicKey,
  String? deviceEphemeralPublicKey,
}) {
  return Uint8List.fromList(utf8.encode(canonicalJson(<String, Object?>{
    'purpose': 'tethoq-secure-transport-handshake',
    'scheme': secureTransportScheme,
    'version': secureTransportVersion,
    'role': role,
    'hostId': hostId,
    'deviceId': deviceId,
    'hostEphemeralPublicKey': hostEphemeralPublicKey,
    'deviceEphemeralPublicKey': deviceEphemeralPublicKey,
  })));
}

class SecureTransportKeys {
  const SecureTransportKeys(
      {required this.hostToDevice, required this.deviceToHost});
  final List<int> hostToDevice;
  final List<int> deviceToHost;
}

/// Both ephemeral keys are folded into the HKDF salt, so the session key is
/// reachable only by the two parties that chose them. Each direction gets its
/// own key, so a reflected frame can never decrypt.
Future<SecureTransportKeys> deriveSecureTransportKeys({
  required List<int> sharedSecret,
  required String hostId,
  required String deviceId,
  required String hostEphemeralPublicKey,
  required String deviceEphemeralPublicKey,
}) async {
  if (sharedSecret.length != _keyBytes) {
    throw const SecureTransportException('The shared secret must be 32 bytes');
  }
  final salt = (await Sha256().hash(utf8.encode(canonicalJson(<String, Object?>{
    'purpose': 'tethoq-secure-transport-salt',
    'scheme': secureTransportScheme,
    'version': secureTransportVersion,
    'hostId': hostId,
    'deviceId': deviceId,
    'hostEphemeralPublicKey': hostEphemeralPublicKey,
    'deviceEphemeralPublicKey': deviceEphemeralPublicKey,
  }))))
      .bytes;
  Future<List<int>> derive(String label) async {
    final key = await _hkdf.deriveKey(
      secretKey: SecretKey(sharedSecret),
      nonce: salt,
      info: utf8.encode(label),
    );
    return key.extractBytes();
  }

  return SecureTransportKeys(
    hostToDevice: await derive('tethoq-secure-transport-v1:host-to-device'),
    deviceToHost: await derive('tethoq-secure-transport-v1:device-to-host'),
  );
}

Uint8List _nonce(int counter) {
  if (counter < 0 || counter >= 0x1000000000000) {
    throw const SecureTransportException(
        'The secure transport frame counter is out of range');
  }
  final value = Uint8List(_nonceBytes);
  var remaining = counter;
  for (var index = _nonceBytes - 1; index >= _nonceBytes - 6; index -= 1) {
    value[index] = remaining & 0xff;
    remaining = remaining >> 8;
  }
  return value;
}

List<int> _associatedData(String direction, int counter) => utf8
    .encode('$secureTransportScheme:$secureTransportVersion:$direction:$counter');

/// One established session. Outbound counters increase; an inbound counter must
/// move forward, which rejects a frame the relay replayed or reordered.
class SecureChannel {
  SecureChannel(this._keys);

  final SecureTransportKeys _keys;
  int _outboundCounter = 0;
  int _highestInboundCounter = -1;

  Future<JsonMap> seal(String plaintext) async {
    final counter = _outboundCounter;
    _outboundCounter += 1;
    final box = await _aes.encrypt(
      utf8.encode(plaintext),
      secretKey: SecretKey(_keys.deviceToHost),
      nonce: _nonce(counter),
      aad: _associatedData(_deviceToHost, counter),
    );
    return <String, Object?>{
      'kind': 'secure',
      'counter': counter,
      'ciphertext':
          base64UrlNoPadding(<int>[...box.cipherText, ...box.mac.bytes]),
    };
  }

  Future<String> open(JsonMap frame) async {
    final counter = frame['counter'];
    if (counter is! int || counter < 0) {
      throw const SecureTransportException(
          'The secure frame counter is invalid');
    }
    if (counter <= _highestInboundCounter) {
      throw const SecureTransportException(
          'A secure transport frame was replayed or reordered');
    }
    final sealed = decodeBase64Url(requireString(frame, 'ciphertext'));
    if (sealed.length < _macBytes) {
      throw const SecureTransportException(
          'The secure frame is too short to authenticate');
    }
    final plaintext = await _aes.decrypt(
      SecretBox(
        sealed.sublist(0, sealed.length - _macBytes),
        nonce: _nonce(counter),
        mac: Mac(sealed.sublist(sealed.length - _macBytes)),
      ),
      secretKey: SecretKey(_keys.hostToDevice),
      aad: _associatedData(_hostToDevice, counter),
    );
    _highestInboundCounter = counter;
    return utf8.decode(plaintext);
  }

  /// Short human-comparable fingerprint. Both ends print the same value only
  /// when no one sat in the middle.
  Future<String> fingerprint() async {
    final digest = await Sha256()
        .hash(<int>[..._keys.hostToDevice, ..._keys.deviceToHost]);
    return digest.bytes
        .sublist(0, 4)
        .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
        .join();
  }
}

/// Proves to the relay that this device is the one its host-signed credential
/// names. The room token is shared with every paired device, so without this any
/// of them could claim another device's ID, evict its tunnel, and receive
/// everything addressed to it. The relay already pinned the computer's public
/// key, so it can check the credential without any new key exchange.
Future<JsonMap> signRelayDeviceAttach({
  required PairedHost host,
  required String token,
}) async {
  final attachId = randomId('attach');
  final issuedAt = DateTime.now().toUtc().toIso8601String();
  final tokenDigest = (await Sha256().hash(utf8.encode(token)))
      .bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
  final signature = await _ed25519.sign(
    utf8.encode(canonicalJson(<String, Object?>{
      'purpose': 'tethoq-relay-device-attach',
      'version': 1,
      'hostId': host.hostId,
      'deviceId': host.deviceId,
      'attachId': attachId,
      'issuedAt': issuedAt,
      'tokenDigest': tokenDigest,
    })),
    keyPair: SimpleKeyPairData(
      host.devicePrivateKey,
      publicKey:
          SimplePublicKey(host.devicePublicKey, type: KeyPairType.ed25519),
      type: KeyPairType.ed25519,
    ),
  );
  return <String, Object?>{
    'version': 1,
    'credential': host.credential.toJson(),
    'attachId': attachId,
    'issuedAt': issuedAt,
    'signature': base64UrlNoPadding(signature.bytes),
  };
}

class SecureHandshakeResult {
  const SecureHandshakeResult({required this.accept, required this.channel});
  final JsonMap accept;
  final SecureChannel channel;
}

/// Verifies the computer's offer against the host key stored at pairing, then
/// answers with this device's own signed ephemeral key.
Future<SecureHandshakeResult> acceptSecureHandshake({
  required SecureHandshakeOffer offer,
  required PairedHost host,
}) async {
  final hostSignatureValid = await _ed25519.verify(
    handshakeBind(
      role: 'host',
      hostId: host.hostId,
      hostEphemeralPublicKey: offer.ephemeralPublicKey,
    ),
    signature: Signature(
      decodeBase64Url(offer.signature),
      publicKey: SimplePublicKey(
          ed25519RawPublicKeyFromPem(host.hostPublicKeyPem),
          type: KeyPairType.ed25519),
    ),
  );
  if (!hostSignatureValid) {
    throw const SecureTransportException(
        'This computer\'s encryption key was not signed by the paired host');
  }

  final ephemeral = await _x25519.newKeyPair();
  final deviceEphemeralPublicKey =
      base64UrlNoPadding((await ephemeral.extractPublicKey()).bytes);
  final signature = await _ed25519.sign(
    handshakeBind(
      role: 'device',
      hostId: host.hostId,
      deviceId: host.deviceId,
      hostEphemeralPublicKey: offer.ephemeralPublicKey,
      deviceEphemeralPublicKey: deviceEphemeralPublicKey,
    ),
    keyPair: SimpleKeyPairData(
      host.devicePrivateKey,
      publicKey:
          SimplePublicKey(host.devicePublicKey, type: KeyPairType.ed25519),
      type: KeyPairType.ed25519,
    ),
  );
  final shared = await _x25519.sharedSecretKey(
    keyPair: ephemeral,
    remotePublicKey: SimplePublicKey(
        decodeBase64Url(offer.ephemeralPublicKey),
        type: KeyPairType.x25519),
  );
  final keys = await deriveSecureTransportKeys(
    sharedSecret: await shared.extractBytes(),
    hostId: host.hostId,
    deviceId: host.deviceId,
    hostEphemeralPublicKey: offer.ephemeralPublicKey,
    deviceEphemeralPublicKey: deviceEphemeralPublicKey,
  );
  return SecureHandshakeResult(
    accept: <String, Object?>{
      'kind': 'secure_handshake',
      'scheme': secureTransportScheme,
      'version': secureTransportVersion,
      'deviceId': host.deviceId,
      'credential': host.credential.toJson(),
      'ephemeralPublicKey': deviceEphemeralPublicKey,
      'signature': base64UrlNoPadding(signature.bytes),
    },
    channel: SecureChannel(keys),
  );
}
