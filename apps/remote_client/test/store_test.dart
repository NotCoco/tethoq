import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/draft_journal.dart';
import 'package:universal_agent_remote/src/ears.dart';
import 'package:universal_agent_remote/src/json.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/security.dart';
import 'package:universal_agent_remote/src/store.dart';
import 'package:universal_agent_remote/src/transport.dart';

void main() {
  test('per-Agent defaults persist and seed a new prepared task', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveAgentDefault(const DelegationSelection(
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    ));
    final store = RemoteAppStore(security: security);
    addTearDown(store.dispose);
    await store.initialize();
    store.providers.add(const ProviderConnection(
      providerId: 'codex',
      displayName: 'Codex',
      state: 'online',
      detected: true,
      authenticated: true,
      capabilities: ProviderCapabilities(
        createSession: true,
        modelEnumeration: true,
      ),
    ));
    store.modelsByProvider['codex'] = const <RemoteModel>[
      RemoteModel(
        id: 'gpt-5.6-sol',
        providerId: 'codex',
        displayName: 'GPT-5.6 Sol',
        isDefault: true,
        nativeMetadata: <String, Object?>{
          'supportedReasoningEfforts': <Object?>[
            <String, Object?>{'reasoningEffort': 'light'},
            <String, Object?>{'reasoningEffort': 'ultra'},
          ],
          'defaultReasoningEffort': 'light',
        },
      ),
    ];

    final resolved = store.agentDefaultSelectionFor(
        'codex', store.modelsByProvider['codex']!);
    expect(resolved?.modelId, 'gpt-5.6-sol');
    expect(resolved?.reasoningEffort, 'ultra');

    final prepared = store.prepareSession('codex');
    expect(prepared.modelId, 'gpt-5.6-sol');
    expect(prepared.reasoningEffort, 'ultra');

    final projectPrepared = store.prepareSession(
      'codex',
      workingDirectory: r'  C:\Projects\Tethoq  ',
    );
    expect(projectPrepared.workingDirectory, r'C:\Projects\Tethoq');
    var directoryNotifications = 0;
    store.addListener(() => directoryNotifications += 1);
    store.updatePreparedDirectory(
      projectPrepared.id,
      r'C:\Projects\Another Tethoq',
    );
    expect(directoryNotifications, 1);
    expect(
      store.sessions
          .firstWhere((session) => session.id == projectPrepared.id)
          .workingDirectory,
      r'C:\Projects\Another Tethoq',
    );

    await store.setAgentDefault(const DelegationSelection(
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'light',
    ));
    final reopened = RemoteAppStore(security: security);
    addTearDown(reopened.dispose);
    await reopened.initialize();
    expect(reopened.agentDefaults['codex']?.modelId, 'gpt-5.6-sol');
    expect(reopened.agentDefaults['codex']?.reasoningEffort, 'light');
  });

  test('reasoning display preference persists without changing model effort',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveReasoningDisplayMode('expanded');
    final store = RemoteAppStore(security: security);
    addTearDown(store.dispose);

    await store.initialize();
    expect(store.reasoningDisplayMode, 'expanded');

    await store.setReasoningDisplayMode('compact');
    expect(store.reasoningDisplayMode, 'compact');
    expect(await security.readReasoningDisplayMode(), 'compact');
    await expectLater(
      security.saveReasoningDisplayMode('verbose'),
      throwsArgumentError,
    );
  });

  test('initialize paints saved local state before network bootstrap completes',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final connectGate = Completer<void>();
    final transport = _FakeTransport(security: security)
      ..connectGate = connectGate;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    var initializeCompleted = false;

    final initialization = store.initialize().whenComplete(() {
      initializeCompleted = true;
    });
    await _waitFor(() => store.initialized && store.hosts.isNotEmpty);

    expect(store.hosts.single.hostId, _host.hostId);
    expect(initializeCompleted, isFalse);

    connectGate.complete();
    await initialization;
    expect(initializeCompleted, isTrue);
  });

  test('cold start chooses the last active computer instead of sorted first',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_otherHost);
    await security.saveHost(_host);
    await security.saveLastActiveHostId(_otherHost.hostId);
    final first = _FakeTransport(security: security, host: _host);
    final last = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? last : first,
    );
    addTearDown(store.dispose);

    await store.initialize();

    expect(store.hosts.map((host) => host.hostId),
        <String>[_host.hostId, _otherHost.hostId]);
    expect(store.activeHost?.hostId, _otherHost.hostId);
    expect(first.connectCalls, 0);
    expect(last.connectCalls, 1);
    expect(await security.readLastActiveHostId(), _otherHost.hostId);

    await security.removeHost(_otherHost.hostId);
    expect(await security.readLastActiveHostId(), isNull);
  });

  test('pairing hides network details and can be retried', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    var connectionAttempts = 0;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, security) {
        connectionAttempts += 1;
        return _FailingPairTransport(
          endpoint: endpoint,
          security: security,
          error: const SocketException(
            "Failed host lookup: 'private-tunnel.trycloudflare.com'",
            osError: OSError('No address associated with hostname', 7),
          ),
        );
      },
    );
    addTearDown(store.dispose);
    final payload = jsonEncode(<String, Object?>{
      'version': 1,
      'hostId': 'pairing-host',
      'hostPublicKeyPem': 'unused-before-connect',
      'pairingId': 'pairing-id',
      'secret': 'pairing-secret',
      'shortCode': '123456',
      'expiresAt': DateTime.now()
          .toUtc()
          .add(const Duration(minutes: 5))
          .toIso8601String(),
      'relayUrl': 'wss://private-tunnel.trycloudflare.com',
    });

    Future<void> tryPairing() => store.pair(
          payloadText: payload,
          confirmedShortCode: '123456',
        );

    await expectLater(tryPairing(), throwsA(isA<SocketException>()));
    expect(
      store.error,
      'The secure connection to this computer could not be reached. '
      'Generate a new connection code, check that both devices are online, '
      'then scan it again.',
    );
    expect(store.error, isNot(contains('SocketException')));
    expect(store.error, isNot(contains('trycloudflare.com')));
    expect(store.error, isNot(contains('errno')));

    await expectLater(tryPairing(), throwsA(isA<SocketException>()));
    expect(connectionAttempts, 2);
  });

  test('a saved computer reports a calm offline state and recovers in place',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = _CredentialPayloadSecurity();
    await security.saveHost(_host);
    late _InitiallyUnavailableTransport transport;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) =>
          transport = _InitiallyUnavailableTransport(security: security),
    );
    addTearDown(store.dispose);

    await store.initialize();

    expect(store.hasHosts, isTrue);
    expect(store.error, 'Not connected');
    expect(store.error, isNot(contains('SocketException')));
    expect(store.error, isNot(contains('trycloudflare.com')));

    await transport.reconnectForTesting();
    await _waitFor(() => transport.refreshCalls > 0 && store.error == null);

    expect(store.connectionState, BridgeConnectionState.online);
    expect(store.hasHosts, isTrue);
  });

  test('removing a connected computer revokes this phone before local cleanup',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = _CredentialPayloadSecurity();
    await security.saveHost(_host);
    late _FakeTransport transport;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport = _FakeTransport(
        security: security,
        host: _host,
      ),
    );
    addTearDown(store.dispose);
    await store.initialize();

    await store.removeHost(_host.hostId);

    expect(transport.revokedCredentialId, 'current-credential');
    expect(transport.revokeTimeout, const Duration(seconds: 5));
    expect(store.hasHosts, isFalse);
    expect(store.activeHost, isNull);
    expect(store.connectionState, BridgeConnectionState.disconnected);
    expect(store.error, isNull);
    expect(await security.readHosts(), isEmpty);
  });

  test('offline unpair stays local and never exposes a transport diagnostic',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = _CredentialPayloadSecurity();
    await security.saveHost(_host);
    late _FakeTransport transport;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport = _FakeTransport(
        security: security,
        host: _host,
      ),
    );
    addTearDown(store.dispose);
    await store.initialize();
    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    await _waitFor(
        () => store.connectionState == BridgeConnectionState.reconnecting);
    store.error =
        'SocketException: Secure DNS returned no usable address for private.trycloudflare.com';

    await store.removeHost(_host.hostId);

    expect(transport.revokedCredentialId, isNull);
    expect(store.hasHosts, isFalse);
    expect(store.activeHost, isNull);
    expect(store.error, isNull);
    expect(await security.readHosts(), isEmpty);
  });

  test('initial queue snapshot waits for provider session refresh', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)..delayRefresh = true;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);

    expect(transport.queueListedAfterRefresh, isTrue);
  });

  test(
      'stale session refresh preserves newer live fields and sessions added or updated in flight',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    const otherSessionId = 'host/fake/other-live';
    final transport = _FakeTransport(security: security)
      ..extraSessions = <Object?>[
        <String, Object?>{
          ..._sessionJson('idle', DateTime.utc(2026, 8, 10, 9)),
          'id': otherSessionId,
          'providerSessionId': 'other-live',
          'title': 'Other live task',
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.selectedSession =
        store.sessions.singleWhere((item) => item.id == _sessionId);

    final gate = Completer<void>();
    transport
      ..refreshGate = gate
      ..refreshResponseSessions = <Object?>[
        <String, Object?>{
          ..._sessionJson('idle', DateTime.utc(2026, 8, 10, 8)),
          'needsApproval': true,
          'modelId': 'stale-model',
          'reasoningEffort': 'low',
          'variantId': 'stale-variant',
        },
      ];
    final refreshing = store.refresh();
    await _waitFor(() => transport.refreshCalls == 2);

    final mainEventAt = DateTime.utc(2026, 8, 27, 13);
    store.applyEventForTesting(AgentEvent(
      eventId: 'main-live-update',
      sequence: 20,
      type: 'session.updated',
      occurredAt: mainEventAt,
      sessionId: _sessionId,
      providerId: 'fake',
      payload: const <String, Object?>{
        'state': 'working',
        'modelId': 'live-model',
        'reasoningEffort': 'high',
        'variantId': 'live-variant',
      },
    ));
    store.applyEventForTesting(AgentEvent(
      eventId: 'other-live-update',
      sequence: 21,
      type: 'session.updated',
      occurredAt: DateTime.utc(2026, 8, 27, 13, 1),
      sessionId: otherSessionId,
      providerId: 'fake',
      payload: const <String, Object?>{'state': 'working'},
    ));
    store.sessions.add(RemoteSession(
      id: 'host/fake/created-in-flight',
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'created-in-flight',
      title: 'Created while refreshing',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 27, 13, 2),
      needsApproval: false,
      stale: false,
    ));

    gate.complete();
    await refreshing;

    final main = store.sessions.singleWhere((item) => item.id == _sessionId);
    expect(main.state, 'working');
    expect(main.needsApproval, isFalse);
    expect(main.modelId, 'live-model');
    expect(main.reasoningEffort, 'high');
    expect(main.variantId, 'live-variant');
    expect(main.lastActivityAt, mainEventAt);
    expect(store.selectedSession?.state, 'working');
    expect(store.selectedSession?.modelId, 'live-model');
    expect(store.selectedSession?.lastActivityAt, mainEventAt);
    expect(
        store.sessions.singleWhere((item) => item.id == otherSessionId).state,
        'working');
    expect(store.sessions.map((item) => item.id),
        contains('host/fake/created-in-flight'));
  });

  test(
      'host-advertised community connectors remain usable without name filters',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..extraProviders = <Object?>[
        _providerJson('claude', 'Community connector'),
        _providerJson('anthropic', 'Community connector'),
        _providerJson('tethoq', 'Tethoq'),
        _providerJson('future-harness', 'Future harness'),
      ]
      ..extraSessions = <Object?>[
        _providerSessionJson('claude', 'community-session'),
        _providerSessionJson('tethoq', 'tethoq-session'),
        _providerSessionJson('future-harness', 'future-session'),
      ]
      ..extraDictationSources = <Object?>[
        _dictationSourceJson('anthropic-stt', 'Community speech-to-text'),
        _dictationSourceJson('future-stt', 'Future speech-to-text'),
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);

    expect(
        store.providers.map((provider) => provider.providerId),
        containsAll(<String>[
          'fake',
          'claude',
          'anthropic',
          'tethoq',
          'future-harness'
        ]));
    expect(
        store.sessions.map((session) => session.id),
        containsAll(<String>[
          _sessionId,
          'host/claude/community-session',
          'host/tethoq/tethoq-session',
          'host/future-harness/future-session'
        ]));
    expect(store.sessions.map((session) => session.providerId),
        contains('claude'));
    expect(store.sessions.map((session) => session.providerId),
        contains('tethoq'));
    expect(
        store.dictationSources.map((source) => source.id),
        containsAll(
            <String>['openai-stt', 'xai-stt', 'anthropic-stt', 'future-stt']));

    await store.createSession(
      providerId: 'claude',
      workingDirectory: r'C:\work',
      firstInstruction: '',
    );
    await store.loadModels('anthropic');
    expect(transport.createCalls, 1);
    expect(transport.modelCalls, 1);
  });

  test(
      'visual support target, status, and configuration RPCs stay session scoped',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final targets = await store.loadVisionProxyTargets();
    final initial = await store.loadVisionProxy(_sessionId);
    final configured = await store.configureVisionProxy(
      _sessionId,
      const VisionProxySelection(
        providerId: 'codex',
        modelId: 'vision-model',
        reasoningEffort: 'high',
      ),
    );

    expect(targets.single.models.single.supportsImageInput, isTrue);
    expect(initial.configured, isNull);
    expect(configured.configured?.reasoningEffort, 'high');
    expect(transport.lastVisionConfigurePayload, <String, Object?>{
      'sessionId': _sessionId,
      'selection': <String, Object?>{
        'providerId': 'codex',
        'modelId': 'vision-model',
        'reasoningEffort': 'high',
      },
    });
    expect(
        store.visionBySession[_sessionId]?.configured?.modelId, 'vision-model');
  });

  test('forced visual target refreshes share one in-flight request', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    transport.visionTargetsGate = Completer<void>();

    final first = store.loadVisionProxyTargets(force: true);
    final second = store.loadVisionProxyTargets(force: true);
    await Future<void>.delayed(Duration.zero);

    expect(transport.visionTargetCalls, 1);
    transport.visionTargetsGate!.complete();
    final results = await Future.wait(<Future<List<VisionProxyTarget>>>[
      first,
      second,
    ]);
    expect(results[0].single.models.single.id, 'vision-model');
    expect(results[1].single.models.single.id, 'vision-model');
    expect(transport.visionTargetCalls, 1);
  });

  test('incomplete visual target refresh keeps the last usable catalogue',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.loadVisionProxyTargets(force: true);
    transport
      ..visionTargetsIncomplete = true
      ..visionTargetsEmpty = true;
    final partial = await store.loadVisionProxyTargets(force: true);

    expect(partial.single.models.single.id, 'vision-model');
    expect(store.visionProxyTargetsIncomplete, isTrue);

    transport.visionTargetsIncomplete = false;
    final completeEmpty = await store.loadVisionProxyTargets(force: true);
    expect(completeEmpty, isEmpty);
    expect(store.visionProxyTargetsIncomplete, isFalse);
  });

  test('a visual target response from the previous host is never returned',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final firstTransport = _FakeTransport(
      security: security,
      host: _host,
      visionModelId: 'old-host-vision',
    )..visionTargetsGate = Completer<void>();
    final secondTransport = _FakeTransport(
      security: security,
      host: _otherHost,
      visionModelId: 'new-host-vision',
    );
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _host.hostId ? firstTransport : secondTransport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);
    final staleLoad = store.loadVisionProxyTargets(force: true);
    await Future<void>.delayed(Duration.zero);
    await store.connectHost(_otherHost);
    final current = await store.loadVisionProxyTargets(force: true);
    firstTransport.visionTargetsGate!.complete();
    final staleResult = await staleLoad;

    expect(current.single.models.single.id, 'new-host-vision');
    expect(staleResult.map((target) => target.models.single.id),
        isNot(contains('old-host-vision')));
    expect(store.cachedVisionProxyTargets.single.models.single.id,
        'new-host-vision');
  });

  test('visual support events hot-sync selection without helper metadata', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);

    store.applyEventForTesting(AgentEvent(
      eventId: 'vision-update',
      sequence: 1,
      type: 'session.vision_updated',
      occurredAt: DateTime.utc(2026, 8, 27, 12),
      sessionId: _sessionId,
      providerId: 'fake',
      payload: const <String, Object?>{
        'vision': <String, Object?>{
          'sessionId': _sessionId,
          'primaryModelSupportsImageInput': false,
          'configured': <String, Object?>{
            'providerId': 'codex',
            'modelId': 'vision-model',
            'reasoningEffort': 'high',
          },
          'helperSessionId': 'host/codex/internal-secret',
          'nativeMetadata': <String, Object?>{
            'internalPurpose': 'vision_proxy'
          },
        },
      },
    ));

    final status = store.visionBySession[_sessionId]!;
    expect(status.configured?.modelId, 'vision-model');
    expect(status.configured?.reasoningEffort, 'high');
    expect(status.toString(), isNot(contains('internal-secret')));
    expect(status.toString(), isNot(contains('vision_proxy')));
  });

  test('a delayed visual status read cannot overwrite a newer live update',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..visionStatusGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final loading = store.loadVisionProxy(_sessionId);
    await Future<void>.delayed(Duration.zero);
    store.applyEventForTesting(AgentEvent(
      eventId: 'newer-vision-update',
      sequence: 2,
      type: 'session.vision_updated',
      occurredAt: DateTime.utc(2026, 8, 27, 12, 1),
      sessionId: _sessionId,
      providerId: 'fake',
      payload: const <String, Object?>{
        'vision': <String, Object?>{
          'sessionId': _sessionId,
          'primaryModelSupportsImageInput': false,
          'configured': <String, Object?>{
            'providerId': 'codex',
            'modelId': 'newer-live-model',
          },
        },
      },
    ));
    transport.visionStatusGate!.complete();

    final returned = await loading;
    expect(returned.configured?.modelId, 'newer-live-model');
    expect(store.visionBySession[_sessionId]?.configured?.modelId,
        'newer-live-model');
  });

  test('a live visual update wins over an older configure response', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..visionConfigureGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final saving = store.configureVisionProxy(
      _sessionId,
      const VisionProxySelection(
          providerId: 'codex', modelId: 'older-save-model'),
    );
    await Future<void>.delayed(Duration.zero);
    store.applyEventForTesting(AgentEvent(
      eventId: 'newer-vision-during-save',
      sequence: 3,
      type: 'session.vision_updated',
      occurredAt: DateTime.utc(2026, 8, 27, 12, 2),
      sessionId: _sessionId,
      providerId: 'fake',
      payload: const <String, Object?>{
        'vision': <String, Object?>{
          'sessionId': _sessionId,
          'primaryModelSupportsImageInput': false,
          'configured': <String, Object?>{
            'providerId': 'codex',
            'modelId': 'newer-live-model',
          },
        },
      },
    ));
    transport.visionConfigureGate!.complete();

    final returned = await saving;
    expect(returned.configured?.modelId, 'newer-live-model');
    expect(store.visionBySession[_sessionId]?.configured?.modelId,
        'newer-live-model');
  });

  test(
      'same-host replay recovery refreshes selected visual status and clears the rest',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    const otherSessionId = 'host/fake/session-two';
    final transport = _FakeTransport(security: security)
      ..extraSessions = <Object?>[
        <String, Object?>{
          ..._sessionJson('idle', DateTime.utc(2026, 8, 10, 9)),
          'id': otherSessionId,
          'providerSessionId': 'session-two',
          'title': 'Other task',
        },
      ]
      ..visionStatusSelection = const VisionProxySelection(
        providerId: 'codex',
        modelId: 'before-reconnect',
      );
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.loadVisionProxy(_sessionId);
    await store.loadVisionProxy(otherSessionId);
    await store.openSession(
        store.sessions.firstWhere((session) => session.id == _sessionId));
    expect(store.visionBySession.keys,
        containsAll(<String>[_sessionId, otherSessionId]));

    final callsBeforeRecovery = transport.visionStatusCalls;
    transport
      ..visionStatusSelection = const VisionProxySelection(
        providerId: 'codex',
        modelId: 'after-reconnect',
      )
      ..syncReplayGap = true;
    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    transport.setStateForTesting(BridgeConnectionState.online);

    await _waitFor(() =>
        transport.visionStatusCalls > callsBeforeRecovery &&
        store.visionBySession[_sessionId]?.configured?.modelId ==
            'after-reconnect');
    expect(store.visionBySession.containsKey(otherSessionId), isFalse);
  });

  test('context usage and compaction threshold stay session scoped', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final initial = await store.loadSessionContext(_sessionId);
    final updated = await store.setSessionCompactionThreshold(_sessionId, 64000,
        compactNow: true);

    expect(initial.usedTokens, 42800);
    expect(updated.compactionThresholdTokens, 64000);
    expect(store.contextBySession[_sessionId]?.usage.cost, .42);
    expect(transport.lastContextThresholdPayload, <String, Object?>{
      'sessionId': _sessionId,
      'thresholdTokens': 64000,
      'compactNow': true,
    });
  });

  test('newer context reads and threshold updates reject older responses',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final olderReadGate = Completer<void>();
    transport.contextGetGate = olderReadGate;
    final olderRead = store.loadSessionContext(_sessionId);
    await _waitFor(() => transport.contextGetCalls == 1);
    transport.contextGetGate = null;
    final newerThreshold = await store
        .setSessionCompactionThreshold(_sessionId, 64000, compactNow: false);
    olderReadGate.complete();

    expect(newerThreshold.compactionThresholdTokens, 64000);
    await expectLater(olderRead, throwsA(isA<StateError>()));
    expect(
        store.contextBySession[_sessionId]?.compactionThresholdTokens, 64000);

    final olderThresholdGate = Completer<void>();
    transport.contextThresholdGate = olderThresholdGate;
    final olderThreshold = store
        .setSessionCompactionThreshold(_sessionId, 48000, compactNow: false);
    await _waitFor(() => transport.contextThresholdCalls == 2);
    transport.contextThresholdGate = null;
    final newerRead = await store.loadSessionContext(_sessionId);
    olderThresholdGate.complete();

    expect(newerRead.compactionThresholdTokens, 96000);
    await expectLater(olderThreshold, throwsA(isA<StateError>()));
    expect(
        store.contextBySession[_sessionId]?.compactionThresholdTokens, 96000);
  });

  test('context response from a previous host cannot repopulate active state',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final first = _FakeTransport(security: security);
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _host.hostId ? first : second,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final gate = Completer<void>();
    first.contextGetGate = gate;
    final staleRead = store.loadSessionContext(_sessionId);
    await _waitFor(() => first.contextGetCalls == 1);
    await store.connectHost(_otherHost);
    gate.complete();

    await expectLater(staleRead, throwsA(isA<StateError>()));
    expect(store.activeHost?.hostId, _otherHost.hostId);
    expect(store.contextBySession, isEmpty);
  });

  test('context response from a replaced transport cannot overwrite new state',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final first = _FakeTransport(security: security)
      ..contextGetGate = Completer<void>();
    final second = _FakeTransport(security: security);
    var connection = 0;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => connection++ == 0 ? first : second,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final staleRead = store.loadSessionContext(_sessionId);
    await _waitFor(() => first.contextGetCalls == 1);
    await store.connectHost(_host);
    final current = await store.setSessionCompactionThreshold(_sessionId, 64000,
        compactNow: false);
    first.contextGetGate!.complete();

    expect(current.compactionThresholdTokens, 64000);
    await expectLater(staleRead, throwsA(isA<StateError>()));
    expect(
        store.contextBySession[_sessionId]?.compactionThresholdTokens, 64000);
  });

  test('context response must identify the requested task', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..contextResponseSessionId = 'host/fake/wrong-task';
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await expectLater(
        store.loadSessionContext(_sessionId), throwsA(isA<FormatException>()));
    expect(store.contextBySession, isEmpty);
  });

  test('context handoff and branch carry prompts into selected new tasks',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final handoff = await store.contextHandoff(
      _sessionId,
      prompt: '  Focus on the failing mobile test.  ',
    );
    expect(transport.lastHandoffPayload, <String, Object?>{
      'sessionId': _sessionId,
      'prompt': 'Focus on the failing mobile test.',
    });
    expect(handoff.session.relationship?.kind, 'handoff');
    expect(store.handoffSummaries[handoff.session.id], handoff.summary);
    expect(
        store.drafts[handoff.session.id], 'Focus on the failing mobile test.');
    expect(store.selectedSession?.id, 'host/fake/handoff');

    final branch = await store.branchSession(
      _sessionId,
      prompt: '  Try the alternative implementation. ',
    );
    expect(transport.lastBranchPayload, <String, Object?>{
      'sessionId': _sessionId,
      'prompt': 'Try the alternative implementation.',
    });
    expect(branch.strategy, 'transcript_bootstrap');
    expect(branch.copiedMessageCount, 7);
    expect(store.drafts[branch.session.id], 'Try the alternative implementation.');
    expect(store.selectedSession?.id, 'host/fake/branch');
  });

  test('refreshed handoff sessions restore their visible summary', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..extraSessions = <Object?>[
        <String, Object?>{
          ..._sessionJson('idle', DateTime.utc(2026, 8, 14, 13)),
          'id': 'host/fake/restored-handoff',
          'providerSessionId': 'restored-handoff',
          'title': 'Restored handoff',
          'contextHandoffSummary': 'Restored from the refreshed session.',
          'relationship': <String, Object?>{
            'kind': 'handoff',
            'sourceSessionId': _sessionId,
            'strategy': 'summary_bootstrap',
          },
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);

    expect(store.handoffSummaries['host/fake/restored-handoff'],
        'Restored from the refreshed session.');
  });

  test('wallet requests cache status and send custom endpoint inputs',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final initial = await store.loadWallet('direct', modelId: 'openai::gpt');
    expect(initial?.requiresApiKey, isTrue);
    expect(transport.lastWalletGetPayload, <String, Object?>{
      'providerId': 'direct',
      'modelId': 'openai::gpt',
    });
    final xai = await store.loadWallet(
      'direct',
      endpointId: 'xai',
      force: true,
    );
    expect(transport.lastWalletGetPayload, <String, Object?>{
      'providerId': 'direct',
      'endpointId': 'xai',
    });
    expect(xai?.endpointId, 'xai');
    expect(store.walletStatusFor('direct', 'xai::grok')?.endpointId, 'xai');
    store.modelsByProvider['direct'] = <RemoteModel>[
      const RemoteModel(
        id: 'openai::gpt',
        providerId: 'direct',
        displayName: 'GPT',
        isDefault: true,
        nativeMetadata: <String, Object?>{},
      ),
    ];

    final configured = await store.configureWallet(
      providerId: 'direct',
      endpointId: 'custom-one',
      modelId: 'custom-one::model-a',
      apiKey: ['test-key', 'not-real'].join('-'),
      setBalance: 12.5,
      customEndpoint: <String, Object?>{
        'id': 'custom-one',
        'name': 'Custom One',
        'baseUrl': 'https://example.test/v1',
        'protocol': 'responses',
        'modelIds': <String>['model-a'],
      },
    );
    expect(configured.apiKeyConfigured, isTrue);
    expect(transport.modelCalls, 1);
    expect(transport.lastWalletConfigurePayload?['endpointId'], 'custom-one');
    expect(transport.lastWalletConfigurePayload?['setBalance'], 12.5);
    expect(
      (transport.lastWalletConfigurePayload?['customEndpoint']
          as Map<String, Object?>)['protocol'],
      'responses',
    );
    expect(
      store.walletStatusFor('direct', 'custom-one::model-a')?.balance,
      12.5,
    );
    expect(store.walletStatusFor('direct', 'openai::another-model')?.endpointId,
        'openai');
    expect(store.modelsByProvider['direct']?.last.id, 'custom-one::model-a');

    await store.configureWallet(
      providerId: 'direct',
      endpointId: 'custom-one',
      modelId: 'custom-one::model-a',
      clearBalance: true,
    );
    expect(transport.lastWalletConfigurePayload?['clearBalance'], isTrue);
    expect(transport.lastWalletConfigurePayload?.containsKey('setBalance'),
        isFalse);
  });

  test('API-key model refresh failures stay owned by the EYES flow', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..modelFailuresRemaining = 1;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.error = null;

    final wallet = await store.configureWallet(
      providerId: 'direct',
      endpointId: 'google',
      apiKey: ['test-key', 'not-real'].join('-'),
      validateApiKey: true,
    );

    expect(wallet.apiKeyConfigured, isTrue);
    expect(transport.modelCalls, 1);
    expect(store.error, isNull);
    expect(store.modelsByProvider, isNot(contains('direct')));
  });

  test('legacy picker recents are ignored', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{
      'uar.recent_models.v1': jsonEncode(<String>[
        'fake\u0000clicked-but-never-used',
      ]),
    });
    final store = RemoteAppStore();
    addTearDown(store.dispose);

    await store.initialize();

    expect(store.recentModelKeys, isEmpty);
  });

  test('recent models merge concrete session activity and persist accepted use',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveRecentModelUses(<RecentModelUse>[
      RecentModelUse(
        key: 'fake\u0000model-a',
        usedAt: DateTime.utc(2026, 8, 28, 10),
      ),
    ]);
    final transport = _FakeTransport(security: security)
      ..modelSnapshot = <Object?>[
        for (final id in <String>[
          'model-a',
          'model-b',
          'model-c',
          'model-d',
          'model-e',
        ])
          <String, Object?>{
            'id': id,
            'providerId': 'fake',
            'displayName': 'Model ${id.substring(id.length - 1).toUpperCase()}',
            'isDefault': id == 'model-a',
            'nativeMetadata': const <String, Object?>{},
          },
      ]
      ..refreshResponseSessions = <Object?>[
        <String, Object?>{
          ..._sessionJson('idle', DateTime.utc(2026, 8, 28, 11)),
          'modelId': 'model-b',
        },
        <String, Object?>{
          ..._providerSessionJson('fake', 'older-model-c'),
          'modelId': 'Model C',
          'lastActivityAt': '2026-08-28T09:00:00.000Z',
        },
        <String, Object?>{
          ..._providerSessionJson('fake', 'internal-model'),
          'modelId': 'model-d',
          'sessionKind': 'internal',
          'lastActivityAt': '2026-08-28T15:00:00.000Z',
        },
        <String, Object?>{
          ..._providerSessionJson('fake', 'ambiguous-model'),
          'modelId': 'default',
          'lastActivityAt': '2026-08-28T16:00:00.000Z',
        },
        <String, Object?>{
          ..._providerSessionJson('fake', 'unavailable-model'),
          'modelId': 'not-advertised',
          'lastActivityAt': '2026-08-28T17:00:00.000Z',
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.initialize();
    await store.connectHost(_host);
    await store.loadModels('fake');

    expect(store.modelsByProvider['fake']?.map((model) => model.id),
        containsAll(<String>['model-a', 'model-b', 'model-c']));
    expect(store.sessions.map((session) => session.modelId),
        containsAll(<String>['model-b', 'Model C']));
    expect(store.recentModelKeys, <String>[
      'fake\u0000model-b',
      'fake\u0000model-a',
      'fake\u0000model-c',
    ]);

    store.sessions.add(RemoteSession(
      id: 'host/fake/arrived-after-catalogue',
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'arrived-after-catalogue',
      title: 'Arrived after catalogue',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 28, 10, 30),
      needsApproval: false,
      stale: false,
      modelId: 'model-e',
    ));
    await store.loadModels('fake');
    expect(store.recentModelKeys, <String>[
      'fake\u0000model-b',
      'fake\u0000model-e',
      'fake\u0000model-a',
      'fake\u0000model-c',
    ]);

    await store.sendMessage(
      _sessionId,
      'Use the newly selected model',
      modelId: 'model-d',
    );
    expect(store.recentModelKeys.first, 'fake\u0000model-d');
    expect(store.recentModelKeys, contains('fake\u0000model-b'));
    expect(store.recentModelKeys, contains('fake\u0000model-a'));

    final beforeFailedSend = List<String>.of(store.recentModelKeys);
    transport.failSend = true;
    await expectLater(
      store.sendMessage(_sessionId, 'This send fails', modelId: 'model-e'),
      throwsA(isA<StateError>()),
    );
    expect(store.recentModelKeys, beforeFailedSend);

    await Future<void>.delayed(const Duration(milliseconds: 20));
    final persisted = await security.readRecentModelUses();
    expect(persisted.map((use) => use.key), store.recentModelKeys);

    final reopened = RemoteAppStore(security: security);
    addTearDown(reopened.dispose);
    await reopened.initialize();
    expect(reopened.recentModelKeys, store.recentModelKeys);
  });

  test('reconnect replays and reconciles every pending snapshot once',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await Future<void>.delayed(Duration.zero);

    transport
      ..queueSnapshot = <Object?>[_queuedJson('after-reconnect')]
      ..delegationSnapshot = <Object?>[_delegationJson('after-reconnect')]
      ..approvalSnapshot = <Object?>[_approvalJson('after-reconnect')]
      ..userInputSnapshot = <Object?>[_userInputJson('after-reconnect')];
    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    transport.setStateForTesting(BridgeConnectionState.online);

    await _waitFor(() =>
        transport.syncCalls == 1 &&
        store.queuedMessages.containsKey('after-reconnect') &&
        store.delegations.containsKey('after-reconnect') &&
        store.approvals.containsKey('after-reconnect') &&
        store.userInputs.containsKey('after-reconnect'));
    expect(transport.refreshCalls, 2);
    expect(transport.lastSyncWasSigned, isTrue);
  });

  test(
      'foreground resume shares callers and runs a trailing recovery before model metadata',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..resumeGate = Completer<void>()
      ..modelGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.selectedSession = store.sessions.single;
    store.setVisibleSession(_sessionId);
    final refreshBefore = transport.refreshCalls;
    final openBefore = transport.openCalls;
    final queueBefore = transport.queueListCalls;
    final approvalsBefore = transport.approvalListCalls;
    final inputBefore = transport.userInputListCalls;

    final first = store.resumeFromBackground();
    final second = store.resumeFromBackground();
    expect(identical(first, second), isTrue);
    await _waitFor(() => transport.resumeCalls == 1);
    transport.resumeGate!.complete();
    await Future.wait(<Future<void>>[first, second]);

    expect(transport.resumeCalls, 2,
        reason: 'the second resume must not be lost behind the first probe');
    expect(transport.resumeProbeTimeout, const Duration(milliseconds: 800));
    expect(transport.syncCalls, 2);
    expect(transport.refreshCalls, refreshBefore + 2);
    expect(transport.openCalls, openBefore + 2);
    expect(transport.queueListCalls, queueBefore + 2);
    expect(transport.approvalListCalls, approvalsBefore + 2);
    expect(transport.userInputListCalls, inputBefore + 2);
    expect(transport.modelGate!.isCompleted, isFalse);

    transport.modelGate!.complete();
  });

  test('delayed attention lists cannot undo newer live resolution or request',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..approvalSnapshot = <Object?>[_approvalJson('stale-approval')]
      ..userInputSnapshot = <Object?>[]
      ..approvalListGate = Completer<void>()
      ..userInputListGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    final connecting = store.connectHost(_host);
    await _waitFor(() =>
        transport.approvalListCalls == 1 && transport.userInputListCalls == 1);
    store.selectedSession = store.sessions.single;
    store.applyEventForTesting(_eventWithPayload(
      'approval.resolved',
      1,
      const <String, Object?>{'requestId': 'stale-approval'},
    ));
    store.applyEventForTesting(_eventWithPayload(
      'user_input.requested',
      2,
      <String, Object?>{'userInput': _userInputJson('live-input')},
    ));
    transport.approvalListGate!.complete();
    transport.userInputListGate!.complete();
    await connecting;

    expect(store.approvals, isNot(contains('stale-approval')));
    expect(store.userInputs, contains('live-input'));
    expect(store.sessions.single.state, 'needs_input');
    expect(store.selectedSession?.state, 'needs_input');
  });

  test('delayed queue and side-chat lists cannot resurrect newer live state',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..queueSnapshot = <Object?>[_queuedJson('stale-queued')]
      ..sideChatSnapshot = <Object?>[_sideChatJson('promoted-side-chat')]
      ..queueListGate = Completer<void>()
      ..sideChatListGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    final connecting = store.connectHost(_host);
    await _waitFor(() =>
        transport.queueListCalls == 1 && transport.sideChatListCalls == 1);
    store.applyEventForTesting(_eventWithPayload(
      'message.queue_removed',
      1,
      const <String, Object?>{'messageId': 'stale-queued'},
    ));
    store.applyEventForTesting(_eventWithPayload(
      'side_chat.promoted',
      2,
      <String, Object?>{
        'session': <String, Object?>{
          ..._sideChatJson('promoted-side-chat'),
          'sessionKind': 'task',
        },
      },
    ));
    transport.queueListGate!.complete();
    transport.sideChatListGate!.complete();
    await connecting;

    expect(transport.queueListCalls, 1);
    expect(transport.sideChatListCalls, 1);
    expect(store.queuedMessages, isNot(contains('stale-queued')));
    expect(
      store.sessions
          .singleWhere((session) => session.id == 'promoted-side-chat')
          .sessionKind,
      'task',
    );
  });

  test('a stale delegation list cannot erase an optimistic Mesh turn',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final listCallsBefore = transport.delegationListCalls;
    final listCompletionsBefore = transport.delegationListCompletedCalls;
    transport.delegationListGate = Completer<void>();

    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    transport.setStateForTesting(BridgeConnectionState.online);
    await _waitFor(() => transport.delegationListCalls == listCallsBefore + 1);

    final task = await store.startDelegation(
      _sessionId,
      '\uFFFCKeep this optimistic Mesh turn',
      const <DelegationSelection>[
        DelegationSelection(providerId: 'fake'),
      ],
    );
    expect(task, isNotNull);
    expect(store.delegations, contains(task!.id));

    transport.delegationListGate!.complete();
    await _waitFor(() =>
        transport.delegationListCompletedCalls == listCompletionsBefore + 1);
    expect(store.delegations, contains(task.id));
    expect(
        store.delegations[task.id]?.prompt, 'Keep this optimistic Mesh turn');
  });

  test(
      'target-only Mesh uses prepare and retains its draft until acknowledgement',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final gate = Completer<void>();
    final transport = _FakeTransport(security: security)
      ..delegationStartGate = gate;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const targets = <DelegationSelection>[
      DelegationSelection(providerId: 'fake'),
    ];
    store.setDraft(_sessionId, '\uFFFC');
    store.setDraftDelegationSelections(_sessionId, targets);

    final pending = store.startDelegation(_sessionId, '\uFFFC', targets);
    await _waitFor(() => transport.lastDelegationPayload != null);

    expect(transport.delegationPrepareCalls, 1);
    expect(transport.delegationLegacyStartCalls, 0);
    expect(transport.lastDelegationPayload?['prompt'], '');
    expect(
      transport.lastDelegationPayload?['presentationSegments'],
      <Object?>[
        <String, Object?>{'type': 'mesh', 'targetIndex': 0},
      ],
    );
    expect(store.drafts[_sessionId], '\uFFFC');
    expect(store.draftDelegationSelectionsFor(_sessionId), hasLength(1));
    expect(
      store.draftDelegationSelectionsFor(_sessionId).single.providerId,
      'fake',
    );

    gate.complete();
    final task = await pending;

    expect(task, isNotNull);
    expect(task!.prompt, '');
    expect(task.presentationSegments, hasLength(1));
    expect(task.presentationSegments.single.type, 'mesh');
    expect(task.targets, hasLength(1));
    expect(task.targets.single.providerId, 'fake');
    expect(store.drafts[_sessionId], isEmpty);
    expect(store.draftDelegationSelectionsFor(_sessionId), isEmpty);
    expect(store.delegations[task.id]?.prompt, '');
  });

  test('target-only Mesh survives delegation list and event parsing', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..delegationSnapshot = <Object?>[
        <String, Object?>{
          ..._delegationJson('listed-target-only'),
          'prompt': '',
          'orchestration': 'parent',
          'targets': const <Object?>[
            <String, Object?>{'providerId': 'fake'},
          ],
          'presentationSegments': const <Object?>[
            <String, Object?>{'type': 'mesh', 'targetIndex': 0},
          ],
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);

    expect(store.delegations['listed-target-only']?.prompt, '');
    store.applyEventForTesting(_eventWithPayload(
      'delegation.updated',
      1,
      <String, Object?>{
        ..._delegationJson('event-target-only'),
        'prompt': '',
        'orchestration': 'parent',
        'targets': const <Object?>[
          <String, Object?>{'providerId': 'fake'},
        ],
        'presentationSegments': const <Object?>[
          <String, Object?>{'type': 'mesh', 'targetIndex': 0},
        ],
      },
    ));
    expect(store.delegations['event-target-only']?.prompt, '');
    expect(
      store.delegations['event-target-only']?.presentationSegments.single.type,
      'mesh',
    );
  });

  test('Mesh child loading starts only after a real child session exists',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final childCallsBefore = transport.childCalls;
    final awaiting = <String, Object?>{
      ..._delegationJson('mesh-child-lifecycle'),
      'prompt': 'Delegate once the parent is ready',
      'state': 'awaiting_dispatch',
      'orchestration': 'parent',
      'targets': const <Object?>[
        <String, Object?>{'providerId': 'fake'},
      ],
      'presentationSegments': const <Object?>[
        <String, Object?>{'type': 'mesh', 'targetIndex': 0},
        <String, Object?>{
          'type': 'text',
          'text': 'Delegate once the parent is ready',
        },
      ],
      'children': const <Object?>[],
    };

    store.applyEventForTesting(
        _eventWithPayload('delegation.updated', 1, awaiting));
    await Future<void>.delayed(Duration.zero);
    expect(
      store.sessions
          .singleWhere((session) => session.id == _sessionId)
          .parentSessionId,
      isNull,
    );
    expect(transport.childCalls, childCallsBefore);

    transport.childSessions = <Object?>[
      <String, Object?>{
        ..._sessionJson('working', DateTime.utc(2026, 8, 10, 11, 2)),
        'id': 'host/fake/mesh-child',
        'providerSessionId': 'mesh-child',
        'title': 'Mesh child',
        'parentSessionId': _sessionId,
      },
    ];
    store.applyEventForTesting(_eventWithPayload(
      'delegation.updated',
      2,
      <String, Object?>{
        ...awaiting,
        'state': 'running',
        'children': const <Object?>[
          <String, Object?>{
            'id': 'mesh-child',
            'providerId': 'fake',
            'state': 'running',
            'sessionId': 'host/fake/mesh-child',
          },
        ],
      },
    ));

    await _waitFor(() => transport.childCalls == childCallsBefore + 1);
    expect(transport.lastChildSessionParentId, _sessionId);
  });

  test('Mesh rejects an unavailable pre-dispatch target before transport',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await expectLater(
      store.startDelegation(
        _sessionId,
        '\uFFFCDo not dispatch this',
        const <DelegationSelection>[
          DelegationSelection(providerId: '   '),
        ],
      ),
      throwsA(isA<StateError>()),
    );
    expect(transport.delegationStartCalls, 0);
    expect(store.delegations, isEmpty);
  });

  test('resolved input event removes its card and settles the selected task',
      () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    final session = RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Input session',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    );
    store.sessions.add(session);
    store.selectedSession = session;

    store.applyEventForTesting(_eventWithPayload(
      'user_input.requested',
      1,
      <String, Object?>{'userInput': _userInputJson('input-one')},
    ));
    expect(store.userInputs, contains('input-one'));
    expect(store.selectedSession?.state, 'needs_input');

    store.applyEventForTesting(_eventWithPayload(
      'user_input.resolved',
      2,
      const <String, Object?>{
        'requestId': 'input-one',
        'reason': 'answered',
      },
    ));
    expect(store.userInputs, isNot(contains('input-one')));
    expect(store.sessions.single.state, 'working');
    expect(store.selectedSession?.state, 'working');
  });

  test('reconnect storms coalesce without overlapping recoveries', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await Future<void>.delayed(Duration.zero);

    transport.syncGate = Completer<void>();
    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    transport.setStateForTesting(BridgeConnectionState.online);
    await _waitFor(() => transport.syncCalls == 1);
    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    transport.setStateForTesting(BridgeConnectionState.online);
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(transport.syncCalls, 1);

    transport.syncGate!.complete();
    await _waitFor(() => transport.syncCalls == 2);
    expect(transport.maxConcurrentSyncs, 1);
    expect(transport.refreshCalls, 3);
  });

  test('a live replay-gap envelope triggers authoritative recovery', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    transport.reportReplayGapForTesting();
    await _waitFor(() => transport.syncCalls == 1);
    expect(transport.refreshCalls, 2);
  });

  test('host switch ignores an old in-flight reconnect recovery', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final first = _FakeTransport(security: security);
    final second = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _host.hostId ? first : second,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await Future<void>.delayed(Duration.zero);

    first
      ..syncGate = Completer<void>()
      ..queueSnapshot = <Object?>[_queuedJson('stale-host')];
    first.setStateForTesting(BridgeConnectionState.reconnecting);
    first.setStateForTesting(BridgeConnectionState.online);
    await _waitFor(() => first.syncCalls == 1);

    await store.connectHost(_otherHost);
    first.syncGate!.complete();
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(store.activeHost?.hostId, _otherHost.hostId);
    expect(store.queuedMessages.containsKey('stale-host'), isFalse);
    expect(first.refreshCalls, 1);
  });

  test('a replay gap reloads the selected session history', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[_messageJson('before reconnect')];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.openSession(store.sessions.single);
    await Future<void>.delayed(Duration.zero);

    transport
      ..syncReplayGap = true
      ..openMessages = <Object?>[_messageJson('after reconnect')];
    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    transport.setStateForTesting(BridgeConnectionState.online);

    await _waitFor(() => transport.openCalls == 2);
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'after reconnect');
  });

  test('message history loads recent pages first and prepends older pages',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        _messageJson(
          'recent one',
          id: 'recent-1',
          createdAt: '2026-08-10T12:00:00.000Z',
        ),
        _messageJson(
          'recent two',
          id: 'recent-2',
          createdAt: '2026-08-10T12:01:00.000Z',
        ),
      ]
      ..openNextCursor = '40';
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.openSession(store.sessions.single);
    expect(store.messages[_sessionId]!.map((message) => message.id),
        <String>['recent-1', 'recent-2']);
    expect(store.hasOlderHistory(_sessionId), isTrue);

    transport
      ..openMessages = <Object?>[
        _messageJson(
          'older one',
          id: 'older-1',
          createdAt: '2026-08-10T11:00:00.000Z',
        ),
        _messageJson(
          'older two',
          id: 'older-2',
          createdAt: '2026-08-10T11:01:00.000Z',
        ),
      ]
      ..openNextCursor = null;
    expect(await store.loadOlderSessionHistory(_sessionId), isTrue);
    expect(store.messages[_sessionId]!.map((message) => message.id),
        <String>['older-1', 'older-2', 'recent-1', 'recent-2']);
    expect(transport.openCursors, <String?>[null, '40']);
    expect(store.hasOlderHistory(_sessionId), isFalse);
  });

  test(
      'history paints text before bounded image hydration and reuses the image',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final imageBytes = <int>[1, 2, 3, 4, 5, 6, 7];
    final transport = _FakeTransport(security: security)
      ..retrievalImageBytes = imageBytes
      ..imageGetGate = Completer<void>()
      ..openMessages = <Object?>[
        <String, Object?>{
          'id': 'image-message',
          'sessionId': _sessionId,
          'providerMessageId': 'native-image',
          'role': 'assistant',
          'createdAt': '2026-08-10T12:00:00.000Z',
          'parts': <Object?>[
            <String, Object?>{
              'type': 'text',
              'text': 'The image is available below.',
            },
            <String, Object?>{
              'type': 'image',
              'retrievalId': 'retrieval-one',
              'mimeType': 'image/png',
              'name': 'history.png',
            },
          ],
          'status': 'completed',
          'nativeMetadata': <String, Object?>{},
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.openSession(store.sessions.single);

    expect(store.messages[_sessionId]!.single.parts.first.summary,
        'The image is available below.');
    expect(store.messages[_sessionId]!.single.parts.last.attachmentUri, isNull);
    expect(transport.imageGetOffsets, <int>[0]);
    final placeholder = store.messages[_sessionId]!.single;
    store.messages[_sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: placeholder.id,
        sessionId: placeholder.sessionId,
        role: placeholder.role,
        createdAt: placeholder.createdAt,
        parts: placeholder.parts,
        status: placeholder.status,
        presentationId: 'local-image-presentation',
        editable: placeholder.editable,
        providerMessageId: placeholder.providerMessageId,
        origin: placeholder.origin,
      ),
    ];

    transport.imageGetGate!.complete();
    await _waitFor(() =>
        store.messages[_sessionId]!.single.parts.last.attachmentUri != null);
    final hydratedHistory = store.messages[_sessionId]!;
    final hydratedMessage = hydratedHistory.single;
    final image = hydratedMessage.parts.last;
    expect(image.attachmentUri,
        'data:image/png;base64,${base64Encode(imageBytes)}');
    expect(hydratedMessage.presentationId, 'local-image-presentation');
    expect(transport.imageGetOffsets, <int>[0, 3, 6]);

    await store.loadSessionHistoryFor(store.sessions.single);

    expect(identical(store.messages[_sessionId], hydratedHistory), isTrue);
    expect(
        identical(store.messages[_sessionId]!.single, hydratedMessage), isTrue);
    expect(store.messages[_sessionId]!.single.parts.last.attachmentUri,
        image.attachmentUri);
    expect(store.messages[_sessionId]!.single.presentationId,
        'local-image-presentation');
    expect(transport.imageGetOffsets, <int>[0, 3, 6]);
  });

  test('expired older-history cursor safely reopens the latest page', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[_messageJson('recent', id: 'recent')]
      ..openNextCursor = '40';
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.openSession(store.sessions.single);

    transport
      ..expireNextHistoryCursor = true
      ..openMessages = <Object?>[_messageJson('refreshed', id: 'refreshed')]
      ..openNextCursor = null;
    expect(await store.loadOlderSessionHistory(_sessionId), isTrue);
    expect(transport.openCursors, <String?>[null, '40', null]);
    expect(
        store.messages[_sessionId]!.single.parts.single.summary, 'refreshed');
  });

  test('session status event updates the matching session immediately', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: 'host/fake/session-one',
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Live session',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    ));

    final occurredAt = DateTime.utc(2026, 8, 10, 11);
    store.applyEventForTesting(AgentEvent(
      eventId: 'fake:event-one',
      sequence: 1,
      type: 'session.status_changed',
      occurredAt: occurredAt,
      payload: const <String, Object?>{'state': 'working'},
      sessionId: 'host/fake/session-one',
      providerId: 'fake',
    ));

    expect(store.sessions.single.state, 'working');
    expect(store.sessions.single.lastActivityAt, occurredAt);

    store.applyEventForTesting(AgentEvent(
      eventId: 'fake:event-two',
      sequence: 2,
      type: 'session.status_changed',
      occurredAt: occurredAt.add(const Duration(minutes: 1)),
      payload: const <String, Object?>{'state': 'busy'},
      sessionId: 'host/fake/session-one',
      providerId: 'fake',
    ));

    expect(store.sessions.single.state, 'working');
  });

  test('automatic compaction completion becomes one quiet system record', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.messages[_sessionId] = <RemoteMessage>[];

    final event = AgentEvent(
      eventId: 'compact-complete',
      sequence: 3,
      type: 'context.compaction_completed',
      occurredAt: DateTime.utc(2026, 8, 10, 11),
      payload: const <String, Object?>{'kind': 'automatic'},
      sessionId: _sessionId,
      providerId: 'fake',
    );
    store.applyEventForTesting(event);
    store.applyEventForTesting(event);

    final records = store.messages[_sessionId]!;
    expect(records, hasLength(1));
    expect(records.single.role, 'system');
    expect(records.single.parts.single.summary, 'Session compacted');
  });

  test('failed compaction clears progress without claiming success', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.contextBySession[_sessionId] = SessionContextState.fromJson({
      'sessionId': _sessionId, 'isCompacting': true,
      'compactionKind': 'automatic', 'usedTokens': 100000,
    });
    store.applyEventForTesting(AgentEvent(
      eventId: 'compact-failed', sequence: 4,
      type: 'context.compaction_failed',
      occurredAt: DateTime.utc(2026, 9, 6),
      payload: const <String, Object?>{'kind': 'automatic'},
      sessionId: _sessionId, providerId: 'fake',
    ));
    expect(store.contextBySession[_sessionId]!.isCompacting, false);
    expect(store.contextBySession[_sessionId]!.usedTokens, 100000);
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Compaction could not be completed. You can try again.');
  });

  test('session metadata events update live truth without dropping relations',
      () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Child session',
      state: 'working',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
      externalWriter: true,
      modelId: 'model-before',
      reasoningEffort: 'high',
      variantId: 'variant-before',
      parentSessionId: 'host/fake/parent',
      agentNickname: 'Reviewer',
      agentRole: 'reviewer',
    ));

    store.applyEventForTesting(
        _eventWithPayload('session.updated', 1, const <String, Object?>{
      'state': 'idle',
      'modelId': 'gpt-5.6-sol',
      'reasoningEffort': 'ultra',
    }));

    final updated = store.sessions.single;
    expect(updated.state, 'idle');
    expect(updated.modelId, 'gpt-5.6-sol');
    expect(updated.reasoningEffort, 'ultra');
    expect(updated.externalWriter, isTrue);
    expect(updated.variantId, 'variant-before');
    expect(updated.parentSessionId, 'host/fake/parent');
    expect(updated.agentNickname, 'Reviewer');
    expect(updated.agentRole, 'reviewer');
    expect(store.events[_sessionId], isNull);

    store.applyEventForTesting(
        _eventWithPayload('session.updated', 2, const <String, Object?>{
      'state': 'busy',
      'externalWriter': false,
    }));
    expect(store.sessions.single.state, 'idle');
    expect(store.sessions.single.externalWriter, isFalse);
    expect(store.events[_sessionId], isNull);
  });

  test('approval expiry is parsed and cannot leave a session stuck', () async {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Approval session',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    ));
    final expiresAt =
        DateTime.now().toUtc().add(const Duration(milliseconds: 60));
    final approvalJson = <String, Object?>{
      ..._approvalJson('expiring-approval'),
      'expiresAt': expiresAt.toIso8601String(),
    };
    final parsed = ApprovalRequest.fromJson(approvalJson);
    expect(parsed.expiresAt, expiresAt);
    expect(parsed.isExpired(), isFalse);

    store.applyEventForTesting(_eventWithPayload(
      'approval.requested',
      1,
      <String, Object?>{'approval': approvalJson},
    ));
    expect(store.approvals, contains('expiring-approval'));
    expect(store.sessions.single.state, 'needs_approval');
    expect(store.events[_sessionId], isNull);

    await _waitFor(() => !store.approvals.containsKey('expiring-approval'));
    expect(store.sessions.single.state, 'idle');
    expect(store.sessions.single.needsApproval, isFalse);

    final expired = ApprovalRequest.fromJson(<String, Object?>{
      ..._approvalJson('already-expired'),
      'expiresAt': DateTime.now()
          .toUtc()
          .subtract(const Duration(seconds: 1))
          .toIso8601String(),
    });
    await store.respondToApproval(expired, 'allow');
    expect(store.approvals, isNot(contains('already-expired')));
  });

  test('child sessions merge by id and stay out of root session lists',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..childSessions = <Object?>[
        <String, Object?>{
          'id': 'host/fake/child-one',
          'hostId': 'host',
          'providerId': 'fake',
          'providerSessionId': 'child-one',
          'title': 'Review the UI',
          'state': 'working',
          'lastActivityAt': '2026-08-10T11:00:00.000Z',
          'needsApproval': false,
          'stale': false,
          'parentSessionId': _sessionId,
          'agentNickname': 'UI reviewer',
          'agentRole': 'reviewer',
          'relationship': <String, Object?>{
            'kind': 'subagent',
            'sourceSessionId': _sessionId,
            'strategy': 'native',
          },
        }
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final children = await store.loadChildSessions(_sessionId);

    expect(transport.childCalls, 1);
    expect(children.single.agentNickname, 'UI reviewer');
    expect(store.sessions, hasLength(2));
    expect(store.visibleSessions.map((session) => session.id),
        <String>[_sessionId]);

    await store.refresh();
    expect(store.childSessionsFor(_sessionId), hasLength(1));

    store.sessions.add(RemoteSession(
      id: 'host/fake/other-child',
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'other-child',
      title: 'Unrelated child',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 12),
      needsApproval: false,
      stale: false,
      parentSessionId: 'host/fake/other-parent',
    ));
    transport.childSessions = <Object?>[];

    expect(await store.loadChildSessions(_sessionId), isEmpty);
    expect(store.sessions.map((session) => session.id),
        contains('host/fake/other-child'));
    expect(store.sessions.map((session) => session.id),
        isNot(contains('host/fake/child-one')));
  });

  test('live message events project distinct user and assistant messages', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Live session',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    ));

    store.applyEventForTesting(_eventWithPayload(
        'message.started', 1, const <String, Object?>{
      'messageId': 'user-live',
      'role': 'user',
      'text': 'Live user message'
    }));
    store.applyEventForTesting(_eventWithPayload(
        'message.started', 2, const <String, Object?>{
      'messageId': 'assistant-live',
      'role': 'assistant'
    }));
    store.applyEventForTesting(
        _eventWithPayload('message.delta', 3, const <String, Object?>{
      'messageId': 'assistant-live',
      'role': 'assistant',
      'text': 'Live assistant message'
    }));
    store.applyEventForTesting(
        _eventWithPayload('message.completed', 4, const <String, Object?>{
      'messageId': 'assistant-live',
      'role': 'assistant',
      'text': 'Live assistant message'
    }));

    expect(store.messages[_sessionId]!.map((message) => message.role),
        <String>['user', 'assistant']);
    expect(store.messages[_sessionId]!.last.parts.single.summary,
        'Live assistant message');
    expect(store.liveAssistantMessageFor(_sessionId), isNull);
  });

  test('presenting an image does not consume or finish the live assistant', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Image task',
      state: 'working',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    ));
    store.applyEventForTesting(_eventWithPayload(
        'message.delta', 1, const <String, Object?>{'text': 'Still explaining'}));
    store.applyEventForTesting(_eventWithPayload(
        'message.completed', 2, const <String, Object?>{
      'messageId': 'presented_image_test',
      'role': 'assistant',
      'text': 'An image caption',
      'tethoqPresentedImage': true,
      'requiresHistoryRefresh': true,
    }));
    expect(store.sessions.single.state, 'working');
    expect(store.liveAssistantMessageFor(_sessionId)!.parts.single.summary,
        'Still explaining');
    expect(store.messages[_sessionId] ?? <RemoteMessage>[], isEmpty);
  });

  test('terminal completion settles the live assistant immediately', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Live session',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    ));

    store.applyEventForTesting(
        _eventWithPayload('message.started', 1, const <String, Object?>{}));
    store.applyEventForTesting(_eventWithPayload(
        'message.delta', 2, const <String, Object?>{'text': 'Final answer'}));
    store.applyEventForTesting(_event('agent.completed', 3));

    expect(store.liveAssistantMessageFor(_sessionId), isNull);
    expect(store.sessions.single.state, 'completed');
    expect(store.messages[_sessionId], hasLength(1));
    expect(store.messages[_sessionId]!.single.status, 'completed');
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Final answer');
  });

  test('failed and interrupted terminals remove partial live assistants', () {
    for (final terminal in const <(String, String)>[
      ('agent.error', 'failed'),
      ('agent.interrupted', 'idle'),
    ]) {
      final store = RemoteAppStore();
      store.sessions.add(RemoteSession(
        id: _sessionId,
        hostId: 'host',
        providerId: 'fake',
        providerSessionId: 'session-one',
        title: 'Live session',
        state: 'working',
        lastActivityAt: DateTime.utc(2026, 8, 10, 10),
        needsApproval: false,
        stale: false,
      ));
      try {
        store.applyEventForTesting(_eventWithPayload(
            'message.delta', 1, const <String, Object?>{'text': 'Partial'}));
        store.applyEventForTesting(_event(terminal.$1, 2));

        expect(store.liveAssistantMessageFor(_sessionId), isNull,
            reason: terminal.$1);
        expect(store.sessions.single.state, terminal.$2, reason: terminal.$1);
        expect(store.messages[_sessionId] ?? const <RemoteMessage>[], isEmpty,
            reason: terminal.$1);
      } finally {
        store.dispose();
      }
    }
  });

  test('paired phones load from the bridge and another phone can be revoked',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);
    expect(store.pairedDevices, hasLength(2));
    expect(store.pairedDevices.first.deviceId, _host.deviceId);

    await store.revokePairedDevice('other-credential');
    expect(transport.deviceRevoked, isTrue);
    expect(store.pairedDevices, hasLength(1));
  });

  test('structured subagent tool events merge into one live message', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Live session',
      state: 'working',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    ));
    const receiver = 'host/fake/child';

    store.applyEventForTesting(
        _eventWithPayload('tool.started', 1, const <String, Object?>{
      'parts': <Object?>[
        <String, Object?>{
          'type': 'subagent',
          'tool': 'spawn_agent',
          'action': 'spawn',
          'status': 'running',
          'receiverSessionIds': <Object?>[receiver],
          'summary': 'Reviewing the UI',
        }
      ]
    }));
    store.applyEventForTesting(
        _eventWithPayload('tool.completed', 2, const <String, Object?>{
      'parts': <Object?>[
        <String, Object?>{
          'type': 'subagent',
          'tool': 'spawn_agent',
          'action': 'spawn',
          'status': 'completed',
          'receiverSessionIds': <Object?>[receiver],
          'summary': 'UI review complete',
        }
      ]
    }));

    expect(store.messages[_sessionId], hasLength(1));
    expect(store.messages[_sessionId]!.single.parts.single.type, 'subagent');
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'UI review complete');
  });

  test('latest reasoning artifact prefers live commentary over stale preview',
      () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Live session',
      state: 'working',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
      preview: 'Stale preview',
    ));
    store.messages[_sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'old-reasoning',
        sessionId: _sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 10, 10),
        parts: const <ContentPart>[
          ContentPart(
              type: 'reasoning',
              data: <String, Object?>{'text': '**Older thought**'})
        ],
        status: 'completed',
      ),
    ];

    expect(store.latestReasoningArtifactFor(_sessionId), 'Older thought');

    store.applyEventForTesting(
        _eventWithPayload('message.delta', 1, const <String, Object?>{
      'phase': 'commentary',
      'partType': 'text',
      'text': 'Live commentary',
    }));
    store.applyEventForTesting(
        _eventWithPayload('message.delta', 2, const <String, Object?>{
      'phase': 'final_answer',
      'partType': 'text',
      'text': 'Final answer text',
    }));

    expect(store.latestReasoningArtifactFor(_sessionId), 'Live commentary');
    expect(store.liveAssistantMessageFor(_sessionId)!.parts.first.type,
        'reasoning');
    expect(store.liveAssistantMessageFor(_sessionId)!.parts.last.type, 'text');
  });

  test('historical sessions baseline as read and new output becomes unread',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);
    expect(store.unreadSessionIds, isEmpty);

    store.applyEventForTesting(_event('agent.completed', 1));
    expect(store.isSessionUnread(_sessionId), isTrue);
    await store.flushUnreadPersistenceForTesting();

    final restoredTransport = _FakeTransport(security: security);
    final restored = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => restoredTransport,
    );
    addTearDown(restored.dispose);
    await restored.connectHost(_host);
    expect(restored.isSessionUnread(_sessionId), isTrue);
  });

  test('only a successful open clears unread and visible output stays read',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    store.applyEventForTesting(_event('agent.completed', 1));
    transport.failOpen = true;
    await expectLater(
        store.openSession(store.sessions.single), throwsStateError);
    expect(store.isSessionUnread(_sessionId), isTrue);

    transport.failOpen = false;
    await store.openSession(store.sessions.single);
    expect(store.isSessionUnread(_sessionId), isFalse);

    store.setVisibleSession(_sessionId);
    store.applyEventForTesting(_event('agent.completed', 2));
    expect(store.isSessionUnread(_sessionId), isFalse);
    store.setVisibleSession(null);
    store.applyEventForTesting(_event('agent.completed', 3));
    expect(store.isSessionUnread(_sessionId), isTrue);
  });

  test('visible session owners restore parent and ignore late parent disposal',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const childId = 'host/fake/child-visible';
    store.sessions.add(RemoteSession(
      id: childId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'child-visible',
      title: 'Child task',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 12),
      needsApproval: false,
      stale: false,
      parentSessionId: _sessionId,
    ));

    store.setVisibleSession(_sessionId);
    store.setVisibleSession(childId);
    store.clearVisibleSessionIf(childId);
    expect(store.visibleSessionIdForTesting, _sessionId);

    store.setVisibleSession(childId);
    store.clearVisibleSessionIf(_sessionId);
    expect(store.visibleSessionIdForTesting, childId);
    store.clearVisibleSessionIf(childId);
    expect(store.visibleSessionIdForTesting, isNull);
  });

  test('tool progress alone does not mark a session unread', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    store.applyEventForTesting(_event('tool.completed', 1));
    expect(store.unreadSessionIds, isEmpty);
  });

  test('completed message while a task is working does not become unread',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    store.applyEventForTesting(_event('message.started', 1));
    store.applyEventForTesting(_event('message.completed', 2));

    expect(store.sessions.single.state, 'working');
    expect(store.unreadSessionIds, isEmpty);
  });

  test('a Grok-style reasoning delta marks the session working', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    store.applyEventForTesting(
        _eventWithPayload('message.delta', 1, const <String, Object?>{
      'partType': 'reasoning',
      'content': <String, Object?>{
        'sessionUpdate': 'agent_thought_chunk',
        'content': <String, Object?>{
          'type': 'text',
          'text': 'Inspecting the parser',
        },
      },
    }));

    expect(store.sessions.single.state, 'working');
    expect(store.liveAssistantMessageFor(_sessionId)?.parts.single.type,
        'reasoning');
    expect(store.liveAssistantMessageFor(_sessionId)?.parts.single.summary,
        'Inspecting the parser');
  });

  test('native Grok queue events appear on the mobile queued-instruction strip',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    store.applyEventForTesting(
        _eventWithPayload('message.queued', 1, <String, Object?>{
      'id': 'provider_queue/grok/session-one/native-q1',
      'sessionId': _sessionId,
      'content': 'Queued from the Grok CLI',
      'state': 'queued',
      'createdAt': '2026-08-17T12:00:00.000Z',
      'attachments': <Object?>[],
    }));

    expect(store.queuedMessagesFor(_sessionId).single.content,
        'Queued from the Grok CLI');

    store.applyEventForTesting(
        _eventWithPayload('message.queue_removed', 2, const <String, Object?>{
      'messageId': 'provider_queue/grok/session-one/native-q1',
    }));
    expect(store.queuedMessagesFor(_sessionId), isEmpty);
  });

  test('newer idle refresh remains read without a final state', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final firstTransport = _FakeTransport(security: security);
    final first = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => firstTransport,
    );
    addTearDown(first.dispose);
    await first.connectHost(_host);
    await first.flushUnreadPersistenceForTesting();

    final refreshedTransport = _FakeTransport(security: security)
      ..sessionState = 'idle'
      ..sessionActivity = DateTime.utc(2026, 8, 10, 12);
    final refreshed = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => refreshedTransport,
    );
    addTearDown(refreshed.dispose);
    await refreshed.connectHost(_host);

    expect(refreshed.isSessionUnread(_sessionId), isFalse);
  });

  test('a working refresh clears a stale unread marker', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final firstTransport = _FakeTransport(security: security);
    final first = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => firstTransport,
    );
    addTearDown(first.dispose);
    await first.connectHost(_host);
    first.applyEventForTesting(_event('agent.completed', 1));
    await first.flushUnreadPersistenceForTesting();

    final workingTransport = _FakeTransport(security: security)
      ..sessionState = 'working'
      ..sessionActivity = DateTime.utc(2026, 8, 10, 12);
    final refreshed = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => workingTransport,
    );
    addTearDown(refreshed.dispose);
    await refreshed.connectHost(_host);

    expect(refreshed.isSessionUnread(_sessionId), isFalse);
  });

  test('interrupt settles a stuck working session when the harness has no turn',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sessionState = 'working'
      ..interruptError = const BridgeRequestException(
          'NO_ACTIVE_TURN', 'No active Codex turn is known for this thread',
          retryable: false);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    expect(store.sessions.single.state, 'working');
    await store.interrupt(_sessionId);

    expect(transport.interruptCalls, 1);
    expect(store.sessions.single.state, 'idle');
  });

  test('interrupt rethrows failures that are not a missing turn', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sessionState = 'working'
      ..interruptError = const BridgeRequestException(
          'BUSY', 'The harness is busy with another turn',
          retryable: false);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await expectLater(
        store.interrupt(_sessionId), throwsA(isA<BridgeRequestException>()));
    expect(transport.interruptCalls, 1);
    expect(store.sessions.single.state, 'working');
  });

  test('send appends one optimistic user message and removes it on failure',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.sendMessage(_sessionId, 'Show this immediately');

    expect(store.messages[_sessionId], hasLength(1));
    expect(store.messages[_sessionId]!.single.role, 'user');
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Show this immediately');

    transport.failSend = true;
    await expectLater(
        store.sendMessage(_sessionId, 'Do not leave a failed echo'),
        throwsStateError);
    expect(store.messages[_sessionId], hasLength(1));
  });

  test(
      'non-retryable delivery unknown keeps the optimistic send and consumes its draft',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sendError = const BridgeRequestException(
        'DELIVERY_UNKNOWN',
        'The provider acknowledgement was lost',
        retryable: false,
      );
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const attachment = RemoteAttachment(
      name: 'unknown.png',
      mimeType: 'image/png',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    store.setDraft(_sessionId, 'Keep this ambiguous send visible');
    store.setDraftAttachments(_sessionId, const <RemoteAttachment>[attachment]);

    await expectLater(
      store.sendMessage(
        _sessionId,
        'Keep this ambiguous send visible',
        attachments: const <RemoteAttachment>[attachment],
      ),
      throwsA(isA<BridgeRequestException>()
          .having((error) => error.code, 'code', 'DELIVERY_UNKNOWN')
          .having((error) => error.retryable, 'retryable', isFalse)),
    );

    expect(transport.sendCalls, 1);
    expect(store.messages[_sessionId], hasLength(1));
    expect(store.messages[_sessionId]!.single.parts.first.summary,
        'Keep this ambiguous send visible');
    expect(
        store.messages[_sessionId]!.single.parts.last.summary, 'unknown.png');
    expect(store.drafts[_sessionId] ?? '', isEmpty);
    expect(store.draftAttachmentsFor(_sessionId), isEmpty);
    expect(transport.cancelledUploadIds, isEmpty);
  });

  test(
      'no-cursor history refresh preserves an in-flight optimistic send until acknowledgement',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sendGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);

    final pending = store.sendMessage(_sessionId, 'Keep me during refresh');
    await _waitFor(() => transport.lastSendPayload != null);
    final optimisticId = store.messages[_sessionId]!.single.id;

    await store.refreshVisibleSessionHistory(_sessionId);

    expect(transport.openCursors, <String?>[null]);
    expect(store.messages[_sessionId], hasLength(1));
    expect(store.messages[_sessionId]!.single.id, optimisticId);
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Keep me during refresh');

    transport.sendGate!.complete();
    await pending;
    expect(store.messages[_sessionId]!.single.id, optimisticId);

    transport.openMessages = <Object?>[
      <String, Object?>{
        'id': 'canonical-user-message',
        'sessionId': _sessionId,
        'providerMessageId': optimisticId,
        'role': 'user',
        'createdAt': '2026-08-10T12:00:00.000Z',
        'parts': <Object?>[
          <String, Object?>{'type': 'text', 'text': 'Keep me during refresh'}
        ],
        'status': 'completed',
      },
    ];
    await store.refreshVisibleSessionHistory(_sessionId);

    expect(store.messages[_sessionId], hasLength(1));
    expect(store.messages[_sessionId]!.single.id, 'canonical-user-message');
    expect(store.messages[_sessionId]!.single.providerMessageId, optimisticId);
    expect(store.messages[_sessionId]!.single.presentationId, optimisticId);
  });

  test(
      'different-id canonical echo adopts the matching optimistic row, not an older repeat',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final olderCreatedAt = DateTime.now().subtract(const Duration(seconds: 30));
    Map<String, Object?> userMessage(
      String id,
      DateTime createdAt,
    ) =>
        <String, Object?>{
          'id': id,
          'sessionId': _sessionId,
          'role': 'user',
          'createdAt': createdAt.toUtc().toIso8601String(),
          'parts': <Object?>[
            <String, Object?>{'type': 'text', 'text': 'Repeat this prompt'}
          ],
          'status': 'completed',
        };
    final olderMessage = userMessage('older-repeat', olderCreatedAt);
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[olderMessage]
      ..sendGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);
    await store.refreshVisibleSessionHistory(_sessionId);

    final pending = store.sendMessage(_sessionId, 'Repeat this prompt');
    await _waitFor(() => transport.lastSendPayload != null);
    final optimistic = store.messages[_sessionId]!.last;
    expect(optimistic.presentationId, optimistic.id);

    await store.refreshVisibleSessionHistory(_sessionId);
    expect(store.messages[_sessionId]!.map((message) => message.id),
        <String>['older-repeat', optimistic.id]);

    transport.openMessages = <Object?>[
      olderMessage,
      userMessage(
        'canonical-new-repeat',
        optimistic.createdAt.add(const Duration(milliseconds: 200)),
      ),
    ];
    await store.refreshVisibleSessionHistory(_sessionId);

    expect(store.messages[_sessionId]!.map((message) => message.id),
        <String>['older-repeat', 'canonical-new-repeat']);
    final canonical = store.messages[_sessionId]!.last;
    expect(canonical.id, 'canonical-new-repeat');
    expect(canonical.providerMessageId, isNull);
    expect(canonical.presentationId, optimistic.presentationId);
    expect(
        store.messages[_sessionId]!.where(
            (message) => message.parts.single.summary == 'Repeat this prompt'),
        hasLength(2));

    transport.sendGate!.complete();
    await pending;
  });

  test('failed send removes an optimistic row retained by history refresh',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..failSend = true
      ..sendGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);

    final pending = store.sendMessage(_sessionId, 'Remove me after failure');
    final failure = expectLater(pending, throwsStateError);
    await _waitFor(() => transport.lastSendPayload != null);

    await store.refreshVisibleSessionHistory(_sessionId);
    expect(store.messages[_sessionId], hasLength(1));
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Remove me after failure');

    transport.sendGate!.complete();
    await failure;

    expect(store.messages[_sessionId] ?? const <RemoteMessage>[], isEmpty);
    await store.refreshVisibleSessionHistory(_sessionId);
    expect(store.messages[_sessionId] ?? const <RemoteMessage>[], isEmpty);
  });

  test('send acknowledgement cannot clear a newer mobile composition',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sendGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const firstAttachment = RemoteAttachment(
      name: 'first.png',
      mimeType: 'image/png',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    const newerAttachment = RemoteAttachment(
      name: 'newer.png',
      mimeType: 'image/png',
      dataBase64: 'Ag==',
      byteLength: 1,
    );
    final firstSettings = SimplifySettings(maxWords: 80);
    final newerSettings = SimplifySettings(maxWords: 160);
    store.setDraft(_sessionId, 'First composition');
    store.setDraftAttachments(
        _sessionId, const <RemoteAttachment>[firstAttachment]);
    store.setDraftSimplifySettings(_sessionId, firstSettings);

    final pending = store.sendMessage(
      _sessionId,
      'First composition',
      attachments: const <RemoteAttachment>[firstAttachment],
      simplify: firstSettings,
    );
    await _waitFor(() => transport.lastSendPayload != null);
    store.setDraft(_sessionId, 'Typed while sending');
    store.setDraftAttachments(
        _sessionId, const <RemoteAttachment>[newerAttachment]);
    store.setDraftSimplifySettings(_sessionId, newerSettings);
    transport.sendGate!.complete();
    await pending;

    expect(store.drafts[_sessionId], 'Typed while sending');
    expect(store.draftAttachmentsFor(_sessionId).single.name, 'newer.png');
    expect(store.simplifySettingsFor(_sessionId)?.maxWords, 160);
    expect(transport.lastSendPayload?['content'], 'First composition');
  });

  test('send acknowledgement preserves identically retyped text and attachment',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sendGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const attachment = RemoteAttachment(
      name: 'same.png',
      mimeType: 'image/png',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    store.setDraft(_sessionId, 'Same composition');
    store.setDraftAttachments(_sessionId, const <RemoteAttachment>[attachment]);

    final pending = store.sendMessage(
      _sessionId,
      'Same composition',
      attachments: const <RemoteAttachment>[attachment],
    );
    await _waitFor(() => transport.lastSendPayload != null);
    // Reproduce the controller clearing on send, followed by the user typing
    // and attaching the exact same values before acknowledgement.
    store.setDraft(_sessionId, '');
    store.setDraftAttachments(_sessionId, const <RemoteAttachment>[]);
    store.setDraft(_sessionId, 'Same composition');
    store.setDraftAttachments(_sessionId, const <RemoteAttachment>[attachment]);
    transport.sendGate!.complete();
    await pending;

    expect(store.drafts[_sessionId], 'Same composition');
    expect(store.draftAttachmentsFor(_sessionId),
        const <RemoteAttachment>[attachment]);
  });

  test('failed send preserves an identically retyped second composition',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..failSend = true
      ..sendGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const attachment = RemoteAttachment(
      name: 'same.png',
      mimeType: 'image/png',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    store.setDraft(_sessionId, 'Same composition');
    store.setDraftAttachments(_sessionId, const <RemoteAttachment>[attachment]);

    final pending = store.sendMessage(
      _sessionId,
      'Same composition',
      attachments: const <RemoteAttachment>[attachment],
    );
    await _waitFor(() => transport.lastSendPayload != null);
    // This is the store-only equivalent of the route clearing on send, being
    // left, and an identical composition being deliberately entered again.
    store.setDraft(_sessionId, '');
    store.setDraftAttachments(_sessionId, const <RemoteAttachment>[]);
    store.setDraft(_sessionId, 'Same composition');
    store.setDraftAttachments(_sessionId, const <RemoteAttachment>[attachment]);
    final failure = expectLater(pending, throwsStateError);
    transport.sendGate!.complete();
    await failure;

    expect(store.drafts[_sessionId], 'Same composition\nSame composition');
    final restored = store.draftAttachmentsFor(_sessionId);
    expect(restored, hasLength(2));
    expect(restored.map((item) => item.name), <String>['same.png', 'same.png']);
    expect(restored.map((item) => item.dataBase64), <String>['AQ==', 'AQ==']);
  });

  test('failed send keeps both the failed composition and newer input',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..failSend = true
      ..sendGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const firstAttachment = RemoteAttachment(
      name: 'failed.png',
      mimeType: 'image/png',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    const newerAttachment = RemoteAttachment(
      name: 'newer.png',
      mimeType: 'image/png',
      dataBase64: 'Ag==',
      byteLength: 1,
    );
    store.setDraft(_sessionId, 'First composition');
    store.setDraftAttachments(
        _sessionId, const <RemoteAttachment>[firstAttachment]);

    final pending = store.sendMessage(
      _sessionId,
      'First composition',
      attachments: const <RemoteAttachment>[firstAttachment],
    );
    await _waitFor(() => transport.lastSendPayload != null);
    store.setDraft(_sessionId, 'New draft survives failure');
    store.setDraftAttachments(
        _sessionId, const <RemoteAttachment>[newerAttachment]);
    transport.sendGate!.complete();

    await expectLater(pending, throwsStateError);
    expect(store.drafts[_sessionId],
        'First composition\nNew draft survives failure');
    expect(
      store.draftAttachmentsFor(_sessionId).map((item) => item.name),
      <String>['failed.png', 'newer.png'],
    );
  });

  test('send forwards a phone image without exposing a device path', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.sendMessage(
      _sessionId,
      'Inspect this image',
      modelId: 'model-one',
      reasoningEffort: 'high',
      attachments: const <RemoteAttachment>[
        RemoteAttachment(
          name: 'phone.jpg',
          mimeType: 'image/jpeg',
          dataBase64: 'AQID',
          byteLength: 3,
        ),
      ],
    );

    expect(transport.lastSendPayload, <String, Object?>{
      'sessionId': _sessionId,
      'content': 'Inspect this image',
      'modelId': 'model-one',
      'reasoningEffort': 'high',
      'attachmentIds': <String>['upload-1'],
    });
    expect(transport.lastAttachmentUploadPayload, <String, Object?>{
      'name': 'phone.jpg',
      'mimeType': 'image/jpeg',
      'byteLength': 3,
    });
    expect(transport.lastSendPayload.toString(), isNot(contains(r'C:\')));
    expect(store.messages[_sessionId]!.single.parts.last.type, 'image');
  });

  test('send accepts an image-only phone message', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.sendMessage(
      _sessionId,
      '',
      attachments: const <RemoteAttachment>[
        RemoteAttachment(
          name: 'image-only.jpg',
          mimeType: 'image/jpeg',
          dataBase64: 'AQID',
          byteLength: 3,
        ),
      ],
    );

    expect(transport.lastSendPayload?['content'], '');
    expect((transport.lastSendPayload?['attachmentIds'] as List<Object?>),
        hasLength(1));
    final parts = store.messages[_sessionId]!.single.parts;
    expect(parts, hasLength(2));
    expect(parts.first.type, 'text');
    expect(parts.first.summary, '');
    expect(parts.last.type, 'image');
  });

  test('store rejects empty and oversized attachments before upload', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    for (final attachment in const <RemoteAttachment>[
      RemoteAttachment(
        name: 'empty.txt',
        mimeType: 'text/plain',
        dataBase64: '',
        byteLength: 0,
      ),
      RemoteAttachment(
        name: 'too-large.bin',
        mimeType: 'application/octet-stream',
        dataBase64: 'AQ==',
        byteLength: maxSingleMessageAttachmentBytes + 1,
      ),
    ]) {
      await expectLater(
        store.sendMessage(
          _sessionId,
          '',
          attachments: <RemoteAttachment>[attachment],
        ),
        throwsStateError,
      );
    }

    expect(transport.attachmentUploadCount, 0);
    expect(transport.lastAttachmentUploadPayload, isNull);
    expect(transport.lastSendPayload, isNull);
    expect(store.messages[_sessionId] ?? const <RemoteMessage>[], isEmpty);
  });

  test('send uploads all six selected screenshots through the chunked route',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final screenshots = List<RemoteAttachment>.generate(
      6,
      (index) => RemoteAttachment(
        name: 'screenshot-${index + 1}.png',
        mimeType: 'image/png',
        dataBase64: base64Encode(<int>[index + 1]),
        byteLength: 1,
      ),
    );

    await store.sendMessage(
      _sessionId,
      'Compare all six screenshots',
      attachments: screenshots,
    );

    expect(
      transport.lastSendPayload?['attachmentIds'],
      List<String>.generate(6, (index) => 'upload-${index + 1}'),
    );
    expect(transport.attachmentUploadCount, 6);
    expect(store.messages[_sessionId]!.single.parts, hasLength(7));
  });

  test('send rejects an excessive selection before uploading any files',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final attachments = List<RemoteAttachment>.generate(
      maxMessageAttachments + 1,
      (index) => RemoteAttachment(
        name: 'file-${index + 1}.png',
        mimeType: 'image/png',
        dataBase64: 'AQ==',
        byteLength: 1,
      ),
    );

    await expectLater(
      store.sendMessage(_sessionId, 'Too many files', attachments: attachments),
      throwsA(predicate((Object error) =>
          error.toString().contains('attach up to 12 files'))),
    );
    expect(transport.attachmentUploadCount, 0);
    expect(transport.lastSendPayload, isNull);
  });

  test('send rejects more than 50 MiB in aggregate before any upload',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const attachments = <RemoteAttachment>[
      RemoteAttachment(
        name: 'first.bin',
        mimeType: 'application/octet-stream',
        dataBase64: 'AQ==',
        byteLength: 25 * 1024 * 1024,
      ),
      RemoteAttachment(
        name: 'second.bin',
        mimeType: 'application/octet-stream',
        dataBase64: 'Ag==',
        byteLength: 25 * 1024 * 1024,
      ),
      RemoteAttachment(
        name: 'third.bin',
        mimeType: 'application/octet-stream',
        dataBase64: 'Aw==',
        byteLength: 1,
      ),
    ];

    await expectLater(
      store.sendMessage(_sessionId, 'Too much', attachments: attachments),
      throwsA(predicate(
          (Object error) => error.toString().contains('50 MiB per message'))),
    );

    expect(transport.attachmentUploadCount, 0);
    expect(transport.lastSendPayload, isNull);
  });

  test('send accepts a file-only phone message without painting it as an image',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.sendMessage(
      _sessionId,
      '',
      attachments: const <RemoteAttachment>[
        RemoteAttachment(
          name: 'notes.pdf',
          mimeType: 'application/pdf',
          dataBase64: 'AQID',
          byteLength: 3,
        ),
      ],
    );

    expect(transport.lastSendPayload?['content'], '');
    expect(transport.lastSendPayload?['attachmentIds'], <String>['upload-1']);
    expect(store.messages[_sessionId]!.single.parts.last.type, 'file');
    expect(store.messages[_sessionId]!.single.parts.last.isImageAttachment,
        isFalse);
  });

  test('simplify settings stay attached to send, queue, and steer requests',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sessionState = 'working';
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.sendMessage(
      _sessionId,
      '/simplify',
      simplify: SimplifySettings(
        maxWords: 100,
        guidance: 'Keep the decision.',
      ),
    );
    expect(transport.lastSendPayload?['content'], '/simplify');
    expect(transport.lastSendPayload?['simplify'], <String, Object?>{
      'maxWords': 100,
      'guidance': 'Keep the decision.',
    });
    expect(store.messages[_sessionId]!.last.parts.single.summary,
        'Simplify the previous answer.');
    expect(store.messages[_sessionId]!.last.parts.single.summary,
        isNot(contains('/simplify')));

    await store.submitMessage(
      _sessionId,
      '/simplify Explain the result',
      deliveryMode: 'queue',
      simplify: SimplifySettings(maxWords: 200),
    );
    expect(
        transport.lastQueuePayload?['content'], '/simplify Explain the result');
    expect(transport.lastQueuePayload?['simplify'], <String, Object?>{
      'maxWords': 200,
    });
    expect(
        store.queuedMessagesFor(_sessionId).last.content, 'Explain the result');
    expect(store.queuedMessagesFor(_sessionId).last.content,
        isNot(contains('/simplify')));

    await store.submitMessage(
      _sessionId,
      'Please /simplify explain the log',
      deliveryMode: 'steer',
      simplify: SimplifySettings(maxWords: 300),
    );
    expect(transport.lastSteerPayload?['content'],
        'Please /simplify explain the log');
    expect(transport.lastSteerPayload?['simplify'], <String, Object?>{
      'maxWords': 300,
    });
    expect(store.simplifySettingsFor(_sessionId), isNull);
  });

  test('EARS transcribes dictation-only send and keeps the draft on cancel',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'gpt-5.6-sol',
      mode: 'cleaned',
    ));

    const clip = RemoteAttachment(
      name: 'dictation.wav',
      mimeType: 'audio/wav',
      origin: 'dictation',
      dataBase64: 'AQID',
      byteLength: 3,
    );
    const image = RemoteAttachment(
      name: 'shot.png',
      mimeType: 'image/png',
      origin: 'file-picker',
      dataBase64: 'BAUG',
      byteLength: 3,
    );

    await store.sendMessage(_sessionId, 'Also look at this',
        attachments: const <RemoteAttachment>[clip, image]);

    expect(transport.lastEarsPayload?['mode'], 'cleaned');
    expect(transport.lastEarsPayload?['attachmentIds'], <Object?>['upload-1']);
    expect(transport.lastSendPayload?['content'],
        'Also look at this\n\nTranscribed phone instruction');
    expect(transport.lastSendPayload?['attachmentIds'], <String>['upload-2']);
    expect(transport.lastAttachmentUploadPayload, <String, Object?>{
      'name': 'shot.png',
      'mimeType': 'image/png',
      'byteLength': 3,
    });
    expect(store.drafts[_sessionId], '');

    transport.earsGate = Completer<void>();
    transport.earsCancelled = false;
    transport.lastEarsPayload = null;
    transport.lastSendPayload = null;
    final pending = store.sendMessage(_sessionId, 'Keep this draft',
        attachments: const <RemoteAttachment>[clip]);
    final pendingFailure =
        expectLater(pending, throwsA(predicate((Object error) {
      return error.toString().contains('EARS transcription was cancelled.');
    })));
    await _waitFor(() => transport.lastEarsPayload != null);
    await store.cancelEars();
    await pendingFailure;
    expect(transport.lastEarsCancelPayload?['requestId'], isNotNull);
    expect(transport.lastSendPayload, isNull);
    expect(store.drafts[_sessionId], 'Keep this draft');
    expect(store.draftAttachmentsFor(_sessionId).single.origin, 'dictation');
    expect(
        store.messages[_sessionId]!
            .expand((message) => message.parts)
            .map((part) => part.summary),
        isNot(contains('Keep this draft')));
  });

  test('native audio-capable destination takes precedence over enabled EARS',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final original = store.sessions.single;
    final directSession = RemoteSession(
      id: original.id,
      hostId: original.hostId,
      providerId: 'direct',
      providerSessionId: original.providerSessionId,
      title: original.title,
      state: original.state,
      lastActivityAt: original.lastActivityAt,
      needsApproval: original.needsApproval,
      stale: original.stale,
      modelId: 'audio-model',
    );
    store.sessions
      ..clear()
      ..add(directSession);
    store.selectedSession = directSession;
    store.modelsByProvider['direct'] = const <RemoteModel>[
      RemoteModel(
        id: 'audio-model',
        providerId: 'direct',
        displayName: 'Audio model',
        isDefault: true,
        inputModalities: <String>['text', 'audio'],
        nativeMetadata: <String, Object?>{},
      ),
    ];
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'ears-model',
    ));
    const clip = RemoteAttachment(
      name: 'native.wav',
      mimeType: 'audio/wav',
      origin: 'dictation',
      dataBase64: 'AQID',
      byteLength: 3,
    );

    await store.sendMessage(
      _sessionId,
      '',
      modelId: 'audio-model',
      attachments: const <RemoteAttachment>[clip],
    );

    expect(transport.lastEarsPayload, isNull);
    expect(transport.lastSendPayload?['content'], '');
    expect(transport.lastSendPayload?['attachmentIds'], <String>['upload-1']);
    expect(transport.lastAttachmentUploadPayload?['name'], 'native.wav');
  });

  test('EARS cancellation and completion remain scoped to their task',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..scopeEarsRequests = true;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const secondSessionId = 'host/fake/second';
    store.sessions.add(store.sessions.single.copyWith(
      id: secondSessionId,
      providerSessionId: 'second',
    ));
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'gpt-5.6-sol',
    ));
    const clip = RemoteAttachment(
      name: 'dictation.wav',
      mimeType: 'audio/wav',
      origin: 'dictation',
      dataBase64: 'AQID',
      byteLength: 3,
    );

    final first = store.sendMessage(
      _sessionId,
      'First task',
      attachments: const <RemoteAttachment>[clip],
    );
    final second = store.sendMessage(
      secondSessionId,
      'Second task',
      attachments: const <RemoteAttachment>[clip],
    );
    await _waitFor(() => transport.earsRequestGates.length == 2);
    expect(store.earsBusyFor(_sessionId), true);
    expect(store.earsBusyFor(secondSessionId), true);

    final firstFailure = expectLater(first, throwsStateError);
    await store.cancelEars(_sessionId);
    await firstFailure;
    expect(store.earsBusyFor(_sessionId), false);
    expect(store.earsBusyFor(secondSessionId), true,
        reason: 'one task finishing must not clear another task owner');
    expect(store.earsBusy, true);

    final secondRequestId = transport.earsPayloads.singleWhere(
            (payload) => payload['sessionId'] == secondSessionId)['requestId']!
        as String;
    transport.earsRequestGates[secondRequestId]!.complete();
    await second;
    expect(store.earsBusy, false);
  });

  test('EARS processes five clips in ordered batches before one send',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'gpt-5.6-sol',
    ));
    final clips = List<RemoteAttachment>.generate(
      5,
      (index) => RemoteAttachment(
        name: 'dictation-$index.wav',
        mimeType: 'audio/wav',
        origin: 'dictation',
        dataBase64: 'AQID',
        byteLength: 3,
      ),
    );

    await store.sendMessage(
      _sessionId,
      'Typed first',
      attachments: clips,
    );

    expect(transport.earsPayloads, hasLength(2));
    expect(
      transport.earsPayloads[0]['attachmentIds'],
      <String>['upload-1', 'upload-2', 'upload-3', 'upload-4'],
    );
    expect(transport.earsPayloads[1]['attachmentIds'], <String>['upload-5']);
    expect(
      transport.earsPayloads.map((payload) => payload['requestId']).toSet(),
      hasLength(2),
    );
    expect(transport.sendCalls, 1);
    expect(
      transport.lastSendPayload?['content'],
      'Typed first\n\n'
      'Transcribed phone instruction\n\n'
      'Transcribed phone instruction\n\n'
      'Transcribed phone instruction\n\n'
      'Transcribed phone instruction\n\n'
      'Transcribed phone instruction',
    );
  });

  test('EARS cancel during upload skips processing and restores the draft',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..attachmentUploadBeginGate = Completer<void>()
      ..gateAttachmentUploadBeginCall = 1;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'gpt-5.6-sol',
    ));
    const clip = RemoteAttachment(
      name: 'dictation.wav',
      mimeType: 'audio/wav',
      origin: 'dictation',
      dataBase64: 'AQID',
      byteLength: 3,
    );

    final pending = store.sendMessage(
      _sessionId,
      'Keep everything',
      attachments: const <RemoteAttachment>[clip],
    );
    await _waitFor(() => transport.attachmentUploadCount == 1);
    expect(store.earsBusyFor(_sessionId), true);
    await store.cancelEars(_sessionId);
    transport.attachmentUploadBeginGate!.complete();

    await expectLater(pending, throwsStateError);
    await _waitFor(() => transport.cancelledUploadIds.contains('upload-1'));
    expect(transport.earsPayloads, isEmpty);
    expect(transport.sendCalls, 0);
    expect(store.drafts[_sessionId], 'Keep everything');
    expect(
        store.draftAttachmentsFor(_sessionId), const <RemoteAttachment>[clip]);
  });

  test('EARS cancel between batches prevents the later batch', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..scopeEarsRequests = true
      ..attachmentUploadBeginGate = Completer<void>()
      ..gateAttachmentUploadBeginCall = 5;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'gpt-5.6-sol',
    ));
    final clips = List<RemoteAttachment>.generate(
      5,
      (index) => RemoteAttachment(
        name: 'dictation-$index.wav',
        mimeType: 'audio/wav',
        origin: 'dictation',
        dataBase64: 'AQID',
        byteLength: 3,
      ),
    );

    final pending = store.sendMessage(
      _sessionId,
      'Keep the batched draft',
      attachments: clips,
    );
    await _waitFor(() => transport.earsPayloads.length == 1);
    final firstRequestId =
        transport.earsPayloads.single['requestId']! as String;
    transport.earsRequestGates[firstRequestId]!.complete();
    await _waitFor(() => transport.attachmentUploadCount == 5);
    await store.cancelEars(_sessionId);
    transport.attachmentUploadBeginGate!.complete();

    await expectLater(pending, throwsStateError);
    expect(transport.earsPayloads, hasLength(1));
    expect(transport.sendCalls, 0);
    expect(store.drafts[_sessionId], 'Keep the batched draft');
    expect(store.draftAttachmentsFor(_sessionId), clips);
  });

  test('disabled EARS rejects dictation for a text-only destination', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await expectLater(
      store.sendMessage(
        _sessionId,
        '',
        attachments: const <RemoteAttachment>[
          RemoteAttachment(
            name: 'dictation.wav',
            mimeType: 'audio/wav',
            origin: 'dictation',
            dataBase64: 'AQID',
            byteLength: 3,
          ),
        ],
      ),
      throwsA(predicate((Object error) {
        return error
            .toString()
            .contains('Enable EARS or choose an audio-capable model');
      })),
    );
    expect(transport.lastSendPayload, isNull);
    expect(transport.lastEarsPayload, isNull);
  });

  test('refresh preserves a prepared task and its unsent draft', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final prepared = store.prepareSession('fake');
    store.setDraft(prepared.id, 'Keep this unsent');
    store.setDraftAttachments(prepared.id, const <RemoteAttachment>[
      RemoteAttachment(
        name: 'draft.png',
        mimeType: 'image/png',
        dataBase64: 'AQID',
        byteLength: 3,
      ),
    ]);

    await store.refresh();

    expect(store.isPreparedSession(prepared.id), isTrue);
    expect(store.sessions.map((session) => session.id), contains(prepared.id));
    expect(store.selectedSession?.id, prepared.id);
    expect(store.drafts[prepared.id], 'Keep this unsent');
    expect(store.draftAttachmentsFor(prepared.id).single.name, 'draft.png');
  });

  test('prepared first turn creates the session before sending the message',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final prepared = store.prepareSession('fake');
    store.updatePreparedDirectory(prepared.id, r'C:\work');

    final createdId = await store.submitMessage(
      prepared.id,
      'Review this repository',
      modelId: 'model-one',
      reasoningEffort: 'high',
    );

    expect(transport.createCalls, 1);
    expect(transport.lastCreatePayload, <String, Object?>{
      'providerId': 'fake',
      'workingDirectory': r'C:\work',
      'modelId': 'model-one',
      'reasoningEffort': 'high',
    });
    expect(transport.lastSendPayload, isNull);
    expect(transport.lastQueuePayload?['content'], 'Review this repository');
    expect(createdId, 'host/fake/created');
    expect(store.isPreparedSession(prepared.id), isFalse);
  });

  test('prepared create success keeps a retryable draft when delivery fails',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)..failQueue = true;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final prepared = store.prepareSession('fake');
    const attachment = RemoteAttachment(
      name: 'retry.txt',
      mimeType: 'text/plain',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    final simplify = SimplifySettings(maxWords: 120);
    store.setDraft(prepared.id, 'Retry this first turn');
    store
        .setDraftAttachments(prepared.id, const <RemoteAttachment>[attachment]);
    store.setDraftSimplifySettings(prepared.id, simplify);

    final createdId = await store.submitMessage(
      prepared.id,
      'Retry this first turn',
      attachments: const <RemoteAttachment>[attachment],
      simplify: simplify,
    );

    expect(createdId, 'host/fake/created');
    expect(store.selectedSession?.id, createdId);
    expect(store.sessions.map((session) => session.id),
        isNot(contains(prepared.id)));
    expect(store.drafts[createdId], 'Retry this first turn');
    expect(store.draftAttachmentsFor(createdId!).single.name, 'retry.txt');
    expect(store.simplifySettingsFor(createdId)?.maxWords, 120);
    expect(store.error, contains('draft is ready to retry'));
  });

  test('prepared delivery failure preserves its first turn and newer typing',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..failQueue = true
      ..createGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final prepared = store.prepareSession('fake');
    const firstAttachment = RemoteAttachment(
      name: 'first.txt',
      mimeType: 'text/plain',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    const newerAttachment = RemoteAttachment(
      name: 'newer.txt',
      mimeType: 'text/plain',
      dataBase64: 'Ag==',
      byteLength: 1,
    );
    store.setDraft(prepared.id, 'Create with this');
    store.setDraftAttachments(
        prepared.id, const <RemoteAttachment>[firstAttachment]);

    final pending = store.submitMessage(
      prepared.id,
      'Create with this',
      attachments: const <RemoteAttachment>[firstAttachment],
    );
    await _waitFor(() => transport.createCalls == 1);
    store.setDraft(prepared.id, 'Typed while the task was being created');
    store.setDraftAttachments(
        prepared.id, const <RemoteAttachment>[newerAttachment]);
    transport.createGate!.complete();
    final createdId = await pending;

    expect(createdId, 'host/fake/created');
    expect(store.drafts[createdId],
        'Create with this\nTyped while the task was being created');
    expect(
      store.draftAttachmentsFor(createdId!).map((item) => item.name),
      <String>['first.txt', 'newer.txt'],
    );
    expect(store.error, contains('draft is ready to retry'));
  });

  test('queued phone attachments use chunks and queue events stay shared',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final bytes = List<int>.filled(1024 * 1024 + 13, 7);

    await store.submitMessage(
      _sessionId,
      'Run this after the current work',
      attachments: <RemoteAttachment>[
        RemoteAttachment(
          name: 'phone-large.bin',
          mimeType: 'application/octet-stream',
          dataBase64: base64Encode(bytes),
          byteLength: bytes.length,
        ),
      ],
    );

    expect(transport.uploadChunkSizes.length, greaterThan(1));
    expect(transport.uploadChunkSizes.reduce((a, b) => a + b), bytes.length);
    expect(transport.lastQueuePayload?['attachmentIds'], <String>['upload-1']);
    expect(store.queuedMessagesFor(_sessionId).single.content,
        'Run this after the current work');

    store.applyEventForTesting(AgentEvent(
      eventId: 'queue-remove',
      sequence: 99,
      type: 'message.queue_removed',
      occurredAt: DateTime.utc(2026, 8, 10, 12),
      sessionId: _sessionId,
      providerId: 'fake',
      payload: const <String, Object?>{'messageId': 'queued-1'},
    ));
    expect(store.queuedMessagesFor(_sessionId), isEmpty);
  });

  test('queue acknowledgement preserves text and attachments typed afterward',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..queueEnqueueGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const sentAttachment = RemoteAttachment(
      name: 'sent.txt',
      mimeType: 'text/plain',
      dataBase64: 'AQ==',
      byteLength: 1,
    );
    const nextAttachment = RemoteAttachment(
      name: 'next.txt',
      mimeType: 'text/plain',
      dataBase64: 'Ag==',
      byteLength: 1,
    );
    store.setDraft(_sessionId, 'Queue this');
    store.setDraftAttachments(
        _sessionId, const <RemoteAttachment>[sentAttachment]);

    final pending = store.submitMessage(
      _sessionId,
      'Queue this',
      attachments: const <RemoteAttachment>[sentAttachment],
    );
    await _waitFor(() => transport.lastQueuePayload != null);
    store.setDraft(_sessionId, 'Then send this');
    store.setDraftAttachments(
        _sessionId, const <RemoteAttachment>[nextAttachment]);
    transport.queueEnqueueGate!.complete();
    await pending;

    expect(store.drafts[_sessionId], 'Then send this');
    expect(store.draftAttachmentsFor(_sessionId).single.name, 'next.txt');
    expect(transport.lastQueuePayload?['content'], 'Queue this');
  });

  test('mesh strips its inline marker without erasing a newer parent draft',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..delegationStartGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const anchoredDraft = '\uFFFCReview in parallel';
    store.setDraft(_sessionId, anchoredDraft);

    final pending = store.startDelegation(
      _sessionId,
      anchoredDraft,
      const <DelegationSelection>[
        DelegationSelection(providerId: 'fake'),
      ],
      modelId: 'parent-model',
      reasoningEffort: 'high',
    );
    await _waitFor(() => transport.lastDelegationPayload != null);
    final optimistic = store.delegations.values.single;
    expect(optimistic.prompt, 'Review in parallel');
    expect(optimistic.targets, hasLength(1));
    expect(optimistic.targets.single.providerId, 'fake');
    expect(
      optimistic.presentationSegments.map((segment) => segment.type),
      <String>['mesh', 'text'],
    );
    store.setDraft(_sessionId, 'New parent draft');
    transport.delegationStartGate!.complete();
    await pending;

    expect(store.drafts[_sessionId], 'New parent draft');
    expect(store.delegations.values.single.state, 'awaiting_dispatch');
    expect(store.delegations.values.single.targets.single.providerId, 'fake');
    expect(transport.lastDelegationPayload?['prompt'], 'Review in parallel');
    expect(transport.lastDelegationPayload?['modelId'], 'parent-model');
    expect(transport.lastDelegationPayload?['reasoningEffort'], 'high');
    expect(
      transport.lastDelegationPayload?['presentationSegments'],
      <Object?>[
        <String, Object?>{'type': 'mesh', 'targetIndex': 0},
        <String, Object?>{'type': 'text', 'text': 'Review in parallel'},
      ],
    );
  });

  test('a locally queued image retains only its safe local preview data',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    const encoded =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    final bytes = base64Decode(encoded);

    await store.submitMessage(
      _sessionId,
      'Look at this next',
      attachments: <RemoteAttachment>[
        RemoteAttachment(
          name: 'local-preview.png',
          mimeType: 'image/png',
          dataBase64: encoded,
          byteLength: bytes.length,
        ),
      ],
    );

    final attachment =
        store.queuedMessagesFor(_sessionId).single.attachments.single;
    expect(attachment.dataBase64, encoded);
    expect(attachment.localImageDataUri, 'data:image/png;base64,$encoded');
  });

  test('queue actions and side chats use isolated bridge operations', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..queueSnapshot = <Object?>[_queuedJson('queue-actions')]
      ..sideChatSnapshot = <Object?>[_sideChatJson('existing-side-chat')];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    expect(store.sideChatsFor(_sessionId).single.id, 'existing-side-chat');
    expect(store.visibleSessions.map((session) => session.id),
        isNot(contains('existing-side-chat')));

    final queued = store.queuedMessagesFor(_sessionId).single;
    final edited = await store.editQueuedMessage(queued, 'Edited in place');
    expect(edited.content, 'Edited in place');
    expect(transport.lastQueueEditPayload?['messageId'], queued.id);

    await store.deliverQueuedMessage(edited, mode: 'steer');
    expect(transport.lastQueueDeliverPayload, <String, Object?>{
      'messageId': queued.id,
      'mode': 'steer',
    });
    expect(store.queuedMessagesFor(_sessionId), isEmpty);

    final sideChat = await store.createSideChat(
      _sessionId,
      prompt: 'Check the current approach',
    );
    expect(sideChat.sessionKind, 'side_chat');
    expect(store.visibleSessions.map((session) => session.id),
        isNot(contains(sideChat.id)));
    final promoted = await store.promoteSideChat(sideChat.id);
    expect(promoted.sessionKind, 'task');
    expect(store.visibleSessions.map((session) => session.id),
        contains(promoted.id));

    await store.createSideChat(
      _sessionId,
      queuedMessageId: 'queued-for-side-chat',
    );
    expect(transport.lastSideChatCreatePayload, <String, Object?>{
      'parentSessionId': _sessionId,
      'queuedMessageId': 'queued-for-side-chat',
    });
  });

  test(
      'moving a queued instruction records the chosen model and removes only that item',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..queueSnapshot = <Object?>[
        _queuedJson('move-this'),
        <String, Object?>{
          ..._queuedJson('keep-this'),
          'content': 'Keep this queued',
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final selected = store.queuedMessages['move-this']!;

    final created = await store.moveQueuedMessageToNewTask(
      selected,
      providerId: 'fake',
      modelId: 'fake-model',
      reasoningEffort: 'high',
    );

    expect(transport.lastQueueNewTaskPayload, <String, Object?>{
      'messageId': 'move-this',
      'providerId': 'fake',
      'modelId': 'fake-model',
      'reasoningEffort': 'high',
    });
    expect(store.queuedMessages.keys, contains('keep-this'));
    expect(store.queuedMessages.keys, isNot(contains('move-this')));
    expect(store.selectedSession?.id, created.id);
    expect(created.modelId, 'fake-model');
    expect(created.reasoningEffort, 'high');
    expect(store.recentModelKeys.first, 'fake\u0000fake-model');
  });

  test('a received cross-task message refreshes visible history with origin',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        <String, Object?>{
          'id': 'remote-message',
          'sessionId': _sessionId,
          'role': 'user',
          'createdAt': DateTime.utc(2026, 8, 15, 12).toIso8601String(),
          'parts': <Object?>[
            <String, Object?>{'type': 'text', 'text': 'Review this handoff'}
          ],
          'status': 'completed',
          'origin': <String, Object?>{
            'kind': 'cross_session',
            'envelopeId': 'envelope-1',
            'sourceSessionId': 'source-session',
            'sourceTitle': 'Source task',
          },
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);

    store.applyEventForTesting(_eventWithPayload(
      'message.remote_received',
      1,
      const <String, Object?>{
        'state': 'delivered',
        'envelope': <String, Object?>{'id': 'envelope-1'},
      },
    ));
    await Future<void>.delayed(const Duration(milliseconds: 400));

    expect(transport.openCalls, 1);
    expect(store.events[_sessionId], isNull);
    expect(store.messages[_sessionId]!.single.origin?.kind, 'cross_session');
    expect(
        store.messages[_sessionId]!.single.origin?.sourceTitle, 'Source task');
  });

  test('dictation sends the selected persisted source and saved dictionary',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.setDictationDictionary(
        <String>[' OpenCode ', 'PostgreSQL', 'opencode', '']);
    await store.setDictationSource('xai-stt');

    final transcript = await store.transcribeDictation(
      List<int>.filled(9000, 4),
      sessionId: _sessionId,
    );

    expect(transcript, 'Transcribed phone instruction');
    expect(transport.lastDictationPayload?['dictionary'],
        <String>['OpenCode', 'PostgreSQL']);
    expect(transport.lastDictationPayload?['sourceId'], 'xai-stt');
    expect(await security.readDictationSourceId(), 'xai-stt');
    expect(transport.uploadChunkSizes.reduce((a, b) => a + b), 9000);
  });

  test('dictation defaults and preferences are ready and harness-specific',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    expect(store.dictationSourceForHarness('codex')?.id, 'openai-stt');
    expect(store.dictationSourceForHarness('grok')?.id, 'xai-stt');
    expect(store.dictationSourceForHarness('opencode'), isNull);

    await store.setDictationSourceForHarness('opencode', 'xai-stt');
    await store.setDictationSourceForHarness('grok', 'openai-stt');

    expect(store.dictationSourceForHarness('opencode')?.id, 'xai-stt');
    expect(store.dictationSourceForHarness('grok')?.id, 'openai-stt');
    expect(await security.readDictationSourcePreferences(), <String, String>{
      'opencode': 'xai-stt',
      'grok': 'openai-stt',
    });
  });

  test('synthetic direct audio preference persists for screen revalidation',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.setDictationSourceForHarness(
        'fake', directAudioDictationSourceId);

    expect(store.preferredDictationSourceIdForHarness('fake'),
        directAudioDictationSourceId);
    expect(store.dictationSourceForHarness('fake'), isNull);
    expect(await security.readDictationSourcePreferences(), <String, String>{
      'fake': directAudioDictationSourceId,
    });
  });

  test(
      'dictation provider key setup returns a ready source without echoing the key',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..dictationSourcesReady = false;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    await store.configureDictationSource('openai-stt',
        apiKey: 'sk-test-secret');

    expect(transport.lastDictationConfigurePayload, <String, Object?>{
      'sourceId': 'openai-stt',
      'apiKey': 'sk-test-secret',
    });
    expect(
        store.dictationSources
            .singleWhere((source) => source.id == 'openai-stt')
            .isReady,
        isTrue);
    expect(
        store.dictationSources.toString(), isNot(contains('sk-test-secret')));
  });

  test('harness login does not make an unavailable dictation service ready',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final xaiIndex =
        store.dictationSources.indexWhere((source) => source.id == 'xai-stt');
    store.dictationSources[xaiIndex] = const TranscriptionSource(
      id: 'xai-stt',
      label: 'xAI speech-to-text',
      status: 'needs_credential',
      setupEnvironmentVariable: 'XAI_API_KEY',
      supportsBatch: true,
      maxAudioBytes: 25 * 1024 * 1024,
    );

    expect(
        store.providers
            .singleWhere((item) => item.providerId == 'fake')
            .authenticated,
        isTrue);
    expect(store.dictationSourceForHarness('grok')?.id, 'openai-stt');
    expect(store.readyDictationSources.any((source) => source.id == 'xai-stt'),
        isFalse);
  });

  test('dictation fails before upload when no speech-to-text source is ready',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..dictationSourcesReady = false;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    expect(
      () => store.transcribeDictation(
        List<int>.filled(9000, 4),
        sessionId: _sessionId,
      ),
      throwsA(isA<StateError>().having((error) => error.message, 'message',
          'Choose a ready dictation service from the microphone menu.')),
    );
    expect(transport.uploadChunkSizes, isEmpty);
  });

  test('visible live deltas stream and completion refreshes history in place',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        <String, Object?>{
          'id': 'assistant-final',
          'sessionId': _sessionId,
          'role': 'assistant',
          'createdAt': DateTime.utc(2026, 8, 10, 11, 1).toIso8601String(),
          'parts': <Object?>[
            <String, Object?>{'type': 'text', 'text': 'Canonical answer'}
          ],
          'status': 'completed',
        }
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);

    store.applyEventForTesting(
        _eventWithPayload('message.started', 1, const <String, Object?>{}));
    store.applyEventForTesting(_eventWithPayload(
        'message.delta', 2, const <String, Object?>{'text': 'Live '}));
    store.applyEventForTesting(_eventWithPayload(
        'message.delta', 3, const <String, Object?>{'text': 'answer'}));

    expect(store.sessions.single.state, 'working');
    final livePresentation = store.liveAssistantMessageFor(_sessionId)!;
    expect(livePresentation.parts.single.summary, 'Live answer');

    store.applyEventForTesting(_event('agent.completed', 4));
    final settledPresentation = store.messages[_sessionId]!.single;
    expect(settledPresentation.id, 'live-event-4');
    expect(settledPresentation.presentationId, livePresentation.presentationId);
    await Future<void>.delayed(const Duration(milliseconds: 400));

    expect(transport.openCalls, 1);
    expect(store.liveAssistantMessageFor(_sessionId), isNull);
    final canonical = store.messages[_sessionId]!.single;
    expect(canonical.id, 'assistant-final');
    expect(canonical.providerMessageId, isNull);
    expect(canonical.presentationId, livePresentation.presentationId);
    expect(canonical.parts.single.summary, 'Canonical answer');
  });

  test('canonical assistant provider identity adopts local presentation first',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        <String, Object?>{
          ..._messageJson(
            'Canonical provider answer',
            id: 'canonical-provider-answer',
            createdAt: '2026-08-10T13:00:00.000Z',
          ),
          'providerMessageId': 'local-provider-answer',
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);
    store.messages[_sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'local-provider-answer',
        sessionId: _sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 10, 11),
        parts: const <ContentPart>[
          ContentPart(
            type: 'text',
            data: <String, Object?>{'text': 'Different local answer'},
          ),
        ],
        status: 'completed',
        presentationId: 'live-assistant-provider-answer',
      ),
    ];

    await store.refreshVisibleSessionHistory(_sessionId);

    final canonical = store.messages[_sessionId]!.single;
    expect(canonical.id, 'canonical-provider-answer');
    expect(canonical.providerMessageId, 'local-provider-answer');
    expect(canonical.presentationId, 'live-assistant-provider-answer');
    expect(canonical.parts.single.summary, 'Canonical provider answer');
  });

  test('an older repeated assistant cannot adopt a newer local presentation',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final olderAt = DateTime.utc(2026, 8, 10, 11, 0, 58);
    final localAt = DateTime.utc(2026, 8, 10, 11, 1);
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        _messageJson(
          'Repeat answer',
          id: 'older-repeat-answer',
          createdAt: olderAt.toIso8601String(),
        ),
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);
    store.messages[_sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'older-repeat-answer',
        sessionId: _sessionId,
        role: 'assistant',
        createdAt: olderAt,
        parts: const <ContentPart>[
          ContentPart(
            type: 'text',
            data: <String, Object?>{'text': 'Repeat answer'},
          ),
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'local-repeat-answer',
        sessionId: _sessionId,
        role: 'assistant',
        createdAt: localAt,
        parts: const <ContentPart>[
          ContentPart(
            type: 'text',
            data: <String, Object?>{'text': 'Repeat answer'},
          ),
        ],
        status: 'completed',
        presentationId: 'live-assistant-repeat-answer',
      ),
    ];

    await store.refreshVisibleSessionHistory(_sessionId);

    final older = store.messages[_sessionId]!.single;
    expect(older.id, 'older-repeat-answer');
    expect(older.presentationId, 'older-repeat-answer');
  });

  test('repeated local assistants cannot consume one ambiguous canonical row',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final localAt = DateTime.utc(2026, 8, 10, 11, 1);
    final canonicalAt = localAt.add(const Duration(seconds: 1));
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        _messageJson(
          'Repeat answer',
          id: 'ambiguous-canonical-answer',
          createdAt: canonicalAt.toIso8601String(),
        ),
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);
    store.messages[_sessionId] = <RemoteMessage>[
      for (var index = 0; index < 2; index += 1)
        RemoteMessage(
          id: 'local-repeat-$index',
          sessionId: _sessionId,
          role: 'assistant',
          createdAt: localAt.add(Duration(milliseconds: index * 200)),
          parts: const <ContentPart>[
            ContentPart(
              type: 'text',
              data: <String, Object?>{'text': 'Repeat answer'},
            ),
          ],
          status: 'completed',
          presentationId: 'live-assistant-repeat-$index',
        ),
    ];

    await store.refreshVisibleSessionHistory(_sessionId);

    final canonical = store.messages[_sessionId]!.single;
    expect(canonical.id, 'ambiguous-canonical-answer');
    expect(canonical.presentationId, 'ambiguous-canonical-answer');
  });

  test('semantically unchanged history polls preserve identity and stay quiet',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        _messageJson(
          'Stable answer',
          id: 'stable-answer',
          createdAt: '2026-08-10T12:00:00.000Z',
        )
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);
    await store.refreshVisibleSessionHistory(_sessionId);
    await Future<void>.delayed(Duration.zero);

    final originalSession = store.sessions.single;
    final originalHistory = store.messages[_sessionId]!;
    final originalMessage = originalHistory.single;
    var notifications = 0;
    store.addListener(() => notifications += 1);

    await store.refreshVisibleSessionHistory(_sessionId);

    expect(identical(store.sessions.single, originalSession), isTrue);
    expect(identical(store.messages[_sessionId], originalHistory), isTrue);
    expect(
        identical(store.messages[_sessionId]!.single, originalMessage), isTrue);
    expect(notifications, 0);
  });

  test('a visible working task can reconcile missed provider reasoning quietly',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sessionState = 'working'
      ..openMessages = <Object?>[
        <String, Object?>{
          'id': 'missed-reasoning',
          'sessionId': _sessionId,
          'role': 'assistant',
          'createdAt': DateTime.utc(2026, 8, 16, 12).toIso8601String(),
          'parts': <Object?>[
            <String, Object?>{
              'type': 'reasoning',
              'text': 'Inspecting the current provider state',
            }
          ],
          'status': 'streaming',
        }
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setVisibleSession(_sessionId);

    await store.refreshVisibleSessionHistory(_sessionId);

    expect(transport.openCalls, 1);
    expect(transport.openRefreshes, <bool>[true]);
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Inspecting the current provider state');
  });

  test('history refresh preserves a newer local thinking artifact', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        <String, Object?>{
          'id': 'assistant-final',
          'sessionId': _sessionId,
          'role': 'assistant',
          'createdAt': DateTime.utc(2026, 8, 10, 11, 1).toIso8601String(),
          'parts': <Object?>[
            <String, Object?>{'type': 'text', 'text': 'Canonical answer'}
          ],
          'status': 'completed',
        }
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    store.applyEventForTesting(
        _eventWithPayload('message.delta', 2, const <String, Object?>{
      'phase': 'commentary',
      'text': 'Checking the final live state',
    }));
    store.applyEventForTesting(
        _eventWithPayload('message.completed', 3, const <String, Object?>{
      'phase': 'commentary',
      'text': 'Checking the final live state',
    }));

    await store.openSession(store.sessions.single);

    final history = store.messages[_sessionId]!;
    expect(history, hasLength(2));
    expect(history.first.parts.single.summary, 'Canonical answer');
    expect(history.last.parts.single.type, 'reasoning');
    expect(history.last.parts.single.summary, 'Checking the final live state');
  });

  test('live deltas coalesce rebuilds and retained event history stays bounded',
      () async {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.sessions.add(RemoteSession(
      id: _sessionId,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: 'session-one',
      title: 'Live session',
      state: 'working',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
    ));
    var notifications = 0;
    store.addListener(() => notifications += 1);

    for (var index = 1; index <= 120; index += 1) {
      store.applyEventForTesting(AgentEvent(
        eventId: 'delta-$index',
        sequence: index,
        type: 'message.delta',
        occurredAt:
            DateTime.utc(2026, 8, 10, 11).add(Duration(milliseconds: index)),
        payload: const <String, Object?>{'text': 'x'},
        sessionId: _sessionId,
        providerId: 'fake',
      ));
    }

    expect(
        store.liveAssistantMessageFor(_sessionId)!.parts.single.summary, 'x');
    expect(store.sessions.single.lastActivityAt,
        DateTime.utc(2026, 8, 10, 11).add(const Duration(milliseconds: 120)));
    expect(store.events[_sessionId], isNull);
    expect(notifications, 0);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(notifications, 1);

    for (var index = 121; index <= 370; index += 1) {
      store.applyEventForTesting(AgentEvent(
        eventId: 'tool-$index',
        sequence: index,
        type: 'tool.completed',
        occurredAt:
            DateTime.utc(2026, 8, 10, 11).add(Duration(milliseconds: index)),
        payload: const <String, Object?>{},
        sessionId: _sessionId,
        providerId: 'fake',
      ));
    }
    expect(store.events[_sessionId], hasLength(200));
    expect(store.events[_sessionId]!.first.sequence, 171);

    final beforeTerminal = notifications;
    store.applyEventForTesting(AgentEvent(
      eventId: 'last-delta',
      sequence: 371,
      type: 'message.delta',
      occurredAt: DateTime.utc(2026, 8, 10, 11, 1),
      payload: const <String, Object?>{'text': 'y'},
      sessionId: _sessionId,
      providerId: 'fake',
    ));
    store.applyEventForTesting(AgentEvent(
      eventId: 'terminal',
      sequence: 372,
      type: 'agent.completed',
      occurredAt: DateTime.utc(2026, 8, 10, 11, 2),
      payload: const <String, Object?>{},
      sessionId: _sessionId,
      providerId: 'fake',
    ));
    expect(notifications, beforeTerminal + 1);
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(notifications, beforeTerminal + 1);
  });

  test('active host scopes root sessions, child sessions, and stale opens', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.hosts.addAll(<PairedHost>[_host, _otherHost]);
    store.activeHost = _host;
    final firstRoot = _sessionForHost('host', 'host/root');
    final firstChild = _sessionForHost(
      'host',
      'host/child',
      parentSessionId: firstRoot.id,
      relationship: SessionRelationship(
        kind: 'subagent',
        sourceSessionId: firstRoot.id,
        strategy: 'native',
      ),
    );
    final secondRoot = _sessionForHost('other-host', 'other/root');
    final secondChild = _sessionForHost(
      'other-host',
      'other/child',
      parentSessionId: secondRoot.id,
      relationship: SessionRelationship(
        kind: 'subagent',
        sourceSessionId: secondRoot.id,
        strategy: 'native',
      ),
    );
    store.sessions.addAll(
        <RemoteSession>[firstRoot, firstChild, secondRoot, secondChild]);

    expect(store.visibleSessions.map((session) => session.id),
        <String>[firstRoot.id]);
    expect(store.childSessionsFor(firstRoot.id).map((session) => session.id),
        <String>[firstChild.id]);

    store.activeHost = _otherHost;
    expect(store.visibleSessions.map((session) => session.id),
        <String>[secondRoot.id]);
    expect(store.childSessionsFor(firstRoot.id), isEmpty);
    store.openSessionForView(firstRoot);
    expect(store.selectedSession, isNull);
  });

  test('parented user chats stay visible when they are not explicit subagents',
      () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);
    store.hosts.add(_host);
    store.activeHost = _host;
    final workspace = _sessionForHost('host', 'host/opencode/workspace');
    final chat = _sessionForHost(
      'host',
      'host/opencode/chat',
      parentSessionId: workspace.id,
    );
    store.sessions.addAll(<RemoteSession>[workspace, chat]);

    expect(store.visibleSessions.map((session) => session.id).toList(),
        containsAll(<String>[workspace.id, chat.id]));
  });

  test('connect lists providers once and concurrent model loads are deduped',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..modelGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    expect(transport.providerCalls, 1);
    final first = store.loadModels('fake');
    final second = store.loadModels('fake');
    await Future<void>.delayed(Duration.zero);
    expect(transport.modelCalls, 1);

    transport.modelGate!.complete();
    expect((await first).single.id, 'fake-model');
    expect((await second).single.id, 'fake-model');
    expect((await store.loadModels('fake')).single.id, 'fake-model');
    expect(transport.modelCalls, 1);
  });

  test('a model catalogue response from the previous host is never returned',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final firstTransport = _FakeTransport(
      security: security,
      host: _host,
      modelId: 'old-host-model',
    )..modelGate = Completer<void>();
    final secondTransport = _FakeTransport(
      security: security,
      host: _otherHost,
      modelId: 'new-host-model',
    );
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _host.hostId ? firstTransport : secondTransport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);
    final staleLoad = store.loadModels('fake', force: true);
    await Future<void>.delayed(Duration.zero);
    await store.connectHost(_otherHost);
    final current = await store.loadModels('fake', force: true);
    firstTransport.modelGate!.complete();
    final staleResult = await staleLoad;

    expect(current.single.id, 'new-host-model');
    expect(staleResult.single.id, 'new-host-model');
    expect(store.modelsByProvider['fake']?.single.id, 'new-host-model');
  });

  test('a prepared task cannot cross hosts while its model catalogue loads',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final firstTransport = _FakeTransport(
      security: security,
      host: _host,
      modelId: 'old-host-model',
    )..modelGate = Completer<void>();
    final secondTransport = _FakeTransport(
      security: security,
      host: _otherHost,
      modelId: 'new-host-model',
    );
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _host.hostId ? firstTransport : secondTransport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);
    final pending = store.startPreparedSession(
      'fake',
      workingDirectory: r'C:\Users\example\Documents\Alpha',
    );
    await Future<void>.delayed(Duration.zero);
    await store.connectHost(_otherHost);
    firstTransport.modelGate!.complete();

    await expectLater(
      pending,
      throwsA(isA<StateError>().having(
        (error) => error.message,
        'message',
        contains('active computer changed'),
      )),
    );
    expect(
        store.sessions.where((session) => store.isPreparedSession(session.id)),
        isEmpty);
  });

  test('a model catalogue response from a replaced transport is never returned',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final firstTransport = _FakeTransport(
      security: security,
      host: _host,
      modelId: 'old-transport-model',
    )..modelGate = Completer<void>();
    final secondTransport = _FakeTransport(
      security: security,
      host: _host,
      modelId: 'new-transport-model',
    );
    var connectionCount = 0;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) =>
          connectionCount++ == 0 ? firstTransport : secondTransport,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);
    final staleLoad = store.loadModels('fake', force: true);
    await Future<void>.delayed(Duration.zero);
    await store.connectHost(_host);
    final current = await store.loadModels('fake', force: true);
    firstTransport.modelGate!.complete();
    final staleResult = await staleLoad;

    expect(current.single.id, 'new-transport-model');
    expect(staleResult.single.id, 'new-transport-model');
    expect(store.modelsByProvider['fake']?.single.id, 'new-transport-model');
  });

  test('failed model catalogues retry directly and after reconnect', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..modelFailuresRemaining = 1;
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    expect(await store.loadModels('fake'), isEmpty);
    expect(store.modelsByProvider, isNot(contains('fake')));
    expect((await store.loadModels('fake')).single.id, 'fake-model');
    expect(transport.modelCalls, 2);

    store.modelsByProvider.remove('fake');
    transport.modelFailuresRemaining = 1;
    expect(await store.loadModels('fake'), isEmpty);
    expect(store.modelsByProvider, isNot(contains('fake')));
    transport.setStateForTesting(BridgeConnectionState.reconnecting);
    transport.setStateForTesting(BridgeConnectionState.online);

    await _waitFor(() =>
        transport.modelCalls == 4 &&
        store.modelsByProvider['fake']?.single.id == 'fake-model');
  });

  test('duplicate view opens share one request and only essential rebuilds',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..openGate = Completer<void>();
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    var notifications = 0;
    store.addListener(() => notifications += 1);

    store.openSessionForView(store.sessions.single);
    store.openSessionForView(store.sessions.single);
    await Future<void>.delayed(Duration.zero);
    expect(transport.openCalls, 1);
    expect(notifications, 1);

    transport.openGate!.complete();
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(store.isSessionHistoryLoading(_sessionId), isFalse);
    expect(notifications, 2);
  });

  test('history and created sessions appear before read-state storage finishes',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = _DelayedReadStateSecurity();
    final transport = _FakeTransport(security: security)
      ..openMessages = <Object?>[
        <String, Object?>{
          'id': 'visible-before-save',
          'sessionId': _sessionId,
          'role': 'assistant',
          'createdAt': '2026-08-10T11:00:00.000Z',
          'parts': <Object?>[
            <String, Object?>{'type': 'text', 'text': 'Loaded immediately'}
          ],
          'status': 'completed',
        }
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.applyEventForTesting(_event('agent.completed', 1));
    await store.flushUnreadPersistenceForTesting();
    security.delayWrites = true;

    await store.openSession(store.sessions.single);
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Loaded immediately');
    expect(store.isSessionUnread(_sessionId), isFalse);

    final created = await store.createSession(
      providerId: 'fake',
      workingDirectory: r'C:\work',
      firstInstruction: '',
    );
    expect(store.sessions.any((session) => session.id == created.id), isTrue);
    expect(store.selectedSession?.id, created.id);
    await Future<void>.delayed(Duration.zero);
    expect(security.delayedSaveCalls, 1);

    security.releaseWrites();
    await store.flushUnreadPersistenceForTesting();
  });

  test(
      'draft journal restart restores exact text settings and attachment order lazily',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-draft-restart-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final firstTransport = _FakeTransport(security: security);
    final first = _journalBackedStore(root, security, firstTransport);
    await first.initialize();
    first.setDraft(_sessionId, 'Exact restart text');
    first.setDraftSimplifySettings(
      _sessionId,
      SimplifySettings(maxWords: 137, guidance: 'Keep the ordering.'),
    );
    first.setDraftAttachments(_sessionId, const <RemoteAttachment>[
      RemoteAttachment(
        name: 'first.txt',
        mimeType: 'text/plain',
        dataBase64: 'AQI=',
        byteLength: 2,
        origin: 'file-picker',
      ),
      RemoteAttachment(
        name: 'second.png',
        mimeType: 'image/png',
        dataBase64: 'AwQF',
        byteLength: 3,
        origin: 'photo-picker',
      ),
    ]);
    await first.flushDraftJournal();
    first.dispose();

    final secondTransport = _FakeTransport(security: security);
    final restarted = _journalBackedStore(root, security, secondTransport);
    addTearDown(restarted.dispose);
    await restarted.initialize();

    expect(restarted.drafts[_sessionId], 'Exact restart text');
    expect(restarted.simplifySettingsFor(_sessionId)?.maxWords, 137);
    expect(restarted.simplifySettingsFor(_sessionId)?.guidance,
        'Keep the ordering.');
    expect(restarted.draftAttachmentsFor(_sessionId), isEmpty);

    await restarted.hydrateDraftComposition(_sessionId);
    expect(
      restarted.draftAttachmentsFor(_sessionId).map((item) => item.name),
      <String>['first.txt', 'second.png'],
    );
    expect(
      restarted.draftAttachmentsFor(_sessionId).map((item) => item.dataBase64),
      <String>['AQI=', 'AwQF'],
    );
  });

  test('mesh targets stay ordered, bounded, deduplicated, and durable',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-mesh-draft-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final first =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    await first.initialize();
    first.setDraft(_sessionId, 'Durable mesh prompt');
    first.setDraftDelegationSelections(
      _sessionId,
      const <DelegationSelection>[
        DelegationSelection(
          providerId: 'fake',
          modelId: 'fake-model',
          reasoningEffort: 'high',
        ),
        DelegationSelection(providerId: 'codex', modelId: 'gpt-5.6-sol'),
        DelegationSelection(providerId: 'FAKE', modelId: 'duplicate'),
        DelegationSelection(providerId: 'grok', reasoningEffort: 'low'),
        DelegationSelection(providerId: 'direct', modelId: 'openai/gpt'),
        DelegationSelection(providerId: 'extra', modelId: 'ignored'),
      ],
    );
    expect(
      first
          .draftDelegationSelectionsFor(_sessionId)
          .map((selection) => selection.providerId),
      <String>['fake', 'codex', 'grok', 'direct'],
    );
    await first.flushDraftJournal();
    first.dispose();

    final restarted =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    addTearDown(restarted.dispose);
    await restarted.initialize();

    final restored = restarted.draftDelegationSelectionsFor(_sessionId);
    expect(restored.map((selection) => selection.providerId),
        <String>['fake', 'codex', 'grok', 'direct']);
    expect(restored.first.modelId, 'fake-model');
    expect(restored.first.reasoningEffort, 'high');
    expect(restored[1].modelId, 'gpt-5.6-sol');
    expect(restored[2].reasoningEffort, 'low');
    expect(restored[3].modelId, 'openai/gpt');
  });

  test('removing one computer tombstones only its drafts and retries cleanup',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    await security.saveHost(_otherHost);
    await security.saveLastActiveHostId(_host.hostId);
    final root = await Directory.systemTemp.createTemp('store-remove-host-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final journal = _FlakyDraftJournal(root);
    await journal.save(DraftJournalWrite(
      hostId: _host.hostId,
      sessionId: 'host-a-private',
      revision: 1,
      text: 'remove me',
    ));
    await journal.save(DraftJournalWrite(
      hostId: _otherHost.hostId,
      sessionId: 'host-b-private',
      revision: 1,
      text: 'keep me',
    ));
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => journal,
      transportFactory: (endpoint, _) => _FakeTransport(
        security: security,
        host: endpoint.hostId == _otherHost.hostId ? _otherHost : _host,
      ),
    );
    addTearDown(store.dispose);
    await store.initialize();
    journal.deleteHostFailuresRemaining = 1;

    await store.removeHost(_host.hostId);

    expect((await security.readHosts()).map((host) => host.hostId),
        <String>[_otherHost.hostId]);
    expect(await security.readLastActiveHostId(), isNull);
    expect(await journal.readHost(_host.hostId), isEmpty);
    expect((await journal.read(_otherHost.hostId, 'host-b-private'))!.text,
        'keep me');
    expect(store.hasPendingDraftJournalWrites, isTrue);

    await store.retryDraftJournalWrites();

    expect(store.hasPendingDraftJournalWrites, isFalse);
    expect(await journal.readHost(_host.hostId), isEmpty);
    expect((await journal.read(_otherHost.hostId, 'host-b-private'))!.text,
        'keep me');
  });

  test('retained dictation survives process death without auto-submit intent',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-dictation-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final first =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    await first.initialize();
    await first.retainDictation(
      _sessionId,
      const <int>[82, 73, 70, 70, 1, 2, 3, 4],
      sourceId: 'openai-stt',
      directAudio: false,
    );
    first.dispose();

    final restarted =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    addTearDown(restarted.dispose);
    await restarted.initialize();
    expect(restarted.retainedDictationFor(_sessionId), isNull);

    await restarted.hydrateDraftComposition(_sessionId);
    final retained = restarted.retainedDictationFor(_sessionId)!;
    expect(retained.bytes, <int>[82, 73, 70, 70, 1, 2, 3, 4]);
    expect(retained.sourceId, 'openai-stt');
    expect(retained.directAudio, isFalse);
  });

  test('failed retained-audio journal clear stays hidden and retries durably',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-clear-retry-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final journal = _FlakyDraftJournal(root);
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => journal,
      transportFactory: (_, __) => _FakeTransport(security: security),
    );
    addTearDown(store.dispose);
    await store.initialize();
    await store.retainDictation(
      _sessionId,
      const <int>[82, 73, 70, 70, 9, 8, 7, 6],
      sourceId: 'openai-stt',
    );

    journal.saveFailuresRemaining = 1;
    await expectLater(
      store.clearRetainedDictation(_sessionId),
      throwsStateError,
    );

    expect(store.retainedDictationFor(_sessionId), isNull);
    expect(store.hasPendingDraftJournalWrites, isTrue);
    expect(
      (await journal.read(_host.hostId, _sessionId))!.retainedDictations,
      isNotEmpty,
    );

    await store.retryDraftJournalWrites();

    expect(store.hasPendingDraftJournalWrites, isFalse);
    expect(await journal.read(_host.hostId, _sessionId), isNull);
  });

  test('one corrupt draft blob preserves text and every healthy attachment',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-corrupt-blob-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final first =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    await first.initialize();
    first.setDraft(_sessionId, 'Text must survive');
    first.setDraftAttachments(_sessionId, const <RemoteAttachment>[
      RemoteAttachment(
          name: 'broken.bin',
          mimeType: 'application/octet-stream',
          dataBase64: 'AQID',
          byteLength: 3),
      RemoteAttachment(
          name: 'healthy.bin',
          mimeType: 'application/octet-stream',
          dataBase64: 'BAUG',
          byteLength: 3),
    ]);
    await first.flushDraftJournal();
    final journal = _testDraftJournal(root);
    final entry = await journal.read(_host.hostId, _sessionId);
    final corruptBlob = File(
        '${root.path}${Platform.pathSeparator}blobs${Platform.pathSeparator}blob-${entry!.attachments.first.blobId}.gcm');
    await corruptBlob.writeAsBytes(const <int>[1, 2, 3], flush: true);
    first.dispose();

    final restarted =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    addTearDown(restarted.dispose);
    await restarted.initialize();
    expect(restarted.drafts[_sessionId], 'Text must survive');
    await restarted.hydrateDraftComposition(_sessionId);
    expect(
      restarted.draftAttachmentsFor(_sessionId).map((item) => item.name),
      <String>['healthy.bin'],
    );
    await restarted.flushDraftJournal();
  });

  test('ack deletes only an unchanged durable draft and preserves newer typing',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-ack-revision-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final transport = _FakeTransport(security: security);
    final store = _journalBackedStore(root, security, transport);
    await store.initialize();
    store.setDraft(_sessionId, 'Acknowledged unchanged');
    await store.sendMessage(_sessionId, 'Acknowledged unchanged');
    expect(
        await _testDraftJournal(root).read(_host.hostId, _sessionId), isNull);

    transport.sendGate = Completer<void>();
    store.setDraft(_sessionId, 'Submitted revision');
    final pending = store.sendMessage(_sessionId, 'Submitted revision');
    await _waitFor(() => transport.sendCalls >= 2);
    store.setDraft(_sessionId, 'Typed while sending');
    await store.flushDraftJournal();
    transport.sendGate!.complete();
    await pending;
    store.dispose();

    final restarted =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    addTearDown(restarted.dispose);
    await restarted.initialize();
    expect(restarted.drafts[_sessionId], 'Typed while sending');
  });

  test('direct-send acknowledgement survives a local delete failure',
      () => _expectPostAckDeleteFailureIsLocal('send'));

  test('queue acknowledgement survives a local delete failure',
      () => _expectPostAckDeleteFailureIsLocal('queue'));

  test('mesh acknowledgement survives a local delete failure',
      () => _expectPostAckDeleteFailureIsLocal('mesh'));

  test('failed send remains recoverable after a full store restart', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-failed-send-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final transport = _FakeTransport(security: security)..failSend = true;
    final first = _journalBackedStore(root, security, transport);
    await first.initialize();
    first.setDraft(_sessionId, 'Retry after restart');
    await expectLater(
      first.sendMessage(_sessionId, 'Retry after restart'),
      throwsStateError,
    );
    await first.flushDraftJournal();
    first.dispose();

    final restarted =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    addTearDown(restarted.dispose);
    await restarted.initialize();
    expect(restarted.drafts[_sessionId], 'Retry after restart');
  });

  test('same-size replacement bytes never reuse an older encrypted blob',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-replaced-bytes-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final first =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    await first.initialize();
    first.setDraftAttachments(_sessionId, const <RemoteAttachment>[
      RemoteAttachment(
        name: 'same-name.bin',
        mimeType: 'application/octet-stream',
        dataBase64: 'AQID',
        byteLength: 3,
        origin: 'file-picker',
      ),
    ]);
    await first.retainDictation(
      _sessionId,
      const <int>[10, 11, 12],
      sourceId: 'openai-stt',
    );
    first.setDraftAttachments(_sessionId, const <RemoteAttachment>[
      RemoteAttachment(
        name: 'same-name.bin',
        mimeType: 'application/octet-stream',
        dataBase64: 'BAUG',
        byteLength: 3,
        origin: 'file-picker',
      ),
    ]);
    await first.retainDictation(
      _sessionId,
      const <int>[20, 21, 22],
      sourceId: 'openai-stt',
    );
    first.dispose();

    final restarted =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    addTearDown(restarted.dispose);
    await restarted.initialize();
    await restarted.hydrateDraftComposition(_sessionId);
    expect(restarted.draftAttachmentsFor(_sessionId).single.dataBase64, 'BAUG');
    expect(
        restarted.retainedDictationFor(_sessionId)!.bytes, <int>[20, 21, 22]);
  });

  test('host switch flushes A and rejects stale A mutations under host B',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final hostB = _otherHost;
    final root = await Directory.systemTemp.createTemp('store-host-switch-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => _testDraftJournal(root),
      transportFactory: (endpoint, _) => _FakeTransport(
        security: security,
        host: endpoint.hostId == hostB.hostId ? hostB : _host,
      ),
    );
    await store.connectHost(_host);
    final preparedA = store.prepareSession('fake');
    store.setDraft(preparedA.id, 'Host A draft');

    await store.connectHost(hostB);
    final preparedB = store.prepareSession('fake');
    store.setDraft(preparedB.id, 'Host B draft');
    store.setDraft(preparedA.id, 'Stale Host A callback');
    await store.flushDraftJournal();
    store.dispose();

    final journal = _testDraftJournal(root);
    final hostAEntries = await journal.readHost(_host.hostId);
    final hostBEntries = await journal.readHost(hostB.hostId);
    expect(hostAEntries.single.text, 'Host A draft');
    expect(hostBEntries.single.text, 'Host B draft');
  });

  test('colliding task IDs never merge host A caches into host B', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final first = _FakeTransport(security: security, host: _host)
      ..refreshResponseSessions = <Object?>[
        <String, Object?>{
          ..._sessionJson('idle', DateTime.utc(2026, 8, 20, 10)),
          'title': 'Host A task',
          'project': 'Host A project',
          'preview': 'Host A artifact preview',
        },
      ];
    final second = _FakeTransport(security: security, host: _otherHost)
      ..refreshResponseSessions = <Object?>[
        <String, Object?>{
          ..._sessionJson('completed', DateTime.utc(2026, 8, 20, 11)),
          'hostId': _otherHost.hostId,
          'title': 'Host B task',
        },
      ];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);

    await store.connectHost(_host);
    store.messages[_sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'host-a-artifact',
        sessionId: _sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 20, 10, 1),
        parts: const <ContentPart>[
          ContentPart(
            type: 'artifact',
            data: <String, Object?>{'text': 'Host A only'},
          ),
        ],
        status: 'completed',
      ),
    ];
    store.events[_sessionId] = <AgentEvent>[_event('message.delta', 1)];
    store.handoffSummaries[_sessionId] = 'Host A summary';
    store.turnOffQueueingFor(_sessionId);
    store.setVisibleSession(_sessionId);

    await store.connectHost(_otherHost);

    final current = store.sessions.singleWhere(
      (session) => session.id == _sessionId,
    );
    expect(current.hostId, _otherHost.hostId);
    expect(current.title, 'Host B task');
    expect(current.project, isNull);
    expect(current.preview, isNull);
    expect(store.messages[_sessionId], isNull);
    expect(store.events[_sessionId], isNull);
    expect(store.handoffSummaries[_sessionId], isNull);
    expect(store.isQueueingEnabledFor(_sessionId), isTrue);
    expect(store.visibleSessionIdForTesting, isNull);

    store.applyEventForTesting(_eventWithPayload(
      'session.status_changed',
      1,
      const <String, Object?>{'state': 'working'},
    ));
    expect(
      store.sessions.singleWhere((session) => session.id == _sessionId).state,
      'working',
    );
  });

  test('prepared task metadata and durable move recover across restart',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-prepared-move-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final transport = _FakeTransport(security: security)..failQueue = true;
    final first = _journalBackedStore(root, security, transport);
    await first.initialize();
    final prepared = first.prepareSession('fake');
    first.updatePreparedDirectory(prepared.id, r'C:\prepared-work');
    first.updatePreparedModelSelection(
      prepared.id,
      modelId: 'fake-model',
      reasoningEffort: 'high',
    );
    first.setDraft(prepared.id, 'Create then retry');
    await first.flushDraftJournal();

    final beforeMove =
        await _testDraftJournal(root).read(_host.hostId, prepared.id);
    expect(beforeMove!.preparedTask!.workingDirectory, r'C:\prepared-work');
    expect(beforeMove.preparedTask!.modelId, 'fake-model');
    expect(beforeMove.preparedTask!.reasoningEffort, 'high');

    final createdId = await first.submitMessage(
      prepared.id,
      'Create then retry',
      modelId: 'fake-model',
      reasoningEffort: 'high',
    );
    await first.flushDraftJournal();
    first.dispose();

    final journal = _testDraftJournal(root);
    expect(await journal.read(_host.hostId, prepared.id), isNull);
    expect((await journal.read(_host.hostId, createdId!))?.text,
        'Create then retry');

    final restarted =
        _journalBackedStore(root, security, _FakeTransport(security: security));
    addTearDown(restarted.dispose);
    await restarted.initialize();
    expect(restarted.drafts[createdId], 'Create then retry');
  });

  test('latest concurrent computer connection remains authoritative', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final firstGate = Completer<void>();
    addTearDown(() {
      if (!firstGate.isCompleted) firstGate.complete();
    });
    final first = _FakeTransport(security: security, host: _host)
      ..connectGate = firstGate;
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);

    final olderConnect = store.connectHost(_host);
    await _waitFor(() => first.connectCalls == 1);
    await store.connectHost(_otherHost);
    expect(store.activeHost?.hostId, _otherHost.hostId);

    firstGate.complete();
    await olderConnect;
    expect(store.activeHost?.hostId, _otherHost.hostId);
    expect(store.error, isNull);

    final firstRefreshCalls = first.refreshCalls;
    final secondRefreshCalls = second.refreshCalls;
    await store.refresh();
    expect(first.refreshCalls, firstRefreshCalls);
    expect(second.refreshCalls, secondRefreshCalls + 1);
  });

  test('stale last-active write cannot overwrite the newer computer', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = _DelayedLastActiveSecurity();
    addTearDown(security.releaseHostA);
    await security.saveHost(_host);
    await security.saveHost(_otherHost);
    final first = _FakeTransport(security: security, host: _host);
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);

    final stale = store.connectHost(_host);
    await security.hostAWriteStarted.future;
    final latest = store.connectHost(_otherHost);
    await _waitFor(() => store.activeHost?.hostId == _otherHost.hostId);
    security.releaseHostA();
    await Future.wait<void>(<Future<void>>[stale, latest]);

    expect(store.activeHost?.hostId, _otherHost.hostId);
    expect(await security.readLastActiveHostId(), _otherHost.hostId);
    expect(first.connectCalls, 0);
    expect(second.connectCalls, 1);
  });

  test('delayed A journal and read-state commits cannot overwrite B', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final root = await Directory.systemTemp.createTemp('store-connect-commit-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final journal = _HostGatedDraftJournal(root);
    addTearDown(journal.releaseHostA);
    await journal.save(DraftJournalWrite(
      hostId: _host.hostId,
      sessionId: 'host-a-draft',
      revision: 1,
      text: 'Host A draft',
    ));
    await journal.save(DraftJournalWrite(
      hostId: _otherHost.hostId,
      sessionId: 'host-b-draft',
      revision: 2,
      text: 'Host B draft',
    ));
    final security = _HostGatedReadStateSecurity();
    addTearDown(security.releaseHostA);
    final first = _FakeTransport(security: security, host: _host)
      ..refreshResponseSessions = <Object?>[
        _sessionJsonForHost(_host.hostId, 'host-a-session'),
      ];
    final second = _FakeTransport(security: security, host: _otherHost)
      ..refreshResponseSessions = <Object?>[
        _sessionJsonForHost(_otherHost.hostId, 'host-b-session'),
      ];
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => journal,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);

    void expectOnlyHostBState() {
      expect(store.activeHost?.hostId, _otherHost.hostId);
      expect(store.drafts['host-a-draft'], isNull);
      expect(store.drafts['host-b-draft'], 'Host B draft');
      expect(store.unreadSessionIds, <String>{'host-b-unread'});
      expect(store.sessions.map((session) => session.id), <String>[
        'host-b-session',
      ]);
      expect(
        store.sessions.every((session) => session.hostId == _otherHost.hostId),
        isTrue,
      );
    }

    final delayedJournalConnect = store.connectHost(_host);
    await _waitFor(() => journal.hostAReadCalls == 1);
    await store.connectHost(_otherHost);
    journal.releaseHostA();
    await delayedJournalConnect;
    expectOnlyHostBState();

    security.delayHostA = true;
    final delayedReadStateConnect = store.connectHost(_host);
    await _waitFor(() => security.hostAReadCalls == 1);
    await store.connectHost(_otherHost);
    security.releaseHostA();
    await delayedReadStateConnect;
    expectOnlyHostBState();
  });

  test('computer switch during upload cannot send an old upload on the new one',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final uploadGate = Completer<void>();
    addTearDown(() {
      if (!uploadGate.isCompleted) uploadGate.complete();
    });
    final first = _FakeTransport(security: security, host: _host)
      ..attachmentUploadBeginGate = uploadGate
      ..gateAttachmentUploadBeginCall = 1;
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    const attachment = RemoteAttachment(
      name: 'host-a.png',
      mimeType: 'image/png',
      dataBase64: 'AQID',
      byteLength: 3,
    );
    final pending = store.sendMessage(
      _sessionId,
      'Do not cross computers',
      attachments: const <RemoteAttachment>[attachment],
    );
    final failure = expectLater(pending, throwsStateError);
    await _waitFor(() => first.attachmentUploadCount == 1);

    await store.connectHost(_otherHost);
    uploadGate.complete();
    await failure;
    await _waitFor(() => first.cancelledUploadIds.contains('upload-1'));

    expect(first.sendCalls, 0);
    expect(second.attachmentUploadCount, 0);
    expect(second.sendCalls, 0);
  });

  test('EARS cancellation remains bound to its originating computer', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final earsGate = Completer<void>();
    addTearDown(() {
      if (!earsGate.isCompleted) earsGate.complete();
    });
    final first = _FakeTransport(security: security, host: _host)
      ..earsGate = earsGate;
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'gpt-5.6-sol',
      mode: 'cleaned',
    ));
    const clip = RemoteAttachment(
      name: 'dictation.wav',
      mimeType: 'audio/wav',
      origin: 'dictation',
      dataBase64: 'AQID',
      byteLength: 3,
    );

    final pending = store.sendMessage(
      _sessionId,
      'Keep this on A',
      attachments: const <RemoteAttachment>[clip],
    );
    final failure = expectLater(pending, throwsStateError);
    await _waitFor(() => first.lastEarsPayload != null);

    await store.connectHost(_otherHost);
    await store.cancelEars(_sessionId);
    await failure;

    expect(first.lastEarsCancelPayload?['requestId'], isNotNull);
    expect(second.lastEarsCancelPayload, isNull);
    expect(second.sendCalls, 0);
  });

  test('a retained recording cannot transcribe through a different computer',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final first = _FakeTransport(security: security, host: _host);
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    await store.retainDictation(
      _sessionId,
      const <int>[1, 2, 3],
      sourceId: 'openai-stt',
    );

    await store.connectHost(_otherHost);
    await expectLater(
      store.transcribeDictation(
        const <int>[1, 2, 3],
        sessionId: _sessionId,
        sourceId: 'openai-stt',
      ),
      throwsStateError,
    );

    expect(second.attachmentUploadCount, 0);
    expect(second.lastDictationPayload, isNull);
  });

  test('prepared creation cannot move or deliver through a newly selected host',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final root = await Directory.systemTemp.createTemp('store-create-switch-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final createGate = Completer<void>();
    addTearDown(() {
      if (!createGate.isCompleted) createGate.complete();
    });
    final first = _FakeTransport(security: security, host: _host)
      ..createGate = createGate;
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => _testDraftJournal(root),
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final prepared = store.prepareSession('fake');
    store.setDraft(prepared.id, 'Create only on A');
    await store.flushDraftJournal();

    final pending = store.submitMessage(prepared.id, 'Create only on A');
    await _waitFor(() => first.createCalls == 1);

    await store.connectHost(_otherHost);
    createGate.complete();
    expect(await pending, isNull);

    expect(first.createCalls, 1);
    expect(first.lastQueuePayload, isNull);
    expect(second.createCalls, 0);
    expect(second.lastQueuePayload, isNull);
    expect(second.sendCalls, 0);
    expect(
      await _testDraftJournal(root).read(_host.hostId, prepared.id),
      isNull,
    );
  });

  test(
      'accepted missing or malformed queue details reconcile without resubmission',
      () async {
    for (final responseKind in <String>['missing', 'malformed']) {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final security = DeviceSecurity();
      await security.saveHost(_host);
      final root = await Directory.systemTemp
          .createTemp('store-queue-$responseKind-ack-');
      final transport = _FakeTransport(security: security)
        ..missingQueueAcknowledgement = responseKind == 'missing'
        ..malformedQueueAcknowledgement = responseKind == 'malformed';
      final store = _journalBackedStore(root, security, transport);
      try {
        await store.initialize();
        final queueListCallsBefore = transport.queueListCalls;
        transport.queueSnapshot = <Object?>[
          _queuedJson('reconciled-$responseKind'),
        ];
        store.setDraft(_sessionId, 'Queue exactly once');
        await store.flushDraftJournal();

        expect(
          await store.submitMessage(_sessionId, 'Queue exactly once'),
          isNull,
        );

        expect(transport.queueEnqueueCalls, 1, reason: responseKind);
        expect(transport.queueListCalls, queueListCallsBefore + 1,
            reason: responseKind);
        expect(store.queuedMessages, contains('reconciled-$responseKind'),
            reason: responseKind);
        expect(store.drafts[_sessionId], isEmpty, reason: responseKind);
        expect(
          await _testDraftJournal(root).read(_host.hostId, _sessionId),
          isNull,
          reason: responseKind,
        );
      } finally {
        await _disposeJournalStoreAndDeleteTemp(store, root);
      }
    }
  });

  test('malformed prepared-task acknowledgement is consumed only once',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root =
        await Directory.systemTemp.createTemp('store-malformed-create-');
    final transport = _FakeTransport(security: security)
      ..malformedCreateAcknowledgement = true;
    final store = _journalBackedStore(root, security, transport);
    addTearDown(() => _disposeJournalStoreAndDeleteTemp(store, root));
    await store.initialize();
    final prepared = store.prepareSession('fake');
    const content = 'Create this exactly once';
    store.setDraft(prepared.id, content);
    await store.flushDraftJournal();
    final refreshCallsBefore = transport.refreshCalls;

    expect(await store.submitMessage(prepared.id, content), isNull);

    expect(transport.createCalls, 1);
    expect(store.drafts[prepared.id], isEmpty);
    expect(
      await _testDraftJournal(root).read(_host.hostId, prepared.id),
      isNull,
    );
    await _waitFor(() => transport.refreshCalls > refreshCallsBefore);

    await expectLater(
      store.submitMessage(prepared.id, content),
      throwsA(
        isA<StateError>().having(
          (failure) => failure.toString(),
          'message',
          contains('already created'),
        ),
      ),
    );
    expect(transport.createCalls, 1);
  });

  test('malformed prepared-task acknowledgement remains consumed after restart',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp
        .createTemp('store-malformed-create-restart-');
    final firstTransport = _FakeTransport(security: security)
      ..malformedCreateAcknowledgement = true;
    final first = _journalBackedStore(root, security, firstTransport);
    RemoteAppStore? second;
    var firstDisposed = false;
    addTearDown(() async {
      final restarted = second;
      if (restarted != null) {
        await _disposeJournalStoreAndDeleteTemp(restarted, root);
      } else if (!firstDisposed) {
        await _disposeJournalStoreAndDeleteTemp(first, root);
      } else if (await root.exists()) {
        await root.delete(recursive: true);
      }
    });
    await first.initialize();
    final prepared = first.prepareSession('fake');
    const content = 'Create this exactly once across restart';
    first.setDraft(prepared.id, content);
    await first.flushDraftJournal();
    final refreshCallsBefore = firstTransport.refreshCalls;

    expect(await first.submitMessage(prepared.id, content), isNull);
    expect(firstTransport.createCalls, 1);
    await _waitFor(() => firstTransport.refreshCalls > refreshCallsBefore);
    await first.flushDraftJournal(runMaintenance: false);
    first.dispose();
    firstDisposed = true;

    final secondTransport = _FakeTransport(security: security);
    second = _journalBackedStore(root, security, secondTransport);
    await second.initialize();
    const replacement = 'Do not create a duplicate task';
    second.setDraft(prepared.id, replacement);
    Object? failure;
    try {
      await second.submitMessage(prepared.id, replacement);
    } catch (caught) {
      failure = caught;
    }

    expect(secondTransport.createCalls, 0);
    expect(
      failure,
      isA<StateError>().having(
        (value) => value.toString(),
        'message',
        contains('already created'),
      ),
    );
  });

  test('malformed delegation acknowledgement consumes the durable draft',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-malformed-mesh-');
    final transport = _FakeTransport(security: security)
      ..malformedDelegationAcknowledgement = true
      ..delegationSnapshot = <Object?>[_delegationJson('reconciled-mesh')];
    final store = _journalBackedStore(root, security, transport);
    addTearDown(() => _disposeJournalStoreAndDeleteTemp(store, root));
    await store.initialize();
    const content = '\uFFFCDelegate this exactly once';
    store.setDraft(_sessionId, content);
    store.setDraftDelegationSelections(
      _sessionId,
      const <DelegationSelection>[
        DelegationSelection(providerId: 'fake'),
      ],
    );
    await store.flushDraftJournal();

    final task = await store.startDelegation(
      _sessionId,
      content,
      const <DelegationSelection>[
        DelegationSelection(providerId: 'fake'),
      ],
    );

    expect(task, isNull);
    expect(transport.delegationStartCalls, 1);
    expect(store.drafts[_sessionId], isEmpty);
    expect(store.draftDelegationSelectionsFor(_sessionId), isEmpty);
    expect(
        await _testDraftJournal(root).read(_host.hostId, _sessionId), isNull);
    await _waitFor(
      () => store.delegations.containsKey('reconciled-mesh'),
    );
  });

  test('malformed queued-task acknowledgement reconciles without a retry',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..queueSnapshot = <Object?>[_queuedJson('move-malformed')];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    final message = store.queuedMessages['move-malformed']!;
    transport
      ..malformedQueueMoveAcknowledgement = true
      ..queueSnapshot = <Object?>[]
      ..refreshResponseSessions = <Object?>[
        _sessionJson('completed', DateTime.utc(2026, 8, 10, 10)),
        <String, Object?>{
          ..._sessionJson('working', DateTime.utc(2026, 8, 16, 12)),
          'id': 'reconciled-queue-task',
          'providerSessionId': 'reconciled-queue-task',
          'title': 'Moved queued instruction',
          'modelId': 'fake-model',
        },
      ];

    final created = await store.moveQueuedMessageToNewTask(
      message,
      providerId: 'fake',
      modelId: 'fake-model',
    );

    expect(created.id, 'reconciled-queue-task');
    expect(store.queuedMessages, isEmpty);
    expect(transport.queueMoveCalls, 1);
    await expectLater(
      store.moveQueuedMessageToNewTask(
        message,
        providerId: 'fake',
        modelId: 'fake-model',
      ),
      throwsStateError,
    );
    expect(transport.queueMoveCalls, 1);
  });

  test('malformed side-chat create acknowledgement adopts the remote chat once',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    transport
      ..malformedSideChatCreateAcknowledgement = true
      ..sideChatSnapshot = <Object?>[
        <String, Object?>{
          ..._sideChatJson('reconciled-side-chat'),
          'parentSessionId': _sessionId,
        },
      ];

    final created = await store.createSideChat(
      _sessionId,
      prompt: 'Inspect this once',
    );

    expect(created.id, 'reconciled-side-chat');
    expect(store.sideChatsFor(_sessionId).map((session) => session.id),
        contains('reconciled-side-chat'));
    expect(transport.sideChatCreateCalls, 1);
  });

  test('malformed side-chat promotion adopts the authoritative task once',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final transport = _FakeTransport(security: security)
      ..sideChatSnapshot = <Object?>[_sideChatJson('promote-malformed')];
    final store = RemoteAppStore(
      security: security,
      transportFactory: (_, __) => transport,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    transport
      ..malformedSideChatPromoteAcknowledgement = true
      ..sideChatSnapshot = <Object?>[]
      ..refreshResponseSessions = <Object?>[
        _sessionJson('completed', DateTime.utc(2026, 8, 10, 10)),
        <String, Object?>{
          ..._sessionJson('idle', DateTime.utc(2026, 8, 16, 13)),
          'id': 'promote-malformed',
          'providerSessionId': 'promoted-side-chat',
          'title': 'Promoted side chat',
          'sessionKind': 'task',
        },
      ];

    final promoted = await store.promoteSideChat('promote-malformed');

    expect(promoted.sessionKind, 'task');
    expect(store.sideChatsFor(_sessionId), isEmpty);
    expect(transport.sideChatPromoteCalls, 1);
  });

  test('malformed handoff and branch acknowledgements adopt each task once',
      () async {
    for (final action in <String>['handoff', 'branch']) {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final security = DeviceSecurity();
      final transport = _FakeTransport(security: security);
      final store = RemoteAppStore(
        security: security,
        transportFactory: (_, __) => transport,
      );
      try {
        await store.connectHost(_host);
        final relationshipKind = action == 'handoff' ? 'handoff' : 'branch';
        transport
          ..malformedContextHandoffAcknowledgement = action == 'handoff'
          ..malformedBranchAcknowledgement = action == 'branch'
          ..refreshResponseSessions = <Object?>[
            _sessionJson('completed', DateTime.utc(2026, 8, 10, 10)),
            <String, Object?>{
              ..._sessionJson('idle', DateTime.utc(2026, 8, 16, 14)),
              'id': 'reconciled-$action',
              'providerSessionId': 'reconciled-$action',
              'title': 'Reconciled $action',
              if (action == 'handoff')
                'contextHandoffSummary': 'Authoritative summary',
              'relationship': <String, Object?>{
                'kind': relationshipKind,
                'sourceSessionId': _sessionId,
                'strategy': action == 'handoff'
                    ? 'summary_bootstrap'
                    : 'transcript_bootstrap',
              },
            },
          ];

        final created = action == 'handoff'
            ? (await store.contextHandoff(_sessionId, prompt: 'Continue once'))
                .session
            : (await store.branchSession(_sessionId, prompt: 'Continue once'))
                .session;

        expect(created.id, 'reconciled-$action', reason: action);
        expect(
          action == 'handoff'
              ? transport.contextHandoffCalls
              : transport.branchCalls,
          1,
          reason: action,
        );
      } finally {
        store.dispose();
      }
    }
  });

  test(
      'unresolved acknowledged mutations stay consumed across a same-host reconnect',
      () async {
    for (final action in <String>[
      'side-create',
      'promote',
      'handoff',
      'branch'
    ]) {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final security = DeviceSecurity();
      final transport = _FakeTransport(security: security);
      if (action == 'promote') {
        transport.sideChatSnapshot = <Object?>[
          _sideChatJson('unresolved-promotion'),
        ];
      }
      final store = RemoteAppStore(
        security: security,
        transportFactory: (_, __) => transport,
      );
      try {
        await store.connectHost(_host);
        switch (action) {
          case 'side-create':
            transport.malformedSideChatCreateAcknowledgement = true;
            break;
          case 'promote':
            transport.malformedSideChatPromoteAcknowledgement = true;
            break;
          case 'handoff':
            transport.malformedContextHandoffAcknowledgement = true;
            break;
          case 'branch':
            transport.malformedBranchAcknowledgement = true;
            break;
        }

        Future<Object?> invoke() => switch (action) {
              'side-create' => store.createSideChat(
                  _sessionId,
                  prompt: 'Accepted once',
                ),
              'promote' => store.promoteSideChat('unresolved-promotion'),
              'handoff' => store.contextHandoff(
                  _sessionId,
                  prompt: 'Accepted once',
                ),
              'branch' => store.branchSession(
                  _sessionId,
                  prompt: 'Accepted once',
                ),
              _ => throw StateError('Unexpected acknowledged action: $action'),
            };
        int bridgeCalls() => switch (action) {
              'side-create' => transport.sideChatCreateCalls,
              'promote' => transport.sideChatPromoteCalls,
              'handoff' => transport.contextHandoffCalls,
              'branch' => transport.branchCalls,
              _ => -1,
            };

        await expectLater(
          invoke(),
          throwsA(
            isA<Object>().having(
              (error) => error.toString(),
              'message',
              contains('being refreshed'),
            ),
          ),
          reason: action,
        );
        expect(bridgeCalls(), 1, reason: action);

        // Reconnecting can refresh an eventually-consistent projection, but it
        // is not proof that the accepted mutation vanished. Keep its local
        // consumption barrier instead of issuing the destructive create again.
        await store.connectHost(_host);
        await expectLater(invoke(), throwsStateError, reason: action);
        expect(bridgeCalls(), 1, reason: action);
      } finally {
        store.dispose();
      }
    }
  });

  test('listener failures cannot turn accepted session mutations into retries',
      () async {
    for (final action in <String>[
      'side-create',
      'promote',
      'handoff',
      'branch'
    ]) {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final security = DeviceSecurity();
      final transport = _FakeTransport(security: security);
      if (action == 'promote') {
        transport.sideChatSnapshot = <Object?>[
          _sideChatJson('listener-promotion'),
        ];
      }
      final store = _ThrowingNotifyStore(
        security: security,
        transportFactory: (_, __) => transport,
      );
      try {
        await store.connectHost(_host);
        store.throwNotifications = true;
        final created = switch (action) {
          'side-create' => await store.createSideChat(
              _sessionId,
              prompt: 'Project despite listener failure',
            ),
          'promote' => await store.promoteSideChat('listener-promotion'),
          'handoff' => (await store.contextHandoff(
              _sessionId,
              prompt: 'Project despite listener failure',
            ))
                .session,
          'branch' => (await store.branchSession(
              _sessionId,
              prompt: 'Project despite listener failure',
            ))
                .session,
          _ => throw StateError('Unexpected acknowledged action: $action'),
        };
        store.throwNotifications = false;

        expect(store.thrownNotifications, greaterThan(0), reason: action);
        expect(
          store.sessions.where((session) => session.id == created.id),
          hasLength(1),
          reason: action,
        );
        expect(
          switch (action) {
            'side-create' => transport.sideChatCreateCalls,
            'promote' => transport.sideChatPromoteCalls,
            'handoff' => transport.contextHandoffCalls,
            'branch' => transport.branchCalls,
            _ => -1,
          },
          1,
          reason: action,
        );
      } finally {
        store.throwNotifications = false;
        store.dispose();
      }
    }
  });

  test(
      'stale handoff and branch acknowledgements cannot project onto a new host',
      () async {
    for (final action in <String>['handoff', 'branch']) {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final security = DeviceSecurity();
      final gate = Completer<void>();
      final first = _FakeTransport(security: security, host: _host);
      if (action == 'handoff') {
        first.contextHandoffGate = gate;
      } else {
        first.branchGate = gate;
      }
      final second = _FakeTransport(security: security, host: _otherHost)
        ..refreshResponseSessions = <Object?>[
          _sessionJsonForHost(_otherHost.hostId, 'host-b-session'),
        ];
      final store = RemoteAppStore(
        security: security,
        transportFactory: (endpoint, _) =>
            endpoint.hostId == _otherHost.hostId ? second : first,
      );
      try {
        await store.connectHost(_host);
        final pending = action == 'handoff'
            ? store.contextHandoff(_sessionId, prompt: 'Only on A')
            : store.branchSession(_sessionId, prompt: 'Only on A');
        final failure = expectLater(
          pending,
          throwsStateError,
          reason: action,
        );
        await _waitFor(() => action == 'handoff'
            ? first.contextHandoffCalls == 1
            : first.branchCalls == 1);

        await store.connectHost(_otherHost);
        gate.complete();
        await failure;

        expect(store.activeHost?.hostId, _otherHost.hostId, reason: action);
        expect(
          store.sessions.every(
            (session) => session.hostId == _otherHost.hostId,
          ),
          isTrue,
          reason: action,
        );
        expect(
          action == 'handoff' ? first.contextHandoffCalls : first.branchCalls,
          1,
          reason: action,
        );
        expect(
          action == 'handoff' ? second.contextHandoffCalls : second.branchCalls,
          0,
          reason: action,
        );

        await store.connectHost(_host);
        await expectLater(
          action == 'handoff'
              ? store.contextHandoff(_sessionId, prompt: 'Only on A')
              : store.branchSession(_sessionId, prompt: 'Only on A'),
          throwsStateError,
          reason: action,
        );
        expect(
          action == 'handoff' ? first.contextHandoffCalls : first.branchCalls,
          1,
          reason: action,
        );
      } finally {
        if (!gate.isCompleted) gate.complete();
        store.dispose();
      }
    }
  });

  test('mesh acknowledgement cannot clear a newer target revision', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-mesh-revision-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final gate = Completer<void>();
    addTearDown(() {
      if (!gate.isCompleted) gate.complete();
    });
    final transport = _FakeTransport(security: security)
      ..delegationStartGate = gate;
    final store = _journalBackedStore(root, security, transport);
    addTearDown(store.dispose);
    await store.initialize();
    store.setDraft(_sessionId, '\uFFFCMesh revision prompt');
    const submitted = <DelegationSelection>[
      DelegationSelection(
        providerId: 'fake',
        modelId: 'old-model',
        reasoningEffort: 'low',
      ),
    ];
    store.setDraftDelegationSelections(_sessionId, submitted);
    await store.flushDraftJournal();

    final pending = store.startDelegation(
        _sessionId, '\uFFFCMesh revision prompt', submitted);
    await _waitFor(() => transport.lastDelegationPayload != null);
    store.setDraftDelegationSelections(
      _sessionId,
      const <DelegationSelection>[
        DelegationSelection(
          providerId: 'codex',
          modelId: 'new-model',
          reasoningEffort: 'high',
        ),
      ],
    );
    gate.complete();
    await pending;
    await store.flushDraftJournal();

    final current = store.draftDelegationSelectionsFor(_sessionId);
    expect(current.single.providerId, 'codex');
    expect(current.single.modelId, 'new-model');
    expect(current.single.reasoningEffort, 'high');
    final persisted = await _testDraftJournal(root).read(
      _host.hostId,
      _sessionId,
    );
    expect(persisted!.delegationSelections.single.providerId, 'codex');
    expect(persisted.delegationSelections.single.modelId, 'new-model');
  });

  test('listener failures after acknowledgement never restore a composition',
      () async {
    for (final mode in <String>['send', 'queue', 'steer', 'prepared', 'mesh']) {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final security = DeviceSecurity();
      await security.saveHost(_host);
      final root =
          await Directory.systemTemp.createTemp('store-$mode-ack-listener-');
      final gate = Completer<void>();
      final transport = _FakeTransport(security: security);
      switch (mode) {
        case 'send':
          transport.sendGate = gate;
          break;
        case 'queue':
          transport.queueEnqueueGate = gate;
          break;
        case 'steer':
          transport
            ..sessionState = 'working'
            ..steerGate = gate;
          break;
        case 'prepared':
          transport.createGate = gate;
          break;
        case 'mesh':
          transport.delegationStartGate = gate;
          break;
      }
      final store = _ThrowingNotifyStore(
        security: security,
        draftJournalFactory: () async => _testDraftJournal(root),
        transportFactory: (_, __) => transport,
      );
      try {
        await store.initialize();
        final sessionId =
            mode == 'prepared' ? store.prepareSession('fake').id : _sessionId;
        final content = mode == 'mesh'
            ? '\uFFFCAccepted $mode composition'
            : 'Accepted $mode composition';
        store.setDraft(sessionId, content);
        await store.flushDraftJournal();

        late final Future<Object?> pending;
        switch (mode) {
          case 'send':
            pending = store
                .sendMessage(sessionId, content)
                .then<Object?>((_) => null);
            break;
          case 'queue':
            pending = store.submitMessage(sessionId, content);
            break;
          case 'steer':
            pending = store.submitMessage(
              sessionId,
              content,
              deliveryMode: 'steer',
            );
            break;
          case 'prepared':
            pending = store.submitMessage(sessionId, content);
            break;
          case 'mesh':
            pending = store.startDelegation(
              sessionId,
              content,
              const <DelegationSelection>[
                DelegationSelection(providerId: 'fake'),
              ],
            );
            break;
          default:
            throw StateError('Unexpected acknowledgement mode: $mode');
        }
        await _waitFor(() => switch (mode) {
              'send' => transport.lastSendPayload != null,
              'queue' => transport.lastQueuePayload != null,
              'steer' => transport.lastSteerPayload != null,
              'prepared' => transport.lastCreatePayload != null,
              'mesh' => transport.lastDelegationPayload != null,
              _ => false,
            });

        store.throwNotifications = true;
        gate.complete();
        final result = await pending;
        store.throwNotifications = false;

        expect(store.drafts[sessionId], isEmpty, reason: mode);
        expect(
          await _testDraftJournal(root).read(_host.hostId, sessionId),
          isNull,
          reason: mode,
        );
        expect(store.thrownNotifications, greaterThan(0), reason: mode);
        if (mode == 'prepared') {
          expect(result, 'host/fake/created');
          expect(transport.createCalls, 1);
        } else if (mode == 'mesh') {
          expect(result, isNull);
          expect(transport.delegationStartCalls, 1);
        }
      } finally {
        if (!gate.isCompleted) gate.complete();
        store.throwNotifications = false;
        store.dispose();
        await store.flushDraftJournal(runMaintenance: false);
        if (await root.exists()) await root.delete(recursive: true);
      }
    }
  });

  test('stale queue and side-chat responses cannot mutate the new host',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final queueGate = Completer<void>();
    final sideChatGate = Completer<void>();
    final sideChatPromoteGate = Completer<void>();
    addTearDown(() {
      if (!queueGate.isCompleted) queueGate.complete();
      if (!sideChatGate.isCompleted) sideChatGate.complete();
      if (!sideChatPromoteGate.isCompleted) sideChatPromoteGate.complete();
    });
    final first = _FakeTransport(security: security, host: _host)
      ..queueEnqueueGate = queueGate
      ..sideChatCreateGate = sideChatGate
      ..sideChatPromoteGate = sideChatPromoteGate
      ..sideChatSnapshot = <Object?>[_sideChatJson('existing-side-chat')];
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);

    final queued = store.submitMessage(_sessionId, 'Queue only on A');
    await _waitFor(() => first.lastQueuePayload != null);
    final sideChat = store.createSideChat(_sessionId, prompt: 'A side chat');
    final sideChatFailure = expectLater(sideChat, throwsStateError);
    await _waitFor(() => first.lastSideChatCreatePayload != null);
    final promotion = store.promoteSideChat('existing-side-chat');
    final promotionFailure = expectLater(promotion, throwsStateError);
    await _waitFor(() => first.lastSideChatPromotePayload != null);

    await store.connectHost(_otherHost);
    queueGate.complete();
    sideChatGate.complete();
    sideChatPromoteGate.complete();
    await queued;
    await Future.wait<void>(<Future<void>>[sideChatFailure, promotionFailure]);

    expect(store.queuedMessages, isEmpty);
    expect(store.sessions.any((session) => session.id == 'created-side-chat'),
        isFalse);
    expect(
      store.sessions.any((session) => session.id == 'existing-side-chat'),
      isFalse,
    );
    expect(store.selectedSession?.id, isNot('existing-side-chat'));
    expect(second.lastQueuePayload, isNull);
    expect(second.lastSideChatCreatePayload, isNull);
    expect(second.lastSideChatPromotePayload, isNull);
  });

  test('every queued-item action rejects a response after computer switch',
      () async {
    for (final action in <String>['cancel', 'edit', 'deliver', 'move']) {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      final security = DeviceSecurity();
      final gate = Completer<void>();
      addTearDown(() {
        if (!gate.isCompleted) gate.complete();
      });
      final first = _FakeTransport(security: security, host: _host)
        ..queueSnapshot = <Object?>[_queuedJson('queued-race')];
      switch (action) {
        case 'cancel':
          first.queueCancelGate = gate;
          break;
        case 'edit':
          first.queueEditGate = gate;
          break;
        case 'deliver':
          first.queueDeliverGate = gate;
          break;
        case 'move':
          first.queueMoveGate = gate;
          break;
        default:
          throw StateError('Unexpected queue action: $action');
      }
      final second = _FakeTransport(security: security, host: _otherHost);
      final store = RemoteAppStore(
        security: security,
        transportFactory: (endpoint, _) =>
            endpoint.hostId == _otherHost.hostId ? second : first,
      );
      addTearDown(store.dispose);
      await store.connectHost(_host);
      final message = store.queuedMessages['queued-race']!;

      late final Future<void> pending;
      switch (action) {
        case 'cancel':
          pending = store.cancelQueuedMessage(message.id);
          break;
        case 'edit':
          pending = store
              .editQueuedMessage(message, 'Edited only on A')
              .then<void>((_) {});
          break;
        case 'deliver':
          pending = store.deliverQueuedMessage(message, mode: 'send');
          break;
        case 'move':
          pending = store
              .moveQueuedMessageToNewTask(
                message,
                providerId: 'fake',
                modelId: 'fake-model',
              )
              .then<void>((_) {});
          break;
        default:
          throw StateError('Unexpected queue action: $action');
      }
      final failure = expectLater(pending, throwsStateError);
      await _waitFor(() => switch (action) {
            'cancel' => first.lastQueueCancelPayload != null,
            'edit' => first.lastQueueEditPayload != null,
            'deliver' => first.lastQueueDeliverPayload != null,
            'move' => first.lastQueueNewTaskPayload != null,
            _ => false,
          });

      await store.connectHost(_otherHost);
      gate.complete();
      await failure;

      expect(store.queuedMessages, isEmpty, reason: action);
      expect(store.activeHost?.hostId, _otherHost.hostId, reason: action);
      expect(second.lastQueueCancelPayload, isNull, reason: action);
      expect(second.lastQueueEditPayload, isNull, reason: action);
      expect(second.lastQueueDeliverPayload, isNull, reason: action);
      expect(second.lastQueueNewTaskPayload, isNull, reason: action);
    }
  });

  test('stale acknowledged delegation clears its A draft without mutating B',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final root = await Directory.systemTemp.createTemp('store-mesh-switch-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    final delegationGate = Completer<void>();
    addTearDown(() {
      if (!delegationGate.isCompleted) delegationGate.complete();
    });
    final first = _FakeTransport(security: security, host: _host)
      ..delegationStartGate = delegationGate;
    final second = _FakeTransport(security: security, host: _otherHost);
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => _testDraftJournal(root),
      transportFactory: (endpoint, _) =>
          endpoint.hostId == _otherHost.hostId ? second : first,
    );
    addTearDown(store.dispose);
    await store.connectHost(_host);
    store.setDraft(_sessionId, '\uFFFCDelegate only on A');

    final pending = store.startDelegation(
      _sessionId,
      '\uFFFCDelegate only on A',
      const <DelegationSelection>[
        DelegationSelection(providerId: 'fake'),
      ],
    );
    await _waitFor(() => first.lastDelegationPayload != null);

    await store.connectHost(_otherHost);
    delegationGate.complete();
    await pending;

    final hostADraft =
        await _testDraftJournal(root).read(_host.hostId, _sessionId);
    expect(hostADraft, isNull);
    expect(store.delegations, isEmpty);
    expect(store.delegationPreferences, isEmpty);
    expect(await security.readDelegationPreferences(), isEmpty);
    expect(second.lastDelegationPayload, isNull);
  });

  test('text-only flush cannot strand concurrent lazy attachment hydration',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root = await Directory.systemTemp.createTemp('store-hydration-race-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    await _testDraftJournal(root).save(DraftJournalWrite(
      hostId: _host.hostId,
      sessionId: _sessionId,
      revision: 1,
      text: 'restored text',
      attachments: <DraftJournalBlobInput>[
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.attachment,
          name: 'lazy.png',
          mimeType: 'image/png',
          bytes: const <int>[1, 2, 3],
        ),
      ],
    ));
    final journal = _DelayedHydrationJournal(root);
    addTearDown(journal.release);
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => journal,
      transportFactory: (_, __) => _FakeTransport(security: security),
    );
    addTearDown(store.dispose);
    await store.initialize();

    final hydration = store.hydrateDraftComposition(_sessionId);
    await _waitFor(() => journal.hydrationCalls == 1);
    store.setDraft(_sessionId, 'new text while hydrating');
    await store.flushDraftJournal();
    journal.release();
    await hydration;

    expect(store.drafts[_sessionId], 'new text while hydrating');
    expect(store.draftAttachmentsHydratedFor(_sessionId), isTrue);
    expect(store.draftAttachmentsFor(_sessionId).single.dataBase64, 'AQID');
  });

  test('retained recording added during clear hydration remains durable',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    await security.saveHost(_host);
    final root =
        await Directory.systemTemp.createTemp('store-retained-clear-race-');
    addTearDown(() async {
      if (await root.exists()) await root.delete(recursive: true);
    });
    await _testDraftJournal(root).save(DraftJournalWrite(
      hostId: _host.hostId,
      sessionId: _sessionId,
      revision: 1,
      text: '',
      retainedDictations: <DraftJournalBlobInput>[
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.retainedDictation,
          name: 'dictation.wav',
          mimeType: 'audio/wav',
          bytes: const <int>[1, 2, 3],
          origin: 'recording',
          sourceId: 'openai-stt',
        ),
      ],
    ));
    final journal = _DelayedHydrationJournal(root);
    addTearDown(journal.release);
    final store = RemoteAppStore(
      security: security,
      draftJournalFactory: () async => journal,
      transportFactory: (_, __) => _FakeTransport(security: security),
    );
    addTearDown(store.dispose);
    await store.initialize();

    final clearing = store.clearRetainedDictation(_sessionId);
    await _waitFor(() => journal.hydrationCalls == 1);
    await store.retainDictation(
      _sessionId,
      const <int>[9, 8, 7, 6],
      sourceId: 'openai-stt',
    );
    journal.release();
    await clearing;

    expect(store.retainedDictationFor(_sessionId)?.bytes, <int>[9, 8, 7, 6]);
    final entry = await journal.read(_host.hostId, _sessionId);
    expect(entry?.retainedDictations, hasLength(1));
    expect(
      await journal.hydrateBlob(entry!.retainedDictations.single),
      <int>[9, 8, 7, 6],
    );
  });
}

