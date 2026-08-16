import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import 'json.dart';
import 'models.dart';
import 'secure_transport.dart';
import 'security.dart';

typedef BridgeDnsResolver = Future<List<InternetAddress>> Function(String host);
typedef BridgeWebSocketConnector<T> = Future<T> Function(
    Uri uri, HttpClient? customClient);
typedef BridgeDohQuery = Future<List<InternetAddress>> Function(
    Uri endpoint, String host, int recordType);

const Duration _dohTimeout = Duration(seconds: 5);
const Duration _resolvedConnectionTimeout = Duration(seconds: 5);
const int _maxDohResponseBytes = 64 * 1024;
const int _maxResolvedAddresses = 8;
final List<Uri> _dohEndpoints = <Uri>[
  Uri.https('cloudflare-dns.com', '/dns-query'),
  Uri.https('dns.google', '/resolve'),
];

bool _isTryCloudflareEndpoint(Uri uri) =>
    uri.scheme == 'wss' &&
    uri.host.toLowerCase().endsWith('.trycloudflare.com');

bool _isFailedHostLookup(SocketException error) =>
    error.message.toLowerCase().contains('failed host lookup');

/// Retries a failed OS lookup for Cloudflare quick tunnels through encrypted
/// DNS. The original URI is deliberately retained so TLS still validates the
/// tunnel hostname rather than the resolved IP address.
@visibleForTesting
Future<T> connectWithTryCloudflareDnsFallback<T>(
  Uri uri, {
  required BridgeWebSocketConnector<T> connector,
  required BridgeDnsResolver resolver,
}) async {
  try {
    return await connector(uri, null);
  } on SocketException catch (error) {
    if (!_isTryCloudflareEndpoint(uri) || !_isFailedHostLookup(error)) rethrow;
  }

  final addresses = await resolver(uri.host);
  if (addresses.isEmpty) {
    throw SocketException(
        'Secure DNS returned no usable address for ${uri.host}');
  }
  final client = _resolvedAddressHttpClient(uri, addresses);
  try {
    return await connector(uri, client);
  } finally {
    client.close();
  }
}

Future<List<InternetAddress>> resolveTryCloudflareWithDoh(String host) async {
  return _resolveTryCloudflareWithDoh(host);
}

@visibleForTesting
Future<List<InternetAddress>> resolveTryCloudflareWithDohForTesting(
  String host, {
  required BridgeDohQuery query,
}) {
  return _resolveTryCloudflareWithDoh(host, query: query);
}

Future<List<InternetAddress>> _resolveTryCloudflareWithDoh(
  String host, {
  BridgeDohQuery? query,
}) async {
  final normalized = host.toLowerCase();
  const suffix = '.trycloudflare.com';
  if (normalized.length <= suffix.length || !normalized.endsWith(suffix)) {
    throw ArgumentError.value(host, 'host', 'Not a trycloudflare.com host');
  }
  final client = HttpClient()
    ..connectionTimeout = _dohTimeout
    ..findProxy = ((_) => 'DIRECT');
  try {
    final effectiveQuery = query ??
        (Uri endpoint, String queriedHost, int recordType) =>
            _resolveDohRecord(client, endpoint, queriedHost, recordType);
    final lookups = <Future<List<InternetAddress>>>[
      for (final endpoint in _dohEndpoints)
        for (final recordType in const <int>[1, 28])
          effectiveQuery(endpoint, normalized, recordType)
              .timeout(_dohTimeout)
              .catchError((Object _) => <InternetAddress>[]),
    ];
    final records = await Future.wait(lookups).timeout(_dohTimeout);
    final unique = <String, InternetAddress>{};
    for (final address in records.expand((values) => values)) {
      if (address.type != InternetAddressType.IPv4 &&
          address.type != InternetAddressType.IPv6) {
        continue;
      }
      unique.putIfAbsent(address.address, () => address);
      if (unique.length == _maxResolvedAddresses) break;
    }
    if (unique.isEmpty) {
      throw SocketException(
          'Secure DNS returned no usable address for $normalized');
    }
    return unique.values.toList(growable: false);
  } finally {
    client.close(force: true);
  }
}

