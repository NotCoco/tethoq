import 'dart:async';
import 'dart:io';

// ignore: depend_on_referenced_packages
import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/dictation.dart';
import 'package:universal_agent_remote/src/models.dart';
import 'package:universal_agent_remote/src/screens.dart';
import 'package:universal_agent_remote/src/security.dart';
import 'package:universal_agent_remote/src/store.dart';
import 'package:universal_agent_remote/src/transport.dart';

void main() {
  test(
      'jump-to-latest stays hidden until the reader is meaningfully above the tail',
      () {
    expect(jumpToLatestVisible(pixels: 900, maxScrollExtent: 1000), isFalse);
    expect(jumpToLatestVisible(pixels: 800, maxScrollExtent: 1000), isTrue);
    expect(jumpToLatestVisible(pixels: 0, maxScrollExtent: 0), isFalse);
  });

  test('side-chat bootstrap diagnostics stay user-facing', () {
    expect(
      compactErrorDetail(StateError(
          'The normalized transcript is 1296877 bytes and cannot be branched safely with the 1000000-byte generic bootstrap limit')),
      'This task is too large to copy in one piece. Try again from a shorter recent span.',
    );
    expect(compactErrorDetail(Exception('Could not reach the computer')),
        'Could not reach the computer');
  });

  test('transport and validation diagnostics stay human-readable', () {
    expect(
      compactErrorDetail(Exception(
          'BRIDGE_REQUEST_FAILED: attachmentIds must contain at most 4 non-empty strings')),
      'You can send up to 4 attachments at once. Remove some and try again.',
    );
    expect(
      compactErrorDetail(const SocketException(
          'Secure DNS returned no usable address for absent-marked-removed-blast.trycloudflare.com')),
      'Not connected. Reconnect to your computer and try again.',
    );
    expect(
      compactErrorDetail(
          Exception('BOTTOM OVERFLOWED BY 28 PIXELS in RenderFlex#abc')),
      'That action could not be completed. Try again.',
    );
    expect(
      compactErrorDetail(
          Exception('BRIDGE_REQUEST_FAILED: modelIds must be an array')),
      'That action could not be completed. Check your message and try again.',
    );
  });

  test('dictation keeps recording well beyond thirty seconds', () {
    expect(dictationShouldAutoFinish(const Duration(seconds: 30)), isFalse);
    expect(dictationShouldAutoFinish(const Duration(minutes: 9, seconds: 59)),
        isFalse);
    expect(dictationShouldAutoFinish(const Duration(minutes: 10)), isTrue);
  });

  test('dictation duration follows source capacity and formats ten minutes',
      () {
    expect(
      dictationMaximumDurationForAudioBytes(25 * 1024 * 1024),
      const Duration(minutes: 10),
    );
    expect(
      dictationMaximumDurationForAudioBytes(96044),
      const Duration(seconds: 2),
    );
    expect(dictationElapsedLabel(const Duration(minutes: 10)), '10:00');
    expect(
      dictationElapsedLabel(const Duration(minutes: 2, seconds: 7)),
      '2:07',
    );
  });

  test('mobile draft attachment picker shares the regular-message limit', () {
    expect(messageAttachmentSlotAvailable(maxMessageAttachments - 1), isTrue);
    expect(messageAttachmentSlotAvailable(maxMessageAttachments), isFalse);
  });

  test('project choices exclude Windows system folders only', () {
    expect(isSelectableProjectDirectory(r'C:\Windows'), isFalse);
    expect(isSelectableProjectDirectory(r'c:/WINDOWS/System32'), isFalse);
    expect(isSelectableProjectDirectory(r'C:\Windows\System32\remote_cli'),
        isFalse);
    expect(isSelectableProjectDirectory(r'C:\Windows2\project'), isTrue);
    expect(
        isSelectableProjectDirectory(r'C:\Users\example\Documents\Tethoq'), isTrue);
    expect(isSelectableProjectDirectory(''), isFalse);
  });

  testWidgets(
      'offline computer status stays compact and hides transport details',
      (tester) async {
    tester.view.physicalSize = const Size(430, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.disconnected
      ..error =
          'SocketException: Secure DNS returned no usable address for absent-marked-removed-blast.trycloudflare.com';
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    final status = find.byKey(const Key('connection-offline-status'));
    expect(status, findsOneWidget);
    expect(
        find.byKey(const Key('connection-offline-computer')), findsOneWidget);
    expect(find.byKey(const Key('connection-offline-dot')), findsOneWidget);
    expect(find.text('Not connected'), findsOneWidget);
    expect(find.textContaining('SocketException'), findsNothing);
    expect(find.textContaining('trycloudflare.com'), findsNothing);
    expect(tester.getSize(status).height, lessThanOrEqualTo(44));
    expect(tester.getSize(status).width, lessThan(300));
  });

  testWidgets(
      'project headings prepare one draft in that folder and omit unsafe groups',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const projectDirectory = r'C:\Users\example\Documents\Alpha';
    final store = _GatedPreparedFeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..taskListMode = 'project'
      ..selectedProviderId = 'opencode';
    store
      ..sessions.addAll(<RemoteSession>[
        _session(
          'project-alpha',
          providerId: 'codex',
          workingDirectory: projectDirectory,
        ),
        _session(
          'project-missing',
          providerId: 'codex',
          workingDirectory: '',
        ),
        _session(
          'project-system32',
          providerId: 'codex',
          workingDirectory: r'C:\Windows\System32\remote_cli',
        ),
      ])
      ..providers.addAll(<ProviderConnection>[
        _provider('codex'),
        _provider('opencode'),
      ])
      ..modelsByProvider['codex'] = const <RemoteModel>[]
      ..modelsByProvider['opencode'] = const <RemoteModel>[];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    final projectAction = find.byKey(ValueKey<String>(
        'project-new-task-directory:${normalizeProjectDirectory(projectDirectory)}'));
    expect(projectAction, findsOneWidget);
    expect(tester.getSize(projectAction).width, greaterThanOrEqualTo(44));
    expect(tester.getSize(projectAction).height, greaterThanOrEqualTo(44));
    expect(
      find.byKey(ValueKey<String>(
          'project-new-task-directory:${normalizeProjectDirectory(r'C:\Windows\System32\remote_cli')}')),
      findsNothing,
    );
    expect(
      find.byKey(const ValueKey<String>('project-new-task-directory:')),
      findsNothing,
    );

    await tester.tap(projectAction);
    await tester.tap(projectAction);
    await tester.pump();
    expect(store.modelLoadCalls, 1,
        reason: 'Rapid taps must share one prepared-task operation.');
    expect(
      find.byKey(const ValueKey<String>('session-tile-project-alpha')),
      findsOneWidget,
      reason: 'The project plus must not collapse its project heading.',
    );
    store.modelGate.complete();
    await tester.pumpAndSettle();

    final prepared = store.sessions
        .singleWhere((session) => store.isPreparedSession(session.id));
    expect(prepared.providerId, 'opencode');
    expect(prepared.workingDirectory, projectDirectory);
    expect(find.byKey(const Key('session-composer')), findsOneWidget);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(
        store.sessions.where((session) => store.isPreparedSession(session.id)),
        isEmpty,
        reason: 'Backing out of an untouched prepared task creates nothing.');
  });

  testWidgets(
      'prepared task project selector lists existing folders and preserves the draft',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const alphaDirectory = r'C:\Users\example\Documents\Alpha';
    const betaDirectory = r'D:\Work\Beta';
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    store
      ..sessions.addAll(<RemoteSession>[
        _session(
          'existing-alpha',
          providerId: 'codex',
          workingDirectory: alphaDirectory,
        ),
        _session(
          'existing-beta',
          providerId: 'codex',
          workingDirectory: betaDirectory,
        ),
        _session(
          'unsafe-history',
          providerId: 'codex',
          workingDirectory: r'C:\Windows\System32\remote_cli',
        ),
      ])
      ..providers.add(_provider('codex'))
      ..modelsByProvider['codex'] = const <RemoteModel>[];
    final prepared = store.prepareSession(
      'codex',
      workingDirectory: r'C:\Users\example\Documents\Tethoq',
    );
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
    await tester.enterText(
      find.byKey(const Key('session-composer')),
      'Keep this project draft.',
    );
    expect(find.byKey(const Key('prepared-project-current')), findsOneWidget);

    await tester.tap(find.byKey(const Key('prepared-project-selector')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('prepared-project-picker')), findsOneWidget);
    store.notifyListeners();
    await tester.pump();
    expect(
      tester
          .getSize(find.byKey(const Key('prepared-project-picker-cancel')))
          .height,
      greaterThanOrEqualTo(44),
    );
    final alphaOption = find.byKey(ValueKey<String>(
        'prepared-project-option-directory:${normalizeProjectDirectory(alphaDirectory)}'));
    expect(alphaOption, findsOneWidget);
    expect(tester.getSize(alphaOption).height, greaterThanOrEqualTo(44));
    expect(find.text(r'C:\Windows\System32\remote_cli'), findsNothing);
    expect(
        find.descendant(
            of: find.byKey(const Key('prepared-project-picker')),
            matching: find.byType(TextField)),
        findsNothing,
        reason: 'Existing projects must not require path typing.');

    await tester.tap(alphaOption);
    await tester.pumpAndSettle();
    expect(
      store.sessions
          .firstWhere((item) => item.id == prepared.id)
          .workingDirectory,
      alphaDirectory,
    );
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Keep this project draft.',
    );
    expect(
      tester
          .widget<InkWell>(find.byKey(const Key('prepared-project-selector')))
          .onTap,
      isNotNull,
      reason: 'Closing the picker must re-enable its selector after a rebuild.',
    );

    await tester.tap(find.byKey(const Key('prepared-project-selector')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('prepared-project-another-folder')));
    await tester.pumpAndSettle();
    expect(
        find.byKey(const Key('prepared-project-path-field')), findsOneWidget);
    await tester.enterText(
      find.byKey(const Key('prepared-project-path-field')),
      r'D:\Personal\New project',
    );
    await tester.tap(find.byKey(const Key('prepared-project-use-folder')));
    await tester.pumpAndSettle();
    expect(
      store.sessions
          .firstWhere((item) => item.id == prepared.id)
          .workingDirectory,
      r'D:\Personal\New project',
    );

    await tester.tap(find.byKey(const Key('prepared-project-selector')));
    await tester.pumpAndSettle();
    await tester.tapAt(const Offset(8, 8));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('prepared-project-picker')), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Keep this project draft.',
    );
  });

  testWidgets(
      'attachment source menu opens above plus and preserves draft on every dismissal',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    var photoPickerCalls = 0;
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('attachment-menu', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          imageAttachmentPicker: () async {
            photoPickerCalls += 1;
            return null;
          },
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    final composer = find.byKey(const Key('session-composer'));
    final editable = find.descendant(
      of: composer,
      matching: find.byType(EditableText),
    );
    await tester.enterText(composer, 'Keep my attachment draft.');
    expect(tester.widget<EditableText>(editable).focusNode.hasFocus, isTrue);

    final add = find.byKey(const Key('add-attachment'));
    await tester.tap(add);
    await tester.pumpAndSettle();
    final menu = find.byKey(const Key('attachment-source-menu'));
    final photos = find.byKey(const Key('attachment-source-photos'));
    final files = find.byKey(const Key('attachment-source-files'));
    expect(menu, findsOneWidget);
    expect(tester.widget<EditableText>(editable).focusNode.hasFocus, isTrue,
        reason: 'Opening the source menu must not dismiss the keyboard.');
    expect(tester.getRect(menu).bottom, lessThan(tester.getRect(add).top));
    expect(tester.getSize(photos).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(files).height, greaterThanOrEqualTo(44));
    final addTopWithKeyboard = tester.getRect(add).top;

    tester.view.viewInsets = const FakeViewPadding(bottom: 240);
    await tester.pump();
    expect(tester.getRect(add).top, greaterThan(addTopWithKeyboard));
    expect(menu, findsNothing,
        reason:
            'The menu must disappear in the first keyboard-collapse frame, before its stale anchor can detach from the composer.');
    final addTopDuringCollapse = tester.getRect(add).top;

    tester.view.viewInsets = FakeViewPadding.zero;
    await tester.pump();
    expect(tester.getRect(add).top, greaterThan(addTopDuringCollapse));
    expect(menu, findsNothing,
        reason:
            'Later keyboard-collapse frames must not repaint the stale menu.');
    await tester.pumpAndSettle();
    expect(menu, findsNothing,
        reason: 'The first Android Back inset collapse dismisses the menu.');
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Keep my attachment draft.',
    );

    await tester.tap(add);
    await tester.pumpAndSettle();
    await tester.tap(files);
    await tester.pump();
    expect(menu, findsOneWidget,
        reason: 'Files stays disabled for image-only harnesses.');
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(menu, findsNothing);

    await tester.tap(add);
    await tester.pumpAndSettle();
    expect(menu, findsOneWidget);
    await tester.tapAt(const Offset(8, 8));
    await tester.pumpAndSettle();
    expect(menu, findsNothing);

    await tester.tap(add);
    await tester.pumpAndSettle();
    expect(menu, findsOneWidget);
    await tester.tap(photos);
    await tester.pumpAndSettle();
    expect(photoPickerCalls, 1);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Keep my attachment draft.',
    );
    expect(store.draftAttachmentsFor(session.id), isEmpty);
  });

  testWidgets('Files source launches the native picker after menu dismissal',
      (tester) async {
    final originalSelector = FileSelectorPlatform.instance;
    final selector = _GatedFileSelector();
    FileSelectorPlatform.instance = selector;
    addTearDown(() => FileSelectorPlatform.instance = originalSelector);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('file-source-menu', providerId: 'opencode');
    store
      ..sessions.add(session)
      ..providers.add(_provider('opencode'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    await tester.enterText(
        find.byKey(const Key('session-composer')), 'Keep this file draft.');
    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('attachment-source-files')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    await tester.pump();
    expect(find.byKey(const Key('attachment-source-menu')), findsNothing);
    expect(selector.openCalls, 1);

    selector.gate.complete(null);
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller
          ?.text,
      'Keep this file draft.',
    );
    expect(store.draftAttachmentsFor(session.id), isEmpty);
  });

  test('distinct tool starts sharing one assistant message stay separate', () {
    final occurredAt = DateTime.utc(2026, 8, 14, 11);
    final events = <AgentEvent>[
      AgentEvent(
        eventId: 'first-tool',
        sequence: 1,
        type: 'tool.started',
        occurredAt: occurredAt,
        payload: const <String, Object?>{
          'tool': 'write_file',
          'messageID': 'assistant-one',
        },
      ),
      AgentEvent(
        eventId: 'second-tool',
        sequence: 2,
        type: 'tool.started',
        occurredAt: occurredAt.add(const Duration(seconds: 1)),
        payload: const <String, Object?>{
          'tool': 'search',
          'messageID': 'assistant-one',
        },
      ),
    ];

    expect(groupConversationActivityEventIdsForTesting(events), <Object?>[
      <String>['first-tool'],
      <String>['second-tool'],
    ]);
  });

  test('completed EYES failures render a useful notice without expansion', () {
    final occurredAt = DateTime.utc(2026, 8, 27, 11);
    final events = <AgentEvent>[
      AgentEvent(
        eventId: 'eyes-started',
        sequence: 1,
        type: 'tool.started',
        occurredAt: occurredAt,
        payload: const <String, Object?>{
          'tool': 'uar_mesh_tethoq_turn_support',
          'callId': 'eyes-call',
          'status': 'running',
        },
      ),
      AgentEvent(
        eventId: 'eyes-failed',
        sequence: 2,
        type: 'tool.completed',
        occurredAt: occurredAt.add(const Duration(seconds: 1)),
        payload: const <String, Object?>{
          'tool': 'uar_mesh_tethoq_turn_support',
          'callId': 'eyes-call',
          'status': 'failed',
          'output': 'EYES could not inspect the image.',
        },
      ),
    ];

    expect(conversationActivityLabelsForTesting(events), <String>['EYES']);
  });

  test('EYES usage exhaustion is distinguished from a generic failure', () {
    final events = <AgentEvent>[
      AgentEvent(
        eventId: 'eyes-usage-failed',
        sequence: 1,
        type: 'tool.completed',
        occurredAt: DateTime.utc(2026, 8, 27, 11),
        payload: const <String, Object?>{
          'tool': 'ask_eyes',
          'callId': 'eyes-usage-call',
          'status': 'failed',
          'output':
              'EYES could not use the selected model because its usage limit was reached.',
        },
      ),
    ];

    expect(conversationActivityLabelsForTesting(events), <String>['EYES']);
  });

  testWidgets('live and persisted EYES failures show one safe visible notice',
      (tester) async {
    tester.view.physicalSize = const Size(430, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const rawFailure =
        r'429 quota exhausted for api_key=RAW_SECRET C:\private\session https://provider.invalid/private';
    const safeNotice =
        'EYES could not use the selected model because its usage limit was reached or it is temporarily rate-limited. Check the provider account or choose another EYES model.';
    final occurredAt = DateTime.utc(2026, 8, 27, 12);
    final store = _FeatureStore();
    final source = _session('eyes-failure', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..events[source.id] = <AgentEvent>[
        AgentEvent(
          eventId: 'eyes-live-failure',
          sequence: 1,
          type: 'tool.completed',
          occurredAt: occurredAt,
          sessionId: source.id,
          payload: const <String, Object?>{
            'tool': 'uar_mesh_tethoq_turn_support',
            'callId': 'eyes-call',
            'providerPartId': 'eyes-part',
            'status': 'failed',
            // This is the shape emitted by the Bridge for a live client-tool
            // failure. The raw value must classify the notice without ever
            // becoming visible in the conversation.
            'error': rawFailure,
          },
        ),
        AgentEvent(
          eventId: 'safe-tool',
          sequence: 2,
          type: 'tool.completed',
          occurredAt: occurredAt.add(const Duration(seconds: 1)),
          sessionId: source.id,
          payload: const <String, Object?>{
            'tool': 'read_file',
            'callId': 'safe-call',
            'status': 'completed',
            'output': 'Read the requested file.',
          },
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.text(safeNotice), findsOneWidget);
    for (final raw in <String>[
      'RAW_SECRET',
      r'C:\private\session',
      'provider.invalid',
    ]) {
      expect(find.textContaining(raw, skipOffstage: false), findsNothing);
    }

    final reasoningToggle =
        find.byKey(const Key('reasoning-toggle-activity-safe-tool'));
    expect(reasoningToggle, findsOneWidget);
    tester.widget<InkWell>(reasoningToggle).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    final expandTools = find.byKey(const Key('expand-reasoning-tools'));
    expect(expandTools, findsOneWidget);
    tester.widget<TextButton>(expandTools).onPressed!();
    await tester.pump(const Duration(milliseconds: 200));
    for (final raw in <String>[
      'RAW_SECRET',
      r'C:\private\session',
      'provider.invalid',
    ]) {
      expect(find.textContaining(raw, skipOffstage: false), findsNothing);
    }

    store.messages[source.id] = <RemoteMessage>[
      RemoteMessage(
        id: 'persisted-eyes-message',
        sessionId: source.id,
        role: 'assistant',
        createdAt: occurredAt,
        status: 'completed',
        parts: const <ContentPart>[
          ContentPart(type: 'tool', data: <String, Object?>{
            'name': 'Ask visual support',
            'callId': 'eyes-call',
            'providerPartId': 'eyes-part',
            'status': 'failed',
            'output': rawFailure,
          }),
        ],
      ),
    ];
    store.notifyListeners();
    await tester.pump();

    expect(find.text(safeNotice), findsOneWidget);
    for (final raw in <String>[
      'RAW_SECRET',
      r'C:\private\session',
      'provider.invalid',
    ]) {
      expect(find.textContaining(raw, skipOffstage: false), findsNothing);
    }
  });

  testWidgets('EYES retries paint one failure notice per user turn',
      (tester) async {
    final store = _FeatureStore();
    final source = _session('eyes-turn-dedupe', providerId: 'future-harness');
    final started = DateTime.utc(2026, 8, 28, 12);
    RemoteMessage user(String id, DateTime at) => RemoteMessage(
          id: id,
          sessionId: source.id,
          role: 'user',
          createdAt: at,
          status: 'completed',
          parts: <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{'text': id}),
          ],
        );
    RemoteMessage failure(String id, String callId, DateTime at) =>
        RemoteMessage(
          id: id,
          sessionId: source.id,
          role: 'assistant',
          createdAt: at,
          status: 'completed',
          parts: <ContentPart>[
            ContentPart(type: 'tool', data: <String, Object?>{
              'name': 'uar_mesh_tethoq_turn_support',
              'callId': callId,
              'status': 'failed',
              'output': 'EYES could not inspect the image.',
            }),
          ],
        );
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = <RemoteMessage>[
        user('first-user', started),
        failure('first-failure', 'first-call',
            started.add(const Duration(seconds: 1))),
        failure('retry-failure', 'retry-call',
            started.add(const Duration(seconds: 2))),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    expect(
        find.text(
            'EYES could not inspect the image. Try again or choose another EYES model.'),
        findsOneWidget);

    store.messages[source.id] = <RemoteMessage>[
      ...store.messages[source.id]!,
      user('second-user', started.add(const Duration(seconds: 3))),
      failure('later-failure', 'later-call',
          started.add(const Duration(seconds: 4))),
    ];
    store.notifyListeners();
    await tester.pump();
    expect(
        find.text(
            'EYES could not inspect the image. Try again or choose another EYES model.'),
        findsNWidgets(2));
  });

  testWidgets(
      'visual status retry stays owned across unrelated store notifications',
      (tester) async {
    final store = _FeatureStore()
      ..activeHost = _mobileHost
      ..visionStatusFailuresRemaining = 1;
    final source = _session('vision-retry', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    expect(store.visionStatusCalls, 1);

    for (var index = 0; index < 3; index += 1) {
      store.notifyListeners();
      await tester.pump();
      expect(store.visionStatusCalls, 1);
    }

    await tester.pump(const Duration(milliseconds: 249));
    expect(store.visionStatusCalls, 1);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump();
    expect(store.visionStatusCalls, 2);
    expect(store.visionBySession, contains(source.id));

    store.notifyListeners();
    await tester.pump(const Duration(milliseconds: 500));
    expect(store.visionStatusCalls, 2);
  });

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

  testWidgets('branch relationship stays visible and navigates both ways',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('branch-source', providerId: 'future-harness');
    final branch = _session(
      'branch-target',
      providerId: 'future-harness',
      relationship: SessionRelationship(
        kind: 'branch',
        sourceSessionId: source.id,
        strategy: 'transcript_bootstrap',
      ),
    );
    store
      ..sessions.addAll(<RemoteSession>[source, branch])
      ..providers.add(_provider('future-harness'))
      ..selectedSession = source;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    expect(find.byKey(const Key('branch-relationship-banner')), findsOneWidget);
    expect(
        find.text('Branched to Feature session branch-target'), findsOneWidget);
    await tester
        .tap(find.byKey(ValueKey<String>('branch-relationship-${branch.id}')));
    await tester.pumpAndSettle();

    expect(store.selectedSession?.id, branch.id);
    expect(find.text('Branched from Feature session branch-source'),
        findsOneWidget);
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
    expect(find.text('Automatic compaction updated'), findsNothing,
        reason: 'saving the sheet is already sufficient feedback');
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

    expect(find.textContaining('Light', findRichText: true), findsOneWidget);
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
    await tester.tap(find.byKey(const Key('attachment-source-photos')));
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

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
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
    await tester.tap(find.byKey(const Key('attachment-source-photos')));
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
    FlutterSecureStorage.setMockInitialValues(<String, String>{
      'uar.recent_used_models.v1':
          '[{"key":"codex\\u0000codex-b","usedAt":"2026-08-28T12:00:00.000Z"}]',
    });
    final store = _FeatureStore();
    await store.initialize();
    store.connectionState = BridgeConnectionState.online;
    store
      ..providers.addAll(<ProviderConnection>[
        _provider('codex', modelEnumeration: true),
        _provider('direct', modelEnumeration: true),
        _provider('opencode', modelEnumeration: true),
      ])
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'codex-a', 'Codex Alpha', isDefault: true),
        _model('codex', 'codex-b', 'Codex Beta'),
      ]
      ..modelsByProvider['direct'] = <RemoteModel>[
        _model('direct', 'openai::api-a', 'API Alpha'),
      ]
      ..modelsByProvider['opencode'] = <RemoteModel>[
        const RemoteModel(
          id: 'deepseek/deepseek-v4',
          providerId: 'opencode',
          displayName: 'DeepSeek V4',
          isDefault: false,
          nativeMetadata: <String, Object?>{
            'sourceProviderId': 'deepseek',
            'sourceProviderName': 'DeepSeek',
          },
        ),
        const RemoteModel(
          id: 'opencode-go/deepseek-v4',
          providerId: 'opencode',
          displayName: 'DeepSeek V4',
          isDefault: false,
          nativeMetadata: <String, Object?>{
            'sourceProviderId': 'opencode-go',
            'sourceProviderName': 'OpenCode Go',
          },
        ),
      ];
    final source = store.prepareSession('codex');
    final recentBeforeSelection = List<String>.of(store.recentModelKeys);
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
    expect(find.text('DeepSeek'), findsOneWidget);
    final openCodeGoHeader = find.byWidgetPredicate(
        (widget) => widget is Text && widget.data == 'OpenCode Go');
    expect(openCodeGoHeader, findsOneWidget);
    await tester.enterText(
        find.byKey(const Key('model-search-field')), 'OpenCode Go');
    await tester.pump();
    expect(find.text('DeepSeek V4'), findsOneWidget);
    expect(openCodeGoHeader, findsOneWidget);
    await tester.enterText(find.byKey(const Key('model-search-field')), 'Beta');
    await tester.pump();
    expect(find.text('Codex Beta'), findsWidgets);
    expect(find.byKey(const Key('catalog-codex-codex-a')), findsNothing);
    await tester.enterText(find.byKey(const Key('model-search-field')), 'API');
    await tester.pump();
    await tester.tap(find.byKey(const Key('catalog-direct-openai::api-a')));
    await tester.pumpAndSettle();
    expect(store.sessions.single.providerId, 'direct');
    expect(store.recentModelKeys, recentBeforeSelection,
        reason: 'an unsent picker choice is not model usage');
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

    const previewKey = ValueKey<String>('expand-message-image-image-message-0');
    expect(find.byKey(previewKey), findsOneWidget);
    await tester.tap(find.byKey(previewKey));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('expanded-message-image')), findsOneWidget);
    expect(find.byType(InteractiveViewer), findsOneWidget);
  });

  testWidgets(
      'direct wallet sheet warns for a key and exposes advanced endpoint fields',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..activeHost = _mobileHost;
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
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
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
      ..connectionState = BridgeConnectionState.online
      ..activeHost = _mobileHost;
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
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
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
    const toolPayload = <String, Object?>{
      'tool': 'read_file',
      'partId': 'read-part',
      'messageID': 'assistant-one',
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
    };
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..events[source.id] = <AgentEvent>[
        AgentEvent(
          eventId: 'tool-event',
          sequence: 1,
          type: 'tool.started',
          occurredAt: DateTime.utc(2026, 8, 14, 11),
          payload: toolPayload,
          sessionId: source.id,
          providerId: source.providerId,
        ),
        AgentEvent(
          eventId: 'tool-event-update',
          sequence: 2,
          type: 'tool.started',
          occurredAt: DateTime.utc(2026, 8, 14, 11, 0, 1),
          payload: toolPayload,
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
    expect(
        find.byKey(
            const ValueKey<String>('activity-disclosure-tool-event-update')),
        findsNothing);
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
    final toggle =
        find.byKey(const Key('reasoning-toggle-tethoq-live-reasoning'));
    tester.widget<InkWell>(toggle).onTap!();
    await tester.pump();
    expect(find.text('Working…'), findsOneWidget);

    store.sessions[0] = source.copyWith(state: 'completed');
    store.notifyListeners();
    await tester.pump();
    expect(find.byKey(const Key('reasoning-toggle-tethoq-live-reasoning')),
        findsNothing);
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

  testWidgets(
      'streaming reasoning keeps its disclosure state as details append',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session(
      'stable-reasoning-key',
      providerId: 'future-harness',
      state: 'working',
    );
    RemoteMessage reasoningMessage(List<ContentPart> parts) => RemoteMessage(
          id: 'stable-reasoning-message',
          sessionId: source.id,
          role: 'assistant',
          createdAt: DateTime.utc(2026, 9, 2, 11),
          status: 'streaming',
          parts: parts,
        );
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = <RemoteMessage>[
        reasoningMessage(const <ContentPart>[
          ContentPart(type: 'reasoning', data: <String, Object?>{
            'summary': 'First streamed thought',
            'text': 'The first streamed reasoning detail.',
          }),
        ]),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    final toggle = find.byKey(const Key(
        'reasoning-toggle-stable-reasoning-message-part-0-thinking-0'));
    expect(toggle, findsOneWidget);
    tester.widget<InkWell>(toggle).onTap!();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const Key('expand-reasoning-thinking')), findsOneWidget);

    store.messages[source.id] = <RemoteMessage>[
      reasoningMessage(const <ContentPart>[
        ContentPart(type: 'reasoning', data: <String, Object?>{
          'summary': 'First streamed thought',
          'text': 'The first streamed reasoning detail.',
        }),
        ContentPart(type: 'reasoning', data: <String, Object?>{
          'summary': 'Second streamed thought',
          'text': 'A later detail arrived without replacing the first.',
        }),
      ]),
    ];
    store.notifyListeners();
    await tester.pump();

    expect(find.byKey(const Key('expand-reasoning-thinking')), findsOneWidget);
    expect(toggle, findsOneWidget);
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

  testWidgets(
      'session rows use immediate press fill instead of a tap-location splash',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('tap-feedback', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: const MaterialApp(home: SessionsScreen()),
    ));
    await tester.pump();

    final row = find.byKey(ValueKey<String>('session-row-${source.id}'));
    expect(row, findsOneWidget);
    final ink = tester.widget<InkWell>(row);
    expect(ink.splashFactory, NoSplash.splashFactory);
    expect(ink.highlightColor?.a ?? 0, greaterThan(0.15));
    expect(
      ink.overlayColor?.resolve(<WidgetState>{WidgetState.pressed})?.a,
      greaterThan(0.15),
    );
    expect(ink.onTap, isNotNull);

    ink.onTap!();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(SessionScreen), findsOneWidget);
  });

  testWidgets('mobile composer uses a compact two-line action layout',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('wide-composer', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    await tester.enterText(
      find.byKey(const Key('session-composer')),
      'This instruction should keep using the full composer width instead of wrapping beside the action icons.',
    );
    await tester.pump();

    final shell =
        tester.getRect(find.byKey(const Key('session-composer-shell')));
    final composer = tester.getRect(find.byKey(const Key('session-composer')));
    final actions =
        tester.getRect(find.byKey(const Key('session-composer-actions')));
    final attach = tester.getRect(find.byKey(const Key('add-attachment')));
    final sendTarget =
        tester.getRect(find.byKey(const Key('send-instruction')));
    final sendVisual =
        tester.getRect(find.byKey(const Key('send-instruction-visual')));
    final dictation = tester.getRect(find.byKey(const Key('dictation-button')));
    final dictationVisual = tester.getRect(find.descendant(
      of: find.byKey(const Key('dictation-button')),
      matching: find.byIcon(Icons.mic_none_rounded),
    ));
    final dictationSource =
        tester.getRect(find.byKey(const Key('dictation-source-selector')));
    final model = tester.getRect(find.byKey(const Key('model-control')));
    final more =
        tester.getRect(find.byKey(const Key('session-secondary-controls')));
    final shellWidget = tester
        .widget<Container>(find.byKey(const Key('session-composer-shell')));
    final shellDecoration = shellWidget.decoration! as BoxDecoration;
    final foregroundDecoration =
        shellWidget.foregroundDecoration! as BoxDecoration;
    expect(composer.width, greaterThan(shell.width * 0.78));
    expect(composer.bottom, lessThanOrEqualTo(actions.top + 1));
    expect(actions.height, 52);
    expect(find.byKey(const Key('session-controls')), findsNothing);
    expect(attach.top, closeTo(sendTarget.top, 1));
    expect(model.top, closeTo(sendTarget.top, 1));
    expect(dictation.top, closeTo(sendTarget.top, 1));
    expect(more.top, closeTo(sendTarget.top, 1));
    expect(dictationVisual.center.dy, closeTo(sendVisual.center.dy, 1));
    expect(attach.height, greaterThanOrEqualTo(44));
    expect(model.height, greaterThanOrEqualTo(44));
    expect(dictation.size, const Size(44, 38));
    expect(dictationSource.size, const Size(30, 13));
    expect(dictationSource.center.dx, closeTo(dictation.center.dx, .1));
    expect(dictationSource.top, lessThan(dictation.bottom));
    expect(dictationSource.bottom, lessThan(actions.bottom));
    expect(more.width, 44);
    expect(more.height, 44);
    expect(sendTarget.size, const Size.square(44));
    expect(sendVisual.size, const Size.square(36));
    expect(sendVisual.center.dx, closeTo(sendTarget.center.dx, .1));
    expect(sendVisual.center.dy, closeTo(sendTarget.center.dy, .1));
    expect(shellDecoration.border, isNull);
    expect(shellDecoration.borderRadius, BorderRadius.circular(16));
    expect(foregroundDecoration.border, isNotNull);
    expect(foregroundDecoration.borderRadius, shellDecoration.borderRadius);
    expect(shellWidget.clipBehavior, Clip.antiAlias);

    await tester.tap(find.byKey(const Key('dictation-source-selector')));
    await tester.pumpAndSettle();
    expect(find.text('Dictation source'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'physical Enter submits once while the soft keyboard stays multiline',
      (tester) async {
    final store = _PendingSendFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('multiline-composer', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    final composer = find.byKey(const Key('session-composer'));
    await tester.tap(composer);
    await tester.pump();
    expect(
      tester.testTextInput.setClientArgs!['inputAction'],
      TextInputAction.newline.toString(),
    );

    await tester.enterText(composer, 'Submit from physical Enter');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(store.mainSendCalls, 1);
    expect(tester.widget<TextField>(composer).controller!.text, isEmpty);

    const multilineText = 'First line\nSecond line';
    tester.testTextInput.updateEditingValue(const TextEditingValue(
      text: multilineText,
      selection: TextSelection.collapsed(offset: multilineText.length),
    ));
    await tester.testTextInput.receiveAction(TextInputAction.newline);
    await tester.pump();

    expect(tester.widget<TextField>(composer).controller!.text, multilineText);
    expect(store.mainSendCalls, 1);
    store.mainSendGate.complete(null);
    await tester.pump();
  });

  testWidgets(
      'composer actions fit narrow phones at large accessibility text scales',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    const longModelLabel =
        'GPT-5.6-Sol with an intentionally very long mobile display name';
    final source = _session(
      'narrow-scaled-composer',
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    );
    store
      ..sessions.add(source)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'gpt-5.6-sol', longModelLabel, isDefault: true),
      ];
    addTearDown(store.dispose);

    for (final width in <double>[320, 280, 240]) {
      for (final scale in <double>[1.5, 2]) {
        tester.view.physicalSize = Size(width, 720);
        await tester.pumpWidget(StoreScope(
          store: store,
          child: MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: SessionScreen(
              sessionId: source.id,
              dictationRecorder: _NoopRecorder(),
            ),
          ),
        ));
        await tester.pump();

        final reason = '${width.toInt()}px at ${scale}x text';
        final layoutException = tester.takeException();
        expect(
          layoutException,
          isNull,
          reason: layoutException is FlutterError
              ? layoutException.toStringDeep()
              : reason,
        );
        final actions =
            tester.getRect(find.byKey(const Key('session-composer-actions')));
        expect(actions.height, 52, reason: reason);
        final orderedControls = <Rect>[
          tester.getRect(find.byKey(const Key('add-attachment'))),
          tester.getRect(find.byKey(const Key('model-control'))),
          tester.getRect(find.byKey(const Key('dictation-button'))),
          tester.getRect(find.byKey(const Key('session-secondary-controls'))),
          tester.getRect(find.byKey(const Key('send-instruction'))),
        ];
        final sourceSelector =
            tester.getRect(find.byKey(const Key('dictation-source-selector')));
        for (final control in orderedControls) {
          expect(control.width, greaterThanOrEqualTo(44), reason: reason);
          expect(control.left, greaterThanOrEqualTo(actions.left - .1),
              reason: reason);
          expect(control.right, lessThanOrEqualTo(actions.right + .1),
              reason: reason);
          expect(control.top, greaterThanOrEqualTo(actions.top - .1),
              reason: reason);
          expect(control.bottom, lessThanOrEqualTo(actions.bottom + .1),
              reason: reason);
        }
        for (var index = 1; index < orderedControls.length; index += 1) {
          expect(orderedControls[index - 1].right,
              lessThanOrEqualTo(orderedControls[index].left + .1),
              reason: reason);
        }
        expect(sourceSelector.size, const Size(30, 13), reason: reason);
        expect(sourceSelector.left, greaterThanOrEqualTo(actions.left - .1),
            reason: reason);
        expect(sourceSelector.right, lessThanOrEqualTo(actions.right + .1),
            reason: reason);
        expect(sourceSelector.top, greaterThanOrEqualTo(actions.top - .1),
            reason: reason);
        expect(sourceSelector.bottom, lessThanOrEqualTo(actions.bottom + .1),
            reason: reason);
        expect(find.byTooltip('$longModelLabel · Ultra'), findsOneWidget,
            reason: '$reason keeps the full model label discoverable');

        final RenderEditable editable = tester
            .state<EditableTextState>(find.descendant(
              of: find.byKey(const Key('session-composer')),
              matching: find.byType(EditableText),
            ))
            .renderEditable;
        expect(editable.size.height,
            greaterThanOrEqualTo(editable.preferredLineHeight),
            reason: '$reason clips the composer text');
      }
    }
  });

  testWidgets('composer semantics name the field, model, and dictation state',
      (tester) async {
    final semantics = tester.ensureSemantics();
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    const longModelLabel =
        'GPT-5.6-Sol with an intentionally very long mobile display name';
    final session = _session(
      'composer-semantics',
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    );
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'gpt-5.6-sol', longModelLabel, isDefault: true),
      ]
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _SuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();

    expect(
      tester
          .getSemantics(find.byKey(const Key('session-composer-semantics')))
          .getSemanticsData()
          .label,
      startsWith('Message composer'),
    );
    expect(
      tester
          .getSemantics(find.byKey(const Key('model-control-semantics')))
          .getSemanticsData()
          .label,
      'Model: $longModelLabel. Reasoning: Ultra.',
    );
    expect(find.byTooltip('$longModelLabel · Ultra'), findsOneWidget);
    expect(
      tester
          .getSemantics(find.byKey(const Key('dictation-button-semantics')))
          .getSemanticsData()
          .label,
      'Start dictation with OpenAI speech to text',
    );
    final sourceSemantics = tester
        .getSemantics(
            find.byKey(const Key('dictation-source-selector-semantics')))
        .getSemanticsData();
    expect(sourceSemantics.label, 'Choose dictation source');
    expect(sourceSemantics.hasAction(SemanticsAction.tap), isTrue);

    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(
      tester
          .getSemantics(find.byKey(const Key('dictation-button-semantics')))
          .getSemanticsData()
          .label,
      'Stop and transcribe',
    );

    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(store.transcriptions, hasLength(1));
    await tester.tap(find.byKey(const Key('cancel-dictation-processing')));
    await tester.pump();
    expect(
      tester
          .getSemantics(find.byKey(const Key('dictation-button-semantics')))
          .getSemanticsData()
          .label,
      'Retry the saved recording without speaking again',
    );
    store.transcriptions.single.complete('ignored stale transcript');
    await tester.pump();

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    semantics.dispose();
  });

  testWidgets('direct-audio trace stays visual-only while Stop is announced',
      (tester) async {
    final semantics = tester.ensureSemantics();
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session(
      'direct-audio-semantics',
      providerId: 'codex',
      modelId: 'audio-model',
    );
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = const <RemoteModel>[
        RemoteModel(
          id: 'audio-model',
          providerId: 'codex',
          displayName: 'Audio model',
          isDefault: true,
          inputModalities: <String>['text', 'audio'],
          nativeMetadata: <String, Object?>{},
        ),
      ]
      ..dictationSourcePreferences['codex'] = directAudioDictationSourceId;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _SuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    expect(
      tester
          .getSemantics(find.byKey(const Key('dictation-button-semantics')))
          .getSemanticsData()
          .label,
      'Start audio recording',
    );

    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(find.byKey(const Key('dictation-live-trace')), findsOneWidget);
    expect(
      tester
          .widget<ExcludeSemantics>(
              find.byKey(const Key('dictation-live-trace')))
          .excluding,
      isTrue,
    );
    expect(
      tester
          .getSemantics(find.byKey(const Key('dictation-button-semantics')))
          .getSemanticsData()
          .label,
      'Stop recording',
    );

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    semantics.dispose();
  });

  testWidgets('main and side-chat attachment chips keep 44dp targets at 2x',
      (tester) async {
    final semantics = tester.ensureSemantics();
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const attachment = RemoteAttachment(
      name: 'very-long-mobile-attachment-name.png',
      mimeType: 'image/png',
      dataBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      byteLength: 68,
    );
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..sideChatAttachmentFixture = attachment;
    final session = _session(
      'scaled-attachment-lanes',
      providerId: 'codex',
      modelId: 'test-model',
    );
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'test-model', 'Test model', isDefault: true),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        builder: (context, child) => MediaQuery(
          data:
              MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(2)),
          child: child!,
        ),
        home: SessionScreen(
          sessionId: session.id,
          imageAttachmentPicker: () async => attachment,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('add-attachment')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('attachment-source-photos')));
    await tester.pumpAndSettle();

    final mainLane = find.byKey(const Key('session-composer-attachment-lane'));
    final mainChip = find.byKey(const ValueKey<String>(
        'session-attachment-chip-very-long-mobile-attachment-name.png-0'));
    expect(tester.getSize(mainLane).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(mainChip).height, greaterThanOrEqualTo(44));
    expect(tester.getSemantics(mainChip).getSemanticsData().label,
        contains('very-long-mobile-attachment-name.png'));

    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-side-chat')));
    await tester.pumpAndSettle();

    final sideLane = find.byKey(const Key('side-chat-attachment-lane'));
    final sideChip = find.byKey(const ValueKey<String>(
        'side-chat-attachment-chip-very-long-mobile-attachment-name.png-0'));
    expect(sideLane, findsOneWidget);
    expect(sideChip, findsOneWidget);
    expect(tester.getSize(sideLane).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(sideChip).height, greaterThanOrEqualTo(44));
    expect(tester.getSemantics(sideChip).getSemanticsData().label,
        contains('very-long-mobile-attachment-name.png'));
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });

  testWidgets('side chat stays usable when its autofocus opens the keyboard',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 1600);
    tester.view.devicePixelRatio = 2.625;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('side-chat-keyboard', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);

    tester.view.viewInsets = const FakeViewPadding(bottom: 800);
    await tester.pump();
    expect(tester.takeException(), isNull);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    final composer = find.byKey(const Key('side-chat-composer'));
    final actions = find.byKey(const Key('side-chat-actions'));
    final close = find.byTooltip('Close side chat');
    final promote = find.byKey(const Key('promote-side-chat'));
    final header = find.text('Side chat');
    expect(composer, findsOneWidget);
    expect(actions, findsOneWidget);
    expect(close, findsOneWidget);
    expect(promote, findsOneWidget);
    expect(header, findsOneWidget);
    expect(tester.getSize(composer).height, greaterThan(0));
    expect(tester.getSize(actions).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(header).height, greaterThan(0));
    expect(tester.getRect(composer).bottom,
        lessThanOrEqualTo(tester.getRect(actions).top + 1));
    final visibleBottom = (1600 - 800) / 2.625;
    expect(
        tester.getRect(actions).bottom, lessThanOrEqualTo(visibleBottom + 1));
    expect(tester.getRect(close).bottom, lessThanOrEqualTo(visibleBottom + 1));
    for (final target in <Finder>[
      close,
      promote,
      find.byKey(const Key('side-chat-attachment')),
      find.byKey(const Key('side-chat-dictation')),
      find.byKey(const Key('side-chat-send')),
    ]) {
      final size = tester.getSize(target);
      expect(size.width, greaterThanOrEqualTo(44));
      expect(size.height, greaterThanOrEqualTo(44));
    }
  });

  testWidgets(
      'tight portrait keyboard keeps attachment and Simplify in the tool lane',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 1600);
    tester.view.devicePixelRatio = 2.625;
    tester.view.viewPadding = const FakeViewPadding(top: 91);
    tester.view.padding = const FakeViewPadding(top: 91);
    tester.view.viewInsets = const FakeViewPadding(bottom: 872);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetViewInsets);
    const attachment = RemoteAttachment(
      name: 'show_keyboard_icon.png',
      mimeType: 'image/png',
      dataBase64: 'AQID',
      byteLength: 3,
    );
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..sideChatAttachmentFixture = attachment;
    final session =
        _session('side-chat-portrait-accessories', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    expect(tester.takeException(), isNull);

    final composer = find.byKey(const Key('side-chat-composer'));
    await tester.enterText(composer, '/simplify');
    await tester.pump();
    expect(tester.takeException(), isNull);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    final actions = find.byKey(const Key('side-chat-actions'));
    final lane = find.byKey(const Key('side-chat-attachment-lane'));
    final attachmentChip = find.byKey(const ValueKey<String>(
        'side-chat-attachment-chip-show_keyboard_icon.png-0'));
    expect(actions, findsOneWidget);
    expect(lane, findsOneWidget);
    expect(attachmentChip, findsOneWidget);
    expect(store.simplifySettingsFor('feature-side-chat-0'), isNotNull);
    await tester.drag(lane, const Offset(-260, 0));
    await tester.pump();
    final simplifyChip = find.byKey(const Key('simplify-composer-chip'));
    expect(simplifyChip, findsOneWidget);
    expect(tester.getSize(actions).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(attachmentChip).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(simplifyChip).height, greaterThanOrEqualTo(44));
    expect(tester.getRect(composer).bottom,
        lessThanOrEqualTo(tester.getRect(actions).top + 1));
    final visibleTop = 91 / 2.625;
    final visibleBottom = (1600 - 872) / 2.625;
    for (final target in <Finder>[
      find.text('Side chat'),
      find.byKey(const Key('promote-side-chat')),
      find.byTooltip('Close side chat'),
      composer,
      actions,
      lane,
      attachmentChip,
      simplifyChip,
      find.byKey(const Key('side-chat-attachment')),
      find.byKey(const Key('side-chat-dictation')),
      find.byKey(const Key('side-chat-send')),
    ]) {
      final rect = tester.getRect(target);
      expect(rect.top, greaterThanOrEqualTo(visibleTop - 1));
      expect(rect.bottom, lessThanOrEqualTo(visibleBottom + 1),
          reason: '$target resolved to $rect');
    }
  });

  testWidgets('side chat keeps its header above a severe landscape keyboard',
      (tester) async {
    tester.view.physicalSize = const Size(1600, 1080);
    tester.view.devicePixelRatio = 2.625;
    tester.view.viewPadding = const FakeViewPadding(top: 74);
    tester.view.padding = const FakeViewPadding(top: 74);
    tester.view.viewInsets = const FakeViewPadding(bottom: 686);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetViewInsets);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('side-chat-landscape-ime', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);

    await tester.pump();
    expect(tester.takeException(), isNull);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    final header = find.text('Side chat');
    final promote = find.byKey(const Key('promote-side-chat'));
    final close = find.byTooltip('Close side chat');
    final composer = find.byKey(const Key('side-chat-composer'));
    final actions = find.byKey(const Key('side-chat-actions'));
    expect(header, findsOneWidget);
    expect(promote, findsOneWidget);
    expect(close, findsOneWidget);
    expect(composer, findsOneWidget);
    expect(actions, findsOneWidget);
    final visibleTop = 74 / 2.625;
    final visibleBottom = (1080 - 686) / 2.625;
    for (final finder in <Finder>[header, promote, close, composer, actions]) {
      final rect = tester.getRect(finder);
      expect(rect.top, greaterThanOrEqualTo(visibleTop - 1));
      expect(rect.bottom, lessThanOrEqualTo(visibleBottom + 1));
    }
    expect(tester.getRect(composer).bottom,
        lessThanOrEqualTo(tester.getRect(actions).top + 1));
    for (final target in <Finder>[
      promote,
      close,
      find.byKey(const Key('side-chat-attachment')),
      find.byKey(const Key('side-chat-dictation')),
      find.byKey(const Key('side-chat-send')),
    ]) {
      final size = tester.getSize(target);
      expect(size.width, greaterThanOrEqualTo(44));
      expect(size.height, greaterThanOrEqualTo(44));
    }
  });

  testWidgets(
      'compact landscape keeps attachments inside the safe two-lane composer',
      (tester) async {
    tester.view.physicalSize = const Size(1600, 1080);
    tester.view.devicePixelRatio = 2.625;
    tester.view.viewPadding = const FakeViewPadding(top: 74);
    tester.view.padding = const FakeViewPadding(top: 74);
    tester.view.viewInsets = const FakeViewPadding(bottom: 686);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetViewInsets);
    const attachment = RemoteAttachment(
      name: 'landscape-reference.png',
      mimeType: 'image/png',
      dataBase64: 'AQID',
      byteLength: 3,
    );
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..sideChatAttachmentFixture = attachment;
    final session =
        _session('side-chat-landscape-attachment', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    expect(tester.takeException(), isNull);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    final lane = find.byKey(const Key('side-chat-attachment-lane'));
    final chip = find.byKey(const ValueKey<String>(
        'side-chat-attachment-chip-landscape-reference.png-0'));
    final actions = find.byKey(const Key('side-chat-actions'));
    expect(lane, findsOneWidget);
    expect(chip, findsOneWidget);
    expect(tester.getSize(lane).height, greaterThanOrEqualTo(44));
    expect(tester.getSize(chip).height, greaterThanOrEqualTo(44));
    final visibleTop = 74 / 2.625;
    final visibleBottom = (1080 - 686) / 2.625;
    for (final target in <Finder>[
      lane,
      chip,
      actions,
      find.byKey(const Key('side-chat-attachment')),
      find.byKey(const Key('side-chat-dictation')),
      find.byKey(const Key('side-chat-send')),
    ]) {
      final rect = tester.getRect(target);
      expect(rect.top, greaterThanOrEqualTo(visibleTop - 1));
      expect(rect.bottom, lessThanOrEqualTo(visibleBottom + 1));
    }
  });

  testWidgets(
      'side chat restores the latest message after metrics changes without yanking a reader',
      (tester) async {
    tester.view.physicalSize = const Size(430, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    final store = _LongSideChatFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('side-chat-metrics', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);

    final list = find.byKey(const Key('side-chat-message-list'));
    final controller = tester.widget<ListView>(list).controller!;
    expect(controller.position.maxScrollExtent, greaterThan(160));
    expect(controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1));

    tester.view.viewInsets = const FakeViewPadding(bottom: 300);
    await tester.pump();
    await tester.pumpAndSettle();
    expect(controller.position.maxScrollExtent - controller.position.pixels,
        lessThanOrEqualTo(1));

    controller.jumpTo(0);
    await tester.pump();
    expect(controller.position.maxScrollExtent - controller.position.pixels,
        greaterThan(160));
    tester.view.viewInsets = const FakeViewPadding(bottom: 220);
    await tester.pump();
    await tester.pumpAndSettle();
    expect(controller.position.maxScrollExtent - controller.position.pixels,
        greaterThan(160));
    expect(tester.takeException(), isNull);
  });

  testWidgets('rapid Side-chat opens stay single-flight', (tester) async {
    final store = _GatedSideChatOpenStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('side-chat-single-flight', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('open-side-chat')));
    await tester.pump();
    expect(store.createCalls, 1);

    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
    final secondOpen = find.byKey(const Key('open-side-chat'));
    expect(tester.widget<ListTile>(secondOpen).enabled, isFalse);
    await tester.tap(secondOpen);
    await tester.pump();
    expect(store.createCalls, 1);
    await tester.tapAt(const Offset(8, 8));
    await tester.pumpAndSettle();

    store.completeCreate(session.id);
    await tester.pump();
    await tester.pumpAndSettle();
    expect(store.createCalls, 1);
    expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('promotion cannot be dismissed before its result is returned',
      (tester) async {
    final store = _GatedSideChatPromotionStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('side-chat-promote-lock', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    final sideChat =
        store.sessions.firstWhere((item) => item.parentSessionId == session.id);

    await tester.tap(find.byKey(const Key('promote-side-chat')));
    await tester.pump();
    expect(store.promoteCalls, 1);
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('close-side-chat')))
          .onPressed,
      isNull,
    );

    await tester.tapAt(const Offset(8, 8));
    await tester.pump();
    expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);
    await tester.drag(find.text('Side chat'), const Offset(0, 500));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);

    store.completePromotion(sideChat.id);
    await tester.pump();
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('side-chat-composer')), findsNothing);
    expect(store.selectedSession?.id, sideChat.id);
    expect(store.selectedSession?.sessionKind, 'task');
    expect(tester.takeException(), isNull);
  });

  testWidgets('side chat honors Direct audio without invoking transcription',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session(
      'side-chat-direct-audio',
      providerId: 'codex',
      modelId: 'audio-model',
    );
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..modelsByProvider['codex'] = const <RemoteModel>[
        RemoteModel(
          id: 'audio-model',
          providerId: 'codex',
          displayName: 'Audio model',
          isDefault: true,
          inputModalities: <String>['text', 'audio'],
          nativeMetadata: <String, Object?>{},
        ),
      ]
      ..dictationSourcePreferences['codex'] = directAudioDictationSourceId;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () =>
              _SuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    final sideChat =
        store.sessions.firstWhere((item) => item.parentSessionId == session.id);

    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    for (var attempt = 0; attempt < 8; attempt += 1) {
      await tester.pump();
      final microphone = tester
          .widget<IconButton>(find.byKey(const Key('side-chat-dictation')));
      if (microphone.tooltip == 'Stop dictation') break;
    }
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('side-chat-dictation')))
          .tooltip,
      'Stop dictation',
    );
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    for (var attempt = 0;
        attempt < 24 && store.draftAttachmentsFor(sideChat.id).isEmpty;
        attempt += 1) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    if (store.draftAttachmentsFor(sideChat.id).isEmpty) {
      await tester.runAsync(() async {
        final deadline = DateTime.now().add(const Duration(seconds: 2));
        while (store.draftAttachmentsFor(sideChat.id).isEmpty &&
            DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      });
      await tester.pump();
    }

    final attachments = store.draftAttachmentsFor(sideChat.id);
    expect(store.transcriptions, isEmpty);
    expect(attachments, hasLength(1));
    expect(attachments.single.mimeType, 'audio/wav');
    expect(attachments.single.origin, 'dictation');
    expect(find.byKey(const Key('side-chat-attachment-lane')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('composer controls and picker headings respect RTL',
      (tester) async {
    tester.view.physicalSize = const Size(430, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session(
      'composer-rtl',
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    );
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = const <RemoteModel>[
        RemoteModel(
          id: 'gpt-5.6-sol',
          providerId: 'codex',
          displayName: 'GPT-5.6-Sol',
          isDefault: true,
          nativeMetadata: <String, Object?>{
            'supportedReasoningEfforts': <String>['ultra'],
          },
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        builder: (context, child) => Directionality(
          textDirection: TextDirection.rtl,
          child: child!,
        ),
        home: SessionScreen(sessionId: session.id),
      ),
    ));
    await tester.pump();

    final rtlControls = <Rect>[
      tester.getRect(find.byKey(const Key('add-attachment'))),
      tester.getRect(find.byKey(const Key('model-control'))),
      tester.getRect(find.byKey(const Key('dictation-button'))),
      tester.getRect(find.byKey(const Key('session-secondary-controls'))),
      tester.getRect(find.byKey(const Key('send-instruction'))),
    ];
    for (var index = 1; index < rtlControls.length; index += 1) {
      expect(rtlControls[index - 1].left, greaterThan(rtlControls[index].left));
    }

    await tester.tap(find.byKey(const Key('model-control')));
    await tester.pumpAndSettle();
    final modelHeading = tester.widget<Align>(find
        .ancestor(of: find.text('Choose model'), matching: find.byType(Align))
        .first);
    expect(modelHeading.alignment, AlignmentDirectional.centerStart);
    expect(modelHeading.alignment.resolve(TextDirection.rtl),
        Alignment.centerRight);
    Navigator.of(tester.element(find.text('Choose model'))).pop();
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('reasoning-control')));
    await tester.pumpAndSettle();
    final reasoningHeading = tester.widget<Align>(find
        .ancestor(
            of: find.text('Reasoning effort'), matching: find.byType(Align))
        .first);
    expect(reasoningHeading.alignment, AlignmentDirectional.centerStart);
    expect(reasoningHeading.alignment.resolve(TextDirection.rtl),
        Alignment.centerRight);
  });

  testWidgets('Shift+Tab traverses backward without accepting slash completion',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session =
        _session('composer-shift-tab', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    final composer = find.byKey(const Key('session-composer'));
    await tester.tap(composer);
    await tester.enterText(composer, '/');
    await tester.pump();
    final textField = tester.widget<TextField>(composer);
    expect(textField.focusNode!.hasFocus, isTrue);
    final keyHandler = tester
        .widget<Focus>(find.byKey(const Key('session-composer-key-handler')));
    expect(keyHandler.canRequestFocus, isFalse);
    expect(keyHandler.skipTraversal, isTrue);
    expect(keyHandler.includeSemantics, isFalse);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pump();

    expect(textField.controller!.text, '/');
    expect(textField.focusNode!.hasFocus, isFalse);
  });

  testWidgets(
      'cancelling transcription keeps the WAV and ignores stale completion',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('dictation-cancel', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    final recorder = _SuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3]));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.pump();

    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-instruction')));
    await tester.pump();
    expect(store.transcriptions, hasLength(1));
    expect(
        find.byKey(const Key('cancel-dictation-processing')), findsOneWidget);

    await tester.tap(find.byKey(const Key('cancel-dictation-processing')));
    await tester.pump();
    expect(find.byKey(const Key('dictation-retry-status')), findsOneWidget);
    expect(find.byKey(const Key('discard-retained-dictation')), findsOneWidget);

    final retryWhileFirstRequestSettles = tester.widget<IconButton>(
      find.byKey(const Key('dictation-button')),
    );
    expect(retryWhileFirstRequestSettles.onPressed, isNull);
    expect(store.transcriptions, hasLength(1));

    store.transcriptions.first.complete('stale transcript');
    await tester.pump();
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      isEmpty,
    );
    expect(find.byKey(const Key('dictation-retry-status')), findsOneWidget);

    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(store.transcriptions, hasLength(2));
    store.transcriptions[1].complete('fresh transcript');
    await tester.pump();
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      'fresh transcript',
    );
    expect(store.sendCalls, 0,
        reason: 'mic Retry must not inherit the earlier Send intent');
  });

  testWidgets('back during transcription retains audio before leaving',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('dictation-back', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _SuccessfulRecorder(Uint8List.fromList(<int>[4, 5, 6])),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(store.transcriptions, hasLength(1));

    await tester.pageBack();
    await tester.pump();
    await tester.pump();
    expect(find.text('Discard saved recording?'), findsOneWidget);
    expect(find.text('Keep editing'), findsOneWidget);
    await tester.tap(find.text('Keep editing'));
    await tester.pump();
    expect(find.byType(SessionScreen), findsOneWidget);
    expect(find.byKey(const Key('dictation-retry-status')), findsOneWidget);

    store.transcriptions.single.complete('must stay stale');
    await tester.pump();
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      isEmpty,
    );
  });

  testWidgets('an open session reconciles a later restored store draft',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('draft-reconcile', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      isEmpty,
    );

    store.restoreDraftForTest(session.id, 'restored after failed send');
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      'restored after failed send',
    );
  });

  testWidgets('active IME composition cannot submit a partial message',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('ime-submit', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.tap(find.byKey(const Key('session-composer')));
    tester.testTextInput.updateEditingValue(const TextEditingValue(
      text: '你',
      selection: TextSelection.collapsed(offset: 1),
      composing: TextRange(start: 0, end: 1),
    ));
    await tester.pump();
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('send-instruction')))
          .onPressed,
      isNull,
    );

    tester.testTextInput.updateEditingValue(const TextEditingValue(
      text: '你',
      selection: TextSelection.collapsed(offset: 1),
    ));
    await tester.pump();
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('send-instruction')))
          .onPressed,
      isNotNull,
    );
  });

  testWidgets('/mesh activates inside prose without consuming the prompt',
      (tester) async {
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('mesh-prose', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('codex'),
      ]);
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();
    final composer = find.byKey(const Key('session-composer'));

    await tester.enterText(composer, 'https://example.com/mesh ');
    await tester.pump();
    expect(find.text('Delegate with /mesh'), findsNothing);
    expect(
      tester.widget<TextField>(composer).controller!.text,
      'https://example.com/mesh ',
    );

    await tester.enterText(composer, 'Please /mesh investigate this crash');
    await tester.pumpAndSettle();
    expect(find.text('Delegate with /mesh'), findsOneWidget);
    expect(
      tester.widget<TextField>(composer).controller!.text,
      'Please /mesh investigate this crash',
    );
    expect(store.drafts[session.id], 'Please /mesh investigate this crash');
    Navigator.of(tester.element(find.text('Delegate with /mesh'))).pop();
    await tester.pumpAndSettle();
    expect(
      tester.widget<TextField>(composer).controller!.text,
      'Please /mesh investigate this crash',
      reason: 'cancelling target selection must not consume the command',
    );
  });

  for (final providerId in <String>['opencode', 'codex', 'grok', 'future-harness']) {
    testWidgets('Mesh can select its own $providerId provider', (tester) async {
      final store = _MeshFeatureStore()
        ..connectionState = BridgeConnectionState.online;
      final session = _session('mesh-own-$providerId', providerId: providerId);
      store
        ..sessions.add(session)
        ..providers.add(_provider(providerId));
      addTearDown(store.dispose);
      await tester.pumpWidget(StoreScope(
        store: store,
        child: MaterialApp(home: SessionScreen(sessionId: session.id)),
      ));
      await tester.pump();
      final composer = find.byKey(const Key('session-composer'));
      await tester.enterText(composer, 'Ask /mesh to review this');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(ValueKey<String>('mesh-provider-$providerId')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('send-instruction')));
      await tester.pump();
      expect(store.startedDelegationTargets, hasLength(1));
      expect(store.startedDelegationTargets!.single.providerId, providerId);
      expect(store.startedDelegationPrompt, 'Ask to review this');
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Android slash-command Enter does not trail the Mesh chip',
      (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final store = _MeshFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session =
        _session('mesh-android-enter', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode'),
      ]);
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();
    final composer = find.byKey(const Key('session-composer'));
    await tester.enterText(composer, '/mesh');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(find.text('Delegate with /mesh'), findsOneWidget);

    tester.testTextInput.updateEditingValue(const TextEditingValue(
      text: '/mesh\n',
      selection: TextSelection.collapsed(offset: 6),
    ));
    await tester.pump();
    expect(tester.widget<TextField>(composer).controller!.text, '/mesh');

    await tester
        .tap(find.byKey(const ValueKey<String>('mesh-provider-opencode')));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(composer).controller!.text, '\uFFFC');
    expect(store.drafts[session.id], '\uFFFC');

    tester.testTextInput.updateEditingValue(const TextEditingValue(
      text: '\uFFFC\nFollow up',
      selection: TextSelection.collapsed(offset: 11),
    ));
    await tester.pump();
    expect(
      tester.widget<TextField>(composer).controller!.text,
      '\uFFFC\nFollow up',
      reason: 'only the newline paired with slash-command Enter is consumed',
    );
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('Android IME newline is consumed when it accepts /mesh',
      (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final store = _MeshFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session =
        _session('mesh-android-ime-enter', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode'),
      ]);
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();
    final composer = find.byKey(const Key('session-composer'));
    await tester.enterText(composer, '/mesh');
    tester.testTextInput.updateEditingValue(const TextEditingValue(
      text: '/mesh\n',
      selection: TextSelection.collapsed(offset: 6),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Delegate with /mesh'), findsOneWidget);

    await tester
        .tap(find.byKey(const ValueKey<String>('mesh-provider-opencode')));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(composer).controller!.text, '\uFFFC');
    expect(store.drafts[session.id], '\uFFFC');

    tester.testTextInput.updateEditingValue(const TextEditingValue(
      text: '\uFFFC\nFollow up',
      selection: TextSelection.collapsed(offset: 11),
    ));
    await tester.pump();
    expect(
      tester.widget<TextField>(composer).controller!.text,
      '\uFFFC\nFollow up',
      reason: 'the IME acceptance repair must not consume later newlines',
    );
    debugDefaultTargetPlatformOverride = null;
  });

  testWidgets('inline Mesh target keeps its text anchor through Shift+Enter',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _MeshFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session =
        _session('mesh-inline-newline', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode', modelEnumeration: true),
      ])
      ..modelsByProvider['opencode'] = const <RemoteModel>[
        RemoteModel(
          id: 'deepseek-v4-flash-vision-exp',
          providerId: 'opencode',
          displayName: 'DeepSeek V4 Flash Vision Exp',
          isDefault: true,
          nativeMetadata: <String, Object?>{
            'supportedReasoningEfforts': <String>['max'],
            'defaultReasoningEffort': 'max',
          },
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();
    final composer = find.byKey(const Key('session-composer'));
    await tester.enterText(
      composer,
      '/mesh you do a search about image generation',
    );
    await tester.pumpAndSettle();
    await tester
        .tap(find.byKey(const ValueKey<String>('mesh-provider-opencode')));
    await tester.pumpAndSettle();

    final target = find.byKey(const ValueKey<String>('mesh-target-opencode'));
    expect(target, findsOneWidget);
    expect(find.byKey(const Key('mesh-composer-panel')), findsNothing);
    expect(
      find.descendant(of: composer, matching: target),
      findsOneWidget,
    );
    final field = tester.widget<TextField>(composer);
    final anchored = field.controller!.text;
    expect(
      anchored,
      '\uFFFCyou do a search about image generation',
    );
    final editableFinder =
        find.descendant(of: composer, matching: find.byType(EditableText));
    RenderEditable editable =
        tester.state<EditableTextState>(editableFinder).renderEditable;
    expect(
      editable.text!.toPlainText(includeSemanticsLabels: false),
      anchored,
    );
    final beforeTargetOffset =
        editable.globalToLocal(tester.getTopLeft(target));

    field.controller!.selection =
        TextSelection.collapsed(offset: anchored.length);
    await tester.tap(composer);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    tester.testTextInput.updateEditingValue(TextEditingValue(
      text: '$anchored\nSecond line',
      selection: TextSelection.collapsed(
        offset: anchored.length + '\nSecond line'.length,
      ),
    ));
    await tester.pump();

    editable = tester.state<EditableTextState>(editableFinder).renderEditable;
    final paintedText =
        editable.text!.toPlainText(includeSemanticsLabels: false);
    expect(paintedText, '$anchored\nSecond line');
    final markerOffset = paintedText.indexOf('\uFFFC');
    expect(markerOffset, 0);
    final targetOffset = editable.globalToLocal(tester.getTopLeft(target));
    expect(targetOffset.dx, closeTo(beforeTargetOffset.dx, 1));
    expect(targetOffset.dy, closeTo(beforeTargetOffset.dy, 1));
    final markerSlot = editable.getRectForComposingRange(
      TextRange(start: markerOffset, end: markerOffset + 1),
    );
    expect(markerSlot, isNotNull);
    expect(markerSlot!.left, closeTo(targetOffset.dx - 2, 3));
    final caret = editable.getLocalRectForCaret(
      TextPosition(offset: paintedText.length),
    );
    expect(caret.top, greaterThan(markerSlot.top));
    expect(tester.takeException(), isNull);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(
      store.startedDelegationPrompt,
      'you do a search about image generation\nSecond line',
    );
    expect(store.startedDelegationPrompt, isNot(contains('\uFFFC')));
    expect(store.startedDelegationPrompt, isNot(contains('/mesh')));
    expect(store.startedDelegationTargets, hasLength(1));
  });

  testWidgets(
      'sending Mesh immediately paints one clean parent bubble with the inline chip',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final gate = Completer<void>();
    addTearDown(() {
      if (!gate.isCompleted) gate.complete();
    });
    final store = _MeshFeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..delegationGate = gate;
    final session = _session('mesh-sent-bubble', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode', modelEnumeration: true),
      ])
      ..modelsByProvider['opencode'] = const <RemoteModel>[
        RemoteModel(
          id: 'deepseek-v4-flash-vision-exp',
          providerId: 'opencode',
          displayName: 'DeepSeek V4 Flash Vision Exp',
          isDefault: true,
          nativeMetadata: <String, Object?>{},
        ),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();
    final composer = find.byKey(const Key('session-composer'));
    await tester.enterText(
        composer, 'Ask /mesh to research this\nThen compare the result');
    await tester.pumpAndSettle();
    await tester
        .tap(find.byKey(const ValueKey<String>('mesh-provider-opencode')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('send-instruction')));
    await tester.pump();

    expect(tester.widget<TextField>(composer).controller!.text, isEmpty);
    expect(store.delegations, contains('prepared-mesh'));
    final message = find.byKey(const ValueKey<String>(
        'mesh-message-mesh-presentation-prepared-mesh-0'));
    expect(message, findsOneWidget);
    expect(
      find.byKey(const ValueKey<String>(
          'sent-mesh-target-mesh-presentation-prepared-mesh-0')),
      findsOneWidget,
    );
    final painted = tester
        .widgetList<RichText>(
            find.descendant(of: message, matching: find.byType(RichText)))
        .map((widget) => widget.text.toPlainText(includeSemanticsLabels: false))
        .toList(growable: false);
    expect(
      painted,
      contains('Ask \uFFFCto research this\nThen compare the result'),
    );
    expect(find.textContaining('providerId'), findsNothing);
    expect(find.textContaining('UAR_MESH'), findsNothing);
    expect(find.textContaining('Sent by Tethoq'), findsNothing);

    gate.complete();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  });

  testWidgets(
      'identical Mesh prompts keep their exact parent chips and hide provenance',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session =
        _session('mesh-identical-parents', providerId: 'future-harness');
    final firstTurnAt = DateTime.utc(2026, 9, 3, 10);
    final secondTurnAt = DateTime.utc(2026, 9, 3, 10, 1);
    RemoteMessage parentTurn(String id, DateTime createdAt) => RemoteMessage(
          id: id,
          sessionId: session.id,
          role: 'user',
          createdAt: createdAt,
          status: 'completed',
          parts: <ContentPart>[
            ContentPart(
              type: 'text',
              data: const <String, Object?>{'text': 'Repeat this request'},
            ),
          ],
          origin: const RemoteMessageOrigin(
            kind: 'cross_session',
            sourceSessionId: 'another-task',
            sourceTitle: 'Another task',
          ),
        );
    RemoteDelegationTask meshTask({
      required String id,
      required String parentTurnId,
      required String modelId,
      required DateTime createdAt,
    }) =>
        RemoteDelegationTask(
          id: id,
          parentSessionId: session.id,
          parentTurnId: parentTurnId,
          prompt: 'Repeat this request',
          state: 'running',
          createdAt: createdAt,
          updatedAt: createdAt,
          children: const <RemoteDelegationChild>[],
          targets: <DelegationSelection>[
            DelegationSelection(providerId: 'opencode', modelId: modelId),
          ],
          presentationSegments: <RemoteMeshPresentationSegment>[
            RemoteMeshPresentationSegment.mesh(0),
            RemoteMeshPresentationSegment.text('Repeat this request'),
          ],
          orchestration: 'parent',
        );
    store
      ..sessions.add(session)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode', modelEnumeration: true),
      ])
      ..modelsByProvider['opencode'] = <RemoteModel>[
        _model('opencode', 'first-model', 'First Mesh model'),
        _model('opencode', 'second-model', 'Second Mesh model'),
      ]
      ..messages[session.id] = <RemoteMessage>[
        parentTurn('turn-one', firstTurnAt),
        parentTurn('turn-two', secondTurnAt),
      ]
      // Reverse task order to prove identity, rather than prompt/time order,
      // owns each inline target.
      ..delegations['mesh-two'] = meshTask(
        id: 'mesh-two',
        parentTurnId: 'turn-two',
        modelId: 'second-model',
        createdAt: secondTurnAt,
      )
      ..delegations['mesh-one'] = meshTask(
        id: 'mesh-one',
        parentTurnId: 'turn-one',
        modelId: 'first-model',
        createdAt: firstTurnAt,
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: session.id)),
    ));
    await tester.pump();

    final firstChip = find.byKey(const ValueKey<String>(
        'sent-mesh-target-mesh-presentation-mesh-one-0'));
    final secondChip = find.byKey(const ValueKey<String>(
        'sent-mesh-target-mesh-presentation-mesh-two-0'));
    expect(firstChip, findsOneWidget);
    expect(secondChip, findsOneWidget);
    expect(
        find.descendant(of: firstChip, matching: find.text('First Mesh model')),
        findsOneWidget);
    expect(
        find.descendant(
            of: firstChip, matching: find.text('Second Mesh model')),
        findsNothing);
    expect(
        find.descendant(
            of: secondChip, matching: find.text('Second Mesh model')),
        findsOneWidget);
    expect(
        find.descendant(
            of: secondChip, matching: find.text('First Mesh model')),
        findsNothing);
    expect(find.textContaining('From another Tethoq task'), findsNothing);
    expect(
      find.byKey(
          const ValueKey<String>('message-origin-mesh-presentation-mesh-one')),
      findsNothing,
    );
    expect(
      find.byKey(
          const ValueKey<String>('message-origin-mesh-presentation-mesh-two')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'materialized Mesh children render once as compact chronological top-level rows',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _DelegationNavigationFeatureStore(populateOnCall: 99)
      ..connectionState = BridgeConnectionState.online;
    final parent =
        _session('mesh-timeline-parent', providerId: 'future-harness');
    final beforeAt = DateTime.utc(2026, 9, 3, 10);
    final spawnedAt = DateTime.utc(2026, 9, 3, 10, 1);
    final afterAt = DateTime.utc(2026, 9, 3, 10, 2);
    RemoteMessage message(String id, String role, String text, DateTime at) =>
        RemoteMessage(
          id: id,
          sessionId: parent.id,
          role: role,
          createdAt: at,
          status: 'completed',
          parts: <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{'text': text}),
          ],
        );
    store
      ..sessions.add(parent)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode', modelEnumeration: true),
      ])
      ..modelsByProvider['opencode'] = <RemoteModel>[
        _model('opencode', 'deepseek-v4-flash', 'DeepSeek V4 Flash'),
        _model('opencode', 'deepseek-v4-pro', 'DeepSeek V4 Pro'),
      ]
      ..messages[parent.id] = <RemoteMessage>[
        message('before-spawn', 'user', 'Before delegation', beforeAt),
        message('after-spawn', 'assistant', 'After delegation', afterAt),
      ]
      ..delegations['mesh-timeline'] = _delegationTask(
        'mesh-timeline',
        parentSessionId: parent.id,
        createdAt: spawnedAt,
        children: const <RemoteDelegationChild>[
          RemoteDelegationChild(
            id: 'child-running',
            sessionId: 'session-running',
            providerId: 'opencode',
            modelId: 'deepseek-v4-flash',
            reasoningEffort: 'high',
            state: 'working',
          ),
          RemoteDelegationChild(
            id: 'child-finished',
            sessionId: 'session-finished',
            providerId: 'opencode',
            modelId: 'deepseek-v4-pro',
            reasoningEffort: 'max',
            state: 'completed',
          ),
          RemoteDelegationChild(
            id: 'child-not-materialized',
            providerId: 'opencode',
            modelId: 'deepseek-v4-pro',
            state: 'spawning',
          ),
        ],
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: parent.id)),
    ));
    await tester.pump();
    await tester.pump();

    final runningRow = find.byKey(const ValueKey<String>(
        'spawned-subagent-mesh-timeline:child:child-running'));
    final finishedRow = find.byKey(const ValueKey<String>(
        'spawned-subagent-mesh-timeline:child:child-finished'));
    expect(runningRow, findsOneWidget);
    expect(finishedRow, findsOneWidget);
    expect(find.text('Spawned sub-agent'), findsNWidgets(2));
    expect(
      find.byKey(const ValueKey<String>(
          'spawned-subagent-mesh-timeline:child:child-not-materialized')),
      findsNothing,
    );
    expect(find.byKey(const ValueKey<String>('delegation-task-mesh-timeline')),
        findsNothing);
    expect(find.ancestor(of: runningRow, matching: find.byType(ExpansionTile)),
        findsNothing);
    expect(tester.getSize(runningRow).height, greaterThanOrEqualTo(48));
    expect(
      tester.getTopLeft(find.text('Before delegation')).dy,
      lessThan(tester.getTopLeft(runningRow).dy),
    );
    expect(
      tester.getTopLeft(finishedRow).dy,
      lessThan(tester.getTopLeft(find.text('After delegation')).dy),
    );
    expect(
      find.descendant(
        of: runningRow,
        matching: find.text('OpenCode · DeepSeek V4 Flash · High'),
      ),
      findsOneWidget,
    );
    expect(find.descendant(of: runningRow, matching: find.text('Running')),
        findsOneWidget);
    expect(find.descendant(of: finishedRow, matching: find.text('Finished')),
        findsOneWidget);
    expect(
      find.descendant(
        of: finishedRow,
        matching: find.byKey(const ValueKey<String>(
            'spawned-subagent-spinner-session-finished')),
      ),
      findsNothing,
    );
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  testWidgets(
      'Mesh child lifecycle updates replace the running row and retire its spinner',
      (tester) async {
    tester.view.physicalSize = const Size(430, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _DelegationNavigationFeatureStore(populateOnCall: 99)
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('mesh-state-parent', providerId: 'future-harness');
    final createdAt = DateTime.utc(2026, 9, 3, 11);
    RemoteDelegationTask task(String state, String childState) =>
        _delegationTask(
          'mesh-state',
          parentSessionId: parent.id,
          createdAt: createdAt,
          state: state,
          children: <RemoteDelegationChild>[
            RemoteDelegationChild(
              id: 'state-child',
              sessionId: 'state-child-session',
              providerId: 'opencode',
              modelId: 'deepseek-v4-pro',
              reasoningEffort: 'max',
              state: childState,
            ),
          ],
        );
    store
      ..sessions.add(parent)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode'),
      ])
      ..delegations['mesh-state'] = task('working', 'working');
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: parent.id)),
    ));
    await tester.pump();

    final row = find.byKey(const ValueKey<String>(
        'spawned-subagent-mesh-state:child:state-child'));
    final spinner = find.byKey(
        const ValueKey<String>('spawned-subagent-spinner-state-child-session'));
    expect(row, findsOneWidget);
    expect(spinner, findsOneWidget);
    expect(find.descendant(of: row, matching: find.text('Running')),
        findsOneWidget);

    store.delegations['mesh-state'] = task('completed', 'completed');
    store.notifyListeners();
    await tester.pump();

    expect(row, findsOneWidget);
    expect(spinner, findsNothing);
    expect(
      find.byKey(const ValueKey<String>(
          'spawned-subagent-terminal-state-child-session')),
      findsOneWidget,
    );
    expect(find.descendant(of: row, matching: find.text('Finished')),
        findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });

  testWidgets('Mesh child row opens the cached exact child without reloading',
      (tester) async {
    final store = _DelegationNavigationFeatureStore(populateOnCall: 99)
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('mesh-cached-parent', providerId: 'future-harness');
    final exact = _session(
      'mesh-cached-exact',
      providerId: 'opencode',
      parentSessionId: parent.id,
    );
    final decoy = _session(
      'mesh-cached-decoy',
      providerId: 'opencode',
      parentSessionId: parent.id,
    );
    store
      ..sessions.addAll(<RemoteSession>[parent, decoy, exact])
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode'),
      ])
      ..delegations['mesh-cached'] = _delegationTask(
        'mesh-cached',
        parentSessionId: parent.id,
        createdAt: DateTime.utc(2026, 9, 3, 12),
        state: 'completed',
        children: const <RemoteDelegationChild>[
          RemoteDelegationChild(
            id: 'cached-child',
            sessionId: 'mesh-cached-exact',
            providerId: 'opencode',
            state: 'completed',
          ),
        ],
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: parent.id)),
    ));
    await tester.pump();
    final loadCallsBeforeTap = store.childLoadCalls;

    await tester.tap(find.byKey(const ValueKey<String>(
        'spawned-subagent-mesh-cached:child:cached-child')));
    await tester.pumpAndSettle();

    expect(store.childLoadCalls, loadCallsBeforeTap);
    expect(store.selectedSession?.id, exact.id);
    expect(store.selectedSession?.id, isNot(decoy.id));
    expect(find.text('Feature session ${exact.id}'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pageBack();
    await tester.pumpAndSettle();
  });

  testWidgets(
      'Mesh child row loads missing children then opens only its exact session',
      (tester) async {
    final parent = _session('mesh-load-parent', providerId: 'future-harness');
    final exact = _session(
      'mesh-loaded-exact',
      providerId: 'opencode',
      parentSessionId: parent.id,
    );
    final decoy = _session(
      'mesh-loaded-decoy',
      providerId: 'opencode',
      parentSessionId: parent.id,
    );
    final store = _DelegationNavigationFeatureStore(
      loadedChildren: <RemoteSession>[decoy, exact],
      populateOnCall: 2,
    )..connectionState = BridgeConnectionState.online;
    store
      ..sessions.add(parent)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode'),
      ])
      ..delegations['mesh-load'] = _delegationTask(
        'mesh-load',
        parentSessionId: parent.id,
        createdAt: DateTime.utc(2026, 9, 3, 13),
        state: 'completed',
        children: const <RemoteDelegationChild>[
          RemoteDelegationChild(
            id: 'loaded-child',
            sessionId: 'mesh-loaded-exact',
            providerId: 'opencode',
            state: 'completed',
          ),
        ],
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: parent.id)),
    ));
    await tester.pump();
    expect(store.childLoadCalls, 1,
        reason: 'The normal materialization refresh runs once on open.');

    await tester.tap(find.byKey(const ValueKey<String>(
        'spawned-subagent-mesh-load:child:loaded-child')));
    await tester.pumpAndSettle();

    expect(store.childLoadCalls, 2);
    expect(store.selectedSession?.id, exact.id);
    expect(store.selectedSession?.id, isNot(decoy.id));
    expect(find.text('Feature session ${exact.id}'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.pageBack();
    await tester.pumpAndSettle();
  });

  testWidgets('inline Mesh target reflows safely on narrow scaled phones',
      (tester) async {
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _MeshFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('mesh-inline-scale', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.addAll(<ProviderConnection>[
        _provider('future-harness'),
        _provider('opencode', modelEnumeration: true),
      ])
      ..modelsByProvider['opencode'] = <RemoteModel>[
        _model(
          'opencode',
          'deepseek-v4-flash-vision-exp',
          'DeepSeek V4 Flash Vision Exp',
          isDefault: true,
        ),
      ]
      ..setDraft(session.id, 'prefix \uFFFCsuffix')
      ..setDraftDelegationSelections(
        session.id,
        const <DelegationSelection>[
          DelegationSelection(
            providerId: 'opencode',
            modelId: 'deepseek-v4-flash-vision-exp',
          ),
        ],
      );
    addTearDown(store.dispose);

    for (final scenario in <(double, double)>[
      (320, 1.5),
      (280, 1.5),
      (240, 2),
    ]) {
      final (width, scale) = scenario;
      tester.view.physicalSize = Size(width, 720);
      await tester.pumpWidget(StoreScope(
        store: store,
        child: MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: SessionScreen(sessionId: session.id),
        ),
      ));
      await tester.pumpAndSettle();

      final composer = find.byKey(const Key('session-composer'));
      final target = find.byKey(const ValueKey<String>('mesh-target-opencode'));
      expect(target, findsOneWidget, reason: '$width px at ${scale}x');
      expect(find.byKey(const Key('mesh-composer-panel')), findsNothing);
      final editableFinder =
          find.descendant(of: composer, matching: find.byType(EditableText));
      final editable =
          tester.state<EditableTextState>(editableFinder).renderEditable;
      final plain = editable.text!.toPlainText(includeSemanticsLabels: false);
      expect(plain, 'prefix \uFFFCsuffix');
      final markerOffset = plain.indexOf('\uFFFC');
      final markerSlot = editable.getRectForComposingRange(
        TextRange(start: markerOffset, end: markerOffset + 1),
      );
      expect(markerSlot, isNotNull, reason: '$width px at ${scale}x');
      final editableRect = editable.localToGlobal(Offset.zero) & editable.size;
      final targetRect = tester.getRect(target);
      expect(targetRect.left, greaterThanOrEqualTo(editableRect.left - 1));
      expect(targetRect.right, lessThanOrEqualTo(editableRect.right + 1));
      expect(tester.takeException(), isNull, reason: '$width px at ${scale}x');
    }

    await tester.enterText(
      find.byKey(const Key('session-composer')),
      'prefix suffix',
    );
    await tester.pump();
    expect(
      find.byKey(const ValueKey<String>('mesh-target-opencode')),
      findsNothing,
    );
    expect(store.draftDelegationSelectionsFor(session.id), isEmpty);
    expect(store.drafts[session.id], 'prefix suffix');
  });

  testWidgets(
      '/mesh selections survive process recreation and prune stale choices',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    const sessionId = 'mesh-durable';
    final session = _session(sessionId, providerId: 'future-harness');
    const codexA = RemoteModel(
      id: 'codex-a',
      providerId: 'codex',
      displayName: 'Codex A',
      isDefault: true,
      nativeMetadata: <String, Object?>{
        'supportedReasoningEfforts': <String>['low', 'high'],
        'defaultReasoningEffort': 'low',
      },
    );
    const codexB = RemoteModel(
      id: 'codex-b',
      providerId: 'codex',
      displayName: 'Codex B',
      isDefault: false,
      nativeMetadata: <String, Object?>{
        'supportedReasoningEfforts': <String>['low', 'high'],
        'defaultReasoningEffort': 'low',
      },
    );
    const opencodeModel = RemoteModel(
      id: 'op-live',
      providerId: 'opencode',
      displayName: 'Open Live',
      isDefault: true,
      nativeMetadata: <String, Object?>{
        'supportedReasoningEfforts': <String>['low', 'medium'],
        'defaultReasoningEffort': 'medium',
      },
    );
    const offlineGrok = ProviderConnection(
      providerId: 'grok',
      displayName: 'grok',
      state: 'offline',
      detected: true,
      authenticated: true,
    );

    void configureStore(_MeshFeatureStore store) {
      store
        ..connectionState = BridgeConnectionState.online
        ..sessions.add(session)
        ..providers.addAll(<ProviderConnection>[
          _provider('future-harness'),
          _provider('codex', modelEnumeration: true),
          _provider('direct', modelEnumeration: true),
          _provider('opencode', modelEnumeration: true),
          _provider('claude', modelEnumeration: true),
          _provider('qwen', modelEnumeration: true),
          offlineGrok,
        ])
        ..modelsByProvider['codex'] = const <RemoteModel>[codexA, codexB]
        ..modelsByProvider['direct'] = <RemoteModel>[
          _model('direct', 'direct-live', 'Direct Live', isDefault: true),
        ]
        ..modelsByProvider['opencode'] = const <RemoteModel>[opencodeModel]
        ..modelsByProvider['claude'] = const <RemoteModel>[]
        ..modelsByProvider['qwen'] = <RemoteModel>[
          _model('qwen', 'qwen-live', 'Qwen Live', isDefault: true),
        ];
    }

    final firstStore = _MeshFeatureStore();
    configureStore(firstStore);
    await tester.pumpWidget(StoreScope(
      store: firstStore,
      child: MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('session-composer')),
        'Please /mesh investigate this crash');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('mesh-provider-codex')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('mesh-target-codex')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('mesh-model-codex-b')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey<String>('mesh-effort-high')));
    await tester.pumpAndSettle();
    final composer = find.byKey(const Key('session-composer'));
    final firstAnchoredDraft =
        tester.widget<TextField>(composer).controller!.text;
    expect(firstAnchoredDraft, contains('\uFFFC'));
    expect(find.byKey(const Key('mesh-composer-panel')), findsNothing);
    expect(
      find.descendant(
        of: find.byType(EditableText),
        matching: find.byKey(const ValueKey<String>('mesh-target-codex')),
      ),
      findsOneWidget,
    );
    await tester.enterText(composer, '$firstAnchoredDraft /mesh ');
    await tester.pumpAndSettle();
    await tester
        .tap(find.byKey(const ValueKey<String>('mesh-provider-direct')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey<String>('mesh-target-direct')),
        findsOneWidget);
    await tester.tap(find.byKey(const ValueKey<String>('mesh-remove-direct')));
    await tester.pumpAndSettle();
    expect(
        find.byKey(const ValueKey<String>('mesh-target-direct')), findsNothing);
    expect(
      '\uFFFC'.allMatches(
        tester.widget<TextField>(composer).controller!.text,
      ),
      hasLength(1),
    );

    final selected = firstStore.draftDelegationSelectionsFor(sessionId);
    expect(selected, hasLength(1));
    expect(selected.single.providerId, 'codex');
    expect(selected.single.modelId, 'codex-b');
    expect(selected.single.reasoningEffort, 'high');
    final restoredPrompt = firstStore.drafts[sessionId]!;

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    expect(firstStore.draftDelegationSelectionsFor(sessionId), selected);
    firstStore.dispose();

    final restoredStore = _MeshFeatureStore();
    configureStore(restoredStore);
    restoredStore
      ..setDraft(sessionId, restoredPrompt)
      ..injectedDraftDelegationSelections = <DelegationSelection>[
        selected.single,
        const DelegationSelection(
          providerId: 'codex',
          modelId: 'codex-a',
          reasoningEffort: 'low',
        ),
        const DelegationSelection(providerId: 'unavailable-harness'),
        const DelegationSelection(providerId: 'grok'),
        const DelegationSelection(
          providerId: 'direct',
          modelId: 'removed-direct-model',
          reasoningEffort: 'ultra',
        ),
        const DelegationSelection(
          providerId: 'opencode',
          modelId: 'op-live',
          reasoningEffort: 'ultra',
        ),
        const DelegationSelection(
          providerId: 'claude',
          modelId: 'removed-claude-model',
          reasoningEffort: 'high',
        ),
        const DelegationSelection(
          providerId: 'qwen',
          modelId: 'qwen-live',
          reasoningEffort: 'low',
        ),
      ];
    addTearDown(restoredStore.dispose);

    await tester.pumpWidget(StoreScope(
      store: restoredStore,
      child: MaterialApp(home: SessionScreen(sessionId: sessionId)),
    ));
    await tester.pumpAndSettle();

    final expectedProviders = <String>['codex', 'direct', 'opencode', 'claude'];
    final targetFinders = expectedProviders
        .map((providerId) =>
            find.byKey(ValueKey<String>('mesh-target-$providerId')))
        .toList(growable: false);
    for (final target in targetFinders) {
      expect(target, findsOneWidget);
    }
    expect(find.byKey(const ValueKey<String>('mesh-target-unavailable-harness')),
        findsNothing);
    expect(
        find.byKey(const ValueKey<String>('mesh-target-grok')), findsNothing);
    expect(
        find.byKey(const ValueKey<String>('mesh-target-qwen')), findsNothing);
    expect(find.byKey(const Key('mesh-composer-panel')), findsNothing);
    for (final target in targetFinders) {
      expect(
        find.descendant(of: find.byType(EditableText), matching: target),
        findsOneWidget,
      );
    }
    expect(
        find.descendant(
          of: targetFinders[0],
          matching: find.textContaining('Codex B'),
        ),
        findsOneWidget);
    expect(
        find.descendant(
          of: targetFinders[0],
          matching: find.textContaining('High'),
        ),
        findsOneWidget);
    expect(
        find.descendant(
          of: targetFinders[1],
          matching: find.textContaining('Direct'),
        ),
        findsOneWidget);
    expect(
        find.descendant(
          of: targetFinders[2],
          matching: find.textContaining('Medium'),
        ),
        findsOneWidget);

    final normalized = restoredStore.draftDelegationSelectionsFor(sessionId);
    expect(normalized.map((target) => target.providerId), expectedProviders);
    expect(normalized[0].modelId, 'codex-b');
    expect(normalized[0].reasoningEffort, 'high');
    expect(normalized[1].modelId, isNull);
    expect(normalized[1].reasoningEffort, isNull);
    expect(normalized[2].modelId, 'op-live');
    expect(normalized[2].reasoningEffort, 'medium');
    expect(normalized[3].modelId, isNull);
    expect(normalized[3].reasoningEffort, isNull);
    final reconciledPrompt = tester
        .widget<TextField>(find.byKey(const Key('session-composer')))
        .controller!
        .text;
    expect('\uFFFC'.allMatches(reconciledPrompt), hasLength(4));

    restoredStore.delegationFailure = StateError('mesh start failed');
    await tester.tap(find.byKey(const Key('send-instruction')));
    await tester.pumpAndSettle();
    expect(restoredStore.startedDelegationTargets, isNotNull);
    expect(
        restoredStore
            .draftDelegationSelectionsFor(sessionId)
            .map((target) => target.toJson()),
        normalized.map((target) => target.toJson()));
    for (final target in targetFinders) {
      expect(target, findsOneWidget);
    }

    restoredStore.startedDelegationPrompt = null;
    restoredStore.startedDelegationTargets = null;
    final send = find.byKey(const Key('send-instruction'));
    for (var attempt = 0;
        attempt < 8 && tester.widget<IconButton>(send).onPressed == null;
        attempt += 1) {
      await tester.pump();
    }
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      reconciledPrompt,
    );
    final retrySend = tester.widget<IconButton>(send).onPressed;
    expect(retrySend, isNotNull);
    retrySend!();
    for (var attempt = 0;
        attempt < 8 && restoredStore.startedDelegationTargets == null;
        attempt += 1) {
      await tester.pump();
    }
    expect(
      restoredStore.startedDelegationPrompt,
      reconciledPrompt.replaceAll('\uFFFC', '').trim(),
    );
    expect(restoredStore.startedDelegationRawDraft, reconciledPrompt);
    expect(
      restoredStore.startedDelegationTargets!
          .map((target) => target.toJson())
          .toList(growable: false),
      normalized.map((target) => target.toJson()).toList(growable: false),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'sub-agent access lives in the app bar without hiding its icon behind the count',
      (tester) async {
    final semantics = tester.ensureSemantics();
    tester.view.physicalSize = const Size(320, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('agents-parent', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();

    for (final childCount in <int>[1, 9, 10, 999]) {
      store.sessions
        ..removeWhere((session) => session.parentSessionId == source.id)
        ..addAll(List<RemoteSession>.generate(
          childCount,
          (index) => _session(
            'agents-child-$index',
            providerId: 'future-harness',
            parentSessionId: source.id,
          ),
        ));
      store.notifyListeners();
      await tester.pump();

      final button = find.byKey(const Key('child-agents-button'));
      final icon = find.byKey(const Key('child-agents-icon'));
      final count = find.byKey(const Key('child-agents-count'));
      final tooltip = find.ancestor(of: button, matching: find.byType(Tooltip));
      expect(button, findsOneWidget, reason: '$childCount children');
      expect(button.hitTestable(), findsOneWidget,
          reason: '$childCount children');
      expect(find.ancestor(of: button, matching: find.byType(AppBar)),
          findsOneWidget,
          reason: '$childCount children');
      expect(icon, findsOneWidget, reason: '$childCount children');
      expect(count, findsOneWidget, reason: '$childCount children');
      expect(tester.widget<Text>(count).data, '$childCount');
      expect(
        tester.getRect(count).left - tester.getRect(icon).right,
        greaterThanOrEqualTo(3),
        reason: '$childCount children keep the identity and count separate',
      );
      final buttonSize = tester.getSize(button);
      expect(buttonSize.width, greaterThanOrEqualTo(44));
      expect(buttonSize.height, greaterThanOrEqualTo(44));
      final buttonRect = tester.getRect(button);
      expect(buttonRect.left, greaterThanOrEqualTo(0));
      expect(buttonRect.right, lessThanOrEqualTo(320));
      final semanticsData = tester.getSemantics(button).getSemanticsData();
      expect(semanticsData.flagsCollection.isButton, isTrue);
      expect(semanticsData.hasAction(SemanticsAction.tap), isTrue);
      expect(semanticsData.label, contains('$childCount'));
      expect(
        tester.widget<Tooltip>(tooltip).message,
        childCount == 1 ? 'View 1 sub-agent' : 'View $childCount sub-agents',
      );
      expect(tester.takeException(), isNull, reason: '$childCount children');
    }

    await tester.tap(find.byKey(const Key('child-agents-button')));
    await tester.pumpAndSettle();
    expect(find.text('Agents'), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    semantics.dispose();
  });

  testWidgets('session owns the Android IME inset exactly once',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 1600);
    tester.view.devicePixelRatio = 2.625;
    tester.view.viewPadding = const FakeViewPadding(top: 91);
    tester.view.padding = const FakeViewPadding(top: 91);
    tester.view.viewInsets = const FakeViewPadding(bottom: 872);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetViewInsets);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('edge-to-edge-ime', providerId: 'future-harness');
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

    final scaffold = tester.widget<Scaffold>(find.byType(Scaffold));
    expect(scaffold.resizeToAvoidBottomInset, isFalse,
        reason: 'SessionScreen must not share IME ownership with Scaffold.');
    final insetOwner = tester.widget<Padding>(
      find.byKey(const Key('session-ime-inset-owner')),
    );
    final logicalInset = 872 / 2.625;
    expect(
      insetOwner.padding.resolve(TextDirection.ltr).bottom,
      closeTo(logicalInset, .01),
    );
    final keyboardTop = (1600 - 872) / 2.625;
    final actions =
        tester.getRect(find.byKey(const Key('session-composer-actions')));
    expect(actions.height, closeTo(52, .01));
    expect(actions.bottom, lessThanOrEqualTo(keyboardTop + 1));
    expect(actions.bottom, greaterThanOrEqualTo(keyboardTop - 24),
        reason: 'The IME inset must be consumed once, not twice.');
    expect(tester.takeException(), isNull);
  });

  testWidgets('landscape keyboard transitions keep the composer usable',
      (tester) async {
    tester.view.physicalSize = const Size(900, 430);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewInsets);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('landscape-ime', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        builder: (context, child) => MediaQuery(
          data:
              MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(2)),
          child: child!,
        ),
        home: SessionScreen(sessionId: source.id),
      ),
    ));
    await tester.enterText(
      find.byKey(const Key('session-composer')),
      'The draft stays visible above the landscape keyboard.',
    );
    for (final inset in <double>[0, 80, 180, 280, 80, 0]) {
      tester.view.viewInsets = FakeViewPadding(bottom: inset);
      await tester.pump();
      await tester.pump();

      final reason = 'keyboard inset ${inset.toInt()}';
      final composer =
          tester.getRect(find.byKey(const Key('session-composer')));
      final actions =
          tester.getRect(find.byKey(const Key('session-composer-actions')));
      expect(composer.bottom, lessThanOrEqualTo(actions.top + 1),
          reason: reason);
      expect(actions.height, 52, reason: reason);
      expect(actions.bottom, lessThanOrEqualTo(430 - inset + 1),
          reason: reason);
      final RenderEditable editable = tester
          .state<EditableTextState>(find.descendant(
            of: find.byKey(const Key('session-composer')),
            matching: find.byType(EditableText),
          ))
          .renderEditable;
      expect(editable.size.height,
          greaterThanOrEqualTo(editable.preferredLineHeight),
          reason: '$reason clips the scaled draft');
      expect(tester.takeException(), isNull, reason: reason);
    }
  });

  testWidgets(
      'slash suggestions stay overflow-free above a tight portrait keyboard',
      (tester) async {
    tester.view.physicalSize = const Size(1080, 1600);
    tester.view.devicePixelRatio = 2.625;
    tester.view.viewPadding = const FakeViewPadding(top: 91);
    tester.view.padding = const FakeViewPadding(top: 91);
    tester.view.viewInsets = const FakeViewPadding(bottom: 872);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetViewPadding);
    addTearDown(tester.view.resetPadding);
    addTearDown(tester.view.resetViewInsets);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session(
      'portrait-slash-keyboard',
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    );
    store
      ..sessions.add(source)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'gpt-5.6-sol', 'GPT-5.6-Sol', isDefault: true),
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
    tester.view.viewInsets = const FakeViewPadding(bottom: 872);
    await tester.pump();
    await tester.enterText(
      find.byKey(const Key('session-composer')),
      '/mesh',
    );
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('slash-command-palette')), findsOneWidget);
    expect(find.byKey(const Key('mesh-command-suggestion')), findsOneWidget);
    expect(tester.takeException(), isNull,
        reason: 'The live portrait keyboard geometry must not overflow.');

    final actions = find.byKey(const Key('session-composer-actions'));
    expect(tester.getSize(actions).height, 52);
    final keyboardTop = (1600 - 872) / 2.625;
    expect(tester.getRect(actions).bottom, lessThanOrEqualTo(keyboardTop + 1));

    tester.view.viewInsets = const FakeViewPadding(bottom: 930);
    await tester.pump();
    await tester.pump();
    final compactLayoutException = tester.takeException();
    expect(
      compactLayoutException,
      isNull,
      reason: compactLayoutException is FlutterError
          ? compactLayoutException.toStringDeep()
          : 'The dock must leave room for the one-pixel history progress lane.',
    );
  });

  testWidgets(
      'model controls and a long composer stay overflow-free in a short viewport',
      (tester) async {
    tester.view.physicalSize = const Size(320, 240);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session(
      'short-composer',
      providerId: 'codex',
      modelId: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    );
    store
      ..sessions.add(source)
      ..providers.add(_provider('codex', modelEnumeration: true))
      ..modelsByProvider['codex'] = <RemoteModel>[
        _model('codex', 'gpt-5.6-sol', 'GPT-5.6-Sol', isDefault: true),
      ];
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(1.5)),
          child: child!,
        ),
        home: SessionScreen(
          sessionId: source.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pump();
    expect(tester.takeException(), isNull, reason: 'initial compact layout');
    await tester.enterText(
      find.byKey(const Key('session-composer')),
      List<String>.filled(20, 'A long mobile instruction keeps growing.')
          .join('\n'),
    );
    await tester.pump();
    expect(find.byKey(const Key('model-control')), findsOneWidget);
    expect(find.byKey(const Key('dictation-source-selector')), findsOneWidget);
    expect(
        tester
            .getSize(find.byKey(const Key('session-composer-actions')))
            .height,
        52);
    await tester.tap(find.byKey(const Key('session-secondary-controls')));
    await tester.pumpAndSettle();
    final dictationSource = find.byKey(const Key('dictation-source-control'));
    expect(dictationSource, findsOneWidget);
    final menuList = find.ancestor(
      of: dictationSource,
      matching: find.byType(ListView),
    );
    expect(menuList, findsOneWidget);
    final menuScrollable = find.descendant(
      of: menuList,
      matching: find.byType(Scrollable),
    );
    expect(menuScrollable, findsOneWidget);
    final reasoningControl = find.byKey(const Key('reasoning-control'));
    await tester.scrollUntilVisible(
      reasoningControl,
      80,
      scrollable: menuScrollable,
    );
    expect(reasoningControl, findsOneWidget);
    expect(tester.takeException(), isNull, reason: 'long composer layout');
  });

  testWidgets(
      'a jump-to-latest control appears after scrolling up and returns to the tail',
      (tester) async {
    tester.view.physicalSize = const Size(430, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('jump-latest', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = List<RemoteMessage>.generate(
        28,
        (index) => RemoteMessage(
          id: 'jump-message-$index',
          sessionId: source.id,
          role: index.isEven ? 'user' : 'assistant',
          createdAt: DateTime.utc(2026, 9, 2, 12, 0, index),
          status: 'completed',
          parts: <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{
              'text':
                  'Line $index of a long mobile conversation that needs enough height to scroll away from the latest message.',
            }),
          ],
        ),
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.byKey(const Key('jump-to-latest')), findsNothing);
    await tester.drag(find.byType(ListView), const Offset(0, 480));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const Key('jump-to-latest')), findsOneWidget);
    expect(tester.getSize(find.byKey(const Key('jump-to-latest'))).height,
        greaterThanOrEqualTo(44));

    await tester.tap(find.byKey(const Key('jump-to-latest')));
    await tester.pump();
    expect(find.byKey(const Key('jump-to-latest')), findsNothing);
  });

  testWidgets(
      'programmatic reader movement revokes follow before live output grows',
      (tester) async {
    tester.view.physicalSize = const Size(430, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source =
        _session('programmatic-scroll', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = List<RemoteMessage>.generate(
        30,
        (index) => RemoteMessage(
          id: 'programmatic-message-$index',
          sessionId: source.id,
          role: index.isEven ? 'user' : 'assistant',
          createdAt: DateTime.utc(2026, 9, 2, 13, 0, index),
          status: 'completed',
          parts: <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{
              'text':
                  'Programmatic scroll line $index has enough content to keep the transcript well away from its physical tail.',
            }),
          ],
        ),
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final list = tester.widget<ListView>(find.byType(ListView));
    final controller = list.controller!;
    controller.jumpTo(controller.position.maxScrollExtent - 320);
    await tester.pump();
    final distanceBeforeGrowth =
        controller.position.maxScrollExtent - controller.position.pixels;
    expect(distanceBeforeGrowth, greaterThan(250));
    expect(find.byKey(const Key('jump-to-latest')), findsOneWidget);

    store.messages[source.id]!.add(RemoteMessage(
      id: 'programmatic-live-tail',
      sessionId: source.id,
      role: 'assistant',
      createdAt: DateTime.utc(2026, 9, 2, 13, 1),
      status: 'streaming',
      parts: const <ContentPart>[
        ContentPart(type: 'text', data: <String, Object?>{
          'text': 'New live output must not become a navigation command.',
        }),
      ],
    ));
    store.notifyListeners();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(
      controller.position.maxScrollExtent - controller.position.pixels,
      greaterThanOrEqualTo(distanceBeforeGrowth - 1),
    );
    expect(find.byKey(const Key('jump-to-latest')), findsOneWidget);
  });

  testWidgets('rotation preserves the first visible conversation row',
      (tester) async {
    tester.view.physicalSize = const Size(430, 720);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('reader-reflow', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'))
      ..messages[source.id] = List<RemoteMessage>.generate(
        34,
        (index) => RemoteMessage(
          id: 'reflow-message-$index',
          sessionId: source.id,
          role: index.isEven ? 'user' : 'assistant',
          createdAt: DateTime.utc(2026, 9, 2, 14, 0, index),
          status: 'completed',
          parts: <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{
              'text':
                  'Reflow line $index deliberately contains enough words to wrap differently when a phone changes width while its reader is away from the latest answer.',
            }),
          ],
        ),
      );
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final listFinder = find.byType(ListView);
    final controller = tester.widget<ListView>(listFinder).controller!;
    controller.jumpTo(controller.position.maxScrollExtent / 2);
    await tester.pump();
    final viewport = tester.getRect(listFinder);
    Finder? retainedRow;
    var retainedTop = double.infinity;
    for (var index = 0; index < 34; index += 1) {
      final candidate =
          find.byKey(ValueKey<String>('message-align-reflow-message-$index'));
      if (candidate.evaluate().isEmpty) continue;
      final rect = tester.getRect(candidate);
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      if (rect.top < retainedTop) {
        retainedRow = candidate;
        retainedTop = rect.top;
      }
    }
    expect(retainedRow, isNotNull);

    tester.view.physicalSize = const Size(320, 720);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(tester.getTopLeft(retainedRow!).dy, closeTo(retainedTop, 1));
    expect(find.byKey(const Key('jump-to-latest')), findsOneWidget);
  });

  testWidgets('non-message timeline rows retain their reading anchor',
      (tester) async {
    tester.view.physicalSize = const Size(430, 620);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _FeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final source = _session('approval-anchor', providerId: 'future-harness');
    store
      ..sessions.add(source)
      ..providers.add(_provider('future-harness'));
    for (var index = 0; index < 9; index += 1) {
      final requestId = 'approval-anchor-$index';
      store.approvals[requestId] = ApprovalRequest(
        requestId: requestId,
        sessionId: source.id,
        providerId: source.providerId,
        title: 'Approval anchor $index',
        choices: const <ApprovalChoice>[
          ApprovalChoice(id: 'allow', label: 'Allow', kind: 'accept'),
        ],
        affectedFiles: const <String>[],
        networkDestinations: const <String>[],
        reason: 'A stable approval card used to protect reading position.',
      );
    }
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: source.id)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final listFinder = find.byType(ListView);
    final controller = tester.widget<ListView>(listFinder).controller!;
    controller.jumpTo(controller.position.maxScrollExtent / 2);
    await tester.pump();
    final viewport = tester.getRect(listFinder);
    Finder? retainedTitle;
    var retainedTop = double.infinity;
    for (var index = 0; index < 9; index += 1) {
      final candidate = find.text('Approval anchor $index');
      if (candidate.evaluate().isEmpty) continue;
      final rect = tester.getRect(candidate);
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      if (rect.top < retainedTop) {
        retainedTitle = candidate;
        retainedTop = rect.top;
      }
    }
    expect(retainedTitle, isNotNull);

    store.messages[source.id] = List<RemoteMessage>.generate(
      8,
      (index) => RemoteMessage(
        id: 'inserted-before-approval-$index',
        sessionId: source.id,
        role: index.isEven ? 'user' : 'assistant',
        createdAt: DateTime.utc(2026, 9, 2, 15, 0, index),
        status: 'completed',
        parts: <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text': 'Earlier reconciled message $index.',
          }),
        ],
      ),
    );
    store.notifyListeners();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(tester.getTopLeft(retainedTitle!).dy, closeTo(retainedTop, 1));
    expect(find.byKey(const Key('jump-to-latest')), findsOneWidget);
  });

  testWidgets('recording controls enable immediately after recorder start',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('dictation-immediate-stop', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _SuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();

    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('dictation-button')))
          .onPressed,
      isNotNull,
      reason: 'Stop must work without waiting for the one-second timer tick.',
    );
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('send-instruction')))
          .onPressed,
      isNotNull,
      reason: 'Stop-and-send must be available on the first recording frame.',
    );
  });

  testWidgets(
      'main dictation says Stopping until audio is retained, then says safe',
      (tester) async {
    final store = _GatedRetentionDictationStore()
      ..connectionState = BridgeConnectionState.online;
    final session =
        _session('main-dictation-status-truth', providerId: 'codex');
    final recorder = _FailingStopRecorder();
    final bytes = Uint8List.fromList(<int>[1, 2, 3]);
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(() {
      if (!recorder.stopGate.isCompleted) recorder.stopGate.complete(bytes);
      if (!store.retentionGate.isCompleted) store.retentionGate.complete();
      for (final transcription in store.transcriptions) {
        if (!transcription.isCompleted)
          transcription.complete('dictated words');
      }
      store.dispose();
    });

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();

    final processing = find.byKey(const Key('dictation-processing-status'));
    expect(find.descendant(of: processing, matching: find.text('Stopping…')),
        findsOneWidget);
    expect(
        find.descendant(of: processing, matching: find.textContaining('safe')),
        findsNothing);

    recorder.stopGate.complete(bytes);
    await tester.pump();
    expect(store.retainCalls, 1);
    expect(find.descendant(of: processing, matching: find.text('Stopping…')),
        findsOneWidget,
        reason: 'Recorder completion alone does not make the bytes durable.');

    store.retentionGate.complete();
    await tester.pump();
    expect(store.transcriptions, hasLength(1));
    expect(
      find.descendant(
        of: processing,
        matching: find.text('Transcribing… Your recording is safe.'),
      ),
      findsOneWidget,
    );

    store.transcriptions.single.complete('dictated words');
    await tester.pump();
  });

  testWidgets(
      'side-chat dictation says Stopping until audio is retained, then says safe',
      (tester) async {
    final store = _GatedRetentionDictationStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-dictation-status-truth', providerId: 'codex');
    final recorder = _FailingStopRecorder();
    final bytes = Uint8List.fromList(<int>[1, 2, 3]);
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(() {
      if (!recorder.stopGate.isCompleted) recorder.stopGate.complete(bytes);
      if (!store.retentionGate.isCompleted) store.retentionGate.complete();
      for (final transcription in store.transcriptions) {
        if (!transcription.isCompleted)
          transcription.complete('dictated words');
      }
      store.dispose();
    });

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () => recorder,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();

    final processing = find.byKey(const Key('side-chat-dictation-processing'));
    expect(processing, findsOneWidget);
    expect(find.text('Stopping…'), findsOneWidget);
    expect(find.textContaining('safe'), findsNothing);

    recorder.stopGate.complete(bytes);
    await tester.pump();
    expect(store.retainCalls, 1);
    expect(find.text('Stopping…'), findsOneWidget,
        reason: 'Recorder completion alone does not make the bytes durable.');

    store.retentionGate.complete();
    await tester.pump();
    expect(store.transcriptions, hasLength(1));
    expect(find.text('Recording safe - transcribing...'), findsOneWidget);

    store.transcriptions.single.complete('dictated words');
    await tester.pump();
  });

  testWidgets('main source-limit expiry finalizes and submits exactly once',
      (tester) async {
    final store = _DictationSubmissionStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('main-dictation-expiry', providerId: 'codex');
    final recorder =
        _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3]));
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_oneSecondDictationSource)
      ..dictationSourcePreferences['codex'] = _oneSecondDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();

    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1100)));
    await tester.pump(const Duration(seconds: 1));
    for (var attempt = 0;
        attempt < 8 && store.mainSendCalls == 0;
        attempt += 1) {
      await tester.pump();
    }

    expect(recorder.stopCalls, 1);
    expect(store.transcribeCalls, 1);
    expect(store.mainSendCalls, 1);
    expect(store.mainContent, 'dictated words');

    await tester.pump(const Duration(seconds: 3));
    expect(recorder.stopCalls, 1,
        reason:
            'Later timer callbacks must not finalize the same audio again.');
    expect(store.mainSendCalls, 1);
  });

  testWidgets('side-chat source-limit expiry submits exactly once',
      (tester) async {
    final store = _DictationSubmissionStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-dictation-expiry', providerId: 'codex');
    final recorder =
        _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3]));
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_oneSecondDictationSource)
      ..dictationSourcePreferences['codex'] = _oneSecondDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () => recorder,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();

    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 1100)));
    await tester.pump(const Duration(seconds: 1));
    for (var attempt = 0;
        attempt < 8 && store.sideSendCalls == 0;
        attempt += 1) {
      await tester.pump();
    }

    expect(recorder.stopCalls, 1);
    expect(store.transcribeCalls, 1);
    expect(store.sideSendCalls, 1);
    expect(store.sideContent, 'dictated words');

    await tester.pump(const Duration(seconds: 3));
    expect(recorder.stopCalls, 1);
    expect(store.sideSendCalls, 1);
  });

  testWidgets('main background stop restores dictation without submitting',
      (tester) async {
    final store = _DictationSubmissionStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('main-dictation-background', providerId: 'codex');
    final recorder =
        _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3]));
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);
    addTearDown(() => tester.binding
        .handleAppLifecycleStateChanged(AppLifecycleState.resumed));

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    await tester.pump();

    expect(recorder.stopCalls, 1);
    expect(store.transcribeCalls, 1);
    expect(store.mainSendCalls, 0);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      'dictated words',
    );
  });

  testWidgets('side-chat background stop restores without submitting',
      (tester) async {
    final store = _DictationSubmissionStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-dictation-background', providerId: 'codex');
    final recorder =
        _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3]));
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);
    addTearDown(() => tester.binding
        .handleAppLifecycleStateChanged(AppLifecycleState.resumed));

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () => recorder,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    await tester.pump();

    expect(recorder.stopCalls, 1);
    expect(store.transcribeCalls, 1);
    expect(store.sideSendCalls, 0);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('side-chat-composer')))
          .controller!
          .text,
      'dictated words',
    );
  });

  testWidgets(
      'main Stop-and-send retains audio through acknowledgement without repainting',
      (tester) async {
    final sendGate = Completer<String?>();
    final store = _DictationSubmissionStore(mainSendGate: sendGate)
      ..connectionState = BridgeConnectionState.online;
    final session = _session('main-dictation-atomic-send', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    final composer = find.byKey(const Key('session-composer'));
    await tester.enterText(composer, 'typed first');
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-instruction')));
    for (var attempt = 0;
        attempt < 24 && store.mainSendCalls == 0;
        attempt += 1) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    if (store.mainSendCalls == 0) {
      await tester.runAsync(() async {
        final deadline = DateTime.now().add(const Duration(seconds: 2));
        while (store.mainSendCalls == 0 && DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      });
      await tester.pump();
    }

    expect(store.mainSendCalls, 1);
    expect(store.clearCalls, 0);
    expect(store.retainedSessionIds, contains(session.id));
    expect(tester.widget<TextField>(composer).controller!.text, isEmpty,
        reason:
            'The accepted outgoing snapshot must clear without repainting finalized speech.');

    sendGate.complete(null);
    for (var attempt = 0; attempt < 8 && store.clearCalls == 0; attempt += 1) {
      await tester.pump();
    }
    expect(store.mainSendCalls, 1);
    expect(store.clearCalls, 1);
    expect(store.retainedSessionIds, isNot(contains(session.id)));
    expect(store.mainContent, 'typed first dictated words');
    expect(tester.widget<TextField>(composer).controller!.text, isEmpty);
  });

  testWidgets(
      'side-chat Stop-and-send retains audio through acknowledgement without repainting a chip',
      (tester) async {
    final sendGate = Completer<void>();
    final store = _DictationSubmissionStore(sideSendGate: sendGate)
      ..connectionState = BridgeConnectionState.online;
    final parent = _session(
      'side-dictation-atomic-send',
      providerId: 'codex',
      modelId: 'audio-model',
    );
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..modelsByProvider['codex'] = const <RemoteModel>[
        RemoteModel(
          id: 'audio-model',
          providerId: 'codex',
          displayName: 'Audio model',
          isDefault: true,
          inputModalities: <String>['text', 'audio'],
          nativeMetadata: <String, Object?>{},
        ),
      ]
      ..dictationSourcePreferences['codex'] = directAudioDictationSourceId;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () =>
              _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    final sideChatId = store.sessions
        .firstWhere((session) => session.sessionKind == 'side_chat')
        .id;
    await tester.enterText(
        find.byKey(const Key('side-chat-composer')), 'typed first');
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    for (var attempt = 0; attempt < 8; attempt += 1) {
      await tester.pump();
      final microphone = tester
          .widget<IconButton>(find.byKey(const Key('side-chat-dictation')));
      if (microphone.tooltip == 'Stop dictation') break;
    }
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('side-chat-dictation')))
          .tooltip,
      'Stop dictation',
    );
    await tester.tap(find.byKey(const Key('side-chat-send')));
    for (var attempt = 0;
        attempt < 24 && store.sideSendCalls == 0;
        attempt += 1) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    if (store.sideSendCalls == 0) {
      await tester.runAsync(() async {
        final deadline = DateTime.now().add(const Duration(seconds: 2));
        while (store.sideSendCalls == 0 && DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(milliseconds: 10));
        }
      });
      await tester.pump();
    }

    expect(store.clearCalls, 0);
    expect(store.sideSendCalls, 1);
    expect(store.retainedSessionIds, contains(sideChatId));
    expect(store.draftAttachmentsFor(sideChatId), isEmpty);
    expect(find.byKey(const Key('side-chat-attachment-lane')), findsNothing,
        reason: 'Finalized audio must not paint before its atomic send.');

    sendGate.complete();
    for (var attempt = 0; attempt < 8 && store.clearCalls == 0; attempt += 1) {
      await tester.pump();
    }
    expect(store.sideSendCalls, 1);
    expect(store.clearCalls, 1);
    expect(store.retainedSessionIds, isNot(contains(sideChatId)));
    expect(store.sideContent, 'typed first');
    expect(store.sideAttachments, hasLength(1));
    expect(store.sideAttachments.single.mimeType, 'audio/wav');
    expect(find.byKey(const Key('side-chat-attachment-lane')), findsNothing);
  });

  testWidgets(
      'main failed Stop-and-send restores once, flushes, then clears recovery',
      (tester) async {
    final sendGate = Completer<String?>();
    final store = _DictationSubmissionStore(mainSendGate: sendGate)
      ..connectionState = BridgeConnectionState.online;
    final session = _session('main-dictation-failed-send', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await tester.enterText(
        find.byKey(const Key('session-composer')), 'typed first');
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-instruction')));
    for (var attempt = 0;
        attempt < 24 && store.mainSendCalls == 0;
        attempt += 1) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(store.retainedSessionIds, contains(session.id));

    sendGate.completeError(StateError('send rejected'));
    for (var attempt = 0; attempt < 12 && store.clearCalls == 0; attempt += 1) {
      await tester.pump();
    }

    expect(store.transcribeCalls, 1);
    expect(store.mainSendCalls, 1);
    expect(store.flushCalls, 1);
    expect(store.clearCalls, 1);
    expect(store.retainedSessionIds, isNot(contains(session.id)));
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      'typed first dictated words',
    );
    expect(find.byKey(const Key('dictation-retry-status')), findsNothing);
  });

  testWidgets(
      'side-chat failed Stop-and-send restores once, flushes, then clears recovery',
      (tester) async {
    final sendGate = Completer<void>();
    final store = _DictationSubmissionStore(sideSendGate: sendGate)
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-dictation-failed-send', providerId: 'codex');
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () =>
              _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    final sideChatId = store.sessions
        .firstWhere((session) => session.sessionKind == 'side_chat')
        .id;
    await tester.enterText(
        find.byKey(const Key('side-chat-composer')), 'typed first');
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('side-chat-send')));
    for (var attempt = 0;
        attempt < 24 && store.sideSendCalls == 0;
        attempt += 1) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(store.retainedSessionIds, contains(sideChatId));

    sendGate.completeError(StateError('send rejected'));
    for (var attempt = 0; attempt < 12 && store.clearCalls == 0; attempt += 1) {
      await tester.pump();
    }

    expect(store.transcribeCalls, 1);
    expect(store.sideSendCalls, 1);
    expect(store.flushCalls, 1);
    expect(store.clearCalls, 1);
    expect(store.retainedSessionIds, isNot(contains(sideChatId)));
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('side-chat-composer')))
          .controller!
          .text,
      'typed first dictated words',
    );
    expect(find.byKey(const Key('side-chat-dictation-retry-status')),
        findsNothing);
  });

  testWidgets(
      'host switch during failed dictated send preserves host A recovery and host B draft',
      (tester) async {
    final sendGate = Completer<String?>();
    final store = _DictationSubmissionStore(mainSendGate: sendGate)
      ..connectionState = BridgeConnectionState.online
      ..activeHost = _testHost('host-a');
    final sessionA = _session(
      'dictation-host-race',
      providerId: 'codex',
      hostId: 'host-a',
    );
    store
      ..sessions.add(sessionA)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: sessionA.id,
          dictationRecorder:
              _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-instruction')));
    for (var attempt = 0;
        attempt < 24 && store.mainSendCalls == 0;
        attempt += 1) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(store.retainedSessionIds, contains(sessionA.id));

    store.activeHost = _testHost('host-b');
    store.sessions
      ..clear()
      ..add(_session(sessionA.id, providerId: 'codex', hostId: 'host-b'));
    store.drafts[sessionA.id] = 'Host B protected draft';
    sendGate.completeError(StateError('Host A send failed'));
    await tester.pump();
    await tester.pump();

    expect(store.clearCalls, 0);
    expect(store.retainedSessionIds, contains(sessionA.id));
    expect(store.drafts[sessionA.id], 'Host B protected draft');
  });

  testWidgets('accepted dictated send never offers Retry when cleanup fails',
      (tester) async {
    final store = _DictationSubmissionStore(failClear: true)
      ..connectionState = BridgeConnectionState.online;
    final session =
        _session('dictation-accepted-clear-fails', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _CountingSuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('send-instruction')));
    for (var attempt = 0; attempt < 16 && store.clearCalls == 0; attempt += 1) {
      await tester.pump();
    }

    expect(store.mainSendCalls, 1);
    expect(store.clearCalls, 1);
    expect(find.byKey(const Key('dictation-retry-status')), findsNothing);
    await tester.pump(const Duration(seconds: 1));
    expect(store.mainSendCalls, 1);
  });

  testWidgets('pop during recorder start serializes cancel before dispose',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('dictation-start-pop', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    final recorder = _OrderedStartRecorder();
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(recorder.events, <String>['start']);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    recorder.startGate.complete(true);
    await tester.pump();
    recorder.cancelGate.complete();
    await tester.pump();
    expect(
      recorder.events,
      <String>['start', 'cancel', 'dispose'],
      reason: 'A pending start must settle and cancel before disposal begins.',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('early dictation Cancel unlocks after recorder stop fails',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('dictation-early-cancel', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    final recorder = _FailingStopRecorder();
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(
        find.byKey(const Key('cancel-dictation-processing')), findsOneWidget);

    await tester.tap(find.byKey(const Key('cancel-dictation-processing')));
    await tester.pump();
    recorder.stopGate.completeError(StateError('recorder stop failed'));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('dictation-processing-status')), findsNothing);
    expect(find.byKey(const Key('cancel-dictation-processing')), findsNothing);
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('dictation-button')))
          .onPressed,
      isNotNull,
      reason: 'A failed stop must not leave voice input permanently blocked.',
    );
  });

  testWidgets('side-chat early Cancel unlocks after recorder stop fails',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-dictation-early-cancel', providerId: 'codex');
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    final recorder = _FailingStopRecorder();
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () => recorder,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    expect(
      find.byKey(const Key('cancel-side-chat-dictation-processing')),
      findsOneWidget,
    );

    await tester
        .tap(find.byKey(const Key('cancel-side-chat-dictation-processing')));
    await tester.pump();
    recorder.stopGate.completeError(StateError('recorder stop failed'));
    await tester.pump();
    await tester.pump();

    expect(
      find.byKey(const Key('side-chat-dictation-processing')),
      findsNothing,
    );
    expect(
      find.byKey(const Key('cancel-side-chat-dictation-processing')),
      findsNothing,
    );
    expect(
      tester
          .widget<IconButton>(find.byKey(const Key('side-chat-dictation')))
          .onPressed,
      isNotNull,
    );
  });

  testWidgets('stale failed send cannot restore over a colliding host draft',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _HostRaceFeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..activeHost = _testHost('host-a');
    final sessionA = _session(
      'colliding-main-send',
      providerId: 'future-harness',
      hostId: 'host-a',
    );
    store
      ..sessions.add(sessionA)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: sessionA.id)),
    ));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const Key('session-composer')), 'Host A outgoing text');
    await tester.pump();
    final send = tester
        .widget<IconButton>(find.byKey(const Key('send-instruction')))
        .onPressed;
    expect(send, isNotNull);
    send!();
    for (var attempt = 0;
        attempt < 4 && store.mainSendCalls == 0;
        attempt += 1) {
      await tester.pump();
    }
    expect(store.mainSendCalls, 1);

    store.replaceWithHost(
      _testHost('host-b'),
      <RemoteSession>[
        _session(
          sessionA.id,
          providerId: 'future-harness',
          hostId: 'host-b',
        ),
      ],
      draft: 'Host B protected draft',
    );
    store.mainSendGate.completeError(StateError('Host A send failed'));
    await tester.pump();
    await tester.pump();

    expect(store.drafts[sessionA.id], 'Host B protected draft');
  });

  testWidgets(
      'stale failed side-chat send cannot restore over a colliding host draft',
      (tester) async {
    final store = _HostRaceFeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..activeHost = _testHost('host-a');
    final parentA = _session(
      'colliding-side-parent',
      providerId: 'codex',
      hostId: 'host-a',
    );
    store
      ..sessions.add(parentA)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parentA.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    final sideChatId = store.sessions
        .firstWhere((session) => session.sessionKind == 'side_chat')
        .id;
    await tester.enterText(
        find.byKey(const Key('side-chat-composer')), 'Host A side outgoing');
    await tester.pump();
    await tester.tap(find.byKey(const Key('side-chat-send')));
    for (var attempt = 0;
        attempt < 4 && store.sideSendCalls == 0;
        attempt += 1) {
      await tester.pump();
    }
    expect(store.sideSendCalls, 1);

    store.replaceWithHost(
      _testHost('host-b'),
      <RemoteSession>[
        _session(
          parentA.id,
          providerId: 'codex',
          hostId: 'host-b',
        ),
        _session(
          sideChatId,
          providerId: 'codex',
          hostId: 'host-b',
          parentSessionId: parentA.id,
        ).copyWith(sessionKind: 'side_chat'),
      ],
      draftSessionId: sideChatId,
      draft: 'Host B protected side draft',
    );
    store.sideSendGate.completeError(StateError('Host A side send failed'));
    await tester.pump();
    await tester.pump();

    expect(store.drafts[sideChatId], 'Host B protected side draft');
  });

  testWidgets('late side-chat picker result is discarded after host switch',
      (tester) async {
    final originalSelector = FileSelectorPlatform.instance;
    final selector = _GatedFileSelector();
    FileSelectorPlatform.instance = selector;
    addTearDown(() => FileSelectorPlatform.instance = originalSelector);
    final store = _HostRaceFeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..activeHost = _testHost('host-a');
    final parentA = _session(
      'side-picker-parent',
      providerId: 'codex',
      hostId: 'host-a',
    );
    store
      ..sessions.add(parentA)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parentA.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    final sideChatId = store.sessions
        .firstWhere((session) => session.sessionKind == 'side_chat')
        .id;
    await tester.tap(find.byKey(const Key('side-chat-attachment')));
    await tester.pump();
    expect(selector.openCalls, 1);

    const protectedAttachment = RemoteAttachment(
      name: 'host-b-protected.txt',
      mimeType: 'text/plain',
      dataBase64: 'Qg==',
      byteLength: 1,
    );
    store.replaceWithHost(
      _testHost('host-b'),
      <RemoteSession>[
        _session(
          parentA.id,
          providerId: 'codex',
          hostId: 'host-b',
        ),
        _session(
          sideChatId,
          providerId: 'codex',
          hostId: 'host-b',
          parentSessionId: parentA.id,
        ).copyWith(sessionKind: 'side_chat'),
      ],
      draftSessionId: sideChatId,
      attachments: const <RemoteAttachment>[protectedAttachment],
    );
    selector.gate.complete(XFile.fromData(
      Uint8List.fromList(<int>[1, 2, 3]),
      name: 'late-host-a.txt',
      mimeType: 'text/plain',
    ));
    await tester.pump();
    await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pump();

    expect(store.draftAttachmentsFor(sideChatId), hasLength(1));
    expect(store.draftAttachmentsFor(sideChatId).single.name,
        protectedAttachment.name);
  });

  testWidgets('stale session poll timers never call the replacement host',
      (tester) async {
    final store = _HostRaceFeatureStore()
      ..connectionState = BridgeConnectionState.online
      ..activeHost = _testHost('host-a');
    final sessionA = _session(
      'poll-host-collision',
      providerId: 'future-harness',
      hostId: 'host-a',
      state: 'working',
    );
    store
      ..sessions.add(sessionA)
      ..providers.add(_provider(
        'future-harness',
        sessionRelationships: true,
      ));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(home: SessionScreen(sessionId: sessionA.id)),
    ));
    await tester.pump();
    await tester.pump();
    store.resetPollCounts();
    store.replaceWithHost(
      _testHost('host-b'),
      <RemoteSession>[
        _session(
          sessionA.id,
          providerId: 'future-harness',
          hostId: 'host-b',
          state: 'working',
        ),
      ],
    );

    await tester.pump(const Duration(seconds: 4));
    expect(store.hostBHistoryRefreshes, 0);
    expect(store.hostBChildLoads, 0);
  });

  testWidgets(
      'main dictation clear failure cannot retry an already inserted transcript',
      (tester) async {
    final store = _ClearFailureDictationStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('main-clear-after-commit', providerId: 'codex');
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder:
              _SuccessfulRecorder(Uint8List.fromList(<int>[7, 8, 9])),
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    await tester.pump();

    final retry = find.byKey(const Key('dictation-retry-status'));
    if (retry.evaluate().isNotEmpty) {
      await tester.tap(find.byKey(const Key('dictation-button')));
      await tester.pump();
      await tester.pump();
    }
    expect(store.transcribeCalls, 1,
        reason: 'Journal cleanup must not make committed audio retryable.');
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer')))
          .controller!
          .text,
      'spoken once',
    );
    expect(retry, findsNothing);
  });

  testWidgets(
      'side-chat dictation clear failure cannot retry an already inserted transcript',
      (tester) async {
    final store = _ClearFailureDictationStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-clear-after-commit', providerId: 'codex');
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () =>
              _SuccessfulRecorder(Uint8List.fromList(<int>[7, 8, 9])),
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    await tester.pump();

    final retry = find.byKey(const Key('side-chat-dictation-retry-status'));
    if (retry.evaluate().isNotEmpty) {
      await tester.tap(find.byKey(const Key('side-chat-dictation')));
      await tester.pump();
      await tester.pump();
    }
    expect(store.transcribeCalls, 1,
        reason: 'Journal cleanup must not make committed audio retryable.');
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('side-chat-composer')))
          .controller!
          .text,
      'spoken once',
    );
    expect(retry, findsNothing);
  });

  testWidgets('disposing main immediately after Send preserves pre-ack draft',
      (tester) async {
    tester.view.physicalSize = const Size(430, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final store = _PendingSendFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('main-dispose-send', providerId: 'future-harness');
    store
      ..sessions.add(session)
      ..providers.add(_provider('future-harness'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: _NoopRecorder(),
        ),
      ),
    ));
    await tester.pumpAndSettle();
    await tester.enterText(
        find.byKey(const Key('session-composer')), 'durable main snapshot');
    await tester.pump();
    final send = tester
        .widget<IconButton>(find.byKey(const Key('send-instruction')))
        .onPressed;
    expect(send, isNotNull);
    send!();
    for (var attempt = 0;
        attempt < 4 && store.mainSendCalls == 0;
        attempt += 1) {
      await tester.pump();
    }
    expect(store.mainSendCalls, 1);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    store.mainSendGate.complete(null);
    await tester.pump();

    expect(store.drafts[session.id], 'durable main snapshot');
  });

  testWidgets(
      'disposing side chat immediately after Send preserves pre-ack draft',
      (tester) async {
    final store = _PendingSendFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-dispose-send', providerId: 'codex');
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'));
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: _NoopRecorder.new,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    final sideChatId = store.sessions
        .firstWhere((session) => session.sessionKind == 'side_chat')
        .id;
    await tester.enterText(
        find.byKey(const Key('side-chat-composer')), 'durable side snapshot');
    await tester.pump();
    tester
        .widget<IconButton>(find.byKey(const Key('side-chat-send')))
        .onPressed!();
    for (var attempt = 0;
        attempt < 4 && store.sideSendCalls == 0;
        attempt += 1) {
      await tester.pump();
    }
    expect(store.sideSendCalls, 1);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    store.sideSendGate.complete();
    await tester.pump();

    expect(store.drafts[sideChatId], 'durable side snapshot');
  });

  testWidgets('disposing main recording cancels once before recorder disposal',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final session = _session('main-recording-dispose', providerId: 'codex');
    final recorder = _LifecycleRecorder();
    store
      ..sessions.add(session)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: session.id,
          dictationRecorder: recorder,
        ),
      ),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const Key('dictation-button')));
    await tester.pump();
    expect(recorder.events, <String>['start']);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    await tester.pump();

    expect(recorder.events, <String>['start', 'cancel', 'dispose']);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'disposing side-chat recording cancels once before recorder disposal',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-recording-dispose', providerId: 'codex');
    final recorder = _LifecycleRecorder();
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () => recorder,
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    expect(recorder.events, <String>['start']);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    await tester.pump();

    expect(recorder.events, <String>['start', 'cancel', 'dispose']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('side-chat Retry stays disabled until cancelled work settles',
      (tester) async {
    final store = _DictationFeatureStore()
      ..connectionState = BridgeConnectionState.online;
    final parent = _session('side-cancel-single-flight', providerId: 'codex');
    store
      ..sessions.add(parent)
      ..providers.add(_provider('codex'))
      ..dictationSources.add(_readyDictationSource)
      ..dictationSourcePreferences['codex'] = _readyDictationSource.id;
    addTearDown(store.dispose);

    await tester.pumpWidget(StoreScope(
      store: store,
      child: MaterialApp(
        home: SessionScreen(
          sessionId: parent.id,
          dictationRecorder: _NoopRecorder(),
          sideChatDictationRecorderFactory: () =>
              _SuccessfulRecorder(Uint8List.fromList(<int>[1, 2, 3])),
        ),
      ),
    ));
    await tester.pump();
    await _openFeatureSideChat(tester);
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    for (var attempt = 0;
        attempt < 8 && store.transcriptions.isEmpty;
        attempt += 1) {
      await tester.pump();
    }
    expect(store.transcriptions, hasLength(1));

    await tester
        .tap(find.byKey(const Key('cancel-side-chat-dictation-processing')));
    await tester.pump();
    var microphone =
        tester.widget<IconButton>(find.byKey(const Key('side-chat-dictation')));
    expect(microphone.onPressed, isNull);
    expect(microphone.tooltip, 'Retry available when processing finishes');
    expect(find.text('Recording kept - finishing...'), findsOneWidget);

    store.transcriptions.single.complete('stale transcript');
    await tester.pump();
    await tester.pump();

    microphone =
        tester.widget<IconButton>(find.byKey(const Key('side-chat-dictation')));
    expect(microphone.onPressed, isNotNull);
    expect(microphone.tooltip, 'Retry saved dictation');
    expect(store.transcriptions, hasLength(1));
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('side-chat-composer')))
          .controller!
          .text,
      isEmpty,
    );

    await tester.tap(find.byKey(const Key('side-chat-dictation')));
    await tester.pump();
    expect(store.transcriptions, hasLength(2));
    store.transcriptions[1].complete('fresh side transcript');
    await tester.pump();
    await tester.pump();
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('side-chat-composer')))
          .controller!
          .text,
      'fresh side transcript',
    );
    expect(store.sendCalls, 0,
        reason: 'Side-chat mic Retry must remain non-submitting.');
  });
}