Future<void> _expectPostAckDeleteFailureIsLocal(String mode) async {
  FlutterSecureStorage.setMockInitialValues(<String, String>{});
  final security = DeviceSecurity();
  await security.saveHost(_host);
  final root = await Directory.systemTemp.createTemp('store-$mode-ack-delete-');
  addTearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });
  final journal = _FlakyDraftJournal(root);
  final transport = _FakeTransport(security: security);
  final store = RemoteAppStore(
    security: security,
    draftJournalFactory: () async => journal,
    transportFactory: (_, __) => transport,
  );
  addTearDown(store.dispose);
  await store.initialize();
  final content = mode == 'mesh'
      ? '\uFFFCAccepted $mode instruction'
      : 'Accepted $mode instruction';
  store.setDraft(_sessionId, content);
  await store.flushDraftJournal();
  journal.deleteFailuresRemaining = 1;

  switch (mode) {
    case 'send':
      await store.sendMessage(_sessionId, content);
      expect(transport.sendCalls, 1);
      break;
    case 'queue':
      await store.submitMessage(_sessionId, content);
      expect(transport.lastQueuePayload, isNotNull);
      expect(store.queuedMessages, isNotEmpty);
      break;
    case 'mesh':
      final task = await store.startDelegation(
        _sessionId,
        content,
        const <DelegationSelection>[
          DelegationSelection(providerId: 'fake'),
        ],
      );
      expect(transport.delegationStartCalls, 1);
      expect(task, isNotNull);
      expect(store.delegations, contains(task!.id));
      break;
    default:
      throw ArgumentError.value(mode, 'mode');
  }

  expect(store.drafts[_sessionId], isEmpty);
  expect(store.hasPendingDraftJournalWrites, isTrue);

  await store.retryDraftJournalWrites();

  expect(store.hasPendingDraftJournalWrites, isFalse);
  expect(await journal.read(_host.hostId, _sessionId), isNull);
}

