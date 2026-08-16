import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'json.dart';
import 'models.dart';

bool isOfficialCodexRemotePairingLink(String value) {
  final uri = Uri.tryParse(value);
  if (uri == null ||
      !RegExp(r'^https://chatgpt\.com/', caseSensitive: false)
          .hasMatch(value) ||
      uri.scheme != 'https' ||
      uri.host != 'chatgpt.com' ||
      uri.hasPort ||
      uri.userInfo.isNotEmpty ||
      uri.path != '/codex/pair' ||
      uri.fragment.isNotEmpty) {
    return false;
  }

  final pairingCodes = uri.queryParametersAll['pairing_code'];
  if (pairingCodes == null || pairingCodes.length != 1) return false;
  return pairingCodes.single.trim().isNotEmpty;
}

class PairingPayload {
  const PairingPayload({
    required this.hostId,
    required this.hostPublicKeyPem,
    required this.pairingId,
    required this.secret,
    this.shortCode,
    required this.expiresAt,
    this.relayUrl,
    this.relayToken,
  });

  factory PairingPayload.fromJson(Object? value) {
    final json = jsonMap(value, name: 'pairing payload');
    if (json['version'] != 1)
      throw const FormatException('Unsupported pairing payload version');
    return PairingPayload(
      hostId: requireString(json, 'hostId'),
      hostPublicKeyPem: requireString(json, 'hostPublicKeyPem'),
      pairingId: requireString(json, 'pairingId'),
      secret: requireString(json, 'secret'),
      shortCode: optionalString(json, 'shortCode'),
      expiresAt: DateTime.parse(requireString(json, 'expiresAt')).toUtc(),
      relayUrl: optionalString(json, 'relayUrl'),
      relayToken: optionalString(json, 'relayToken'),
    );
  }

  final String hostId;
  final String hostPublicKeyPem;
  final String pairingId;
  final String secret;
  final String? shortCode;
  final DateTime expiresAt;
  final String? relayUrl;
  final String? relayToken;
}

class ScannedPairingData {
  const ScannedPairingData({required this.payloadText, this.directUrl});

  factory ScannedPairingData.parse(String value) {
    final decoded = jsonDecode(value);
    final json = jsonMap(decoded, name: 'pairing QR code');
    final Object? rawPayload;
    final String? directUrl;
    if (json['type'] == 'uar.pairing') {
      if (json['version'] != 1) {
        throw const FormatException('Unsupported pairing QR code version');
      }
      rawPayload = json['payload'];
      directUrl = optionalString(json, 'directUrl');
    } else {
      rawPayload = decoded;
      directUrl = null;
    }
    PairingPayload.fromJson(rawPayload);
    return ScannedPairingData(
      payloadText: jsonEncode(rawPayload),
      directUrl: directUrl,
    );
  }

  final String payloadText;
  final String? directUrl;
}

class SignedCredential {
  const SignedCredential({required this.payload, required this.signature});

  factory SignedCredential.fromJson(Object? value) {
    final json = jsonMap(value, name: 'signed credential');
    return SignedCredential(
        payload: requireString(json, 'payload'),
        signature: requireString(json, 'signature'));
  }

  final String payload;
  final String signature;

  JsonMap toJson() =>
      <String, Object?>{'payload': payload, 'signature': signature};
}

class DeviceIdentity {
  const DeviceIdentity(
      {required this.deviceId,
      required this.privateKeyBytes,
      required this.publicKeyBytes,
      required this.publicKeyPem});

  final String deviceId;
  final List<int> privateKeyBytes;
  final List<int> publicKeyBytes;
  final String publicKeyPem;
}

class PairedHost {
  const PairedHost({
    required this.hostId,
    required this.hostPublicKeyPem,
    required this.endpoint,
    required this.deviceId,
    required this.devicePrivateKey,
    required this.devicePublicKey,
    required this.credential,
    this.relayToken,
    this.displayName,
  });

  factory PairedHost.fromJson(Object? value) {
    final json = jsonMap(value, name: 'paired host');
    return PairedHost(
      hostId: requireString(json, 'hostId'),
      hostPublicKeyPem: requireString(json, 'hostPublicKeyPem'),
      endpoint: requireString(json, 'endpoint'),
      deviceId: requireString(json, 'deviceId'),
      devicePrivateKey:
          decodeBase64Url(requireString(json, 'devicePrivateKey')),
      devicePublicKey: decodeBase64Url(requireString(json, 'devicePublicKey')),
      credential: SignedCredential.fromJson(json['credential']),
      relayToken: optionalString(json, 'relayToken'),
      displayName: optionalString(json, 'displayName'),
    );
  }

