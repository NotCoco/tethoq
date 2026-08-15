import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/security.dart';
import 'package:universal_agent_remote/src/transport.dart';

void main() {
  test('bridge endpoint policy requires confidentiality off the local device',
      () {
    expect(
        validateBridgeEndpointUrl('ws://127.0.0.1:8765/bridge').scheme, 'ws');
    expect(validateBridgeEndpointUrl('ws://10.0.2.2:8765/bridge').host,
        '10.0.2.2');
    expect(
        validateBridgeEndpointUrl('wss://relay.example/bridge').scheme, 'wss');

    expect(
      () => validateBridgeEndpointUrl('ws://192.168.1.20:8765/bridge'),
      throwsA(isA<FormatException>()),
    );
    expect(
      () => validateBridgeEndpointUrl('https://relay.example/bridge'),
      throwsA(isA<FormatException>()),
    );
    expect(
      () => validateBridgeEndpointUrl('wss://user:secret@relay.example/bridge'),
      throwsA(isA<FormatException>()),
    );
  });

  test('failed trycloudflare OS lookup retries with secure DNS addresses',
      () async {
    final uri =
        Uri.parse('wss://dns-fallback-example.trycloudflare.com/bridge');
    var attempts = 0;
    var resolveCalls = 0;
    HttpClient? fallbackClient;
    final result = await connectWithTryCloudflareDnsFallback<String>(
      uri,
      connector: (connectedUri, customClient) async {
        attempts += 1;
        expect(connectedUri, uri,
            reason: 'The original hostname must be retained for TLS/SNI');
        if (attempts == 1) {
          expect(customClient, isNull);
          throw const SocketException(
            "Failed host lookup: 'dns-fallback-example.trycloudflare.com'",
            osError: OSError('No address associated with hostname', 7),
          );
        }
        fallbackClient = customClient;
        return 'connected';
      },
      resolver: (host) async {
        resolveCalls += 1;
        expect(host, 'dns-fallback-example.trycloudflare.com');
        return <InternetAddress>[InternetAddress('203.0.113.10')];
      },
    );

    expect(result, 'connected');
    expect(attempts, 2);
    expect(resolveCalls, 1);
    expect(fallbackClient, isNotNull);
  });

  test('secure DNS fallback is restricted to failed trycloudflare lookups',
      () async {
    Future<void> expectNoFallback(Uri uri, SocketException error) async {
      var resolveCalls = 0;
      await expectLater(
        connectWithTryCloudflareDnsFallback<String>(
          uri,
          connector: (_, __) => Future<String>.error(error),
          resolver: (_) async {
            resolveCalls += 1;
            return <InternetAddress>[InternetAddress('203.0.113.10')];
          },
        ),
        throwsA(same(error)),
      );
      expect(resolveCalls, 0);
    }

    await expectNoFallback(
      Uri.parse('wss://bridge.example.com'),
      const SocketException("Failed host lookup: 'bridge.example.com'"),
    );
    await expectNoFallback(
      Uri.parse('ws://demo.trycloudflare.com'),
      const SocketException("Failed host lookup: 'demo.trycloudflare.com'"),
    );
    await expectNoFallback(
      Uri.parse('wss://demo.trycloudflare.com'),
      const SocketException('Connection refused'),
    );
    await expectNoFallback(
      Uri.parse('wss://trycloudflare.com'),
      const SocketException("Failed host lookup: 'trycloudflare.com'"),
    );
    await expectNoFallback(
      Uri.parse('wss://demo.trycloudflare.com.attacker.example'),
      const SocketException(
          "Failed host lookup: 'demo.trycloudflare.com.attacker.example'"),
    );
  });

  test('secure DNS accepts Cloudflare-only A and AAAA success', () async {
    final queries = <String>[];
    final addresses = await resolveTryCloudflareWithDohForTesting(
      'DEMO.trycloudflare.com',
      query: (endpoint, host, recordType) async {
        queries.add('${endpoint.host}:$recordType');
        expect(host, 'demo.trycloudflare.com');
        if (endpoint.host == 'dns.google') {
          throw const SocketException('Google DNS unavailable');
        }
        return recordType == 1
            ? <InternetAddress>[InternetAddress('203.0.113.20')]
            : <InternetAddress>[InternetAddress('2001:db8::20')];
      },
    );

    expect(
      queries.toSet(),
      <String>{
        'cloudflare-dns.com:1',
        'cloudflare-dns.com:28',
        'dns.google:1',
        'dns.google:28',
      },
    );
    expect(addresses.map((address) => address.address),
        <String>['203.0.113.20', '2001:db8::20']);
  });

  test('secure DNS accepts Google-only success and deduplicates it', () async {
    final addresses = await resolveTryCloudflareWithDohForTesting(
      'demo.trycloudflare.com',
      query: (endpoint, host, recordType) async {
        if (endpoint.host == 'cloudflare-dns.com') {
          throw const SocketException('Cloudflare DNS unavailable');
        }
        if (recordType == 28) return const <InternetAddress>[];
        return <InternetAddress>[
          InternetAddress('203.0.113.30'),
          InternetAddress('203.0.113.30'),
        ];
      },
    );

    expect(
        addresses.map((address) => address.address), <String>['203.0.113.30']);
  });

  test('secure DNS resolver does not expand beyond tunnel subdomains',
      () async {
    var queries = 0;
    Future<List<InternetAddress>> query(
        Uri endpoint, String host, int recordType) async {
      queries += 1;
      return <InternetAddress>[InternetAddress('203.0.113.40')];
    }

    await expectLater(
      resolveTryCloudflareWithDohForTesting('trycloudflare.com', query: query),
      throwsArgumentError,
    );
    await expectLater(
      resolveTryCloudflareWithDohForTesting(
        'demo.trycloudflare.com.attacker.example',
        query: query,
      ),
      throwsArgumentError,
    );
    expect(queries, 0);
  });

  test('secure DNS rejects empty, malformed, and mismatched answers', () {
    expect(parseDohAddresses(null), isEmpty);
    expect(parseDohAddresses(<String, Object?>{'Status': 3}), isEmpty);
    expect(
      parseDohAddresses(<String, Object?>{
        'Status': 0,
        'Answer': <Object?>[
          <String, Object?>{'type': 5, 'data': 'alias.example.com.'},
          <String, Object?>{'type': 1, 'data': 'not-an-address'},
          <String, Object?>{'type': 1, 'data': '2001:db8::1'},
          <String, Object?>{'type': 28, 'data': '203.0.113.5'},
        ],
      }),
      isEmpty,
    );
  });

  test('secure DNS accepts only A and AAAA answers and caps the result', () {
    final answers = <Object?>[
      <String, Object?>{'type': 1, 'data': '203.0.113.1'},
      <String, Object?>{'type': 28, 'data': '2001:db8::1'},
      for (var index = 2; index < 12; index += 1)
        <String, Object?>{'type': 1, 'data': '203.0.113.$index'},
    ];
    final addresses = parseDohAddresses(<String, Object?>{
      'Status': 0,
      'Answer': answers,
    });

    expect(addresses, hasLength(8));
    expect(addresses.first.address, '203.0.113.1');
    expect(addresses[1].address, '2001:db8::1');
  });

  test('failed lookup reports a secure DNS no-answer failure', () async {
    await expectLater(
      connectWithTryCloudflareDnsFallback<String>(
        Uri.parse('wss://demo.trycloudflare.com'),
        connector: (_, __) => Future<String>.error(
          const SocketException("Failed host lookup: 'demo.trycloudflare.com'"),
        ),
        resolver: (_) async => const <InternetAddress>[],
      ),
      throwsA(isA<SocketException>().having(
        (error) => error.message,
        'message',
        contains('Secure DNS returned no usable address'),
      )),
    );
  });

  test('sync replay advances only through the bounded response cursor',
      () async {
    final transport = _ReplayTransport();
    addTearDown(transport.close);
    final received = <int>[];
    final subscription =
        transport.events.listen((event) => received.add(event.sequence));
    addTearDown(subscription.cancel);

    final first = await transport.syncSince(5);
    await Future<void>.delayed(Duration.zero);
    expect(received, <int>[6, 7]);
    expect(first.latestSequence, 20);
    expect(first.throughSequence, 7);
    expect(transport.lastReceivedSequence, 7);

    final second = await transport.syncSince(transport.lastReceivedSequence);
    await Future<void>.delayed(Duration.zero);
    expect(transport.requestedSequences, <int>[5, 7]);
    expect(received, <int>[6, 7, 8]);
    expect(second.throughSequence, 8);
    expect(transport.lastReceivedSequence, 8);
  });

  test('sync replay adopts a reset bridge sequence after host restart',
      () async {
    final transport = _RestartReplayTransport();
    addTearDown(transport.close);
    final received = <int>[];
    final subscription =
        transport.events.listen((event) => received.add(event.sequence));
    addTearDown(subscription.cancel);

    await transport.syncSince(500);
    expect(transport.lastReceivedSequence, 3);
    await transport.syncSince(transport.lastReceivedSequence);
    await Future<void>.delayed(Duration.zero);
    expect(received, <int>[4]);
    expect(transport.lastReceivedSequence, 4);
  });
}

