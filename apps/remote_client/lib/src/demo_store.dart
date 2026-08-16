import 'dart:async';
import 'dart:convert';

import 'models.dart';
import 'security.dart';
import 'store.dart';
import 'transport.dart';

/// In-memory backend for reviewing the real application UI without a bridge.
///
/// The screens continue to depend on [RemoteAppStore], so demo interactions and
/// production interactions exercise the same widgets. This class only replaces
/// the host transport and secure-storage boundary.
class DemoRemoteAppStore extends RemoteAppStore {
  static const _hostId = 'demo-host';

  @override
  Future<void> initialize() async {
    final now = DateTime.now();
    final host = PairedHost(
      hostId: _hostId,
      hostPublicKeyPem: '',
      endpoint: 'local demo data',
      deviceId: 'demo-device',
      devicePrivateKey: const <int>[],
      devicePublicKey: const <int>[],
      credential: const SignedCredential(payload: '', signature: ''),
      displayName: 'Demo computer',
    );

    hosts
      ..clear()
      ..add(host);
    activeHost = host;
    pairedDevices
      ..clear()
      ..add(PairedDevice(
        credentialId: 'demo-credential',
        deviceId: host.deviceId,
        issuedAt: now.subtract(const Duration(days: 2)),
      ));
    providers
      ..clear()
      ..addAll(const <ProviderConnection>[
        ProviderConnection(
            providerId: 'codex',
            displayName: 'Codex',
            state: 'online',
            detected: true,
            authenticated: true,
            capabilities: ProviderCapabilities(
                createSession: true,
                modelEnumeration: true,
                steering: true,
                sessionRelationships: true,
                messageEditing: true)),
        ProviderConnection(
            providerId: 'opencode',
            displayName: 'OpenCode',
            state: 'online',
            detected: true,
            authenticated: true,
            capabilities: ProviderCapabilities(
                createSession: true,
                modelEnumeration: true,
                sessionRelationships: true)),
        ProviderConnection(
            providerId: 'grok',
            displayName: 'Grok Build',
            state: 'online',
            detected: true,
            authenticated: true,
            capabilities: ProviderCapabilities(
                createSession: true, modelEnumeration: true)),
      ]);
    dictationSources
      ..clear()
      ..addAll(const <TranscriptionSource>[
        TranscriptionSource(
          id: 'openai-stt',
          label: 'OpenAI speech-to-text',
          status: 'ready',
          setupEnvironmentVariable: 'TETHOQ_OPENAI_API_KEY',
          supportsBatch: true,
          maxAudioBytes: 4194304,
          credentialLabel: 'OpenAI API key',
          credentialSetupUrl: 'https://platform.openai.com/api-keys',
        ),
        TranscriptionSource(
          id: 'xai-stt',
          label: 'xAI speech-to-text',
          status: 'ready',
          setupEnvironmentVariable: 'XAI_API_KEY',
          supportsBatch: true,
          maxAudioBytes: 26214400,
          credentialLabel: 'xAI API key',
          credentialSetupUrl: 'https://console.x.ai/',
        ),
      ]);
    preferredDictationSourceId = 'openai-stt';
    sessions
      ..clear()
      ..addAll(<RemoteSession>[
        _session(
          id: 'demo-working',
          providerId: 'codex',
          title: 'Improve search indexing',
          state: 'working',
          activity: now.subtract(const Duration(minutes: 2)),
          project: 'Tethoq',
          directory: r'C:\Projects\sample-app',
          preview:
              'Checking index updates and preserving existing search behavior.',
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'ultra',
        ),
        _session(
          id: 'demo-working-child',
          providerId: 'codex',
          title: 'Review attachment rendering',
          state: 'working',
          activity: now.subtract(const Duration(minutes: 1)),
          project: 'Tethoq',
          directory: r'C:\Projects\sample-app',
          preview: 'Checking the attachment preview behavior.',
          parentSessionId: 'demo-working',
          agentNickname: 'UI reviewer',
          agentRole: 'reviewer',
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'high',
        ),
        _session(
          id: 'demo-approval',
          providerId: 'opencode',
          title: 'Ship the landing page',
          state: 'needs_approval',
          activity: now.subtract(const Duration(minutes: 11)),
          project: 'Marketing site',
          directory: r'C:\Projects\landing-page',
          preview:
              'The production build is ready. Permission is needed before deployment.',
        ),
        _session(
          id: 'demo-input',
          providerId: 'codex',
          title: 'Refine onboarding flow',
          state: 'needs_input',
          activity: now.subtract(const Duration(minutes: 28)),
          project: 'Mobile app',
          directory: r'C:\Projects\mobile-app',
          preview:
              'Waiting for a decision on which onboarding direction to use.',
        ),
        _session(
          id: 'demo-complete',
          providerId: 'opencode',
          title: 'Fix authentication regression',
          state: 'completed',
          activity: now.subtract(const Duration(hours: 3)),
          project: 'Account service',
          directory: r'C:\Projects\account-service',
          preview:
              'Fixed token refresh handling and added a focused regression test.',
        ),
        _session(
          id: 'demo-failed',
          providerId: 'grok',
          title: 'Upgrade desktop build',
          state: 'failed',
          activity: now.subtract(const Duration(days: 1, hours: 2)),
          project: 'Desktop client',
          directory: r'C:\Projects\desktop-client',
          preview:
              'The build stopped because a required Windows SDK component is missing.',
        ),
        _session(
          id: 'demo-codex-api',
          providerId: 'codex',
          title: 'Refactor API client',
          state: 'completed',
          activity: now.subtract(const Duration(minutes: 52)),
          project: 'Mobile app',
          directory: r'C:\Projects\mobile-app',
          preview: 'Simplified request retries and response parsing.',
        ),
        _session(
          id: 'demo-codex-audit',
          providerId: 'codex',
          title: 'Add audit logging',
          state: 'completed',
          activity: now.subtract(const Duration(hours: 2)),
          project: 'Account service',
          directory: r'C:\Projects\account-service',
          preview: 'Added structured audit events for account changes.',
        ),
        _session(
          id: 'demo-codex-tests',
          providerId: 'codex',
          title: 'Fix flaky integration tests',
          state: 'failed',
          activity: now.subtract(const Duration(hours: 5)),
          project: 'Test suite',
          directory: r'C:\Projects\test-suite',
          preview: 'One timing-sensitive test still needs investigation.',
        ),
        _session(
          id: 'demo-opencode-homepage',
          providerId: 'opencode',
          title: 'Fix homepage button workflow',
          state: 'working',
          activity: now.subtract(const Duration(minutes: 7)),
          project: 'Marketing site',
          directory: r'C:\Projects\landing-page',
          preview: 'Scanning the homepage flow and applying the button fix.',
        ),
        _session(
          id: 'demo-opencode-branch',
          providerId: 'opencode',
          title: 'Review branch changes',
          state: 'completed',
          activity: now.subtract(const Duration(minutes: 48)),
          project: 'Storefront',
          directory: r'C:\Projects\storefront',
          preview: 'Reviewed the branch and summarized the risky changes.',
        ),
        _session(
          id: 'demo-opencode-e2e',
          providerId: 'opencode',
          title: 'Add checkout end-to-end test',
          state: 'idle',
          activity: now.subtract(const Duration(hours: 2)),
          project: 'Storefront',
          directory: r'C:\Projects\storefront',
          preview: 'The browser flow is drafted and paused before checkout.',
        ),
        _session(
          id: 'demo-grok-runtime',
          providerId: 'grok',
          title: 'Optimize runtime startup',
          state: 'working',
          activity: now.subtract(const Duration(minutes: 5)),
          project: 'Desktop client',
          directory: r'C:\Projects\desktop-client',
          preview: 'Profiling startup and removing redundant initialization.',
        ),
        _session(
          id: 'demo-grok-cache',
          providerId: 'grok',
          title: 'Repair cache invalidation',
          state: 'completed',
          activity: now.subtract(const Duration(minutes: 36)),
          project: 'API service',
          directory: r'C:\Projects\api-service',
          preview: 'Fixed stale cache entries after background updates.',
        ),
        _session(
          id: 'demo-grok-search',
          providerId: 'grok',
          title: 'Improve project search',
          state: 'completed',
          activity: now.subtract(const Duration(hours: 2)),
          project: 'Desktop client',
          directory: r'C:\Projects\desktop-client',
          preview: 'Added fuzzy matching and keyboard navigation.',
        ),
        _session(
          id: 'demo-grok-release',
          providerId: 'grok',
          title: 'Prepare release notes',
          state: 'idle',
          activity: now.subtract(const Duration(hours: 4)),
          project: 'Platform',
          directory: r'C:\Projects\platform',
          preview: 'Drafted the release summary and paused for review.',
        ),
      ]);

    messages
      ..clear()
      ..addAll(<String, List<RemoteMessage>>{
        'demo-working': <RemoteMessage>[
          _message(
              'working-user',
              'demo-working',
              'user',
              now.subtract(const Duration(minutes: 6)),
              'Make a dev mode that previews the real phone UI without weakening production pairing.'),
          _message(
              'working-agent',
              'demo-working',
              'assistant',
              now.subtract(const Duration(minutes: 4)),
              'I am separating the in-memory data source from the bridge-backed store so both modes use the same screens.'),
        ],
        'demo-approval': <RemoteMessage>[
          _message(
              'approval-user',
              'demo-approval',
              'user',
              now.subtract(const Duration(minutes: 18)),
              'Build the landing page and prepare it for deployment.'),
          _message(
              'approval-agent',
              'demo-approval',
              'assistant',
              now.subtract(const Duration(minutes: 12)),
              'The build and smoke test passed. Deployment needs your approval.'),
        ],
        'demo-input': <RemoteMessage>[
          _message(
              'input-user',
              'demo-input',
              'user',
              now.subtract(const Duration(minutes: 35)),
              'Improve the first-run onboarding experience.'),
          _message(
              'input-agent',
              'demo-input',
              'assistant',
              now.subtract(const Duration(minutes: 29)),
              'I have two viable directions and need your product preference before changing the flow.'),
        ],
        'demo-complete': <RemoteMessage>[
          _message(
              'complete-user',
              'demo-complete',
              'user',
              now.subtract(const Duration(hours: 4)),
              'Find and fix the sign-in loop.'),
          _message(
              'complete-agent',
              'demo-complete',
              'assistant',
              now.subtract(const Duration(hours: 3)),
              'Fixed the refresh race and verified the regression test passes.'),
        ],
        'demo-failed': <RemoteMessage>[
          _message(
              'failed-user',
              'demo-failed',
              'user',
              now.subtract(const Duration(days: 1, hours: 3)),
              'Upgrade the desktop build dependencies.'),
          RemoteMessage(
            id: 'failed-agent',
            sessionId: 'demo-failed',
            role: 'assistant',
            createdAt: now.subtract(const Duration(days: 1, hours: 2)),
            parts: const <ContentPart>[
              ContentPart(type: 'error', data: <String, Object?>{
                'message': 'Windows SDK 10.0.26100 was not found.'
              }),
            ],
            status: 'failed',
          ),
        ],
      });

    for (final session in sessions) {
      messages.putIfAbsent(
        session.id,
        () => <RemoteMessage>[
          _message(
            '${session.id}-preview',
            session.id,
            'assistant',
            session.lastActivityAt,
            session.preview ??
                'This session is available in development preview.',
          ),
        ],
      );
    }

    events
      ..clear()
      ..addAll(<String, List<AgentEvent>>{
        'demo-working': <AgentEvent>[
          AgentEvent(
            eventId: 'event-tool',
            sequence: 1,
            type: 'tool.started',
            occurredAt: now.subtract(const Duration(minutes: 1)),
            sessionId: 'demo-working',
            providerId: 'codex',
            payload: const <String, Object?>{
              'text': 'Running Flutter analyzer'
            },
          ),
        ],
      });

    approvals
      ..clear()
      ..addAll(const <String, ApprovalRequest>{
        'demo-deploy-approval': ApprovalRequest(
          requestId: 'demo-deploy-approval',
          sessionId: 'demo-approval',
          providerId: 'opencode',
          title: 'Deploy the production site?',
          reason: 'This will publish the newly built landing page.',
          command: 'npm run deploy -- --production',
          workingDirectory: r'C:\Projects\landing-page',
          affectedFiles: <String>[],
          networkDestinations: <String>['deploy.example.com'],
          choices: <ApprovalChoice>[
            ApprovalChoice(id: 'approve', label: 'Approve', kind: 'approve'),
            ApprovalChoice(id: 'reject', label: 'Reject', kind: 'reject'),
          ],
        ),
      });
    userInputs
      ..clear()
      ..addAll(const <String, UserInputRequest>{
        'demo-onboarding-input': UserInputRequest(
          requestId: 'demo-onboarding-input',
          sessionId: 'demo-input',
          title: 'Choose an onboarding direction',
          prompt:
              'Should the first run be a short guided tour or a single setup checklist?',
          request: <String, Object?>{
            'type': 'choice',
            'options': <String>['Guided tour', 'Setup checklist'],
          },
        ),
      });

    connectionState = BridgeConnectionState.online;
    lastSuccessfulRefresh = now;
    initialized = true;
    notifyListeners();
  }

