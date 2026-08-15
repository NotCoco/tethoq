import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import 'desktop_wake.dart';
import 'json.dart';
import 'models.dart';
import 'security.dart';
import 'transport.dart';

const String availableAgentsTaskFilter = '@available-agents';

const Set<String> _sessionStates = <String>{
  'idle',
  'working',
  'needs_input',
  'needs_approval',
  'completed',
  'failed',
  'disconnected',
  'unknown',
};

const Set<String> _unreadEventTypes = <String>{
  'approval.requested',
  'user_input.requested',
  'agent.completed',
  'agent.error',
};

const String _pairingConnectionError =
    'The secure connection to this computer could not be reached. '
    'Generate a new connection code, check that both devices are online, '
    'then scan it again.';

// The phone reflects only providers and transcription sources advertised by the
// paired host. Tethoq decides what it ships at that host boundary; the remote
// client must not apply provider-name policy to independently installed
// connectors.
bool _isMobileProviderEnabled(String providerId) =>
    providerId.trim().isNotEmpty;

bool _isMobileDictationSourceEnabled(TranscriptionSource source) =>
    source.id.trim().isNotEmpty;

bool _isPairingConnectionError(Object error) {
  if (error is SocketException ||
      error is WebSocketException ||
      error is HandshakeException ||
      error is TlsException ||
      error is HttpException ||
      error is TimeoutException) {
    return true;
  }
  if (error is BridgeRequestException) {
    return error.retryable ||
        error.code == 'TIMEOUT' ||
        error.code == 'TRANSPORT_ERROR';
  }
  return false;
}

const Set<String> _nonConversationEventTypes = <String>{
  'session.status_changed',
  'message.started',
  'message.delta',
  'message.completed',
  'message.queued',
  'message.queue_updated',
  'message.queue_removed',
  'agent.completed',
  'agent.interrupted',
  'approval.requested',
  'approval.resolved',
  'user_input.requested',
};

const int _maxRetainedEventsPerSession = 200;
const Duration _liveDeltaNotificationInterval = Duration(milliseconds: 16);

typedef BridgeTransportFactory = BridgeTransport Function(
    BridgeEndpoint endpoint, DeviceSecurity security);

class RemoteAppStore extends ChangeNotifier {
  RemoteAppStore(
      {DeviceSecurity? security, BridgeTransportFactory? transportFactory})
      : security = security ?? DeviceSecurity(),
        _transportFactory = transportFactory ??
            ((endpoint, security) =>
                BridgeTransport(endpoint: endpoint, security: security));

  final DeviceSecurity security;
  final BridgeTransportFactory _transportFactory;
  final List<PairedHost> hosts = <PairedHost>[];
  final List<RemoteSession> sessions = <RemoteSession>[];
  final List<ProviderConnection> providers = <ProviderConnection>[];
  final List<PairedDevice> pairedDevices = <PairedDevice>[];
  final Map<String, List<RemoteMessage>> messages =
      <String, List<RemoteMessage>>{};
  final Map<String, List<RemoteModel>> modelsByProvider =
      <String, List<RemoteModel>>{};
  final Map<String, ProviderWalletStatus> walletByModel =
      <String, ProviderWalletStatus>{};
  final Map<String, String> handoffSummaries = <String, String>{};
  final List<String> recentModelKeys = <String>[];
  final Map<String, VisionProxyStatus> visionBySession =
      <String, VisionProxyStatus>{};
  final Map<String, SessionContextState> contextBySession =
      <String, SessionContextState>{};
  final Map<String, RemoteQueuedMessage> queuedMessages =
      <String, RemoteQueuedMessage>{};
  final Map<String, RemoteDelegationTask> delegations =
      <String, RemoteDelegationTask>{};
  final Map<String, DelegationSelection> delegationPreferences =
      <String, DelegationSelection>{};
  final Map<String, String> _liveAssistantText = <String, String>{};
  final Map<String, String> _liveAssistantReasoning = <String, String>{};
  final Map<String, DateTime> _liveAssistantStartedAt = <String, DateTime>{};
  final Set<String> _historySyncs = <String>{};
  final Set<String> _sessionHistoryLoads = <String>{};
  final Set<String> _olderHistoryLoads = <String>{};
  final Map<String, String?> _historyCursors = <String, String?>{};
  final Set<String> _childSessionLoads = <String>{};
  final Map<String, List<AgentEvent>> events = <String, List<AgentEvent>>{};
  final Map<String, int> _lastEventSequenceBySession = <String, int>{};
  final Map<String, Future<List<RemoteModel>>> _modelLoads =
      <String, Future<List<RemoteModel>>>{};
  final Map<String, ApprovalRequest> approvals = <String, ApprovalRequest>{};
  final Map<String, UserInputRequest> userInputs = <String, UserInputRequest>{};
  final Map<String, String> drafts = <String, String>{};
  final Set<String> unreadSessionIds = <String>{};
  final List<String> dictationDictionary = <String>[];
  final List<TranscriptionSource> dictationSources = <TranscriptionSource>[];
  final Map<String, String> dictationSourcePreferences = <String, String>{};
  final Set<String> _dismissedImageModelNoticeKeys = <String>{};
  final Map<String, DateTime> _lastReadAt = <String, DateTime>{};
  final Set<String> _preparedSessionIds = <String>{};

  BridgeTransport? _transport;
  StreamSubscription<AgentEvent>? _eventSubscription;
  StreamSubscription<BridgeConnectionState>? _stateSubscription;
  StreamSubscription<void>? _replayGapSubscription;
  Future<void> _readStateWrites = Future<void>.value();
  Future<void> _recentModelWrites = Future<void>.value();
  Future<void>? _reconnectRecovery;
  Object? _reconnectRecoveryToken;
  Timer? _liveDeltaNotificationTimer;
  bool _reconnectRecoveryRequested = false;
  int _transportEpoch = 0;
  bool _hasReadState = false;
  String? _visibleSessionId;
  PairedHost? activeHost;
  RemoteSession? selectedSession;
  BridgeConnectionState connectionState = BridgeConnectionState.disconnected;
  bool initialized = false;
  bool refreshing = false;
  String? error;
  DateTime? lastSuccessfulRefresh;
  final Set<String> _providerFilters = <String>{};
  String? stateFilter;
  String selectedProviderId = 'codex';
  String query = '';
  String defaultDeliveryMode = 'queue';
  String? preferredDictationSourceId;

  bool get hasHosts => hosts.isNotEmpty;

  Set<String> get providerFilters => Set<String>.unmodifiable(_providerFilters);

  String? get providerFilter => _providerFilters.length == 1 &&
          !_providerFilters.contains(availableAgentsTaskFilter)
      ? _providerFilters.single
      : null;

  bool get hasProviderFilters => _providerFilters.isNotEmpty;

  bool taskProviderFilterSelected(String providerId) =>
      _providerFilters.contains(providerId);

  bool isProviderUsableForTasks(ProviderConnection provider) =>
      provider.detected &&
      provider.state.toLowerCase() == 'online' &&
      provider.authenticated != false;

  List<TranscriptionSource> get readyDictationSources =>
      dictationSources.where(isDictationSourceReady).toList(growable: false);

  bool isDictationSourceReady(TranscriptionSource source) =>
      source.isReady &&
      source.supportsBatch &&
      _isMobileDictationSourceEnabled(source);

  String? preferredDictationSourceIdForHarness(String harnessId) =>
      dictationSourcePreferences[harnessId.trim().toLowerCase()];

  TranscriptionSource? dictationSourceForHarness(String harnessId) {
    final normalizedHarnessId = harnessId.trim().toLowerCase();
    final preferredId = dictationSourcePreferences[normalizedHarnessId];
    if (preferredId != null) {
      return readyDictationSources
          .where((source) => source.id == preferredId)
          .firstOrNull;
    }
    final defaultSourceId = switch (normalizedHarnessId) {
      'codex' => 'openai-stt',
      'grok' => 'xai-stt',
      _ => null,
    };
    if (defaultSourceId == null) return null;
    return readyDictationSources
            .where((source) => source.id == defaultSourceId)
            .firstOrNull ??
        readyDictationSources.firstOrNull;
  }

  TranscriptionSource? get selectedDictationSource => dictationSourceForHarness(
      selectedSession?.providerId ?? selectedProviderId);

  bool isPreparedSession(String sessionId) =>
      _preparedSessionIds.contains(sessionId);

  RemoteSession prepareSession(String providerId) {
    if (!_isMobileProviderEnabled(providerId)) {
      throw StateError('That harness is not available');
    }
    final provider = providers
        .where((item) =>
            item.providerId == providerId &&
            item.detected &&
            item.capabilities.createSession)
        .firstOrNull;
    if (provider == null)
      throw StateError('That harness cannot start a session');
    final now = DateTime.now();
    final id = 'prepared-$providerId-${now.microsecondsSinceEpoch}';
    final session = RemoteSession(
      id: id,
      hostId: activeHost?.hostId ?? 'local',
      providerId: providerId,
      providerSessionId: id,
      title: 'New task',
      state: 'idle',
      lastActivityAt: now,
      needsApproval: false,
      stale: false,
      workingDirectory: '',
    );
    _preparedSessionIds.add(id);
    sessions.add(session);
    messages[id] = <RemoteMessage>[];
    selectedSession = session;
    notifyListeners();
    return session;
  }

  Future<RemoteSession> startPreparedSession(String providerId) async {
    final session = prepareSession(providerId);
    unawaited(loadModels(providerId));
    return session;
  }

  void updatePreparedDirectory(String sessionId, String directory) {
    if (!_preparedSessionIds.contains(sessionId)) return;
    final index = sessions.indexWhere((item) => item.id == sessionId);
    if (index < 0) return;
    sessions[index] = sessions[index].copyWith(workingDirectory: directory);
    selectedSession = sessions[index];
  }

  void updatePreparedProvider(String sessionId, String providerId) {
    if (!_preparedSessionIds.contains(sessionId)) return;
    if (!_isMobileProviderEnabled(providerId)) {
      throw StateError('That agent is not available');
    }
    final provider = providers
        .where((item) =>
            item.providerId == providerId &&
            item.detected &&
            item.capabilities.createSession)
        .firstOrNull;
    if (provider == null) throw StateError('That agent cannot start a task');
    final index = sessions.indexWhere((item) => item.id == sessionId);
    if (index < 0) return;
    final current = sessions[index];
    if (current.providerId == providerId) return;
    final updated = RemoteSession(
      id: current.id,
      hostId: current.hostId,
      providerId: providerId,
      providerSessionId: current.providerSessionId,
      title: 'New task',
      state: current.state,
      lastActivityAt: DateTime.now(),
      needsApproval: current.needsApproval,
      stale: current.stale,
      workingDirectory: current.workingDirectory,
    );
    sessions[index] = updated;
    selectedSession = updated;
    unawaited(loadModels(providerId));
    notifyListeners();
  }

  void discardPreparedSession(String sessionId) {
    if (!_preparedSessionIds.remove(sessionId)) return;
    sessions.removeWhere((item) => item.id == sessionId);
    messages.remove(sessionId);
    contextBySession.remove(sessionId);
    drafts.remove(sessionId);
    if (selectedSession?.id == sessionId) selectedSession = null;
    notifyListeners();
  }

  List<RemoteDelegationTask> delegationsFor(String parentSessionId) {
    final result = delegations.values
        .where((task) => task.parentSessionId == parentSessionId)
        .toList();
    result.sort((left, right) => left.createdAt.compareTo(right.createdAt));
    return result;
  }

  bool isSessionUnread(String sessionId) =>
      unreadSessionIds.contains(sessionId);

  bool isSessionHistoryLoading(String sessionId) =>
      _sessionHistoryLoads.contains(sessionId);

