import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/main.dart';
import 'package:universal_agent_remote/src/app_shell.dart';
import 'package:universal_agent_remote/src/demo_store.dart';
import 'package:universal_agent_remote/src/external_system_activity.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';

void main() {
  test('external activity leases are one-shot and preserve nested leases', () {
    final coordinator = ExternalSystemActivityCoordinator();
    final heldAfterReturn = coordinator.acquire();

    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.hidden),
      isTrue,
    );
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.paused),
      isTrue,
    );
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.resumed),
      isTrue,
    );
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.hidden),
      isFalse,
      reason: 'a claimed lease cannot swallow a later Home transition',
    );
    heldAfterReturn.release();

    final outer = coordinator.acquire();
    final inner = coordinator.acquire();
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.hidden),
      isTrue,
    );
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.resumed),
      isTrue,
    );
    inner.release();
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.hidden),
      isTrue,
      reason: 'releasing a claimed nested lease must preserve the outer lease',
    );
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.resumed),
      isTrue,
    );
    outer.release();

    final detached = coordinator.acquire();
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.hidden),
      isTrue,
    );
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.detached),
      isFalse,
    );
    expect(
      coordinator.consumeLifecycleState(AppLifecycleState.resumed),
      isFalse,
      reason: 'detach terminates the pending external return',
    );
    detached.release();
  });

  testWidgets(
      'phone shell prioritizes readable tasks and keeps controls touch sized',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();

    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    expect(find.text('Dashboard'), findsOneWidget);
    expect(find.text('Tasks'), findsOneWidget);
    expect(find.text('Settings'), findsOneWidget);
    expect(find.text('Recent tasks'), findsOneWidget);
    expect(find.text('Loaded sessions'), findsNothing);
    expect(find.text('Active sessions'), findsNothing);
    expect(find.text('Running'), findsNothing);

    final taskTitle = tester.widget<Text>(find.text('Refine onboarding flow'));
    expect(taskTitle.style?.fontSize, greaterThanOrEqualTo(15));

    final recentTask =
        find.byKey(const ValueKey<String>('recent-session-demo-input'));
    expect(tester.getSize(recentTask).height, greaterThanOrEqualTo(72));
    final recentTime =
        find.byKey(const ValueKey<String>('recent-session-time-demo-input'));
    final recentState = find
        .byKey(const ValueKey<String>('recent-session-state-slot-demo-input'));
    expect(tester.getCenter(recentTime).dx,
        lessThan(tester.getCenter(recentState).dx));
    expect(tester.getSize(find.byTooltip('New task')).height,
        greaterThanOrEqualTo(44));
    expect(
      tester
          .getSize(find.ancestor(
            of: find.text('View all'),
            matching: find.byType(TextButton),
          ))
          .height,
      greaterThanOrEqualTo(44),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'recent task sub-agent marker keeps its icon and count separate on a narrow phone',
      (tester) async {
    tester.view.physicalSize = const Size(320, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();

    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    final row = find.byKey(
      const ValueKey<String>('recent-session-demo-working'),
    );
    final button = find.byKey(
      const ValueKey<String>('recent-session-agents-demo-working'),
    );
    final icon = find.byKey(
      const ValueKey<String>('recent-session-agents-icon-demo-working'),
    );
    final count = find.byKey(
      const ValueKey<String>('recent-session-agents-count-demo-working'),
    );

    expect(row, findsOneWidget);
    expect(button, findsOneWidget);
    expect(button.hitTestable(), findsOneWidget);
    expect(icon, findsOneWidget);
    expect(count, findsOneWidget);

    final rowRect = tester.getRect(row);
    final buttonRect = tester.getRect(button);
    final iconRect = tester.getRect(icon);
    final countRect = tester.getRect(count);

    expect(buttonRect.width, greaterThanOrEqualTo(44));
    expect(buttonRect.height, greaterThanOrEqualTo(44));
    expect(
      countRect.left - iconRect.right,
      greaterThanOrEqualTo(3),
      reason: 'the delegated-agent count must not obscure its icon',
    );
    expect(buttonRect.contains(iconRect.topLeft), isTrue);
    expect(buttonRect.contains(iconRect.bottomRight), isTrue);
    expect(buttonRect.contains(countRect.topLeft), isTrue);
    expect(buttonRect.contains(countRect.bottomRight), isTrue);
    expect(rowRect.contains(iconRect.center), isTrue);
    expect(rowRect.contains(countRect.center), isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('agents use compact state signals without status prose',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    final codex = store.providers.first;
    store.providers[0] = ProviderConnection(
      providerId: codex.providerId,
      displayName: codex.displayName,
      state: 'offline',
      detected: false,
      authenticated: false,
      capabilities: codex.capabilities,
    );

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: AgentsScreen()),
    ));

    expect(find.text('Available on this computer'), findsNothing);
    expect(find.text('Not detected'), findsNothing);
    expect(find.text('Online'), findsNothing);
    expect(find.byKey(const ValueKey<String>('status-signal-online')),
        findsNWidgets(store.providers.length - 1));
    expect(find.byKey(const ValueKey<String>('status-signal-offline')),
        findsNothing);

    final codexRow = find.byKey(const ValueKey<String>('agent-row-codex'));
    expect(tester.getSize(codexRow).height, 68);
    final codexTitle = tester.widget<Text>(find.text('Codex'));
    expect(codexTitle.style?.fontSize, greaterThanOrEqualTo(16));
    expect(tester.takeException(), isNull);
  });

  testWidgets('foreground recovery runs once after a real background frame',
      (tester) async {
    final store = _LifecycleStore();
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(store.resumeCalls, 0,
        reason: 'an inactive-only system overlay is not a background return');

    final releasedBeforeResume = externalSystemActivity.acquire();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    releasedBeforeResume.release();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(store.resumeCalls, 0,
        reason: 'a picker return stays classified after its lease is released');
    expect(store.flushCalls, 1,
        reason:
            'a picker skips foreground recovery but must durably flush drafts in case Android kills the covered app');

    final heldAfterResume = externalSystemActivity.acquire();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(store.resumeCalls, 0,
        reason: 'a claimed lease held after resume stays tied to that return');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    heldAfterResume.release();
    expect(store.resumeCalls, 0,
        reason: 'recovery must wait until the resumed UI paints');

    await tester.pump();
    expect(store.resumeCalls, 1);
    await tester.pump();
    expect(store.resumeCalls, 1,
        reason: 'duplicate resumed signals must stay coalesced');
  });

  testWidgets('detached terminates an overlay return and recovers on reattach',
      (tester) async {
    final store = _LifecycleStore(flushFailuresRemaining: 1);
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    final lease = externalSystemActivity.acquire();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.detached);
    await tester.pump();
    expect(store.flushCalls, 1);

    lease.release();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    expect(store.resumeCalls, 0,
        reason: 'reattach recovery must wait for cached UI to paint');
    await tester.pump();
    expect(store.resumeCalls, 1);

    await tester.pump(const Duration(seconds: 1));
    expect(store.flushCalls, 1,
        reason: 'reattach must leave and cancel the failed flush epoch');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(store.resumeCalls, 2,
        reason: 'detach must not strand later background recovery');
  });

  testWidgets(
      'failed background draft flush retries without another lifecycle event',
      (tester) async {
    final store = _LifecycleStore(flushFailuresRemaining: 1);
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(store.flushCalls, 1,
        reason: 'hidden and paused must share one in-flight flush');

    await tester.pump();
    await tester.pump(const Duration(milliseconds: 99));
    expect(store.flushCalls, 1, reason: 'the retry must use a backoff');

    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump();
    expect(store.flushCalls, 2);
    expect(store.successfulFlushes, 1);

    await tester.pump(const Duration(seconds: 1));
    expect(store.flushCalls, 2,
        reason: 'a successful retry must not create a polling loop');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
  });

  testWidgets('background draft flush retries stay bounded after all failures',
      (tester) async {
    final store = _LifecycleStore(flushFailuresRemaining: 10);
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump();
    expect(store.flushCalls, 3);
    expect(store.successfulFlushes, 0);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump(const Duration(seconds: 2));
    expect(store.flushCalls, 3,
        reason: 'duplicate lifecycle signals cannot restart exhausted retries');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
  });

  testWidgets('scheduled recovery never crosses a store replacement',
      (tester) async {
    final first = _LifecycleStore();
    final second = _LifecycleStore();
    addTearDown(first.dispose);
    addTearDown(second.dispose);
    await first.initialize();
    await second.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: first));

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpWidget(UniversalAgentRemoteApp(store: second));
    expect(first.resumeCalls, 0);
    expect(second.resumeCalls, 0,
        reason: 'a resume captured for store A cannot run against store B');

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(first.resumeCalls, 0);
    expect(second.resumeCalls, 1);
  });

  testWidgets('store replacement detaches an unresolved background flush',
      (tester) async {
    final first = _LifecycleStore(holdFlushOperations: true);
    final second = _LifecycleStore(holdFlushOperations: true);
    addTearDown(first.dispose);
    addTearDown(second.dispose);
    await first.initialize();
    await second.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: first));

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    expect(first.flushCalls, 1);

    await tester.pumpWidget(UniversalAgentRemoteApp(store: second));
    expect(second.flushCalls, 1,
        reason: 'store B must flush without waiting for unresolved store A');

    first.completeNextFlush(error: StateError('late store A failure'));
    await tester.pump();
    expect(second.flushCalls, 1,
        reason: 'late store A completion cannot mutate store B retry state');

    second.completeNextFlush();
    await tester.pump();
    expect(second.successfulFlushes, 1);

    first.holdFlushOperations = false;
    second.holdFlushOperations = false;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
  });

  testWidgets('foreground recoveries serialize to one latest trailing run',
      (tester) async {
    final store = _LifecycleStore(holdResumeOperations: true);
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    _backgroundAndResume(tester);
    await tester.pump();
    expect(store.resumeCalls, 1);
    expect(store.activeResumeCalls, 1);

    _backgroundAndResume(tester);
    await tester.pump();
    _backgroundAndResume(tester);
    await tester.pump();
    expect(store.resumeCalls, 1,
        reason: 'overlapping recoveries must remain single-flight');

    store.completeNextResume();
    await tester.pump();
    expect(store.resumeCalls, 2,
        reason: 'only the latest queued recovery should trail the first');
    expect(store.maximumConcurrentResumeCalls, 1);

    store.completeNextResume();
    await tester.pump();
    expect(store.resumeCalls, 2);
    expect(store.activeResumeCalls, 0);
    expect(store.maximumConcurrentResumeCalls, 1);
  });

  testWidgets('rapid dashboard taps open only one task route', (tester) async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    final target =
        find.byKey(const ValueKey<String>('recent-session-demo-input'));
    final row = tester.widget<InkWell>(target);
    row.onTap!();
    row.onTap!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(SessionScreen), findsOneWidget);
    await tester.pageBack();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    tester.widget<InkWell>(target).onTap!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(SessionScreen), findsOneWidget,
        reason: 'the guard must release after the first route closes');
    await tester.pageBack();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
  });
}

