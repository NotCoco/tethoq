import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/dictation.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';
import 'package:universal_agent_remote/src/store.dart';
import 'package:universal_agent_remote/src/transport.dart';

void main() {
  testWidgets(
      'context handoff keeps popup instruction as a draft and shows summary',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('source', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: source.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'initial session layout');

    await tester.tap(find.byKey(const Key('session-actions-menu')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'opening the action menu');
    await tester.tap(find.text('Context Handoff'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'opening the handoff sheet');

    expect(
        find.byKey(const Key('source-session-action-sheet')), findsOneWidget);
    expect(find.byKey(const Key('source-action-dictation')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('source-action-prompt')),
        'Continue with the focused mobile fix.');
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'entering a handoff draft');
    await tester.tap(find.byKey(const Key('source-action-submit')));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull, reason: 'opening the new task');

    expect(store.lastHandoffPrompt, isNull);
    expect(store.drafts['handoff'], 'Continue with the focused mobile fix.');
    expect(find.byKey(const Key('context-handoff-summary')), findsOneWidget);
    expect(find.text('Continue with the focused mobile fix.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('context-handoff-summary')));
    await tester.pumpAndSettle();
    expect(
        find.byKey(const Key('context-handoff-summary-full')), findsOneWidget);
    final summaryText = tester.widget<SelectableText>(find.descendant(
      of: find.byKey(const Key('context-handoff-summary-full')),
      matching: find.byType(SelectableText),
    ));
    expect(summaryText.style?.fontStyle, FontStyle.italic);
  });

  testWidgets('task row long press branches without a second model picker',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('task-list-source', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    await tester
        .longPress(find.byKey(ValueKey<String>('session-row-${source.id}')));
    await tester.pumpAndSettle();
    final branchAction =
        find.byKey(ValueKey<String>('task-row-branch-${source.id}'));
    expect(branchAction, findsOneWidget);
    expect(tester.getSize(branchAction).height, greaterThanOrEqualTo(44));
    expect(find.textContaining('provider'), findsNothing);
    expect(find.textContaining('model'), findsNothing);

    await tester.tap(branchAction);
    await tester.pumpAndSettle();

    expect(store.lastBranchSessionId, source.id);
    expect(store.selectedSession?.id, 'branch');
    expect(find.byType(SessionScreen), findsOneWidget);
  });

  testWidgets('message long press copies normalized visible markdown',
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
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('copy-source', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = <RemoteMessage>[
        RemoteMessage(
          id: 'copy-assistant',
          sessionId: source.id,
          role: 'assistant',
          createdAt: DateTime.utc(2026, 8, 14, 10),
          status: 'completed',
          parts: const <ContentPart>[
            ContentPart(
              type: 'reasoning',
              data: <String, Object?>{
                'text': 'Hidden chain of thought',
              },
            ),
            ContentPart(
              type: 'reasoning',
              data: <String, Object?>{
                'phase': 'commentary',
                'text': 'Checked the visible result.',
              },
            ),
            ContentPart(
              type: 'tool',
              data: <String, Object?>{
                'name': 'private_tool_metadata',
              },
            ),
            ContentPart(
              type: 'text',
              data: <String, Object?>{
                'text': '### Result  \r\n\r\n\r\nValue **bold**   ',
              },
            ),
          ],
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    final bubble =
        find.byKey(const ValueKey<String>('message-bubble-copy-assistant'));
    await tester.longPress(bubble);
    await tester.pumpAndSettle();
    final copyAction =
        find.byKey(const ValueKey<String>('copy-message-copy-assistant'));
    expect(copyAction, findsOneWidget);
    expect(tester.getSize(copyAction).height, greaterThanOrEqualTo(44));
    await tester.tap(copyAction);
    await tester.pumpAndSettle();

    expect(clipboardText,
        'Checked the visible result.\n\n### Result\n\nValue **bold**');
    expect(clipboardText, isNot(contains('Hidden chain of thought')));
    expect(clipboardText, isNot(contains('private_tool_metadata')));
    expect(find.text('Message copied'), findsOneWidget);
  });

  testWidgets(
      'automatic compaction uses one local slider and applies with fresh-check permission',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source =
        _session('context', providerId: 'future-harness', state: 'working');
    final contextState = _contextState(source.id);
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..contextFixture = contextState
      ..contextBySession[source.id] = contextState;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    await tester.tap(find.byKey(const Key('session-context-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));

    expect(find.text('Set automatic compaction'), findsOneWidget);
    expect(
        find.byKey(const Key('session-context-threshold-bar')), findsOneWidget);
    expect(
        find.text(
            'Compacts this task automatically when its context reaches this point.'),
        findsOneWidget);
    expect(find.text('In use'), findsNothing);
    await tester.tap(find.text('Usage details'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.text('In use'), findsOneWidget);

    var slider = tester.widget<Slider>(
        find.byKey(const Key('session-context-threshold-slider')));
    expect(slider.value, 80000);
    slider.onChanged!(5000);
    await tester.pump();
    slider = tester.widget<Slider>(
        find.byKey(const Key('session-context-threshold-slider')));
    expect(slider.value, 20000,
        reason: 'the model-reported minimum remains enforced');
    expect(store.thresholdSetCalls, 0,
        reason: 'dragging only changes sheet-local state');
    expect(
        find.byKey(const Key('current-turn-compaction-note')), findsOneWidget);

    await tester
        .ensureVisible(find.byKey(const Key('save-session-context-threshold')));
    await tester.tap(find.byKey(const Key('save-session-context-threshold')));
    await tester.pump(const Duration(milliseconds: 350));

    expect(find.byKey(const Key('immediate-compaction-confirmation')),
        findsNothing);
    expect(store.thresholdSetCalls, 1);
    expect(store.lastThresholdTokens, 20000);
    expect(store.lastCompactNow, isTrue);
    expect(find.text('Automatic compaction updated'), findsOneWidget);
  });

  testWidgets('collapsed context control does not show a dash without usage',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source =
        _session('context-unavailable', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    await tester.pump();

    final control = find.byKey(const Key('session-context-button'));
    expect(control, findsOneWidget);
    expect(
        find.descendant(of: control, matching: find.text('—')), findsNothing);
  });

  testWidgets('model picker is large, searchable, grouped, and shows recents',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    store
      ..providers.addAll(<ProviderConnection>[
        _provider('codex', modelEnumeration: true),
        _provider('direct', modelEnumeration: true),
      ])
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'codex-a', 'Codex Alpha', isDefault: true),
        _model('codex', 'codex-b', 'Codex Beta'),
      ]
      ..modelsByProvider['direct'] = <RemoteModel>[
        _model('direct', 'openai::api-a', 'API Alpha'),
      ];
    final source = store.prepareSession('codex');
    store.rememberModelSelection('codex', 'codex-b');
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: source.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('model-control')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('searchable-model-picker')), findsOneWidget);
    expect(find.text('Recent'), findsOneWidget);
    expect(find.text('Codex'), findsOneWidget);
    expect(find.text('Direct API'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('model-search-field')), 'Beta');
    await tester.pump();
    expect(find.text('Codex Beta'), findsWidgets);
    expect(find.byKey(const Key('catalog-codex-codex-a')), findsNothing);
    await tester.enterText(find.byKey(const Key('model-search-field')), 'API');
    await tester.pump();
    await tester.tap(find.byKey(const Key('catalog-direct-openai::api-a')));
    await tester.pumpAndSettle();
    expect(store.sessions.single.providerId, 'direct');
  });

  testWidgets('inline image attachment opens an interactive preview',
      (tester) async {
    final store = _FeatureStore();
    final source = _session('image', providerId: 'codex');
    store
      ..sessions.add(source)
      ..providers.add(_provider('codex', messageEditing: true))
      ..messages[source.id] = <RemoteMessage>[
        RemoteMessage(
          id: 'image-message',
          sessionId: source.id,
          role: 'user',
          createdAt: DateTime.utc(2026, 8, 14, 10),
          status: 'completed',
          editable: true,
          parts: const <ContentPart>[
            ContentPart(
              type: 'image',
              data: <String, Object?>{
                'name': 'pixel.png',
                'mimeType': 'image/png',
                'uri':
                    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              },
            ),
          ],
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: source.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();

    expect(find.byKey(const Key('expand-message-image')), findsOneWidget);
    await tester.tap(find.byKey(const Key('expand-message-image')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('expanded-message-image')), findsOneWidget);
    expect(find.byType(InteractiveViewer), findsOneWidget);
  });

  testWidgets(
      'direct wallet sheet warns for a key and exposes advanced endpoint fields',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source =
        _session('direct-wallet', providerId: 'direct', modelId: 'openai::gpt');
    store
      ..sessions.add(source)
      ..providers.add(_provider('direct', modelEnumeration: true))
      ..modelsByProvider['direct'] = <RemoteModel>[
        RemoteModel(
          id: 'openai::gpt',
          providerId: 'direct',
          displayName: 'GPT',
          isDefault: true,
          nativeMetadata: const <String, Object?>{
            'endpointName': 'OpenAI',
          },
        ),
      ]
      ..walletByModel['direct\u0000openai::gpt'] = const ProviderWalletStatus(
        providerId: 'direct',
        kind: 'user_api',
        label: 'Direct API wallet',
        detail: 'Uses your own API key.',
        endpointId: 'openai',
        endpointName: 'OpenAI',
        currency: 'USD',
        apiKeyConfigured: false,
        caution: 'Add an API key before sending.',
        availableEndpoints: <ProviderWalletEndpoint>[
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
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: source.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('wallet-source-control')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('wallet-key-caution')), findsOneWidget);
    await tester.tap(find.byKey(const Key('wallet-endpoint-selector')));
    await tester.pumpAndSettle();
    expect(find.text('xAI API'), findsOneWidget);
    await tester.tap(find.text('xAI API'));
    await tester.pumpAndSettle();
    expect(store.lastWalletEndpointId, 'xai');
    expect(find.byKey(const Key('wallet-key-caution')), findsNothing);
    expect(find.textContaining('Budget USD 7.00'), findsOneWidget);
    final keyField =
        tester.widget<TextField>(find.byKey(const Key('wallet-api-key-field')));
    expect(keyField.obscureText, isTrue);
    expect(keyField.decoration?.labelText, 'XAI_API_KEY');
    expect(find.textContaining('not stored money'), findsOneWidget);
    await tester.tap(find.byKey(const Key('wallet-advanced-settings')));
    await tester.pumpAndSettle();
    expect(
        find.byKey(const Key('wallet-custom-endpoint-name')), findsOneWidget);
    expect(find.byKey(const Key('wallet-custom-endpoint-url')), findsOneWidget);
    expect(find.byKey(const Key('wallet-custom-endpoint-protocol')),
        findsOneWidget);
    expect(
        find.byKey(const Key('wallet-custom-endpoint-models')), findsOneWidget);
  });

  testWidgets('subscription wallet never exposes direct API key controls',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source =
        _session('subscription-wallet', providerId: 'codex', modelId: 'gpt');
    store
      ..sessions.add(source)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..walletByModel['codex\u0000gpt'] = const ProviderWalletStatus(
        providerId: 'codex',
        kind: 'subscription',
        label: 'Subscription usage',
        detail: 'OpenAI subscription usage is being used.',
        currency: 'USD',
        apiKeyConfigured: true,
        apiKeyLabel: 'OpenAI subscription',
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: source.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('wallet-source-control')));
    await tester.pumpAndSettle();

    expect(find.text('Subscription'), findsOneWidget);
    expect(
        find.text('OpenAI subscription usage is being used.'), findsOneWidget);
    expect(find.text('OpenAI subscription'), findsNothing);
    expect(find.byKey(const Key('wallet-endpoint-selector')), findsNothing);
    expect(find.byKey(const Key('wallet-api-key-field')), findsNothing);
    expect(find.byKey(const Key('wallet-clear-key')), findsNothing);
  });

  testWidgets('task activity and input requests stay human-readable',
      (tester) async {
    final store = _FeatureStore();
    final source = _session('input', providerId: 'future-harness');
    final request = UserInputRequest(
      requestId: 'input-request',
      sessionId: source.id,
      title: 'Choose a pace',
      prompt: 'How should the agent continue?',
      request: const <String, Object?>{
        'questions': <Object?>[
          <String, Object?>{
            'id': 'pace',
            'question': 'Choose the pace for this task.',
            'options': <Object?>[
              <String, Object?>{'label': 'Careful'},
              <String, Object?>{'label': 'Fast'},
            ],
          },
        ],
      },
    );
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..events[source.id] = <AgentEvent>[
        AgentEvent(
          eventId: 'tool-event',
          sequence: 1,
          type: 'tool.started',
          occurredAt: DateTime.utc(2026, 8, 14, 11),
          payload: const <String, Object?>{
            'tool': 'read_file',
            'text': '''Inspecting the project
1: first line
2: second line
3: third line
4: fourth line
5: fifth line
6: sixth line
7: seventh line
8: eighth line
9: ninth line
10: tenth line
11: eleventh line
12: twelfth line
13: thirteenth line
14: fourteenth line
15: fifteenth line''',
          },
          sessionId: source.id,
          providerId: source.providerId,
        ),
      ]
      ..userInputs[request.requestId] = request;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.text('Reasoning'), findsOneWidget);
    expect(find.textContaining('Inspecting the project'), findsNothing);
    final reasoningToggle = find.byKey(const Key('reasoning-activity-toggle'));
    await tester.ensureVisible(reasoningToggle);
    await tester.pump(const Duration(milliseconds: 100));
    tester.widget<InkWell>(reasoningToggle).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(
        find.descendant(
          of: reasoningToggle,
          matching: find.byIcon(Icons.keyboard_arrow_up_rounded),
        ),
        findsOneWidget);
    expect(find.byKey(const ValueKey<String>('activity-disclosure-tool-event')),
        findsOneWidget);
    expect(find.text('Read'), findsOneWidget);
    expect(find.textContaining('Inspecting the project'), findsNothing);
    final readDisclosure =
        find.byKey(const ValueKey<String>('activity-disclosure-tool-event'));
    tester.widget<InkWell>(readDisclosure).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining('Inspecting the project'), findsOneWidget);
    expect(find.byKey(const Key('activity-collapse-top')), findsOneWidget);
    expect(find.byKey(const Key('activity-collapse-bottom')), findsOneWidget);
    expect(find.byKey(const Key('activity-resize-snippet')), findsOneWidget);
    expect(find.text('tool started'), findsNothing);
    expect(find.text('Provider request details'), findsNothing);
    expect(find.text('Answers JSON'), findsNothing);
    expect(find.text('Choose the pace for this task.'), findsOneWidget);
    await tester.tap(find.text('Careful'));
    await tester.pump();
    expect(store.lastInputAnswers, <String, Object?>{'pace': 'Careful'});
  });
}