Future<List<InternetAddress>> _resolveDohRecord(
    HttpClient client, Uri endpoint, String host, int recordType) async {
  final uri = endpoint.replace(queryParameters: <String, String>{
    'name': host,
    'type': '$recordType',
  });
  final request = await client.getUrl(uri).timeout(_dohTimeout);
  request.headers.set(HttpHeaders.acceptHeader, 'application/dns-json');
  final response = await request.close().timeout(_dohTimeout);
  if (response.statusCode != HttpStatus.ok) {
    throw SocketException('Secure DNS returned HTTP ${response.statusCode}');
  }
  if (response.contentLength > _maxDohResponseBytes) {
    throw const FormatException('Secure DNS response was too large');
  }
  final bytes = BytesBuilder(copy: false);
  await for (final chunk in response.timeout(_dohTimeout)) {
    if (bytes.length + chunk.length > _maxDohResponseBytes) {
      throw const FormatException('Secure DNS response was too large');
    }
    bytes.add(chunk);
  }
  return parseDohAddresses(jsonDecode(utf8.decode(bytes.takeBytes())));
}

@visibleForTesting
List<InternetAddress> parseDohAddresses(Object? value) {
  if (value is! Map<Object?, Object?> || value['Status'] != 0) {
    return const <InternetAddress>[];
  }
  final answers = value['Answer'];
  if (answers is! List<Object?>) return const <InternetAddress>[];
  final unique = <String, InternetAddress>{};
  for (final answer in answers) {
    if (answer is! Map<Object?, Object?>) continue;
    final type = answer['type'];
    if (type != 1 && type != 28) continue;
    final data = answer['data'];
    if (data is! String) continue;
    final address = InternetAddress.tryParse(data);
    if (address == null ||
        (type == 1 && address.type != InternetAddressType.IPv4) ||
        (type == 28 && address.type != InternetAddressType.IPv6)) {
      continue;
    }
    unique.putIfAbsent(address.address, () => address);
    if (unique.length == _maxResolvedAddresses) break;
  }
  return unique.values.toList(growable: false);
}

HttpClient _resolvedAddressHttpClient(
    Uri endpoint, List<InternetAddress> addresses) {
  final client = HttpClient()
    ..connectionTimeout = _resolvedConnectionTimeout
    ..findProxy = ((_) => 'DIRECT');
  client.connectionFactory =
      (Uri requestUri, String? proxyHost, int? proxyPort) {
    if (proxyHost != null || proxyPort != null) {
      throw const SocketException(
          'A proxy cannot be used with the secure DNS fallback');
    }
    if (requestUri.host.toLowerCase() != endpoint.host.toLowerCase()) {
      throw const SocketException(
          'The secure DNS fallback cannot connect to a different host');
    }
    final port = requestUri.port;
    ConnectionTask<Socket>? activeTask;
    Socket? activeSocket;
    var cancelled = false;
    final socket = () async {
      Object? lastError;
      for (final address
          in addresses.take(_maxResolvedAddresses).toList(growable: false)) {
        if (cancelled) {
          throw const SocketException('Connection attempt was cancelled');
        }
        try {
          activeTask = await Socket.startConnect(address, port);
          final rawSocket = await activeTask!.socket.timeout(
            _resolvedConnectionTimeout,
            onTimeout: () {
              activeTask?.cancel();
              throw TimeoutException('Resolved address connection timed out');
            },
          );
          activeSocket = rawSocket;
          if (cancelled) {
            rawSocket.destroy();
            throw const SocketException('Connection attempt was cancelled');
          }
          if (requestUri.scheme == 'https') {
            // Passing the original DNS name here preserves both SNI and normal
            // certificate hostname verification. No bad-certificate callback
            // is installed.
            final secureSocket = await SecureSocket.secure(
              rawSocket,
              host: endpoint.host,
            ).timeout(_resolvedConnectionTimeout);
            activeSocket = secureSocket;
            return secureSocket;
          }
          return rawSocket;
        } on Object catch (error) {
          lastError = error;
          activeSocket?.destroy();
          activeSocket = null;
        }
      }
      if (lastError is SocketException) throw lastError;
      throw SocketException(
          'Could not connect to a secure DNS address for ${endpoint.host}');
    }();
    return Future<ConnectionTask<Socket>>.value(ConnectionTask.fromSocket(
      socket,
      () {
        cancelled = true;
        activeTask?.cancel();
        activeSocket?.destroy();
      },
    ));
  };
  return client;
}

enum BridgeConnectionState {
  disconnected,
  connecting,
  online,
  reconnecting,
  closed
}

class BridgeRequestException implements Exception {
  const BridgeRequestException(this.code, this.message,
      {required this.retryable});

