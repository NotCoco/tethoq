import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
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
  });

  test('recent model choices retain only the last five and persist', () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final store = RemoteAppStore(security: security);
    addTearDown(store.dispose);

    for (var index = 0; index < 6; index += 1) {
      store.rememberModelSelection('provider', 'model-$index');
    }
    await Future<void>.delayed(const Duration(milliseconds: 20));

    expect(store.recentModelKeys, hasLength(5));
    expect(store.recentModelKeys.first, 'provider\u0000model-5');
    expect(store.recentModelKeys, isNot(contains('provider\u0000model-0')));
    expect(await security.readRecentModelKeys(), store.recentModelKeys);
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

  test('session history hydrates chunked inline images before display',
      () async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final security = DeviceSecurity();
    final imageBytes = <int>[1, 2, 3, 4, 5, 6, 7];
    final transport = _FakeTransport(security: security)
      ..retrievalImageBytes = imageBytes
      ..openMessages = <Object?>[
        <String, Object?>{
          'id': 'image-message',
          'sessionId': _sessionId,
          'providerMessageId': 'native-image',
          'role': 'assistant',
          'createdAt': '2026-08-10T12:00:00.000Z',
          'parts': <Object?>[
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

    final image = store.messages[_sessionId]!.single.parts.single;
    expect(image.attachmentUri,
        'data:image/png;base64,${base64Encode(imageBytes)}');
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
      modelId: 'model-before',
      reasoningEffort: 'high',
      variantId: 'variant-before',
      parentSessionId: 'host/fake/parent',
      agentNickname: 'Reviewer',
      agentRole: 'reviewer',
    ));

    store.applyEventForTesting(
        _eventWithPayload('session.updated', 1, const <String, Object?>{
      'modelId': 'gpt-5.6-sol',
      'reasoningEffort': 'ultra',
    }));

    final updated = store.sessions.single;
    expect(updated.modelId, 'gpt-5.6-sol');
    expect(updated.reasoningEffort, 'ultra');
    expect(updated.variantId, 'variant-before');
    expect(updated.parentSessionId, 'host/fake/parent');
    expect(updated.agentNickname, 'Reviewer');
    expect(updated.agentRole, 'reviewer');
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
      'attachments': <Object?>[
        <String, Object?>{
          'name': 'phone.jpg',
          'mimeType': 'image/jpeg',
          'dataBase64': 'AQID',
          'byteLength': 3,
        }
      ],
    });
    expect(transport.lastSendPayload.toString(), isNot(contains(r'C:\')));
    expect(store.messages[_sessionId]!.single.parts.last.type, 'image');
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
    expect(transport.lastSendPayload?['attachments'], <Object?>[
      <String, Object?>{
        'name': 'shot.png',
        'mimeType': 'image/png',
        'dataBase64': 'BAUG',
        'byteLength': 3,
        'origin': 'file-picker',
      }
    ]);
    expect(store.drafts[_sessionId], '');

    transport.earsGate = Completer<void>();
    transport.earsCancelled = false;
    transport.lastEarsPayload = null;
    transport.lastSendPayload = null;
    final pending = store.sendMessage(_sessionId, 'Keep this draft',
        attachments: const <RemoteAttachment>[clip]);
    await _waitFor(() => store.earsBusy);
    await store.cancelEars();
    await expectLater(pending, throwsA(predicate((Object error) {
      return error.toString().contains('EARS transcription was cancelled.');
    })));
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

    final transcript =
        await store.transcribeDictation(List<int>.filled(9000, 4));

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
      () => store.transcribeDictation(List<int>.filled(9000, 4)),
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
    expect(store.liveAssistantMessageFor(_sessionId)!.parts.single.summary,
        'Live answer');

    store.applyEventForTesting(_event('agent.completed', 4));
    await Future<void>.delayed(const Duration(milliseconds: 400));

    expect(transport.openCalls, 1);
    expect(store.liveAssistantMessageFor(_sessionId), isNull);
    expect(store.messages[_sessionId]!.single.parts.single.summary,
        'Canonical answer');
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
}

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
  _FakeTransport({required DeviceSecurity security})
      : super(
          endpoint: BridgeEndpoint(
            hostId: _host.hostId,
            url: _host.endpoint,
            deviceId: _host.deviceId,
            pairedHost: _host,
          ),
          security: security,
        );

  bool failOpen = false;
  bool failSend = false;
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
  Map<String, Object?>? lastQueueDeliverPayload;
  Map<String, Object?>? lastQueueNewTaskPayload;
  Map<String, Object?>? lastEarsPayload;
  Map<String, Object?>? lastEarsCancelPayload;
  Completer<void>? earsGate;
  bool earsCancelled = false;
  Map<String, Object?>? lastSideChatCreatePayload;
  Map<String, Object?>? lastAttachmentUploadPayload;
  final List<int> uploadChunkSizes = <int>[];
  List<int>? retrievalImageBytes;
  final List<int> imageGetOffsets = <int>[];
  int openCalls = 0;
  int childCalls = 0;
  int createCalls = 0;
  int providerCalls = 0;
  int modelCalls = 0;
  int refreshCalls = 0;
  int syncCalls = 0;
  int concurrentSyncs = 0;
  int maxConcurrentSyncs = 0;
  bool lastSyncWasSigned = false;
  bool syncReplayGap = false;
  bool deviceRevoked = false;
  bool delayRefresh = false;
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
  List<Object?> queueSnapshot = <Object?>[];
  List<Object?> sideChatSnapshot = <Object?>[];
  List<Object?> delegationSnapshot = <Object?>[];
  List<Object?> approvalSnapshot = <Object?>[];
  List<Object?> userInputSnapshot = <Object?>[];
  String sessionState = 'completed';
  DateTime sessionActivity = DateTime.utc(2026, 8, 10, 10);
  Completer<void>? openGate;
  Completer<void>? modelGate;
  Completer<void>? syncGate;
  int interruptCalls = 0;
  Object? interruptError;

  @override
  Future<void> connect() async {
    setStateForTesting(BridgeConnectionState.online);
  }

  @override
  Future<void> close() async {}

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
        deviceRevoked = payload['credentialId'] == 'other-credential';
        return <String, Object?>{'revoked': deviceRevoked};
      case 'sessions.refresh':
        refreshCalls += 1;
        if (delayRefresh) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
        refreshCompleted = true;
        return <String, Object?>{
          'sessions': <Object?>[
            _sessionJson(sessionState, sessionActivity),
            ...extraSessions,
          ]
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
        return <String, Object?>{'sessions': childSessions};
      case 'vision.targets':
        return <String, Object?>{
          'targets': <Object?>[
            <String, Object?>{
              'providerId': 'codex',
              'displayName': 'Codex',
              'models': <Object?>[
                <String, Object?>{
                  'id': 'vision-model',
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
        };
      case 'session.vision.get':
        return <String, Object?>{
          'vision': <String, Object?>{
            'sessionId': payload['sessionId'],
            'primaryModelId': 'text-model',
            'primaryModelSupportsImageInput': false,
            'configured': null,
          },
        };
      case 'session.vision.configure':
        lastVisionConfigurePayload = payload;
        return <String, Object?>{
          'vision': <String, Object?>{
            'sessionId': payload['sessionId'],
            'primaryModelId': 'text-model',
            'primaryModelSupportsImageInput': false,
            'configured': payload['selection'],
          },
        };
      case 'session.context.get':
        return <String, Object?>{
          'context': _contextJson(payload['sessionId']! as String, 96000),
        };
      case 'session.context.set_threshold':
        lastContextThresholdPayload = payload;
        return <String, Object?>{
          'context': _contextJson(payload['sessionId']! as String,
              payload['thresholdTokens']! as int),
        };
      case 'session.context_handoff':
        lastHandoffPayload = payload;
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
        lastBranchPayload = payload;
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
        return <String, Object?>{'messages': queueSnapshot};
      case 'side_chat.list':
        return <String, Object?>{'sessions': sideChatSnapshot};
      case 'side_chat.create':
        lastSideChatCreatePayload = payload;
        return <String, Object?>{
          'session': <String, Object?>{
            ..._sideChatJson('created-side-chat'),
            'parentSessionId': payload['parentSessionId'],
            'title': payload['prompt'] ?? 'Side chat',
            'preview': payload['prompt'] ?? '',
          },
        };
      case 'side_chat.promote':
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
        return <String, Object?>{'delegations': delegationSnapshot};
      case 'approval.list':
        return <String, Object?>{'approvals': approvalSnapshot};
      case 'user_input.list':
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
        return <String, Object?>{
          'uploadId': 'upload-1',
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
        return <String, Object?>{'cancelled': true};
      case 'dictation.transcribe':
        lastDictationPayload = payload;
        return <String, Object?>{'text': 'Transcribed phone instruction'};
      case 'ears.process':
        lastEarsPayload = payload;
        await earsGate?.future;
        if (earsCancelled) {
          throw StateError('EARS transcription was cancelled.');
        }
        return <String, Object?>{
          'texts': <Object?>['Transcribed phone instruction']
        };
      case 'ears.cancel':
        lastEarsCancelPayload = payload;
        earsCancelled = true;
        earsGate?.complete();
        return <String, Object?>{'cancelled': true};
      case 'message_queue.enqueue':
        lastQueuePayload = payload;
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
        return <String, Object?>{'cancelled': true};
      case 'message_queue.edit':
        lastQueueEditPayload = payload;
        return <String, Object?>{
          'message': <String, Object?>{
            ..._queuedJson(payload['messageId']! as String),
            'content': payload['content'],
          },
        };
      case 'message_queue.deliver':
        lastQueueDeliverPayload = payload;
        return <String, Object?>{'delivered': true};
      case 'message_queue.move_to_new_task':
        lastQueueNewTaskPayload = payload;
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
        return <String, Object?>{'accepted': true};
      case 'session.send_message':
        if (failSend) throw StateError('send failed');
        lastSendPayload = payload;
        return <String, Object?>{};
      case 'models.list':
        modelCalls += 1;
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
              : <Object?>[
                  <String, Object?>{
                    'id': 'fake-model',
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