  @override
  Future<void> connectHost(PairedHost host) async {
    activeHost = host;
    connectionState = BridgeConnectionState.online;
    notifyListeners();
  }

  @override
  Future<void> removeHost(String hostId) async {
    error = 'The development preview host is always available in demo mode.';
    notifyListeners();
  }

  @override
  Future<void> reconnectProvider(String providerId) async {
    final index =
        providers.indexWhere((provider) => provider.providerId == providerId);
    if (index < 0) return;
    final provider = providers[index];
    providers[index] = ProviderConnection(
      providerId: provider.providerId,
      displayName: provider.displayName,
      state: provider.detected ? 'online' : provider.state,
      detected: provider.detected,
      authenticated: provider.detected ? true : provider.authenticated,
      capabilities: provider.capabilities,
    );
    notifyListeners();
  }

  @override
  Future<void> refresh() async {
    refreshing = true;
    error = null;
    notifyListeners();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    refreshing = false;
    lastSuccessfulRefresh = DateTime.now();
    notifyListeners();
  }

  @override
  Future<List<RemoteModel>> loadModels(
    String providerId, {
    bool force = false,
  }) async {
    final models = <RemoteModel>[
      RemoteModel(
        id: providerId == 'codex' ? 'gpt-5.6-sol' : '$providerId/default',
        providerId: providerId,
        displayName: switch (providerId) {
          'codex' => 'GPT-5.6 Sol',
          'opencode' => 'Default OpenCode model',
          'grok' => 'Grok Code',
          _ => 'Default model',
        },
        isDefault: true,
        nativeMetadata: providerId == 'codex'
            ? const <String, Object?>{
                'supportedReasoningEfforts': <Object?>[
                  <String, Object?>{'reasoningEffort': 'low'},
                  <String, Object?>{'reasoningEffort': 'medium'},
                  <String, Object?>{'reasoningEffort': 'high'},
                  <String, Object?>{'reasoningEffort': 'ultra'},
                ],
                'defaultReasoningEffort': 'medium',
              }
            : const <String, Object?>{},
      ),
    ];
    modelsByProvider[providerId] = models;
    notifyListeners();
    return models;
  }

