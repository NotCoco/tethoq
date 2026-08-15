import 'dart:convert';
import 'dart:math';

String randomId([String prefix = 'id']) {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex =
      bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  return '$prefix-${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

String base64UrlNoPadding(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

List<int> decodeBase64Url(String value) {
  final padding = '=' * ((4 - value.length % 4) % 4);
  return base64Url.decode('$value$padding');
}

Map<String, Object?> jsonMap(Object? value, {String name = 'value'}) {
  if (value is! Map<Object?, Object?>)
    throw FormatException('$name must be a JSON object');
  return value.map<String, Object?>((Object? key, Object? item) {
    if (key is! String)
      throw FormatException('$name contains a non-string key');
    return MapEntry<String, Object?>(key, item);
  });
}

String requireString(Map<String, Object?> source, String key) {
  final value = source[key];
  if (value is! String || value.isEmpty)
    throw FormatException('$key must be a non-empty string');
  return value;
}

String? optionalString(Map<String, Object?> source, String key) {
  final value = source[key];
  return value is String && value.isNotEmpty ? value : null;
}

List<Object?> jsonList(Object? value) =>
    value is List<Object?> ? value : const <Object?>[];

/// Largest integer that Node's JSON.stringify and this canonicalizer both
/// represent faithfully (2^53 - 1). JavaScript numbers are IEEE-754 doubles,
/// so a value outside this range cannot round-trip identically on the host.
const int _safeJsonIntegerMax = 9007199254740991;

String canonicalJson(Object? value) {
  if (value == null || value is bool || value is String)
    return jsonEncode(value);
  if (value is num) {
    if (!value.isFinite)
      throw const FormatException(
          'Canonical JSON does not allow non-finite numbers');
    if (value is int) {
      if (value > _safeJsonIntegerMax || value < -_safeJsonIntegerMax) {
        throw const FormatException(
            'Canonical JSON integers must fit in the JavaScript safe integer range');
      }
      return value.toString();
    }
    final whole = value.roundToDouble();
    if (value == whole) {
      final integral = value.toInt();
      if (integral > _safeJsonIntegerMax || integral < -_safeJsonIntegerMax) {
        throw const FormatException(
            'Canonical JSON whole numbers must fit in the JavaScript safe integer range');
      }
      return integral.toString();
    }
    // Fractional doubles use the same shortest-roundtrip formatting in Dart
    // and Node (JSON.stringify), so toString() is the canonical form.
    return value.toString();
  }
  if (value is List<Object?>) return '[${value.map(canonicalJson).join(',')}]';
  if (value is Map<Object?, Object?>) {
    final mapped = jsonMap(value);
    final keys = mapped.keys.toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${canonicalJson(mapped[key])}').join(',')}}';
  }
  throw FormatException(
      'Unsupported canonical JSON value ${value.runtimeType}');
}
