import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/demo_store.dart';
import 'package:universal_agent_remote/src/desktop_wake.dart';
import 'package:universal_agent_remote/src/desktop_wake_dialog.dart';
import 'package:universal_agent_remote/src/screens.dart';
import 'package:universal_agent_remote/src/transport.dart';

void main() {
  test('already-running Desktop does not send a duplicate wake request',
      () async {
    final calls = <String>[];
    final coordinator = DesktopWakeCoordinator(
      request: (type, payload, {required timeout}) async {
        calls.add(type);
        expect(payload, isEmpty);
        return <String, Object?>{'state': 'running'};
      },
    );

    final result = await coordinator.wake();

    expect(result.state, DesktopAppState.running);
    expect(result.alreadyRunning, isTrue);
    expect(result.launched, isFalse);
    expect(calls, <String>['desktop.status']);
  });

  test('stopped Desktop wakes once and readiness polling stays bounded',
      () async {
    final calls = <String>[];
    var statusCalls = 0;
    final coordinator = DesktopWakeCoordinator(
      readinessTimeout: const Duration(seconds: 2),
      pollInterval: const Duration(seconds: 1),
      delay: (_) async {},
      request: (type, payload, {required timeout}) async {
        calls.add(type);
        expect(payload, isEmpty);
        if (type == 'desktop.wake') {
          return <String, Object?>{'state': 'starting', 'launched': true};
        }
        statusCalls += 1;
        return <String, Object?>{
          'state': statusCalls < 3 ? 'stopped' : 'running',
        };
      },
    );

    final result = await coordinator.wake();

    expect(result.state, DesktopAppState.running);
    expect(result.alreadyRunning, isFalse);
    expect(result.launched, isTrue);
    expect(calls, <String>[
      'desktop.status',
      'desktop.wake',
      'desktop.status',
      'desktop.status'
    ]);
    expect(calls.where((call) => call == 'desktop.wake'), hasLength(1));
  });

  test('readiness timeout never repeats the wake request', () async {
    final calls = <String>[];
    final coordinator = DesktopWakeCoordinator(
      readinessTimeout: const Duration(seconds: 2),
      pollInterval: const Duration(seconds: 1),
      delay: (_) async {},
      request: (type, payload, {required timeout}) async {
        calls.add(type);
        return type == 'desktop.wake'
            ? <String, Object?>{'state': 'starting', 'launched': true}
            : <String, Object?>{'state': 'stopped'};
      },
    );

    await expectLater(
        coordinator.wake(), throwsA(isA<DesktopWakeTimeoutException>()));
    expect(calls.where((call) => call == 'desktop.wake'), hasLength(1));
    expect(calls.where((call) => call == 'desktop.status'), hasLength(3));
  });

  testWidgets('wake card shows opening state and a clean success state',
      (tester) async {
    final completion = Completer<DesktopWakeResult>();
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(useMaterial3: true),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => DesktopWakeDialog(
                onWake: () => completion.future,
              ),
            ),
            child: const Text('Open'),
          ),
        ),
      ),
    ));

    await tester.tap(find.text('Open'));
    await tester.pump();
    expect(find.text('Opening Tethoq on your PC'), findsOneWidget);
    expect(find.byKey(const Key('desktop-wake-spinner')), findsOneWidget);

    completion.complete(const DesktopWakeResult(
      state: DesktopAppState.running,
      launched: true,
      alreadyRunning: false,
    ));
    await tester.pump();

    expect(find.text('Tethoq is open'), findsOneWidget);
    expect(find.byKey(const Key('desktop-wake-success')), findsOneWidget);
    expect(find.text('Done'), findsOneWidget);
  });

  testWidgets('standalone Bridge explains that Desktop is optional',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: ThemeData.dark(useMaterial3: true),
      home: DesktopWakeDialog(
        onWake: () async => throw const BridgeRequestException(
          'DESKTOP_NOT_INSTALLED',
          'Desktop is not installed',
          retryable: false,
        ),
      ),
    ));
    await tester.pump();

    expect(find.text('Tethoq Desktop is not installed'), findsOneWidget);
    expect(find.textContaining('Bridge can still run your phone sessions'),
        findsOneWidget);
    expect(find.text('Try again'), findsNothing);
    expect(find.text('Close'), findsOneWidget);
  });

  testWidgets('session actions expose an explicit desktop launch command',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    final session = store.sessions.first;
    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();

    expect(find.text('Open on PC'), findsNothing);
    await tester.tap(find.byKey(const Key('session-actions-menu')));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('Open on PC'), findsOneWidget);
  });
}