Future<void> _disposeJournalStoreAndDeleteTemp(
  RemoteAppStore store,
  Directory root,
) async {
  // dispose() intentionally performs its last journal flush in the
  // background. Drain the same ordered journal tail first so Windows cannot
  // observe a writer recreating files while the test removes its temp root.
  await store.flushDraftJournal(runMaintenance: false);
  store.dispose();
  if (await root.exists()) await root.delete(recursive: true);
}

DraftJournal _testDraftJournal(Directory root) => DraftJournal(
      root: root,
      keyProvider: StaticDraftJournalKeyProvider(
        List<int>.generate(32, (index) => index),
      ),
    );

class _FlakyDraftJournal extends DraftJournal {
  _FlakyDraftJournal(Directory root)
      : super(
          root: root,
          keyProvider: StaticDraftJournalKeyProvider(
            List<int>.generate(32, (index) => index),
          ),
        );

  int saveFailuresRemaining = 0;
  int deleteFailuresRemaining = 0;
  int deleteHostFailuresRemaining = 0;

  @override
  Future<DraftJournalEntry> save(DraftJournalWrite write) {
    if (saveFailuresRemaining > 0) {
      saveFailuresRemaining -= 1;
      return Future<DraftJournalEntry>.error(
        StateError('simulated draft save failure'),
      );
    }
    return super.save(write);
  }