Future<void> _openFeatureSideChat(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('session-secondary-controls')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const Key('open-side-chat')));
  await tester.pumpAndSettle();
  expect(find.byKey(const Key('side-chat-composer')), findsOneWidget);
}

class _FeatureStore extends RemoteAppStore {
  String? lastHandoffPrompt;
  String? lastBranchSessionId;
  String? lastWalletEndpointId;
  String? lastReasoningDisplayMode;
  Map<String, Object?>? lastInputAnswers;
  SessionContextState? contextFixture;
  int thresholdSetCalls = 0;
  int visionStatusCalls = 0;
  int visionStatusFailuresRemaining = 0;
  int? lastThresholdTokens;
  bool? lastCompactNow;
  RemoteAttachment? sideChatAttachmentFixture;
  int _sideChatSequence = 0;

  void restoreDraftForTest(String sessionId, String text) {
    drafts[sessionId] = text;
    notifyListeners();
  }

  @override
  Future<RemoteSession> createSideChat(
    String parentSessionId, {
    String? prompt,
    String? queuedMessageId,
  }) async {
    final parent =
        sessions.firstWhere((session) => session.id == parentSessionId);
    final created = _session(
      'feature-side-chat-${_sideChatSequence++}',
      providerId: parent.providerId,
      hostId: parent.hostId,
      modelId: parent.modelId,
      parentSessionId: parentSessionId,
    ).copyWith(sessionKind: 'side_chat');
    sessions.add(created);
    final attachment = sideChatAttachmentFixture;
    if (attachment != null) {
      setDraftAttachments(created.id, <RemoteAttachment>[attachment]);
    } else {
      notifyListeners();
    }
    return created;
  }

