import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/app_shell.dart';
import 'package:universal_agent_remote/src/demo_store.dart';
import 'package:universal_agent_remote/src/dictation.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';

const _sessionId = 'demo-complete';

void main() {
  setUpAll(() async {
    // Optional real fonts for local painted QA; normal CI uses Flutter's test font.
    const directory = String.fromEnvironment('MOBILE_PERF_FONT_DIR');
    if (directory.isEmpty) return;
    for (final entry in {
      'Roboto': ['roboto-regular.ttf', 'roboto-medium.ttf', 'roboto-bold.ttf'],
      'MaterialIcons': ['materialicons-regular.otf'],
    }.entries) {
      final loader = FontLoader(entry.key);
      for (final name in entry.value) {
        loader.addFont(
            File('$directory/$name').readAsBytes().then(ByteData.sublistView));
      }
      await loader.load();
    }
  });

  test('live snapshots track text, reasoning, completion and a new turn',
      () async {
    final store = _PerformanceStore();
    addTearDown(store.dispose);
    await store.initialize();
    var sequence = 0;
    void emit(String type, Map<String, Object?> payload) {
      sequence++;
      store.applyEventForTesting(AgentEvent(
        eventId: 'snapshot-$sequence',
        sequence: sequence,
        type: type,
        sessionId: _sessionId,
        providerId: 'opencode',
        occurredAt:
            DateTime.utc(2026, 9, 10, 12).add(Duration(seconds: sequence)),
        payload: payload,
      ));
    }

    emit('message.delta', {'text': 'First answer'});
    final first = store.liveAssistantMessageFor(_sessionId)!;
    expect(store.liveAssistantMessageFor(_sessionId), same(first));
    emit('message.delta', {'text': 'Thinking', 'phase': 'commentary'});
    final reasoning = store.liveAssistantMessageFor(_sessionId)!;
    expect(reasoning, isNot(same(first)));
    expect(reasoning.parts.map((part) => part.summary),
        ['Thinking', 'First answer']);
    expect(first.parts.single.summary, 'First answer');
    emit('message.completed', {'text': 'First answer finished'});
    expect(store.liveAssistantMessageFor(_sessionId), isNull);
    expect(store.messages[_sessionId]!.last.parts.last.summary,
        'First answer finished');
    emit('message.started', {'text': 'First answer'});
    final next = store.liveAssistantMessageFor(_sessionId)!;
    expect(next, isNot(same(first)));
    expect(next.createdAt, isNot(first.createdAt));
    expect(next.parts.single.summary, 'First answer');
    emit('agent.interrupted', {});
    expect(store.liveAssistantMessageFor(_sessionId), isNull);
  });

  testWidgets('cached history refreshes replacements, prepends and removals',
      (tester) async {
    tester.view.physicalSize = const Size(430, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _PerformanceStore();
    addTearDown(store.dispose);
    await store.initialize();
    final history = <RemoteMessage>[_message(1)];
    store.messages[_sessionId] = history;
    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
          home: SessionScreen(
        sessionId: _sessionId,
        dictationRecorder: _NoopRecorder(),
      )),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Answer 1'), findsOneWidget);
    final original = history.single;
    history[0] = RemoteMessage(
      id: original.id,
      sessionId: original.sessionId,
      role: original.role,
      createdAt: original.createdAt,
      status: original.status,
      parts: const [
        ContentPart(type: 'text', data: {'text': 'Edited answer'})
      ],
    );
    store.pulse();
    await tester.pump();
    expect(find.text('Answer 1'), findsNothing);
    expect(find.text('Edited answer'), findsOneWidget);
    history.insert(0, _message(0));
    store.pulse();
    await tester.pump();
    expect(tester.getTopLeft(find.text('Check the behaviour of item 0.')).dy,
        lessThan(tester.getTopLeft(find.text('Edited answer')).dy));
    history.removeLast();
    store.pulse();
    await tester.pump();
    expect(find.text('Edited answer'), findsNothing);
    expect(find.text('Check the behaviour of item 0.'), findsOneWidget);
    history.clear();
    store.pulse();
    await tester.pump();
    expect(find.text('No messages yet.'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('unchanged Markdown survives live updates in a long mobile chat',
      (tester) async {
    tester.view.physicalSize = const Size(430, 850);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _PerformanceStore();
    addTearDown(store.dispose);
    await store.initialize();
    store.messages[_sessionId] = List.generate(120, _message);
    final boundaryKey = GlobalKey();
    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: RepaintBoundary(
          key: boundaryKey,
          child: SessionScreen(
            sessionId: _sessionId,
            dictationRecorder: _NoopRecorder(),
          ),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    await _capture(tester, boundaryKey, 'conversation');

    // A retained Markdown span must not be reparsed just because another
    // message streams. This checks actual renderer reuse, not wall-clock speed.
    final retainedText = find.byWidgetPredicate((widget) =>
        widget is SelectableText &&
        widget.textSpan?.toPlainText().contains('Answer 119') == true);
    expect(retainedText, findsOneWidget);
    final before = tester.widget<SelectableText>(retainedText).textSpan;
    final samples = <int>[];
    for (var index = 0; index < 30; index++) {
      final stopwatch = Stopwatch()..start();
      store.applyEventForTesting(AgentEvent(
        eventId: 'perf-delta-$index',
        sequence: index + 1,
        type: 'message.delta',
        sessionId: _sessionId,
        providerId: 'opencode',
        occurredAt: DateTime.utc(2026, 9, 10, 12),
        payload: <String, Object?>{'text': 'Live reply $index'},
      ));
      await tester.pump(const Duration(milliseconds: 20));
      stopwatch.stop();
      samples.add(stopwatch.elapsedMicroseconds);
    }
    samples.sort();
    // Diagnostic only: absolute test-runner timings are not phone frame times.
    debugPrint('MOBILE_PERF streaming 120 messages: '
        'median=${samples[15]}us p95=${samples[28]}us');
    expect(find.textContaining('Live reply 29'), findsWidgets);
    expect(tester.widget<SelectableText>(retainedText).textSpan, same(before));
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('hidden mobile tabs retain state without rebuilding on updates',
      (tester) async {
    tester.view.physicalSize = const Size(430, 850);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _PerformanceStore();
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: AppShell()),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(SessionsScreen, skipOffstage: false), findsNothing);
    await tester.tap(find.text('Tasks'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    final taskElement = tester.element(find.byType(SessionsScreen));
    await tester.tap(find.text('Dashboard'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    var hiddenBuilds = 0;
    final previousCallback = debugOnRebuildDirtyWidget;
    debugOnRebuildDirtyWidget = (element, builtOnce) {
      previousCallback?.call(element, builtOnce);
      if (element.widget is SessionsScreen || element.widget is HostsScreen) {
        hiddenBuilds++;
      }
    };
    addTearDown(() => debugOnRebuildDirtyWidget = previousCallback);
    store.pulse();
    await tester.pump();
    expect(hiddenBuilds, 0);
    debugOnRebuildDirtyWidget = previousCallback;

    store.sessions.removeWhere((session) => session.id == _sessionId);
    store.pulse();
    await tester.pump();
    await tester.tap(find.text('Tasks'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.element(find.byType(SessionsScreen)), same(taskElement));
    expect(find.text('Fix authentication regression'), findsNothing);
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(navigator.push(MaterialPageRoute<void>(
      builder: (_) => const Scaffold(body: Text('Covering route')),
    )));
    await tester.pumpAndSettle();
    hiddenBuilds = 0;
    debugOnRebuildDirtyWidget = (element, builtOnce) {
      if (element.widget is SessionsScreen ||
          element.widget is DashboardScreen) {
        hiddenBuilds++;
      }
    };
    store.pulse();
    await tester.pump();
    expect(hiddenBuilds, 0);
    debugOnRebuildDirtyWidget = previousCallback;
    navigator.pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(tester.element(find.byType(SessionsScreen)), same(taskElement));
    expect(tester.takeException(), isNull);
  });
}

RemoteMessage _message(int index) => RemoteMessage(
      id: 'perf-$index',
      sessionId: _sessionId,
      role: index.isEven ? 'user' : 'assistant',
      createdAt: DateTime.utc(2026, 9, 10).add(Duration(seconds: index)),
      status: 'completed',
      parts: <ContentPart>[
        ContentPart(type: 'text', data: <String, Object?>{
          'text': index.isEven
              ? 'Check the behaviour of item $index.'
              : '**Answer $index**\n\nThe result preserves the existing behaviour '
                  'and keeps the conversation readable.\n\n'
                  '- Keep message order\n- Preserve the draft',
        }),
      ],
    );

class _PerformanceStore extends DemoRemoteAppStore {
  void pulse() => notifyListeners();
}

class _NoopRecorder implements DictationRecorder {
  @override
  Future<bool> start() async => false;
  @override
  Future<Uint8List> stop() async => Uint8List(0);
  @override
  Future<void> cancel() async {}
  @override
  Future<void> dispose() async {}
  @override
  Stream<double> get levelStream => const Stream<double>.empty();
}

Future<void> _capture(WidgetTester tester, GlobalKey key, String name) async {
  const directory = String.fromEnvironment('MOBILE_PERF_ARTIFACT_DIR');
  if (directory.isEmpty) return;
  await tester.runAsync(() async {
    final boundary =
        key.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage();
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(directory).create(recursive: true);
      await File('$directory/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  });
}