  @override
  Future<bool> delete(
    String hostId,
    String sessionId, {
    int? expectedRevision,
  }) {
    if (deleteFailuresRemaining > 0) {
      deleteFailuresRemaining -= 1;
      return Future<bool>.error(StateError('simulated draft delete failure'));
    }
    return super.delete(
      hostId,
      sessionId,
      expectedRevision: expectedRevision,
    );
  }

  @override
  Future<void> deleteHost(String hostId) async {
    await super.deleteHost(hostId);
    if (deleteHostFailuresRemaining > 0) {
      deleteHostFailuresRemaining -= 1;
      throw StateError('simulated post-tombstone host cleanup failure');
    }
  }
}

class _DelayedHydrationJournal extends DraftJournal {
  _DelayedHydrationJournal(Directory root)
      : super(
          root: root,
          keyProvider: StaticDraftJournalKeyProvider(
            List<int>.generate(32, (index) => index),
          ),
        );

  final Completer<void> _hydrationGate = Completer<void>();
  int hydrationCalls = 0;

  @override
  Future<Uint8List?> hydrateBlob(DraftJournalBlob blob) async {
    hydrationCalls += 1;
    await _hydrationGate.future;
    return super.hydrateBlob(blob);
  }

  void release() {
    if (!_hydrationGate.isCompleted) _hydrationGate.complete();
  }
}