  @override
  Future<List<RemoteSession>> loadChildSessions(String parentSessionId) async =>
      childSessionsFor(parentSessionId);

  @override
  Future<void> openSession(RemoteSession session) async {
    selectedSession = session;
    unreadSessionIds.remove(session.id);
    notifyListeners();
  }

  @override
  Future<void> loadSessionHistoryFor(RemoteSession session) async {}

  @override
  void openSessionForView(RemoteSession session) {
    unawaited(openSession(session));
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
    final trimmed = content.trim();
    if (trimmed.isEmpty) return;
    final visibleContent = simplifyVisibleContent(trimmed);
    drafts[sessionId] = '';
    draftAttachments.remove(sessionId);
    draftSimplifySettings.remove(sessionId);
    messages.putIfAbsent(sessionId, () => <RemoteMessage>[]).add(
          _message('demo-user-${DateTime.now().microsecondsSinceEpoch}',
              sessionId, 'user', DateTime.now(), visibleContent),
        );
    _setSessionState(sessionId, 'working');
    notifyListeners();
    await Future<void>.delayed(const Duration(milliseconds: 350));
    messages[sessionId]!.add(
      _message(
        'demo-agent-${DateTime.now().microsecondsSinceEpoch}',
        sessionId,
        'assistant',
        DateTime.now(),
        'This is a local preview response. In production, the same composer sends this instruction through the paired bridge.',
      ),
    );
    _setSessionState(sessionId, 'idle');
    notifyListeners();
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
    if (isPreparedSession(sessionId)) {
      return await super.submitMessage(
        sessionId,
        content,
        deliveryMode: deliveryMode,
        modelId: modelId,
        reasoningEffort: reasoningEffort,
        attachments: attachments,
        simplify: simplify,
      );
    }
    final session = sessions.where((item) => item.id == sessionId).firstOrNull;
    if (session?.state == 'working' && deliveryMode == 'queue') {
      final now = DateTime.now();
      final id = 'demo-queue-${now.microsecondsSinceEpoch}';
      queuedMessages[id] = RemoteQueuedMessage(
        id: id,
        sessionId: sessionId,
        content: simplifyVisibleContent(content),
        state: 'queued',
        createdAt: now,
        modelId: modelId,
        reasoningEffort: reasoningEffort,
        attachments: attachments
            .map((attachment) => RemoteQueuedAttachment(
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  byteLength: attachment.byteLength,
                  dataBase64: attachment.dataBase64,
                ))
            .toList(growable: false),
      );
      drafts[sessionId] = '';
      draftAttachments.remove(sessionId);
      draftSimplifySettings.remove(sessionId);
      notifyListeners();
      return null;
    }
    await sendMessage(
      sessionId,
      content,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      attachments: attachments,
      simplify: simplify,
    );
    return null;
  }