  @visibleForTesting
  void beginSessionHistoryLoadForTesting(String sessionId) {
    _sessionHistoryLoads.add(sessionId);
    notifyListeners();
  }

  @visibleForTesting
  void endSessionHistoryLoadForTesting(String sessionId) {
    if (_sessionHistoryLoads.remove(sessionId)) notifyListeners();
  }

  bool isOlderHistoryLoading(String sessionId) =>
      _olderHistoryLoads.contains(sessionId);

  bool hasOlderHistory(String sessionId) =>
      _historyCursors.containsKey(sessionId) &&
      _historyCursors[sessionId] != null;

  bool isImageModelNoticeDismissed(String providerId, String modelId) =>
      _dismissedImageModelNoticeKeys.contains('$providerId:$modelId');

  void dismissImageModelNotice(String providerId, String modelId) {
    _dismissedImageModelNoticeKeys.add('$providerId:$modelId');
  }

  RemoteMessage? liveAssistantMessageFor(String sessionId) {
    final reasoning = _liveAssistantReasoning[sessionId]?.trim() ?? '';
    final text = _liveAssistantText[sessionId]?.trim() ?? '';
    if (reasoning.isEmpty && text.isEmpty) return null;
    return RemoteMessage(
      id: 'live-assistant-$sessionId',
      sessionId: sessionId,
      role: 'assistant',
      createdAt: _liveAssistantStartedAt[sessionId] ?? DateTime.now(),
      parts: <ContentPart>[
        if (reasoning.isNotEmpty)
          ContentPart(
              type: 'reasoning', data: <String, Object?>{'text': reasoning}),
        if (text.isNotEmpty)
          ContentPart(type: 'text', data: <String, Object?>{'text': text}),
      ],
      status: 'streaming',
    );
  }

  String? latestReasoningArtifactFor(String sessionId) {
    final live = liveAssistantMessageFor(sessionId);
    final liveArtifact = live == null ? null : _latestArtifactIn(live);
    if (liveArtifact != null) return liveArtifact;
    final history = messages[sessionId] ?? const <RemoteMessage>[];
    for (final message in history.reversed) {
      final artifact = _latestArtifactIn(message);
      if (artifact != null) return artifact;
    }
    return null;
  }

  List<RemoteSession> get visibleSessions {
    if (activeHost == null && hosts.isNotEmpty) {
      return const <RemoteSession>[];
    }
    final needle = query.trim().toLowerCase();
    final usableProviderIds = providers
        .where(isProviderUsableForTasks)
        .map((provider) => provider.providerId)
        .toSet();
    final result = sessions.where((session) {
      if (!_isMobileProviderEnabled(session.providerId)) return false;
      final hostId = activeHost?.hostId;
      if (hostId != null && session.hostId != hostId) return false;
      if (session.parentSessionId != null) return false;
      if (_providerFilters.isNotEmpty &&
          !_providerFilters.any((providerId) =>
              providerId == availableAgentsTaskFilter
                  ? usableProviderIds.contains(session.providerId)
                  : session.providerId == providerId)) {
        return false;
      }
      if (stateFilter != null && session.state != stateFilter) return false;
      if (needle.isNotEmpty) {
        final haystack =
            '${session.title} ${session.project ?? ''} ${session.preview ?? ''}'
                .toLowerCase();
        if (!haystack.contains(needle)) return false;
      }
      return true;
    }).toList();
    result.sort(
        (left, right) => right.lastActivityAt.compareTo(left.lastActivityAt));
    return result;
  }

  List<RemoteSession> childSessionsFor(String parentSessionId) {
    if (activeHost == null && hosts.isNotEmpty) {
      return const <RemoteSession>[];
    }
    final hostId = activeHost?.hostId;
    if (hostId != null &&
        !sessions.any((session) =>
            session.id == parentSessionId && session.hostId == hostId)) {
      return const <RemoteSession>[];
    }
    final result = sessions
        .where((session) =>
            _isMobileProviderEnabled(session.providerId) &&
            session.parentSessionId == parentSessionId &&
            (hostId == null || session.hostId == hostId))
        .toList();
    result.sort(
        (left, right) => right.lastActivityAt.compareTo(left.lastActivityAt));
    return result;
  }

  bool providerSupportsSessionRelationships(String providerId) {
    final matches = providers.where((item) => item.providerId == providerId);
    return matches.isNotEmpty &&
        matches.first.capabilities.sessionRelationships;
  }

  bool providerSupportsSteering(String providerId) {
    final matches = providers.where((item) => item.providerId == providerId);
    return matches.isNotEmpty && matches.first.capabilities.steering;
  }

  bool providerSupportsMessageEditing(String providerId) {
    final matches = providers.where((item) => item.providerId == providerId);
    return matches.isNotEmpty && matches.first.capabilities.messageEditing;
  }

  List<RemoteQueuedMessage> queuedMessagesFor(String sessionId) {
    final result = queuedMessages.values
        .where((message) => message.sessionId == sessionId)
        .toList(growable: false);
    result.sort((left, right) => left.createdAt.compareTo(right.createdAt));
    return result;
  }

  Future<void> initialize() async {
    try {
      defaultDeliveryMode = await security.readDefaultDeliveryMode();
      dictationDictionary
        ..clear()
        ..addAll(await security.readDictationDictionary());
      preferredDictationSourceId = await security.readDictationSourceId();
      dictationSourcePreferences
        ..clear()
        ..addAll(await security.readDictationSourcePreferences());
      recentModelKeys
        ..clear()
        ..addAll(await security.readRecentModelKeys());
      delegationPreferences
        ..clear()
        ..addEntries((await security.readDelegationPreferences()).entries.where(
            (entry) => _isMobileProviderEnabled(entry.value.providerId)));
      hosts
        ..clear()
        ..addAll(await security.readHosts());
      if (hosts.isNotEmpty) await connectHost(hosts.first);
    } on Object catch (caught) {
      error = caught.toString();
    } finally {
      initialized = true;
      notifyListeners();
    }
  }

  Future<void> pair({
    required String payloadText,
    required String confirmedShortCode,
    String? directUrl,
  }) async {
    error = null;
    notifyListeners();
    BridgeTransport? temporary;
    try {
      final payload = PairingPayload.fromJson(jsonDecode(payloadText));
      if (payload.expiresAt.isBefore(DateTime.now().toUtc()))
        throw StateError('Pairing payload has expired');
      final verificationCode = confirmedShortCode.trim();
      if (!RegExp(r'^\d{6}$').hasMatch(verificationCode)) {
        throw StateError('Enter the 6-digit code shown on the computer');
      }
      if (payload.shortCode != null && verificationCode != payload.shortCode) {
        throw StateError(
            'The verification code does not match the code shown on the computer');
      }
      final endpoint = payload.relayUrl ?? directUrl?.trim();
      if (endpoint == null || endpoint.isEmpty)
        throw StateError(
            'Enter the direct bridge WebSocket URL because this payload has no relay URL');
      validateBridgeEndpointUrl(endpoint);
      final identity = await security.createDeviceIdentity();
      temporary = _transportFactory(
        BridgeEndpoint(
          hostId: payload.hostId,
          url: endpoint,
          deviceId: identity.deviceId,
          relayToken: payload.relayToken,
        ),
        security,
      );
      await temporary.connect();
      final response = await temporary.request(
        'pairing.confirm',
        <String, Object?>{
          'pairingId': payload.pairingId,
          'secret': payload.secret,
          'shortCode': verificationCode,
          'deviceId': identity.deviceId,
          'devicePublicKeyPem': identity.publicKeyPem,
        },
        signed: false,
      );
      final credential = SignedCredential.fromJson(response);
      final credentialPayload =
          await security.verifyCredential(credential, payload.hostPublicKeyPem);
      if (credentialPayload['hostId'] != payload.hostId ||
          credentialPayload['deviceId'] != identity.deviceId) {
        throw const FormatException(
            'Issued credential does not match this host and device');
      }
      final host = PairedHost(
        hostId: payload.hostId,
        hostPublicKeyPem: payload.hostPublicKeyPem,
        endpoint: endpoint,
        deviceId: identity.deviceId,
        devicePrivateKey: identity.privateKeyBytes,
        devicePublicKey: identity.publicKeyBytes,
        credential: credential,
        relayToken: payload.relayToken,
      );
      await security.saveHost(host);
      hosts
        ..removeWhere((item) => item.hostId == host.hostId)
        ..add(host);
      await temporary.close();
      temporary = null;
      await connectHost(host);
    } on Object catch (caught) {
      error = _isPairingConnectionError(caught)
          ? _pairingConnectionError
          : caught.toString();
      rethrow;
    } finally {
      await temporary?.close();
      notifyListeners();
    }
  }

  Future<void> connectHost(PairedHost host) async {
    validateBridgeEndpointUrl(host.endpoint);
    await _detachTransport();
    final switchingHosts = activeHost?.hostId != host.hostId;
    activeHost = host;
    if (switchingHosts) {
      selectedSession = null;
      providers.clear();
      dictationSources.clear();
      pairedDevices.clear();
      queuedMessages.clear();
      delegations.clear();
      approvals.clear();
      userInputs.clear();
      modelsByProvider.clear();
      walletByModel.clear();
      handoffSummaries.clear();
      visionBySession.clear();
      contextBySession.clear();
      _modelLoads.clear();
      _preparedSessionIds.clear();
      sessions.removeWhere((session) => session.id.startsWith('prepared-'));
    }
    await _loadSessionReadState(host);
    final transport = _transportFactory(
      BridgeEndpoint(
        hostId: host.hostId,
        url: host.endpoint,
        deviceId: host.deviceId,
        relayToken: host.relayToken,
        pairedHost: host,
      ),
      security,
    );
    _transport = transport;
    final transportEpoch = _transportEpoch;
    var reachedOnline = false;
    var disconnectedAfterOnline = false;
    _eventSubscription = transport.events.listen(_applyEvent);
    _replayGapSubscription = transport.replayGaps.listen((_) {
      _requestReconnectRecovery(transport, host.hostId, transportEpoch);
    });
    _stateSubscription = transport.states.listen((state) {
      if (_transport != transport || _transportEpoch != transportEpoch) return;
      connectionState = state;
      notifyListeners();
      if (state == BridgeConnectionState.online) {
        if (reachedOnline && disconnectedAfterOnline) {
          _requestReconnectRecovery(transport, host.hostId, transportEpoch);
        }
        reachedOnline = true;
        disconnectedAfterOnline = false;
      } else if (reachedOnline &&
          (state == BridgeConnectionState.reconnecting ||
              state == BridgeConnectionState.disconnected)) {
        disconnectedAfterOnline = true;
      }
    });
    await transport.connect();
    await Future.wait(<Future<void>>[
      _loadHostMetadata(),
      refresh(),
    ]);
    await Future.wait(<Future<void>>[
      _loadQueuedMessages(),
      _loadDelegations(),
      _loadApprovals(),
      _loadUserInputs(),
      _loadDictationSources(),
    ]);
  }

  Future<void> setDefaultDeliveryMode(String mode) async {
    if (mode != 'queue' && mode != 'steer') return;
    defaultDeliveryMode = mode;
    notifyListeners();
    await security.saveDefaultDeliveryMode(mode);
  }

  Future<DesktopAppState> desktopStatus() => _desktopWakeCoordinator().status();

  Future<DesktopWakeResult> wakeDesktop() => _desktopWakeCoordinator().wake();

  DesktopWakeCoordinator _desktopWakeCoordinator() {
    final transport = _requireTransport();
    return DesktopWakeCoordinator(
      request: (type, payload, {required timeout}) =>
          transport.request(type, payload, timeout: timeout),
    );
  }

