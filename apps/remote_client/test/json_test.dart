import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/json.dart';

void main() {
  test('canonical JSON sorts object keys recursively', () {
    expect(
        canonicalJson(<String, Object?>{
          'z': 1,
          'a': <String, Object?>{'b': true, 'a': 'text'},
        }),
        '{"a":{"a":"text","b":true},"z":1}');
  });

  test('base64url helpers round trip without padding', () {
    final bytes = <int>[0, 1, 2, 250, 251, 252];
    final encoded = base64UrlNoPadding(bytes);
    expect(encoded, isNot(contains('=')));
    expect(decodeBase64Url(encoded), bytes);
  });

  test('random request IDs are unique and namespaced', () {
    final first = randomId('request');
    final second = randomId('request');
    expect(first, startsWith('request-'));
    expect(second, isNot(first));
  });
}