class _FeatureStore extends RemoteAppStore {
  String? lastHandoffPrompt;
  String? lastBranchSessionId;
  String? lastWalletEndpointId;
  Map<String, Object?>? lastInputAnswers;
  SessionContextState? contextFixture;
  int thresholdSetCalls = 0;
  int? lastThresholdTokens;
  bool? lastCompactNow;

  @override
  Future<void> respondToUserInput(
      UserInputRequest request, Map<String, Object?> answers) async {
    lastInputAnswers = answers;
    userInputs.remove(request.requestId);
    notifyListeners();
  }

  @override
  Future<ContextHandoffResult> contextHandoff(String sessionId,
      {String? prompt}) async {
    lastHandoffPrompt = prompt;
    final created = _session(
      'handoff',
      providerId: 'future-harness',
      relationship: const SessionRelationship(
        kind: 'handoff',
        sourceSessionId: 'source',
        strategy: 'summary_bootstrap',
      ),
    );
    sessions.add(created);
    handoffSummaries[created.id] = 'A concise summary of the source chat.';
    selectedSession = created;
    notifyListeners();
    return ContextHandoffResult(
      summary: handoffSummaries[created.id]!,
      session: created,
    );
  }

  @override
  Future<SessionBranchResult> branchSession(String sessionId,
      {String? prompt}) async {
    lastBranchSessionId = sessionId;
    final created = _session(
      'branch',
      providerId:
          sessions.firstWhere((item) => item.id == sessionId).providerId,
      relationship: SessionRelationship(
        kind: 'branch',
        sourceSessionId: sessionId,
        strategy: 'transcript_bootstrap',
      ),
    );
    sessions.add(created);
    selectedSession = created;
    notifyListeners();
    return SessionBranchResult(
      session: created,
      strategy: 'transcript_bootstrap',
      copiedMessageCount: messages[sessionId]?.length ?? 0,
    );
  }