  Future<void> setDictationDictionary(Iterable<String> entries) async {
    final normalized = <String>[];
    final seen = <String>{};
    for (final entry in entries) {
      final value = entry.trim();
      final key = value.toLowerCase();
      if (value.isEmpty || value.length > 80 || !seen.add(key)) continue;
      normalized.add(value);
      if (normalized.length == 100) break;
    }
    dictationDictionary
      ..clear()
      ..addAll(normalized);
    notifyListeners();
    await security.saveDictationDictionary(normalized);
  }

  Future<void> setDictationSource(String sourceId) async {
    await setDictationSourceForHarness(
      selectedSession?.providerId ?? selectedProviderId,
      sourceId,
    );
    await security.saveDictationSourceId(sourceId);
  }

  Future<void> setDictationSourceForHarness(
      String harnessId, String sourceId) async {
    final source = dictationSources
        .where((item) => item.id == sourceId && isDictationSourceReady(item))
        .firstOrNull;
    if (source == null) {
      throw StateError('That speech-to-text source is not ready');
    }
    final normalizedHarnessId = harnessId.trim().toLowerCase();
    if (normalizedHarnessId.isEmpty || normalizedHarnessId.length > 80) {
      throw ArgumentError.value(
          harnessId, 'harnessId', 'must be a valid harness ID');
    }
    dictationSourcePreferences[normalizedHarnessId] = source.id;
    preferredDictationSourceId = source.id;
    notifyListeners();
    await security.saveDictationSourcePreferences(dictationSourcePreferences);
  }

  Future<String> transcribeDictation(List<int> waveBytes,
      {String? sourceId}) async {
    if (waveBytes.isEmpty) throw StateError('Dictation audio is empty');
    final source = sourceId == null
        ? selectedDictationSource
        : dictationSources
            .where(
                (item) => item.id == sourceId && isDictationSourceReady(item))
            .firstOrNull;
    if (source == null) {
      throw StateError(
          'Choose a ready dictation service from the microphone menu.');
    }
    if (waveBytes.length > source.maxAudioBytes) {
      throw StateError('Dictation audio is too large for ${source.label}');
    }
    final attachments = <RemoteAttachment>[
      RemoteAttachment(
        name: 'dictation.wav',
        mimeType: 'audio/wav',
        dataBase64: base64Encode(waveBytes),
        byteLength: waveBytes.length,
      ),
    ];
    final attachmentIds = await _uploadAttachments(attachments);
    try {
      final result = await _requireTransport().request(
        'dictation.transcribe',
        <String, Object?>{
          'attachmentId': attachmentIds.single,
          'sourceId': source.id,
          'dictionary': dictationDictionary,
        },
        requestId: randomId('dictation'),
      );
      return requireString(result, 'text').trim();
    } catch (_) {
      for (final attachmentId in attachmentIds) {
        unawaited(_requireTransport().request(
          'attachment.upload.cancel',
          <String, Object?>{'uploadId': attachmentId},
        ).catchError((Object _) => <String, Object?>{}));
      }
      rethrow;
    }
  }

  Future<void> removeHost(String hostId) async {
    PairedHost? target;
    for (final host in hosts) {
      if (host.hostId == hostId) {
        target = host;
        break;
      }
    }
    String? revocationFailure;
    if (target != null && activeHost?.hostId == hostId && _transport != null) {
      try {
        final credentialPayload = await security.verifyCredential(
            target.credential, target.hostPublicKeyPem);
        final credentialId = optionalString(credentialPayload, 'credentialId');
        if (credentialId != null) {
          await _transport!.request(
              'device.revoke', <String, Object?>{'credentialId': credentialId});
        }
      } on Object catch (caught) {
        revocationFailure = caught.toString();
      }
      await _detachTransport();
    }
    await security.removeHost(hostId);
    hosts.removeWhere((host) => host.hostId == hostId);
    if (activeHost?.hostId == hostId) {
      activeHost = null;
      selectedSession = null;
      providers.clear();
      pairedDevices.clear();
      queuedMessages.clear();
      delegations.clear();
      approvals.clear();
      userInputs.clear();
      modelsByProvider.clear();
      walletByModel.clear();
      handoffSummaries.clear();
      visionBySession.clear();
      contextBySession.clear();
      _modelLoads.clear();
    }
    sessions.removeWhere((session) => session.hostId == hostId);
    if (revocationFailure != null) {
      error =
          'The local credential was removed, but host-side revocation could not be confirmed: $revocationFailure';
    }
    notifyListeners();
  }

  Future<void> reconnectProvider(String providerId) async {
    if (!_isMobileProviderEnabled(providerId)) {
      throw StateError('That harness is not available');
    }
    await _requireTransport().request(
        'provider.reconnect', <String, Object?>{'providerId': providerId});
    await _loadProviders();
  }

  Future<void> revokePairedDevice(String credentialId) async {
    final currentDeviceId = activeHost?.deviceId;
    final matches =
        pairedDevices.where((device) => device.credentialId == credentialId);
    if (matches.isEmpty) return;
    if (matches.first.deviceId == currentDeviceId) {
      throw StateError('The current phone cannot revoke itself here');
    }
    final result =
        await _requireTransport().request('device.revoke', <String, Object?>{
      'credentialId': credentialId,
    });
    if (result['revoked'] != true) {
      throw StateError('The paired device could not be revoked');
    }
    pairedDevices.removeWhere((device) => device.credentialId == credentialId);
    notifyListeners();
  }

  Future<void> refresh() async {
    await _refreshWithTransport(_requireTransport(), showProgress: true);
  }

  Future<bool> _refreshWithTransport(
    BridgeTransport transport, {
    required bool showProgress,
  }) async {
    final hostId = activeHost?.hostId;
    if (hostId == null || _transport != transport) return false;
    if (showProgress) {
      refreshing = true;
      error = null;
      notifyListeners();
    }
    try {
      final result = await transport
          .request('sessions.refresh', const <String, Object?>{});
      if (_transport != transport || activeHost?.hostId != hostId) return false;
      sessions.removeWhere((session) =>
          !_isMobileProviderEnabled(session.providerId) ||
          (session.hostId == hostId && session.parentSessionId == null));
      for (final session
          in jsonList(result['sessions']).map(RemoteSession.fromJson)) {
        _upsertSession(session);
      }
      sessions.removeWhere(
          (session) => !_isMobileProviderEnabled(session.providerId));
      await _reconcileUnreadAfterRefresh(
          sessions.where((session) => session.hostId == hostId));
      final timestamp = optionalString(result, 'lastSuccessfulRefreshAt');
      if (timestamp != null)
        lastSuccessfulRefresh = DateTime.tryParse(timestamp)?.toLocal();
      await _loadProviders(transport);
      return _transport == transport && activeHost?.hostId == hostId;
    } on Object catch (caught) {
      if (_transport == transport && activeHost?.hostId == hostId) {
        error = caught.toString();
      }
      return false;
    } finally {
      if (showProgress &&
          _transport == transport &&
          activeHost?.hostId == hostId) {
        refreshing = false;
        notifyListeners();
      }
    }
  }

  Future<void> openSession(RemoteSession session) async {
    if (!_isMobileProviderEnabled(session.providerId)) {
      throw StateError('That harness is not available');
    }
    if (!_belongsToActiveHost(session)) {
      throw StateError('That session belongs to another host');
    }
    selectedSession = session;
    notifyListeners();
    await _loadSessionHistory(session);
  }

  void openSessionForView(RemoteSession session) {
    if (!_isMobileProviderEnabled(session.providerId)) return;
    if (!_belongsToActiveHost(session)) return;
    final selectionChanged = selectedSession?.id != session.id;
    selectedSession = session;
    error = null;
    if (!_sessionHistoryLoads.add(session.id)) {
      if (selectionChanged) notifyListeners();
      return;
    }
    notifyListeners();
    unawaited(_finishOpeningSessionForView(session));
  }

  Future<void> _finishOpeningSessionForView(RemoteSession session) async {
    try {
      await _loadSessionHistory(session, notifyOnComplete: false);
    } on Object catch (caught) {
      error = caught.toString();
    } finally {
      _sessionHistoryLoads.remove(session.id);
      notifyListeners();
    }
  }

  Future<List<RemoteModel>> loadModels(
    String providerId, {
    bool force = false,
  }) async {
    if (!_isMobileProviderEnabled(providerId)) {
      return const <RemoteModel>[];
    }
    final cached = modelsByProvider[providerId];
    if (!force && cached != null) return cached;
    final hostId = activeHost?.hostId;
    final loadKey = '${hostId ?? 'unpaired'}:$providerId';
    final inFlight = _modelLoads[loadKey];
    if (inFlight != null) {
      if (!force) return inFlight;
      try {
        await inFlight;
      } on Object {
        // A forced refresh must still get one post-configuration attempt.
      }
    }
    final load = _loadModels(providerId, hostId);
    _modelLoads[loadKey] = load;
    return load.whenComplete(() {
      if (identical(_modelLoads[loadKey], load)) {
        final _ = _modelLoads.remove(loadKey);
      }
    });
  }

  Future<List<RemoteModel>> loadModelCatalog() async {
    final providerIds = providers
        .where((provider) =>
            provider.detected && provider.capabilities.modelEnumeration)
        .map((provider) => provider.providerId)
        .toSet();
    if (selectedSession != null) providerIds.add(selectedSession!.providerId);
    await Future.wait(providerIds.map(loadModels));
    return providerIds
        .expand((providerId) =>
            modelsByProvider[providerId] ?? const <RemoteModel>[])
        .toList(growable: false);
  }

  void rememberModelSelection(String providerId, String modelId) {
    final key = _modelSelectionKey(providerId, modelId);
    recentModelKeys
      ..remove(key)
      ..insert(0, key);
    if (recentModelKeys.length > 5) {
      recentModelKeys.removeRange(5, recentModelKeys.length);
    }
    notifyListeners();
    final snapshot = List<String>.of(recentModelKeys);
    _recentModelWrites = _recentModelWrites
        .then((_) => security.saveRecentModelKeys(snapshot))
        .catchError((Object _) {});
  }

  List<RemoteModel> recentModels(Iterable<RemoteModel> models) {
    final byKey = <String, RemoteModel>{
      for (final model in models)
        _modelSelectionKey(model.providerId, model.id): model,
    };
    return recentModelKeys
        .map((key) => byKey[key])
        .whereType<RemoteModel>()
        .toList(growable: false);
  }

  ProviderWalletStatus? walletStatusFor(String providerId, String? modelId) {
    final exact = walletByModel[_walletSelectionKey(providerId, modelId)];
    if (exact != null) return exact;
    final endpointId =
        providerId == 'direct' ? _directEndpointIdFromModelId(modelId) : null;
    return (endpointId == null
            ? null
            : walletByModel[
                _walletEndpointSelectionKey(providerId, endpointId)]) ??
        walletByModel[_walletSelectionKey(providerId, null)];
  }

  ProviderWalletStatus walletDisplayFor(String providerId, String? modelId) {
    final status = walletStatusFor(providerId, modelId);
    if (status != null) return status;
    final provider =
        providers.where((item) => item.providerId == providerId).firstOrNull;
    return ProviderWalletStatus.fallback(
      providerId: providerId,
      apiKeyConfigured: provider?.authenticated == true,
    );
  }