  final String code;
  final String message;
  final bool retryable;

  @override
  String toString() => '$code: $message';
}

class BridgeReplayResult {
  const BridgeReplayResult({
    required this.latestSequence,
    required this.throughSequence,
    required this.oldestAvailableSequence,
    required this.replayGap,
  });

  final int latestSequence;
  final int throughSequence;
  final int? oldestAvailableSequence;
  final bool replayGap;
}

class BridgeEndpoint {
  const BridgeEndpoint({
    required this.hostId,
    required this.url,
    required this.deviceId,
    this.relayToken,
    this.pairedHost,
  });

  final String hostId;
  final String url;
  final String deviceId;
  final String? relayToken;
  final PairedHost? pairedHost;
}

Uri validateBridgeEndpointUrl(String value) {
  final uri = Uri.tryParse(value.trim());
  if (uri == null ||
      (uri.scheme != 'ws' && uri.scheme != 'wss') ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.fragment.isNotEmpty) {
    throw const FormatException(
        'Bridge URL must be a ws:// or wss:// WebSocket address without credentials or a fragment');
  }
  if (uri.scheme == 'ws' && !_isLocalDevelopmentHost(uri.host)) {
    throw const FormatException(
        'A real phone must use an encrypted wss:// bridge or relay. Unencrypted ws:// is allowed only for localhost and the Android emulator.');
  }
  return uri;
}

bool _isLocalDevelopmentHost(String host) {
  final normalized = host.toLowerCase();
  if (normalized == 'localhost' ||
      normalized == '::1' ||
      normalized == '0:0:0:0:0:0:0:1' ||
      normalized == '10.0.2.2') {
    return true;
  }
  final parts = normalized.split('.');
  return parts.length == 4 && parts.first == '127';
}

class _PendingRequest {
  _PendingRequest({
    required this.envelope,
    required this.signed,
    required this.completer,
    required this.timer,
  });

  final JsonMap envelope;
  final bool signed;
  final Completer<JsonMap> completer;
  final Timer timer;
}

class BridgeTransport {
  BridgeTransport({
    required this.endpoint,
    required this.security,
    BridgeDnsResolver? dnsResolver,
    BridgeWebSocketConnector<WebSocket>? socketConnector,
  })  : _dnsResolver = dnsResolver ?? resolveTryCloudflareWithDoh,
        _socketConnector = socketConnector ?? _connectWebSocket;

  final BridgeEndpoint endpoint;
  final DeviceSecurity security;
  final BridgeDnsResolver _dnsResolver;
  final BridgeWebSocketConnector<WebSocket> _socketConnector;
  final StreamController<BridgeConnectionState> _states =
      StreamController<BridgeConnectionState>.broadcast();
  final StreamController<AgentEvent> _events =
      StreamController<AgentEvent>.broadcast();
  final StreamController<void> _replayGaps = StreamController<void>.broadcast();
  final Map<String, _PendingRequest> _pending = <String, _PendingRequest>{};
  final Set<String> _seenEvents = <String>{};
  final Random _random = Random();
  WebSocket? _socket;
  Future<void>? _connecting;
  Timer? _reconnectTimer;
  BridgeConnectionState _state = BridgeConnectionState.disconnected;
  bool _disposed = false;
  SecureChannel? _secure;
  /// Inbound frames are handled one at a time. Decryption is asynchronous, and
  /// a secure channel refuses a frame that arrives out of order, so overlapping
  /// handlers would reject perfectly good traffic.
  Future<void> _inbound = Future<void>.value();
  /// Set once this computer has proved it supports encryption. A later
  /// connection that silently drops the offer is treated as an attacker
  /// stripping it, not as an older bridge.
  bool _encryptionExpected = false;
  Completer<void>? _handshake;

  /// True while this connection is encrypted end to end with the computer.
  bool get encrypted => _secure != null;
  int _reconnectAttempt = 0;
  int _lastReceivedSequence = 0;

  Stream<BridgeConnectionState> get states => _states.stream;
  Stream<AgentEvent> get events => _events.stream;
  Stream<void> get replayGaps => _replayGaps.stream;
  BridgeConnectionState get state => _state;
  int get lastReceivedSequence => _lastReceivedSequence;

  @visibleForTesting
  void setStateForTesting(BridgeConnectionState value) => _setState(value);

  @visibleForTesting
  void reportReplayGapForTesting() => _reportReplayGap();

