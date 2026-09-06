import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cryptography/cryptography.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/json.dart';
import 'package:universal_agent_remote/src/secure_transport.dart';
import 'package:universal_agent_remote/src/security.dart';
import 'package:universal_agent_remote/src/transport.dart';

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues(<String, String>{}));

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

  test('a request from a failed connection is not sent by a later reconnect',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final receivedRequestIds = <String>[];
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'request') {
          return;
        }
        final requestId = value['requestId'] as String;
        receivedRequestIds.add(requestId);
        socket.add(jsonEncode(<String, Object?>{
          'kind': 'response',
          'requestId': requestId,
          'ok': true,
          'payload': <String, Object?>{'accepted': true},
        }));
      });
    });
    addTearDown(() async {
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    var connectionAttempts = 0;
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
      socketConnector: (uri, _) {
        connectionAttempts += 1;
        if (connectionAttempts == 1) {
          return Future<WebSocket>.error(
              const SocketException('Initial connection failed'));
        }
        return WebSocket.connect(uri.toString());
      },
    );
    addTearDown(transport.close);

    await expectLater(
      transport.request('host.get', const <String, Object?>{},
          signed: false, requestId: 'failed-request'),
      throwsA(isA<SocketException>()),
    );
    final response = await transport.request(
      'host.get',
      const <String, Object?>{},
      signed: false,
      requestId: 'successful-request',
    );

    expect(response['accepted'], true);
    expect(receivedRequestIds, <String>['successful-request']);
  });

  test('one flush send failure does not fail an earlier request already sent',
      () async {
    final secureFixture = await _secureFixture();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final receivedRequestIds = <String>[];
    final firstRequestReceived = Completer<void>();
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(secureFixture.hello));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> ||
            value['kind'] != 'signed_action') {
          return;
        }
        final signed = value['signed'];
        if (signed is! Map<String, dynamic>) return;
        final action = signed['action'];
        if (action is! Map<String, dynamic>) return;
        final requestId = action['requestId'];
        if (requestId is! String) return;
        receivedRequestIds.add(requestId);
        if (!firstRequestReceived.isCompleted) firstRequestReceived.complete();
      });
    });
    addTearDown(() async {
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: secureFixture.pairedHost.deviceId,
        pairedHost: secureFixture.pairedHost,
      ),
      security: _SecondRequestSigningFailsSecurity(),
      secureSealer: _plainTestSecureSealer,
    );
    addTearDown(transport.close);

    final first = transport.request('host.get', const <String, Object?>{},
        requestId: 'first-request');
    var firstSettled = false;
    unawaited(first.then<void>(
      (_) => firstSettled = true,
      onError: (Object _) => firstSettled = true,
    ));
    final second = transport.request('host.get', const <String, Object?>{},
        requestId: 'second-request');

    await expectLater(second, throwsA(isA<StateError>()));
    await firstRequestReceived.future.timeout(const Duration(seconds: 1));
    expect(firstSettled, false);
    expect(receivedRequestIds, <String>['first-request']);
  });

  test('an uncorrelated transport error does not fail an arbitrary request',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final requestsReceived = Completer<WebSocket>();
    final receivedRequestIds = <String>[];
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'request') {
          return;
        }
        receivedRequestIds.add(value['requestId'] as String);
        if (receivedRequestIds.length == 2 && !requestsReceived.isCompleted) {
          requestsReceived.complete(socket);
        }
      });
    });
    addTearDown(() async {
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
    );
    addTearDown(transport.close);

    var firstCompleted = false;
    var secondCompleted = false;
    final first = transport
        .request('host.get', const <String, Object?>{},
            signed: false, requestId: 'first-request')
        .whenComplete(() => firstCompleted = true);
    final second = transport
        .request('host.get', const <String, Object?>{},
            signed: false, requestId: 'second-request')
        .whenComplete(() => secondCompleted = true);
    final socket = await requestsReceived.future;
    addTearDown(socket.close);

    socket.add(jsonEncode(<String, Object?>{
      'type': 'transport.error',
      'message': 'Connection-level notice',
    }));
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(firstCompleted, false);
    expect(secondCompleted, false);

    socket.add(jsonEncode(<String, Object?>{
      'type': 'transport.error',
      'requestId': 'second-request',
      'message': 'Second request was rejected',
    }));
    await expectLater(
      second,
      throwsA(isA<BridgeRequestException>().having(
          (error) => error.message, 'message', 'Second request was rejected')),
    );
    expect(firstCompleted, false);
    expect(secondCompleted, true);

    socket.add(jsonEncode(<String, Object?>{
      'kind': 'response',
      'requestId': 'first-request',
      'ok': true,
      'payload': <String, Object?>{'accepted': true},
    }));
    expect((await first)['accepted'], true);
  });

  test('an encrypted connection ignores a plaintext transport error', () async {
    final hostIdentity = await DeviceSecurity().createDeviceIdentity();
    final deviceIdentity = await DeviceSecurity().createDeviceIdentity();
    final hostEphemeral = await X25519().newKeyPair();
    final hostEphemeralPublicKey =
        base64UrlNoPadding((await hostEphemeral.extractPublicKey()).bytes);
    final hostSigningKey = SimpleKeyPairData(
      hostIdentity.privateKeyBytes,
      publicKey: SimplePublicKey(hostIdentity.publicKeyBytes,
          type: KeyPairType.ed25519),
      type: KeyPairType.ed25519,
    );
    final hostSignature = await Ed25519().sign(
      handshakeBind(
        role: 'host',
        hostId: 'host',
        hostEphemeralPublicKey: hostEphemeralPublicKey,
      ),
      keyPair: hostSigningKey,
    );
    final pairedHost = PairedHost(
      hostId: 'host',
      hostPublicKeyPem: hostIdentity.publicKeyPem,
      endpoint: 'unused',
      deviceId: deviceIdentity.deviceId,
      devicePrivateKey: deviceIdentity.privateKeyBytes,
      devicePublicKey: deviceIdentity.publicKeyBytes,
      credential:
          const SignedCredential(payload: 'credential', signature: 'signature'),
    );

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final forgedErrorSent = Completer<void>();
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
        'encryption': <String, Object?>{
          'scheme': secureTransportScheme,
          'version': secureTransportVersion,
          'ephemeralPublicKey': hostEphemeralPublicKey,
          'signature': base64UrlNoPadding(hostSignature.bytes),
        },
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'secure') return;
        socket.add(jsonEncode(<String, Object?>{
          'type': 'transport.error',
          'requestId': 'secure-request',
          'message': 'Forged plaintext rejection',
        }));
        if (!forgedErrorSent.isCompleted) forgedErrorSent.complete();
      });
    });
    addTearDown(() async {
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: deviceIdentity.deviceId,
        pairedHost: pairedHost,
      ),
      security: DeviceSecurity(),
    );
    addTearDown(transport.close);

    var completed = false;
    final request = transport.request('host.get', const <String, Object?>{},
        signed: false, requestId: 'secure-request');
    unawaited(request.then<void>((_) => completed = true,
        onError: (Object _) => completed = true));
    await forgedErrorSent.future;
    await Future<void>.delayed(const Duration(milliseconds: 50));
    expect(transport.encrypted, true);
    expect(completed, false);

    final rejectedOnClose = expectLater(request, throwsA(isA<StateError>()));
    await transport.close();
    await rejectedOnClose;
  });

  test('a stored legacy pairing without a secure marker can use plaintext',
      () async {
    final secureFixture = await _secureFixture();
    const sharedStorage = FlutterSecureStorage();
    final originalSecurity = DeviceSecurity(storage: sharedStorage);
    await originalSecurity.saveHost(secureFixture.pairedHost);

    final restartedSecurity = DeviceSecurity(storage: sharedStorage);
    final restoredHost = (await restartedSecurity.readHosts()).single;
    expect(
      await restartedSecurity.readSecureTransportRequired(restoredHost),
      false,
    );

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'request') {
          return;
        }
        socket.add(jsonEncode(<String, Object?>{
          'kind': 'response',
          'requestId': value['requestId'],
          'ok': true,
          'payload': <String, Object?>{'legacy': true},
        }));
      });
    });
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: restoredHost.hostId,
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: restoredHost.deviceId,
        pairedHost: restoredHost,
      ),
      security: restartedSecurity,
    );
    addTearDown(() async {
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    expect(
      await transport.request(
        'host.get',
        const <String, Object?>{},
        signed: false,
        requestId: 'legacy-plaintext-probe',
        timeout: const Duration(seconds: 1),
      ),
      <String, Object?>{'legacy': true},
    );
    expect(transport.encrypted, false);
    expect(
      await restartedSecurity.readSecureTransportRequired(restoredHost),
      false,
    );
  });

  test('secure marker read failure prevents opening a socket', () async {
    final secureFixture = await _secureFixture();
    var connectorCalled = false;
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: secureFixture.pairedHost.hostId,
        url: 'ws://127.0.0.1:8765/bridge',
        deviceId: secureFixture.pairedHost.deviceId,
        pairedHost: secureFixture.pairedHost,
      ),
      security: _SecureTransportReadFailsSecurity(),
      socketConnector: (_, __) async {
        connectorCalled = true;
        throw StateError('socket connector must not be called');
      },
    );
    addTearDown(transport.close);

    await expectLater(transport.connect(), throwsA(isA<StateError>()));
    expect(connectorCalled, false);
  });

  test('an explicit invalid secure offer never falls back to plaintext',
      () async {
    final secureFixture = await _secureFixture();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var applicationFrames = 0;
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
        'encryption': <String, Object?>{
          'scheme': 'unsupported',
          'version': secureTransportVersion,
          'ephemeralPublicKey': 'invalid',
          'signature': 'invalid',
        },
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is Map<String, dynamic> && value['kind'] != 'hello') {
          applicationFrames += 1;
        }
      });
    });
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: secureFixture.pairedHost.hostId,
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: secureFixture.pairedHost.deviceId,
        pairedHost: secureFixture.pairedHost,
      ),
      security: DeviceSecurity(),
    );
    addTearDown(() async {
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await expectLater(
      transport.request(
        'host.get',
        const <String, Object?>{},
        signed: false,
        requestId: 'invalid-encryption-offer',
        timeout: const Duration(seconds: 1),
      ),
      throwsA(isA<BridgeRequestException>()
          .having((error) => error.code, 'code', 'ENCRYPTION_FAILED')),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(applicationFrames, 0,
        reason: 'an invalid encryption offer must not permit plaintext');
  });

  test('secure transport pin survives a fresh DeviceSecurity instance',
      () async {
    final secureFixture = await _secureFixture();
    const sharedStorage = FlutterSecureStorage();
    final firstSecurity = DeviceSecurity(storage: sharedStorage);
    await firstSecurity.saveHost(secureFixture.pairedHost);
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var connectionCount = 0;
    var secondConnectionApplicationFrames = 0;
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      connectionCount += 1;
      final connectionNumber = connectionCount;
      socket.add(jsonEncode(connectionNumber == 1
          ? secureFixture.hello
          : <String, Object?>{
              'kind': 'hello',
              'role': 'host',
            }));
      socket.listen((Object? raw) {
        if (connectionNumber != 2 || raw is! String) return;
        final value = jsonDecode(raw);
        if (value is Map<String, dynamic> && value['kind'] != 'hello') {
          secondConnectionApplicationFrames += 1;
        }
      });
    });
    final firstTransport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: secureFixture.pairedHost.hostId,
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: secureFixture.pairedHost.deviceId,
        pairedHost: secureFixture.pairedHost,
      ),
      security: firstSecurity,
    );
    BridgeTransport? restartedTransport;
    addTearDown(() async {
      await firstTransport.close();
      await restartedTransport?.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await firstTransport.connect();
    expect(firstTransport.encrypted, true);
    expect(
      await firstSecurity.readSecureTransportRequired(secureFixture.pairedHost),
      true,
    );
    await firstTransport.close();

    final restartedSecurity = DeviceSecurity(storage: sharedStorage);
    final restoredHost = (await restartedSecurity.readHosts()).single;
    expect(
      await restartedSecurity.readSecureTransportRequired(restoredHost),
      true,
    );
    final freshTransport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: restoredHost.hostId,
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: restoredHost.deviceId,
        pairedHost: restoredHost,
      ),
      security: restartedSecurity,
    );
    restartedTransport = freshTransport;

    await expectLater(
      freshTransport.request(
        'host.get',
        const <String, Object?>{},
        signed: false,
        requestId: 'restart-downgrade-probe',
        timeout: const Duration(seconds: 1),
      ),
      throwsA(isA<BridgeRequestException>()
          .having((error) => error.code, 'code', 'ENCRYPTION_REQUIRED')),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(connectionCount, 2);
    expect(secondConnectionApplicationFrames, 0,
        reason: 'the paired request must not be sent without a secure channel');
  });

  test('secure frames stay ordered when an earlier encryption finishes later',
      () async {
    final hostIdentity = await DeviceSecurity().createDeviceIdentity();
    final deviceIdentity = await DeviceSecurity().createDeviceIdentity();
    final hostEphemeral = await X25519().newKeyPair();
    final hostEphemeralPublicKey =
        base64UrlNoPadding((await hostEphemeral.extractPublicKey()).bytes);
    final hostSigningKey = SimpleKeyPairData(
      hostIdentity.privateKeyBytes,
      publicKey: SimplePublicKey(hostIdentity.publicKeyBytes,
          type: KeyPairType.ed25519),
      type: KeyPairType.ed25519,
    );
    final hostSignature = await Ed25519().sign(
      handshakeBind(
        role: 'host',
        hostId: 'host',
        hostEphemeralPublicKey: hostEphemeralPublicKey,
      ),
      keyPair: hostSigningKey,
    );
    final pairedHost = PairedHost(
      hostId: 'host',
      hostPublicKeyPem: hostIdentity.publicKeyPem,
      endpoint: 'unused',
      deviceId: deviceIdentity.deviceId,
      devicePrivateKey: deviceIdentity.privateKeyBytes,
      devicePublicKey: deviceIdentity.publicKeyBytes,
      credential:
          const SignedCredential(payload: 'credential', signature: 'signature'),
    );

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final receivedCounters = <int>[];
    final framesReceived = Completer<void>();
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
        'encryption': <String, Object?>{
          'scheme': secureTransportScheme,
          'version': secureTransportVersion,
          'ephemeralPublicKey': hostEphemeralPublicKey,
          'signature': base64UrlNoPadding(hostSignature.bytes),
        },
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'secure') {
          return;
        }
        final counter = value['counter'];
        if (counter is! int) return;
        receivedCounters.add(counter);
        if (receivedCounters.length == 2 && !framesReceived.isCompleted) {
          framesReceived.complete();
        }
      });
    });
    final firstSealStarted = Completer<void>();
    final releaseFirstSeal = Completer<void>();
    var nextCounter = 0;
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: deviceIdentity.deviceId,
        pairedHost: pairedHost,
      ),
      security: DeviceSecurity(),
      secureSealer: (_, __) async {
        final counter = nextCounter;
        nextCounter += 1;
        if (counter == 0) {
          firstSealStarted.complete();
          await releaseFirstSeal.future;
        }
        return <String, Object?>{
          'kind': 'secure',
          'counter': counter,
          'ciphertext': base64UrlNoPadding(<int>[counter]),
        };
      },
    );
    addTearDown(() async {
      if (!releaseFirstSeal.isCompleted) releaseFirstSeal.complete();
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await transport.connect();
    final first = transport.request(
      'session.send_message',
      const <String, Object?>{'text': 'first'},
      signed: false,
      requestId: 'first-secure-request',
    );
    unawaited(first.then<void>((_) {}, onError: (Object _, StackTrace __) {}));
    await firstSealStarted.future.timeout(const Duration(seconds: 1));
    final second = transport.request(
      'session.send_message',
      const <String, Object?>{'text': 'second'},
      signed: false,
      requestId: 'second-secure-request',
    );
    unawaited(second.then<void>((_) {}, onError: (Object _, StackTrace __) {}));
    await Future<void>.delayed(Duration.zero);
    releaseFirstSeal.complete();

    await framesReceived.future.timeout(const Duration(seconds: 1));
    expect(receivedCounters, <int>[0, 1]);
  });

  test('a request that times out while signing cannot send after its retry',
      () async {
    final secureFixture = await _secureFixture();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final receivedRequestIds = <String>[];
    final retriedRequestReceived = Completer<void>();
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(secureFixture.hello));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> ||
            value['kind'] != 'signed_action') {
          return;
        }
        final signed = value['signed'];
        if (signed is! Map<String, dynamic>) return;
        final action = signed['action'];
        if (action is! Map<String, dynamic>) return;
        final requestId = action['requestId'];
        if (requestId is! String) return;
        receivedRequestIds.add(requestId);
        if (!retriedRequestReceived.isCompleted)
          retriedRequestReceived.complete();
      });
    });
    final security = _FirstSigningGatedSecurity();
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: secureFixture.pairedHost.deviceId,
        pairedHost: secureFixture.pairedHost,
      ),
      security: security,
      secureSealer: _plainTestSecureSealer,
    );
    addTearDown(() async {
      if (!security.releaseFirst.isCompleted) security.releaseFirst.complete();
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await transport.connect();
    final firstAttempt = transport.request(
      'session.send_message',
      const <String, Object?>{'text': 'first attempt'},
      requestId: 'reused-request',
      timeout: const Duration(milliseconds: 30),
    );
    unawaited(
        firstAttempt.then<void>((_) {}, onError: (Object _, StackTrace __) {}));
    await security.firstStarted.future.timeout(const Duration(seconds: 1));
    final timeoutObserved = transport.request(
      'session.send_message',
      const <String, Object?>{'text': 'first attempt'},
      requestId: 'reused-request',
      timeout: const Duration(milliseconds: 30),
    );
    await expectLater(
      timeoutObserved,
      throwsA(isA<BridgeRequestException>()
          .having((error) => error.code, 'code', 'TIMEOUT')),
    );

    final retried = transport.request(
      'session.send_message',
      const <String, Object?>{'text': 'retry'},
      requestId: 'reused-request',
      timeout: const Duration(seconds: 1),
    );
    unawaited(retried.then<void>((_) {}, onError: (Object _) {}));
    await retriedRequestReceived.future.timeout(const Duration(seconds: 1));
    security.releaseFirst.complete();
    await Future<void>.delayed(const Duration(milliseconds: 100));

    expect(receivedRequestIds, <String>['reused-request'],
        reason: 'the timed-out pending request must never transmit late');
  });

  test(
      'malformed successful payloads settle once and do not poison later responses',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((WebSocket socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'request') {
          return;
        }
        final requestId = value['requestId'];
        if (requestId is! String) return;
        final response = <String, Object?>{
          'kind': 'response',
          'requestId': requestId,
          'ok': true,
        };
        if (requestId == 'scalar-payload') {
          response['payload'] = 7;
        } else if (requestId == 'valid-payload') {
          response['payload'] = <String, Object?>{'accepted': true};
        }
        socket.add(jsonEncode(response));
        if (requestId == 'missing-payload') {
          socket.add(jsonEncode(<String, Object?>{
            ...response,
            'payload': <String, Object?>{'duplicate': true},
          }));
        }
      });
    });
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
    );
    addTearDown(() async {
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });
    final completionCounts = <String, int>{};

    Future<Map<String, Object?>> send(String requestId) => transport
            .request(
          'session.send_message',
          <String, Object?>{'text': requestId},
          signed: false,
          requestId: requestId,
          timeout: const Duration(seconds: 1),
        )
            .whenComplete(() {
          completionCounts.update(requestId, (count) => count + 1,
              ifAbsent: () => 1);
        });

    expect(
      await send('missing-payload').timeout(const Duration(seconds: 2)),
      isEmpty,
    );
    expect(
      await send('scalar-payload').timeout(const Duration(seconds: 2)),
      isEmpty,
    );
    expect(
      await send('valid-payload').timeout(const Duration(seconds: 2)),
      <String, Object?>{'accepted': true},
    );
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(completionCounts, <String, int>{
      'missing-payload': 1,
      'scalar-payload': 1,
      'valid-payload': 1,
    });
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

  test('requests wait for the handshake even when the WebSocket is open',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final acceptedSocket = Completer<WebSocket>();
    final applicationRequestReceived = Completer<void>();
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((socket) {
      acceptedSocket.complete(socket);
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'request') {
          return;
        }
        if (!applicationRequestReceived.isCompleted) {
          applicationRequestReceived.complete();
        }
        socket.add(jsonEncode(<String, Object?>{
          'kind': 'response',
          'requestId': value['requestId'],
          'ok': true,
          'payload': <String, Object?>{'ready': true},
        }));
      });
    });
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
    );
    addTearDown(() async {
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    final firstConnect = transport.connect();
    final socket = await acceptedSocket.future;
    addTearDown(() => socket.close());
    var secondConnectCompleted = false;
    final secondConnect = transport.connect().then<void>((_) {
      secondConnectCompleted = true;
    });
    final response = transport.request(
      'host.get',
      const <String, Object?>{},
      signed: false,
      requestId: 'during-handshake',
      timeout: const Duration(seconds: 1),
    );

    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(secondConnectCompleted, false);
    expect(applicationRequestReceived.isCompleted, false,
        reason: 'application data must not bypass encryption negotiation');

    socket.add(jsonEncode(<String, Object?>{
      'kind': 'hello',
      'role': 'host',
    }));
    await firstConnect;
    await secondConnect;
    expect((await response)['ready'], true);
    expect(applicationRequestReceived.isCompleted, true);
  });

  test('a socket closing during its handshake never reports online', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((socket) {
      Future<void>.delayed(
        const Duration(milliseconds: 10),
        () => socket.close(WebSocketStatus.goingAway, 'Handshake interrupted'),
      );
    });
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
    );
    final states = <BridgeConnectionState>[];
    final stateSubscription = transport.states.listen(states.add);
    addTearDown(() async {
      await stateSubscription.cancel();
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await expectLater(
      transport.connect().timeout(const Duration(seconds: 1)),
      throwsA(isA<BridgeRequestException>()
          .having((error) => error.code, 'code', 'CONNECTION_CLOSED')),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(states, isNot(contains(BridgeConnectionState.online)));
  });

  test('foreground resume cancels reconnect backoff and connects immediately',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
      }));
      socket.listen((_) {});
    });
    var connectionAttempts = 0;
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
      socketConnector: (uri, _) {
        connectionAttempts += 1;
        if (connectionAttempts == 1) {
          return Future<WebSocket>.error(
              const SocketException('Background connection failed'));
        }
        return WebSocket.connect(uri.toString());
      },
    );
    addTearDown(() async {
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await expectLater(transport.connect(), throwsA(isA<SocketException>()));
    expect(
      await transport
          .resumeFromBackground()
          .timeout(const Duration(seconds: 1)),
      true,
    );

    expect(connectionAttempts, 2);
    expect(transport.state, BridgeConnectionState.online);
    await Future<void>.delayed(const Duration(milliseconds: 700));
    expect(connectionAttempts, 2,
        reason: 'the cancelled reconnect timer must not open another socket');
  });

  test('failed foreground probe replaces only the stale socket', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var connectionCount = 0;
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((socket) {
      connectionCount += 1;
      final connectionNumber = connectionCount;
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is! Map<String, dynamic> || value['kind'] != 'request') {
          return;
        }
        if (connectionNumber == 1 && value['type'] == 'host.get') return;
        socket.add(jsonEncode(<String, Object?>{
          'kind': 'response',
          'requestId': value['requestId'],
          'ok': true,
          'payload': <String, Object?>{'connection': connectionNumber},
        }));
      });
    });
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
    );
    addTearDown(() async {
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await transport.connect();
    expect(
      await transport
          .resumeFromBackground(probeTimeout: const Duration(milliseconds: 40))
          .timeout(const Duration(seconds: 1)),
      true,
    );
    final response = await transport.request(
      'host.get',
      const <String, Object?>{},
      signed: false,
      timeout: const Duration(seconds: 1),
    );

    expect(response['connection'], 2);
    expect(transport.state, BridgeConnectionState.online);
    await Future<void>.delayed(const Duration(milliseconds: 700));
    expect(connectionCount, 2,
        reason: 'the retired socket must not disconnect its replacement');
    expect(transport.state, BridgeConnectionState.online);
  });

  test('foreground probe reports no replacement when transport is disposed',
      () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final probeReceived = Completer<void>();
    final serverSubscription =
        server.transform(WebSocketTransformer()).listen((socket) {
      socket.add(jsonEncode(<String, Object?>{
        'kind': 'hello',
        'role': 'host',
      }));
      socket.listen((Object? raw) {
        if (raw is! String) return;
        final value = jsonDecode(raw);
        if (value is Map<String, dynamic> &&
            value['kind'] == 'request' &&
            value['type'] == 'host.get' &&
            !probeReceived.isCompleted) {
          probeReceived.complete();
        }
      });
    });
    final transport = BridgeTransport(
      endpoint: BridgeEndpoint(
        hostId: 'host',
        url: 'ws://${server.address.address}:${server.port}/bridge',
        deviceId: 'device',
      ),
      security: DeviceSecurity(),
    );
    addTearDown(() async {
      await transport.close();
      await serverSubscription.cancel();
      await server.close(force: true);
    });

    await transport.connect();
    final resume = transport.resumeFromBackground(
      probeTimeout: const Duration(seconds: 2),
    );
    await probeReceived.future.timeout(const Duration(seconds: 1));
    await transport.close();

    expect(await resume, false,
        reason: 'disposal did not complete a replacement connection');
  });
}

