import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/demo_store.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';
import 'package:universal_agent_remote/src/security.dart';
import 'package:universal_agent_remote/src/store.dart';

RemoteSession _session(String id, String directory, DateTime updatedAt) =>
    RemoteSession(
      id: id,
      hostId: 'host',
      providerId: 'fake',
      providerSessionId: id,
      title: id,
      state: 'idle',
      lastActivityAt: updatedAt,
      needsApproval: false,
      stale: false,
      workingDirectory: directory,
    );

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues(<String, String>{}));

  RemoteSession projectTask(
    String id,
    DateTime activity, {
    String state = 'idle',
    String workingDirectory = r'C:\Projects\sample-app',
  }) =>
      RemoteSession(
        id: id,
        hostId: 'demo-host',
        providerId: 'codex',
        providerSessionId: id,
        title: 'Project task $id',
        state: state,
        lastActivityAt: activity,
        needsApproval: false,
        stale: false,
        workingDirectory: workingDirectory,
      );

  test('project grouping uses full normalized folder identity', () {
    final groups = groupSessionsByProject(<RemoteSession>[
      _session('one', r'C:\work\alpha\app\', DateTime.utc(2026, 8, 24, 10)),
      _session('two', 'c:/work/alpha/app', DateTime.utc(2026, 8, 24, 11)),
      _session('three', r'C:\work\beta\app', DateTime.utc(2026, 8, 24, 12)),
      _session('four', '', DateTime.utc(2026, 8, 24, 9)),
    ]);

    expect(
        groups
            .map((group) => <Object>[
                  group.name,
                  group.sessions.map((session) => session.id).toList()
                ])
            .toList(),
        <Object>[
          <Object>[
            'app',
            <String>['three']
          ],
          <Object>[
            'app',
            <String>['one', 'two']
          ],
          <Object>[
            'No project folder',
            <String>['four']
          ],
        ]);
    expect(normalizeProjectDirectory(r'\\Server\Share\Repo\'),
        r'\\server\share\repo');
    expect(projectDirectoryName(r'C:\'), r'C:\');
    expect(projectDirectoryName('/'), '/');
  });

  test('task list mode defaults safely and persists', () async {
    final security = DeviceSecurity();
    expect(await security.readTaskListMode(), 'recent');
    await security.saveTaskListMode('project');
    expect(await DeviceSecurity().readTaskListMode(), 'project');
    await expectLater(
        security.saveTaskListMode('folders'), throwsArgumentError);
  });

  testWidgets('project mode starts with five compact rows and expands the rest',
      (tester) async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    await store.setTaskListMode('project');
    final now = DateTime.now();
    final added = List<RemoteSession>.generate(
      6,
      (index) => projectTask(
        'project-${index + 1}',
        now.subtract(Duration(minutes: index + 1)),
        state: index == 0 ? 'working' : 'idle',
      ),
    );
    store.sessions.addAll(added);
    // Deliberately select the oldest added task: it must remain reachable in
    // the bounded initial window rather than disappearing behind Show more.
    store.selectedSession = added.last;
    store.notifyListeners();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    final group = groupSessionsByProject(store.visibleSessions)
        .firstWhere((item) => item.name == 'sample-app');
    final groupFinder =
        find.byKey(ValueKey<String>('project-group-${group.key}'));
    final showMore =
        find.byKey(ValueKey<String>('project-show-more-${group.key}'));
    expect(showMore, findsOneWidget);
    expect(
      find.descendant(
          of: groupFinder, matching: find.text('${group.sessions.length}')),
      findsNothing,
      reason: 'the project heading should not expose a redundant session total',
    );
    final showMoreButton = tester.widget<TextButton>(showMore);
    final style = showMoreButton.style!;
    final restingText = style.foregroundColor!.resolve(<WidgetState>{})!;
    final hoveredText =
        style.foregroundColor!.resolve(<WidgetState>{WidgetState.hovered})!;
    expect(hoveredText.a, greaterThan(restingText.a));
    expect(style.backgroundColor!.resolve(<WidgetState>{}), Colors.transparent);
    expect(style.backgroundColor!.resolve(<WidgetState>{WidgetState.hovered}),
        Colors.transparent);
    expect(style.overlayColor!.resolve(<WidgetState>{WidgetState.hovered}),
        Colors.transparent);
    final projectRows = find.descendant(
      of: groupFinder,
      matching: find.byWidgetPredicate((widget) {
        final key = widget.key;
        return key is ValueKey<String> && key.value.startsWith('session-row-');
      }),
    );
    expect(projectRows, findsNWidgets(5));
    expect(find.byKey(ValueKey<String>('session-row-${added.last.id}')),
        findsOneWidget);
    expect(find.byKey(ValueKey<String>('session-provider-${added.first.id}')),
        findsNothing);
    expect(find.byKey(ValueKey<String>('session-time-${added.first.id}')),
        findsNothing);
    expect(find.byKey(ValueKey<String>('session-state-${added.first.id}')),
        findsOneWidget);

    await tester.tap(showMore);
    await tester.pump();
    expect(find.byKey(ValueKey<String>('project-show-more-${group.key}')),
        findsNothing);
    for (final session in group.sessions) {
      expect(find.byKey(ValueKey<String>('session-row-${session.id}')),
          findsOneWidget);
    }
  });

  testWidgets(
      'project mode counts delegated tasks for Show more while recency stays top-level',
      (tester) async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    await store.setTaskListMode('project');
    final now = DateTime.now();
    final ordinary = List<RemoteSession>.generate(
      5,
      (index) => projectTask(
        'ideas-${index + 1}',
        now.subtract(Duration(minutes: index + 1)),
        workingDirectory: r'C:\Projects\ideas-only',
      ),
    );
    final delegated = RemoteSession(
      id: 'ideas-delegated-6',
      hostId: 'demo-host',
      providerId: 'codex',
      providerSessionId: 'ideas-delegated-6',
      title: 'Delegated idea',
      state: 'idle',
      lastActivityAt: now.subtract(const Duration(minutes: 6)),
      needsApproval: false,
      stale: false,
      workingDirectory: r'C:\Projects\ideas-only',
      relationship: const SessionRelationship(
        kind: 'subagent',
        sourceSessionId: 'parent',
        strategy: 'native',
      ),
    );
    store.sessions.addAll(<RemoteSession>[...ordinary, delegated]);
    store.notifyListeners();

    expect(store.visibleSessions.any((session) => session.id == delegated.id),
        isFalse);
    expect(
        store.projectModeSessions
            .where((session) =>
                session.workingDirectory == r'C:\Projects\ideas-only')
            .length,
        6);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    final group = groupSessionsByProject(store.projectModeSessions)
        .firstWhere((item) => item.name == 'ideas-only');
    expect(find.byKey(ValueKey<String>('project-show-more-${group.key}')),
        findsOneWidget);
  });

  testWidgets('recency mode keeps the rich task rows', (tester) async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    final session = store.sessions.first;
    expect(find.byKey(ValueKey<String>('recent-task-list')), findsOneWidget);
    expect(find.byKey(ValueKey<String>('session-provider-${session.id}')),
        findsOneWidget);
    expect(find.byKey(ValueKey<String>('session-time-${session.id}')),
        findsOneWidget);
  });
}
