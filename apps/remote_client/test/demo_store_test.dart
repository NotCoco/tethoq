import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/main.dart';
import 'package:universal_agent_remote/src/app_shell.dart';
import 'package:universal_agent_remote/src/app_theme.dart';
import 'package:universal_agent_remote/src/demo_store.dart';
import 'package:universal_agent_remote/src/dictation.dart';
import 'package:universal_agent_remote/src/ears.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';
import 'package:universal_agent_remote/src/security.dart';
import 'package:universal_agent_remote/src/store.dart';
import 'package:universal_agent_remote/src/transport.dart';

void main() {
  test('demo session tap selects without invoking bridge history loading',
      () async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    final session = store.sessions.first;

    store.openSessionForView(session);

    expect(store.selectedSession?.id, session.id);
    expect(store.isSessionHistoryLoading(session.id), isFalse);
  });

  test('neutral provider themes are achromatic and keep distinct dark bases',
      () {
    expect(
        HSVColor.fromColor(codexVisualTheme.accent).saturation, lessThan(0.03));
    expect(HSVColor.fromColor(openCodeVisualTheme.accent).saturation,
        lessThan(0.1));
    expect(HSVColor.fromColor(grokVisualTheme.accent).saturation, 0);
    expect(HSVColor.fromColor(allHarnessesVisualTheme.accent).saturation, 0);
    expect(grokVisualTheme.background, const Color(0xff000000));
    expect(grokVisualTheme.accent, const Color(0xffffffff));
    expect(allHarnessesVisualTheme.background, const Color(0xff0a0a0a));
    expect(allHarnessesVisualTheme.surface.computeLuminance(),
        greaterThan(grokVisualTheme.surface.computeLuminance()));
    expect(allHarnessesVisualTheme.accent.computeLuminance(),
        lessThan(grokVisualTheme.accent.computeLuminance()));
    expect(openCodeVisualTheme.surface, isNot(codexVisualTheme.surface));
  });

  test('demo store initializes and supports UI interactions without a bridge',
      () async {
    final store = DemoRemoteAppStore();

    await store.initialize();

    expect(store.initialized, isTrue);
    expect(store.hasHosts, isTrue);
    expect(store.connectionState, BridgeConnectionState.online);
    expect(store.sessions, isNotEmpty);
    expect(store.providers, isNotEmpty);

    final session = store.sessions.first;
    await store.openSession(session);
    await store.sendMessage(session.id, 'Preview this interaction');

    expect(store.messages[session.id]!.last.parts.single.summary,
        contains('local preview response'));
  });

  testWidgets('demo mode opens the real dashboard instead of pairing',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();

    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    expect(find.text('Dashboard'), findsOneWidget);
    expect(find.text('Tasks'), findsOneWidget);
    expect(find.byKey(const Key('selected-tab-indicator')), findsNothing);
    expect(find.text('Pair a development computer'), findsNothing);
    expect(find.text('Improve search indexing'), findsNWidgets(2));
    expect(find.byKey(const Key('active-session-spinner')), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.text('THINKING'), findsNothing);
    expect(find.text('Loaded sessions'), findsNothing);
    expect(find.text('CLI sessions'), findsNothing);
    expect(
        find.byKey(
            const ValueKey<String>('recent-session-spinner-demo-working')),
        findsOneWidget);
    expect(find.text('Review attachment rendering'), findsNothing);
  });

  testWidgets('app root ignores store updates that do not change app chrome',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    var materialAppBuilds = 0;

    await tester.pumpWidget(UniversalAgentRemoteApp(
      store: store,
      materialAppBuilder: (home) {
        materialAppBuilds += 1;
        return MaterialApp(home: home);
      },
    ));
    expect(materialAppBuilds, 1);

    store.setFilters(search: 'does not affect app chrome');
    await tester.pump();
    expect(materialAppBuilds, 1);

    store.selectProvider('opencode');
    await tester.pump();
    expect(materialAppBuilds, 2);
  });

  testWidgets('inactive app tabs disable their tickers', (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    final tickerModes = find.byWidgetPredicate((widget) => widget is TickerMode,
        skipOffstage: false);
    TickerMode tickerFor(Finder page) => tester.widget<TickerMode>(
        find.ancestor(of: page, matching: tickerModes).first);

    expect(tickerFor(find.byType(DashboardScreen)).enabled, isTrue);
    expect(find.byType(SessionsScreen, skipOffstage: false), findsNothing);

    tester
        .widget<NavigationBar>(find.byType(NavigationBar))
        .onDestinationSelected!(1);
    await tester.pump();

    expect(tickerFor(find.byType(DashboardScreen, skipOffstage: false)).enabled,
        isFalse);
    expect(tickerFor(find.byType(SessionsScreen)).enabled, isTrue);

    tester
        .widget<NavigationBar>(find.byType(NavigationBar))
        .onDestinationSelected!(0);
    await tester.pump();
    expect(tickerFor(find.byType(SessionsScreen, skipOffstage: false)).enabled,
        isFalse);
  });

  testWidgets('tablet layout uses a rail and keeps dashboard content bounded',
      (tester) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();

    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    expect(find.byKey(const Key('adaptive-navigation-rail')), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('compact phone tolerates large accessibility text',
      (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();

    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(
        size: Size(360, 640),
        textScaler: TextScaler.linear(1.5),
      ),
      child: UniversalAgentRemoteApp(store: store),
    ));

    expect(tester.takeException(), isNull);
    expect(find.text('Dashboard'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey<String>('recent-session-demo-input')),
        matching: find.textContaining('ago'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('recent session opens before slow history finishes loading',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    final session =
        store.sessions.firstWhere((item) => item.id == 'demo-working');
    store.beginSessionHistoryLoadForTesting(session.id);
    addTearDown(() => store.endSessionHistoryLoadForTesting(session.id));

    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));
    final recentSession =
        find.byKey(const ValueKey<String>('recent-session-demo-working'));
    final recentInk = tester.widget<InkWell>(recentSession);
    expect(recentInk.overlayColor?.resolve(<WidgetState>{WidgetState.pressed}),
        isNotNull);
    recentInk.onTap!();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.byType(SessionScreen), findsOneWidget);
    expect(find.byKey(const Key('session-history-loading')), findsOneWidget);

    store.endSessionHistoryLoadForTesting(session.id);
    await tester.pump();
    expect(find.byKey(const Key('session-history-loading')), findsNothing);
  });

  testWidgets('new chat auto-fills the provider default model', (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    final session = await store.startPreparedSession('opencode');

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('Default OpenCode model'), findsOneWidget);
    expect(find.text('Model'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Agent defaults choose reasoning for future phone tasks',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    final store = DemoRemoteAppStore();
    await store.initialize();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: HostsScreen()),
    ));
    await tester.tap(find.byKey(const Key('settings-section-agent-defaults')));
    await tester.pumpAndSettle();

    final codex = find.byKey(const Key('agent-default-codex'));
    await tester.ensureVisible(codex);
    await tester.tap(codex);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('catalog-codex-gpt-5.6-sol')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('agent-default-reasoning-ultra')));
    await tester.pumpAndSettle();

    expect(store.agentDefaults['codex']?.modelId, 'gpt-5.6-sol');
    expect(store.agentDefaults['codex']?.reasoningEffort, 'ultra');
    final prepared = await store.startPreparedSession('codex');
    expect(prepared.modelId, 'gpt-5.6-sol');
    expect(prepared.reasoningEffort, 'ultra');
  });

  testWidgets('conversation surfaces a transcript loading error',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    store.messages[sessionId] = <RemoteMessage>[];
    store.error = 'Could not load this transcript';

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(find.byKey(const Key('session-history-error')), findsOneWidget);
    expect(find.text('Could not load this transcript'), findsOneWidget);
    expect(find.text('No messages yet.'), findsNothing);
  });

  testWidgets('a Grok project-name fallback is labelled as untitled',
      (tester) async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    final index = store.sessions.indexWhere((item) => item.id == 'demo-failed');
    final grokSession = store.sessions[index];
    store.sessions[index] = grokSession.copyWith(title: grokSession.project);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(
        home: SessionScreen(sessionId: 'demo-failed'),
      ),
    ));
    await tester.pump();

    expect(find.text('Untitled Grok session'), findsOneWidget);
    expect(find.text('Desktop client'), findsNothing);
  });

  testWidgets(
      'reaching the conversation top prepends older history without losing the reading position',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _PagedHistoryDemoStore();
    addTearDown(store.dispose);
    await store.initialize();
    store.seedRecentHistory();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(
        home: SessionScreen(sessionId: _PagedHistoryDemoStore.sessionId),
      ),
    ));
    await tester.pump();
    await tester.pump();

    final transcript = find.descendant(
      of: find.byType(SessionScreen),
      matching: find.byType(ListView),
    );
    expect(transcript, findsOneWidget);
    final controller = tester.widget<ListView>(transcript).controller!;
    final previousMaxExtent = controller.position.maxScrollExtent;
    expect(previousMaxExtent, greaterThan(300));
    expect(previousMaxExtent - controller.position.pixels, lessThan(96));

    controller.jumpTo(0);
    await tester.pump();
    expect(store.olderHistoryLoads, 1);
    final recentMessage = find.textContaining('Recent history 01');
    expect(recentMessage, findsOneWidget);
    final recentMessageTop = tester.getTopLeft(recentMessage).dy;

    store.releaseOlderHistory();
    await tester.pumpAndSettle();

    expect(store.messages[_PagedHistoryDemoStore.sessionId]!.first.id,
        'older-history-01');
    final addedExtent = controller.position.maxScrollExtent - previousMaxExtent;
    expect(addedExtent, greaterThan(100));
    expect(controller.position.pixels, greaterThan(100));
    expect(tester.getTopLeft(recentMessage).dy, closeTo(recentMessageTop, 96));

    controller.jumpTo(0);
    await tester.pump();
    expect(find.textContaining('Older history 01'), findsOneWidget);
    expect(store.olderHistoryLoads, 1);
  });

  testWidgets(
      'active dashboard line follows live commentary without stale preview',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-working';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'dashboard-reasoning',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 11),
        parts: const <ContentPart>[
          ContentPart(
              type: 'reasoning',
              data: <String, Object?>{'text': '**Checking old state**'})
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    expect(find.text('Improve search indexing'), findsNWidgets(2));
    expect(find.text('Checking old state'), findsOneWidget);
    expect(find.textContaining('preserving existing search behavior'),
        findsNothing);
    expect(find.byKey(const Key('active-session-thinking')), findsOneWidget);
    expect(
        find.descendant(
          of: find.byKey(const Key('active-session-thinking')),
          matching: find.byType(ShaderMask),
        ),
        findsOneWidget);

    store.applyEventForTesting(AgentEvent(
      eventId: 'dashboard-live-commentary',
      sequence: 12,
      type: 'message.delta',
      occurredAt: DateTime.utc(2026, 8, 11, 11, 1),
      sessionId: sessionId,
      providerId: 'codex',
      payload: const <String, Object?>{
        'phase': 'commentary',
        'partType': 'text',
        'text': 'Inspecting live event handling',
      },
    ));
    await tester.pump(const Duration(milliseconds: 25));

    expect(find.text('Inspecting live event handling'), findsOneWidget);
    expect(find.text('Checking old state'), findsNothing);

    store.selectProvider('opencode');
    await tester.pump();
    expect(find.text('OpenCode is working…'), findsOneWidget);
    expect(find.text('Scanning the homepage flow and applying the button fix.'),
        findsNothing);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('recent sessions show unread with a fixed semantic blue dot',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    store.unreadSessionIds.add('demo-working');

    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    final dot = tester.widget<Container>(
        find.byKey(const ValueKey<String>('unread-dot-demo-working')));
    final decoration = dot.decoration! as BoxDecoration;
    expect(decoration.color, const Color(0xff4c9aff));

    final menu = tester.widget<PopupMenuButton<String>>(
        find.byKey(const Key('recent-sessions-menu')));
    final menuItems = menu.itemBuilder(
        tester.element(find.byKey(const Key('recent-sessions-menu'))));
    final markReadItem = menuItems.single as PopupMenuItem<String>;
    expect((markReadItem.child! as Text).data, 'Mark all as read');
    menu.onSelected!('mark-read');
    await tester.pump();
    expect(find.byKey(const ValueKey<String>('unread-dot-demo-working')),
        findsNothing);
    expect(find.byKey(const Key('recent-sessions-menu')), findsOneWidget);
    final clearedMenu = tester.widget<PopupMenuButton<String>>(
        find.byKey(const Key('recent-sessions-menu')));
    final clearedItem = clearedMenu
        .itemBuilder(
            tester.element(find.byKey(const Key('recent-sessions-menu'))))
        .single as PopupMenuItem<String>;
    expect(clearedItem.enabled, isFalse);
  });

  testWidgets('all agents is first and aggregates provider tasks',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pump(const Duration(milliseconds: 300));

    final dropdown = tester.widget<DropdownButton<String>>(
        find.byType(DropdownButton<String>).first);
    expect(dropdown.items!.first.value, 'all');

    await tester.tap(find.text('All agents').last);
    await tester.pump(const Duration(milliseconds: 300));

    expect(store.selectedProviderId, 'all');
    expect(find.text('All agents'), findsOneWidget);
    expect(find.text('Ship the landing page'), findsOneWidget);
  });

  testWidgets('provider choice applies its preset theme', (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    await tester.pumpWidget(UniversalAgentRemoteApp(store: store));

    await tester.tap(find.byType(DropdownButton<String>));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('OpenCode').last);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(store.selectedProviderId, 'opencode');
    expect(find.text('Paused'), findsNothing);
    final context = tester.element(find.text('Dashboard'));
    expect(Theme.of(context).colorScheme.primary, openCodeVisualTheme.accent);
  });

  testWidgets('tasks page keeps search and filters quiet until requested',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    expect(find.text('Tasks'), findsOneWidget);
    expect(find.byKey(const Key('session-search')), findsNothing);
    expect(find.byKey(const Key('task-filter-sheet')), findsNothing);

    await tester.tap(find.byKey(const Key('task-search-toggle')));
    await tester.pump();
    expect(find.byKey(const Key('session-search')), findsOneWidget);
    await tester.tap(find.byKey(const Key('task-search-toggle')));
    await tester.pump();
    expect(find.byKey(const Key('session-search')), findsNothing);

    await tester.tap(find.byKey(const Key('task-filter-toggle')));
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byKey(const Key('task-filter-sheet')), findsOneWidget);
    final workingFilter = find.widgetWithText(ListTile, 'Working');
    await tester.ensureVisible(workingFilter);
    await tester.pump(const Duration(milliseconds: 150));
    tester.widget<ListTile>(workingFilter).onTap!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byKey(const Key('task-filter-sheet')), findsNothing);

    final providerMark =
        find.byKey(const ValueKey<String>('session-provider-demo-working'));
    expect(providerMark, findsOneWidget);
    expect(
        find.descendant(
          of: providerMark,
          matching: find.byKey(
            const ValueKey<String>('provider-logo-codex'),
          ),
        ),
        findsOneWidget);

    final workingState =
        find.byKey(const ValueKey<String>('session-state-demo-working'));
    final workingTime =
        find.byKey(const ValueKey<String>('session-time-demo-working'));
    expect(tester.getCenter(workingTime).dx,
        lessThan(tester.getCenter(workingState).dx));
    expect(
        find.descendant(of: workingState, matching: find.byType(CustomPaint)),
        findsOneWidget);
  });

  test('task agent filters use OR matching and live provider usability',
      () async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    final openCodeIndex = store.providers
        .indexWhere((provider) => provider.providerId == 'opencode');
    final openCode = store.providers[openCodeIndex];
    store.providers[openCodeIndex] = ProviderConnection(
      providerId: openCode.providerId,
      displayName: openCode.displayName,
      state: 'offline',
      detected: openCode.detected,
      authenticated: openCode.authenticated,
      capabilities: openCode.capabilities,
    );

    store.setTaskProviderFilter(availableAgentsTaskFilter);
    expect(store.providerFilters, <String>{availableAgentsTaskFilter});
    expect(
      store.visibleSessions.map((session) => session.providerId),
      isNot(contains('opencode')),
    );

    store.clearTaskProviderFilters();
    store.toggleTaskProviderFilter('codex');
    store.toggleTaskProviderFilter('grok');
    expect(store.providerFilters, <String>{'codex', 'grok'});
    final filteredProviders =
        store.visibleSessions.map((session) => session.providerId).toSet();
    expect(filteredProviders, containsAll(<String>{'codex', 'grok'}));
    expect(filteredProviders, isNot(contains('opencode')));
  });

  testWidgets(
      'task agent sheet keeps custom toggles open and single selection closes',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    final openCodeIndex = store.providers
        .indexWhere((provider) => provider.providerId == 'opencode');
    final openCode = store.providers[openCodeIndex];
    store.providers[openCodeIndex] = ProviderConnection(
      providerId: openCode.providerId,
      displayName: openCode.displayName,
      state: 'offline',
      detected: openCode.detected,
      authenticated: openCode.authenticated,
      capabilities: openCode.capabilities,
    );

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.tap(find.byKey(const Key('task-filter-toggle')));
    await tester.pump(const Duration(milliseconds: 400));

    final allAgents = find.byKey(const Key('task-filter-all-agents'));
    final availableAgents =
        find.byKey(const Key('task-filter-available-agents'));
    expect(allAgents, findsOneWidget);
    expect(availableAgents, findsOneWidget);
    expect(tester.getTopLeft(allAgents).dy,
        lessThan(tester.getTopLeft(availableAgents).dy));

    for (final filterId in <String>[
      availableAgentsTaskFilter,
      'codex',
      'opencode',
    ]) {
      final checkbox =
          find.byKey(ValueKey<String>('task-filter-checkbox-$filterId'));
      expect(tester.getSize(checkbox), const Size.square(44));
    }
    final unavailableCheckbox = tester.widget<Checkbox>(find.descendant(
      of: find.byKey(const Key('task-filter-agent-opencode')),
      matching: find.byType(Checkbox),
    ));
    expect(unavailableCheckbox.onChanged, isNull);
    final unavailableOpacity = tester.widget<Opacity>(find
        .descendant(
          of: find.byKey(const Key('task-filter-agent-opencode')),
          matching: find.byType(Opacity),
        )
        .first);
    expect(unavailableOpacity.opacity, lessThan(.5));

    tester
        .widget<Checkbox>(find.descendant(
          of: find.byKey(const Key('task-filter-agent-codex')),
          matching: find.byType(Checkbox),
        ))
        .onChanged!(true);
    await tester.pump();
    expect(find.byKey(const Key('task-filter-sheet')), findsOneWidget);
    tester
        .widget<Checkbox>(find.descendant(
          of: find.byKey(const Key('task-filter-agent-grok')),
          matching: find.byType(Checkbox),
        ))
        .onChanged!(true);
    await tester.pump();
    expect(find.byKey(const Key('task-filter-sheet')), findsOneWidget);
    expect(store.providerFilters, <String>{'codex', 'grok'});

    final grokRow = find.descendant(
      of: find.byKey(const Key('task-filter-agent-grok')),
      matching: find.byType(ListTile),
    );
    tester.widget<ListTile>(grokRow).onTap!();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('task-filter-sheet')), findsNothing);
    expect(store.providerFilters, <String>{'grok'});

    await tester.tap(find.byKey(const Key('task-filter-toggle')));
    await tester.pump(const Duration(milliseconds: 400));
    tester
        .widget<TextButton>(find.byKey(const Key('clear-task-agent-filters')))
        .onPressed!();
    await tester.pump();
    expect(store.providerFilters, isEmpty);
    expect(find.byKey(const Key('task-filter-sheet')), findsOneWidget);

    tester
        .widget<Checkbox>(find.descendant(
          of: availableAgents,
          matching: find.byType(Checkbox),
        ))
        .onChanged!(true);
    await tester.pump();
    expect(store.providerFilters, <String>{availableAgentsTaskFilter});
    tester.widget<ListTile>(allAgents).onTap!();
    await tester.pump(const Duration(milliseconds: 400));
    expect(store.providerFilters, isEmpty);
    expect(find.byKey(const Key('task-filter-sheet')), findsNothing);
  });

  testWidgets(
      'conversation hides lifecycle plumbing and uses role layout and session theme',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    store.selectProvider('all');
    final session =
        store.sessions.firstWhere((item) => item.id == 'demo-opencode-e2e');
    store.messages[session.id] = <RemoteMessage>[
      RemoteMessage(
        id: 'role-user',
        sessionId: session.id,
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 10, 10),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text', data: <String, Object?>{'text': 'User side'})
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'role-assistant',
        sessionId: session.id,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 10, 10, 1),
        parts: const <ContentPart>[
          ContentPart(
              type: 'reasoning',
              data: <String, Object?>{'text': '**Analyzing**'}),
          ContentPart(type: 'text', data: <String, Object?>{
            'text': '''Assistant side
<oai-mem-citation>
<citation_entries>
MEMORY.md:12-18|note=[Prior app context]
</citation_entries>
<rollout_ids>
019fe34d-a181-70f1-b41a-226238eef130
</rollout_ids>
</oai-mem-citation>'''
          })
        ],
        status: 'completed',
      ),
    ];
    store.events[session.id] = <AgentEvent>[
      AgentEvent(
        eventId: 'hidden-status',
        sequence: 1,
        type: 'session.status_changed',
        occurredAt: DateTime.utc(2026, 8, 10, 10, 2),
        payload: const <String, Object?>{'state': 'idle'},
        sessionId: session.id,
        providerId: session.providerId,
      )
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        theme: buildRemoteTheme(allHarnessesVisualTheme),
        home: SessionScreen(sessionId: session.id),
      ),
    ));
    await tester.pump();

    expect(find.text('session status changed'), findsNothing);
    expect(find.text('idle'), findsNothing);
    expect(find.byKey(const Key('interrupt-current-work')), findsNothing);
    expect(find.byKey(const Key('conversation-state-indicator')), findsNothing);
    expect(find.byKey(const Key('send-instruction')), findsOneWidget);
    expect(find.byKey(const Key('add-attachment')), findsOneWidget);
    expect(find.byKey(const Key('session-controls')), findsNothing);
    expect(find.byKey(const Key('session-secondary-controls')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('send-instruction')),
        matching: find.byIcon(Icons.send_rounded),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('send-instruction')),
        matching: find.byIcon(Icons.playlist_add_rounded),
      ),
      findsNothing,
    );
    final composer =
        tester.widget<TextField>(find.byKey(const Key('session-composer')));
    expect(composer.decoration?.hintMaxLines, 1);
    expect(composer.decoration?.hintStyle?.color?.a, lessThan(0.6));
    final dictationButton =
        tester.widget<IconButton>(find.byKey(const Key('dictation-button')));
    final sendButton =
        tester.widget<IconButton>(find.byKey(const Key('send-instruction')));
    expect(dictationButton.style?.shape?.resolve(<WidgetState>{}),
        isA<CircleBorder>());
    expect(
        sendButton.style?.shape?.resolve(<WidgetState>{}), isA<CircleBorder>());
    final attachmentRect =
        tester.getRect(find.byKey(const Key('add-attachment')));
    final attachmentIconRect = tester.getRect(find.descendant(
      of: find.byKey(const Key('add-attachment')),
      matching: find.byIcon(Icons.add_rounded),
    ));
    final composerRect =
        tester.getRect(find.byKey(const Key('session-composer')));
    final shellRect =
        tester.getRect(find.byKey(const Key('session-composer-shell')));
    final sendRect = tester.getRect(find.byKey(const Key('send-instruction')));
    expect(
        attachmentIconRect.center.dy, closeTo(attachmentRect.center.dy, 0.5));
    expect(attachmentRect.center.dy, greaterThan(composerRect.center.dy));
    expect(attachmentRect.center.dy, closeTo(sendRect.center.dy, 1));
    expect(composerRect.width, greaterThan(shellRect.width * 0.78));
    expect(find.text('NEXT TURN'), findsNothing);
    expect(find.text('Analyzing'), findsNothing);
    final reasoning = find.byKey(const ValueKey<String>(
        'reasoning-toggle-role-assistant-part-0-thinking-0'));
    tester.widget<InkWell>(reasoning).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Analyzing'), findsOneWidget);
    expect(find.text('**Analyzing**'), findsNothing);
    expect(find.text('Assistant side'), findsOneWidget);
    expect(find.textContaining('<oai-mem-citation>'), findsNothing);
    expect(find.byKey(const Key('memory-context-indicator')), findsOneWidget);
    expect(find.text('Used saved context'), findsOneWidget);

    final attachmentButton =
        tester.widget<IconButton>(find.byKey(const Key('add-attachment')));
    expect(attachmentButton.onPressed, isNotNull);

    final userAlign = tester.widget<Align>(
        find.byKey(const ValueKey<String>('message-align-role-user')));
    final assistantAlign = tester.widget<Align>(find.byKey(
        const ValueKey<String>('message-align-role-assistant-visible-0')));
    expect(userAlign.alignment, Alignment.centerRight);
    expect(assistantAlign.alignment, Alignment.centerLeft);
    expect(
        tester
            .widget<SelectableText>(
                find.widgetWithText(SelectableText, 'User side'))
            .textAlign,
        anyOf(TextAlign.left, TextAlign.start));

    final userBubble = tester.widget<Container>(
        find.byKey(const ValueKey<String>('message-bubble-role-user')));
    final assistantBubble = tester.widget<Container>(find.byKey(
        const ValueKey<String>('message-bubble-role-assistant-visible-0')));
    expect((userBubble.decoration! as BoxDecoration).color,
        isNot((assistantBubble.decoration! as BoxDecoration).color));

    final themedContext =
        tester.element(find.byKey(const Key('session-composer')));
    expect(Theme.of(themedContext).colorScheme.primary,
        openCodeVisualTheme.accent);
    expect(Theme.of(themedContext).scaffoldBackgroundColor,
        openCodeVisualTheme.background);
    expect(store.selectedProviderId, 'all');

    store.applyEventForTesting(AgentEvent(
      eventId: 'working-event',
      sequence: 2,
      type: 'message.started',
      occurredAt: DateTime.utc(2026, 8, 10, 10, 3),
      payload: const <String, Object?>{},
      sessionId: session.id,
      providerId: session.providerId,
    ));
    await tester.pump();
    expect(find.byKey(const Key('interrupt-current-work')), findsOneWidget);
    expect(
        find.byKey(const Key('conversation-state-indicator')), findsOneWidget);
  });

  testWidgets(
      'working session shows live model effort and relation-driven agent activity',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-working';
    store.events[sessionId] = <AgentEvent>[];
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'subagent-event',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 10),
        parts: const <ContentPart>[
          ContentPart(type: 'subagent', data: <String, Object?>{
            'tool': 'spawn_agent',
            'action': 'spawn',
            'status': 'running',
            'receiverSessionIds': <Object?>['demo-working-child'],
            'summary': 'Reviewing the attachment UI',
            'modelId': 'gpt-5.6-sol',
            'reasoningEffort': 'high',
          }),
          ContentPart(type: 'subagent', data: <String, Object?>{
            'tool': 'spawn_agent',
            'action': 'spawn',
            'status': 'pending',
            'receiverSessionIds': <Object?>['not-loaded'],
          }),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(
        find.textContaining('GPT-5.6 Sol', findRichText: true), findsOneWidget);
    expect(find.textContaining('Ultra', findRichText: true), findsOneWidget);
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pump(const Duration(milliseconds: 400));
    final effortFinder = find.byKey(const Key('reasoning-control'));
    final effortControl = tester.widget<ListTile>(effortFinder);
    expect(effortControl.enabled, isFalse);
    expect(
        tester
            .widget<Text>(find.descendant(
              of: effortFinder,
              matching: find.text('Ultra'),
            ))
            .style
            ?.color,
        const Color(0xffa78bfa));
    await tester.tapAt(const Offset(2, 2));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('child-agents-button')), findsOneWidget);
    expect(find.text('2 agents active'), findsOneWidget);
    expect(find.text('Reviewing the attachment UI'), findsNothing);
    expect(
        find.byKey(const ValueKey<String>('view-subagent-demo-working-child')),
        findsNothing);
    expect(find.text('Agent activity'), findsNothing);
    expect(
        tester.getSize(find.byKey(const Key('agent-activity-toggle'))).height,
        44);

    await tester.tap(find.byKey(const Key('agent-activity-toggle')));
    await tester.pump();
    expect(find.text('Reviewing the attachment UI'), findsOneWidget);
    expect(
        find.byKey(const ValueKey<String>('view-subagent-demo-working-child')),
        findsOneWidget);
    expect(find.text('gpt-5.6-sol'), findsNothing);
    expect(find.text('High'), findsNothing);

    store.applyEventForTesting(AgentEvent(
      eventId: 'live-subagent-event',
      sequence: 1,
      type: 'tool.started',
      occurredAt: DateTime.utc(2026, 8, 11, 10, 1),
      sessionId: sessionId,
      providerId: 'codex',
      payload: const <String, Object?>{
        'parts': <Object?>[
          <String, Object?>{
            'type': 'subagent',
            'tool': 'send_message',
            'action': 'message',
            'status': 'running',
            'receiverSessionIds': <Object?>['demo-working-child'],
            'summary': 'Live agent update',
          }
        ],
      },
    ));
    await tester.pump();
    expect(find.text('1 agent active'), findsOneWidget);
    expect(find.text('Live agent update'), findsNothing);
    expect(find.text('tool started'), findsNothing);

    await tester.tap(find.text('1 agent active'));
    await tester.pump();
    expect(find.text('Live agent update'), findsOneWidget);

    await tester.tap(find.byKey(const Key('child-agents-button')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('UI reviewer'), findsWidgets);
    expect(find.text('reviewer · Working'), findsOneWidget);
    expect(
        find.byKey(
            const ValueKey<String>('view-child-agent-demo-working-child')),
        findsOneWidget);
    Navigator.of(tester.element(find.text('Agents'))).pop();
    await tester.pump(const Duration(milliseconds: 300));

    final parentIndex =
        store.sessions.indexWhere((session) => session.id == sessionId);
    store.sessions[parentIndex] = _copySession(
      store.sessions[parentIndex],
      reasoningEffort: 'low',
    );
    store.notifyListeners();
    await tester.pump();
    expect(find.textContaining('Light', findRichText: true), findsOneWidget);
    expect(find.textContaining('Low', findRichText: true), findsNothing);

    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
      'conversation renders image bytes and clean attachment labels instead of raw metadata',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'image-user',
        sessionId: sessionId,
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 11, 10),
        parts: const <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text': '''# Files mentioned by the user:

## phone-shot.png: C:\\Users\\person\\phone-shot.png

## My request:
Please inspect this screenshot.''',
          }),
          ContentPart(type: 'image', data: <String, Object?>{
            'uri':
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'mimeType': 'image/png',
            'name': 'phone-shot.png',
          }),
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'file-user',
        sessionId: sessionId,
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 11, 10, 1),
        parts: const <ContentPart>[
          ContentPart(type: 'file', data: <String, Object?>{
            'name': 'requirements.txt',
            'mimeType': 'text/plain',
          }),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(
        home: SessionScreen(sessionId: sessionId),
      ),
    ));
    await tester.pump();

    expect(find.byKey(const ValueKey<String>('message-image-image-user-0')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('message-file-file-user-0')),
        findsOneWidget);
    expect(find.text('requirements.txt'), findsOneWidget);
    expect(find.text('Please inspect this screenshot.'), findsOneWidget);
    expect(find.textContaining('Files mentioned by the user'), findsNothing);
    expect(find.textContaining(r'C:\Users'), findsNothing);
  });

  testWidgets('only the newest actively streaming private reasoning shimmers',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    final sessionIndex =
        store.sessions.indexWhere((item) => item.id == sessionId);
    store.sessions[sessionIndex] =
        _copySession(store.sessions[sessionIndex], state: 'working');
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'older-artifact',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 10),
        parts: const <ContentPart>[
          ContentPart(
              type: 'reasoning',
              data: <String, Object?>{'text': 'Earlier reasoning'})
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'newest-artifact',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 10, 1),
        parts: const <ContentPart>[
          ContentPart(
              type: 'reasoning',
              data: <String, Object?>{'text': 'Newest reasoning'}),
          ContentPart(type: 'text', data: <String, Object?>{
            'text': 'Visible progress update',
            'phase': 'commentary',
          }),
        ],
        status: 'streaming',
      ),
    ];
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump(const Duration(milliseconds: 80));

    expect(find.text('Reasoning'), findsOneWidget);
    expect(find.text('Earlier reasoning'), findsNothing);
    expect(find.text('Newest reasoning'), findsNothing);
    expect(find.byType(ShaderMask), findsOneWidget);

    store.sessions[sessionIndex] =
        _copySession(store.sessions[sessionIndex], state: 'idle');
    final activeMessage = store.messages[sessionId]!.last;
    store.messages[sessionId] = <RemoteMessage>[
      store.messages[sessionId]!.first,
      RemoteMessage(
        id: activeMessage.id,
        sessionId: activeMessage.sessionId,
        role: activeMessage.role,
        createdAt: activeMessage.createdAt,
        parts: activeMessage.parts,
        status: 'completed',
      ),
    ];
    store.selectProvider('all');
    await tester.pump();

    expect(find.byType(ShaderMask), findsNothing);
  });

  testWidgets('thinking updates share one disclosure and keep turn identity',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'thinking-entry',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 10),
        parts: const <ContentPart>[
          ContentPart(
              type: 'reasoning',
              data: <String, Object?>{'text': 'Inspecting live events'})
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'middle-thinking-entry',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 10, 0, 30),
        parts: const <ContentPart>[
          ContentPart(
              type: 'reasoning',
              data: <String, Object?>{'text': 'Checking another detail'})
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'final-entry',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 10, 1),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text', data: <String, Object?>{'text': 'Final response'})
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(find.text('Reasoning'), findsOneWidget);
    expect(find.text('Inspecting live events'), findsNothing);
    expect(find.text('Checking another detail'), findsNothing);
    expect(find.text('Final response'), findsOneWidget);
    expect(
        find.byKey(const ValueKey<String>(
            'assistant-identity-reasoning-thinking-entry-part-0-thinking-0')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('assistant-identity-final-entry')),
        findsOneWidget);
    expect(
        find.byKey(const ValueKey<String>('final-answer-boundary-final-entry')),
        findsOneWidget);
    final reasoning = find.byKey(const ValueKey<String>(
        'reasoning-toggle-thinking-entry-part-0-thinking-0'));
    tester.widget<InkWell>(reasoning).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Inspecting live events'), findsOneWidget);
    expect(find.text('Checking another detail'), findsOneWidget);
  });

  testWidgets('Grok and OpenCode thinking stays private until expanded',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();

    for (final entry in <(String, String)>[
      ('demo-grok-release', 'Grok'),
      ('demo-opencode-e2e', 'OpenCode'),
    ]) {
      store.messages[entry.$1] = <RemoteMessage>[
        RemoteMessage(
          id: '${entry.$1}-assistant',
          sessionId: entry.$1,
          role: 'assistant',
          createdAt: DateTime.utc(2026, 8, 13, 10),
          parts: <ContentPart>[
            ContentPart(type: 'reasoning', data: <String, Object?>{
              'text': '${entry.$2} private thought',
            }),
            ContentPart(type: 'text', data: <String, Object?>{
              'text': '${entry.$2} final output',
            }),
          ],
          status: 'completed',
        ),
      ];

      await tester.pumpWidget(StoreScope(
        store: store,
        child: MaterialApp(
          home: SessionScreen(
            key: ValueKey<String>(entry.$1),
            sessionId: entry.$1,
          ),
        ),
      ));
      await tester.pump();

      expect(find.text('${entry.$2} private thought'), findsNothing);
      expect(find.text('${entry.$2} final output'), findsOneWidget);
      expect(find.text('Reasoning'), findsOneWidget);
      expect(
          find.byKey(ValueKey<String>(
              'final-answer-boundary-${entry.$1}-assistant-visible-0')),
          findsOneWidget);
      final reasoning = find.byKey(ValueKey<String>(
          'reasoning-toggle-${entry.$1}-assistant-part-0-thinking-0'));
      tester.widget<InkWell>(reasoning).onTap!();
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('${entry.$2} private thought'), findsOneWidget);
    }
  });

  testWidgets(
      'conversation markdown renders structure safely and stays bounded on a phone',
      (tester) async {
    String? clipboardText;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        clipboardText =
            (call.arguments as Map<Object?, Object?>)['text'] as String?;
      }
      return null;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'markdown-answer',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 14, 12),
        parts: const <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text': '''### Supabase Free