  @override
  Future<void> cancelQueuedMessage(String messageId) async {
    queuedMessages.remove(messageId);
    notifyListeners();
  }

  @override
  Future<RemoteQueuedMessage> editQueuedMessage(
      RemoteQueuedMessage message, String content) async {
    final updated = RemoteQueuedMessage(
      id: message.id,
      sessionId: message.sessionId,
      content: content.trim(),
      state: message.state,
      createdAt: message.createdAt,
      attachments: message.attachments,
      modelId: message.modelId,
      reasoningEffort: message.reasoningEffort,
      error: message.error,
    );
    queuedMessages[message.id] = updated;
    notifyListeners();
    return updated;
  }

  @override
  Future<void> deliverQueuedMessage(RemoteQueuedMessage message,
      {required String mode}) async {
    queuedMessages.remove(message.id);
    await sendMessage(message.sessionId, message.content,
        modelId: message.modelId, reasoningEffort: message.reasoningEffort);
  }

  @override
  Future<List<RemoteSession>> loadSideChats({String? parentSessionId}) async =>
      parentSessionId == null
          ? sessions
              .where((session) => session.sessionKind == 'side_chat')
              .toList(growable: false)
          : sideChatsFor(parentSessionId);

  @override
  Future<RemoteSession> createSideChat(
    String parentSessionId, {
    String? prompt,
    String? queuedMessageId,
  }) async {
    final parent =
        sessions.where((session) => session.id == parentSessionId).firstOrNull;
    if (parent == null) throw StateError('Task is no longer available');
    final now = DateTime.now();
    final id = 'demo-side-chat-${now.microsecondsSinceEpoch}';
    final initial = prompt?.trim() ?? '';
    final sideChat = _session(
      id: id,
      providerId: parent.providerId,
      title: initial.isEmpty ? 'Side chat' : initial,
      state: 'idle',
      activity: now,
      project: parent.project ?? 'Side chat',
      directory: parent.workingDirectory ?? '',
      preview: initial,
      modelId: parent.modelId,
      reasoningEffort: parent.reasoningEffort,
      parentSessionId: parent.id,
      sessionKind: 'side_chat',
    );
    sessions.add(sideChat);
    messages[id] = <RemoteMessage>[
      if (initial.isNotEmpty)
        _message('demo-side-chat-user', id, 'user', now, initial),
    ];
    if (queuedMessageId != null) queuedMessages.remove(queuedMessageId);
    notifyListeners();
    return sideChat;
  }

