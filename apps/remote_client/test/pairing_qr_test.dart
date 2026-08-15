import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/security.dart';

void main() {
  const payload = <String, Object?>{
    'version': 1,
    'hostId': 'host_1',
    'hostPublicKeyPem': 'public-key',
    'pairingId': 'pair_1',
    'secret': 'secret',
    'shortCode': '123456',
    'expiresAt': '2026-08-12T12:00:00.000Z',
  };

  test('parses a phone pairing QR wrapper with its secure endpoint', () {
    final result = ScannedPairingData.parse(jsonEncode(<String, Object?>{
      'type': 'uar.pairing',
      'version': 1,
      'payload': payload,
      'directUrl': 'wss://example.test/bridge',
    }));

    expect(
        (jsonDecode(result.payloadText) as Map<String, Object?>)
            .containsKey('shortCode'),
        isTrue);
    expect(result.directUrl, 'wss://example.test/bridge');
  });

  test('keeps raw pairing payloads as a manual-compatible fallback', () {
    final result = ScannedPairingData.parse(jsonEncode(payload));

    expect(jsonDecode(result.payloadText), payload);
    expect(result.directUrl, isNull);
  });

  test('recognizes the official Codex Remote pairing link', () {
    expect(
      isOfficialCodexRemotePairingLink(
        'https://chatgpt.com/codex/pair?pairing_code=test-code',
      ),
      isTrue,
    );
    expect(
      isOfficialCodexRemotePairingLink(
        'https://chatgpt.com/codex/pair?pairing_code=test-code&source=qr',
      ),
      isTrue,
    );
  });

  test('rejects lookalike or incomplete Codex Remote pairing links', () {
    const rejected = <String>[
      'http://chatgpt.com/codex/pair?pairing_code=test-code',
      'https://codex.chatgpt.com/codex/pair?pairing_code=test-code',
      'https://chatgpt.com.example/codex/pair?pairing_code=test-code',
      'https://user@chatgpt.com/codex/pair?pairing_code=test-code',
      'https://chatgpt.com:443/codex/pair?pairing_code=test-code',
      'https://chatgpt.com/codex/pair/?pairing_code=test-code',
      'https://chatgpt.com/Codex/pair?pairing_code=test-code',
      'https://chatgpt.com/codex/pair',
      'https://chatgpt.com/codex/pair?pairing_code=',
      'https://chatgpt.com/codex/pair?pairing_code=%20',
      'https://chatgpt.com/codex/pair?pairing_code=one&pairing_code=two',
      'https://chatgpt.com/codex/pair?pairing_code=test-code#fragment',
    ];

    for (final value in rejected) {
      expect(
        isOfficialCodexRemotePairingLink(value),
        isFalse,
        reason: value,
      );
    }
  });
}
