import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/main.dart';
import 'package:universal_agent_remote/src/app_shell.dart';
import 'package:universal_agent_remote/src/demo_store.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';

void main() {
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
}