  final String hostId;
  final String hostPublicKeyPem;
  final String endpoint;
  final String deviceId;
  final List<int> devicePrivateKey;
  final List<int> devicePublicKey;
  final SignedCredential credential;
  final String? relayToken;
  final String? displayName;

  JsonMap toJson() => <String, Object?>{
        'hostId': hostId,
        'hostPublicKeyPem': hostPublicKeyPem,
        'endpoint': endpoint,
        'deviceId': deviceId,
        'devicePrivateKey': base64UrlNoPadding(devicePrivateKey),
        'devicePublicKey': base64UrlNoPadding(devicePublicKey),
        'credential': credential.toJson(),
        if (relayToken != null) 'relayToken': relayToken,
        if (displayName != null) 'displayName': displayName,
      };
}

class SessionReadState {
  const SessionReadState({
    required this.lastReadAt,
    required this.unreadSessionIds,
  });

  factory SessionReadState.fromJson(Object? value) {
    final json = jsonMap(value, name: 'session read state');
    if (json['version'] != 1) {
      throw const FormatException('Unsupported session read state version');
    }
    final timestamps =
        jsonMap(json['lastReadAt'], name: 'last read timestamps');
    return SessionReadState(
      lastReadAt: <String, DateTime>{
        for (final entry in timestamps.entries)
          if (entry.value is String &&
              DateTime.tryParse(entry.value! as String) != null)
            entry.key: DateTime.parse(entry.value! as String).toUtc(),
      },
      unreadSessionIds:
          jsonList(json['unreadSessionIds']).whereType<String>().toSet(),
    );
  }

  final Map<String, DateTime> lastReadAt;
  final Set<String> unreadSessionIds;

  JsonMap toJson() => <String, Object?>{
        'version': 1,
        'lastReadAt': <String, Object?>{
          for (final entry in lastReadAt.entries)
            entry.key: entry.value.toUtc().toIso8601String(),
        },
        'unreadSessionIds': unreadSessionIds.toList()..sort(),
      };
}