  Future<void> connect() {
    if (_disposed) return Future<void>.error(StateError('Transport is closed'));
    if (_socket?.readyState == WebSocket.open) return Future<void>.value();
    return _connecting ??= _open().whenComplete(() => _connecting = null);
  }

  Future<JsonMap> request(
    String type,
    JsonMap payload, {
    bool signed = true,
    String? requestId,
    Duration timeout = const Duration(minutes: 2),
  }) async {
    if (signed && endpoint.pairedHost == null)
      throw StateError('Signed requests require a paired host credential');
    final id = requestId ?? randomId('request');
    final existing = _pending[id];
    if (existing != null) return existing.completer.future;
    final envelope = <String, Object?>{
      'protocolVersion': 1,
      'messageId': randomId('message'),
      'hostId': endpoint.hostId,
      'sentAt': DateTime.now().toUtc().toIso8601String(),
      'kind': 'request',
      'type': type,
      'requestId': id,
      'payload': payload,
    };
    final completer = Completer<JsonMap>();
    late final Timer timer;
    timer = Timer(timeout, () {
      final pending = _pending.remove(id);
      if (pending != null && !pending.completer.isCompleted) {
        pending.completer.completeError(const BridgeRequestException(
            'TIMEOUT', 'Bridge request timed out',
            retryable: true));
      }
    });
    final pending = _PendingRequest(
        envelope: envelope, signed: signed, completer: completer, timer: timer);
    _pending[id] = pending;
    if (_socket?.readyState == WebSocket.open) {
      await _send(pending);
    } else {
      await connect();
    }
    return completer.future;
  }

  /// Re-authorizes event replay on a fresh socket and feeds missed events
  /// through the same de-duplicated stream as live event batches.
  Future<BridgeReplayResult> syncSince(int sequence) async {
    final result = await request(
      'sync.since',
      <String, Object?>{'sequence': sequence},
      requestId: randomId('sync'),
    );
    _emitEventValues(jsonList(result['events']));
    final latest = result['latestSequence'];
    final latestSequence = latest is num ? latest.toInt() : sequence;
    final through = result['throughSequence'];
    final throughSequence = through is num
        ? through.toInt()
        : (_lastReceivedSequence > sequence ? _lastReceivedSequence : sequence);
    final oldest = result['oldestAvailableSequence'];
    final oldestAvailableSequence = oldest is num ? oldest.toInt() : null;
    final replayGap = result['replayGap'] == true ||
        (oldestAvailableSequence != null &&
            sequence < oldestAvailableSequence - 1);
    if (latestSequence < sequence || throughSequence > _lastReceivedSequence) {
      _lastReceivedSequence = throughSequence;
    }
    return BridgeReplayResult(
      latestSequence: latestSequence,
      throughSequence: throughSequence,
      oldestAvailableSequence: oldestAvailableSequence,
      replayGap: replayGap,
    );
  }

  Future<void> close() async {
    if (_disposed) return;
    _disposed = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _setState(BridgeConnectionState.closed);
    for (final pending in _pending.values) {
      pending.timer.cancel();
      if (!pending.completer.isCompleted)
        pending.completer.completeError(StateError('Transport closed'));
    }
    _pending.clear();
    await _socket?.close(WebSocketStatus.normalClosure, 'Client closed');
    _socket = null;
    await _states.close();
    await _events.close();
    await _replayGaps.close();
  }