  @override
  void openSessionForView(RemoteSession session) {
    selectedSession = session;
    notifyListeners();
  }

  @override
  Future<SessionContextState> loadSessionContext(String sessionId) async {
    final value = contextFixture ??
        SessionContextState(
          sessionId: sessionId,
          usedTokens: null,
          contextWindowTokens: null,
          usedPercent: null,
          compactionThresholdTokens: null,
          minimumThresholdTokens: null,
          supportsManualCompaction: false,
          supportsThreshold: false,
          isCompacting: false,
          updatedAt: DateTime.utc(2026, 8, 14),
          usage: const SessionUsageTotals(),
        );
    contextBySession[sessionId] = value;
    return value;
  }

  @override
  Future<SessionContextState> setSessionCompactionThreshold(
      String sessionId, int thresholdTokens,
      {required bool compactNow}) async {
    thresholdSetCalls += 1;
    lastThresholdTokens = thresholdTokens;
    lastCompactNow = compactNow;
    final current = contextFixture ?? contextBySession[sessionId]!;
    final value = SessionContextState(
      sessionId: sessionId,
      modelId: current.modelId,
      usedTokens: current.usedTokens,
      contextWindowTokens: current.contextWindowTokens,
      usedPercent: current.usedPercent,
      compactionThresholdTokens: thresholdTokens,
      minimumThresholdTokens: current.minimumThresholdTokens,
      supportsManualCompaction: current.supportsManualCompaction,
      supportsThreshold: current.supportsThreshold,
      isCompacting: current.isCompacting,
      updatedAt: current.updatedAt,
      usage: current.usage,
    );
    contextBySession[sessionId] = value;
    return value;
  }