class _RestartReplayTransport extends BridgeTransport {
  _RestartReplayTransport()
      : super(
          endpoint: const BridgeEndpoint(
            hostId: 'host',
            url: 'ws://127.0.0.1/bridge',
            deviceId: 'device',
          ),
          security: DeviceSecurity(),
        );

  @override
  Future<Map<String, Object?>> request(
    String type,
    Map<String, Object?> payload, {
    bool signed = true,
    String? requestId,
    Duration timeout = const Duration(minutes: 2),
  }) async {
    final requested = payload['sequence']! as int;
    return <String, Object?>{
      'events': requested == 3 ? <Object?>[_eventJson(4)] : const <Object?>[],
      'requestedSequence': requested,
      'oldestAvailableSequence': 1,
      'latestSequence': requested == 3 ? 4 : 3,
      'throughSequence': requested == 3 ? 4 : 3,
      'replayGap': requested > 4,
      'omittedEventCount': 0,
    };
  }
}

class _ReplayTransport extends BridgeTransport {
  _ReplayTransport()
      : super(
          endpoint: const BridgeEndpoint(
            hostId: 'host',
            url: 'ws://127.0.0.1/bridge',
            deviceId: 'device',
          ),
          security: DeviceSecurity(),
        );

  final List<int> requestedSequences = <int>[];

  @override
  Future<Map<String, Object?>> request(
    String type,
    Map<String, Object?> payload, {
    bool signed = true,
    String? requestId,
    Duration timeout = const Duration(minutes: 2),
  }) async {
    final requested = payload['sequence']! as int;
    requestedSequences.add(requested);
    final events = requested == 5
        ? <Object?>[_eventJson(6), _eventJson(7)]
        : <Object?>[_eventJson(7), _eventJson(8)];
    return <String, Object?>{
      'events': events,
      'requestedSequence': requested,
      'oldestAvailableSequence': 1,
      'latestSequence': 20,
      'throughSequence': requested == 5 ? 7 : 8,
      'replayGap': false,
      'omittedEventCount': 0,
    };
  }
}

Map<String, Object?> _eventJson(int sequence) => <String, Object?>{
      'eventId': 'event-$sequence',
      'sequence': sequence,
      'type': 'message.delta',
      'occurredAt': '2026-08-12T12:00:00.000Z',
      'payload': const <String, Object?>{},
      'sessionId': 'host/fake/session',
      'providerId': 'fake',
    };
