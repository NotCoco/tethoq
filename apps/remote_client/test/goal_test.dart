import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/dictation.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';
import 'package:universal_agent_remote/src/security.dart';
import 'package:universal_agent_remote/src/store.dart';
import 'package:universal_agent_remote/src/transport.dart';

const _tethoqSessionId = 'host/fake/tethoq-goal';
const _nativeSessionId = 'host/codex/native-goal';

final _goalHost = PairedHost(
  hostId: 'host',
  hostPublicKeyPem: 'unused',
  endpoint: 'ws://127.0.0.1/unused',
  deviceId: 'device',
  devicePrivateKey: const <int>[1],
  devicePublicKey: const <int>[2],
  credential: const SignedCredential(payload: 'unused', signature: 'unused'),
);

void main() {
  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
  });

  test('goal lifecycle is provider-neutral and never starts a model turn',
      () async {
    final backend = _GoalBackend();
    final transport = _GoalTransport(backend);
    final store = await _connectedStore(transport);
    addTearDown(store.dispose);

    final tethoqGoal = await store.setSessionGoal(
      _tethoqSessionId,
      objective: 'Keep the provider-neutral mobile task moving',
      tokenBudget: 1200,
    );
    expect(tethoqGoal.source, 'tethoq');
    expect(tethoqGoal.status, 'active');
    expect(tethoqGoal.tokenBudget, 1200);
    expect(store.goalsBySession[_tethoqSessionId]?.objective,
        tethoqGoal.objective);

    final paused = await store.setSessionGoal(
      _tethoqSessionId,
      status: 'paused',
    );
    expect(paused.status, 'paused');
    expect(paused.revision, greaterThan(tethoqGoal.revision));

    final nativeGoal = await store.setSessionGoal(
      _nativeSessionId,
      objective: 'Keep the native provider task moving',
    );
    expect(nativeGoal.source, 'native');
    expect(nativeGoal.status, 'active');

    await store.clearSessionGoal(_tethoqSessionId);
    expect(store.goalsBySession.containsKey(_tethoqSessionId), isFalse);
    store.applyEventForTesting(_goalEvent(
      sequence: 10,
      sessionId: _tethoqSessionId,
      revision: paused.revision,
      objective: 'Delayed response from before clear',
    ));
    expect(store.goalsBySession[_tethoqSessionId], isNull);
    expect(store.goalsBySession[_nativeSessionId]?.source, 'native');

    expect(transport.requestTypes, isNot(contains('session.send_message')));
    expect(
        transport.requestTypes.where((type) => type.contains('turn')), isEmpty);
  });

  test('goal state survives a mobile store reopen through the bridge',
      () async {
    final backend = _GoalBackend();
    final transport = _GoalTransport(backend);
    final first = await _connectedStore(transport);
    final written = await first.setSessionGoal(
      _tethoqSessionId,
      objective: 'Restore this objective after reopening the task',
      status: 'blocked',
      tokenBudget: 2400,
    );
    first.dispose();

    final reopened = await _connectedStore(transport);
    addTearDown(reopened.dispose);
    final restored = await reopened.loadSessionGoal(_tethoqSessionId);

    expect(restored?.objective, written.objective);
    expect(restored?.status, 'blocked');
    expect(restored?.tokenBudget, 2400);
    expect(restored?.revision, written.revision);
  });

  test('a clear tombstone rejects delayed updates but keeps newer updates', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);

    store.applyEventForTesting(_goalEvent(
      sequence: 1,
      sessionId: _tethoqSessionId,
      revision: 10,
      objective: 'Before clear',
    ));
    store.applyEventForTesting(_goalEvent(
      sequence: 2,
      sessionId: _tethoqSessionId,
      revision: 11,
      cleared: true,
    ));
    store.applyEventForTesting(_goalEvent(
      sequence: 3,
      sessionId: _tethoqSessionId,
      revision: 10,
      objective: 'Delayed stale update',
    ));
    store.applyEventForTesting(_goalEvent(
      sequence: 31,
      sessionId: _tethoqSessionId,
      revision: 10,
      cleared: true,
    ));
    store.applyEventForTesting(_goalEvent(
      sequence: 32,
      sessionId: _tethoqSessionId,
      revision: 11,
      objective: 'Update tied with the clear revision',
    ));
    expect(store.goalsBySession[_tethoqSessionId], isNull);

    store.applyEventForTesting(_goalEvent(
      sequence: 4,
      sessionId: _tethoqSessionId,
      revision: 12,
      objective: 'New objective after clear',
    ));
    store.applyEventForTesting(_goalEvent(
      sequence: 5,
      sessionId: _tethoqSessionId,
      revision: 11,
      cleared: true,
    ));
    expect(store.goalsBySession[_tethoqSessionId]?.objective,
        'New objective after clear');
  });

  test('stale goal RPC replies cannot overwrite newer events', () async {
    final backend = _GoalBackend();
    final transport = _GoalTransport(backend);
    final store = await _connectedStore(transport);
    addTearDown(store.dispose);

    await store.setSessionGoal(_tethoqSessionId,
        objective: 'Initial objective');
    transport.delayNextGoalGet();
    final pendingLoad = store.loadSessionGoal(_tethoqSessionId);
    await transport.goalGetStarted;
    store.applyEventForTesting(_goalEvent(
      sequence: 101,
      sessionId: _tethoqSessionId,
      revision: 2,
      objective: 'Newer event during load',
    ));
    transport.releaseGoalGet();
    expect((await pendingLoad)?.objective, 'Newer event during load');

    transport.delayNextGoalSet();
    final pendingSet =
        store.setSessionGoal(_tethoqSessionId, objective: 'Stale set response');
    await transport.goalSetStarted;
    store.applyEventForTesting(_goalEvent(
      sequence: 102,
      sessionId: _tethoqSessionId,
      revision: 3,
      objective: 'Newer event during set',
    ));
    transport.releaseGoalSet();
    expect((await pendingSet).objective, 'Newer event during set');

    transport.clearSucceeds = false;
    await store.clearSessionGoal(_tethoqSessionId);
    expect(store.goalsBySession[_tethoqSessionId]?.objective,
        'Newer event during set');
  });

  test('native and Tethoq goal events retain the same lifecycle fields', () {
    final store = RemoteAppStore();
    addTearDown(store.dispose);

    store.applyEventForTesting(_goalEvent(
      sequence: 1,
      sessionId: _tethoqSessionId,
      revision: 1,
      objective: 'Tethoq objective',
      source: 'tethoq',
      status: 'usageLimited',
    ));
    store.applyEventForTesting(_goalEvent(
      sequence: 2,
      sessionId: _nativeSessionId,
      revision: 2,
      objective: 'Native objective',
      source: 'native',
      status: 'budgetLimited',
    ));

    final tethoq = store.goalsBySession[_tethoqSessionId]!;
    final native = store.goalsBySession[_nativeSessionId]!;
    expect(tethoq.source, 'tethoq');
    expect(native.source, 'native');
    expect(tethoq.status, 'usageLimited');
    expect(native.status, 'budgetLimited');
    expect(tethoq.tokenBudget, 900);
    expect(native.tokenBudget, 900);
    expect(tethoq.tokensUsed, 300);
    expect(native.tokensUsed, 300);
    expect(tethoq.timeUsedSeconds, 42);
    expect(native.timeUsedSeconds, 42);
  });

  test('goal parsing rejects malformed lifecycle records', () {
    final valid = _goalJson(_tethoqSessionId, revision: 1);
    expect(
        SessionGoal.fromJson(<String, Object?>{
          ...valid,
          'objective': '  Keep this normalized  ',
        }).objective,
        'Keep this normalized');

    void expectMalformed(String key, Object? value) {
      expect(
        () => SessionGoal.fromJson(<String, Object?>{...valid, key: value}),
        throwsA(isA<FormatException>()),
        reason: key,
      );
    }

    expectMalformed('objective', '   ');
    expectMalformed('objective', 'x' * 4001);
    expectMalformed('source', 'connector');
    expectMalformed('tokenBudget', 0);
    expectMalformed('tokenBudget', -1);
    expectMalformed('tokenBudget', 1.5);
    expectMalformed('tokensUsed', -1);
    expectMalformed('timeUsedSeconds', -1);
    expectMalformed('revision', -1);
    expectMalformed('createdAt', 'not-a-timestamp');
    expectMalformed('updatedAt', 'not-a-timestamp');
  });

  testWidgets('goal controls stay compact and accessible on a phone',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final store = _GoalFeatureStore();
    final session =
        _goalSession(_tethoqSessionId, providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.add(_provider('future-harness'))
      ..goalsBySession[_tethoqSessionId] = _goalJsonModel(
        _tethoqSessionId,
        source: 'tethoq',
        objective: 'A readable mobile goal',
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: _tethoqSessionId,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    expect(tester.takeException(), isNull);

    expect(find.byKey(const Key('session-goal-button')), findsNothing);
    await tester.tap(find.byKey(const Key('session-actions-menu')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-goal-settings')), findsOneWidget);
    expect(find.text('Goal: active'), findsOneWidget);
    expect(find.byKey(const Key('session-eyes-settings')), findsOneWidget);
    expect(find.text('EYES settings'), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-goal-settings')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('session-goal-sheet')), findsOneWidget);
    expect(find.text('Token target (advisory)'), findsOneWidget);

    final objective = tester
        .widget<TextField>(find.byKey(const Key('session-goal-objective')));
    expect(objective.maxLength, 4000);
    await tester.tap(find.byKey(const Key('session-goal-save')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final complete = find.byKey(const Key('session-goal-complete'));
    expect(complete, findsOneWidget);
    expect(tester.getSize(complete).height, greaterThanOrEqualTo(44));
  });
}

Future<RemoteAppStore> _connectedStore(_GoalTransport transport) async {
  final store = RemoteAppStore(
    security: DeviceSecurity(),
    transportFactory: (_, __) => transport,
  );
  await store.connectHost(_goalHost);
  return store;
}

AgentEvent _goalEvent({
  required int sequence,
  required String sessionId,
  required int revision,
  String objective = 'Goal objective',
  String source = 'tethoq',
  String status = 'active',
  bool cleared = false,
}) {
  return AgentEvent(
    eventId: 'goal-event-$sequence',
    sequence: sequence,
    type: cleared ? 'session.goal_cleared' : 'session.goal_updated',
    occurredAt: DateTime.utc(2026, 8, 23, 12, 0, sequence),
    sessionId: sessionId,
    providerId: sessionId.contains('/codex/') ? 'codex' : 'fake',
    payload: cleared
        ? <String, Object?>{'revision': revision}
        : <String, Object?>{
            'goal': _goalJson(
              sessionId,
              revision: revision,
              objective: objective,
              source: source,
              status: status,
            ),
          },
  );
}

Map<String, Object?> _goalJson(
  String sessionId, {
  required int revision,
  String objective = 'Goal objective',
  String source = 'tethoq',
  String status = 'active',
}) =>
    <String, Object?>{
      'sessionId': sessionId,
      'objective': objective,
      'status': status,
      'source': source,
      'tokenBudget': 900,
      'tokensUsed': 300,
      'timeUsedSeconds': 42,
      'createdAt': '2026-08-23T12:00:00.000Z',
      'updatedAt': '2026-08-23T12:00:01.000Z',
      'revision': revision,
    };

SessionGoal _goalJsonModel(
  String sessionId, {
  required String source,
  required String objective,
  String status = 'active',
  int revision = 1,
}) =>
    SessionGoal.fromJson(_goalJson(
      sessionId,
      revision: revision,
      objective: objective,
      source: source,
      status: status,
    ));

RemoteSession _goalSession(String id, {required String providerId}) =>
    RemoteSession(
      id: id,
      hostId: 'host',
      providerId: providerId,
      providerSessionId: id,
      title: 'Goal task',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 8, 23, 12),
      needsApproval: false,
      stale: false,
    );

ProviderConnection _provider(String id) => ProviderConnection(
      providerId: id,
      displayName: id,
      state: 'online',
      detected: true,
      authenticated: true,
      capabilities: const ProviderCapabilities(createSession: true),
    );

class _GoalBackend {
  final Map<String, Map<String, Object?>> goals =
      <String, Map<String, Object?>>{};
  int nextRevision = 0;

  String sourceFor(String sessionId) =>
      sessionId.contains('/codex/') ? 'native' : 'tethoq';

  Map<String, Object?>? get(String sessionId) => goals[sessionId];

  int clear(String sessionId) {
    goals.remove(sessionId);
    return ++nextRevision;
  }

  Map<String, Object?> set(String sessionId, Map<String, Object?> payload) {
    final previous = goals[sessionId];
    final objective = payload['objective'] as String? ??
        previous?['objective'] as String? ??
        (throw StateError('objective required'));
    final tokenBudget = payload.containsKey('tokenBudget')
        ? payload['tokenBudget'] as int?
        : previous?['tokenBudget'] as int?;
    final goal = _goalJson(
      sessionId,
      revision: ++nextRevision,
      objective: objective,
      source: sourceFor(sessionId),
      status: payload['status'] as String? ??
          previous?['status'] as String? ??
          'active',
    )..['tokenBudget'] = tokenBudget;
    goals[sessionId] = goal;
    return goal;
  }
}

class _GoalTransport extends BridgeTransport {
  _GoalTransport(this.backend)
      : super(
          endpoint: BridgeEndpoint(
            hostId: _goalHost.hostId,
            url: _goalHost.endpoint,
            deviceId: _goalHost.deviceId,
            pairedHost: _goalHost,
          ),
          security: DeviceSecurity(),
        );

  final _GoalBackend backend;
  final List<String> requestTypes = <String>[];
  Completer<void>? _goalGetGate;
  Completer<void>? _goalGetStarted;
  Completer<void>? _goalSetGate;
  Completer<void>? _goalSetStarted;
  bool clearSucceeds = true;

  Future<void> get goalGetStarted => _goalGetStarted!.future;
  Future<void> get goalSetStarted => _goalSetStarted!.future;

  void delayNextGoalGet() {
    _goalGetGate = Completer<void>();
    _goalGetStarted = Completer<void>();
  }

  void releaseGoalGet() => _goalGetGate!.complete();

  void delayNextGoalSet() {
    _goalSetGate = Completer<void>();
    _goalSetStarted = Completer<void>();
  }

  void releaseGoalSet() => _goalSetGate!.complete();

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
    requestTypes.add(type);
    switch (type) {
      case 'host.get':
        return <String, Object?>{
          'host': <String, Object?>{'displayName': 'Goal host'},
        };
      case 'provider.list':
        return <String, Object?>{
          'providers': <Object?>[
            <String, Object?>{
              'providerId': 'fake',
              'displayName': 'Fake',
              'state': 'online',
              'detected': true,
              'authenticated': true,
              'capabilities': <String, Object?>{'createSession': true},
            },
            <String, Object?>{
              'providerId': 'codex',
              'displayName': 'Codex',
              'state': 'online',
              'detected': true,
              'authenticated': true,
              'capabilities': <String, Object?>{'createSession': true},
            },
          ],
        };
      case 'sessions.refresh':
        return <String, Object?>{
          'sessions': <Object?>[
            _sessionJson(_tethoqSessionId, 'fake'),
            _sessionJson(_nativeSessionId, 'codex'),
          ],
        };
      case 'device.list':
        return <String, Object?>{'devices': const <Object?>[]};
      case 'message_queue.list':
        return <String, Object?>{'messages': const <Object?>[]};
      case 'side_chat.list':
      case 'delegation.list':
        return <String, Object?>{
          'sessions': const <Object?>[],
          'delegations': const <Object?>[]
        };
      case 'approval.list':
      case 'user_input.list':
        return <String, Object?>{'requests': const <Object?>[]};
      case 'dictation.source.list':
        return <String, Object?>{'sources': const <Object?>[]};
      case 'session.goal.get':
        final captured = backend.get(payload['sessionId']! as String);
        if (_goalGetGate != null) {
          _goalGetStarted!.complete();
          await _goalGetGate!.future;
          _goalGetGate = null;
          _goalGetStarted = null;
        }
        return <String, Object?>{
          'goal': captured == null ? null : Map<String, Object?>.from(captured),
        };
      case 'session.goal.set':
        final captured = Map<String, Object?>.from(
            backend.set(payload['sessionId']! as String, payload));
        if (_goalSetGate != null) {
          _goalSetStarted!.complete();
          await _goalSetGate!.future;
          _goalSetGate = null;
          _goalSetStarted = null;
        }
        return <String, Object?>{
          'goal': captured,
        };
      case 'session.goal.clear':
        if (!clearSucceeds) {
          clearSucceeds = true;
          return <String, Object?>{
            'cleared': false,
            'revision': backend.nextRevision,
          };
        }
        return <String, Object?>{
          'cleared': true,
          'revision': backend.clear(payload['sessionId']! as String),
        };
      default:
        throw StateError('Unexpected goal test request: $type');
    }
  }
}

Map<String, Object?> _sessionJson(String id, String providerId) =>
    <String, Object?>{
      'id': id,
      'hostId': 'host',
      'providerId': providerId,
      'providerSessionId': id,
      'title': 'Goal task',
      'state': 'idle',
      'lastActivityAt': '2026-08-23T12:00:00.000Z',
      'needsApproval': false,
      'stale': false,
    };

class _GoalFeatureStore extends RemoteAppStore {
  @override
  Future<SessionGoal?> loadSessionGoal(String sessionId) async =>
      goalsBySession[sessionId];

  @override
  Future<SessionGoal> setSessionGoal(
    String sessionId, {
    String? objective,
    String? status,
    int? tokenBudget,
    bool clearTokenBudget = false,
  }) async {
    final previous = goalsBySession[sessionId];
    final goal = SessionGoal.fromJson(_goalJson(
      sessionId,
      revision: (previous?.revision ?? 0) + 1,
      objective: objective ?? previous?.objective ?? 'Goal objective',
      source: previous?.source ?? 'tethoq',
      status: status ?? previous?.status ?? 'active',
    )..['tokenBudget'] =
        clearTokenBudget ? null : tokenBudget ?? previous?.tokenBudget);
    goalsBySession[sessionId] = goal;
    notifyListeners();
    return goal;
  }

  @override
  Future<void> clearSessionGoal(String sessionId) async {
    goalsBySession.remove(sessionId);
    notifyListeners();
  }

  @override
  Future<SessionContextState> loadSessionContext(String sessionId) async {
    final context = SessionContextState(
      sessionId: sessionId,
      usedTokens: null,
      contextWindowTokens: null,
      usedPercent: null,
      compactionThresholdTokens: null,
      minimumThresholdTokens: null,
      supportsManualCompaction: false,
      supportsThreshold: false,
      isCompacting: false,
      updatedAt: DateTime.utc(2026, 8, 23),
      usage: const SessionUsageTotals(),
    );
    contextBySession[sessionId] = context;
    return context;
  }

  @override
  Future<VisionProxyStatus> loadVisionProxy(String sessionId) async {
    final status = VisionProxyStatus(
      sessionId: sessionId,
      primaryModelSupportsImageInput: true,
    );
    visionBySession[sessionId] = status;
    return status;
  }
}

class _NoopRecorder implements DictationRecorder {
  @override
  Stream<double> get levelStream => const Stream<double>.empty();

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> start() async => false;

  @override
  Future<Uint8List> stop() async => Uint8List(0);
}