class _HostGatedDraftJournal extends DraftJournal {
  _HostGatedDraftJournal(Directory root)
      : super(
          root: root,
          keyProvider: StaticDraftJournalKeyProvider(
            List<int>.generate(32, (index) => index),
          ),
        );

  final Completer<void> _hostAGate = Completer<void>();
  int hostAReadCalls = 0;

  @override
  Future<List<DraftJournalEntry>> readHost(String hostId) async {
    if (hostId == _host.hostId && !_hostAGate.isCompleted) {
      hostAReadCalls += 1;
      await _hostAGate.future;
    }
    return super.readHost(hostId);
  }

  void releaseHostA() {
    if (!_hostAGate.isCompleted) _hostAGate.complete();
  }
}

class _HostGatedReadStateSecurity extends DeviceSecurity {
  final Completer<void> _hostAGate = Completer<void>();
  bool delayHostA = false;
  int hostAReadCalls = 0;

  @override
  Future<SessionReadState?> readSessionReadState(PairedHost host) async {
    if (host.hostId == _host.hostId) {
      if (delayHostA) {
        hostAReadCalls += 1;
        await _hostAGate.future;
      }
      return const SessionReadState(
        lastReadAt: <String, DateTime>{},
        unreadSessionIds: <String>{'host-a-unread'},
      );
    }
    return const SessionReadState(
      lastReadAt: <String, DateTime>{},
      unreadSessionIds: <String>{'host-b-unread'},
    );
  }