  @override
  bool get canSyncVisionStatus => true;

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
    visionStatusCalls += 1;
    if (visionStatusFailuresRemaining > 0) {
      visionStatusFailuresRemaining -= 1;
      throw StateError('visual status failed');
    }
    final value = VisionProxyStatus(
      sessionId: sessionId,
      primaryModelSupportsImageInput: true,
    );
    visionBySession[sessionId] = value;
    notifyListeners();
    return value;
  }

  @override
  Duration visionStatusRetryDelay(String sessionId) =>
      const Duration(milliseconds: 250);

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

class _GatedPreparedFeatureStore extends _FeatureStore {
  final Completer<void> modelGate = Completer<void>();
  int modelLoadCalls = 0;

  @override
  Future<List<RemoteModel>> loadModels(
    String providerId, {
    bool force = false,
    bool surfaceErrors = true,
  }) async {
    modelLoadCalls += 1;
    await modelGate.future;
    return modelsByProvider[providerId] ?? const <RemoteModel>[];
  }
}

class _LongSideChatFeatureStore extends _FeatureStore {
  @override
  Future<RemoteSession> createSideChat(
    String parentSessionId, {
    String? prompt,
    String? queuedMessageId,
  }) async {
    final created = await super.createSideChat(
      parentSessionId,
      prompt: prompt,
      queuedMessageId: queuedMessageId,
    );
    messages[created.id] = List<RemoteMessage>.generate(
      32,
      (index) => RemoteMessage(
        id: 'side-scroll-message-$index',
        sessionId: created.id,
        role: index.isEven ? 'user' : 'assistant',
        createdAt: DateTime.utc(2026, 9, 2, 12, 0, index),
        status: 'completed',
        parts: <ContentPart>[
          ContentPart(type: 'text', data: <String, Object?>{
            'text':
                'Side chat line $index with enough content to keep this conversation scrollable during keyboard changes.',
          }),
        ],
      ),
    );
    notifyListeners();
    return created;
  }
}