  Future<ProviderWalletStatus?> loadWallet(
    String providerId, {
    String? modelId,
    String? endpointId,
    bool force = false,
  }) async {
    final normalizedEndpointId = endpointId?.trim();
    final key = normalizedEndpointId?.isNotEmpty == true
        ? _walletEndpointSelectionKey(providerId, normalizedEndpointId!)
        : _walletSelectionKey(providerId, modelId);
    if (!force && walletByModel.containsKey(key)) return walletByModel[key];
    try {
      final result = await _requireTransport().request(
        'wallet.get',
        <String, Object?>{
          'providerId': providerId,
          if (modelId?.trim().isNotEmpty == true) 'modelId': modelId!.trim(),
          if (normalizedEndpointId?.isNotEmpty == true)
            'endpointId': normalizedEndpointId,
        },
      );
      final wallet = ProviderWalletStatus.fromJson(result['wallet']);
      if (normalizedEndpointId?.isNotEmpty != true ||
          wallet.endpointId == normalizedEndpointId) {
        walletByModel[key] = wallet;
      }
      if (wallet.endpointId != null) {
        walletByModel[
                _walletEndpointSelectionKey(providerId, wallet.endpointId!)] =
            wallet;
      }
      notifyListeners();
      return wallet;
    } on Object {
      // Wallet reporting is additive. Older bridges keep their model catalog
      // and conversation controls without surfacing a global error.
      return null;
    }
  }

  Future<ProviderWalletStatus> configureWallet({
    required String providerId,
    required String endpointId,
    String? modelId,
    String? apiKey,
    bool clearApiKey = false,
    double? setBalance,
    double? addBalance,
    JsonMap? customEndpoint,
  }) async {
    final result = await _requireTransport().request(
      'wallet.configure',
      <String, Object?>{
        'providerId': providerId,
        'endpointId': endpointId,
        if (apiKey?.trim().isNotEmpty == true) 'apiKey': apiKey!.trim(),
        if (clearApiKey) 'clearApiKey': true,
        if (setBalance != null) 'setBalance': setBalance,
        if (addBalance != null) 'addBalance': addBalance,
        if (customEndpoint != null) 'customEndpoint': customEndpoint,
      },
    );
    final wallet = ProviderWalletStatus.fromJson(result['wallet']);
    if (providerId == 'direct' && wallet.endpointId != null) {
      walletByModel.removeWhere((key, current) =>
          current.providerId == providerId &&
          current.endpointId == wallet.endpointId);
      walletByModel[
          _walletEndpointSelectionKey(providerId, wallet.endpointId!)] = wallet;
      if (_directEndpointIdFromModelId(modelId) == wallet.endpointId) {
        walletByModel[_walletSelectionKey(providerId, modelId)] = wallet;
      }
    } else {
      walletByModel[_walletSelectionKey(providerId, modelId)] = wallet;
      walletByModel[_walletSelectionKey(providerId, null)] = wallet;
    }
    if (providerId == 'direct' &&
        (apiKey?.trim().isNotEmpty == true ||
            clearApiKey ||
            customEndpoint != null)) {
      await loadModels(providerId, force: true);
    }
    if (customEndpoint != null) {
      final endpointId = optionalString(customEndpoint, 'id');
      final endpointName = optionalString(customEndpoint, 'name');
      final models = modelsByProvider[providerId];
      if (endpointId != null && endpointName != null && models != null) {
        final additions = jsonList(customEndpoint['modelIds'])
            .whereType<String>()
            .where((id) => id.trim().isNotEmpty)
            .map((id) => RemoteModel(
                  id: '$endpointId::$id',
                  providerId: providerId,
                  displayName: id,
                  description: '$endpointName direct API',
                  isDefault: false,
                  nativeMetadata: <String, Object?>{
                    'sourceProviderId': endpointId,
                    'sourceProviderName': endpointName,
                    'walletKind': 'user_api',
                    'apiKeyConfigured': wallet.apiKeyConfigured,
                  },
                ))
            .where((model) => !models.any((current) => current.id == model.id));
        modelsByProvider[providerId] = <RemoteModel>[...models, ...additions];
      }
    }
    notifyListeners();
    return wallet;
  }

  Future<List<VisionProxyTarget>> loadVisionProxyTargets() async {
    final result = await _requireTransport()
        .request('vision.targets', const <String, Object?>{});
    return jsonList(result['targets'])
        .map(VisionProxyTarget.fromJson)
        .toList(growable: false);
  }

  Future<VisionProxyStatus> loadVisionProxy(String sessionId) async {
    final result = await _requireTransport().request(
        'session.vision.get', <String, Object?>{'sessionId': sessionId});
    final status = VisionProxyStatus.fromJson(result['vision']);
    visionBySession[sessionId] = status;
    notifyListeners();
    return status;
  }

  Future<VisionProxyStatus> configureVisionProxy(
      String sessionId, VisionProxySelection? selection) async {
    final result = await _requireTransport()
        .request('session.vision.configure', <String, Object?>{
      'sessionId': sessionId,
      'selection': selection?.toJson(),
    });
    final status = VisionProxyStatus.fromJson(result['vision']);
    visionBySession[sessionId] = status;
    notifyListeners();
    return status;
  }

  Future<SessionContextState> loadSessionContext(String sessionId) async {
    final result = await _requireTransport().request(
        'session.context.get', <String, Object?>{'sessionId': sessionId});
    final context = SessionContextState.fromJson(result['context']);
    contextBySession[sessionId] = context;
    notifyListeners();
    return context;
  }

  Future<SessionContextState> setSessionCompactionThreshold(
    String sessionId,
    int thresholdTokens, {
    required bool compactNow,
  }) async {
    final result = await _requireTransport()
        .request('session.context.set_threshold', <String, Object?>{
      'sessionId': sessionId,
      'thresholdTokens': thresholdTokens,
      'compactNow': compactNow,
    });
    final context = SessionContextState.fromJson(result['context']);
    contextBySession[sessionId] = context;
    notifyListeners();
    return context;
  }

  Future<void> _refreshSessionContextQuietly(String sessionId) async {
    try {
      await loadSessionContext(sessionId);
    } on Object {
      // Usage is supplementary. A provider that cannot report it must not
      // disturb the conversation or surface a global connection error.
    }
  }

  Future<List<RemoteModel>> _loadModels(
      String providerId, String? hostId) async {
    try {
      final result = await _requireTransport()
          .request('models.list', <String, Object?>{'providerId': providerId});
      final models = jsonList(result['models'])
          .map(RemoteModel.fromJson)
          .toList(growable: false);
      if (activeHost?.hostId == hostId) {
        modelsByProvider[providerId] = models;
        notifyListeners();
      }
      return models;
    } on Object catch (caught) {
      if (activeHost?.hostId == hostId) {
        error = caught.toString();
        modelsByProvider[providerId] = const <RemoteModel>[];
        notifyListeners();
      }
      return const <RemoteModel>[];
    }
  }

  Future<List<RemoteSession>> loadChildSessions(String parentSessionId) async {
    final parentMatches =
        sessions.where((session) => session.id == parentSessionId);
    if (parentMatches.isEmpty || !_belongsToActiveHost(parentMatches.first)) {
      return childSessionsFor(parentSessionId);
    }
    if (!_childSessionLoads.add(parentSessionId)) {
      return childSessionsFor(parentSessionId);
    }
    try {
      final result = await _requireTransport().request(
          'session.children', <String, Object?>{'sessionId': parentSessionId});
      for (final session
          in jsonList(result['sessions']).map(RemoteSession.fromJson)) {
        _upsertSession(session);
      }
      notifyListeners();
      return childSessionsFor(parentSessionId);
    } finally {
      _childSessionLoads.remove(parentSessionId);
    }
  }