Future<({PairedHost pairedHost, Map<String, Object?> hello})>
    _secureFixture() async {
  final hostIdentity = await DeviceSecurity().createDeviceIdentity();
  final deviceIdentity = await DeviceSecurity().createDeviceIdentity();
  final hostEphemeral = await X25519().newKeyPair();
  final hostEphemeralPublicKey =
      base64UrlNoPadding((await hostEphemeral.extractPublicKey()).bytes);
  final hostSignature = await Ed25519().sign(
    handshakeBind(
      role: 'host',
      hostId: 'host',
      hostEphemeralPublicKey: hostEphemeralPublicKey,
    ),
    keyPair: SimpleKeyPairData(
      hostIdentity.privateKeyBytes,
      publicKey: SimplePublicKey(
        hostIdentity.publicKeyBytes,
        type: KeyPairType.ed25519,
      ),
      type: KeyPairType.ed25519,
    ),
  );
  return (
    pairedHost: PairedHost(
      hostId: 'host',
      hostPublicKeyPem: hostIdentity.publicKeyPem,
      endpoint: 'unused',
      deviceId: deviceIdentity.deviceId,
      devicePrivateKey: deviceIdentity.privateKeyBytes,
      devicePublicKey: deviceIdentity.publicKeyBytes,
      credential:
          const SignedCredential(payload: 'credential', signature: 'signature'),
    ),
    hello: <String, Object?>{
      'kind': 'hello',
      'role': 'host',
      'encryption': <String, Object?>{
        'scheme': secureTransportScheme,
        'version': secureTransportVersion,
        'ephemeralPublicKey': hostEphemeralPublicKey,
        'signature': base64UrlNoPadding(hostSignature.bytes),
      },
    },
  );
}