class _GatedSideChatOpenStore extends _FeatureStore {
  final Completer<RemoteSession> createGate = Completer<RemoteSession>();
  int createCalls = 0;

  @override
  Future<RemoteSession> createSideChat(
    String parentSessionId, {
    String? prompt,
    String? queuedMessageId,
  }) {
    createCalls += 1;
    return createGate.future;
  }

  void completeCreate(String parentSessionId) {
    final parent =
        sessions.firstWhere((session) => session.id == parentSessionId);
    final created = _session(
      'gated-side-chat',
      providerId: parent.providerId,
      hostId: parent.hostId,
      modelId: parent.modelId,
      parentSessionId: parentSessionId,
    ).copyWith(sessionKind: 'side_chat');
    sessions.add(created);
    notifyListeners();
    createGate.complete(created);
  }
}

class _GatedSideChatPromotionStore extends _FeatureStore {
  final Completer<RemoteSession> promoteGate = Completer<RemoteSession>();
  int promoteCalls = 0;

  @override
  Future<RemoteSession> promoteSideChat(String sessionId) {
    promoteCalls += 1;
    return promoteGate.future;
  }

  void completePromotion(String sessionId) {
    final sideChat = sessions.firstWhere((session) => session.id == sessionId);
    final promoted = sideChat.copyWith(sessionKind: 'task');
    sessions.removeWhere((session) => session.id == sessionId);
    sessions.add(promoted);
    selectedSession = promoted;
    notifyListeners();
    promoteGate.complete(promoted);
  }
}