  Future<void> _open() async {
    _setState(_reconnectAttempt == 0
        ? BridgeConnectionState.connecting
        : BridgeConnectionState.reconnecting);
    try {
      final uri = validateBridgeEndpointUrl(endpoint.url);
      final socket = await connectWithTryCloudflareDnsFallback<WebSocket>(
        uri,
        connector: _socketConnector,
        resolver: _dnsResolver,
      );
      if (_disposed) {
        await socket.close();
        return;
      }
      _socket = socket;
      _secure = null;
      final handshake = Completer<void>();
      _handshake = handshake;
      socket.pingInterval = const Duration(seconds: 15);
      socket.listen(
        (Object? data) {
          _inbound = _inbound.then((_) => _receive(data)).catchError((Object _) {});
        },
        onDone: _disconnected,
        onError: (Object error, StackTrace stackTrace) => _disconnected(),
        cancelOnError: false,
      );
      final relayToken = endpoint.relayToken;
      final pairedHost = endpoint.pairedHost;
      if (relayToken != null) {
        socket.add(jsonEncode(<String, Object?>{
          'type': 'relay.attach',
          'role': 'device',
          'hostId': endpoint.hostId,
          'token': relayToken,
          'deviceId': endpoint.deviceId,
          // The shared room token cannot show which device this is, so the
          // relay is given the host-signed credential and a fresh signature.
          if (pairedHost != null)
            'proof': await signRelayDeviceAttach(
                host: pairedHost, token: relayToken),
        }));
      }
      // Announcing the device makes the relay create the host session, so the
      // computer's encryption offer arrives before any real request is sent.
      // It carries no secrets.
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'device',
        'deviceId': endpoint.deviceId,
      }));
      await _awaitHandshake(handshake);
      _reconnectAttempt = 0;
      _setState(BridgeConnectionState.online);
      for (final pending in _pending.values.toList(growable: false)) {
        await _send(pending);
      }
    } on Object {
      _scheduleReconnect();
      rethrow;
    }
  }

  static Future<WebSocket> _connectWebSocket(
          Uri uri, HttpClient? customClient) =>
      WebSocket.connect(uri.toString(), customClient: customClient);

  /// Waits briefly for the computer's greeting so the first real request can
  /// already be encrypted. An older bridge that never greets falls back to the
  /// previous behaviour instead of hanging.
  Future<void> _awaitHandshake(Completer<void> handshake) async {
    try {
      await handshake.future.timeout(const Duration(seconds: 6));
    } on TimeoutException {
      if (_encryptionExpected) {
        throw const BridgeRequestException(
          'ENCRYPTION_REQUIRED',
          'This computer previously used an encrypted connection and did not this time. '
              'Nothing was sent.',
          retryable: false,
        );
      }
    }
  }

  Future<void> _send(_PendingRequest pending) async {
    final socket = _socket;
    if (socket == null || socket.readyState != WebSocket.open) return;
    Object message = pending.envelope;
    if (pending.signed) {
      final host = endpoint.pairedHost;
      if (host == null)
        throw StateError('Paired host disappeared before signing');
      final signed = await security.signAction(host, pending.envelope);
      message = <String, Object?>{'kind': 'signed_action', 'signed': signed};
    }
    final channel = _secure;
    if (channel != null) {
      socket.add(jsonEncode(await channel.seal(jsonEncode(message))));
      return;
    }
    socket.add(jsonEncode(message));
  }

  Future<void> _receive(Object? raw) async {
    if (raw is! String) return;
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return;
    }
    JsonMap value = jsonMap(decoded, name: 'transport message');
    if (value['kind'] == 'secure') {
      final channel = _secure;
      if (channel == null) return;
      try {
        value = jsonMap(jsonDecode(await channel.open(value)),
            name: 'transport message');
      } on Object {
        return;
      }
      if (value['kind'] == 'secure_established') return;
    } else if (_secure != null && value['kind'] != null) {
      // The channel is live, so a readable application message did not come
      // from the computer. Drop it rather than trusting it.
      return;
    }
    if (value['type'] == 'relay.attached') return;
    if (value['type'] == 'relay.host_offline') {
      _setState(BridgeConnectionState.reconnecting);
      return;
    }
    if (value['type'] == 'transport.error') {
      if (_pending.isNotEmpty) {
        final requestId = _pending.keys.first;
        final pending = _pending.remove(requestId);
        pending?.timer.cancel();
        if (pending != null && !pending.completer.isCompleted) {
          pending.completer.completeError(BridgeRequestException(
            'TRANSPORT_ERROR',
            optionalString(value, 'message') ??
                'Bridge transport rejected the request',
            retryable: false,
          ));
        }
      }
      return;
    }
    final kind = optionalString(value, 'kind');
    if (kind == 'response') {
      _handleResponse(value);
    } else if (kind == 'event') {
      _handleEventEnvelope(value);
    } else if (kind == 'hello') {
      await _negotiateEncryption(value);
      _setState(BridgeConnectionState.online);
    }
  }

  /// Agrees a key with the computer using the identity stored at pairing. A
  /// greeting without an offer is only accepted from a computer that has never
  /// shown it can encrypt.
  Future<void> _negotiateEncryption(JsonMap hello) async {
    if (_secure != null) return;
    final host = endpoint.pairedHost;
    SecureHandshakeOffer? offer;
    try {
      offer = SecureHandshakeOffer.tryParse(hello['encryption']);
    } on SecureTransportException {
      offer = null;
    }
    if (offer == null || host == null) {
      if (offer == null && _encryptionExpected) {
        // Refusing to continue is the point: this is what a relay stripping
        // the offer looks like, and falling back hands it the plain text.
        await _failHandshake(const BridgeRequestException(
          'ENCRYPTION_REQUIRED',
          'This computer previously used an encrypted connection and did not '
              'this time. Nothing was sent.',
          retryable: false,
        ));
        return;
      }
      _finishHandshake();
      return;
    }
    try {
      final result = await acceptSecureHandshake(offer: offer, host: host);
      _socket?.add(jsonEncode(result.accept));
      _secure = result.channel;
      _encryptionExpected = true;
    } on Object catch (error) {
      await _failHandshake(BridgeRequestException(
        'ENCRYPTION_FAILED',
        error is SecureTransportException
            ? error.message
            : 'This computer could not prove its encryption key. '
                'Nothing was sent.',
        retryable: false,
      ));
      return;
    }
    _finishHandshake();
  }

  void _finishHandshake() {
    final handshake = _handshake;
    _handshake = null;
    if (handshake != null && !handshake.isCompleted) handshake.complete();
  }

  Future<void> _failHandshake(BridgeRequestException reason) async {
    final handshake = _handshake;
    _handshake = null;
    if (handshake != null && !handshake.isCompleted) {
      handshake.completeError(reason);
    }
    await _socket?.close(WebSocketStatus.policyViolation, 'Encryption refused');
  }

  void _handleResponse(JsonMap response) {
    final requestId = optionalString(response, 'requestId');
    if (requestId == null) return;
    final pending = _pending.remove(requestId);
    if (pending == null) return;
    pending.timer.cancel();
    if (response['ok'] == true) {
      pending.completer
          .complete(jsonMap(response['payload'], name: 'response payload'));
      return;
    }
    final error = response['error'] is Map<Object?, Object?>
        ? jsonMap(response['error'], name: 'response error')
        : const <String, Object?>{};
    pending.completer.completeError(BridgeRequestException(
      optionalString(error, 'code') ?? 'BRIDGE_ERROR',
      optionalString(error, 'message') ?? 'Bridge request failed',
      retryable: error['retryable'] == true,
    ));
  }

  void _handleEventEnvelope(JsonMap envelope) {
    final payload =
        jsonMap(envelope['payload'], name: 'event envelope payload');
    final previousSequence = _lastReceivedSequence;
    final values = jsonList(payload['events']);
    _emitEventValues(values);
    final through = envelope['sequence'];
    if (through is num && through.toInt() > _lastReceivedSequence) {
      _lastReceivedSequence = through.toInt();
    }
    if (payload['replayGap'] == true &&
        _lastReceivedSequence > previousSequence) {
      _reportReplayGap();
    }
    if (_seenEvents.length > 10000) {
      _seenEvents
        ..clear()
        ..addAll(values.map(AgentEvent.fromJson).map((event) => event.eventId));
    }
  }

  void _emitEventValues(List<Object?> values) {
    for (final value in values) {
      final event = AgentEvent.fromJson(value);
      if (event.sequence <= _lastReceivedSequence) continue;
      _lastReceivedSequence = event.sequence;
      if (_seenEvents.add(event.eventId)) _events.add(event);
    }
  }

  void _reportReplayGap() {
    if (!_replayGaps.isClosed) _replayGaps.add(null);
  }

  void _disconnected() {
    if (_disposed) return;
    _socket = null;
    // Session keys belong to one socket. The next connection agrees fresh ones,
    // which is what keeps past traffic unreadable if a key ever leaks.
    _secure = null;
    _finishHandshake();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_disposed || _reconnectTimer != null) return;
    _setState(BridgeConnectionState.reconnecting);
    final base = min(30000, 500 * (1 << min(_reconnectAttempt, 6)));
    _reconnectAttempt += 1;
    final jitter = (base * 0.2 * (_random.nextDouble() * 2 - 1)).round();
    _reconnectTimer = Timer(Duration(milliseconds: max(0, base + jitter)), () {
      _reconnectTimer = null;
      unawaited(connect().catchError((Object _) {}));
    });
  }

  void _setState(BridgeConnectionState value) {
    if (_state == value) return;
    _state = value;
    if (!_states.isClosed) _states.add(value);
  }
}