class DeviceSecurity {
  DeviceSecurity({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  static const _hostIndexKey = 'uar.paired_host_ids.v1';
  static const _defaultDeliveryModeKey = 'uar.default_delivery_mode.v1';
  static const _reasoningDisplayModeKey = 'uar.reasoning_display_mode.v1';
  static const _dictationDictionaryKey = 'uar.dictation_dictionary.v1';
  static const _dictationSourceKey = 'uar.dictation_source.v1';
  static const _dictationSourcePreferencesKey =
      'uar.dictation_source_preferences.v1';
  static const _delegationPreferencesKey = 'uar.delegation_preferences.v1';
  static const _agentDefaultsKey = 'uar.agent_defaults.v1';
  static const _recentModelsKey = 'uar.recent_models.v1';
  final FlutterSecureStorage _storage;
  final Ed25519 _algorithm = Ed25519();

  Future<DeviceIdentity> createDeviceIdentity() async {
    final keyPair = await _algorithm.newKeyPair();
    final privateBytes = await keyPair.extractPrivateKeyBytes();
    final publicKey = await keyPair.extractPublicKey();
    return DeviceIdentity(
      deviceId: randomId('device'),
      privateKeyBytes: privateBytes,
      publicKeyBytes: publicKey.bytes,
      publicKeyPem: _rawPublicKeyToPem(publicKey.bytes),
    );
  }

  Future<JsonMap> verifyCredential(
      SignedCredential credential, String hostPublicKeyPem) async {
    final publicKey = SimplePublicKey(_pemToRawPublicKey(hostPublicKeyPem),
        type: KeyPairType.ed25519);
    final signature =
        Signature(decodeBase64Url(credential.signature), publicKey: publicKey);
    final valid = await _algorithm.verify(utf8.encode(credential.payload),
        signature: signature);
    if (!valid)
      throw const FormatException('Host credential signature is invalid');
    final payload = jsonMap(
        jsonDecode(utf8.decode(decodeBase64Url(credential.payload))),
        name: 'credential payload');
    if (payload['version'] != 1)
      throw const FormatException('Unsupported device credential version');
    return payload;
  }

  Future<JsonMap> signAction(PairedHost host, JsonMap action) async {
    final issuedAt = DateTime.now().toUtc();
    final unsigned = <String, Object?>{
      'credential': host.credential.toJson(),
      'actionId': randomId('action'),
      'issuedAt': issuedAt.toIso8601String(),
      'expiresAt': issuedAt.add(const Duration(minutes: 1)).toIso8601String(),
      'action': action,
    };
    final keyPair = SimpleKeyPairData(
      host.devicePrivateKey,
      publicKey:
          SimplePublicKey(host.devicePublicKey, type: KeyPairType.ed25519),
      type: KeyPairType.ed25519,
    );
    final signature = await _algorithm
        .sign(utf8.encode(canonicalJson(unsigned)), keyPair: keyPair);
    return <String, Object?>{
      ...unsigned,
      'signature': base64UrlNoPadding(signature.bytes)
    };
  }

  /// Verifies a signed device action produced by this device (or a vector
  /// produced by the Node reference implementation) against the signer's
  /// Ed25519 public key. The canonical unsigned envelope must match the one
  /// built by signAction and by Node's signDeviceAction.
  Future<JsonMap> verifySignedAction(
      JsonMap signed, String signerPublicKeyPem) async {
    final unsigned = <String, Object?>{
      'credential':
          jsonMap(signed['credential'], name: 'signed action credential'),
      'actionId': requireString(signed, 'actionId'),
      'issuedAt': requireString(signed, 'issuedAt'),
      'expiresAt': requireString(signed, 'expiresAt'),
      'action': jsonMap(signed['action'], name: 'signed action'),
    };
    final publicKey = SimplePublicKey(_pemToRawPublicKey(signerPublicKeyPem),
        type: KeyPairType.ed25519);
    final signature = Signature(
        decodeBase64Url(requireString(signed, 'signature')),
        publicKey: publicKey);
    final valid = await _algorithm.verify(utf8.encode(canonicalJson(unsigned)),
        signature: signature);
    if (!valid)
      throw const FormatException('Signed action signature is invalid');
    return jsonMap(unsigned['action'], name: 'signed action');
  }

  Future<List<PairedHost>> readHosts() async {
    final raw = await _storage.read(key: _hostIndexKey);
    final ids = raw == null ? <Object?>[] : jsonList(jsonDecode(raw));
    final result = <PairedHost>[];
    for (final id in ids.whereType<String>()) {
      final value = await _storage.read(key: 'uar.host.$id');
      if (value != null) result.add(PairedHost.fromJson(jsonDecode(value)));
    }
    return result;
  }

  Future<void> saveHost(PairedHost host) async {
    final hosts = await readHosts();
    final ids = <String>{...hosts.map((item) => item.hostId), host.hostId}
        .toList()
      ..sort();
    await _storage.write(
        key: 'uar.host.${host.hostId}', value: jsonEncode(host.toJson()));
    await _storage.write(key: _hostIndexKey, value: jsonEncode(ids));
  }

  Future<void> removeHost(String hostId) async {
    final hosts = await readHosts();
    final removed = hosts.where((item) => item.hostId == hostId).firstOrNull;
    final ids = hosts
        .map((item) => item.hostId)
        .where((id) => id != hostId)
        .toList()
      ..sort();
    await _storage.delete(key: 'uar.host.$hostId');
    if (removed != null) {
      await _storage.delete(key: _sessionReadStateKey(removed));
    }
    await _storage.write(key: _hostIndexKey, value: jsonEncode(ids));
  }

  Future<SessionReadState?> readSessionReadState(PairedHost host) async {
    final raw = await _storage.read(key: _sessionReadStateKey(host));
    if (raw == null) return null;
    return SessionReadState.fromJson(jsonDecode(raw));
  }

  Future<void> saveSessionReadState(
      PairedHost host, SessionReadState state) async {
    await _storage.write(
      key: _sessionReadStateKey(host),
      value: jsonEncode(state.toJson()),
    );
  }

  Future<String> readDefaultDeliveryMode() async {
    final value = await _storage.read(key: _defaultDeliveryModeKey);
    return value == 'steer' ? 'steer' : 'queue';
  }

  Future<void> saveDefaultDeliveryMode(String value) async {
    if (value != 'queue' && value != 'steer') {
      throw ArgumentError.value(value, 'value', 'must be queue or steer');
    }
    await _storage.write(key: _defaultDeliveryModeKey, value: value);
  }

  Future<String> readReasoningDisplayMode() async {
    final value = await _storage.read(key: _reasoningDisplayModeKey);
    return value == 'expanded' ? 'expanded' : 'compact';
  }

  Future<void> saveReasoningDisplayMode(String value) async {
    if (value != 'compact' && value != 'expanded') {
      throw ArgumentError.value(value, 'value', 'must be compact or expanded');
    }
    await _storage.write(key: _reasoningDisplayModeKey, value: value);
  }

  Future<List<String>> readDictationDictionary() async {
    final raw = await _storage.read(key: _dictationDictionaryKey);
    if (raw == null) return <String>[];
    final value = jsonDecode(raw);
    if (value is! List<Object?>) return <String>[];
    return value.whereType<String>().take(100).toList(growable: false);
  }

  Future<void> saveDictationDictionary(List<String> entries) async {
    await _storage.write(
        key: _dictationDictionaryKey,
        value: jsonEncode(entries.take(100).toList()));
  }

  Future<String?> readDictationSourceId() async {
    final value = await _storage.read(key: _dictationSourceKey);
    if (value == null || value.trim().isEmpty || value.length > 80) return null;
    return value;
  }

  Future<void> saveDictationSourceId(String sourceId) async {
    final value = sourceId.trim();
    if (value.isEmpty || value.length > 80) {
      throw ArgumentError.value(
          sourceId, 'sourceId', 'must be a valid source ID');
    }
    await _storage.write(key: _dictationSourceKey, value: value);
  }

  Future<Map<String, String>> readDictationSourcePreferences() async {
    final raw = await _storage.read(key: _dictationSourcePreferencesKey);
    if (raw == null) return <String, String>{};
    final decoded = jsonDecode(raw);
    if (decoded is! Map<Object?, Object?>) return <String, String>{};
    final preferences = <String, String>{};
    for (final entry in decoded.entries) {
      if (entry.key is! String || entry.value is! String) continue;
      final harnessId = (entry.key as String).trim().toLowerCase();
      final sourceId = (entry.value as String).trim();
      if (harnessId.isEmpty ||
          harnessId.length > 80 ||
          sourceId.isEmpty ||
          sourceId.length > 80) {
        continue;
      }
      preferences[harnessId] = sourceId;
      if (preferences.length == 40) break;
    }
    return preferences;
  }

  Future<void> saveDictationSourcePreferences(
      Map<String, String> preferences) async {
    final normalized = <String, String>{};
    for (final entry in preferences.entries) {
      final harnessId = entry.key.trim().toLowerCase();
      final sourceId = entry.value.trim();
      if (harnessId.isEmpty ||
          harnessId.length > 80 ||
          sourceId.isEmpty ||
          sourceId.length > 80) {
        continue;
      }
      normalized[harnessId] = sourceId;
      if (normalized.length == 40) break;
    }
    await _storage.write(
      key: _dictationSourcePreferencesKey,
      value: jsonEncode(normalized),
    );
  }

  Future<Map<String, DelegationSelection>> readDelegationPreferences() async {
    final raw = await _storage.read(key: _delegationPreferencesKey);
    if (raw == null) return <String, DelegationSelection>{};
    final decoded = jsonDecode(raw);
    if (decoded is! Map<Object?, Object?>) {
      return <String, DelegationSelection>{};
    }
    final result = <String, DelegationSelection>{};
    for (final entry in decoded.entries) {
      if (entry.key is! String || entry.value is! Map<Object?, Object?>)
        continue;
      try {
        final selection = DelegationSelection.fromJson(entry.value);
        result[entry.key! as String] = selection;
      } on FormatException {
        // Ignore a malformed saved choice without breaking app startup.
      }
    }
    return result;
  }

  Future<void> saveDelegationPreference(DelegationSelection selection) async {
    final current = await readDelegationPreferences();
    current[selection.providerId] = selection;
    await _storage.write(
      key: _delegationPreferencesKey,
      value: jsonEncode(<String, Object?>{
        for (final entry in current.entries) entry.key: entry.value.toJson(),
      }),
    );
  }

  Future<Map<String, DelegationSelection>> readAgentDefaults() async {
    final raw = await _storage.read(key: _agentDefaultsKey);
    if (raw == null) return <String, DelegationSelection>{};
    final decoded = jsonDecode(raw);
    if (decoded is! Map<Object?, Object?>) {
      return <String, DelegationSelection>{};
    }
    final result = <String, DelegationSelection>{};
    for (final entry in decoded.entries) {
      if (entry.key is! String || entry.value is! Map<Object?, Object?>) {
        continue;
      }
      try {
        final selection = DelegationSelection.fromJson(entry.value);
        final providerId = selection.providerId.trim().toLowerCase();
        final modelId = selection.modelId?.trim();
        final reasoningEffort = selection.reasoningEffort?.trim();
        if (providerId.isEmpty ||
            providerId.length > 80 ||
            modelId == null ||
            modelId.isEmpty ||
            modelId.length > 300 ||
            (reasoningEffort != null && reasoningEffort.length > 80)) {
          continue;
        }
        result[providerId] = DelegationSelection(
          providerId: providerId,
          modelId: modelId,
          reasoningEffort:
              reasoningEffort?.isEmpty == true ? null : reasoningEffort,
        );
        if (result.length == 40) break;
      } on FormatException {
        // Ignore a malformed saved default without breaking app startup.
      }
    }
    return result;
  }

  Future<void> saveAgentDefault(DelegationSelection selection) async {
    final providerId = selection.providerId.trim().toLowerCase();
    final modelId = selection.modelId?.trim();
    final reasoningEffort = selection.reasoningEffort?.trim();
    if (providerId.isEmpty ||
        providerId.length > 80 ||
        modelId == null ||
        modelId.isEmpty ||
        modelId.length > 300 ||
        (reasoningEffort != null && reasoningEffort.length > 80)) {
      throw ArgumentError.value(selection, 'selection',
          'must name a valid Agent, model, and reasoning value');
    }
    final current = await readAgentDefaults();
    current[providerId] = DelegationSelection(
      providerId: providerId,
      modelId: modelId,
      reasoningEffort:
          reasoningEffort?.isEmpty == true ? null : reasoningEffort,
    );
    await _storage.write(
      key: _agentDefaultsKey,
      value: jsonEncode(<String, Object?>{
        for (final entry in current.entries) entry.key: entry.value.toJson(),
      }),
    );
  }

  Future<List<String>> readRecentModelKeys() async {
    final raw = await _storage.read(key: _recentModelsKey);
    if (raw == null) return <String>[];
    final decoded = jsonDecode(raw);
    if (decoded is! List<Object?>) return <String>[];
    return decoded
        .whereType<String>()
        .where((value) => value.length <= 300 && value.contains('\u0000'))
        .take(5)
        .toList(growable: false);
  }

  Future<void> saveRecentModelKeys(Iterable<String> keys) async {
    final normalized = keys
        .where((value) => value.length <= 300 && value.contains('\u0000'))
        .take(5)
        .toList(growable: false);
    await _storage.write(key: _recentModelsKey, value: jsonEncode(normalized));
  }

  String _sessionReadStateKey(PairedHost host) =>
      'uar.session_reads.v1.${host.hostId}.${host.deviceId}';

  String _rawPublicKeyToPem(List<int> raw) {
    if (raw.length != 32)
      throw const FormatException('Ed25519 public keys must contain 32 bytes');
    final der = Uint8List.fromList(<int>[
      0x30,
      0x2a,
      0x30,
      0x05,
      0x06,
      0x03,
      0x2b,
      0x65,
      0x70,
      0x03,
      0x21,
      0x00,
      ...raw
    ]);
    final encoded = base64.encode(der);
    final lines = <String>[];
    for (var index = 0; index < encoded.length; index += 64) {
      lines.add(encoded.substring(
          index, index + 64 > encoded.length ? encoded.length : index + 64));
    }
    return '-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n';
  }

  List<int> _pemToRawPublicKey(String pem) => ed25519RawPublicKeyFromPem(pem);
}

/// Unwraps an Ed25519 SubjectPublicKeyInfo PEM into its raw 32 bytes. The
/// secure transport needs the same conversion to check the computer's signed
/// encryption key against the identity stored at pairing.
List<int> ed25519RawPublicKeyFromPem(String pem) {
  final body = pem.replaceAll(
      RegExp(r'-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s'), '');
  final der = base64.decode(body);
  const prefix = <int>[
    0x30,
    0x2a,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x03,
    0x21,
    0x00
  ];
  if (der.length != prefix.length + 32)
    throw const FormatException(
        'Host public key is not an Ed25519 SubjectPublicKeyInfo key');
  for (var index = 0; index < prefix.length; index += 1) {
    if (der[index] != prefix[index])
      throw const FormatException(
          'Host public key uses an unexpected algorithm');
  }
  return der.sublist(prefix.length);
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