class _MeshFeatureStore extends _FeatureStore {
  List<DelegationSelection>? injectedDraftDelegationSelections;
  String? startedDelegationPrompt;
  String? startedDelegationRawDraft;
  List<DelegationSelection>? startedDelegationTargets;
  String? startedDelegationModelId;
  String? startedDelegationReasoningEffort;
  Completer<void>? delegationGate;
  Object? delegationFailure;

  @override
  List<DelegationSelection> draftDelegationSelectionsFor(String sessionId) =>
      List<DelegationSelection>.unmodifiable(
        injectedDraftDelegationSelections ??
            super.draftDelegationSelectionsFor(sessionId),
      );

  @override
  void setDraftDelegationSelections(
    String sessionId,
    Iterable<DelegationSelection> selections,
  ) {
    final retained = List<DelegationSelection>.unmodifiable(selections);
    injectedDraftDelegationSelections = retained;
    super.setDraftDelegationSelections(sessionId, retained);
  }

  @override
  Future<RemoteDelegationTask?> startDelegation(
    String parentSessionId,
    String prompt,
    List<DelegationSelection> targets, {
    String? modelId,
    String? reasoningEffort,
  }) async {
    startedDelegationRawDraft = prompt;
    startedDelegationPrompt = prompt
        .replaceAll('\uFFFC', '')
        .replaceAllMapped(
          RegExp(r'(^|\s)/mesh(?=\s|$)', caseSensitive: false),
          (match) => match.group(1) ?? '',
        )
        .trim();
    startedDelegationTargets = List<DelegationSelection>.unmodifiable(targets);
    startedDelegationModelId = modelId;
    startedDelegationReasoningEffort = reasoningEffort;
    final segments = <RemoteMeshPresentationSegment>[];
    var textStart = 0;
    var targetIndex = 0;
    for (var index = 0; index < prompt.length; index += 1) {
      if (prompt[index] != '\uFFFC') continue;
      if (textStart < index) {
        segments.add(RemoteMeshPresentationSegment.text(
            prompt.substring(textStart, index)));
      }
      segments.add(RemoteMeshPresentationSegment.mesh(targetIndex));
      targetIndex += 1;
      textStart = index + 1;
    }
    if (textStart < prompt.length) {
      segments
          .add(RemoteMeshPresentationSegment.text(prompt.substring(textStart)));
    }
    final now = DateTime.now();
    final task = RemoteDelegationTask(
      id: 'prepared-mesh',
      parentSessionId: parentSessionId,
      prompt: startedDelegationPrompt!,
      state: 'awaiting_dispatch',
      createdAt: now,
      updatedAt: now,
      children: const <RemoteDelegationChild>[],
      targets: List<DelegationSelection>.unmodifiable(targets),
      presentationSegments: segments,
      orchestration: 'parent',
    );
    delegations[task.id] = task;
    notifyListeners();
    await delegationGate?.future;
    final failure = delegationFailure;
    delegationFailure = null;
    if (failure != null) {
      delegations.remove(task.id);
      notifyListeners();
      throw failure;
    }
    setDraft(parentSessionId, '');
    setDraftDelegationSelections(
        parentSessionId, const <DelegationSelection>[]);
    return task;
  }
}