| Feature | Free |
|---|---|
| Monthly cost | **\$0** |
| API requests | Unlimited |

- One readable item
- A second item

> This stays visually secondary.

Use `inlineCode()` and:

```dart
const aVeryLongIdentifierForHorizontalScrolling = 'safe';
```

[Blocked link](javascript:alert(1))

![Tracker image](https://example.com/tracker.png)

<script>alert('never execute')</script>''',
          }),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(find.byType(MarkdownBody), findsOneWidget);
    expect(find.text('Supabase Free'), findsOneWidget);
    expect(find.text('### Supabase Free'), findsNothing);
    expect(find.byType(Table), findsOneWidget);
    expect(find.byType(SelectableText), findsWidgets);
    expect(
        find.byKey(const ValueKey<String>(
            'markdown-image-reference-https://example.com/tracker.png')),
        findsOneWidget);
    expect(find.text('Tracker image'), findsOneWidget);
    expect(find.byType(SingleChildScrollView), findsAtLeastNWidgets(2));
    expect(tester.takeException(), isNull);

    final markdown = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    markdown.onTapLink
        ?.call('Blocked link', 'javascript:alert(1)', 'Unsafe scheme');
    await tester.pump();
    expect(find.text('This link type is blocked.'), findsOneWidget);

    markdown.onTapLink
        ?.call('Desktop file', 'file:///C:/work/main.dart', 'Local path');
    await tester.pumpAndSettle();
    expect(find.text('Desktop path'), findsOneWidget);
    expect(find.byKey(const Key('copy-desktop-path')), findsOneWidget);
    expect(find.textContaining('cannot open on this phone'), findsOneWidget);
    await tester.tap(find.byKey(const Key('copy-desktop-path')));
    await tester.pumpAndSettle();
    expect(clipboardText, 'file:///C:/work/main.dart');
  });

  testWidgets('raw markup-only messages leave no shell but images still render',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'raw-user-heartbeat',
        sessionId: sessionId,
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 14, 12),
        parts: const <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text': '<heartbeat>alive</heartbeat>',
          }),
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'raw-provider-metadata',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 14, 12, 1),
        parts: const <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text': '<div data-event="provider">metadata</div>',
          }),
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'image-only-message',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 14, 12, 2),
        parts: const <ContentPart>[
          ContentPart(type: 'image', data: <String, Object?>{
            'uri':
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'mimeType': 'image/png',
            'name': 'result.png',
          }),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(
        find.byKey(const ValueKey<String>('message-bubble-raw-user-heartbeat')),
        findsNothing);
    expect(
        find.byKey(
            const ValueKey<String>('message-bubble-raw-provider-metadata')),
        findsNothing);
    expect(find.textContaining('heartbeat'), findsNothing);
    expect(find.textContaining('metadata'), findsNothing);
    expect(
        find.byKey(
            const ValueKey<String>('message-image-image-only-message-0')),
        findsOneWidget);
    expect(
        find.byKey(const ValueKey<String>('message-bubble-image-only-message')),
        findsOneWidget);
  });

  testWidgets(
      'image-only user galleries stay compact, bubbled, and right aligned',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    const image =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'five-image-user-message',
        sessionId: sessionId,
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 28, 8),
        parts: <ContentPart>[
          ...List<ContentPart>.generate(
            4,
            (index) => ContentPart(type: 'image', data: <String, Object?>{
              'uri': image,
              'mimeType': 'image/png',
              'name': 'image-${index + 1}.png',
            }),
          ),
          const ContentPart(type: 'image', data: <String, Object?>{
            'mimeType': 'image/png',
            'name': 'missing.png',
          }),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    final gallery = find.byKey(const ValueKey<String>(
        'message-image-gallery-five-image-user-message'));
    final bubble = find.byKey(
        const ValueKey<String>('message-bubble-five-image-user-message'));
    expect(gallery, findsOneWidget);
    expect(bubble, findsOneWidget);
    expect(tester.getSize(gallery).width, closeTo(223, .1));
    expect(tester.getSize(gallery).height, closeTo(101, .1));
    final bubbleRect = tester.getRect(bubble);
    final alignedRect = tester.getRect(find.byKey(
        const ValueKey<String>('message-align-five-image-user-message')));
    expect(bubbleRect.right, closeTo(alignedRect.right, .1));
    expect(bubbleRect.width, lessThanOrEqualTo(237));
    for (var index = 0; index < 5; index += 1) {
      final tile = find.byKey(
          ValueKey<String>('message-image-five-image-user-message-$index'));
      expect(tile, findsOneWidget);
      expect(tester.getSize(tile), const Size(52, 48));
    }
  });

  testWidgets('system compaction is a quiet conversation boundary',
      (tester) async {
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'compacted-context',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 14, 12),
        parts: const <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text':
                'Another language model started to solve this problem and produced a summary of its thinking process.\n\n## Current task progress\n\nPrivate raw summary',
          }),
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'automatic-compaction',
        sessionId: sessionId,
        role: 'system',
        createdAt: DateTime.utc(2026, 8, 14, 12, 1),
        parts: const <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text': 'Context automatically compacted',
          }),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(
        find.byKey(
            const ValueKey<String>('conversation-boundary-compacted-context')),
        findsOneWidget);
    expect(find.text('Session compacted'), findsNWidgets(2));
    expect(find.textContaining('Private raw summary'), findsNothing);
    await tester.tap(find.byKey(
        const ValueKey<String>('conversation-boundary-compacted-context')));
    await tester.pump();
    expect(find.textContaining('Private raw summary'), findsOneWidget);
  });

  testWidgets('working directory stays in task details and is scrollable',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-grok-release';
    final sessionIndex =
        store.sessions.indexWhere((session) => session.id == sessionId);
    store.sessions[sessionIndex] = store.sessions[sessionIndex].copyWith(
      workingDirectory:
          r'C:\Users\person\Documents\extremely-long-project-directory\nested\working-folder',
    );

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(find.byKey(const Key('working-directory-scroll')), findsNothing);
    await tester.tap(find.byKey(const Key('session-actions-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-task-details')));
    await tester.pumpAndSettle();

    final scrollable = tester.state<ScrollableState>(find
        .descendant(
          of: find.byKey(const Key('working-directory-scroll')),
          matching: find.byType(Scrollable),
        )
        .first);
    expect(scrollable.position.maxScrollExtent, greaterThan(0));
  });

  testWidgets(
      'text-only model shows one dismissible notice after selecting an image',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final imageBytes = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    final attachment = RemoteAttachment(
      name: 'phone-warning.png',
      mimeType: 'image/png',
      dataBase64: base64Encode(imageBytes),
      byteLength: imageBytes.length,
    );

    final store = _TextOnlyModelDemoStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    final index = store.sessions.indexWhere((item) => item.id == sessionId);
    final session = store.sessions[index];
    store.sessions[index] =
        _copySession(session, modelId: _TextOnlyModelDemoStore.modelId);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: sessionId,
          imageAttachmentPicker: () async => attachment,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.tap(find.byKey(const Key('attachment-source-photos')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('text-only-image-notice')), findsOneWidget);
    expect(
        find.byKey(const ValueKey<String>('pending-image-phone-warning.png')),
        findsOneWidget);

    await tester.tap(find.byKey(const Key('dismiss-text-only-image-notice')));
    await tester.pump();
    expect(find.byKey(const Key('text-only-image-notice')), findsNothing);

    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tester.tap(find.byKey(const Key('attachment-source-photos')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('text-only-image-notice')), findsNothing);
  });

  testWidgets('attachment menu fully dismisses before the image picker starts',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    addTearDown(store.dispose);
    final imageBytes = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    final attachment = RemoteAttachment(
      name: 'dismissed-sheet.png',
      mimeType: 'image/png',
      dataBase64: base64Encode(imageBytes),
      byteLength: imageBytes.length,
    );
    final pickerGate = Completer<RemoteAttachment?>();
    var pickerCalls = 0;
    bool? menuWasMountedWhenPickerStarted;

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-opencode-e2e',
          imageAttachmentPicker: () {
            pickerCalls += 1;
            menuWasMountedWhenPickerStarted = find
                .byKey(const Key('attachment-source-menu'))
                .evaluate()
                .isNotEmpty;
            return pickerGate.future;
          },
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('attachment-source-menu')), findsOneWidget);

    await tester.tap(find.byKey(const Key('attachment-source-photos')));
    await tester.pump();
    expect(pickerCalls, 0,
        reason: 'the system picker must wait for the menu reverse transition');

    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('attachment-source-menu')), findsNothing);
    expect(pickerCalls, 1);
    expect(menuWasMountedWhenPickerStarted, isFalse);

    pickerGate.complete(attachment);
    await tester.pump();
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('pending-image-dismissed-sheet.png')),
      findsOneWidget,
    );
    expect(store.draftAttachmentsFor('demo-opencode-e2e'), hasLength(1));
    await tester.pump(const Duration(milliseconds: 500));
    expect(pickerCalls, 1);
    expect(store.draftAttachmentsFor('demo-opencode-e2e'), hasLength(1));
  });

  testWidgets('open conversation shows sent and assistant messages live',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: const SessionScreen(sessionId: sessionId),
      ),
    ));
    await tester.enterText(
        find.byKey(const Key('session-composer')), 'Live phone message');
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-instruction')));
    await tester.pump();

    expect(find.text('Live phone message'), findsOneWidget);
    expect(
        store.messages[sessionId]!.any((message) =>
            message.role == 'user' &&
            message.parts.single.summary == 'Live phone message'),
        isTrue);

    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump();
    expect(store.messages[sessionId]!.last.parts.single.summary,
        contains('local preview response'));
    expect(find.textContaining('local preview response'), findsOneWidget);
    expect(find.byKey(const Key('conversation-state-indicator')), findsNothing);
  });

  testWidgets(
      'dictation source picker inserts editable text without sending it',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    final before = store.messages[sessionId]!.length;
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: sessionId,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pumpAndSettle();
    expect(find.text('OpenAI speech-to-text'), findsOneWidget);
    expect(find.text('xAI speech-to-text'), findsOneWidget);
    await tester.tap(find.text('xAI speech-to-text'));
    await tester.pumpAndSettle();
    expect(recorder.started, isTrue);
    expect(store.preferredDictationSourceId, 'xai-stt');
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pumpAndSettle();

    final composer =
        tester.widget<TextField>(find.byKey(const Key('session-composer')));
    expect(composer.controller?.text, 'Demo dictation transcript');
    expect(store.messages[sessionId]!.length, before);
  });

  testWidgets('stopped dictation immediately says the recording is safe',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetriableDictationDemoStore();
    final transcript = Completer<String>();
    store.transcriptionGate = transcript;
    await store.initialize();
    addTearDown(store.dispose);
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();

    expect(
        find.byKey(const Key('dictation-processing-status')), findsOneWidget);
    expect(find.textContaining('Your recording is safe'), findsOneWidget);
    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);

    transcript.complete('Transcript arrived');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    final composer =
        tester.widget<TextField>(find.byKey(const Key('session-composer')));
    expect(composer.controller?.text, 'Transcript arrived');
  });

  testWidgets(
      'cancelled deferred dictation keeps Retry single-flight and ignores the stale result',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _ConcurrentDictationDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    store.dictationSourcePreferences['codex'] = 'openai-stt';
    final audio = Uint8List.fromList(
        List<int>.generate(9000, (index) => (index * 29) & 0xff));
    final recorder = _FakeDictationRecorder(waveBytes: audio);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();

    expect(store.transcriptionGates, hasLength(1));
    expect(store.activeTranscriptions, 1);
    expect(store.maxConcurrentTranscriptions, 1);
    expect(store.retainedDictationFor('demo-working')?.bytes,
        orderedEquals(audio));

    await tester.tap(find.byKey(const Key('cancel-dictation-processing')));
    await tester.pump();
    final retryWhileFirstRequestSettles = tester.widget<IconButton>(
      find.byKey(const Key('dictation-button')),
    );
    expect(retryWhileFirstRequestSettles.onPressed, isNull,
        reason: 'Retry must not start a second transcription in parallel');
    expect(store.transcriptionGates, hasLength(1));
    expect(store.maxConcurrentTranscriptions, 1);

    store.transcriptionGates.single.complete('Stale transcript');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(store.activeTranscriptions, 0);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      isEmpty,
      reason: 'a cancelled request must not mutate the composition',
    );
    expect(
        store.retainedDictationFor('demo-working')?.bytes, orderedEquals(audio),
        reason: 'the stale completion must not clear the retryable recording');
    expect(find.byKey(const Key('dictation-retry-status')), findsOneWidget);

    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(store.transcriptionGates, hasLength(2));
    expect(store.activeTranscriptions, 1);
    expect(store.maxConcurrentTranscriptions, 1);
    expect(store.retainedDictationFor('demo-working')?.bytes,
        orderedEquals(audio));

    store.transcriptionGates.last.complete('Fresh transcript');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(store.activeTranscriptions, 0);
    expect(store.maxConcurrentTranscriptions, 1);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Fresh transcript',
    );
    expect(store.retainedDictationFor('demo-working'), isNull);
  });

  testWidgets(
      'source action back retains stopped audio and keeps transcription single-flight',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _ConcurrentDictationDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    store.dictationSourcePreferences['codex'] = 'openai-stt';
    final audio = Uint8List.fromList(
        List<int>.generate(9000, (index) => (index * 23) & 0xff));
    final stopGate = Completer<void>();
    final recorder =
        _FakeDictationRecorder(waveBytes: audio, stopGate: stopGate);
    final initialSessionCount = store.sessions.length;

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-codex-api',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('session-actions-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-context-handoff')));
    await tester.pumpAndSettle();
    expect(
        find.byKey(const Key('source-session-action-sheet')), findsOneWidget);

    await tester.tap(find.byKey(const Key('source-action-dictation')));
    await tester.pump();
    expect(recorder.startCalls, 1);
    await WidgetsBinding.instance.handlePopRoute();
    await tester.pump();
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionGates, isEmpty,
        reason: 'Back before stop completes must not start transcription');
    expect(find.text('Discard saved recording?'), findsNothing);

    stopGate.complete();
    await tester.pump();
    await tester.pump();
    expect(store.transcriptionGates, isEmpty);
    expect(find.text('Discard saved recording?'), findsOneWidget);
    await tester.tap(find.text('Keep editing'));
    await tester.pump();
    expect(find.byKey(const Key('source-action-dictation-retry-status')),
        findsOneWidget);

    await tester.tap(find.byKey(const Key('source-action-dictation')));
    await tester.pump();
    expect(store.transcriptionGates, hasLength(1));
    expect(store.maxConcurrentTranscriptions, 1);
    await tester.tap(
        find.byKey(const Key('cancel-source-action-dictation-processing')));
    await tester.pump();
    final retryWhileFirstRequestSettles = tester.widget<IconButton>(
      find.byKey(const Key('source-action-dictation')),
    );
    expect(retryWhileFirstRequestSettles.onPressed, isNull,
        reason: 'Retry must wait for the cancelled request to settle');
    expect(find.byKey(const Key('source-action-dictation-retry-status')),
        findsOneWidget);

    await WidgetsBinding.instance.handlePopRoute();
    await tester.pump();
    expect(find.text('Discard saved recording?'), findsOneWidget,
        reason: 'Back must not wait for the stale transcription');
    await tester.tap(find.text('Keep editing'));
    await tester.pump();

    store.transcriptionGates.single.complete('Stale source transcript');
    await tester.pump();
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('source-action-prompt')))
          .controller
          ?.text,
      isEmpty,
      reason: 'The cancelled completion must not mutate the instruction',
    );
    expect(find.byKey(const Key('source-action-dictation-retry-status')),
        findsOneWidget,
        reason: 'The cancelled completion must not clear retained audio');

    await tester.tap(find.byKey(const Key('source-action-dictation')));
    await tester.pump();
    expect(store.transcriptionGates, hasLength(2));
    expect(store.maxConcurrentTranscriptions, 1);
    store.transcriptionGates.last.complete('Fresh source transcript');
    await tester.pump();
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('source-action-prompt')))
          .controller
          ?.text,
      'Fresh source transcript',
    );
    expect(find.byKey(const Key('source-action-dictation-retry-status')),
        findsNothing);
    expect(store.sessions, hasLength(initialSessionCount),
        reason: 'Dictation recovery must never create a handoff automatically');
  });

  testWidgets(
      'failed dictation keeps audio and retries without recording again',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetriableDictationDemoStore(failFirst: true);
    await store.initialize();
    addTearDown(store.dispose);
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byKey(const Key('dictation-retry-status')), findsOneWidget);
    expect(find.textContaining('no need to speak again'), findsOneWidget);
    expect(find.text('Retry'), findsWidgets);
    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionAttempts, 1);

    final retryButton = tester.widget<IconButton>(
      find.byKey(const Key('dictation-button')),
    );
    expect(retryButton.onPressed, isNotNull);
    retryButton.onPressed!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    final composer =
        tester.widget<TextField>(find.byKey(const Key('session-composer')));
    expect(composer.controller?.text, 'Recovered dictation transcript');
    expect(find.byKey(const Key('dictation-retry-status')), findsNothing);
    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionAttempts, 2);
  });

  testWidgets('source limit auto-stops and submits exactly once',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetriableDictationDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    store.dictationSources
      ..clear()
      ..add(const TranscriptionSource(
        id: 'openai-stt',
        label: 'OpenAI speech-to-text',
        status: 'ready',
        setupEnvironmentVariable: 'TETHOQ_OPENAI_API_KEY',
        supportsBatch: true,
        maxAudioBytes: 64044,
      ));
    store.dictationSourcePreferences['codex'] = 'openai-stt';
    final recorder = _FakeDictationRecorder();
    final queuedBefore = store.queuedMessages.keys.toSet();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 1100));
    });
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionAttempts, 1);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      isEmpty,
    );
    final added = store.queuedMessages.entries
        .where((entry) => !queuedBefore.contains(entry.key))
        .map((entry) => entry.value)
        .toList(growable: false);
    expect(added, hasLength(1));
    expect(added.single.content, 'Recovered dictation transcript');
    await tester.pump(const Duration(milliseconds: 500));
    expect(
      store.queuedMessages.keys
          .where((messageId) => !queuedBefore.contains(messageId)),
      hasLength(1),
    );
  });

  testWidgets('source-limit failure retries identical audio without submitting',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetriableDictationDemoStore(failFirst: true);
    await store.initialize();
    addTearDown(store.dispose);
    store.dictationSources
      ..clear()
      ..add(const TranscriptionSource(
        id: 'openai-stt',
        label: 'OpenAI speech-to-text',
        status: 'ready',
        setupEnvironmentVariable: 'TETHOQ_OPENAI_API_KEY',
        supportsBatch: true,
        maxAudioBytes: 64044,
      ));
    store.dictationSourcePreferences['codex'] = 'openai-stt';
    final audio = Uint8List.fromList(
        List<int>.generate(9000, (index) => (index * 31) & 0xff));
    final recorder = _FakeDictationRecorder(waveBytes: audio);
    final before = store.queuedMessages.length;

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 1100));
    });
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byKey(const Key('dictation-retry-status')), findsOneWidget);
    expect(store.queuedMessages.length, before);
    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionInputs, hasLength(1));
    expect(identical(store.transcriptionInputs.single, audio), isTrue);

    final retryButton = tester.widget<IconButton>(
      find.byKey(const Key('dictation-button')),
    );
    expect(retryButton.onPressed, isNotNull);
    retryButton.onPressed!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byKey(const Key('dictation-retry-status')), findsNothing);
    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionInputs, hasLength(2));
    expect(
        identical(store.transcriptionInputs[0], store.transcriptionInputs[1]),
        isTrue);
    expect(store.transcriptionInputs[1], orderedEquals(audio));
    expect(store.queuedMessages.length, before);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Recovered dictation transcript',
    );
    await tester.pump(const Duration(milliseconds: 500));
    expect(store.queuedMessages.length, before);
  });

  testWidgets('background finalization transcribes without submitting',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetriableDictationDemoStore();
    final transcript = Completer<String>();
    store.transcriptionGate = transcript;
    await store.initialize();
    addTearDown(store.dispose);
    void resumeLifecycle() {
      if (tester.binding.lifecycleState == AppLifecycleState.paused) {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      }
      if (tester.binding.lifecycleState == AppLifecycleState.hidden) {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      }
      if (tester.binding.lifecycleState == AppLifecycleState.inactive) {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      }
    }

    addTearDown(resumeLifecycle);
    store.dictationSourcePreferences['codex'] = 'openai-stt';
    final recorder = _FakeDictationRecorder();
    final before = store.queuedMessages.length;

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(
        find.byKey(const Key('dictation-processing-status')), findsOneWidget);
    transcript.complete('Recovered dictation transcript');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionAttempts, 1);
    expect(store.queuedMessages.length, before);
    final composer =
        tester.widget<TextField>(find.byKey(const Key('session-composer')));
    expect(composer.controller?.text, 'Recovered dictation transcript');

    resumeLifecycle();
    await tester.pump(const Duration(milliseconds: 500));
    expect(store.queuedMessages.length, before);
  });

  for (final finalizationCause in <String>['source limit', 'background']) {
    testWidgets(
        'explicit Send upgrades an active $finalizationCause finalization exactly once',
        (tester) async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      tester.view.physicalSize = const Size(430, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = _RetriableDictationDemoStore();
      await store.initialize();
      addTearDown(store.dispose);
      if (finalizationCause == 'source limit') {
        _useOneSecondDictationSource(store);
      } else {
        store.dictationSourcePreferences['codex'] = 'openai-stt';
      }
      final stopGate = Completer<void>();
      final recorder = _FakeDictationRecorder(stopGate: stopGate);
      final queuedBefore = store.queuedMessages.keys.toSet();

      void resumeLifecycle() {
        if (tester.binding.lifecycleState == AppLifecycleState.paused) {
          tester.binding
              .handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        }
        if (tester.binding.lifecycleState == AppLifecycleState.hidden) {
          tester.binding
              .handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        }
        if (tester.binding.lifecycleState == AppLifecycleState.inactive) {
          tester.binding
              .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
        }
      }

      addTearDown(resumeLifecycle);
      await tester.pumpWidget(StoreScope(
        store: store,
        child: MaterialApp(
          home: SessionScreen(
            sessionId: 'demo-working',
            dictationRecorder: recorder,
          ),
        ),
      ));
      await tester.tap(find.byKey(const Key('dictation-button')));
      await tester.pump();
      final pendingSend = tester
          .widget<IconButton>(find.byKey(const Key('send-instruction')))
          .onPressed;
      expect(pendingSend, isNotNull);

      if (finalizationCause == 'source limit') {
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 1100));
        });
        await tester.pump(const Duration(seconds: 1));
      } else {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.inactive);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
        await tester.pump();
      }

      expect(recorder.stopCalls, 1,
          reason: 'the non-submit finalization must already own the recording');
      expect(store.queuedMessages.keys.toSet(), queuedBefore,
          reason: '$finalizationCause alone is never consent to submit');

      // Model a Send pointer event that was accepted just before the disabled
      // state repainted. Repeated delivery of that event must only escalate the
      // one existing finalization operation, never create another submit.
      pendingSend!();
      pendingSend();
      expect(recorder.stopCalls, 1);
      expect(store.queuedMessages.keys.toSet(), queuedBefore);

      stopGate.complete();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      final added = store.queuedMessages.entries
          .where((entry) => !queuedBefore.contains(entry.key))
          .map((entry) => entry.value)
          .toList(growable: false);
      expect(recorder.stopCalls, 1);
      expect(store.transcriptionAttempts, 1);
      expect(added, hasLength(1));
      expect(added.single.sessionId, 'demo-working');
      expect(added.single.content, 'Recovered dictation transcript');
      await tester.pump(const Duration(milliseconds: 500));
      expect(
        store.queuedMessages.keys
            .where((messageId) => !queuedBefore.contains(messageId)),
        hasLength(1),
      );
      resumeLifecycle();
    });
  }

  testWidgets('side-chat source limit auto-stops and submits exactly once',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetriableDictationDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    _useOneSecondDictationSource(store);
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: _FakeDictationRecorder(),
          sideChatDictationRecorderFactory: () => recorder,
        ),
      ),
    ));
    final sideChatId = await _openSideChatForDictation(tester, store);

    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    await tester.runAsync(() async {
      await Future<void>.delayed(const Duration(milliseconds: 1100));
    });
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(milliseconds: 600));

    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionAttempts, 1);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('side-chat-composer')))
          .controller
          ?.text,
      isEmpty,
    );
    expect(_sideChatTranscriptCount(store, sideChatId), 1);
    await tester.pump(const Duration(milliseconds: 500));
    expect(_sideChatTranscriptCount(store, sideChatId), 1);
  });

  for (final emptyFirst in <bool>[false, true]) {
    final failureLabel = emptyFirst ? 'empty transcript' : 'request error';
    testWidgets(
        'side-chat source-limit $failureLabel keeps identical audio without submitting',
        (tester) async {
      FlutterSecureStorage.setMockInitialValues(<String, String>{});
      tester.view.physicalSize = const Size(430, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final store = _RetriableDictationDemoStore(
        failFirst: !emptyFirst,
        emptyFirst: emptyFirst,
      );
      await store.initialize();
      addTearDown(store.dispose);
      _useOneSecondDictationSource(store);
      final audio = Uint8List.fromList(
          List<int>.generate(9000, (index) => (index * 17) & 0xff));
      final recorder = _FakeDictationRecorder(waveBytes: audio);

      await tester.pumpWidget(StoreScope(
        store: store,
        child: MaterialApp(
          home: SessionScreen(
            sessionId: 'demo-working',
            dictationRecorder: _FakeDictationRecorder(),
            sideChatDictationRecorderFactory: () => recorder,
          ),
        ),
      ));
      final sideChatId = await _openSideChatForDictation(tester, store);

      await tester.tap(find.byKey(const Key('side-chat-dictation')));
      await tester.pump();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 1100));
      });
      await tester.pump(const Duration(seconds: 1));
      await tester.pump(const Duration(milliseconds: 500));

      expect(find.byKey(const Key('side-chat-dictation-retry-status')),
          findsOneWidget);
      expect(recorder.startCalls, 1);
      expect(recorder.stopCalls, 1);
      expect(store.transcriptionInputs, hasLength(1));
      expect(identical(store.transcriptionInputs.single, audio), isTrue);
      expect(_sideChatTranscriptCount(store, sideChatId), 0);

      await tester.tap(find.byKey(const Key('side-chat-dictation')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));

      expect(find.byKey(const Key('side-chat-dictation-retry-status')),
          findsNothing);
      expect(recorder.startCalls, 1);
      expect(recorder.stopCalls, 1);
      expect(store.transcriptionInputs, hasLength(2));
      expect(
          identical(store.transcriptionInputs[0], store.transcriptionInputs[1]),
          isTrue);
      expect(store.transcriptionInputs[1], orderedEquals(audio));
      expect(_sideChatTranscriptCount(store, sideChatId), 0);
      expect(
        tester
            .widget<TextField>(find.byKey(const Key('side-chat-composer')))
            .controller
            ?.text,
        'Recovered dictation transcript',
      );
      await tester.pump(const Duration(milliseconds: 500));
      expect(_sideChatTranscriptCount(store, sideChatId), 0);
    });
  }

  testWidgets('side-chat background finalization never submits',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetriableDictationDemoStore();
    final transcript = Completer<String>();
    store.transcriptionGate = transcript;
    await store.initialize();
    addTearDown(store.dispose);
    final recorder = _FakeDictationRecorder();

    void resumeLifecycle() {
      if (tester.binding.lifecycleState == AppLifecycleState.paused) {
        tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
      }
      if (tester.binding.lifecycleState == AppLifecycleState.hidden) {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      }
      if (tester.binding.lifecycleState == AppLifecycleState.inactive) {
        tester.binding
            .handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      }
    }

    addTearDown(resumeLifecycle);
    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: _FakeDictationRecorder(),
          sideChatDictationRecorderFactory: () => recorder,
        ),
      ),
    ));
    final sideChatId = await _openSideChatForDictation(tester, store);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(find.byKey(const Key('side-chat-dictation-processing')),
        findsOneWidget);
    transcript.complete('Recovered dictation transcript');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(recorder.startCalls, 1);
    expect(recorder.stopCalls, 1);
    expect(store.transcriptionAttempts, 1);
    expect(_sideChatTranscriptCount(store, sideChatId), 0);
    final composer =
        tester.widget<TextField>(find.byKey(const Key('side-chat-composer')));
    expect(composer.controller?.text, 'Recovered dictation transcript');
    resumeLifecycle();
    await tester.pump(const Duration(milliseconds: 500));
    expect(_sideChatTranscriptCount(store, sideChatId), 0);
  });

  testWidgets(
      'dictation button opens setup guidance when no source is reported',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    store.dictationSources.clear();
    store.notifyListeners();
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-opencode-e2e',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pumpAndSettle();

    expect(
      find.text(
          'No dictation source is enabled. No compatible source is available on this computer.'),
      findsOneWidget,
    );
    expect(find.text('Dictation source'), findsOneWidget);
    expect(recorder.started, isFalse);
  });

  testWidgets('thin selector chooses a dictation source without recording',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: recorder,
        ),
      ),
    ));

    expect(tester.getSize(find.byKey(const Key('dictation-button'))),
        const Size(44, 38));
    expect(tester.getSize(find.byKey(const Key('dictation-source-selector'))),
        const Size(30, 13));
    await tester.tap(find.byKey(const Key('dictation-source-selector')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Dictation source'), findsOneWidget);
    expect(find.text('WAV audio'), findsNothing);
    expect(find.byKey(const Key('dictation-source-option-direct-audio')),
        findsNothing);
    expect(
        find.descendant(
          of: find.byKey(const Key('dictation-source-option-openai-stt')),
          matching: find.byKey(const ValueKey<String>('provider-logo-codex')),
        ),
        findsOneWidget);
    expect(
        find.descendant(
          of: find.byKey(const Key('dictation-source-option-xai-stt')),
          matching: find.byKey(const ValueKey<String>('provider-logo-grok')),
        ),
        findsOneWidget);
    tester
        .widget<InkWell>(
            find.byKey(const Key('dictation-source-option-openai-stt')))
        .onTap!();
    await tester.pump(const Duration(milliseconds: 400));

    expect(store.preferredDictationSourceIdForHarness('codex'), 'openai-stt');
    expect(recorder.started, isFalse);
  });

  testWidgets('thin source selector offers WAV audio when EARS is configured',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    addTearDown(store.dispose);
    await store.initialize();
    store.modelsByProvider['direct'] = const <RemoteModel>[
      RemoteModel(
        id: 'direct/audio-helper',
        providerId: 'direct',
        displayName: 'Audio helper',
        isDefault: true,
        inputModalities: <String>['text', 'audio'],
        nativeMetadata: <String, Object?>{},
      ),
    ];
    await store.setEars(const EarsSettings(
      enabled: true,
      providerId: 'direct',
      modelId: 'direct/audio-helper',
    ));

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-working',
          dictationRecorder: _FakeDictationRecorder(),
        ),
      ),
    ));
    expect(find.byKey(const Key('dictation-source-selector')), findsOneWidget);
    await tester.tap(find.byKey(const Key('dictation-source-selector')));
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('WAV audio'), findsOneWidget);
    expect(find.text('EARS turns your recording into text'), findsOneWidget);
    expect(find.byKey(const Key('dictation-source-option-direct-audio')),
        findsOneWidget);
  });

  testWidgets('Grok tap uses a ready xAI default without opening the picker',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-failed',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pumpAndSettle();

    expect(find.text('Dictation source'), findsNothing);
    expect(store.preferredDictationSourceIdForHarness('grok'), 'xai-stt');
    expect(recorder.started, isTrue);
  });

  testWidgets('OpenCode tap keeps the source picker open until one is chosen',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    final recorder = _FakeDictationRecorder();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: 'demo-opencode-e2e',
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Dictation source'), findsOneWidget);
    expect(recorder.started, isFalse);
  });

  testWidgets('settings reveals dictation setup details only on request',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    store.dictationSources[1] = const TranscriptionSource(
      id: 'xai-stt',
      label: 'xAI speech-to-text',
      status: 'needs_credential',
      setupEnvironmentVariable: 'XAI_API_KEY',
      supportsBatch: true,
      maxAudioBytes: 25 * 1024 * 1024,
      credentialLabel: 'xAI API key',
      credentialSetupUrl: 'https://console.x.ai/',
    );

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: HostsScreen()),
    ));

    expect(find.text('Dictation'), findsOneWidget);
    expect(find.text('OpenAI speech-to-text'), findsOneWidget);
    expect(find.text('xAI speech-to-text'), findsNothing);
    expect(find.textContaining('TETHOQ_OPENAI_API_KEY'), findsNothing);
    expect(find.textContaining('XAI_API_KEY'), findsNothing);
    expect(find.textContaining('Needs credential'), findsNothing);

    await tester.tap(find.byKey(const Key('settings-section-dictation')));
    await tester.pumpAndSettle();

    expect(find.text('xAI speech-to-text'), findsOneWidget);
    expect(find.textContaining('XAI_API_KEY'), findsNothing);

    final details = find.byKey(const Key('dictation-source-details-xai-stt'));
    await tester.ensureVisible(details);
    await tester.tap(details);
    await tester.pumpAndSettle();

    expect(find.text('Setup needed'), findsOneWidget);
    expect(find.text('xAI API key'), findsOneWidget);
    expect(find.textContaining('XAI_API_KEY'), findsNothing);
    expect(find.byKey(const Key('dictation-api-key-xai-stt')), findsOneWidget);
  });

  testWidgets('settings keeps computers and agents quiet until expanded',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: HostsScreen()),
    ));

    expect(find.text('Paired computers'), findsOneWidget);
    expect(find.text('Agent connections'), findsOneWidget);
    expect(find.text('Harness connections'), findsNothing);
    expect(find.text('Open Tethoq Desktop'), findsNothing);
    expect(find.text('local demo data'), findsNothing);
    expect(find.textContaining('Detection:'), findsNothing);
    expect(find.textContaining('paired'), findsNothing);
    expect(find.byType(Card), findsNothing);

    await tester.tap(find.byKey(const Key('settings-section-computers')));
    await tester.pumpAndSettle();

    expect(find.text('Open Tethoq Desktop'), findsOneWidget);
    expect(find.text('Demo computer'), findsNWidgets(2));
    expect(find.text('local demo data'), findsNothing);
    expect(find.byType(Card), findsNothing);

    final details = find.byKey(const Key('paired-computer-details-demo-host'));
    await tester.ensureVisible(details);
    await tester.tap(details);
    await tester.pumpAndSettle();

    expect(find.text('Endpoint'), findsOneWidget);
    expect(find.text('local demo data'), findsOneWidget);
  });

  testWidgets('settings offers agent reconnect only when it is needed',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    final codex = store.providers.first;
    store.providers[0] = ProviderConnection(
      providerId: codex.providerId,
      displayName: codex.displayName,
      state: 'disconnected',
      detected: codex.detected,
      authenticated: false,
      capabilities: codex.capabilities,
    );

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: HostsScreen()),
    ));

    await tester.tap(find.byKey(const Key('settings-section-agents')));
    await tester.pumpAndSettle();
    final codexRow = find.byKey(const Key('agent-connection-codex'));
    await tester.ensureVisible(codexRow);
    await tester.tap(codexRow);
    await tester.pumpAndSettle();

    expect(find.text('Authentication'), findsOneWidget);
    expect(find.text('Needed'), findsOneWidget);
    expect(find.text('Reconnect'), findsOneWidget);

    await tester.tap(find.text('Reconnect'));
    await tester.pumpAndSettle();
    expect(store.providers.first.state, 'online');

    await tester.tap(codexRow);
    await tester.pumpAndSettle();
    expect(find.text('Reconnect'), findsNothing);
  });

  testWidgets('working instructions render as a distinct synced queue rail',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-working';

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    final secondaryControls =
        find.byKey(const Key('session-secondary-controls'));
    await tester.ensureVisible(secondaryControls);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(secondaryControls);
    await tester.pump();
    await tester.tap(find.byKey(const Key('delivery-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Add direction to the work that is running now.'),
        findsOneWidget);
    expect(
        tester
            .widget<ListTile>(find.byKey(const Key('delivery-option-steer')))
            .enabled,
        isTrue);
    await tester.tap(find.byKey(const Key('delivery-option-queue')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    await tester.enterText(find.byKey(const Key('session-composer')),
        'Check this after the build');
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-instruction')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final queueStrip = find.byKey(const Key('queued-instruction-strip'));
    expect(queueStrip, findsOneWidget);
    expect(tester.getSize(queueStrip).height, lessThanOrEqualTo(104));
    expect(find.text('Check this after the build'), findsOneWidget);
    final queued = store.queuedMessagesFor(sessionId).single;
    expect(
        tester
            .getSize(
                find.byKey(ValueKey<String>('queued-actions-${queued.id}')))
            .height,
        greaterThanOrEqualTo(44));
    expect(
        tester
            .getSize(find.byKey(ValueKey<String>('cancel-queued-${queued.id}')))
            .height,
        greaterThanOrEqualTo(44));
    expect(
        tester.getBottomRight(queueStrip).dy,
        lessThanOrEqualTo(tester
            .getTopRight(find.byKey(const Key('session-composer-shell')))
            .dy));
    expect(find.byKey(const Key('session-secondary-controls')), findsOneWidget);
    expect(store.queuedMessagesFor(sessionId), hasLength(1));
    expect(
        find.byKey(ValueKey<String>(
            'message-bubble-${store.queuedMessagesFor(sessionId).single.id}')),
        findsNothing);
  });

  testWidgets('cross-task messages show quiet source attribution',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-codex-api';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'cross-task-mobile',
        sessionId: sessionId,
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 15, 12),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text',
              data: <String, Object?>{'text': 'Please verify this change.'}),
        ],
        status: 'completed',
        origin: const RemoteMessageOrigin(
          kind: 'cross_session',
          envelopeId: 'envelope-mobile',
          sourceSessionId: 'source-task',
          sourceTitle: 'Source task',
        ),
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(find.text('From another Tethoq task · Source task'), findsOneWidget);
    expect(
        find.byKey(const ValueKey<String>('message-origin-cross-task-mobile')),
        findsOneWidget);
  });

  testWidgets('queued local images show a miniature with metadata fallback',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-working';
    const encoded =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    final byteLength = base64Decode(encoded).length;
    store.queuedMessages.addAll(<String, RemoteQueuedMessage>{
      'thumbnail': RemoteQueuedMessage(
        id: 'thumbnail',
        sessionId: sessionId,
        content: 'Queued with a local image',
        state: 'queued',
        createdAt: DateTime.utc(2026, 8, 15, 12),
        attachments: <RemoteQueuedAttachment>[
          RemoteQueuedAttachment(
            name: 'local.png',
            mimeType: 'image/png',
            byteLength: byteLength,
            dataBase64: encoded,
          ),
        ],
      ),
      'metadata': RemoteQueuedMessage(
        id: 'metadata',
        sessionId: sessionId,
        content: 'Queued with metadata only',
        state: 'queued',
        createdAt: DateTime.utc(2026, 8, 15, 12, 0, 1),
        attachments: <RemoteQueuedAttachment>[
          RemoteQueuedAttachment(
            name: 'remote.png',
            mimeType: 'image/png',
            byteLength: byteLength,
          ),
        ],
      ),
    });

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    expect(find.byKey(const ValueKey<String>('queued-image-preview-thumbnail')),
        findsOneWidget);
    final metadataRow =
        find.byKey(const ValueKey<String>('queued-instruction-metadata'));
    expect(
        find.descendant(
            of: metadataRow, matching: find.byIcon(Icons.image_outlined)),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('queued-image-preview-metadata')),
        findsNothing);
    expect(find.descendant(of: metadataRow, matching: find.text('1')),
        findsOneWidget);
  });

  testWidgets('queue actions open a touch-safe hidden side chat',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-working';
    final queued = RemoteQueuedMessage(
      id: 'mobile-queued-actions',
      sessionId: sessionId,
      content: 'Review this in a smaller conversation',
      state: 'queued',
      createdAt: DateTime.utc(2026, 8, 15, 12),
      attachments: const <RemoteQueuedAttachment>[
        RemoteQueuedAttachment(
          name: 'reference.png',
          mimeType: 'image/png',
          byteLength: 128,
        ),
      ],
    );
    store.queuedMessages[queued.id] = queued;

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    expect(find.byKey(const Key('queued-instruction-strip')), findsOneWidget);
    expect(find.text('Review this in a smaller conversation'), findsOneWidget);
    expect(
        find.descendant(
          of: find.byKey(const Key('queued-instruction-strip')),
          matching: find.text('1'),
        ),
        findsOneWidget);

    await tester.tap(find
        .byKey(const ValueKey<String>('queued-actions-mobile-queued-actions')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    for (final key in <String>[
      'queued-action-edit',
      'queued-action-deliver',
      'queued-action-side-chat',
      'queued-action-new-task',
      'queued-action-disable-queue',
    ]) {
      expect(tester.getSize(find.byKey(Key(key))).height,
          greaterThanOrEqualTo(44));
    }

    await tester.tap(find.byKey(const Key('queued-action-new-task')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(const Duration(milliseconds: 550));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byKey(const Key('queued-new-task-picker')), findsOneWidget);
    expect(
        find.byKey(const Key('queued-new-task-model-search')), findsOneWidget);
    expect(find.text('Codex'), findsWidgets);
    expect(find.byKey(const Key('queued-new-task-reasoning')), findsOneWidget);
    final grokModel =
        find.byKey(const ValueKey<String>('queued-model-grok-grok/default'));
    await tester.ensureVisible(grokModel);
    await tester.pump();
    await tester.tap(grokModel);
    await tester.pump();
    expect(find.byKey(const Key('queued-new-task-reasoning')), findsNothing);
    await tester.tap(find.byTooltip('Close'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    await tester.tap(find
        .byKey(const ValueKey<String>('queued-actions-mobile-queued-actions')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    await tester.tap(find.byKey(const Key('queued-action-side-chat')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);
    expect(find.byKey(const Key('promote-side-chat')), findsOneWidget);
    expect(tester.getSize(find.byKey(const Key('side-chat-attachment'))).height,
        greaterThanOrEqualTo(44));
    expect(tester.getSize(find.byKey(const Key('side-chat-dictation'))).height,
        greaterThanOrEqualTo(44));
    expect(store.queuedMessagesFor(sessionId), isEmpty);
    await tester.enterText(
        find.byKey(const Key('side-chat-composer')), 'Keep this draft');
    final sideChatId = store.sideChatsFor(sessionId).single.id;
    expect(store.drafts[sideChatId], 'Keep this draft');

    await tester.tap(find.byTooltip('Close side chat'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.tap(find.byKey(const Key('task-filter-toggle')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(find.byKey(const Key('task-filter-show-side-chats')));
    await tester.pump();
    Navigator.of(tester.element(find.byType(SwitchListTile))).pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    final preview =
        find.byKey(ValueKey<String>('side-chat-preview-$sideChatId'));
    expect(preview, findsOneWidget);
    await tester.tap(preview);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    final reopenedComposer = tester.widget<TextField>(
      find.byKey(const Key('side-chat-composer')),
    );
    expect(reopenedComposer.controller?.text, 'Keep this draft');
  });

  testWidgets(
      'delivery-unknown queue tombstones disable resubmission actions but keep remove',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-working';
    const messageId = 'delivery-unknown-queue';
    store.queuedMessages[messageId] = RemoteQueuedMessage(
      id: messageId,
      sessionId: sessionId,
      content: 'Do not submit this unresolved instruction again',
      state: 'failed',
      createdAt: DateTime.utc(2026, 9, 3, 12),
      attachments: const <RemoteQueuedAttachment>[],
      error: 'The provider acknowledgement was lost',
      retryable: false,
    );

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    await tester.tap(find.byKey(
        const ValueKey<String>('queued-actions-delivery-unknown-queue')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    for (final key in <String>[
      'queued-action-edit',
      'queued-action-deliver',
      'queued-action-side-chat',
      'queued-action-new-task',
    ]) {
      final tile = tester.widget<ListTile>(find.descendant(
        of: find.byKey(Key(key)),
        matching: find.byType(ListTile),
      ));
      expect(tile.onTap, isNull,
          reason: '$key must not retry an unknown delivery');
    }
    final queueToggle = tester.widget<ListTile>(find.descendant(
      of: find.byKey(const Key('queued-action-disable-queue')),
      matching: find.byType(ListTile),
    ));
    expect(queueToggle.onTap, isNotNull);

    Navigator.of(tester.element(find.byKey(const Key('queued-action-edit'))))
        .pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    final remove = tester.widget<IconButton>(find
        .byKey(const ValueKey<String>('cancel-queued-delivery-unknown-queue')));
    expect(remove.onPressed, isNotNull);
    await tester.tap(find
        .byKey(const ValueKey<String>('cancel-queued-delivery-unknown-queue')));
    await tester.pump();
    expect(store.queuedMessages.containsKey(messageId), isFalse);
  });

  testWidgets('queued edit exits safely through Save and Android back',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 1600);
    tester.view.devicePixelRatio = 2.625;
    tester.view.viewPadding = const FakeViewPadding(top: 91);
    tester.view.padding = const FakeViewPadding(top: 91);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetViewInsets);
    final store = DemoRemoteAppStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-working';
    final queued = RemoteQueuedMessage(
      id: 'queued-edit-exit',
      sessionId: sessionId,
      content: 'Original queued message',
      state: 'queued',
      createdAt: DateTime.utc(2026, 8, 15, 12),
      attachments: const <RemoteQueuedAttachment>[],
    );
    store.queuedMessages[queued.id] = queued;

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    Future<void> pumpWithoutLayoutFailure(
        [Duration duration = Duration.zero]) async {
      await tester.pump(duration);
      final exception = tester.takeException();
      expect(
        exception,
        isNull,
        reason: exception is FlutterError
            ? exception.toStringDeep()
            : 'The queued-message route transition must stay layout-safe.',
      );
    }

    Future<void> openEditor() async {
      tester.view.viewInsets = FakeViewPadding.zero;
      await pumpWithoutLayoutFailure();
      await tester.tap(find
          .byKey(const ValueKey<String>('queued-actions-queued-edit-exit')));
      await pumpWithoutLayoutFailure();
      await pumpWithoutLayoutFailure(const Duration(milliseconds: 350));
      await tester.tap(find.byKey(const Key('queued-action-edit')));
      tester.view.viewInsets = const FakeViewPadding(bottom: 850);
      for (final duration in <Duration>[
        Duration.zero,
        const Duration(milliseconds: 100),
        const Duration(milliseconds: 150),
        const Duration(milliseconds: 150),
        Duration.zero,
        Duration.zero,
        const Duration(milliseconds: 350),
      ]) {
        await pumpWithoutLayoutFailure(duration);
      }

      final field = find.byKey(const Key('edit-queued-message-field'));
      final save = find.byKey(const Key('save-queued-message'));
      expect(field, findsOneWidget);
      expect(save, findsOneWidget);
      expect(find.byKey(const Key('queued-action-edit')), findsNothing);
      expect(
        find.byWidgetPredicate(
            (widget) => widget is ModalBarrier && widget.dismissible),
        findsOneWidget,
      );
      final keyboardTop = (1600 - 850) / 2.625;
      for (final target in <Finder>[
        find.text('Edit queued message'),
        field,
        save,
      ]) {
        expect(
            tester.getRect(target).bottom, lessThanOrEqualTo(keyboardTop + 1));
      }
    }

    await openEditor();
    await tester.enterText(find.byKey(const Key('edit-queued-message-field')),
        'Saved queued message');
    final save = find.byKey(const Key('save-queued-message'));
    await tester.ensureVisible(save);
    await pumpWithoutLayoutFailure();
    await tester.tap(save);
    await pumpWithoutLayoutFailure();
    await pumpWithoutLayoutFailure(const Duration(milliseconds: 100));
    await pumpWithoutLayoutFailure(const Duration(milliseconds: 150));
    await pumpWithoutLayoutFailure(const Duration(milliseconds: 250));
    expect(store.queuedMessages[queued.id]?.content, 'Saved queued message');
    expect(find.byKey(const Key('edit-queued-message-field')), findsNothing);

    await openEditor();
    await tester.enterText(find.byKey(const Key('edit-queued-message-field')),
        'This edit should be discarded');
    await WidgetsBinding.instance.handlePopRoute();
    await pumpWithoutLayoutFailure();
    await pumpWithoutLayoutFailure(const Duration(milliseconds: 100));
    await pumpWithoutLayoutFailure(const Duration(milliseconds: 150));
    await pumpWithoutLayoutFailure(const Duration(milliseconds: 250));
    expect(store.queuedMessages[queued.id]?.content, 'Saved queued message');
    expect(find.byKey(const Key('edit-queued-message-field')), findsNothing);

    await openEditor();
    final reopenedField = find.byKey(const Key('edit-queued-message-field'));
    final reopenedEditable = tester.widget<EditableText>(find.descendant(
      of: reopenedField,
      matching: find.byType(EditableText),
    ));
    expect(reopenedEditable.controller.text, 'Saved queued message');
    await tester.enterText(reopenedField, 'Dismiss this outside edit');
    await tester.tapAt(const Offset(8, 4));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(tester.takeException(), isNull);
    expect(find.byKey(const Key('edit-queued-message-field')), findsNothing);
    expect(store.queuedMessages[queued.id]?.content, 'Saved queued message');

    await openEditor();
    final finalEditable = tester.widget<EditableText>(find.descendant(
      of: find.byKey(const Key('edit-queued-message-field')),
      matching: find.byType(EditableText),
    ));
    expect(finalEditable.controller.text, 'Saved queued message');
    await WidgetsBinding.instance.handlePopRoute();
    await pumpWithoutLayoutFailure();
    await pumpWithoutLayoutFailure(const Duration(milliseconds: 500));
    expect(find.byKey(const Key('edit-queued-message-field')), findsNothing);
  });

  testWidgets('side chat hides copied parent context behind a brief note',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-codex-api';
    store.showSideChats = true;
    final sideChat = await store.createSideChat(sessionId);
    store.messages[sideChat.id] = <RemoteMessage>[
      RemoteMessage(
        id: '${sideChat.id}:copied:1',
        sessionId: sideChat.id,
        providerMessageId: 'copied:parent-message:1',
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 11, 10),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text',
              data: <String, Object?>{'text': 'Inherited parent context'}),
        ],
        status: 'completed',
      ),
      RemoteMessage(
        id: 'real-side-chat-message',
        sessionId: sideChat.id,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 11),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text',
              data: <String, Object?>{'text': 'A real side chat answer'}),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();
    final preview =
        find.byKey(ValueKey<String>('side-chat-preview-${sideChat.id}'));
    expect(preview, findsOneWidget);
    await tester.tap(preview);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);
    expect(find.text('Inherited parent context'), findsNothing);
    expect(find.text('A real side chat answer'), findsOneWidget);
    expect(
        find.text('This side chat already carries the parent task\'s context.'),
        findsNothing);

    store.messages[sideChat.id] = <RemoteMessage>[
      RemoteMessage(
        id: '${sideChat.id}:copied:1',
        sessionId: sideChat.id,
        providerMessageId: 'copied:parent-message:1',
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 11, 10),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text',
              data: <String, Object?>{'text': 'Inherited parent context'}),
        ],
        status: 'completed',
      ),
    ];
    await tester.tap(find.byTooltip('Close side chat'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    await tester.tap(preview);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('Inherited parent context'), findsNothing);
    expect(
        find.text('This side chat already carries the parent task\'s context.'),
        findsOneWidget);
  });

  testWidgets('stopped Codex text keeps copy and edit in its long-press menu',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-codex-api';
    store.messages[sessionId] = <RemoteMessage>[
      RemoteMessage(
        id: 'editable-user',
        sessionId: sessionId,
        providerMessageId: 'native-user',
        role: 'user',
        createdAt: DateTime.utc(2026, 8, 11, 12),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text',
              data: <String, Object?>{'text': 'Original instruction'}),
        ],
        status: 'completed',
        editable: true,
      ),
      RemoteMessage(
        id: 'later-agent',
        sessionId: sessionId,
        role: 'assistant',
        createdAt: DateTime.utc(2026, 8, 11, 12, 1),
        parts: const <ContentPart>[
          ContentPart(
              type: 'text', data: <String, Object?>{'text': 'Old response'}),
        ],
        status: 'completed',
      ),
    ];

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('delivery-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Available while this session is actively working.'),
        findsOneWidget);
    expect(find.text('This harness does not support live steering.'),
        findsNothing);
    expect(
        tester
            .widget<ListTile>(find.byKey(const Key('delivery-option-steer')))
            .enabled,
        isFalse);
    await tester.tap(find.byKey(const Key('delivery-option-queue')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final editableGesture = find
        .ancestor(
          of: find
              .byKey(const ValueKey<String>('message-bubble-editable-user')),
          matching: find.byType(GestureDetector),
        )
        .first;
    await tester.longPress(editableGesture);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('copy-message-editable-user')),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('edit-message-editable-user')),
        findsOneWidget);

    await tester
        .tap(find.byKey(const ValueKey<String>('edit-message-editable-user')));
    await tester.pumpAndSettle();
    expect(find.textContaining('Files already changed'), findsOneWidget);
    await tester.enterText(
        find.byKey(const Key('edit-message-field')), 'Revised instruction');
    await tester.tap(find.byKey(const Key('confirm-edit-message')));
    await tester.pump();

    expect(store.messages[sessionId], hasLength(1));
    expect(store.messages[sessionId]!.single.parts.single.summary,
        'Revised instruction');
    expect(store.sessions.firstWhere((item) => item.id == sessionId).state,
        'working');
    expect(find.text('Old response'), findsNothing);
  });

  testWidgets('slash palette opens immediately, filters, and inserts on Enter',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));

    final composer = find.byKey(const Key('session-composer'));
    await tester.enterText(composer, '/');
    await tester.pump();
    expect(find.byKey(const Key('slash-command-palette')), findsOneWidget);
    expect(
        find.byKey(const Key('simplify-command-suggestion')), findsOneWidget);
    expect(find.byKey(const Key('mesh-command-suggestion')), findsOneWidget);
    expect(find.byKey(const Key('goal-command-suggestion')), findsOneWidget);
    expect(find.byKey(const Key('ears-command-suggestion')), findsOneWidget);
    expect(find.byKey(const Key('eyes-command-suggestion')), findsOneWidget);
    expect(tester.widget<TextField>(composer).controller!.text, '/');

    await tester.enterText(composer, '/si');
    await tester.pump();
    expect(
        find.byKey(const Key('simplify-command-suggestion')), findsOneWidget);
    expect(find.byKey(const Key('mesh-command-suggestion')), findsNothing);
    expect(tester.widget<TextField>(composer).controller!.text, '/si');

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(tester.widget<TextField>(composer).controller!.text, '/simplify ');
    expect(find.byKey(const Key('slash-command-palette')), findsNothing);
    expect(find.byKey(const Key('simplify-composer-chip')), findsOneWidget);
  });

  testWidgets('delegated work renders as a compact spawned sub-agent row',
      (tester) async {
    final store = DemoRemoteAppStore();
    await store.initialize();
    const sessionId = 'demo-opencode-e2e';
    store.delegations['mesh-test'] = RemoteDelegationTask(
      id: 'mesh-test',
      parentSessionId: sessionId,
      prompt: 'Review the live event flow',
      state: 'working',
      createdAt: DateTime.utc(2026, 8, 12, 10),
      updatedAt: DateTime.utc(2026, 8, 12, 10),
      children: const <RemoteDelegationChild>[
        RemoteDelegationChild(
          id: 'mesh-child',
          providerId: 'codex',
          sessionId: 'demo-codex-api',
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'ultra',
          state: 'working',
        ),
      ],
    );
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();

    // The expandable coordination rail was replaced by one compact top-level
    // row per materialized child, so the child is readable without expanding
    // anything and the parent transcript keeps a permanent record of the spawn.
    final Finder row = find.byKey(
        const ValueKey<String>('spawned-subagent-mesh-test:child:mesh-child'));
    expect(row, findsOneWidget);
    expect(find.byKey(const ValueKey<String>('delegation-task-mesh-test')),
        findsNothing);
    expect(find.text('Delegated harnesses are working'), findsNothing);
    expect(
        find.descendant(of: row, matching: find.text('Spawned sub-agent')),
        findsOneWidget);
    expect(
        find.descendant(of: row, matching: find.textContaining('Codex')),
        findsOneWidget);
    expect(
        find.descendant(of: row, matching: find.textContaining('Ultra')),
        findsOneWidget);
    // A working child still presents as live.
    expect(
        find.byKey(const ValueKey<String>(
            'spawned-subagent-spinner-demo-codex-api')),
        findsOneWidget);
  });

  testWidgets('eyes picker explicitly selects model and reasoning effort',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _VisionProxyDemoStore();
    await store.initialize();
    const sessionId = 'demo-codex-api';

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    final secondaryControls =
        find.byKey(const Key('session-secondary-controls'));
    await tester.ensureVisible(secondaryControls);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(secondaryControls);
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final visionModel =
        find.byKey(const Key('vision-model-codex-widget-test-vision-model'));
    tester.widget<ListTile>(visionModel).onTap!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    final highEffort = find.byKey(const Key('vision-effort-high'));
    tester.widget<ListTile>(highEffort).onTap!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));

    expect(store.configured?.providerId, 'codex');
    expect(store.configured?.modelId, 'widget-test-vision-model');
    expect(store.configured?.reasoningEffort, 'high');
    expect(find.text('Eyes: widget-test-vision-model'), findsNothing);
    store.modelsByProvider['codex'] =
        _VisionProxyDemoStore.availableTargets.single.models;
    store.notifyListeners();
    await tester.pump();
    await tester.tap(secondaryControls);
    await tester.pump();
    final eyesLabels = tester
        .widgetList<Text>(find.byType(Text))
        .map((widget) => widget.data)
        .whereType<String>()
        .where((text) => text.startsWith('Eyes:'))
        .toList(growable: false);
    expect(eyesLabels, <String>['Eyes: Vision test model']);
    expect(secondaryControls, findsOneWidget);
  });

  testWidgets('eyes picker paints before catalogue and wallet hydration',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _DelayedVisionProxyDemoStore();
    await store.initialize();

    await tester.pumpWidget(StoreScope(
      store: store,
      child:
          const MaterialApp(home: SessionScreen(sessionId: 'demo-codex-api')),
    ));
    await tester.pump();
    final controls = find.byKey(const Key('session-secondary-controls'));
    await tester.tap(controls);
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pump();

    expect(find.text('Visual support'), findsOneWidget);
    expect(find.byKey(const Key('vision-picker-hydrating')), findsOneWidget);
    final hydrationSlot = find.byKey(const Key('vision-picker-hydration-slot'));
    expect(tester.getSize(hydrationSlot).height, 4);
    expect(find.byKey(const Key('vision-api-google')), findsOneWidget);
    expect(find.byKey(const Key('vision-api-xai')), findsOneWidget);
    expect(
        find.text(
            'Add a key above or connect an image-capable model in a harness.'),
        findsNothing);

    store.completeHydration();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.byKey(const Key('vision-model-codex-widget-test-vision-model')),
        findsOneWidget);
    expect(find.byKey(const Key('vision-picker-hydrating')), findsNothing);
    expect(tester.getSize(hydrationSlot).height, 4);
  });

  testWidgets('an open eyes picker drops an invalidated cached catalogue',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _InvalidatingVisionProxyDemoStore();
    await store.initialize();
    addTearDown(store.completeRefresh);

    await tester.pumpWidget(StoreScope(
      store: store,
      child:
          const MaterialApp(home: SessionScreen(sessionId: 'demo-codex-api')),
    ));
    await tester.pump();
    final controls = find.byKey(const Key('session-secondary-controls'));
    await tester.tap(controls);
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pump();
    await tester.pump();

    final model =
        find.byKey(const Key('vision-model-codex-widget-test-vision-model'));
    expect(model, findsOneWidget);
    store.invalidateCatalogue();
    await tester.pump();

    expect(model, findsNothing);
    expect(store.refreshCalls, greaterThanOrEqualTo(2));
    store.completeRefresh();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  });

  testWidgets('eyes picker owns failures and keeps a rejected key editable',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FailingVisionProxyDemoStore();
    await store.initialize();

    await tester.pumpWidget(StoreScope(
      store: store,
      child:
          const MaterialApp(home: SessionScreen(sessionId: 'demo-codex-api')),
    ));
    await tester.pump();
    final controls = find.byKey(const Key('session-secondary-controls'));
    await tester.tap(controls);
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(
        find.text('Tethoq could not refresh visual models.'), findsOneWidget);
    expect(find.text('Current choice could not be refreshed.'), findsOneWidget);
    expect(find.textContaining(r'C:\private\wallet.json'), findsNothing);

    await tester.tap(find.byKey(const Key('vision-api-google')));
    await tester.pumpAndSettle();
    const rejectedKey = 'bad-key-1234';
    final keyField =
        find.byKey(const ValueKey<String>('vision-api-key-google'));
    await tester.enterText(keyField, rejectedKey);
    await tester.tap(find.text('Save and use now'));
    await tester.pumpAndSettle();

    expect(store.validateApiKeyRequested, isTrue);
    expect(find.text('That API key was not accepted. Check it and try again.'),
        findsOneWidget);
    expect(find.textContaining('AUTH_INVALID'), findsNothing);
    expect(find.textContaining(r'C:\private\wallet.json'), findsNothing);
    expect(tester.widget<TextField>(keyField).controller!.text, rejectedKey);
  });

  testWidgets('eyes API switches stage choices until Use as eyes applies them',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _ApiToggleVisionDemoStore();
    await store.initialize();
    await tester.pumpWidget(StoreScope(store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: 'demo-codex-api'))));
    await tester.pump();
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pumpAndSettle();
    final google = find.byKey(const Key('vision-api-google'));
    final xai = find.byKey(const Key('vision-api-xai'));
    Future<void> reopen() async {
      await tester.tap(find.byKey(const Key('session-secondary-controls')));
      await tester.pump();
      await tester.tap(find.byKey(const Key('vision-control')));
      await tester.pumpAndSettle();
    }
    Future<void> apply() async {
      await tester.scrollUntilVisible(find.text('Use as eyes'), 100,
          scrollable: find.descendant(of: find.byType(BottomSheet),
              matching: find.byType(Scrollable)).last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Use as eyes'));
      await tester.pumpAndSettle();
    }
    expect(tester.widget<ListTile>(google).selected, isFalse);
    await tester.ensureVisible(google);
    await tester.pumpAndSettle();
    await tester.tap(google);
    await tester.pumpAndSettle();
    expect(store.configured, isNull);
    expect(tester.widget<ListTile>(google).selected, isTrue);
    expect(find.text('Visual support'), findsOneWidget);
    await tester.tap(google);
    await tester.pumpAndSettle();
    expect(tester.widget<ListTile>(google).selected, isFalse);
    await tester.tap(google);
    await tester.pumpAndSettle();
    final reasoning = find.descendant(of: find.byKey(const Key('vision-api-reasoning')),
        matching: find.byType(DropdownButton<String>));
    expect(tester.widget<DropdownButton<String>>(reasoning).value, isNull);
    tester.widget<DropdownButton<String>>(reasoning).onChanged!('high');
    await tester.pumpAndSettle();
    await apply();
    expect(store.configured?.modelId, 'google::vision-test');
    expect(store.configured?.reasoningEffort, 'high');
    await reopen();
    expect(tester.widget<DropdownButton<String>>(reasoning).value, 'high');
    tester.widget<DropdownButton<String>>(reasoning).onChanged!('xhigh');
    await tester.pumpAndSettle();
    await apply();
    expect(store.configured?.reasoningEffort, 'xhigh');
    await reopen();
    store.fail = true;
    await tester.ensureVisible(xai);
    await tester.pumpAndSettle();
    await tester.tap(xai);
    await tester.pumpAndSettle();
    tester.widget<DropdownButton<String>>(reasoning).onChanged!('high');
    await tester.pumpAndSettle();
    expect(store.configured?.modelId, 'google::vision-test');
    expect(tester.widget<ListTile>(xai).selected, isTrue);
    await apply();
    expect(store.configured?.modelId, 'google::vision-test');
    expect(find.byKey(const Key('vision-selection-error')), findsOneWidget);
    store.fail = false;
    await apply();
    expect(store.configured?.modelId, 'xai::vision-test');
    await reopen();
    expect(tester.widget<ListTile>(google).selected, isFalse);
    expect(tester.widget<ListTile>(xai).selected, isTrue);
    await tester.tap(xai);
    await tester.pumpAndSettle();
    expect(store.configured?.modelId, 'xai::vision-test');
    expect(tester.widget<ListTile>(xai).selected, isFalse);
    await apply();
    expect(store.configured, isNull);
    await reopen();
    await tester.tap(find.byTooltip('Replace Gemini API key'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('vision-api-key-google')),
        'replacement-fixture-key');
    await tester.tap(find.text('Save and use now'));
    await tester.pumpAndSettle();
    expect(store.configured?.modelId, 'google::vision-test');
    expect(tester.widget<ListTile>(google).selected, isTrue);
  });

  testWidgets('eyes picker reflects a hot external selection update',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _VisionProxyDemoStore();
    await store.initialize();
    const sessionId = 'demo-codex-api';

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    final controls = find.byKey(const Key('session-secondary-controls'));
    await tester.tap(controls);
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final model =
        find.byKey(const Key('vision-model-codex-widget-test-vision-model'));
    expect(tester.widget<ListTile>(model).selected, isFalse);

    store.applyExternalSelection(
      sessionId,
      const VisionProxySelection(
        providerId: 'codex',
        modelId: 'widget-test-vision-model',
        reasoningEffort: 'high',
      ),
    );
    await tester.pump();

    expect(tester.widget<ListTile>(model).selected, isTrue);
    expect(find.text('Disable visual support'), findsOneWidget);
  });

  testWidgets('failed eyes selection remains retryable without raw errors',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _RetryVisionProxyDemoStore();
    await store.initialize();

    await tester.pumpWidget(StoreScope(
      store: store,
      child:
          const MaterialApp(home: SessionScreen(sessionId: 'demo-codex-api')),
    ));
    await tester.pump();
    final controls = find.byKey(const Key('session-secondary-controls'));
    await tester.tap(controls);
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    tester
        .widget<ListTile>(find
            .byKey(const Key('vision-model-codex-widget-test-vision-model')))
        .onTap!();
    await tester.pumpAndSettle();
    tester
        .widget<ListTile>(find.byKey(const Key('vision-effort-high')))
        .onTap!();
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('vision-selection-error')), findsOneWidget);
    expect(find.textContaining('provider stack trace'), findsNothing);
    final retry = find.descendant(
        of: find.byKey(const Key('vision-selection-error')),
        matching: find.text('Retry'));
    await tester.tap(retry);
    await tester.pumpAndSettle();

    expect(store.configureAttempts, 2);
    expect(store.configured?.reasoningEffort, 'high');
    expect(find.text('Visual support'), findsNothing);
  });

  testWidgets(
      'mounted session route never adopts or mutates a colliding host draft',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-working';
    final aAttachment = _hostSwitchAttachment('host-a-main.png');
    final bAttachment = _hostSwitchAttachment('host-b-main.png');
    store.setDraft(sessionId, 'Host A main draft');
    store.setDraftAttachments(sessionId, <RemoteAttachment>[aAttachment]);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Host A main draft',
    );
    expect(
      find.byKey(const ValueKey<String>('pending-image-host-a-main.png')),
      findsOneWidget,
    );

    store.switchToHostB(
      sessionId,
      draft: 'Host B protected main draft',
      attachments: <RemoteAttachment>[bAttachment],
      modelId: 'host-b-protected-model',
      reasoningEffort: 'low',
      state: 'working',
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final staleComposer = find.byKey(const Key('session-composer'));
    if (staleComposer.evaluate().isNotEmpty) {
      final field = tester.widget<TextField>(staleComposer);
      expect(field.controller?.text, 'Host A main draft',
          reason: 'the mounted Host A route must never reconcile Host B');
      expect(
        find.byKey(const ValueKey<String>('pending-image-host-b-main.png')),
        findsNothing,
      );
      if (field.enabled != false) {
        await tester.enterText(staleComposer, 'Late edit from Host A');
        await tester.pump();
      }
    }
    expect(store.drafts[sessionId], 'Host B protected main draft');
    expect(store.draftAttachmentsFor(sessionId), hasLength(1));
    expect(store.draftAttachmentsFor(sessionId).single.name, 'host-b-main.png');
    expect(store.hostBDraftMutationCalls, isEmpty);
  });

  testWidgets(
      'mounted side chat never adopts or mutates a colliding host draft',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: 'demo-working')),
    ));
    await tester.pump();
    final sideChatId = await _openSideChatForDictation(tester, store);
    await tester.enterText(
        find.byKey(const Key('side-chat-composer')), 'Host A side draft');
    final aAttachment = _hostSwitchAttachment('host-a-side.png');
    final bAttachment = _hostSwitchAttachment('host-b-side.png');
    store.setDraftAttachments(sideChatId, <RemoteAttachment>[aAttachment]);
    store.notifyListeners();
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>(
          'side-chat-attachment-chip-host-a-side.png-0')),
      findsOneWidget,
    );

    store.switchToHostB(
      sideChatId,
      parentSessionId: 'demo-working',
      draft: 'Host B protected side draft',
      attachments: <RemoteAttachment>[bAttachment],
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    final staleComposer = find.byKey(const Key('side-chat-composer'));
    if (staleComposer.evaluate().isNotEmpty) {
      final field = tester.widget<TextField>(staleComposer);
      expect(field.controller?.text, 'Host A side draft',
          reason: 'the mounted Host A side chat must never reconcile Host B');
      expect(
        find.byKey(const ValueKey<String>(
            'side-chat-attachment-chip-host-b-side.png-0')),
        findsNothing,
      );
      if (field.enabled != false) {
        await tester.enterText(staleComposer, 'Late side edit from Host A');
        await tester.pump();
      }
    }
    expect(store.drafts[sideChatId], 'Host B protected side draft');
    expect(store.draftAttachmentsFor(sideChatId), hasLength(1));
    expect(
        store.draftAttachmentsFor(sideChatId).single.name, 'host-b-side.png');
    expect(store.hostBDraftMutationCalls, isEmpty);
  });

  testWidgets('late Host A image picker result is discarded after Host B wins',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-working';
    final picker = Completer<RemoteAttachment?>();
    var pickerCalls = 0;

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: sessionId,
          imageAttachmentPicker: () {
            pickerCalls += 1;
            return picker.future;
          },
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.byKey(const Key('attachment-source-photos')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(pickerCalls, 1);

    final bAttachment = _hostSwitchAttachment('host-b-picker.png');
    store.switchToHostB(
      sessionId,
      draft: 'Host B picker draft',
      attachments: <RemoteAttachment>[bAttachment],
      state: 'working',
    );
    await tester.pump();
    picker.complete(_hostSwitchAttachment('late-host-a-picker.png'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));

    expect(store.draftAttachmentsFor(sessionId), hasLength(1));
    expect(
        store.draftAttachmentsFor(sessionId).single.name, 'host-b-picker.png');
    expect(
      find.byKey(
          const ValueKey<String>('pending-image-late-host-a-picker.png')),
      findsNothing,
    );
    expect(store.hostBDraftMutationCalls, isEmpty);
  });

  testWidgets('stale EYES API-key sheet cannot configure either host',
      (tester) async {
    tester.view.physicalSize = const Size(430, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-codex-api';

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('vision-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.byKey(const Key('vision-api-google')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('vision-api-key-google')),
        findsOneWidget);

    store.switchToHostB(sessionId, draft: 'Host B EYES draft');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    store.clearHostRequestLog();
    final keyField =
        find.byKey(const ValueKey<String>('vision-api-key-google'));
    if (keyField.evaluate().isNotEmpty) {
      await tester.enterText(keyField, 'stale-google-key-1234');
      final save = find.ancestor(
        of: find.text('Save and use now'),
        matching: find.byType(FilledButton),
      );
      tester.widget<FilledButton>(save).onPressed?.call();
      await tester.pumpAndSettle();
    }

    expect(store.walletConfigureRequests, isEmpty);
    expect(store.walletLoadRequests, isEmpty);
  });

  testWidgets('stale wallet endpoint choice cannot load from either host',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    final sessionId = store.addDirectWalletSession();

    await _openHostSwitchWallet(tester, store, sessionId);
    store.switchToHostB(
      sessionId,
      draft: 'Host B wallet draft',
      modelId: _HostSwitchingDemoStore.directModelId,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    store.clearHostRequestLog();
    final selector = find.byKey(const Key('wallet-endpoint-selector'));
    if (selector.evaluate().isNotEmpty) {
      tester
          .widget<DropdownButtonFormField<String>>(selector)
          .onChanged
          ?.call('xai');
      await tester.pumpAndSettle();
    }

    expect(store.walletLoadRequests, isEmpty);
    expect(store.walletConfigureRequests, isEmpty);
  });

  testWidgets('stale wallet Save cannot configure either host', (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    final sessionId = store.addDirectWalletSession();

    await _openHostSwitchWallet(tester, store, sessionId);
    store.switchToHostB(
      sessionId,
      draft: 'Host B wallet draft',
      modelId: _HostSwitchingDemoStore.directModelId,
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    store.clearHostRequestLog();
    final keyField = find.byKey(const Key('wallet-api-key-field'));
    if (keyField.evaluate().isNotEmpty) {
      await tester.enterText(keyField, 'stale-wallet-key-1234');
      tester
          .widget<FilledButton>(find.byKey(const Key('wallet-save')))
          .onPressed
          ?.call();
      await tester.pumpAndSettle();
    }

    expect(store.walletConfigureRequests, isEmpty);
    expect(store.walletLoadRequests, isEmpty);
  });

  testWidgets('stale model choice cannot mutate a colliding prepared task',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    final prepared = store.addPreparedHostSwitchSession();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: prepared.id)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.byKey(const Key('model-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('searchable-model-picker')), findsOneWidget);

    store.switchToHostB(
      prepared.id,
      draft: 'Host B prepared draft',
      modelId: 'host-b-protected-model',
      reasoningEffort: 'low',
    );
    await tester.pump();
    store.clearHostRequestLog();
    store.preparedSelectionRequests.clear();
    final staleChoice = find.byKey(
        const Key('catalog-codex-${_HostSwitchingDemoStore.secondaryModelId}'));
    if (staleChoice.evaluate().isNotEmpty) {
      await tester.tap(staleChoice);
      await tester.pumpAndSettle();
    }

    expect(store.preparedSelectionRequests, isEmpty);
    expect(store.walletLoadRequests, isEmpty);
    expect(store.sessionById(prepared.id)?.modelId, 'host-b-protected-model');
    expect(store.sessionById(prepared.id)?.reasoningEffort, 'low');
  });

  testWidgets('stale reasoning choice cannot mutate a colliding prepared task',
      (tester) async {
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    final prepared = store.addPreparedHostSwitchSession();

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: prepared.id)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reasoning-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('Ultra'), findsOneWidget);

    store.switchToHostB(
      prepared.id,
      draft: 'Host B prepared draft',
      modelId: 'host-b-protected-model',
      reasoningEffort: 'low',
    );
    await tester.pump();
    store.preparedSelectionRequests.clear();
    final staleChoice = find.text('Ultra');
    if (staleChoice.evaluate().isNotEmpty) {
      await tester.tap(staleChoice);
      await tester.pumpAndSettle();
    }

    expect(store.preparedSelectionRequests, isEmpty);
    expect(store.sessionById(prepared.id)?.modelId, 'host-b-protected-model');
    expect(store.sessionById(prepared.id)?.reasoningEffort, 'low');
  });

  testWidgets('stale dictation source choice cannot mutate either host',
      (tester) async {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    tester.view.physicalSize = const Size(430, 820);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostSwitchingDemoStore();
    await store.initialize();
    addTearDown(store.dispose);
    const sessionId = 'demo-working';

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-source-control')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('dictation-source-option-xai-stt')),
        findsOneWidget);

    store.switchToHostB(
      sessionId,
      draft: 'Host B dictation draft',
      state: 'working',
    );
    store.dictationSourcePreferences['codex'] = 'host-b-protected-source';
    store.dictationSourceRequests.clear();
    await tester.pump();
    final staleChoice =
        find.byKey(const Key('dictation-source-option-xai-stt'));
    if (staleChoice.evaluate().isNotEmpty) {
      await tester.tap(staleChoice);
      await tester.pumpAndSettle();
    }

    expect(store.dictationSourceRequests, isEmpty);
    expect(
        store.dictationSourcePreferences['codex'], 'host-b-protected-source');
  });
}

class _TextOnlyModelDemoStore extends DemoRemoteAppStore {
  static const modelId = 'widget-test-text-only-model';

  @override
  Future<List<RemoteModel>> loadModels(
    String providerId, {
    bool force = false,
    bool surfaceErrors = true,
  }) async {
    final models = <RemoteModel>[
      RemoteModel(
        id: modelId,
        providerId: providerId,
        displayName: 'Text-only test model',
        isDefault: true,
        nativeMetadata: const <String, Object?>{
          'inputModalities': <Object?>['text'],
        },
      ),
    ];
    modelsByProvider[providerId] = models;
    notifyListeners();
    return models;
  }
}

class _ApiToggleVisionDemoStore extends _VisionProxyDemoStore {
  bool fail = false;

  @override
  Future<ProviderWalletStatus> configureWallet({
    required String providerId, required String endpointId,
    String? modelId, String? apiKey, bool validateApiKey = false,
    bool clearApiKey = false, bool clearBalance = false,
    double? setBalance, double? addBalance, Map<String, Object?>? customEndpoint,
  }) async {
    expect(validateApiKey, isTrue);
    return (await loadWallet(providerId, endpointId: endpointId))!;
  }

  @override
  Future<List<VisionProxyTarget>> loadVisionProxyTargets({bool force = false}) async => [
    VisionProxyTarget(providerId: 'direct', displayName: 'Direct API', models: [
      for (final endpoint in ['google', 'xai'])
        RemoteModel(id: '$endpoint::vision-test', providerId: 'direct',
          displayName: '$endpoint vision', isDefault: true,
          inputModalities: const ['text', 'image'],
          nativeMetadata: const {'walletKind': 'user_api', 'apiKeyConfigured': true, 'apiKeyVerified': true, 'reasoningEfforts': ['minimal', 'high', 'xhigh']}),
    ]),
  ];

  @override
  Future<ProviderWalletStatus?> loadWallet(String providerId,
      {String? modelId, String? endpointId, bool force = false}) async =>
    ProviderWalletStatus(providerId: 'direct', kind: 'user_api', label: 'API',
      detail: '', currency: 'USD', endpointId: endpointId, apiKeyConfigured: true);

  @override
  Future<VisionProxyStatus> configureVisionProxy(String sessionId, VisionProxySelection? selection) {
    if (fail) throw StateError('fixture-failure');
    return super.configureVisionProxy(sessionId, selection);
  }
}

class _VisionProxyDemoStore extends DemoRemoteAppStore {
  static const availableTargets = <VisionProxyTarget>[
    VisionProxyTarget(
      providerId: 'codex',
      displayName: 'Codex',
      models: <RemoteModel>[
        RemoteModel(
          id: 'widget-test-vision-model',
          providerId: 'codex',
          displayName: 'Vision test model',
          isDefault: true,
          inputModalities: <String>['text', 'image'],
          nativeMetadata: <String, Object?>{
            'supportedReasoningEfforts': <Object?>[
              <String, Object?>{'reasoningEffort': 'low'},
              <String, Object?>{'reasoningEffort': 'high'},
            ],
            'defaultReasoningEffort': 'low',
          },
        ),
      ],
    ),
  ];

  VisionProxySelection? configured;

  @override
  Future<List<VisionProxyTarget>> loadVisionProxyTargets(
          {bool force = false}) async =>
      availableTargets;

  @override
  Future<VisionProxyStatus> loadVisionProxy(String sessionId) async =>
      VisionProxyStatus(
        sessionId: sessionId,
        primaryModelSupportsImageInput: false,
        configured: configured,
      );

  @override
  Future<VisionProxyStatus> configureVisionProxy(
      String sessionId, VisionProxySelection? selection) async {
    configured = selection;
    final status = VisionProxyStatus(
      sessionId: sessionId,
      primaryModelSupportsImageInput: false,
      configured: selection,
    );
    visionBySession[sessionId] = status;
    notifyListeners();
    return status;
  }

  void applyExternalSelection(
      String sessionId, VisionProxySelection? selection) {
    configured = selection;
    visionBySession[sessionId] = VisionProxyStatus(
      sessionId: sessionId,
      primaryModelSupportsImageInput: false,
      configured: selection,
    );
    notifyListeners();
  }
}

RemoteAttachment _hostSwitchAttachment(String name) {
  final bytes = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
  return RemoteAttachment(
    name: name,
    mimeType: 'image/png',
    dataBase64: base64Encode(bytes),
    byteLength: bytes.length,
    origin: 'widget-test',
  );
}

Future<void> _openHostSwitchWallet(WidgetTester tester,
    _HostSwitchingDemoStore store, String sessionId) async {
  await tester.pumpWidget(StoreScope(
    store: store,
    child: MaterialApp(home: SessionScreen(sessionId: sessionId)),
  ));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  await tester.tap(find.byKey(const Key('session-secondary-controls')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('wallet-source-control')));
  await tester.pumpAndSettle();
  expect(find.byKey(const Key('wallet-api-key-field')), findsOneWidget);
  store.clearHostRequestLog();
}

class _HostSwitchingDemoStore extends _VisionProxyDemoStore {
  static const hostBId = 'widget-host-b';
  static const primaryModelId = 'widget-primary-model';
  static const secondaryModelId = 'widget-secondary-model';
  static const directModelId = 'openai::widget-direct-model';
  static const directSessionId = 'widget-direct-wallet-session';

  static final PairedHost _hostB = PairedHost(
    hostId: hostBId,
    hostPublicKeyPem: 'widget-host-b-public-key',
    endpoint: 'ws://127.0.0.1/widget-host-b',
    deviceId: 'widget-host-b-device',
    devicePrivateKey: const <int>[3],
    devicePublicKey: const <int>[4],
    credential:
        const SignedCredential(payload: 'widget-b', signature: 'widget-b'),
    displayName: 'Widget Host B',
  );

  static const List<RemoteModel> _codexModels = <RemoteModel>[
    RemoteModel(
      id: primaryModelId,
      providerId: 'codex',
      displayName: 'Primary widget model',
      isDefault: true,
      inputModalities: <String>['text', 'image'],
      nativeMetadata: <String, Object?>{
        'supportedReasoningEfforts': <Object?>[
          <String, Object?>{'reasoningEffort': 'low'},
          <String, Object?>{'reasoningEffort': 'medium'},
          <String, Object?>{'reasoningEffort': 'high'},
          <String, Object?>{'reasoningEffort': 'ultra'},
        ],
        'defaultReasoningEffort': 'low',
      },
    ),
    RemoteModel(
      id: secondaryModelId,
      providerId: 'codex',
      displayName: 'Secondary widget model',
      isDefault: false,
      inputModalities: <String>['text', 'image'],
      nativeMetadata: <String, Object?>{
        'supportedReasoningEfforts': <Object?>[
          <String, Object?>{'reasoningEffort': 'low'},
          <String, Object?>{'reasoningEffort': 'high'},
        ],
        'defaultReasoningEffort': 'high',
      },
    ),
  ];

  final List<String> hostBDraftMutationCalls = <String>[];
  final List<String> preparedSelectionRequests = <String>[];
  final List<String> dictationSourceRequests = <String>[];
  final List<String> walletLoadRequests = <String>[];
  final List<String> walletConfigureRequests = <String>[];

  @override
  Future<void> initialize() async {
    await super.initialize();
    modelsByProvider['codex'] = _codexModels;
  }

  String get _requestHost => activeHost?.hostId ?? 'no-host';

  RemoteSession? sessionById(String sessionId) =>
      sessions.where((session) => session.id == sessionId).firstOrNull;

  @override
  void setDraft(String sessionId, String value) {
    if (_requestHost == hostBId) {
      hostBDraftMutationCalls.add('text:$sessionId');
    }
    super.setDraft(sessionId, value);
  }

  @override
  void setDraftAttachments(
      String sessionId, Iterable<RemoteAttachment> attachments) {
    if (_requestHost == hostBId) {
      hostBDraftMutationCalls.add('attachments:$sessionId');
    }
    super.setDraftAttachments(sessionId, attachments);
  }

  @override
  void updatePreparedModelSelection(
    String sessionId, {
    required String? modelId,
    required String? reasoningEffort,
  }) {
    preparedSelectionRequests
        .add('$_requestHost:$sessionId:$modelId:$reasoningEffort');
    super.updatePreparedModelSelection(
      sessionId,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
    );
  }

  @override
  Future<void> setDictationSourceForHarness(
      String harnessId, String sourceId) async {
    dictationSourceRequests.add('$_requestHost:$harnessId:$sourceId');
    await super.setDictationSourceForHarness(harnessId, sourceId);
  }

  @override
  Future<List<RemoteModel>> loadModels(
    String providerId, {
    bool force = false,
    bool surfaceErrors = true,
  }) async {
    if (providerId == 'codex') {
      modelsByProvider[providerId] = _codexModels;
      return _codexModels;
    }
    return super.loadModels(
      providerId,
      force: force,
      surfaceErrors: surfaceErrors,
    );
  }

  @override
  Future<List<RemoteModel>> loadModelCatalog() async => modelsByProvider.values
      .expand((models) => models)
      .toList(growable: false);

  ProviderWalletStatus _directWallet(String endpointId,
          {bool configured = false}) =>
      ProviderWalletStatus(
        providerId: 'direct',
        kind: 'user_api',
        label: 'Direct API wallet',
        detail: 'Encrypted locally on the selected host.',
        endpointId: endpointId,
        endpointName: switch (endpointId) {
          'xai' => 'xAI API',
          'google' => 'Gemini API',
          _ => 'OpenAI',
        },
        currency: 'USD',
        apiKeyConfigured: configured,
        apiKeyLabel: switch (endpointId) {
          'xai' => 'XAI_API_KEY',
          'google' => 'GOOGLE_API_KEY',
          _ => 'OPENAI_API_KEY',
        },
        availableEndpoints: const <ProviderWalletEndpoint>[
          ProviderWalletEndpoint(
            id: 'openai',
            name: 'OpenAI',
            apiKeyLabel: 'OPENAI_API_KEY',
          ),
          ProviderWalletEndpoint(
            id: 'xai',
            name: 'xAI API',
            apiKeyLabel: 'XAI_API_KEY',
          ),
        ],
      );

  @override
  Future<ProviderWalletStatus?> loadWallet(
    String providerId, {
    String? modelId,
    String? endpointId,
    bool force = false,
  }) async {
    walletLoadRequests
        .add('$_requestHost:$providerId:${endpointId ?? modelId ?? ''}');
    if (providerId == 'direct') {
      return _directWallet(endpointId ?? 'openai');
    }
    return const ProviderWalletStatus(
      providerId: 'codex',
      kind: 'subscription',
      label: 'Subscription usage',
      detail: 'Uses the host subscription.',
      currency: 'USD',
      apiKeyConfigured: true,
    );
  }

  @override
  Future<ProviderWalletStatus> configureWallet({
    required String providerId,
    required String endpointId,
    String? modelId,
    String? apiKey,
    bool validateApiKey = false,
    bool clearApiKey = false,
    bool clearBalance = false,
    double? setBalance,
    double? addBalance,
    Map<String, Object?>? customEndpoint,
  }) async {
    walletConfigureRequests.add('$_requestHost:$providerId:$endpointId');
    return _directWallet(endpointId, configured: !clearApiKey);
  }

  void clearHostRequestLog() {
    walletLoadRequests.clear();
    walletConfigureRequests.clear();
  }

  RemoteSession addPreparedHostSwitchSession() {
    modelsByProvider['codex'] = _codexModels;
    final prepared = prepareSession('codex');
    updatePreparedModelSelection(
      prepared.id,
      modelId: primaryModelId,
      reasoningEffort: 'low',
    );
    preparedSelectionRequests.clear();
    return sessionById(prepared.id)!;
  }

  String addDirectWalletSession() {
    if (!providers.any((provider) => provider.providerId == 'direct')) {
      providers.add(const ProviderConnection(
        providerId: 'direct',
        displayName: 'Direct API',
        state: 'online',
        detected: true,
        authenticated: true,
        capabilities: ProviderCapabilities(
          createSession: true,
          modelEnumeration: true,
        ),
      ));
    }
    final model = RemoteModel(
      id: directModelId,
      providerId: 'direct',
      displayName: 'Direct widget model',
      isDefault: true,
      nativeMetadata: const <String, Object?>{
        'endpointId': 'openai',
        'endpointName': 'OpenAI',
      },
    );
    modelsByProvider['direct'] = <RemoteModel>[model];
    sessions.removeWhere((session) => session.id == directSessionId);
    sessions.add(RemoteSession(
      id: directSessionId,
      hostId: activeHost!.hostId,
      providerId: 'direct',
      providerSessionId: directSessionId,
      title: 'Direct wallet task',
      state: 'idle',
      lastActivityAt: DateTime.utc(2026, 9, 2, 12),
      needsApproval: false,
      stale: false,
      modelId: directModelId,
    ));
    walletByModel['direct\u0000$directModelId'] = _directWallet('openai');
    return directSessionId;
  }

  void switchToHostB(
    String sessionId, {
    String? parentSessionId,
    required String draft,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    String? modelId,
    String? reasoningEffort,
    String? state,
  }) {
    final source = sessionById(sessionId)!;
    final parent =
        parentSessionId == null ? null : sessionById(parentSessionId);
    final hostBSession = _copySessionForHostB(
      source,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      state: state,
    );
    final hostBParent = parent == null ? null : _copySessionForHostB(parent);
    if (!hosts.any((host) => host.hostId == hostBId)) hosts.add(_hostB);
    activeHost = _hostB;
    sessions
      ..clear()
      ..addAll(<RemoteSession>[
        if (hostBParent != null) hostBParent,
        hostBSession,
      ]);
    selectedSession = hostBSession;
    messages
      ..clear()
      ..addAll(<String, List<RemoteMessage>>{
        if (hostBParent != null) hostBParent.id: <RemoteMessage>[],
        hostBSession.id: <RemoteMessage>[],
      });
    drafts
      ..clear()
      ..[sessionId] = draft;
    draftAttachments
      ..clear()
      ..addAll(attachments.isEmpty
          ? const <String, List<RemoteAttachment>>{}
          : <String, List<RemoteAttachment>>{
              sessionId: List<RemoteAttachment>.unmodifiable(attachments),
            });
    draftSimplifySettings.clear();
    visionBySession.clear();
    connectionState = BridgeConnectionState.online;
    hostBDraftMutationCalls.clear();
    notifyListeners();
  }

  RemoteSession _copySessionForHostB(
    RemoteSession source, {
    String? modelId,
    String? reasoningEffort,
    String? state,
  }) =>
      RemoteSession(
        id: source.id,
        hostId: hostBId,
        providerId: source.providerId,
        providerSessionId: 'host-b-${source.providerSessionId}',
        title: 'Host B ${source.title}',
        state: state ?? source.state,
        lastActivityAt: DateTime.utc(2026, 9, 2, 13),
        needsApproval: false,
        stale: false,
        project: 'Host B protected project',
        workingDirectory: r'C:\HostB\protected',
        preview: 'Host B protected task',
        modelId: modelId ?? source.modelId,
        reasoningEffort: reasoningEffort ?? source.reasoningEffort,
        variantId: source.variantId,
        parentSessionId: source.parentSessionId,
        agentNickname: source.agentNickname,
        agentRole: source.agentRole,
        relationship: source.relationship,
        contextHandoffSummary: source.contextHandoffSummary,
        sessionKind: source.sessionKind,
      );
}

class _DelayedVisionProxyDemoStore extends _VisionProxyDemoStore {
  final Completer<List<VisionProxyTarget>> _targets =
      Completer<List<VisionProxyTarget>>();
  final Completer<VisionProxyStatus> _status = Completer<VisionProxyStatus>();
  final Map<String, Completer<ProviderWalletStatus?>> _wallets =
      <String, Completer<ProviderWalletStatus?>>{};

  @override
  Future<List<VisionProxyTarget>> loadVisionProxyTargets(
          {bool force = false}) =>
      _targets.future;

  @override
  Future<VisionProxyStatus> loadVisionProxy(String sessionId) => _status.future;

  @override
  Future<ProviderWalletStatus?> loadWallet(String providerId,
      {String? modelId, String? endpointId, bool force = false}) {
    if (endpointId == null) {
      return super.loadWallet(providerId,
          modelId: modelId, endpointId: endpointId, force: force);
    }
    return _wallets
        .putIfAbsent(endpointId, () => Completer<ProviderWalletStatus?>())
        .future;
  }

  void completeHydration() {
    _targets.complete(_VisionProxyDemoStore.availableTargets);
    _status.complete(const VisionProxyStatus(
      sessionId: 'demo-codex-api',
      primaryModelSupportsImageInput: false,
    ));
    for (final endpointId in <String>['google', 'xai']) {
      _wallets
          .putIfAbsent(endpointId, () => Completer<ProviderWalletStatus?>())
          .complete(ProviderWalletStatus(
            providerId: 'direct',
            kind: 'user_api',
            label: 'Direct API wallet',
            detail: 'Encrypted locally',
            currency: 'USD',
            endpointId: endpointId,
            apiKeyConfigured: false,
          ));
    }
  }
}

class _InvalidatingVisionProxyDemoStore extends _VisionProxyDemoStore {
  final Completer<List<VisionProxyTarget>> _refresh =
      Completer<List<VisionProxyTarget>>();
  bool _catalogueValid = true;
  int refreshCalls = 0;

  @override
  List<VisionProxyTarget> get cachedVisionProxyTargets => _catalogueValid
      ? _VisionProxyDemoStore.availableTargets
      : const <VisionProxyTarget>[];

  @override
  int get visionProxyTargetsRevision => _catalogueValid ? 0 : 1;

  @override
  Future<List<VisionProxyTarget>> loadVisionProxyTargets({bool force = false}) {
    refreshCalls += 1;
    return _refresh.future;
  }

  void invalidateCatalogue() {
    _catalogueValid = false;
    notifyListeners();
  }

  void completeRefresh() {
    if (!_refresh.isCompleted) {
      _refresh.complete(const <VisionProxyTarget>[]);
    }
  }
}

class _FailingVisionProxyDemoStore extends _VisionProxyDemoStore {
  bool validateApiKeyRequested = false;

  @override
  Future<List<VisionProxyTarget>> loadVisionProxyTargets(
      {bool force = false}) async {
    throw StateError(r'C:\private\wallet.json provider stack trace');
  }

  @override
  Future<VisionProxyStatus> loadVisionProxy(String sessionId) async {
    throw StateError(r'C:\private\wallet.json status stack trace');
  }

  @override
  Future<ProviderWalletStatus?> loadWallet(String providerId,
          {String? modelId, String? endpointId, bool force = false}) async =>
      null;

  @override
  Future<ProviderWalletStatus> configureWallet({
    required String providerId,
    required String endpointId,
    String? modelId,
    String? apiKey,
    bool validateApiKey = false,
    bool clearApiKey = false,
    bool clearBalance = false,
    double? setBalance,
    double? addBalance,
    Map<String, Object?>? customEndpoint,
  }) async {
    validateApiKeyRequested = validateApiKey;
    throw const BridgeRequestException(
      'AUTH_INVALID',
      r'C:\private\wallet.json rejected the key',
      retryable: false,
    );
  }
}

class _RetryVisionProxyDemoStore extends _VisionProxyDemoStore {
  int configureAttempts = 0;

  @override
  Future<VisionProxyStatus> configureVisionProxy(
      String sessionId, VisionProxySelection? selection) async {
    configureAttempts += 1;
    if (configureAttempts == 1) {
      throw StateError('provider stack trace should stay hidden');
    }
    return super.configureVisionProxy(sessionId, selection);
  }
}

class _PagedHistoryDemoStore extends DemoRemoteAppStore {
  static const sessionId = 'demo-opencode-e2e';

  bool _hasOlderHistory = true;
  final Completer<void> _olderHistoryGate = Completer<void>();
  int olderHistoryLoads = 0;

  void releaseOlderHistory() => _olderHistoryGate.complete();

  void seedRecentHistory() {
    messages[sessionId] = List<RemoteMessage>.generate(
      14,
      (index) => _historyMessage(
        id: 'recent-history-${(index + 1).toString().padLeft(2, '0')}',
        text:
            'Recent history ${(index + 1).toString().padLeft(2, '0')} keeps enough transcript content visible to exercise scrolling.',
        createdAt: DateTime.utc(2026, 8, 12, 12, index),
        role: index.isEven ? 'user' : 'assistant',
      ),
    );
  }

  @override
  bool hasOlderHistory(String targetSessionId) =>
      targetSessionId == sessionId && _hasOlderHistory;

  @override
  Future<bool> loadOlderSessionHistory(String targetSessionId) async {
    if (!hasOlderHistory(targetSessionId)) return false;
    olderHistoryLoads += 1;
    await _olderHistoryGate.future;
    messages[targetSessionId] = <RemoteMessage>[
      ...List<RemoteMessage>.generate(
        6,
        (index) => _historyMessage(
          id: 'older-history-${(index + 1).toString().padLeft(2, '0')}',
          text:
              'Older history ${(index + 1).toString().padLeft(2, '0')} was fetched after reaching the top of the transcript.',
          createdAt: DateTime.utc(2026, 8, 12, 11, index),
          role: index.isEven ? 'user' : 'assistant',
        ),
      ),
      ...messages[targetSessionId]!,
    ];
    _hasOlderHistory = false;
    notifyListeners();
    return true;
  }
}

RemoteMessage _historyMessage({
  required String id,
  required String text,
  required DateTime createdAt,
  required String role,
}) =>
    RemoteMessage(
      id: id,
      sessionId: _PagedHistoryDemoStore.sessionId,
      role: role,
      createdAt: createdAt,
      parts: <ContentPart>[
        ContentPart(type: 'text', data: <String, Object?>{'text': text}),
      ],
      status: 'completed',
    );

void _useOneSecondDictationSource(DemoRemoteAppStore store) {
  store.dictationSources
    ..clear()
    ..add(const TranscriptionSource(
      id: 'openai-stt',
      label: 'OpenAI speech-to-text',
      status: 'ready',
      setupEnvironmentVariable: 'TETHOQ_OPENAI_API_KEY',
      supportsBatch: true,
      maxAudioBytes: 64044,
    ));
  store.dictationSourcePreferences['codex'] = 'openai-stt';
}

Future<String> _openSideChatForDictation(
    WidgetTester tester, DemoRemoteAppStore store) async {
  await tester.tap(find.byKey(const Key('session-secondary-controls')));
  await tester.pump();
  await tester.tap(find.byKey(const Key('open-side-chat')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 600));
  expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);
  return store.sideChatsFor('demo-working').single.id;
}

int _sideChatTranscriptCount(DemoRemoteAppStore store, String sideChatId) =>
    (store.messages[sideChatId] ?? const <RemoteMessage>[])
        .where((message) =>
            message.role == 'user' &&
            message.parts.any(
                (part) => part.summary == 'Recovered dictation transcript'))
        .length;

class _FakeDictationRecorder implements DictationRecorder {
  _FakeDictationRecorder({Uint8List? waveBytes, this.stopGate})
      : waveBytes = waveBytes ?? Uint8List(9000);

  final Uint8List waveBytes;
  final Completer<void>? stopGate;
  bool started = false;
  int startCalls = 0;
  int stopCalls = 0;

  @override
  Stream<double> get levelStream => const Stream<double>.empty();

  @override
  Future<bool> start() async {
    started = true;
    startCalls += 1;
    return true;
  }

  @override
  Future<Uint8List> stop() async {
    stopCalls += 1;
    await stopGate?.future;
    return waveBytes;
  }

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}
}

class _RetriableDictationDemoStore extends DemoRemoteAppStore {
  _RetriableDictationDemoStore({
    this.failFirst = false,
    this.emptyFirst = false,
  });

  final bool failFirst;
  final bool emptyFirst;
  Completer<String>? transcriptionGate;
  int transcriptionAttempts = 0;
  final List<List<int>> transcriptionInputs = <List<int>>[];

  @override
  Future<String> transcribeDictation(
    List<int> waveBytes, {
    required String sessionId,
    String? sourceId,
  }) async {
    transcriptionAttempts += 1;
    transcriptionInputs.add(waveBytes);
    final gate = transcriptionGate;
    if (gate != null) return await gate.future;
    if (failFirst && transcriptionAttempts == 1) {
      throw StateError('timeout bad request');
    }
    if (emptyFirst && transcriptionAttempts == 1) return '';
    return 'Recovered dictation transcript';
  }
}

class _ConcurrentDictationDemoStore extends DemoRemoteAppStore {
  final List<Completer<String>> transcriptionGates = <Completer<String>>[];
  int activeTranscriptions = 0;
  int maxConcurrentTranscriptions = 0;

  @override
  Future<String> transcribeDictation(
    List<int> waveBytes, {
    required String sessionId,
    String? sourceId,
  }) async {
    final gate = Completer<String>();
    transcriptionGates.add(gate);
    activeTranscriptions += 1;
    if (activeTranscriptions > maxConcurrentTranscriptions) {
      maxConcurrentTranscriptions = activeTranscriptions;
    }
    try {
      return await gate.future;
    } finally {
      activeTranscriptions -= 1;
    }
  }
}

RemoteSession _copySession(RemoteSession session,
        {String? state, String? modelId, String? reasoningEffort}) =>
    session.copyWith(
      state: state,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
    );
