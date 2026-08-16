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

    final bubble = find.byKey(
        const ValueKey<String>('message-bubble-copy-assistant-visible-1'));
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

    final collapsedContext = find.byKey(const Key('session-context-button'));
    expect(
        find.descendant(of: collapsedContext, matching: find.text('70k / 80k')),
        findsOneWidget);
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
    expect(find.text('Usage details'), findsOneWidget);
    expect(find.text('Context used'), findsOneWidget);
    expect(find.text('Automatic compaction'), findsOneWidget);
    expect(find.text('Model capacity'), findsOneWidget);
    expect(find.text('Session cost'), findsOneWidget);

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

  testWidgets('active compaction appears once as a quiet temporary status',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('compacting', providerId: 'future-harness');
    final compacting = _contextState(source.id,
        isCompacting: true, compactionKind: 'automatic');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..contextFixture = compacting
      ..contextBySession[source.id] = compacting;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.byKey(const Key('compaction-progress-row')), findsOneWidget);
    expect(find.text('Automatically compacting context…'), findsOneWidget);

    final finished = _contextState(source.id);
    store
      ..contextFixture = finished
      ..contextBySession[source.id] = finished
      ..notifyListeners();
    await tester.pump();

    expect(find.byKey(const Key('compaction-progress-row')), findsNothing);
    expect(find.text('Automatically compacting context…'), findsNothing);
  });

  testWidgets('user turn boundaries have the same expanded spacing',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('spacing', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = <RemoteMessage>[
        RemoteMessage(
          id: 'spacing-before',
          sessionId: source.id,
          role: 'assistant',
          createdAt: DateTime.utc(2026, 8, 15, 10),
          status: 'completed',
          parts: const <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{
              'text': 'Assistant response before the user turn.',
            }),
          ],
        ),
        RemoteMessage(
          id: 'spacing-user',
          sessionId: source.id,
          role: 'user',
          createdAt: DateTime.utc(2026, 8, 15, 10, 1),
          status: 'completed',
          parts: const <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{
              'text': 'A distinct user instruction.',
            }),
          ],
        ),
        RemoteMessage(
          id: 'spacing-reasoning',
          sessionId: source.id,
          role: 'assistant',
          createdAt: DateTime.utc(2026, 8, 15, 10, 2),
          status: 'completed',
          parts: const <ContentPart>[
            ContentPart(type: 'reasoning', data: <String, Object?>{
              'text': 'Inspecting the requested spacing.',
            }),
          ],
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    final beforeUser = tester.widget<Padding>(
        find.byKey(const ValueKey<String>('turn-boundary-spacing-user')));
    final afterUser = tester.widget<Padding>(find.byKey(const ValueKey<String>(
        'turn-boundary-spacing-reasoning-part-0-thinking-0')));
    expect(beforeUser.padding, const EdgeInsets.only(top: 21));
    expect(afterUser.padding, beforeUser.padding);
  });

  testWidgets('automatic effort resolves to the model concrete default',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session(
      'resolved-effort',
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'auto',
    );
    store
      ..sessions.add(source)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = <RemoteModel>[
        RemoteModel(
          id: 'gpt-5.6-sol',
          providerId: 'codex',
          displayName: 'GPT-5.6 Sol',
          isDefault: true,
          nativeMetadata: const <String, Object?>{
            'supportedReasoningEfforts': <Object?>[
              <String, Object?>{'reasoningEffort': 'auto'},
              <String, Object?>{'reasoningEffort': 'low'},
              <String, Object?>{'reasoningEffort': 'high'},
            ],
            'defaultReasoningEffort': 'low',
          },
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.text('Light'), findsOneWidget);
    expect(find.text('Auto'), findsNothing);
    expect(find.text('Effort unknown'), findsNothing);
  });

  testWidgets('reasoning control stays hidden when no effort is truthful',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session(
      'unknown-effort',
      providerId: 'codex',
      modelId: 'ambiguous-model',
      reasoningEffort: 'auto',
    );
    store
      ..sessions.add(source)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = <RemoteModel>[
        RemoteModel(
          id: 'ambiguous-model',
          providerId: 'codex',
          displayName: 'Ambiguous model',
          isDefault: true,
          nativeMetadata: const <String, Object?>{
            'supportedReasoningEfforts': <Object?>[
              <String, Object?>{'reasoningEffort': 'auto'},
              <String, Object?>{'reasoningEffort': 'low'},
              <String, Object?>{'reasoningEffort': 'high'},
            ],
            'defaultReasoningEffort': 'auto',
          },
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.byKey(const Key('reasoning-control')), findsNothing);
    expect(find.text('Auto'), findsNothing);
    expect(find.text('Effort unknown'), findsNothing);
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

  testWidgets(
      'task drafts keep text and local attachments when switching away and back',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final first = _session('draft-one', providerId: 'codex');
    final second = _session('draft-two', providerId: 'codex');
    const attachment = RemoteAttachment(
      name: 'phone-shot.png',
      mimeType: 'image/png',
      dataBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      byteLength: 68,
    );
    store
      ..sessions.addAll(<RemoteSession>[first, second])
      ..providers.add(_provider('codex'))
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'test-model', 'Test model', isDefault: true),
      ];
    addTearDown(store.dispose);

    Widget task(String sessionId) => StoreScope(
          store: store,
          child: MaterialApp(
            home: SessionScreen(
              key: ValueKey<String>('screen-$sessionId'),
              sessionId: sessionId,
              imageAttachmentPicker: () async => attachment,
              dictationRecorder: _NoopRecorder(),
            ),
          ),
        );

    await tester.pumpWidget(task(first.id));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('session-composer')),
        'Keep this unsent instruction.');
    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Photo or image'));
    await tester.pumpAndSettle();

    expect(store.drafts[first.id], 'Keep this unsent instruction.');
    expect(store.draftAttachmentsFor(first.id), hasLength(1));

    await tester.pumpWidget(task(second.id));
    await tester.pump();
    expect(find.text('Continue this task…'), findsOneWidget);
    await tester.enterText(
        find.byKey(const Key('session-composer')), 'A separate draft.');

    await tester.pumpWidget(task(first.id));
    await tester.pump();
    final composer =
        tester.widget<TextField>(find.byKey(const Key('session-composer')));
    expect(composer.controller?.text, 'Keep this unsent instruction.');
    expect(find.byKey(const ValueKey<String>('pending-image-phone-shot.png')),
        findsOneWidget);
    expect(store.drafts[second.id], 'A separate draft.');
    expect(store.draftAttachmentsFor(first.id), hasLength(1));
    expect(
        tester.getSize(find.byKey(const Key('session-composer-shell'))).height,
        lessThanOrEqualTo(360));
  });

  testWidgets(
      'simplify chip keeps settings, text, and attachments with the task draft',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final first = _session('simplify-one', providerId: 'codex');
    final second = _session('simplify-two', providerId: 'codex');
    const attachment = RemoteAttachment(
      name: 'diagram.png',
      mimeType: 'image/png',
      dataBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      byteLength: 68,
    );
    store
      ..sessions.addAll(<RemoteSession>[first, second])
      ..providers.add(_provider('codex'))
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'test-model', 'Test model', isDefault: true),
      ];
    addTearDown(store.dispose);

    Widget task(String sessionId) => StoreScope(
          store: store,
          child: MaterialApp(
            home: SessionScreen(
              key: ValueKey<String>('simplify-screen-$sessionId'),
              sessionId: sessionId,
              imageAttachmentPicker: () async => attachment,
              dictationRecorder: _NoopRecorder(),
            ),
          ),
        );

    await tester.pumpWidget(task(first.id));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('session-composer')), '/sim');
    await tester.pump();
    expect(
        find.byKey(const Key('simplify-command-suggestion')), findsOneWidget);

    await tester.tap(find.byKey(const Key('simplify-command-suggestion')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('simplify-composer-chip')), findsOneWidget);
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('session-composer')))
            .controller
            ?.text,
        '/simplify ');

    await tester.tap(find.byKey(const Key('simplify-composer-chip')));
    await tester.pumpAndSettle();
    expect(find.text('Simplify response'), findsOneWidget);
    expect(find.textContaining('shortens the previous answer'), findsOneWidget);
    await tester.tap(find.byKey(const Key('simplify-preset-200')));
    await tester.enterText(
        find.byKey(const Key('simplify-guidance')), 'Keep the example.');
    await tester
        .ensureVisible(find.byKey(const Key('apply-simplify-settings')));
    await tester.tap(find.byKey(const Key('apply-simplify-settings')));
    await tester.pumpAndSettle();
    expect(find.text('Simplify · 200 words'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('session-composer')),
        '/simplify Explain this result.');
    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Photo or image'));
    await tester.pumpAndSettle();
    expect(store.simplifySettingsFor(first.id)?.maxWords, 200);
    expect(store.simplifySettingsFor(first.id)?.guidance, 'Keep the example.');
    expect(store.draftAttachmentsFor(first.id), hasLength(1));

    await tester.pumpWidget(task(second.id));
    await tester.pump();
    await tester.enterText(
        find.byKey(const Key('session-composer')), 'A different draft.');
    await tester.pumpWidget(task(first.id));
    await tester.pump();

    expect(find.text('Simplify · 200 words'), findsOneWidget);
    expect(
        tester
            .widget<TextField>(find.byKey(const Key('session-composer')))
            .controller
            ?.text,
        '/simplify Explain this result.');
    expect(find.byKey(const ValueKey<String>('pending-image-diagram.png')),
        findsOneWidget);
  });

  testWidgets('new task composer uses a task-aware placeholder',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..providers.add(_provider('codex'));
    final prepared = store.prepareSession('codex');
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: prepared.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();

    expect(find.text('Describe a task…'), findsOneWidget);
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
    final reasoningToggle =
        find.byKey(const Key('reasoning-toggle-activity-tool-event'));
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
    expect(find.textContaining('Read'), findsOneWidget);
    expect(find.textContaining('Inspecting the project'), findsNothing);
    final toolBulkToggle = find.byKey(const Key('expand-reasoning-tools'));
    expect(tester.getSize(toolBulkToggle).height, greaterThanOrEqualTo(44));
    expect(
        tester
            .widget<TextButton>(
                find.byKey(const Key('expand-reasoning-thinking')))
            .onPressed,
        isNull);
    tester.widget<TextButton>(toolBulkToggle).onPressed!();
    await tester.pump(const Duration(milliseconds: 200));
    final readDisclosure =
        find.byKey(const ValueKey<String>('activity-disclosure-tool-event'));
    expect(readDisclosure, findsOneWidget);
    expect(find.textContaining('Inspecting the project'), findsOneWidget);
    expect(find.byKey(const Key('activity-collapse-top')), findsOneWidget);
    expect(find.byKey(const Key('activity-collapse-bottom')), findsOneWidget);
    expect(find.byKey(const Key('activity-resize-snippet')), findsOneWidget);
    expect(find.text('tool started'), findsNothing);
    expect(find.text('Provider request details'), findsNothing);
    expect(find.text('Answers JSON'), findsNothing);
    tester.widget<InkWell>(readDisclosure).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining('Inspecting the project'), findsNothing);
    tester.widget<InkWell>(reasoningToggle).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.drag(find.byType(ListView), const Offset(0, -320));
    await tester.pump();
    expect(find.text('Choose the pace for this task.'), findsOneWidget);
    await tester.tap(find.text('Careful'));
    await tester.pump();
    expect(store.lastInputAnswers, <String, Object?>{'pace': 'Careful'});
  });

  testWidgets(
      'mixed assistant parts form chronological reasoning spans without raw trace leakage',
      (tester) async {
    tester.view.physicalSize = const Size(430, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore();
    final source = _session('mixed-reasoning', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = <RemoteMessage>[
        RemoteMessage(
          id: 'mixed',
          sessionId: source.id,
          role: 'assistant',
          createdAt: DateTime.utc(2026, 8, 15, 10),
          status: 'completed',
          parts: const <ContentPart>[
            ContentPart(type: 'reasoning', data: <String, Object?>{
              'text':
                  'First private thought with verbose implementation notes.',
            }),
            ContentPart(type: 'text', data: <String, Object?>{
              'phase': 'commentary',
              'text': 'Visible progress update.',
            }),
            ContentPart(type: 'tool', data: <String, Object?>{
              'name': 'read_file',
              'text': 'raw tool body one',
            }),
            ContentPart(type: 'file_change', data: <String, Object?>{
              'path': 'lib/example.dart',
              'diff': 'raw tool body two',
            }),
            ContentPart(type: 'reasoning', data: <String, Object?>{
              'summary': 'Checked the resulting state',
              'text': '''Second private thought with verbose state details.
Detail 02
Detail 03
Detail 04
Detail 05
Detail 06
Detail 07
Detail 08
Detail 09
Detail 10
Detail 11
Detail 12
Detail 13
Detail 14
Detail 15
Detail 16''',
            }),
            ContentPart(type: 'text', data: <String, Object?>{
              'text': 'Final visible answer.',
            }),
          ],
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.text('Reasoning'), findsNWidgets(2));
    expect(find.text('Visible progress update.'), findsOneWidget);
    expect(find.text('Final visible answer.'), findsOneWidget);
    expect(find.textContaining('First private thought'), findsNothing);
    expect(find.textContaining('Second private thought'), findsNothing);
    expect(find.textContaining('raw tool body'), findsNothing);

    final secondReasoning =
        find.byKey(const Key('reasoning-toggle-mixed-part-2-toolCall-0'));
    await tester.ensureVisible(secondReasoning);
    tester.widget<InkWell>(secondReasoning).onTap!();
    await tester.pump(const Duration(milliseconds: 200));

    expect(find.text('read file + 1 more'), findsOneWidget);
    expect(find.text('Checked the resulting state'), findsOneWidget);
    expect(find.textContaining('Second private thought'), findsNothing);
    expect(find.textContaining('raw tool body'), findsNothing);

    final expandThinking = find.byKey(const Key('expand-reasoning-thinking'));
    tester.widget<TextButton>(expandThinking).onPressed!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining('Second private thought'), findsOneWidget);
    expect(
        find.byKey(
            const Key('reasoning-thinking-scroll-mixed-part-4-thinking-0')),
        findsOneWidget);
    expect(find.textContaining('raw tool body'), findsNothing);

    final expandTools = find.byKey(const Key('expand-reasoning-tools'));
    tester.widget<TextButton>(expandTools).onPressed!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.textContaining('raw tool body one'), findsOneWidget);
    expect(find.textContaining('raw tool body two'), findsOneWidget);
    expect(
        tester.getTopLeft(find.text('read file + 1 more')).dy,
        lessThan(
            tester.getTopLeft(find.text('Checked the resulting state')).dy));
  });

  testWidgets(
      'a working task shows one live reasoning state before provider detail arrives',
      (tester) async {
    final store = _FeatureStore();
    final source = _session(
      'waiting-for-reasoning',
      providerId: 'future-harness',
      state: 'working',
    );
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.text('Reasoning'), findsOneWidget);
    final toggle = find.byKey(
        const Key('reasoning-toggle-tethoq-live-reasoning'));
    tester.widget<InkWell>(toggle).onTap!();
    await tester.pump();
    expect(find.text('Working…'), findsOneWidget);

    store.sessions[0] = source.copyWith(state: 'completed');
    store.notifyListeners();
    await tester.pump();
    expect(find.byKey(
        const Key('reasoning-toggle-tethoq-live-reasoning')), findsNothing);
  });

  testWidgets('expanded reasoning display opens thinking but not tool bodies',
      (tester) async {
    final store = _FeatureStore()..reasoningDisplayMode = 'expanded';
    final source = _session('expanded-reasoning', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = <RemoteMessage>[
        RemoteMessage(
          id: 'expanded-message',
          sessionId: source.id,
          role: 'assistant',
          createdAt: DateTime.utc(2026, 8, 15, 11),
          status: 'completed',
          parts: const <ContentPart>[
            ContentPart(type: 'reasoning', data: <String, Object?>{
              'summary': 'Checked the approach',
              'text': 'Expanded thinking body.',
            }),
            ContentPart(type: 'tool', data: <String, Object?>{
              'name': 'read_file',
              'text': 'Hidden tool body.',
            }),
          ],
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    expect(find.text('Expanded thinking body.'), findsNothing);
    final toggle = find.byKey(
        const Key('reasoning-toggle-expanded-message-part-0-thinking-0'));
    tester.widget<InkWell>(toggle).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('Expanded thinking body.'), findsOneWidget);
    expect(find.text('Hidden tool body.'), findsNothing);
  });

  testWidgets('settings labels reasoning display separately from model effort',
      (tester) async {
    final store = _FeatureStore();
    addTearDown(store.dispose);
    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: HostsScreen()),
    ));
    await tester.pump();

    expect(find.text('Reasoning display'), findsOneWidget);
    expect(find.text('Only changes what opens here, not model effort.'),
        findsOneWidget);
    final picker = tester.widget<DropdownButton<String>>(
        find.byKey(const Key('reasoning-display-mode')));
    expect(picker.value, 'compact');
    picker.onChanged!('expanded');
    await tester.pump();
    expect(store.lastReasoningDisplayMode, 'expanded');
  });
}