class _DelegationNavigationFeatureStore extends _FeatureStore {
  _DelegationNavigationFeatureStore({
    this.loadedChildren = const <RemoteSession>[],
    this.populateOnCall = 1,
  });

  final List<RemoteSession> loadedChildren;
  final int populateOnCall;
  int childLoadCalls = 0;

  @override
  Future<List<RemoteSession>> loadChildSessions(String parentSessionId) async {
    childLoadCalls += 1;
    if (childLoadCalls < populateOnCall) return const <RemoteSession>[];
    for (final child in loadedChildren) {
      sessions.removeWhere((candidate) => candidate.id == child.id);
      sessions.add(child);
    }
    if (loadedChildren.isNotEmpty) notifyListeners();
    return List<RemoteSession>.unmodifiable(loadedChildren);
  }
}

class _DictationFeatureStore extends _FeatureStore {
  final List<Completer<String>> transcriptions = <Completer<String>>[];
  int sendCalls = 0;

  @override
  Future<String> transcribeDictation(
    List<int> waveBytes, {
    required String sessionId,
    String? sourceId,
  }) {
    final completer = Completer<String>();
    transcriptions.add(completer);
    return completer.future;
  }

  @override
  Future<void> sendMessage(
    String sessionId,
    String content, {
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) async {
    sendCalls += 1;
  }
}

class _GatedRetentionDictationStore extends _DictationFeatureStore {
  final Completer<void> retentionGate = Completer<void>();
  int retainCalls = 0;