  void releaseHostA() {
    if (!_hostAGate.isCompleted) _hostAGate.complete();
  }
}

class _DelayedLastActiveSecurity extends DeviceSecurity {
  final Completer<void> _hostAGate = Completer<void>();
  final Completer<void> hostAWriteStarted = Completer<void>();

  @override
  Future<void> saveLastActiveHostId(String hostId) async {
    if (hostId == _host.hostId) {
      if (!hostAWriteStarted.isCompleted) hostAWriteStarted.complete();
      await _hostAGate.future;
    }
    await super.saveLastActiveHostId(hostId);
  }

  void releaseHostA() {
    if (!_hostAGate.isCompleted) _hostAGate.complete();
  }
}

class _ThrowingNotifyStore extends RemoteAppStore {
  _ThrowingNotifyStore({
    required super.security,
    required super.transportFactory,
    super.draftJournalFactory,
  });

  bool throwNotifications = false;
  int thrownNotifications = 0;

  @override
  void notifyListeners() {
    if (throwNotifications) {
      thrownNotifications += 1;
      throw StateError('simulated listener projection failure');
    }
    super.notifyListeners();
  }
}

RemoteAppStore _journalBackedStore(
  Directory root,
  DeviceSecurity security,
  _FakeTransport transport,
) =>
    RemoteAppStore(
      security: security,
      draftJournalFactory: () async => _testDraftJournal(root),
      transportFactory: (_, __) => transport,
    );