void _backgroundAndResume(WidgetTester tester) {
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
  tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
}

class _LifecycleStore extends DemoRemoteAppStore {
  _LifecycleStore({
    this.flushFailuresRemaining = 0,
    this.holdFlushOperations = false,
    this.holdResumeOperations = false,
  });

  int resumeCalls = 0;
  int activeResumeCalls = 0;
  int maximumConcurrentResumeCalls = 0;
  int flushCalls = 0;
  int successfulFlushes = 0;
  int flushFailuresRemaining;
  bool holdFlushOperations;
  bool holdResumeOperations;
  final List<Completer<void>> _pendingFlushes = <Completer<void>>[];
  final List<Completer<void>> _pendingResumes = <Completer<void>>[];

  @override
  Future<void> resumeFromBackground() async {
    resumeCalls += 1;
    activeResumeCalls += 1;
    if (activeResumeCalls > maximumConcurrentResumeCalls) {
      maximumConcurrentResumeCalls = activeResumeCalls;
    }
    try {
      if (holdResumeOperations) {
        final completer = Completer<void>();
        _pendingResumes.add(completer);
        await completer.future;
      }
    } finally {
      activeResumeCalls -= 1;
    }
  }

  @override
  Future<void> flushDraftJournal({bool runMaintenance = true}) async {
    flushCalls += 1;
    if (holdFlushOperations) {
      final completer = Completer<void>();
      _pendingFlushes.add(completer);
      await completer.future;
    }
    if (flushFailuresRemaining > 0) {
      flushFailuresRemaining -= 1;
      throw StateError('simulated journal write failure');
    }
    successfulFlushes += 1;
  }

  void completeNextFlush({Object? error}) {
    final completer = _pendingFlushes.removeAt(0);
    if (error == null) {
      completer.complete();
    } else {
      completer.completeError(error, StackTrace.current);
    }
  }

  void completeNextResume() {
    _pendingResumes.removeAt(0).complete();
  }
}