  @override
  Future<void> retainDictation(
    String sessionId,
    List<int> waveBytes, {
    String? sourceId,
    bool directAudio = false,
  }) async {
    retainCalls += 1;
    await retentionGate.future;
  }

  @override
  Future<void> clearRetainedDictation(String sessionId) async {}
}

class _DictationSubmissionStore extends _FeatureStore {
  _DictationSubmissionStore({
    this.mainSendGate,
    this.sideSendGate,
    this.failClear = false,
  });

  final Completer<String?>? mainSendGate;
  final Completer<void>? sideSendGate;
  final bool failClear;
  int transcribeCalls = 0;
  int clearCalls = 0;
  int flushCalls = 0;
  int mainSendCalls = 0;
  int sideSendCalls = 0;
  String? mainContent;
  String? sideContent;
  List<RemoteAttachment> mainAttachments = const <RemoteAttachment>[];
  List<RemoteAttachment> sideAttachments = const <RemoteAttachment>[];
  final Set<String> retainedSessionIds = <String>{};

  @override
  Future<void> retainDictation(
    String sessionId,
    List<int> waveBytes, {
    String? sourceId,
    bool directAudio = false,
  }) async {
    retainedSessionIds.add(sessionId);
  }

  @override
  Future<void> clearRetainedDictation(String sessionId) async {
    clearCalls += 1;
    if (failClear) throw StateError('draft journal clear failed');
    retainedSessionIds.remove(sessionId);
  }