const _sessionId = 'host/fake/session-one';

final _host = PairedHost(
  hostId: 'host',
  hostPublicKeyPem: 'unused',
  endpoint: 'ws://127.0.0.1/unused',
  deviceId: 'device',
  devicePrivateKey: const <int>[1],
  devicePublicKey: const <int>[2],
  credential: const SignedCredential(payload: 'unused', signature: 'unused'),
);

final _otherHost = PairedHost(
  hostId: 'other-host',
  hostPublicKeyPem: 'unused',
  endpoint: 'ws://127.0.0.1/other',
  deviceId: 'other-device',
  devicePrivateKey: const <int>[3],
  devicePublicKey: const <int>[4],
  credential: const SignedCredential(payload: 'unused', signature: 'unused'),
);

RemoteSession _sessionForHost(String hostId, String id,
        {String? parentSessionId, SessionRelationship? relationship}) =>
    RemoteSession(
      id: id,
      hostId: hostId,
      providerId: 'fake',
      providerSessionId: id,
      title: id,
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 10, 10),
      needsApproval: false,
      stale: false,
      parentSessionId: parentSessionId,
      relationship: relationship,
    );

AgentEvent _event(String type, int sequence) => AgentEvent(
      eventId: 'event-$sequence',
      sequence: sequence,
      type: type,
      occurredAt: DateTime.utc(2026, 8, 10, 11, sequence),
      payload: const <String, Object?>{},
      sessionId: _sessionId,
      providerId: 'fake',
    );

AgentEvent _eventWithPayload(
        String type, int sequence, Map<String, Object?> payload) =>
    AgentEvent(
      eventId: 'event-$sequence',
      sequence: sequence,
      type: type,
      occurredAt: DateTime.utc(2026, 8, 10, 11, sequence),
      payload: payload,
      sessionId: _sessionId,
      providerId: 'fake',
    );

Map<String, Object?> _sessionJson(String state, DateTime activity) =>
    <String, Object?>{
      'id': _sessionId,
      'hostId': 'host',
      'providerId': 'fake',
      'providerSessionId': 'session-one',
      'title': 'Live session',
      'state': state,
      'lastActivityAt': activity.toIso8601String(),
      'needsApproval': false,
      'stale': false,
    };

Map<String, Object?> _sessionJsonForHost(String hostId, String id) =>
    <String, Object?>{
      'id': id,
      'hostId': hostId,
      'providerId': 'fake',
      'providerSessionId': id,
      'title': id,
      'state': 'idle',
      'lastActivityAt': '2026-08-10T10:00:00.000Z',
      'needsApproval': false,
      'stale': false,
    };

Map<String, Object?> _providerJson(String providerId, String displayName) =>
    <String, Object?>{
      'providerId': providerId,
      'displayName': displayName,
      'state': 'online',
      'detected': true,
      'authenticated': true,
      'capabilities': const <String, Object?>{'createSession': true},
    };

Map<String, Object?> _providerSessionJson(String providerId, String id) =>
    <String, Object?>{
      'id': 'host/$providerId/$id',
      'hostId': 'host',
      'providerId': providerId,
      'providerSessionId': id,
      'title': 'Provider session',
      'state': 'idle',
      'lastActivityAt': '2026-08-10T10:00:00.000Z',
      'needsApproval': false,
      'stale': false,
    };

Map<String, Object?> _dictationSourceJson(String id, String label) =>
    <String, Object?>{
      'id': id,
      'label': label,
      'status': 'ready',
      'setupEnvironmentVariable': 'FUTURE_STT_API_KEY',
      'capabilities': const <String, Object?>{
        'batch': true,
        'maxAudioBytes': 4 * 1024 * 1024,
      },
    };

Map<String, Object?> _queuedJson(String id) => <String, Object?>{
      'id': id,
      'sessionId': _sessionId,
      'content': 'Queued after reconnect',
      'state': 'queued',
      'createdAt': '2026-08-10T12:00:00.000Z',
      'attachments': const <Object?>[],
    };

Map<String, Object?> _sideChatJson(String id) => <String, Object?>{
      ..._sessionJson('idle', DateTime.utc(2026, 8, 15, 12)),
      'id': id,
      'providerSessionId': id,
      'title': 'Side chat prompt',
      'preview': 'Side chat prompt',
      'sessionKind': 'side_chat',
      'parentSessionId': _sessionId,
    };

Map<String, Object?> _delegationJson(String id) => <String, Object?>{
      'id': id,
      'parentSessionId': _sessionId,
      'prompt': 'Review reconnect state',
      'state': 'running',
      'createdAt': '2026-08-10T12:00:00.000Z',
      'updatedAt': '2026-08-10T12:00:00.000Z',
      'children': const <Object?>[],
    };

Map<String, Object?> _approvalJson(String id) => <String, Object?>{
      'requestId': id,
      'sessionId': _sessionId,
      'providerId': 'fake',
      'title': 'Approve reconnect action',
      'choices': const <Object?>[],
      'affectedFiles': const <Object?>[],
      'networkDestinations': const <Object?>[],
    };

Map<String, Object?> _userInputJson(String id) => <String, Object?>{
      'requestId': id,
      'sessionId': _sessionId,
      'title': 'Input needed after reconnect',
      'request': const <String, Object?>{},
    };

Map<String, Object?> _messageJson(
  String text, {
  String id = 'reconnect-message',
  String createdAt = '2026-08-10T12:00:00.000Z',
}) =>
    <String, Object?>{
      'id': id,
      'sessionId': _sessionId,
      'role': 'assistant',
      'createdAt': createdAt,
      'parts': <Object?>[
        <String, Object?>{'type': 'text', 'text': text}
      ],
      'status': 'completed',
    };

Map<String, Object?> _contextJson(String sessionId, int thresholdTokens) =>
    <String, Object?>{
      'sessionId': sessionId,
      'modelId': 'fake-model',
      'usedTokens': 42800,
      'contextWindowTokens': 128000,
      'usedPercent': 33.4375,
      'compactionThresholdTokens': thresholdTokens,
      'minimumThresholdTokens': 8000,
      'supportsManualCompaction': true,
      'supportsThreshold': true,
      'isCompacting': false,
      'updatedAt': '2026-08-14T10:00:00.000Z',
      'usage': <String, Object?>{
        'inputTokens': 39100,
        'outputTokens': 3700,
        'totalTokens': 42800,
        'cost': .42,
        'currency': 'USD',
      },
    };