  Future<void> _loadSessionHistory(RemoteSession session,
      {bool notifyOnComplete = true,
      BridgeTransport? expectedTransport}) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    final clearThrough = _lastEventSequenceBySession[session.id] ?? 0;
    final result = await transport.request('session.open', <String, Object?>{
      'sessionId': session.id,
      'limit': 40,
    });
    if (_transport != transport || activeHost?.hostId != hostId) return;
    final updated = RemoteSession.fromJson(result['session']);
    _upsertSession(updated);
    final localMessages =
        List<RemoteMessage>.of(messages[session.id] ?? const <RemoteMessage>[]);
    final snapshotMessages = await _hydrateHistoryImages(
      transport,
      session.id,
      jsonList(result['messages'])
          .map(RemoteMessage.fromJson)
          .toList(growable: true),
    );
    final mergedSnapshot =
        _mergeSnapshotWithLocalArtifacts(snapshotMessages, localMessages);
    if (_historyCursors.containsKey(session.id)) {
      final byId = <String, RemoteMessage>{
        for (final message in localMessages) message.id: message,
        for (final message in mergedSnapshot) message.id: message,
      };
      messages[session.id] = byId.values.toList()
        ..sort((left, right) => left.createdAt.compareTo(right.createdAt));
    } else {
      messages[session.id] = mergedSnapshot;
    }
    _historyCursors[session.id] = optionalString(result, 'nextCursor');
    var readAt = updated.lastActivityAt;
    for (final message in messages[session.id]!) {
      if (message.createdAt.isAfter(readAt)) readAt = message.createdAt;
    }
    final retainedEvents = (events[session.id] ?? const <AgentEvent>[])
        .where((event) => event.sequence > clearThrough)
        .toList(growable: true);
    if (retainedEvents.isEmpty) {
      events.remove(session.id);
    } else {
      events[session.id] = retainedEvents;
    }
    if (retainedEvents.isEmpty) _clearLiveAssistant(session.id);
    _markSessionRead(session.id, readAt);
    if (notifyOnComplete) notifyListeners();
    unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
  }

  Future<bool> loadOlderSessionHistory(String sessionId) async {
    final cursor = _historyCursors[sessionId];
    if (cursor == null || !_olderHistoryLoads.add(sessionId)) return false;
    final transport = _requireTransport();
    notifyListeners();
    try {
      Map<String, Object?> result;
      try {
        result = await transport.request(
          'session.open',
          <String, Object?>{
            'sessionId': sessionId,
            'cursor': cursor,
            'limit': 40
          },
        );
      } on Object catch (caught) {
        if (!_isExpiredMessageHistoryPage(caught)) rethrow;
        final session = sessions
            .where((candidate) => candidate.id == sessionId)
            .firstOrNull;
        if (session == null) rethrow;
        _historyCursors.remove(sessionId);
        await _loadSessionHistory(session);
        return true;
      }
      final older = await _hydrateHistoryImages(
        transport,
        sessionId,
        jsonList(result['messages'])
            .map(RemoteMessage.fromJson)
            .toList(growable: false),
      );
      final current = messages[sessionId] ?? const <RemoteMessage>[];
      final byId = <String, RemoteMessage>{
        for (final message in older) message.id: message,
        for (final message in current) message.id: message,
      };
      messages[sessionId] = byId.values.toList()
        ..sort((left, right) => left.createdAt.compareTo(right.createdAt));
      _historyCursors[sessionId] = optionalString(result, 'nextCursor');
      notifyListeners();
      return older.isNotEmpty;
    } finally {
      _olderHistoryLoads.remove(sessionId);
      notifyListeners();
    }
  }

  bool _isExpiredMessageHistoryPage(Object caught) =>
      caught.toString().toLowerCase().contains('message history page expired');

  Future<List<RemoteMessage>> _hydrateHistoryImages(
    BridgeTransport transport,
    String sessionId,
    List<RemoteMessage> history,
  ) async {
    final hydrated = <RemoteMessage>[];
    for (final message in history) {
      var changed = false;
      final parts = <ContentPart>[];
      for (final part in message.parts) {
        final retrievalId = optionalString(part.data, 'retrievalId');
        if (part.type != 'image' ||
            part.attachmentUri != null ||
            retrievalId == null) {
          parts.add(part);
          continue;
        }
        final replacement = await _retrieveHistoryImage(
          transport,
          sessionId,
          retrievalId,
          part,
        );
        parts.add(replacement ?? part);
        changed = changed || replacement != null;
      }
      hydrated.add(changed
          ? RemoteMessage(
              id: message.id,
              sessionId: message.sessionId,
              role: message.role,
              createdAt: message.createdAt,
              parts: parts,
              status: message.status,
              editable: message.editable,
              providerMessageId: message.providerMessageId,
            )
          : message);
    }
    return hydrated;
  }

  Future<ContentPart?> _retrieveHistoryImage(
    BridgeTransport transport,
    String sessionId,
    String retrievalId,
    ContentPart part,
  ) async {
    const maximumBytes = 25 * 1024 * 1024;
    const maximumChunks = 64;
    final bytes = BytesBuilder(copy: false);
    var offset = 0;
    int? totalBytes;
    String? mimeType = part.attachmentMimeType;
    String? retrievedMimeType;
    String? name = part.attachmentName;
    try {
      for (var chunkIndex = 0; chunkIndex < maximumChunks; chunkIndex += 1) {
        final result = await transport.request(
          'session.image.get',
          <String, Object?>{
            'sessionId': sessionId,
            'retrievalId': retrievalId,
            'offset': offset,
          },
        );
        final reportedTotal = _nonNegativeJsonInteger(result['totalBytes']);
        final returnedOffset = _nonNegativeJsonInteger(result['offset']);
        if (optionalString(result, 'retrievalId') != retrievalId ||
            returnedOffset != offset ||
            reportedTotal == null ||
            reportedTotal > maximumBytes ||
            (totalBytes != null && reportedTotal != totalBytes)) {
          return null;
        }
        totalBytes = reportedTotal;
        final encoded = result['dataBase64'];
        if (encoded is! String) return null;
        final chunk = base64Decode(encoded);
        final nextRaw = result['nextOffset'];
        final nextOffset =
            nextRaw == null ? null : _nonNegativeJsonInteger(nextRaw);
        if (nextRaw != null && nextOffset == null) return null;
        final expectedOffset = offset + chunk.length;
        if (expectedOffset > totalBytes ||
            (nextOffset != null &&
                (nextOffset != expectedOffset || nextOffset <= offset)) ||
            (nextOffset == null && expectedOffset != totalBytes)) {
          return null;
        }
        bytes.add(chunk);
        final returnedMimeType = optionalString(result, 'mimeType');
        if (returnedMimeType == null ||
            !RegExp(r'^image/[a-z0-9.+-]+$', caseSensitive: false)
                .hasMatch(returnedMimeType) ||
            (retrievedMimeType != null &&
                returnedMimeType != retrievedMimeType)) {
          return null;
        }
        retrievedMimeType = returnedMimeType;
        mimeType = returnedMimeType;
        name = optionalString(result, 'name') ?? name;
        if (nextOffset == null) {
          return ContentPart(
            type: part.type,
            data: <String, Object?>{
              ...part.data,
              'uri': 'data:$mimeType;base64,${base64Encode(bytes.takeBytes())}',
              'mimeType': mimeType,
              if (name != null) 'name': name,
            },
          );
        }
        offset = nextOffset;
      }
    } on Object {
      // Image hydration is additive. A missing or expired retrieval entry
      // leaves the attachment label visible without blocking chat history.
    }
    return null;
  }

  int? _nonNegativeJsonInteger(Object? value) {
    if (value is! num || !value.isFinite || value < 0 || value % 1 != 0) {
      return null;
    }
    return value.toInt();
  }

  Future<void> sendMessage(
    String sessionId,
    String content, {
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
  }) async {
    final trimmed = content.trim();
    if (trimmed.isEmpty) return;
    final requestId = randomId('send');
    drafts[sessionId] = content;
    final optimisticMessage = RemoteMessage(
      id: requestId,
      sessionId: sessionId,
      role: 'user',
      createdAt: DateTime.now(),
      parts: <ContentPart>[
        ContentPart(type: 'text', data: <String, Object?>{'text': trimmed}),
        ...attachments.map((attachment) => ContentPart(
              type: 'image',
              data: <String, Object?>{
                'uri': attachment.dataUri,
                'mimeType': attachment.mimeType,
              },
            )),
      ],
      status: 'completed',
    );
    messages
        .putIfAbsent(sessionId, () => <RemoteMessage>[])
        .add(optimisticMessage);
    notifyListeners();
    try {
      await _requireTransport().request(
        'session.send_message',
        <String, Object?>{
          'sessionId': sessionId,
          'content': trimmed,
          if (modelId != null && modelId.isNotEmpty) 'modelId': modelId,
          if (reasoningEffort != null && reasoningEffort.isNotEmpty)
            'reasoningEffort': reasoningEffort,
          if (attachments.isNotEmpty)
            'attachments': attachments
                .map((attachment) => attachment.toJson())
                .toList(growable: false),
        },
        requestId: requestId,
      );
      drafts[sessionId] = '';
      notifyListeners();
    } catch (_) {
      messages[sessionId]?.removeWhere((message) => message.id == requestId);
      notifyListeners();
      rethrow;
    }
  }

  Future<String?> submitMessage(
    String sessionId,
    String content, {
    String deliveryMode = 'queue',
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
  }) async {
    final trimmed = content.trim();
    if (trimmed.isEmpty) return null;
    final session = sessions.where((item) => item.id == sessionId).firstOrNull;
    if (session == null) throw StateError('Session is no longer available');
    if (!_isMobileProviderEnabled(session.providerId)) {
      throw StateError('That harness is not available');
    }
    if (_preparedSessionIds.contains(sessionId)) {
      final created = await createSession(
        providerId: session.providerId,
        workingDirectory: session.workingDirectory?.trim() ?? '',
        firstInstruction: '',
        modelId: modelId,
        reasoningEffort: reasoningEffort,
      );
      _preparedSessionIds.remove(sessionId);
      sessions.removeWhere((item) => item.id == sessionId);
      messages.remove(sessionId);
      contextBySession.remove(sessionId);
      drafts.remove(sessionId);
      await submitMessage(created.id, trimmed,
          deliveryMode: deliveryMode,
          modelId: modelId,
          reasoningEffort: reasoningEffort,
          attachments: attachments);
      notifyListeners();
      return created.id;
    }
    final mode = deliveryMode == 'steer' &&
            session.state == 'working' &&
            providerSupportsSteering(session.providerId)
        ? 'steer'
        : 'queue';
    drafts[sessionId] = content;
    notifyListeners();
    final attachmentIds = await _uploadAttachments(attachments);
    try {
      final result = await _requireTransport().request(
        mode == 'steer' ? 'session.steer_message' : 'message_queue.enqueue',
        <String, Object?>{
          'sessionId': sessionId,
          'content': trimmed,
          if (modelId != null && modelId.isNotEmpty) 'modelId': modelId,
          if (reasoningEffort != null && reasoningEffort.isNotEmpty)
            'reasoningEffort': reasoningEffort,
          if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
        },
        requestId: randomId(mode),
      );
      if (mode == 'queue' && result['message'] != null) {
        final queued = RemoteQueuedMessage.fromJson(result['message']);
        queuedMessages[queued.id] = queued;
      }
      drafts[sessionId] = '';
      notifyListeners();
      return null;
    } catch (_) {
      for (final attachmentId in attachmentIds) {
        unawaited(_requireTransport().request(
            'attachment.upload.cancel', <String, Object?>{
          'uploadId': attachmentId
        }).catchError((Object _) => <String, Object?>{}));
      }
      rethrow;
    }
  }

  Future<RemoteDelegationTask> startDelegation(
    String parentSessionId,
    String prompt,
    List<DelegationSelection> targets,
  ) async {
    final trimmed = prompt.trim();
    if (trimmed.isEmpty || targets.isEmpty) {
      throw StateError('Choose a harness and enter a task for /mesh');
    }
    if (targets.any((target) => !_isMobileProviderEnabled(target.providerId))) {
      throw StateError('One of the selected harnesses is not available');
    }
    final result = await _requireTransport().request(
      'delegation.start',
      <String, Object?>{
        'parentSessionId': parentSessionId,
        'prompt': trimmed,
        'targets':
            targets.map((target) => target.toJson()).toList(growable: false),
      },
      requestId: randomId('mesh'),
      timeout: const Duration(minutes: 5),
    );
    final task = RemoteDelegationTask.fromJson(result['delegation']);
    delegations[task.id] = task;
    drafts[parentSessionId] = '';
    for (final target in targets) {
      delegationPreferences[target.providerId] = target;
      await security.saveDelegationPreference(target);
    }
    notifyListeners();
    unawaited(loadChildSessions(parentSessionId));
    return task;
  }

  Future<void> cancelQueuedMessage(String messageId) async {
    final result = await _requireTransport().request(
        'message_queue.cancel', <String, Object?>{'messageId': messageId});
    if (result['cancelled'] == true) {
      queuedMessages.remove(messageId);
      notifyListeners();
    }
  }

  Future<void> editMessage(
    String sessionId,
    RemoteMessage message,
    String content, {
    String? modelId,
    String? reasoningEffort,
  }) async {
    final providerMessageId = message.providerMessageId;
    final trimmed = content.trim();
    if (!message.editable || providerMessageId == null || trimmed.isEmpty) {
      throw StateError('That message is not editable');
    }
    await _requireTransport().request(
      'session.edit_message',
      <String, Object?>{
        'sessionId': sessionId,
        'providerMessageId': providerMessageId,
        'content': trimmed,
        if (modelId != null && modelId.isNotEmpty) 'modelId': modelId,
        if (reasoningEffort != null && reasoningEffort.isNotEmpty)
          'reasoningEffort': reasoningEffort,
      },
      requestId: randomId('edit'),
    );
    final current = messages[sessionId] ?? const <RemoteMessage>[];
    final targetIndex = current.indexWhere((item) => item.id == message.id);
    if (targetIndex >= 0) {
      messages[sessionId] = <RemoteMessage>[
        ...current.take(targetIndex),
        RemoteMessage(
          id: 'edited-${DateTime.now().microsecondsSinceEpoch}',
          sessionId: sessionId,
          role: 'user',
          createdAt: DateTime.now(),
          parts: <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{'text': trimmed}),
          ],
          status: 'completed',
        ),
      ];
    }
    _liveAssistantText.remove(sessionId);
    _liveAssistantReasoning.remove(sessionId);
    _liveAssistantStartedAt.remove(sessionId);
    final sessionIndex = sessions.indexWhere((item) => item.id == sessionId);
    if (sessionIndex >= 0) {
      sessions[sessionIndex] = sessions[sessionIndex].copyWith(
        state: 'working',
        lastActivityAt: DateTime.now(),
        needsApproval: false,
      );
      if (selectedSession?.id == sessionId) {
        selectedSession = sessions[sessionIndex];
      }
    }
    notifyListeners();
  }

  Future<List<String>> _uploadAttachments(
      List<RemoteAttachment> attachments) async {
    final transport = _requireTransport();
    final result = <String>[];
    final startedIds = <String>[];
    try {
      for (final attachment in attachments) {
        final bytes = base64Decode(attachment.dataBase64);
        final started = await transport.request(
          'attachment.upload.begin',
          <String, Object?>{
            'name': attachment.name,
            'mimeType': attachment.mimeType,
            'byteLength': bytes.length,
          },
        );
        final uploadId = requireString(started, 'uploadId');
        startedIds.add(uploadId);
        final advertisedChunkBytes = started['chunkBytes'];
        final chunkBytes = advertisedChunkBytes is num
            ? advertisedChunkBytes.toInt().clamp(32 * 1024, 192 * 1024).toInt()
            : 192 * 1024;
        var offset = 0;
        while (offset < bytes.length) {
          final end = (offset + chunkBytes).clamp(0, bytes.length).toInt();
          await transport.request(
            'attachment.upload.chunk',
            <String, Object?>{
              'uploadId': uploadId,
              'offset': offset,
              'dataBase64': base64Encode(bytes.sublist(offset, end)),
            },
          );
          offset = end;
        }
        final completed = await transport.request('attachment.upload.complete',
            <String, Object?>{'uploadId': uploadId});
        result.add(requireString(completed, 'attachmentId'));
      }
    } catch (_) {
      for (final uploadId in startedIds) {
        unawaited(transport.request(
            'attachment.upload.cancel', <String, Object?>{
          'uploadId': uploadId
        }).catchError((Object _) => <String, Object?>{}));
      }
      rethrow;
    }
    return result;
  }

  Future<RemoteSession> createSession({
    required String providerId,
    required String workingDirectory,
    required String firstInstruction,
    String? modelId,
    String? reasoningEffort,
    String? title,
  }) async {
    if (!_isMobileProviderEnabled(providerId)) {
      throw StateError('That harness is not available');
    }
    final result =
        await _requireTransport().request('session.create', <String, Object?>{
      'providerId': providerId,
      'workingDirectory': workingDirectory,
      if (firstInstruction.trim().isNotEmpty)
        'firstInstruction': firstInstruction.trim(),
      if (modelId != null && modelId.trim().isNotEmpty)
        'modelId': modelId.trim(),
      if (reasoningEffort != null && reasoningEffort.trim().isNotEmpty)
        'reasoningEffort': reasoningEffort.trim(),
      if (title != null && title.trim().isNotEmpty) 'title': title.trim(),
    });
    final session = RemoteSession.fromJson(result['session']);
    if (!_isMobileProviderEnabled(session.providerId)) {
      throw StateError('That harness is not available');
    }
    _upsertSession(session);
    selectedSession = session;
    _markSessionRead(session.id, session.lastActivityAt);
    notifyListeners();
    unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
    return session;
  }

  Future<ContextHandoffResult> contextHandoff(
    String sessionId, {
    String? prompt,
  }) async {
    final trimmedPrompt = prompt?.trim();
    final result = await _requireTransport().request(
      'session.context_handoff',
      <String, Object?>{
        'sessionId': sessionId,
        if (trimmedPrompt?.isNotEmpty == true) 'prompt': trimmedPrompt,
      },
    );
    final handoff = ContextHandoffResult.fromJson(result);
    if (!_isMobileProviderEnabled(handoff.session.providerId)) {
      throw StateError('That harness is not available');
    }
    _upsertSession(handoff.session);
    handoffSummaries[handoff.session.id] = handoff.summary;
    if (handoff.prompt?.isNotEmpty == true) {
      drafts[handoff.session.id] = handoff.prompt!;
    }
    selectedSession = handoff.session;
    _markSessionRead(handoff.session.id, handoff.session.lastActivityAt);
    notifyListeners();
    unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
    return handoff;
  }

  Future<SessionBranchResult> branchSession(
    String sessionId, {
    String? prompt,
  }) async {
    final trimmedPrompt = prompt?.trim();
    final result = await _requireTransport().request(
      'session.branch',
      <String, Object?>{
        'sessionId': sessionId,
        if (trimmedPrompt?.isNotEmpty == true) 'prompt': trimmedPrompt,
      },
    );
    final branch = SessionBranchResult.fromJson(result);
    if (!_isMobileProviderEnabled(branch.session.providerId)) {
      throw StateError('That harness is not available');
    }
    _upsertSession(branch.session);
    selectedSession = branch.session;
    _markSessionRead(branch.session.id, branch.session.lastActivityAt);
    notifyListeners();
    unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
    return branch;
  }

  Future<void> interrupt(String sessionId) async {
    await _requireTransport().request(
        'session.interrupt', <String, Object?>{'sessionId': sessionId});
  }

  Future<void> respondToApproval(
      ApprovalRequest approval, String choiceId) async {
    await _requireTransport().request('approval.respond', <String, Object?>{
      'requestId': approval.requestId,
      'choiceId': choiceId,
      'respondedAt': DateTime.now().toUtc().toIso8601String(),
    });
    approvals.remove(approval.requestId);
    notifyListeners();
  }

  Future<void> respondToUserInput(
      UserInputRequest request, JsonMap answers) async {
    await _requireTransport().request('user_input.respond', <String, Object?>{
      'requestId': request.requestId,
      'answers': answers,
      'respondedAt': DateTime.now().toUtc().toIso8601String(),
    });
    userInputs.remove(request.requestId);
    notifyListeners();
  }

  void setFilters({String? provider, String? state, String? search}) {
    _providerFilters
      ..clear()
      ..addAll(provider == null ? const <String>[] : <String>[provider]);
    stateFilter = state;
    if (search != null) query = search;
    notifyListeners();
  }

  void setTaskProviderFilter(String? providerId) {
    if (_providerFilters.length == (providerId == null ? 0 : 1) &&
        (providerId == null || _providerFilters.contains(providerId))) {
      return;
    }
    _providerFilters
      ..clear()
      ..addAll(providerId == null ? const <String>[] : <String>[providerId]);
    notifyListeners();
  }

  void toggleTaskProviderFilter(String providerId) {
    if (!_providerFilters.remove(providerId)) _providerFilters.add(providerId);
    notifyListeners();
  }

  void clearTaskProviderFilters() => setTaskProviderFilter(null);

  void setTaskStateFilter(String? state) {
    if (stateFilter == state) return;
    stateFilter = state;
    notifyListeners();
  }

  void setTaskSearch(String value) {
    if (query == value) return;
    query = value;
    notifyListeners();
  }

  void selectProvider(String providerId) {
    if (providerId != 'all' && !_isMobileProviderEnabled(providerId)) return;
    if (selectedProviderId == providerId) return;
    selectedProviderId = providerId;
    notifyListeners();
  }

  void setDraft(String sessionId, String value) {
    drafts[sessionId] = value;
  }

  Future<void> markSessionsRead(Iterable<RemoteSession> targetSessions) async {
    var changed = false;
    for (final session in targetSessions) {
      changed = _markSessionRead(session.id, session.lastActivityAt) || changed;
    }
    if (!changed) return;
    notifyListeners();
    await _enqueueReadStateWrite();
  }

  void setVisibleSession(String? sessionId) {
    if (_visibleSessionId == sessionId) return;
    final leaving = _visibleSessionId;
    if (leaving != null) {
      final matches = sessions.where((item) => item.id == leaving);
      final session = matches.isEmpty ? null : matches.first;
      if (session != null) _markSessionRead(leaving, session.lastActivityAt);
      unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
    }
    _visibleSessionId = sessionId;
  }

  @override
  void dispose() {
    _liveDeltaNotificationTimer?.cancel();
    _liveDeltaNotificationTimer = null;
    unawaited(_detachTransport());
    super.dispose();
  }

  Future<void> _loadHostMetadata() async {
    final result = await _requireTransport()
        .request('host.get', const <String, Object?>{});
    final hostJson = jsonMap(result['host'], name: 'host');
    final current = activeHost;
    if (current != null) {
      final displayName = optionalString(hostJson, 'displayName');
      final updated = PairedHost(
        hostId: current.hostId,
        hostPublicKeyPem: current.hostPublicKeyPem,
        endpoint: current.endpoint,
        deviceId: current.deviceId,
        devicePrivateKey: current.devicePrivateKey,
        devicePublicKey: current.devicePublicKey,
        credential: current.credential,
        relayToken: current.relayToken,
        displayName: displayName,
      );
      activeHost = updated;
      hosts
        ..removeWhere((item) => item.hostId == updated.hostId)
        ..add(updated);
      await security.saveHost(updated);
    }
    await _loadPairedDevices();
  }

  Future<void> _loadPairedDevices() async {
    final result = await _requireTransport()
        .request('device.list', const <String, Object?>{});
    pairedDevices
      ..clear()
      ..addAll(jsonList(result['devices']).map(PairedDevice.fromJson));
    notifyListeners();
  }

  Future<void> _loadProviders([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    final result =
        await transport.request('provider.list', const <String, Object?>{});
    if (_transport != transport || activeHost?.hostId != hostId) return;
    providers
      ..clear()
      ..addAll(jsonList(result['providers'])
          .map(ProviderConnection.fromJson)
          .where((provider) => _isMobileProviderEnabled(provider.providerId)));
    notifyListeners();
  }

  Future<void> _loadDictationSources(
      [BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    try {
      final result = await transport
          .request('dictation.source.list', const <String, Object?>{});
      if (_transport != transport || activeHost?.hostId != hostId) return;
      dictationSources
        ..clear()
        ..addAll(jsonList(result['sources'])
            .map(TranscriptionSource.fromJson)
            .where(_isMobileDictationSourceEnabled));
      notifyListeners();
    } on Object {
      if (_transport != transport || activeHost?.hostId != hostId) return;
      dictationSources.clear();
      notifyListeners();
    }
  }

  Future<void> _loadQueuedMessages([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    final result = await transport
        .request('message_queue.list', const <String, Object?>{});
    if (_transport != transport || activeHost?.hostId != hostId) return;
    queuedMessages
      ..clear()
      ..addEntries(jsonList(result['messages'])
          .map(RemoteQueuedMessage.fromJson)
          .map((message) => MapEntry(message.id, message)));
    notifyListeners();
  }

  Future<void> _loadDelegations([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    try {
      final result =
          await transport.request('delegation.list', const <String, Object?>{});
      if (_transport != transport || activeHost?.hostId != hostId) return;
      delegations
        ..clear()
        ..addEntries(jsonList(result['delegations'])
            .map(RemoteDelegationTask.fromJson)
            .where((task) => task.children
                .every((child) => _isMobileProviderEnabled(child.providerId)))
            .map((task) => MapEntry(task.id, task)));
      notifyListeners();
      for (final parentSessionId
          in delegations.values.map((task) => task.parentSessionId).toSet()) {
        unawaited(loadChildSessions(parentSessionId)
            .catchError((Object _) => childSessionsFor(parentSessionId)));
      }
    } on Object {
      // Older bridges do not expose /mesh yet; keep the rest of the app usable.
    }
  }

  Future<void> _loadApprovals([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    try {
      final result =
          await transport.request('approval.list', const <String, Object?>{});
      if (_transport != transport || activeHost?.hostId != hostId) return;
      approvals
        ..clear()
        ..addEntries(jsonList(result['approvals'])
            .map(ApprovalRequest.fromJson)
            .where((request) => _isMobileProviderEnabled(request.providerId))
            .map((request) => MapEntry(request.requestId, request)));
      notifyListeners();
    } on Object {
      // Compatibility with older bridges which only emitted live approvals.
    }
  }

  Future<void> _loadUserInputs([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    try {
      final result =
          await transport.request('user_input.list', const <String, Object?>{});
      if (_transport != transport || activeHost?.hostId != hostId) return;
      userInputs
        ..clear()
        ..addEntries(jsonList(result['requests'])
            .map(UserInputRequest.fromJson)
            .map((request) => MapEntry(request.requestId, request)));
      notifyListeners();
    } on Object {
      // Compatibility with older bridges which only emitted live requests.
    }
  }

  void _requestReconnectRecovery(
    BridgeTransport transport,
    String hostId,
    int transportEpoch,
  ) {
    if (_transport != transport ||
        activeHost?.hostId != hostId ||
        _transportEpoch != transportEpoch) {
      return;
    }
    if (_reconnectRecovery != null) {
      _reconnectRecoveryRequested = true;
      return;
    }
    final token = Object();
    _reconnectRecoveryToken = token;
    _reconnectRecovery = _recoverAfterReconnect(
      transport,
      hostId,
      transportEpoch,
    ).whenComplete(() {
      if (_reconnectRecoveryToken != token) return;
      _reconnectRecovery = null;
      _reconnectRecoveryToken = null;
      if (_reconnectRecoveryRequested) {
        _reconnectRecoveryRequested = false;
        _requestReconnectRecovery(transport, hostId, transportEpoch);
      }
    });
  }

  Future<void> _recoverAfterReconnect(
    BridgeTransport transport,
    String hostId,
    int transportEpoch,
  ) async {
    bool isCurrent() =>
        _transport == transport &&
        activeHost?.hostId == hostId &&
        _transportEpoch == transportEpoch;

    try {
      // The signed sync request is also the handshake that authorizes event
      // replay for a newly-created bridge socket.
      BridgeReplayResult? replay;
      try {
        replay = await transport.syncSince(transport.lastReceivedSequence);
      } on Object {
        // The signed attempt still authorizes replay on compatible older
        // bridges. The snapshots below remain the source of truth.
      }
      if (!isCurrent()) return;
      final refreshed =
          await _refreshWithTransport(transport, showProgress: false);
      if (!refreshed) return;
      if (!isCurrent()) return;
      if (replay?.replayGap == true) {
        final selected = selectedSession;
        if (selected != null && selected.hostId == hostId) {
          await _loadSessionHistory(
            selected,
            notifyOnComplete: false,
            expectedTransport: transport,
          );
        }
      }
      if (!isCurrent()) return;
      await Future.wait(<Future<void>>[
        _loadQueuedMessages(transport),
        _loadDelegations(transport),
        _loadApprovals(transport),
        _loadUserInputs(transport),
        _loadDictationSources(transport),
      ]);
      if (!isCurrent()) return;
      error = null;
      notifyListeners();
    } on Object catch (caught) {
      if (isCurrent()) {
        error = caught.toString();
        notifyListeners();
      }
    }
  }

  @visibleForTesting
  void applyEventForTesting(AgentEvent event) => _applyEvent(event);

  void _applyEvent(AgentEvent event) {
    var syncVisibleHistory = false;
    final eventSessionId = event.sessionId;
    if (eventSessionId != null) {
      final previousSequence = _lastEventSequenceBySession[eventSessionId] ?? 0;
      if (event.sequence > previousSequence) {
        _lastEventSequenceBySession[eventSessionId] = event.sequence;
      }
      if (!_nonConversationEventTypes.contains(event.type)) {
        final retained =
            events.putIfAbsent(eventSessionId, () => <AgentEvent>[]);
        retained.add(event);
        if (retained.length > _maxRetainedEventsPerSession) {
          retained.removeRange(
              0, retained.length - _maxRetainedEventsPerSession);
        }
      }
    }
    if (event.type == 'message.queued' ||
        event.type == 'message.queue_updated') {
      final message = RemoteQueuedMessage.fromJson(event.payload);
      queuedMessages[message.id] = message;
    } else if (event.type == 'message.queue_removed') {
      final messageId = optionalString(event.payload, 'messageId');
      if (messageId != null) queuedMessages.remove(messageId);
    }
    if (event.type == 'delegation.started' ||
        event.type == 'delegation.updated' ||
        event.type == 'delegation.completed' ||
        event.type == 'delegation.failed') {
      final task = RemoteDelegationTask.fromJson(event.payload);
      if (task.children
          .any((child) => !_isMobileProviderEnabled(child.providerId))) {
        return;
      }
      delegations[task.id] = task;
      if (event.type == 'delegation.started' ||
          event.type == 'delegation.updated') {
        unawaited(loadChildSessions(task.parentSessionId)
            .catchError((Object _) => childSessionsFor(task.parentSessionId)));
      }
    }
    if (event.type == 'approval.requested' &&
        event.payload['approval'] is Map<Object?, Object?>) {
      final approval = ApprovalRequest.fromJson(event.payload['approval']);
      if (_isMobileProviderEnabled(approval.providerId)) {
        approvals[approval.requestId] = approval;
      }
    } else if (event.type == 'approval.resolved') {
      final requestId = optionalString(event.payload, 'requestId');
      if (requestId != null) approvals.remove(requestId);
    } else if (event.type == 'user_input.requested' &&
        event.payload['userInput'] is Map<Object?, Object?>) {
      final request = UserInputRequest.fromJson(event.payload['userInput']);
      userInputs[request.requestId] = request;
    }
    final sessionId = event.sessionId;
    if (sessionId != null) {
      final index = sessions.indexWhere((session) => session.id == sessionId);
      if (index >= 0) {
        final current = sessions[index];
        _projectLiveMessageEvent(event);
        final statusState = optionalString(event.payload, 'state');
        final state = switch (event.type) {
          'session.status_changed'
              when statusState != null &&
                  _sessionStates.contains(statusState) =>
            statusState,
          'approval.requested' => 'needs_approval',
          'user_input.requested' => 'needs_input',
          'agent.error' => 'failed',
          'agent.completed' => 'completed',
          'agent.interrupted' => 'idle',
          'message.started' || 'tool.started' || 'command.started' => 'working',
          _ => current.state,
        };
        sessions[index] = current.copyWith(
          state: state,
          lastActivityAt: event.occurredAt,
          needsApproval: state == 'needs_approval',
          modelId: optionalString(event.payload, 'modelId'),
          reasoningEffort: optionalString(event.payload, 'reasoningEffort'),
          variantId: optionalString(event.payload, 'variantId'),
          parentSessionId: optionalString(event.payload, 'parentSessionId'),
          agentNickname: optionalString(event.payload, 'agentNickname'),
          agentRole: optionalString(event.payload, 'agentRole'),
        );
        var readStateChanged = false;
        if (_eventMarksUnread(event, state)) {
          if (_visibleSessionId == sessionId) {
            readStateChanged = _markSessionRead(sessionId, event.occurredAt);
          } else {
            readStateChanged = unreadSessionIds.add(sessionId);
          }
        } else if (!_sessionCanBeUnread(state)) {
          readStateChanged = unreadSessionIds.remove(sessionId);
        }
        if (readStateChanged) {
          unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
        }
        syncVisibleHistory = _visibleSessionId == sessionId &&
            (event.type == 'agent.completed' ||
                event.type == 'agent.error' ||
                event.type == 'agent.interrupted' ||
                (event.type == 'session.status_changed' &&
                    current.state == 'working' &&
                    state == 'idle'));
      }
    }
    _notifyForEvent(event.type);
    if (event.sessionId != null &&
        (event.type == 'agent.completed' ||
            event.type == 'agent.error' ||
            event.type == 'agent.interrupted')) {
      unawaited(_refreshSessionContextQuietly(event.sessionId!));
    }
    if (syncVisibleHistory && event.sessionId != null) {
      unawaited(_syncVisibleSessionHistory(event.sessionId!));
    }
  }

  void _notifyForEvent(String eventType) {
    if (eventType != 'message.delta') {
      _liveDeltaNotificationTimer?.cancel();
      _liveDeltaNotificationTimer = null;
      notifyListeners();
      return;
    }
    _liveDeltaNotificationTimer ??= Timer(_liveDeltaNotificationInterval, () {
      _liveDeltaNotificationTimer = null;
      notifyListeners();
    });
  }

  void _projectLiveMessageEvent(AgentEvent event) {
    final sessionId = event.sessionId;
    if (sessionId == null) return;
    final subagentParts = jsonList(event.payload['parts'])
        .map(ContentPart.fromJson)
        .where((part) => part.type == 'subagent')
        .toList(growable: false);
    if (subagentParts.isNotEmpty) {
      _upsertLiveSubagentMessage(event, subagentParts);
      return;
    }
    final role = _messageEventRole(event.payload);
    final text = _messageEventText(event.payload);
    if (role == 'user') {
      if (text.isNotEmpty) _appendLiveUserMessage(event, text);
      return;
    }
    if (event.type == 'message.started') {
      if (liveAssistantMessageFor(sessionId) != null) {
        _commitLiveAssistant(event);
      }
      _clearLiveAssistant(sessionId);
      _liveAssistantStartedAt[sessionId] = event.occurredAt;
      if (text.isNotEmpty) _liveAssistantText[sessionId] = text;
      return;
    }
    if (event.type != 'message.delta' && event.type != 'message.completed') {
      return;
    }
    if (text.isNotEmpty) {
      _liveAssistantStartedAt.putIfAbsent(sessionId, () => event.occurredAt);
      final reasoning = event.payload['partType'] == 'reasoning' ||
          event.payload.containsKey('reasoning') ||
          event.payload['phase'] == 'commentary';
      final target = reasoning ? _liveAssistantReasoning : _liveAssistantText;
      target[sessionId] = _mergeStreamText(target[sessionId] ?? '', text);
    }
    if (event.type == 'message.completed' &&
        liveAssistantMessageFor(sessionId) != null) {
      _commitLiveAssistant(event);
    }
  }

  void _upsertLiveSubagentMessage(AgentEvent event, List<ContentPart> parts) {
    final sessionId = event.sessionId!;
    final history = messages.putIfAbsent(sessionId, () => <RemoteMessage>[]);
    final identity = _subagentEventIdentity(event, parts.first);
    final messageId = identity == null
        ? 'subagent-${event.eventId}'
        : 'subagent-$sessionId-$identity';
    final existing = history.indexWhere((message) => message.id == messageId);
    final failed =
        parts.any((part) => optionalString(part.data, 'status') == 'failed');
    final message = RemoteMessage(
      id: messageId,
      sessionId: sessionId,
      role: 'assistant',
      createdAt: existing >= 0 ? history[existing].createdAt : event.occurredAt,
      parts: parts,
      status: failed ? 'failed' : 'completed',
    );
    if (existing >= 0) {
      history[existing] = message;
    } else {
      history.add(message);
    }
  }

  void _appendLiveUserMessage(AgentEvent event, String text) {
    final sessionId = event.sessionId!;
    final history = messages.putIfAbsent(sessionId, () => <RemoteMessage>[]);
    final messageId = _messageEventId(event);
    if (history.any((message) => message.id == messageId)) return;
    final duplicate = history.reversed.any((message) =>
        message.role == 'user' &&
        message.parts.length == 1 &&
        message.parts.single.summary == text &&
        event.occurredAt.difference(message.createdAt).abs() <
            const Duration(minutes: 2));
    if (duplicate) return;
    history.add(RemoteMessage(
      id: messageId,
      sessionId: sessionId,
      role: 'user',
      createdAt: event.occurredAt,
      parts: <ContentPart>[
        ContentPart(type: 'text', data: <String, Object?>{'text': text})
      ],
      status: 'completed',
    ));
  }

  void _commitLiveAssistant(AgentEvent event) {
    final sessionId = event.sessionId!;
    final live = liveAssistantMessageFor(sessionId);
    if (live == null) return;
    final history = messages.putIfAbsent(sessionId, () => <RemoteMessage>[]);
    final messageId = _messageEventId(event);
    if (!history.any((message) => message.id == messageId)) {
      history.add(RemoteMessage(
        id: messageId,
        sessionId: sessionId,
        role: 'assistant',
        createdAt: live.createdAt,
        parts: live.parts,
        status: 'completed',
      ));
    }
    _clearLiveAssistant(sessionId);
  }

  void _clearLiveAssistant(String sessionId) {
    _liveAssistantText.remove(sessionId);
    _liveAssistantReasoning.remove(sessionId);
    _liveAssistantStartedAt.remove(sessionId);
  }

  Future<void> _syncVisibleSessionHistory(String sessionId) async {
    if (_visibleSessionId != sessionId || !_historySyncs.add(sessionId)) return;
    try {
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (_visibleSessionId != sessionId) return;
      final index =
          sessions.indexWhere((candidate) => candidate.id == sessionId);
      if (index >= 0) await _loadSessionHistory(sessions[index]);
    } catch (_) {
      // Live events remain visible if the provider snapshot is briefly unavailable.
    } finally {
      _historySyncs.remove(sessionId);
    }
  }

  void _upsertSession(RemoteSession session) {
    if (!_isMobileProviderEnabled(session.providerId)) return;
    final index = sessions.indexWhere((item) => item.id == session.id);
    late final RemoteSession stored;
    if (index >= 0) {
      final current = sessions[index];
      stored = session.copyWith(
        project: session.project ?? current.project,
        workingDirectory: session.workingDirectory ?? current.workingDirectory,
        preview: session.preview ?? current.preview,
        modelId: session.modelId ?? current.modelId,
        reasoningEffort: session.reasoningEffort ?? current.reasoningEffort,
        variantId: session.variantId ?? current.variantId,
        parentSessionId: session.parentSessionId ?? current.parentSessionId,
        agentNickname: session.agentNickname ?? current.agentNickname,
        agentRole: session.agentRole ?? current.agentRole,
        relationship: session.relationship ?? current.relationship,
        contextHandoffSummary:
            session.contextHandoffSummary ?? current.contextHandoffSummary,
      );
      sessions[index] = stored;
      if (selectedSession?.id == session.id) {
        selectedSession = stored;
      }
    } else {
      stored = session;
      sessions.add(session);
    }
    final summary = stored.contextHandoffSummary;
    if (summary?.isNotEmpty == true) {
      handoffSummaries[session.id] = summary!;
    }
  }

  bool _eventMarksUnread(AgentEvent event, String state) =>
      _unreadEventTypes.contains(event.type) ||
      (event.type == 'session.status_changed' && _sessionCanBeUnread(state));

  Future<void> _loadSessionReadState(PairedHost host) async {
    final state = await security.readSessionReadState(host);
    _lastReadAt
      ..clear()
      ..addAll(state?.lastReadAt ?? const <String, DateTime>{});
    unreadSessionIds
      ..clear()
      ..addAll(state?.unreadSessionIds ?? const <String>{});
    _hasReadState = state != null;
    _visibleSessionId = null;
  }

  bool _belongsToActiveHost(RemoteSession session) {
    final hostId = activeHost?.hostId;
    return hostId == null ? hosts.isEmpty : session.hostId == hostId;
  }

  Future<void> _reconcileUnreadAfterRefresh(
      Iterable<RemoteSession> refreshedSessions) async {
    final snapshot = refreshedSessions.toList(growable: false);
    if (!_hasReadState) {
      for (final session in snapshot) {
        _lastReadAt[session.id] = session.lastActivityAt;
        unreadSessionIds.remove(session.id);
      }
      _hasReadState = true;
      await _enqueueReadStateWrite();
      return;
    }
    var changed = false;
    for (final session in snapshot) {
      if (_visibleSessionId == session.id) {
        changed =
            _markSessionRead(session.id, session.lastActivityAt) || changed;
        continue;
      }
      final lastRead = _lastReadAt[session.id];
      final responseReady = _sessionCanBeUnread(session.state);
      if (responseReady &&
          (lastRead == null || session.lastActivityAt.isAfter(lastRead))) {
        changed = unreadSessionIds.add(session.id) || changed;
      } else if (!responseReady) {
        changed = unreadSessionIds.remove(session.id) || changed;
      }
    }
    if (changed) await _enqueueReadStateWrite();
  }

  bool _markSessionRead(String sessionId, DateTime readAt) {
    final previous = _lastReadAt[sessionId];
    var changed = unreadSessionIds.remove(sessionId);
    if (previous == null || readAt.isAfter(previous)) {
      _lastReadAt[sessionId] = readAt.toUtc();
      changed = true;
    }
    return changed;
  }

  Future<void> _enqueueReadStateWrite() {
    final host = activeHost;
    if (host == null || !_hasReadState) return Future<void>.value();
    final snapshot = SessionReadState(
      lastReadAt: Map<String, DateTime>.of(_lastReadAt),
      unreadSessionIds: Set<String>.of(unreadSessionIds),
    );
    final operation = _readStateWrites
        .then((_) => security.saveSessionReadState(host, snapshot));
    _readStateWrites = operation.catchError((Object _) {});
    return operation;
  }

  @visibleForTesting
  Future<void> flushUnreadPersistenceForTesting() => _readStateWrites;

  BridgeTransport _requireTransport() {
    final transport = _transport;
    if (transport == null) throw StateError('No paired host is connected');
    return transport;
  }

  Future<void> _detachTransport() async {
    _transportEpoch += 1;
    _reconnectRecoveryRequested = false;
    _reconnectRecovery = null;
    _reconnectRecoveryToken = null;
    await _eventSubscription?.cancel();
    await _stateSubscription?.cancel();
    await _replayGapSubscription?.cancel();
    _eventSubscription = null;
    _stateSubscription = null;
    _replayGapSubscription = null;
    await _transport?.close();
    _transport = null;
    connectionState = BridgeConnectionState.disconnected;
  }
}

String? _latestArtifactIn(RemoteMessage message) {
  for (final part in message.parts.reversed) {
    final text = part.summary.trim();
    if (text.isEmpty) continue;
    if (part.type == 'reasoning' || part.data['phase'] == 'commentary') {
      return _cleanArtifactText(text);
    }
    final lines = text
        .split(RegExp(r'\r?\n'))
        .where((line) => line.trim().isNotEmpty)
        .toList(growable: false);
    if (lines.isNotEmpty && lines.every(_isMarkdownArtifactLine)) {
      return lines.map(_cleanArtifactText).join('\n');
    }
  }
  return null;
}

bool _sessionCanBeUnread(String state) =>
    state == 'completed' ||
    state == 'failed' ||
    state == 'needs_approval' ||
    state == 'needs_input';

List<RemoteMessage> _mergeSnapshotWithLocalArtifacts(
  List<RemoteMessage> snapshot,
  List<RemoteMessage> local,
) {
  final merged = List<RemoteMessage>.of(snapshot);
  final knownArtifacts = <String>{
    for (final message in snapshot)
      for (final part in message.parts)
        if (_artifactText(part) case final artifact?) artifact,
  };
  final knownIds = snapshot.map((message) => message.id).toSet();

  for (final message in local) {
    final artifactParts = message.parts
        .where((part) => _artifactText(part) != null)
        .where((part) => knownArtifacts.add(_artifactText(part)!))
        .toList(growable: false);
    if (artifactParts.isEmpty) continue;
    final onlyArtifacts = artifactParts.length == message.parts.length;
    var id = onlyArtifacts ? message.id : '${message.id}-artifacts';
    if (!knownIds.add(id)) {
      id = '$id-${message.createdAt.microsecondsSinceEpoch}';
      if (!knownIds.add(id)) continue;
    }
    merged.add(RemoteMessage(
      id: id,
      sessionId: message.sessionId,
      role: 'assistant',
      createdAt: message.createdAt,
      parts: artifactParts,
      status: message.status,
    ));
  }

  merged.sort((left, right) => left.createdAt.compareTo(right.createdAt));
  return merged;
}

String? _artifactText(ContentPart part) {
  final text = part.summary.trim();
  if (text.isEmpty) return null;
  if (part.type == 'reasoning' || part.data['phase'] == 'commentary') {
    return _cleanArtifactText(text);
  }
  final lines = text
      .split(RegExp(r'\r?\n'))
      .where((line) => line.trim().isNotEmpty)
      .toList(growable: false);
  return lines.isNotEmpty && lines.every(_isMarkdownArtifactLine)
      ? lines.map(_cleanArtifactText).join('\n')
      : null;
}

bool _isMarkdownArtifactLine(String line) {
  final value = line.trim();
  return value.length > 4 && value.startsWith('**') && value.endsWith('**');
}

String _cleanArtifactText(String value) =>
    value.split(RegExp(r'\r?\n')).map((line) {
      final trimmed = line.trim();
      return _isMarkdownArtifactLine(trimmed)
          ? trimmed.substring(2, trimmed.length - 2).trim()
          : trimmed;
    }).join('\n');

String? _subagentEventIdentity(AgentEvent event, ContentPart part) {
  final receiverIds = jsonList(part.data['receiverSessionIds'])
      .whereType<String>()
      .where((id) => id.isNotEmpty)
      .toList(growable: false);
  if (receiverIds.isNotEmpty) return receiverIds.join('|');
  for (final key in const <String>[
    'callId',
    'toolUseId',
    'itemId',
    'taskId',
  ]) {
    final value = event.payload[key];
    if (value is String && value.isNotEmpty) return value;
  }
  return null;
}

String _messageEventText(Map<String, Object?> payload) {
  for (final key in const <String>['text', 'delta', 'output', 'message']) {
    final value = payload[key];
    if (value is String && value.isNotEmpty) return value;
  }
  for (final key in const <String>['reasoning', 'content', 'item', 'parts']) {
    final text = _nestedMessageText(payload[key]);
    if (text.isNotEmpty) return text;
  }
  return '';
}

String _messageEventRole(Map<String, Object?> payload) {
  final direct = payload['role'];
  if (direct is String) return direct.toLowerCase();
  for (final key in const <String>['info', 'item', 'message']) {
    final nested = payload[key];
    if (nested is! Map<Object?, Object?>) continue;
    final role = nested['role'];
    if (role is String) return role.toLowerCase();
    final type = nested['type'];
    if (type is String) {
      final normalized = type.toLowerCase();
      if (normalized.contains('user')) return 'user';
      if (normalized.contains('agent') || normalized.contains('assistant')) {
        return 'assistant';
      }
    }
  }
  return 'assistant';
}

String _messageEventId(AgentEvent event) {
  for (final key in const <String>['messageId', 'itemId', 'turnId', 'id']) {
    final value = event.payload[key];
    if (value is String && value.isNotEmpty) return value;
  }
  for (final key in const <String>['info', 'item', 'message']) {
    final nested = event.payload[key];
    if (nested is Map<Object?, Object?>) {
      final value = nested['id'];
      if (value is String && value.isNotEmpty) return value;
    }
  }
  return 'live-${event.eventId}';
}

String _nestedMessageText(Object? value, [int depth = 0]) {
  if (depth > 6 || value == null) return '';
  if (value is String) return value;
  if (value is List<Object?>) {
    return value
        .map((item) => _nestedMessageText(item, depth + 1))
        .where((text) => text.isNotEmpty)
        .join();
  }
  if (value is Map<Object?, Object?>) {
    for (final key in const <String>['text', 'delta', 'output', 'message']) {
      final nested = value[key];
      if (nested is String && nested.isNotEmpty) return nested;
    }
    for (final key in const <String>['content', 'parts', 'reasoning', 'item']) {
      final text = _nestedMessageText(value[key], depth + 1);
      if (text.isNotEmpty) return text;
    }
  }
  return '';
}

String _mergeStreamText(String existing, String incoming) {
  if (incoming.isEmpty || existing.endsWith(incoming)) return existing;
  if (existing.isEmpty || incoming.startsWith(existing)) return incoming;
  return '$existing$incoming';
}

String _modelSelectionKey(String providerId, String modelId) =>
    '$providerId\u0000$modelId';

String _walletSelectionKey(String providerId, String? modelId) =>
    '$providerId\u0000${modelId ?? ''}';

String _walletEndpointSelectionKey(String providerId, String endpointId) =>
    '$providerId\u0000endpoint:$endpointId';

String? _directEndpointIdFromModelId(String? modelId) {
  if (modelId == null) return null;
  final separator = modelId.indexOf('::');
  return separator <= 0 ? null : modelId.substring(0, separator);
}