  @override
  Future<void> flushDraftJournal({bool runMaintenance = true}) async {
    flushCalls += 1;
  }

  @override
  Future<String> transcribeDictation(
    List<int> waveBytes, {
    required String sessionId,
    String? sourceId,
  }) async {
    transcribeCalls += 1;
    return 'dictated words';
  }

  @override
  Future<String?> submitMessage(
    String sessionId,
    String content, {
    String deliveryMode = 'queue',
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) async {
    mainSendCalls += 1;
    mainContent = content;
    mainAttachments = List<RemoteAttachment>.unmodifiable(attachments);
    final gate = mainSendGate;
    if (gate != null) return gate.future;
    return null;
  }

  @override
  Future<void> sendMessage(
    String sessionId,
    String content, {
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) async {
    sideSendCalls += 1;
    sideContent = content;
    sideAttachments = List<RemoteAttachment>.unmodifiable(attachments);
    final gate = sideSendGate;
    if (gate != null) await gate.future;
  }
}

class _HostRaceFeatureStore extends _FeatureStore {
  final Completer<String?> mainSendGate = Completer<String?>();
  final Completer<void> sideSendGate = Completer<void>();
  int mainSendCalls = 0;
  int sideSendCalls = 0;
  int hostBHistoryRefreshes = 0;
  int hostBChildLoads = 0;

  void replaceWithHost(
    PairedHost host,
    List<RemoteSession> replacement, {
    String? draftSessionId,
    String? draft,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
  }) {
    activeHost = host;
    sessions
      ..clear()
      ..addAll(replacement);
    drafts.clear();
    draftAttachments.clear();
    final targetId =
        draftSessionId ?? (replacement.isEmpty ? null : replacement.first.id);
    if (targetId != null && draft != null) drafts[targetId] = draft;
    if (targetId != null && attachments.isNotEmpty) {
      draftAttachments[targetId] =
          List<RemoteAttachment>.unmodifiable(attachments);
    }
    // Intentionally do not notify: these regressions exercise async callbacks
    // in the real interval after store ownership changes and before repaint.
  }

  void resetPollCounts() {
    hostBHistoryRefreshes = 0;
    hostBChildLoads = 0;
  }

  @override
  Future<String?> submitMessage(
    String sessionId,
    String content, {
    String deliveryMode = 'queue',
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) {
    mainSendCalls += 1;
    return mainSendGate.future;
  }

  @override
  Future<void> sendMessage(
    String sessionId,
    String content, {
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) {
    sideSendCalls += 1;
    return sideSendGate.future;
  }

  @override
  Future<void> refreshVisibleSessionHistory(String sessionId) async {
    if (activeHost?.hostId == 'host-b') hostBHistoryRefreshes += 1;
  }

  @override
  Future<List<RemoteSession>> loadChildSessions(String parentSessionId) async {
    if (activeHost?.hostId == 'host-b') hostBChildLoads += 1;
    return const <RemoteSession>[];
  }
}

class _ClearFailureDictationStore extends _FeatureStore {
  int transcribeCalls = 0;

  @override
  Future<String> transcribeDictation(
    List<int> waveBytes, {
    required String sessionId,
    String? sourceId,
  }) async {
    transcribeCalls += 1;
    return 'spoken once';
  }

  @override
  Future<void> clearRetainedDictation(String sessionId) async {
    throw StateError('draft journal clear failed');
  }
}

class _PendingSendFeatureStore extends _FeatureStore {
  final Completer<String?> mainSendGate = Completer<String?>();
  final Completer<void> sideSendGate = Completer<void>();
  int mainSendCalls = 0;
  int sideSendCalls = 0;

  @override
  Future<String?> submitMessage(
    String sessionId,
    String content, {
    String deliveryMode = 'queue',
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) {
    mainSendCalls += 1;
    return mainSendGate.future;
  }

  @override
  Future<void> sendMessage(
    String sessionId,
    String content, {
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) {
    sideSendCalls += 1;
    return sideSendGate.future;
  }
}

const _readyDictationSource = TranscriptionSource(
  id: 'openai-stt',
  label: 'OpenAI speech to text',
  status: 'ready',
  setupEnvironmentVariable: 'OPENAI_API_KEY',
  supportsBatch: true,
  maxAudioBytes: 25 * 1024 * 1024,
);

const _oneSecondDictationSource = TranscriptionSource(
  id: 'one-second-stt',
  label: 'One second speech to text',
  status: 'ready',
  setupEnvironmentVariable: 'OPENAI_API_KEY',
  supportsBatch: true,
  maxAudioBytes: 64044,
);

final _mobileHost = PairedHost(
  hostId: 'host',
  hostPublicKeyPem: 'unused',
  endpoint: 'ws://127.0.0.1/unused',
  deviceId: 'device',
  devicePrivateKey: const <int>[1],
  devicePublicKey: const <int>[2],
  credential: const SignedCredential(payload: 'unused', signature: 'unused'),
);

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

class _SuccessfulRecorder implements DictationRecorder {
  _SuccessfulRecorder(this.bytes);

  final Uint8List bytes;

  @override
  Stream<double> get levelStream => const Stream<double>.empty();

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> start() async => true;

  @override
  Future<Uint8List> stop() async => bytes;
}

class _CountingSuccessfulRecorder extends _SuccessfulRecorder {
  _CountingSuccessfulRecorder(super.bytes);

  int stopCalls = 0;

  @override
  Future<Uint8List> stop() async {
    stopCalls += 1;
    return bytes;
  }
}

class _LifecycleRecorder implements DictationRecorder {
  final List<String> events = <String>[];

  @override
  Stream<double> get levelStream => const Stream<double>.empty();

  @override
  Future<void> cancel() async {
    events.add('cancel');
  }

  @override
  Future<void> dispose() async {
    events.add('dispose');
  }

  @override
  Future<bool> start() async {
    events.add('start');
    return true;
  }

  @override
  Future<Uint8List> stop() async {
    events.add('stop');
    return Uint8List.fromList(<int>[1, 2, 3]);
  }
}

class _FailingStopRecorder implements DictationRecorder {
  final Completer<Uint8List> stopGate = Completer<Uint8List>();

  @override
  Stream<double> get levelStream => const Stream<double>.empty();

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<bool> start() async => true;

  @override
  Future<Uint8List> stop() => stopGate.future;
}

class _OrderedStartRecorder implements DictationRecorder {
  final Completer<bool> startGate = Completer<bool>();
  final Completer<void> cancelGate = Completer<void>();
  final List<String> events = <String>[];

  @override
  Stream<double> get levelStream => const Stream<double>.empty();

  @override
  Future<void> cancel() async {
    events.add('cancel');
    await cancelGate.future;
  }

  @override
  Future<void> dispose() async {
    events.add('dispose');
  }

  @override
  Future<bool> start() {
    events.add('start');
    return startGate.future;
  }

  @override
  Future<Uint8List> stop() async => Uint8List(0);
}

class _GatedFileSelector extends FileSelectorPlatform {
  final Completer<XFile?> gate = Completer<XFile?>();
  int openCalls = 0;

  @override
  Future<XFile?> openFile({
    List<XTypeGroup>? acceptedTypeGroups,
    String? initialDirectory,
    String? confirmButtonText,
  }) {
    openCalls += 1;
    return gate.future;
  }
}

PairedHost _testHost(String hostId) => PairedHost(
      hostId: hostId,
      hostPublicKeyPem: 'unused',
      endpoint: 'ws://127.0.0.1/$hostId',
      deviceId: 'device-$hostId',
      devicePrivateKey: const <int>[1],
      devicePublicKey: const <int>[2],
      credential:
          const SignedCredential(payload: 'unused', signature: 'unused'),
    );

RemoteSession _session(
  String id, {
  required String providerId,
  String hostId = 'host',
  String? modelId,
  String? reasoningEffort,
  String? variantId,
  String? parentSessionId,
  SessionRelationship? relationship,
  String? workingDirectory,
  String state = 'idle',
}) =>
    RemoteSession(
      id: id,
      hostId: hostId,
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
      parentSessionId: parentSessionId,
      relationship: relationship,
      workingDirectory: workingDirectory,
    );

RemoteDelegationTask _delegationTask(
  String id, {
  required String parentSessionId,
  required DateTime createdAt,
  required List<RemoteDelegationChild> children,
  String state = 'working',
}) =>
    RemoteDelegationTask(
      id: id,
      parentSessionId: parentSessionId,
      prompt: 'Delegate the focused work.',
      state: state,
      createdAt: createdAt,
      updatedAt: createdAt,
      children: children,
      orchestration: 'parent',
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
  bool sessionRelationships = false,
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
        sessionRelationships: sessionRelationships,
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