  @override
  Future<RemoteSession> promoteSideChat(String sessionId) async {
    final current =
        sessions.where((session) => session.id == sessionId).firstOrNull;
    if (current == null || current.sessionKind != 'side_chat') {
      throw StateError('Side chat is no longer available');
    }
    final promoted = RemoteSession(
      id: current.id,
      hostId: current.hostId,
      providerId: current.providerId,
      providerSessionId: current.providerSessionId,
      title: current.title,
      state: current.state,
      lastActivityAt: DateTime.now(),
      needsApproval: current.needsApproval,
      stale: current.stale,
      project: current.project,
      workingDirectory: current.workingDirectory,
      preview: current.preview,
      modelId: current.modelId,
      reasoningEffort: current.reasoningEffort,
      variantId: current.variantId,
      sessionKind: 'task',
    );
    final index = sessions.indexWhere((session) => session.id == sessionId);
    sessions[index] = promoted;
    selectedSession = promoted;
    notifyListeners();
    return promoted;
  }

  @override
  Future<void> editMessage(
    String sessionId,
    RemoteMessage message,
    String content, {
    String? modelId,
    String? reasoningEffort,
  }) async {
    final history = messages[sessionId] ?? <RemoteMessage>[];
    final index = history.indexWhere((item) => item.id == message.id);
    if (index < 0 || !message.editable) {
      throw StateError('That message is not editable');
    }
    messages[sessionId] = <RemoteMessage>[
      ...history.take(index),
      _message('demo-edited-${DateTime.now().microsecondsSinceEpoch}',
          sessionId, 'user', DateTime.now(), content.trim()),
    ];
    _setSessionState(sessionId, 'working');
    notifyListeners();
  }