  @override
  Future<VisionProxyStatus> loadVisionProxy(String sessionId) async {
    final value = VisionProxyStatus(
      sessionId: sessionId,
      primaryModelSupportsImageInput: true,
    );
    visionBySession[sessionId] = value;
    return value;
  }

  @override
  Future<List<RemoteModel>> loadModelCatalog() async => modelsByProvider.values
      .expand((models) => models)
      .toList(growable: false);

  @override
  Future<ProviderWalletStatus?> loadWallet(String providerId,
      {String? modelId, String? endpointId, bool force = false}) async {
    lastWalletEndpointId = endpointId;
    if (endpointId != 'xai') return null;
    return const ProviderWalletStatus(
      providerId: 'direct',
      kind: 'user_api',
      label: 'Direct API wallet',
      detail: 'Uses the selected xAI endpoint.',
      endpointId: 'xai',
      endpointName: 'xAI API',
      currency: 'USD',
      balance: 7,
      apiKeyConfigured: true,
      apiKeyLabel: 'XAI_API_KEY',
      availableEndpoints: <ProviderWalletEndpoint>[
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
  }
}

class _NoopRecorder implements DictationRecorder {
  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> start() async => false;

  @override
  Future<Uint8List> stop() async => Uint8List(0);
}

RemoteSession _session(
  String id, {
  required String providerId,
  String? modelId,
  SessionRelationship? relationship,
  String state = 'idle',
}) =>
    RemoteSession(
      id: id,
      hostId: 'host',
      providerId: providerId,
      providerSessionId: id,
      title: 'Feature session $id',
      state: state,
      lastActivityAt: DateTime.utc(2026, 8, 14, 10),
      needsApproval: false,
      stale: false,
      modelId: modelId,
      relationship: relationship,
    );

SessionContextState _contextState(String sessionId) => SessionContextState(
      sessionId: sessionId,
      modelId: 'test-model',
      usedTokens: 70000,
      contextWindowTokens: 100000,
      usedPercent: 70,
      compactionThresholdTokens: 80000,
      minimumThresholdTokens: 20000,
      supportsManualCompaction: true,
      supportsThreshold: true,
      isCompacting: false,
      updatedAt: DateTime.utc(2026, 8, 14),
      usage: const SessionUsageTotals(
        inputTokens: 60000,
        outputTokens: 10000,
        totalTokens: 70000,
        cost: .42,
        currency: 'USD',
      ),
    );

ProviderConnection _provider(
  String id, {
  bool modelEnumeration = false,
  bool messageEditing = false,
}) =>
    ProviderConnection(
      providerId: id,
      displayName: id,
      state: 'online',
      detected: true,
      authenticated: true,
      capabilities: ProviderCapabilities(
        createSession: true,
        modelEnumeration: modelEnumeration,
        messageEditing: messageEditing,
      ),
    );

RemoteModel _model(String providerId, String id, String name,
        {bool isDefault = false}) =>
    RemoteModel(
      id: id,
      providerId: providerId,
      displayName: name,
      isDefault: isDefault,
      nativeMetadata: const <String, Object?>{},
    );