class _FeatureStore extends RemoteAppStore {
  String? lastHandoffPrompt;
  String? lastBranchSessionId;
  String? lastWalletEndpointId;
  String? lastReasoningDisplayMode;
  Map<String, Object?>? lastInputAnswers;
  SessionContextState? contextFixture;
  int thresholdSetCalls = 0;
  int? lastThresholdTokens;
  bool? lastCompactNow;

  @override
  Future<void> setReasoningDisplayMode(String mode) async {
    reasoningDisplayMode = mode;
    lastReasoningDisplayMode = mode;
    notifyListeners();
  }

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
      compactionKind: current.compactionKind,
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
  String? reasoningEffort,
  String? variantId,
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
      reasoningEffort: reasoningEffort,
      variantId: variantId,
      relationship: relationship,
    );

SessionContextState _contextState(String sessionId,
        {bool isCompacting = false, String? compactionKind}) =>
    SessionContextState(
      sessionId: sessionId,
      modelId: 'test-model',
      usedTokens: 70000,
      contextWindowTokens: 100000,
      usedPercent: 70,
      compactionThresholdTokens: 80000,
      minimumThresholdTokens: 20000,
      supportsManualCompaction: true,
      supportsThreshold: true,
      isCompacting: isCompacting,
      compactionKind: compactionKind,
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