  @override
  Future<void> setDefaultDeliveryMode(String mode) async {
    if (mode != 'queue' && mode != 'steer') return;
    defaultDeliveryMode = mode;
    notifyListeners();
  }

  @override
  Future<void> setDictationDictionary(Iterable<String> entries) async {
    dictationDictionary
      ..clear()
      ..addAll(entries
          .map((entry) => entry.trim())
          .where((entry) => entry.isNotEmpty)
          .take(100));
    notifyListeners();
  }

  @override
  Future<void> setDictationSource(String sourceId) async {
    await setDictationSourceForHarness(
        selectedSession?.providerId ?? selectedProviderId, sourceId);
  }

  @override
  Future<void> setDictationSourceForHarness(
      String harnessId, String sourceId) async {
    if (!dictationSources
        .any((source) => source.id == sourceId && source.isReady)) {
      throw StateError('That speech-to-text source is not ready');
    }
    dictationSourcePreferences[harnessId.trim().toLowerCase()] = sourceId;
    preferredDictationSourceId = sourceId;
    notifyListeners();
  }

  @override
  Future<String> transcribeDictation(List<int> waveBytes,
          {String? sourceId}) async =>
      'Demo dictation transcript';

  @override
  Future<RemoteSession> createSession({
    required String providerId,
    required String workingDirectory,
    required String firstInstruction,
    String? modelId,
    String? reasoningEffort,
    String? title,
  }) async {
    final now = DateTime.now();
    final id = 'demo-created-${now.microsecondsSinceEpoch}';
    final session = _session(
      id: id,
      providerId: providerId,
      title: title?.trim().isNotEmpty == true
          ? title!.trim()
          : 'New development session',
      state: 'working',
      activity: now,
      project: workingDirectory.trim().isEmpty
          ? 'New project'
          : workingDirectory.trim(),
      directory: workingDirectory.trim().isEmpty
          ? r'C:\Projects\new-project'
          : workingDirectory.trim(),
      preview: firstInstruction.trim().isEmpty
          ? 'New session created in demo mode.'
          : firstInstruction.trim(),
      modelId: modelId?.trim().isEmpty == true ? null : modelId?.trim(),
      reasoningEffort: reasoningEffort?.trim().isEmpty == true
          ? null
          : reasoningEffort?.trim(),
    );
    sessions.add(session);
    messages[id] = <RemoteMessage>[
      _message(
          'demo-created-user',
          id,
          'user',
          now,
          firstInstruction.trim().isEmpty
              ? 'Start a new task.'
              : firstInstruction.trim()),
      _message('demo-created-agent', id, 'assistant', now,
          'The preview session is ready. No bridge or provider was contacted.'),
    ];
    selectedSession = session;
    notifyListeners();
    return session;
  }