Future<Map<String, Object?>> _plainTestSecureSealer(
        SecureChannel _, String plaintext) async =>
    jsonMap(jsonDecode(plaintext), name: 'test secure plaintext');

class _SecureTransportReadFailsSecurity extends DeviceSecurity {
  @override
  Future<bool> readSecureTransportRequired(PairedHost host) async {
    throw StateError('secure storage unavailable');
  }
}

class _SecondRequestSigningFailsSecurity extends DeviceSecurity {
  @override
  Future<Map<String, Object?>> signAction(
      PairedHost host, Map<String, Object?> action) async {
    if (action['requestId'] == 'second-request') {
      throw StateError('second request signing failed');
    }
    return <String, Object?>{
      'credential': host.credential.toJson(),
      'actionId': 'test-action',
      'issuedAt': '2026-08-27T12:00:00.000Z',
      'expiresAt': '2026-08-27T12:01:00.000Z',
      'action': action,
      'signature': 'test-signature',
    };
  }
}

class _FirstSigningGatedSecurity extends DeviceSecurity {
  final Completer<void> firstStarted = Completer<void>();
  final Completer<void> releaseFirst = Completer<void>();
  var _calls = 0;

  @override
  Future<Map<String, Object?>> signAction(
      PairedHost host, Map<String, Object?> action) async {
    _calls += 1;
    final call = _calls;
    if (call == 1) {
      firstStarted.complete();
      await releaseFirst.future;
    }
    return <String, Object?>{
      'credential': host.credential.toJson(),
      'actionId': 'test-action-$call',
      'issuedAt': '2026-09-02T12:00:00.000Z',
      'expiresAt': '2026-09-02T12:01:00.000Z',
      'action': action,
      'signature': 'test-signature-$call',
    };
  }
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