Future<void> _waitFor(bool Function() condition) async {
  final deadline = DateTime.now().add(const Duration(seconds: 2));
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      throw StateError('Timed out waiting for asynchronous store state');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

class _FakeTransport extends BridgeTransport {
  _FakeTransport({
    required DeviceSecurity security,
    PairedHost? host,
    this.visionModelId = 'vision-model',
    this.modelId = 'fake-model',
  }) : super(
          endpoint: BridgeEndpoint(
            hostId: (host ?? _host).hostId,
            url: (host ?? _host).endpoint,
            deviceId: (host ?? _host).deviceId,
            pairedHost: host ?? _host,
          ),
          security: security,
        );

  bool failOpen = false;
  bool failSend = false;
  Object? sendError;
  bool failQueue = false;
  bool failDelegation = false;
  bool missingQueueAcknowledgement = false;
  bool malformedQueueAcknowledgement = false;
  bool malformedCreateAcknowledgement = false;
  bool malformedDelegationAcknowledgement = false;
  bool malformedQueueMoveAcknowledgement = false;
  bool malformedSideChatCreateAcknowledgement = false;
  bool malformedSideChatPromoteAcknowledgement = false;
  bool malformedContextHandoffAcknowledgement = false;
  bool malformedBranchAcknowledgement = false;
  bool dictationSourcesReady = true;
  Map<String, Object?>? lastSendPayload;
  Map<String, Object?>? lastCreatePayload;
  Map<String, Object?>? lastQueuePayload;
  Map<String, Object?>? lastSteerPayload;
  Map<String, Object?>? lastDictationPayload;
  Map<String, Object?>? lastDictationConfigurePayload;
  Map<String, Object?>? lastVisionConfigurePayload;
  Map<String, Object?>? lastContextThresholdPayload;
  Map<String, Object?>? lastHandoffPayload;
  Map<String, Object?>? lastBranchPayload;
  Map<String, Object?>? lastWalletGetPayload;
  Map<String, Object?>? lastWalletConfigurePayload;
  Map<String, Object?>? lastQueueEditPayload;
  Map<String, Object?>? lastQueueCancelPayload;
  Map<String, Object?>? lastQueueDeliverPayload;
  Map<String, Object?>? lastQueueNewTaskPayload;
  Map<String, Object?>? lastEarsPayload;
  Map<String, Object?>? lastEarsCancelPayload;
  Map<String, Object?>? lastDelegationPayload;
  Completer<void>? earsGate;
  bool earsCancelled = false;
  bool scopeEarsRequests = false;
  final List<Map<String, Object?>> earsPayloads = <Map<String, Object?>>[];
  final Map<String, Completer<void>> earsRequestGates =
      <String, Completer<void>>{};
  final Set<String> cancelledEarsRequestIds = <String>{};
  Map<String, Object?>? lastSideChatCreatePayload;
  Map<String, Object?>? lastSideChatPromotePayload;
  Map<String, Object?>? lastAttachmentUploadPayload;
  final List<int> uploadChunkSizes = <int>[];
  final List<String> cancelledUploadIds = <String>[];
  int attachmentUploadCount = 0;
  int sendCalls = 0;
  int connectCalls = 0;
  int closeCalls = 0;
  List<int>? retrievalImageBytes;
  final List<int> imageGetOffsets = <int>[];
  int openCalls = 0;
  int childCalls = 0;
  String? lastChildSessionParentId;
  int createCalls = 0;
  int providerCalls = 0;
  int modelCalls = 0;
  int modelFailuresRemaining = 0;
  int refreshCalls = 0;
  int contextGetCalls = 0;
  int contextThresholdCalls = 0;
  int visionStatusCalls = 0;
  int visionStatusFailuresRemaining = 0;
  int approvalListCalls = 0;
  int userInputListCalls = 0;
  int syncCalls = 0;
  int resumeCalls = 0;
  int delegationStartCalls = 0;
  int delegationPrepareCalls = 0;
  int delegationLegacyStartCalls = 0;
  int delegationListCalls = 0;
  int delegationListCompletedCalls = 0;
  int queueEnqueueCalls = 0;
  int queueMoveCalls = 0;
  int sideChatCreateCalls = 0;
  int sideChatPromoteCalls = 0;
  int contextHandoffCalls = 0;
  int branchCalls = 0;
  int concurrentSyncs = 0;
  int maxConcurrentSyncs = 0;
  bool lastSyncWasSigned = false;
  bool syncReplayGap = false;
  bool deviceRevoked = false;
  String? revokedCredentialId;
  Duration? revokeTimeout;
  bool delayRefresh = false;
  Completer<void>? refreshGate;
  List<Object?>? refreshResponseSessions;
  bool refreshCompleted = false;
  bool queueListedAfterRefresh = false;
  List<Object?> openMessages = <Object?>[];
  String? openNextCursor;
  bool expireNextHistoryCursor = false;
  final List<String?> openCursors = <String?>[];
  final List<bool> openRefreshes = <bool>[];
  List<Object?> childSessions = <Object?>[];
  List<Object?> extraProviders = <Object?>[];
  List<Object?> extraSessions = <Object?>[];
  List<Object?> extraDictationSources = <Object?>[];
  List<Object?>? modelSnapshot;
  List<Object?> queueSnapshot = <Object?>[];
  List<Object?> sideChatSnapshot = <Object?>[];
  int queueListCalls = 0;
  int sideChatListCalls = 0;
  List<Object?> delegationSnapshot = <Object?>[];
  List<Object?> approvalSnapshot = <Object?>[];
  List<Object?> userInputSnapshot = <Object?>[];
  String sessionState = 'completed';
  DateTime sessionActivity = DateTime.utc(2026, 8, 10, 10);
  Completer<void>? openGate;
  Completer<void>? imageGetGate;
  Completer<void>? connectGate;
  Completer<void>? createGate;
  Completer<void>? resumeGate;
  Completer<void>? sendGate;
  Completer<void>? dictationGate;
  Completer<void>? attachmentUploadBeginGate;
  int? gateAttachmentUploadBeginCall;
  Completer<void>? queueEnqueueGate;
  Completer<void>? steerGate;
  Completer<void>? queueCancelGate;
  Completer<void>? queueEditGate;
  Completer<void>? queueDeliverGate;
  Completer<void>? queueMoveGate;
  Completer<void>? delegationStartGate;
  Completer<void>? delegationListGate;
  Completer<void>? sideChatCreateGate;
  Completer<void>? sideChatPromoteGate;
  Completer<void>? contextHandoffGate;
  Completer<void>? branchGate;
  Completer<void>? modelGate;
  Completer<void>? syncGate;
  Completer<void>? visionTargetsGate;
  Completer<void>? visionStatusGate;
  Completer<void>? visionConfigureGate;
  VisionProxySelection? visionStatusSelection;
  Completer<void>? contextGetGate;
  Completer<void>? contextThresholdGate;
  String? contextResponseSessionId;
  Completer<void>? approvalListGate;
  Completer<void>? userInputListGate;
  Completer<void>? queueListGate;
  Completer<void>? sideChatListGate;
  final String visionModelId;
  final String modelId;
  int visionTargetCalls = 0;
  bool visionTargetsIncomplete = false;
  bool visionTargetsEmpty = false;
  int interruptCalls = 0;
  Object? interruptError;
  bool resumeReconnected = false;
  Duration? resumeProbeTimeout;

  @override
  Future<void> connect() async {
    connectCalls += 1;
    await connectGate?.future;
    setStateForTesting(BridgeConnectionState.online);
  }

  @override
  Future<bool> resumeFromBackground({
    Duration probeTimeout = const Duration(seconds: 2),
  }) async {
    resumeCalls += 1;
    resumeProbeTimeout = probeTimeout;
    await resumeGate?.future;
    return resumeReconnected;
  }

  @override
  Future<void> close() async {
    closeCalls += 1;
  }

  @override
  Future<Map<String, Object?>> request(
    String type,
    Map<String, Object?> payload, {
    bool signed = true,
    String? requestId,
    Duration timeout = const Duration(minutes: 2),
  }) async {
    switch (type) {
      case 'host.get':
        return <String, Object?>{
          'host': <String, Object?>{'displayName': 'Test host'}
        };
      case 'provider.list':
        providerCalls += 1;
        return <String, Object?>{
          'providers': <Object?>[
            <String, Object?>{
              'providerId': 'fake',
              'displayName': 'Fake',
              'state': 'online',
              'detected': true,
              'authenticated': true,
              'capabilities': <String, Object?>{
                'createSession': true,
                'sessionRelationships': true,
                'steering': true,
              },
            },
            ...extraProviders,
          ]
        };
      case 'device.list':
        return <String, Object?>{
          'devices': <Object?>[
            <String, Object?>{
              'credentialId': 'current-credential',
              'deviceId': _host.deviceId,
              'issuedAt': '2026-08-09T10:00:00.000Z',
            },
            <String, Object?>{
              'credentialId': 'other-credential',
              'deviceId': 'other-phone',
              'issuedAt': '2026-08-08T10:00:00.000Z',
            },
          ],
        };
      case 'device.revoke':
        revokedCredentialId = payload['credentialId'] as String?;
        revokeTimeout = timeout;
        deviceRevoked = revokedCredentialId == 'other-credential' ||
            revokedCredentialId == 'current-credential';
        return <String, Object?>{'revoked': deviceRevoked};
      case 'sessions.refresh':
        refreshCalls += 1;
        final responseSessions = refreshResponseSessions ??
            <Object?>[
              _sessionJson(sessionState, sessionActivity),
              ...extraSessions,
            ];
        await refreshGate?.future;
        if (delayRefresh) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        refreshCompleted = true;
        return <String, Object?>{
          'sessions': responseSessions,
        };
      case 'session.open':
        openCalls += 1;
        final cursor = payload['cursor'] as String?;
        openCursors.add(cursor);
        openRefreshes.add(payload['refresh'] == true);
        await openGate?.future;
        if (failOpen) throw StateError('open failed');
        if (expireNextHistoryCursor && cursor != null) {
          expireNextHistoryCursor = false;
          throw StateError('Message history page expired; reopen the session');
        }
        return <String, Object?>{
          'session': _sessionJson(sessionState, sessionActivity),
          'messages': openMessages,
          'nextCursor': openNextCursor,
        };
      case 'session.image.get':
        final source = retrievalImageBytes;
        if (source == null) throw StateError('No retrieval image configured');
        final offset = payload['offset']! as int;
        imageGetOffsets.add(offset);
        await imageGetGate?.future;
        if (offset < 0 || offset > source.length) {
          throw StateError('Invalid image offset');
        }
        final proposedEnd = offset + 3;
        final end = proposedEnd < source.length ? proposedEnd : source.length;
        return <String, Object?>{
          'retrievalId': payload['retrievalId'],
          'offset': offset,
          'dataBase64': base64Encode(source.sublist(offset, end)),
          'totalBytes': source.length,
          'nextOffset': end < source.length ? end : null,
          'mimeType': 'image/png',
          'name': 'history.png',
        };
      case 'session.create':
        createCalls += 1;
        lastCreatePayload = payload;
        await createGate?.future;
        if (malformedCreateAcknowledgement) {
          return <String, Object?>{'session': 'accepted-without-details'};
        }
        final providerId = payload['providerId']! as String;
        return <String, Object?>{
          'session': <String, Object?>{
            'id': 'host/$providerId/created',
            'hostId': 'host',
            'providerId': providerId,
            'providerSessionId': 'created',
            'title': 'Created session',
            'state': 'idle',
            'lastActivityAt': '2026-08-10T12:00:00.000Z',
            'needsApproval': false,
            'stale': false,
          }
        };
      case 'session.children':
        childCalls += 1;
        lastChildSessionParentId = payload['sessionId'] as String?;
        return <String, Object?>{'sessions': childSessions};
      case 'vision.targets':
        visionTargetCalls += 1;
        await visionTargetsGate?.future;
        return <String, Object?>{
          'targets': visionTargetsEmpty
              ? <Object?>[]
              : <Object?>[
                  <String, Object?>{
                    'providerId': 'codex',
                    'displayName': 'Codex',
                    'models': <Object?>[
                      <String, Object?>{
                        'id': visionModelId,
                        'providerId': 'codex',
                        'displayName': 'Vision model',
                        'isDefault': true,
                        'inputModalities': <Object?>['text', 'image'],
                        'nativeMetadata': <String, Object?>{
                          'supportedReasoningEfforts': <Object?>[
                            <String, Object?>{'reasoningEffort': 'low'},
                            <String, Object?>{'reasoningEffort': 'high'},
                          ],
                        },
                      },
                    ],
                  },
                ],
          'incomplete': visionTargetsIncomplete,
        };
      case 'session.vision.get':
        visionStatusCalls += 1;
        await visionStatusGate?.future;
        if (visionStatusFailuresRemaining > 0) {
          visionStatusFailuresRemaining -= 1;
          throw StateError('visual status failed');
        }
        return <String, Object?>{
          'vision': <String, Object?>{
            'sessionId': payload['sessionId'],
            'primaryModelId': 'text-model',
            'primaryModelSupportsImageInput': false,
            'configured': visionStatusSelection?.toJson(),
          },
        };
      case 'session.vision.configure':
        lastVisionConfigurePayload = payload;
        await visionConfigureGate?.future;
        return <String, Object?>{
          'vision': <String, Object?>{
            'sessionId': payload['sessionId'],
            'primaryModelId': 'text-model',
            'primaryModelSupportsImageInput': false,
            'configured': payload['selection'],
          },
        };
      case 'session.context.get':
        contextGetCalls += 1;
        await contextGetGate?.future;
        return <String, Object?>{
          'context': _contextJson(
              contextResponseSessionId ?? payload['sessionId']! as String,
              96000),
        };
      case 'session.context.set_threshold':
        contextThresholdCalls += 1;
        lastContextThresholdPayload = payload;
        await contextThresholdGate?.future;
        return <String, Object?>{
          'context': _contextJson(payload['sessionId']! as String,
              payload['thresholdTokens']! as int),
        };
      case 'session.context_handoff':
        contextHandoffCalls += 1;
        lastHandoffPayload = payload;
        await contextHandoffGate?.future;
        if (malformedContextHandoffAcknowledgement) {
          return <String, Object?>{'session': 'accepted-without-details'};
        }
        return <String, Object?>{
          'summary': 'A compact, visible summary from the source chat.',
          if (payload['prompt'] != null) 'prompt': payload['prompt'],
          'session': <String, Object?>{
            ..._sessionJson('idle', DateTime.utc(2026, 8, 14, 11)),
            'id': 'host/fake/handoff',
            'providerSessionId': 'handoff',
            'title': 'Context handoff',
            'relationship': <String, Object?>{
              'kind': 'handoff',
              'sourceSessionId': _sessionId,
              'strategy': 'summary_bootstrap',
            },
          },
        };
      case 'session.branch':
        branchCalls += 1;
        lastBranchPayload = payload;
        await branchGate?.future;
        if (malformedBranchAcknowledgement) {
          return <String, Object?>{'session': 'accepted-without-details'};
        }
        return <String, Object?>{
          'session': <String, Object?>{
            ..._sessionJson('idle', DateTime.utc(2026, 8, 14, 12)),
            'id': 'host/fake/branch',
            'providerSessionId': 'branch',
            'title': 'Branched task',
            'relationship': <String, Object?>{
              'kind': 'branch',
              'sourceSessionId': _sessionId,
              'strategy': 'transcript_bootstrap',
            },
          },
          'strategy': 'transcript_bootstrap',
          'copiedMessageCount': 7,
        };
      case 'session.interrupt':
        interruptCalls += 1;
        if (interruptError != null) throw interruptError!;
        return <String, Object?>{};
      case 'wallet.get':
        lastWalletGetPayload = payload;
        final endpointId = payload['endpointId'] as String? ?? 'openai';
        return <String, Object?>{
          'wallet': <String, Object?>{
            'providerId': payload['providerId'],
            'kind': 'user_api',
            'label': 'Direct API wallet',
            'detail': 'Local spend budget',
            'endpointId': endpointId,
            'endpointName': endpointId == 'xai' ? 'xAI API' : 'OpenAI',
            'currency': 'USD',
            'balance': endpointId == 'xai' ? 7 : 25,
            'spent': 1,
            'apiKeyConfigured': endpointId == 'xai',
            if (endpointId != 'xai') 'caution': 'API key required',
          },
        };
      case 'wallet.configure':
        lastWalletConfigurePayload = payload;
        return <String, Object?>{
          'wallet': <String, Object?>{
            'providerId': payload['providerId'],
            'kind': 'user_api',
            'label': 'Direct API wallet',
            'detail': 'Local spend budget',
            'endpointId': payload['endpointId'],
            'endpointName': 'Custom One',
            'currency': 'USD',
            'balance': payload['setBalance'],
            'spent': 0,
            'apiKeyConfigured': payload['clearApiKey'] != true,
          },
        };
      case 'message_queue.list':
        queueListedAfterRefresh = refreshCompleted;
        queueListCalls += 1;
        final queueSnapshotAtRequest = List<Object?>.of(queueSnapshot);
        await queueListGate?.future;
        return <String, Object?>{'messages': queueSnapshotAtRequest};
      case 'side_chat.list':
        sideChatListCalls += 1;
        final sideChatSnapshotAtRequest = List<Object?>.of(sideChatSnapshot);
        await sideChatListGate?.future;
        return <String, Object?>{'sessions': sideChatSnapshotAtRequest};
      case 'side_chat.create':
        sideChatCreateCalls += 1;
        lastSideChatCreatePayload = payload;
        await sideChatCreateGate?.future;
        if (malformedSideChatCreateAcknowledgement) {
          return <String, Object?>{'session': 'accepted-without-details'};
        }
        return <String, Object?>{
          'session': <String, Object?>{
            ..._sideChatJson('created-side-chat'),
            'parentSessionId': payload['parentSessionId'],
            'title': payload['prompt'] ?? 'Side chat',
            'preview': payload['prompt'] ?? '',
          },
        };
      case 'side_chat.promote':
        sideChatPromoteCalls += 1;
        lastSideChatPromotePayload = payload;
        await sideChatPromoteGate?.future;
        if (malformedSideChatPromoteAcknowledgement) {
          return <String, Object?>{'session': 'accepted-without-details'};
        }
        return <String, Object?>{
          'session': <String, Object?>{
            ..._sessionJson('idle', DateTime.utc(2026, 8, 15, 13)),
            'id': payload['sessionId'],
            'providerSessionId': 'promoted-side-chat',
            'title': 'Promoted side chat',
            'sessionKind': 'task',
          },
        };
      case 'delegation.list':
        delegationListCalls += 1;
        final delegationSnapshotAtRequest =
            List<Object?>.of(delegationSnapshot);
        await delegationListGate?.future;
        delegationListCompletedCalls += 1;
        return <String, Object?>{
          'delegations': delegationSnapshotAtRequest,
        };
      case 'delegation.start':
      case 'delegation.prepare':
        delegationStartCalls += 1;
        if (type == 'delegation.prepare') {
          delegationPrepareCalls += 1;
        } else {
          delegationLegacyStartCalls += 1;
        }
        lastDelegationPayload = payload;
        await delegationStartGate?.future;
        if (failDelegation) throw StateError('delegation failed');
        if (malformedDelegationAcknowledgement) {
          return <String, Object?>{'delegation': 'accepted-without-details'};
        }
        return <String, Object?>{
          'delegation': <String, Object?>{
            ..._delegationJson(type == 'delegation.prepare'
                ? requestId ?? 'prepared-delegation'
                : 'started-delegation'),
            'parentSessionId': payload['parentSessionId'],
            'prompt': payload['prompt'],
            if (type == 'delegation.prepare') ...<String, Object?>{
              'state': 'awaiting_dispatch',
              'targets': payload['targets'],
              'presentationSegments': payload['presentationSegments'],
              'orchestration': 'parent',
            },
          },
        };
      case 'approval.list':
        approvalListCalls += 1;
        await approvalListGate?.future;
        return <String, Object?>{'approvals': approvalSnapshot};
      case 'user_input.list':
        userInputListCalls += 1;
        await userInputListGate?.future;
        return <String, Object?>{'requests': userInputSnapshot};
      case 'dictation.source.list':
        return <String, Object?>{
          'sources': <Object?>[
            <String, Object?>{
              'id': 'openai-stt',
              'label': 'OpenAI speech-to-text',
              'status': dictationSourcesReady ? 'ready' : 'needs_credential',
              'setupEnvironmentVariable': 'TETHOQ_OPENAI_API_KEY',
              'credential': <String, Object?>{
                'kind': 'api_key',
                'label': 'OpenAI API key',
                'setupUrl': 'https://platform.openai.com/api-keys',
              },
              'capabilities': <String, Object?>{
                'batch': true,
                'maxAudioBytes': 4 * 1024 * 1024,
              },
            },
            <String, Object?>{
              'id': 'xai-stt',
              'label': 'xAI speech-to-text',
              'status': dictationSourcesReady ? 'ready' : 'needs_credential',
              'setupEnvironmentVariable': 'XAI_API_KEY',
              'credential': <String, Object?>{
                'kind': 'api_key',
                'label': 'xAI API key',
                'setupUrl': 'https://console.x.ai/',
              },
              'capabilities': <String, Object?>{
                'batch': true,
                'maxAudioBytes': 25 * 1024 * 1024,
              },
            },
            ...extraDictationSources,
          ],
        };
      case 'dictation.source.configure':
        lastDictationConfigurePayload = Map<String, Object?>.from(payload);
        dictationSourcesReady = payload['clear'] != true;
        return <String, Object?>{
          'sources': <Object?>[
            <String, Object?>{
              'id': 'openai-stt',
              'label': 'OpenAI speech-to-text',
              'status': dictationSourcesReady ? 'ready' : 'needs_credential',
              'setupEnvironmentVariable': 'TETHOQ_OPENAI_API_KEY',
              'credential': <String, Object?>{
                'kind': 'api_key',
                'label': 'OpenAI API key',
                'setupUrl': 'https://platform.openai.com/api-keys',
              },
              'capabilities': <String, Object?>{
                'batch': true,
                'maxAudioBytes': 4 * 1024 * 1024,
              },
            },
            <String, Object?>{
              'id': 'xai-stt',
              'label': 'xAI speech-to-text',
              'status': dictationSourcesReady ? 'ready' : 'needs_credential',
              'setupEnvironmentVariable': 'XAI_API_KEY',
              'credential': <String, Object?>{
                'kind': 'api_key',
                'label': 'xAI API key',
                'setupUrl': 'https://console.x.ai/',
              },
              'capabilities': <String, Object?>{
                'batch': true,
                'maxAudioBytes': 25 * 1024 * 1024,
              },
            },
          ],
        };
      case 'sync.since':
        syncCalls += 1;
        concurrentSyncs += 1;
        if (concurrentSyncs > maxConcurrentSyncs) {
          maxConcurrentSyncs = concurrentSyncs;
        }
        lastSyncWasSigned = signed;
        try {
          await syncGate?.future;
          final sequence = payload['sequence']! as int;
          return <String, Object?>{
            'events': const <Object?>[],
            'requestedSequence': sequence,
            'oldestAvailableSequence': syncReplayGap ? sequence + 2 : null,
            'latestSequence': sequence,
            'throughSequence': sequence,
            'replayGap': syncReplayGap,
            'omittedEventCount': 0,
          };
        } finally {
          concurrentSyncs -= 1;
        }
      case 'attachment.upload.begin':
        lastAttachmentUploadPayload = payload;
        final uploadCall = ++attachmentUploadCount;
        if (gateAttachmentUploadBeginCall == uploadCall) {
          await attachmentUploadBeginGate?.future;
        }
        return <String, Object?>{
          'uploadId': 'upload-$uploadCall',
          'chunkBytes': 64 * 1024,
        };
      case 'attachment.upload.chunk':
        uploadChunkSizes
            .add(base64Decode(payload['dataBase64']! as String).length);
        return <String, Object?>{
          'receivedBytes': uploadChunkSizes.fold<int>(0, (a, b) => a + b)
        };
      case 'attachment.upload.complete':
        return <String, Object?>{'attachmentId': payload['uploadId']};
      case 'attachment.upload.cancel':
        cancelledUploadIds.add(payload['uploadId']! as String);
        return <String, Object?>{'cancelled': true};
      case 'dictation.transcribe':
        lastDictationPayload = payload;
        await dictationGate?.future;
        return <String, Object?>{'text': 'Transcribed phone instruction'};
      case 'ears.process':
        lastEarsPayload = payload;
        earsPayloads.add(Map<String, Object?>.of(payload));
        if (scopeEarsRequests) {
          final scopedRequestId = payload['requestId']! as String;
          final gate = earsRequestGates.putIfAbsent(
              scopedRequestId, () => Completer<void>());
          await gate.future;
          if (cancelledEarsRequestIds.contains(scopedRequestId)) {
            throw StateError('EARS transcription was cancelled.');
          }
          return <String, Object?>{
            'texts': <Object?>[
              for (final _ in jsonList(payload['attachmentIds']))
                'Transcribed phone instruction',
            ]
          };
        }
        await earsGate?.future;
        if (earsCancelled) {
          throw StateError('EARS transcription was cancelled.');
        }
        return <String, Object?>{
          'texts': <Object?>[
            for (final _ in jsonList(payload['attachmentIds']))
              'Transcribed phone instruction',
          ]
        };
      case 'ears.cancel':
        lastEarsCancelPayload = payload;
        if (scopeEarsRequests) {
          final scopedRequestId = payload['requestId']! as String;
          cancelledEarsRequestIds.add(scopedRequestId);
          final gate = earsRequestGates[scopedRequestId];
          if (gate != null && !gate.isCompleted) gate.complete();
          return <String, Object?>{'cancelled': true};
        }
        earsCancelled = true;
        earsGate?.complete();
        return <String, Object?>{'cancelled': true};
      case 'message_queue.enqueue':
        queueEnqueueCalls += 1;
        lastQueuePayload = payload;
        await queueEnqueueGate?.future;
        if (failQueue) throw StateError('queue failed');
        if (missingQueueAcknowledgement) return <String, Object?>{};
        if (malformedQueueAcknowledgement) {
          return <String, Object?>{'message': 'accepted-without-details'};
        }
        final uploaded = lastAttachmentUploadPayload;
        return <String, Object?>{
          'message': <String, Object?>{
            'id': 'queued-1',
            'sessionId': payload['sessionId'],
            'content': payload['content'],
            'state': 'queued',
            'createdAt': '2026-08-10T12:00:00.000Z',
            'attachments': uploaded == null
                ? const <Object?>[]
                : <Object?>[
                    <String, Object?>{
                      'name': uploaded['name'],
                      'mimeType': uploaded['mimeType'],
                      'byteLength': uploaded['byteLength'],
                    }
                  ],
          },
        };
      case 'message_queue.cancel':
        lastQueueCancelPayload = payload;
        await queueCancelGate?.future;
        return <String, Object?>{'cancelled': true};
      case 'message_queue.edit':
        lastQueueEditPayload = payload;
        await queueEditGate?.future;
        return <String, Object?>{
          'message': <String, Object?>{
            ..._queuedJson(payload['messageId']! as String),
            'content': payload['content'],
          },
        };
      case 'message_queue.deliver':
        lastQueueDeliverPayload = payload;
        await queueDeliverGate?.future;
        return <String, Object?>{'delivered': true};
      case 'message_queue.move_to_new_task':
        queueMoveCalls += 1;
        lastQueueNewTaskPayload = payload;
        await queueMoveGate?.future;
        if (malformedQueueMoveAcknowledgement) {
          return <String, Object?>{'session': 'accepted-without-details'};
        }
        return <String, Object?>{
          'session': <String, Object?>{
            ..._sessionJson('working', DateTime.utc(2026, 8, 16, 12)),
            'id': 'queue-new-task',
            'providerSessionId': 'queue-new-task-provider',
            'providerId': payload['providerId'],
            'title': 'Moved queued instruction',
            'modelId': payload['modelId'],
            if (payload['reasoningEffort'] != null)
              'reasoningEffort': payload['reasoningEffort'],
          },
        };
      case 'session.steer_message':
        lastSteerPayload = payload;
        await steerGate?.future;
        return <String, Object?>{'accepted': true};
      case 'session.send_message':
        lastSendPayload = payload;
        sendCalls += 1;
        await sendGate?.future;
        if (sendError != null) throw sendError!;
        if (failSend) throw StateError('send failed');
        return <String, Object?>{};
      case 'models.list':
        modelCalls += 1;
        if (modelFailuresRemaining > 0) {
          modelFailuresRemaining -= 1;
          throw StateError('model list failed');
        }
        await modelGate?.future;
        final providerId = payload['providerId']! as String;
        final configuredEndpoint = providerId == 'direct'
            ? (lastWalletConfigurePayload?['customEndpoint']
                as Map<String, Object?>?)
            : null;
        final configuredModelIds = configuredEndpoint == null
            ? const <Object?>[]
            : jsonList(configuredEndpoint['modelIds']);
        return <String, Object?>{
          'models': providerId == 'direct' && configuredEndpoint != null
              ? configuredModelIds
                  .whereType<String>()
                  .map((modelId) => <String, Object?>{
                        'id': '${configuredEndpoint['id']}::$modelId',
                        'providerId': providerId,
                        'displayName': modelId,
                        'isDefault': false,
                        'nativeMetadata': <String, Object?>{
                          'endpointId': configuredEndpoint['id'],
                          'endpointName': configuredEndpoint['name'],
                        },
                      })
                  .toList(growable: false)
              : modelSnapshot ??
                  <Object?>[
                    <String, Object?>{
                      'id': modelId,
                      'providerId': providerId,
                      'displayName': 'Fake model',
                      'isDefault': true,
                      'nativeMetadata': <String, Object?>{},
                    }
                  ],
        };
      default:
        throw StateError('Unexpected request: $type');
    }
  }
}

class _FailingPairTransport extends BridgeTransport {
  _FailingPairTransport({
    required super.endpoint,
    required super.security,
    required this.error,
  });

  final Object error;

  @override
  Future<void> connect() => Future<void>.error(error);
}

class _InitiallyUnavailableTransport extends _FakeTransport {
  _InitiallyUnavailableTransport({required super.security});

  bool _firstAttempt = true;

  @override
  Future<void> connect() async {
    if (_firstAttempt) {
      _firstAttempt = false;
      setStateForTesting(BridgeConnectionState.reconnecting);
      throw const SocketException(
          'Secure DNS returned no usable address for private.trycloudflare.com');
    }
    await super.connect();
  }

  Future<void> reconnectForTesting() => connect();
}

class _CredentialPayloadSecurity extends DeviceSecurity {
  @override
  Future<Map<String, Object?>> verifyCredential(
          SignedCredential credential, String hostPublicKeyPem) async =>
      <String, Object?>{
        'credentialId': 'current-credential',
        'hostId': _host.hostId,
        'deviceId': _host.deviceId,
      };
}

class _DelayedReadStateSecurity extends DeviceSecurity {
  bool delayWrites = false;
  int delayedSaveCalls = 0;
  final Completer<void> _writeGate = Completer<void>();

  @override
  Future<void> saveSessionReadState(
      PairedHost host, SessionReadState state) async {
    if (delayWrites) {
      delayedSaveCalls += 1;
      await _writeGate.future;
    }
    await super.saveSessionReadState(host, state);
  }

  void releaseWrites() {
    if (!_writeGate.isCompleted) _writeGate.complete();
  }
}