  @override
  Future<void> interrupt(String sessionId) async {
    _setSessionState(sessionId, 'idle');
    events.putIfAbsent(sessionId, () => <AgentEvent>[]).add(
          AgentEvent(
            eventId: 'demo-interrupt-${DateTime.now().microsecondsSinceEpoch}',
            sequence: events[sessionId]?.length ?? 0,
            type: 'agent.interrupted',
            occurredAt: DateTime.now(),
            sessionId: sessionId,
            payload: const <String, Object?>{
              'message': 'Work interrupted in development preview.'
            },
          ),
        );
    notifyListeners();
  }

  @override
  Future<void> respondToApproval(
      ApprovalRequest approval, String choiceId) async {
    final choice =
        approval.choices.where((item) => item.id == choiceId).firstOrNull;
    approvals.remove(approval.requestId);
    _setSessionState(
        approval.sessionId, choice?.kind == 'reject' ? 'idle' : 'working');
    events.putIfAbsent(approval.sessionId, () => <AgentEvent>[]).add(
          AgentEvent(
            eventId: 'demo-approval-${DateTime.now().microsecondsSinceEpoch}',
            sequence: events[approval.sessionId]?.length ?? 0,
            type: 'approval.resolved',
            occurredAt: DateTime.now(),
            sessionId: approval.sessionId,
            providerId: approval.providerId,
            payload: <String, Object?>{
              'requestId': approval.requestId,
              'choiceId': choiceId
            },
          ),
        );
    notifyListeners();
  }

  @override
  Future<void> respondToUserInput(
      UserInputRequest request, JsonMap answers) async {
    userInputs.remove(request.requestId);
    _setSessionState(request.sessionId, 'working');
    messages.putIfAbsent(request.sessionId, () => <RemoteMessage>[]).add(
          _message(
            'demo-input-${DateTime.now().microsecondsSinceEpoch}',
            request.sessionId,
            'user',
            DateTime.now(),
            'Submitted: ${jsonEncode(answers)}',
          ),
        );
    notifyListeners();
  }

  RemoteSession _session({
    required String id,
    required String providerId,
    required String title,
    required String state,
    required DateTime activity,
    required String project,
    required String directory,
    required String preview,
    String? modelId,
    String? reasoningEffort,
    String? variantId,
    String? parentSessionId,
    String? agentNickname,
    String? agentRole,
    String sessionKind = 'task',
  }) {
    return RemoteSession(
      id: id,
      hostId: _hostId,
      providerId: providerId,
      providerSessionId: '$providerId-$id',
      title: title,
      state: state,
      lastActivityAt: activity,
      needsApproval: state == 'needs_approval',
      stale: false,
      project: project,
      workingDirectory: directory,
      preview: preview,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      variantId: variantId,
      parentSessionId: parentSessionId,
      agentNickname: agentNickname,
      agentRole: agentRole,
      sessionKind: sessionKind,
    );
  }

  RemoteMessage _message(String id, String sessionId, String role,
      DateTime createdAt, String text) {
    return RemoteMessage(
      id: id,
      sessionId: sessionId,
      role: role,
      createdAt: createdAt,
      parts: <ContentPart>[
        ContentPart(type: 'text', data: <String, Object?>{'text': text}),
      ],
      status: 'completed',
      editable: role == 'user',
      providerMessageId: id,
    );
  }

  void _setSessionState(String sessionId, String state) {
    final index = sessions.indexWhere((session) => session.id == sessionId);
    if (index < 0) return;
    final current = sessions[index];
    sessions[index] = current.copyWith(
      state: state,
      lastActivityAt: DateTime.now(),
      needsApproval: state == 'needs_approval',
    );
    if (selectedSession?.id == sessionId) selectedSession = sessions[index];
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
