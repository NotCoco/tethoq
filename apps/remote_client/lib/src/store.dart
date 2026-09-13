import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

import 'desktop_wake.dart';
import 'draft_journal.dart';
import 'ears.dart';
import 'json.dart';
import 'models.dart';
import 'security.dart';
import 'transport.dart';

const String availableAgentsTaskFilter = '@available-agents';
const int maxMessageAttachments = 12;
const int maxSingleMessageAttachmentBytes = 25 * 1024 * 1024;
const int maxMessageAttachmentBytes = 50 * 1024 * 1024;
const int _maxEarsAttachmentsPerRequest = 4;
const String directAudioDictationSourceId = 'direct-audio';
const String _meshDraftPlaceholder = '\uFFFC';

String _withoutMeshCommandTokens(String value) => value
    .replaceAllMapped(
      RegExp(r'(^|\s)/mesh(?=\s|$)', caseSensitive: false),
      (match) => match.group(1) ?? '',
    )
    .trim();

List<RemoteMeshPresentationSegment> _meshPresentationSegments(
  String composition,
  int targetCount,
) {
  final source = _withoutMeshCommandTokens(composition);
  final segments = <RemoteMeshPresentationSegment>[];
  var textStart = 0;
  var targetIndex = 0;
  for (var index = 0; index < source.length; index += 1) {
    if (source[index] != _meshDraftPlaceholder) continue;
    if (targetIndex >= targetCount) {
      throw StateError('Mesh targets no longer match the message');
    }
    if (textStart < index) {
      segments.add(RemoteMeshPresentationSegment.text(
          source.substring(textStart, index)));
    }
    segments.add(RemoteMeshPresentationSegment.mesh(targetIndex));
    targetIndex += 1;
    textStart = index + 1;
  }
  if (textStart < source.length) {
    segments
        .add(RemoteMeshPresentationSegment.text(source.substring(textStart)));
  }
  if (targetIndex != targetCount) {
    throw StateError('Mesh targets no longer match the message');
  }
  return List<RemoteMeshPresentationSegment>.unmodifiable(segments);
}

String _meshPlainText(Iterable<RemoteMeshPresentationSegment> segments) =>
    segments
        .where((segment) => segment.type == 'text')
        .map((segment) => segment.text ?? '')
        .join()
        .trim();

RemoteDelegationTask _remoteDelegationTaskFromJson(Object? value) {
  final source = jsonMap(value, name: 'delegation task');
  if (source['prompt'] != '') return RemoteDelegationTask.fromJson(source);

  final parsed = RemoteDelegationTask.fromJson(<String, Object?>{
    ...source,
    'prompt': _meshDraftPlaceholder,
  });
  final targetIndexes = parsed.presentationSegments
      .map((segment) => segment.targetIndex)
      .toList(growable: false);
  final validTargetOnlyMesh = parsed.orchestration == 'parent' &&
      parsed.targets.isNotEmpty &&
      parsed.presentationSegments.isNotEmpty &&
      parsed.presentationSegments.every((segment) => segment.type == 'mesh') &&
      targetIndexes.every((index) =>
          index != null && index >= 0 && index < parsed.targets.length) &&
      targetIndexes.toSet().length == parsed.targets.length &&
      targetIndexes.length == parsed.targets.length;
  if (!validTargetOnlyMesh) return RemoteDelegationTask.fromJson(source);

  return RemoteDelegationTask(
    id: parsed.id,
    parentSessionId: parsed.parentSessionId,
    prompt: '',
    state: parsed.state,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    children: parsed.children,
    targets: parsed.targets,
    presentationSegments: parsed.presentationSegments,
    orchestration: parsed.orchestration,
    parentTurnId: parsed.parentTurnId,
    error: parsed.error,
  );
}

const List<Duration> _draftJournalRetryDelays = <Duration>[
  Duration(milliseconds: 250),
  Duration(milliseconds: 500),
  Duration(seconds: 1),
  Duration(seconds: 2),
  Duration(seconds: 4),
];
const int _recentModelHistoryLimit = 20;
const int _recentModelVisibleLimit = 5;

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

const Set<String> _modelUseEventTypes = <String>{
  'message.started',
  'message.delta',
  'tool.started',
  'command.started',
  'agent.completed',
};

const String _pairingConnectionError =
    'The secure connection to this computer could not be reached. '
    'Generate a new connection code, check that both devices are online, '
    'then scan it again.';
const String _notConnectedError = 'Not connected';
const String _computerReconnectError =
    'Couldn\'t connect to this computer. Reconnect it from Settings.';
const String _startupError =
    'Tethoq couldn\'t finish starting. Close the app and try again.';

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

String _connectionError(Object error, {required String fallback}) =>
    _isPairingConnectionError(error) ? _notConnectedError : fallback;

const Set<String> _nonConversationEventTypes = <String>{
  'session.status_changed',
  'session.updated',
  'session.goal_updated',
  'session.goal_cleared',
  'session.vision_updated',
  'message.started',
  'message.delta',
  'message.completed',
  'message.queued',
  'message.queue_updated',
  'message.queue_removed',
  'message.remote_received',
  'side_chat.created',
  'side_chat.updated',
  'side_chat.promoted',
  'agent.completed',
  'agent.interrupted',
  'approval.requested',
  'approval.resolved',
  'user_input.requested',
  'user_input.resolved',
};

const int _maxRetainedEventsPerSession = 200;
const Duration _liveDeltaNotificationInterval = Duration(milliseconds: 16);
const Duration _optimisticEchoTimeTolerance = Duration(minutes: 2);
const Duration _optimisticEchoClockSkewAllowance = Duration(seconds: 5);
const Duration _assistantPresentationTimeTolerance = Duration(minutes: 2);
const Duration _assistantPresentationClockSkewAllowance = Duration(seconds: 5);

RemoteQueuedMessage _retainQueuedAttachmentPreviews(
  RemoteQueuedMessage message,
  Iterable<RemoteQueuedAttachment> localSources,
) {
  final sources = localSources.toList(growable: false);
  final visibleContent = simplifyVisibleContent(message.content);
  var changed = visibleContent != message.content;
  final attachments = message.attachments.map((attachment) {
    if (attachment.localImageDataUri != null) return attachment;
    RemoteQueuedAttachment? source;
    for (final candidate in sources) {
      if (candidate.name == attachment.name &&
          candidate.mimeType == attachment.mimeType &&
          candidate.byteLength == attachment.byteLength &&
          candidate.localImageDataUri != null) {
        source = candidate;
        break;
      }
    }
    if (source == null) return attachment;
    changed = true;
    return RemoteQueuedAttachment(
      name: attachment.name,
      mimeType: attachment.mimeType,
      byteLength: attachment.byteLength,
      dataBase64: source.dataBase64,
    );
  }).toList(growable: false);
  if (!changed) return message;
  return RemoteQueuedMessage(
    id: message.id,
    sessionId: message.sessionId,
    content: visibleContent,
    state: message.state,
    createdAt: message.createdAt,
    attachments: attachments,
    modelId: message.modelId,
    reasoningEffort: message.reasoningEffort,
    error: message.error,
    retryable: message.retryable,
  );
}

typedef BridgeTransportFactory = BridgeTransport Function(
    BridgeEndpoint endpoint, DeviceSecurity security);
typedef DraftJournalFactory = Future<DraftJournal> Function();

class RetainedDictationDraft {
  RetainedDictationDraft({
    required List<int> bytes,
    this.sourceId,
    this.directAudio = false,
  }) : _bytes = Uint8List.fromList(bytes);

  final Uint8List _bytes;
  final String? sourceId;
  final bool directAudio;

  Uint8List get bytes => Uint8List.fromList(_bytes);
  int get byteLength => _bytes.length;
}

class _OutgoingCompositionSnapshot {
  const _OutgoingCompositionSnapshot({
    required this.hostId,
    required this.content,
    required this.attachments,
    required this.modelId,
    required this.reasoningEffort,
    required this.simplify,
    required this.delegationSelections,
    this.draftRevision,
  });

  final String? hostId;
  final String content;
  final List<RemoteAttachment> attachments;
  final String? modelId;
  final String? reasoningEffort;
  final SimplifySettings? simplify;
  final List<DelegationSelection> delegationSelections;
  final int? draftRevision;

  _OutgoingCompositionSnapshot trackedAt(int revision) =>
      _OutgoingCompositionSnapshot(
        hostId: hostId,
        content: content,
        attachments: attachments,
        modelId: modelId,
        reasoningEffort: reasoningEffort,
        simplify: simplify,
        delegationSelections: delegationSelections,
        draftRevision: revision,
      );
}

class _DraftJournalSnapshot {
  const _DraftJournalSnapshot({
    required this.hostId,
    required this.sessionId,
    required this.revision,
    required this.write,
    required this.shouldDelete,
    required this.attachmentObjects,
    required this.retainedDictation,
  });

  final String hostId;
  final String sessionId;
  final int revision;
  final DraftJournalWrite write;
  final bool shouldDelete;
  final List<RemoteAttachment> attachmentObjects;
  final RetainedDictationDraft? retainedDictation;
}

class _PendingDraftJournalDelete {
  const _PendingDraftJournalDelete({
    required this.hostId,
    required this.sessionId,
    required this.expectedRevision,
  });

  final String hostId;
  final String sessionId;
  final int expectedRevision;

  String get key => '$hostId\u0000$sessionId\u0000$expectedRevision';
}

class _TransportOrigin {
  const _TransportOrigin({required this.transport, required this.hostId});

  final BridgeTransport transport;
  final String hostId;
}

class _AcknowledgedSessionCreateFailure implements Exception {
  const _AcknowledgedSessionCreateFailure(this.cause, {this.session});

  final Object cause;
  final RemoteSession? session;

  @override
  String toString() =>
      'The task was created, but its local details could not be refreshed.';
}

class _AcknowledgedMutationFailure implements Exception {
  const _AcknowledgedMutationFailure(this.message);

  final String message;

  @override
  String toString() => message;
}

class _EarsOperation {
  _EarsOperation(this.origin);

  final _TransportOrigin origin;
  bool cancelled = false;
  String? currentBridgeRequestId;

  void cancel() => cancelled = true;

  void throwIfCancelled() {
    if (cancelled) throw StateError(earsCancelledMessage);
  }
}

class SessionProjectGroup {
  const SessionProjectGroup({
    required this.key,
    required this.name,
    required this.directory,
    required this.sessions,
    required this.updatedAt,
  });

  final String key;
  final String name;
  final String directory;
  final List<RemoteSession> sessions;
  final DateTime updatedAt;
}

String normalizeProjectDirectory(String? value) {
  final trimmed = value?.trim() ?? '';
  if (trimmed.isEmpty) return '';
  final windows =
      RegExp(r'^[a-z]:[\\/]', caseSensitive: false).hasMatch(trimmed) ||
          trimmed.startsWith(r'\\');
  final unc = trimmed.startsWith(r'\\');
  final separator = windows ? r'\' : '/';
  var normalized = trimmed.replaceAll(RegExp(r'[\\/]+'), separator);
  if (unc) normalized = r'\\' + normalized.replaceFirst(RegExp(r'^\\+'), '');
  final windowsRoot =
      RegExp(r'^[a-z]:\\$', caseSensitive: false).hasMatch(normalized);
  final posixRoot = normalized == '/';
  final uncShareRoot = RegExp(r'^\\\\[^\\]+\\[^\\]+\\?$').hasMatch(normalized);
  if (!windowsRoot && !posixRoot && !uncShareRoot) {
    normalized = normalized.replaceFirst(RegExp(r'[\\/]+$'), '');
  }
  return windows ? normalized.toLowerCase() : normalized;
}

String projectDirectoryName(String directory,
    [String fallback = 'No project folder']) {
  final trimmed = directory.trim();
  if (trimmed.isEmpty) return fallback;
  if (trimmed == '/') return '/';
  if (RegExp(r'^[a-z]:[\\/]?$', caseSensitive: false).hasMatch(trimmed)) {
    return '${trimmed[0].toUpperCase()}:\\';
  }
  final withoutTrailing = trimmed.replaceFirst(RegExp(r'[\\/]+$'), '');
  final parts = withoutTrailing
      .split(RegExp(r'[\\/]'))
      .where((part) => part.isNotEmpty)
      .toList(growable: false);
  return parts.isEmpty ? fallback : parts.last;
}

List<SessionProjectGroup> groupSessionsByProject(
    Iterable<RemoteSession> sessions) {
  final grouped =
      <String, ({String directory, List<RemoteSession> sessions})>{};
  for (final session in sessions) {
    final directory = session.workingDirectory?.trim() ?? '';
    final key = 'directory:${normalizeProjectDirectory(directory)}';
    final current = grouped[key];
    if (current == null) {
      grouped[key] = (directory: directory, sessions: <RemoteSession>[session]);
    } else {
      current.sessions.add(session);
    }
  }
  final result = grouped.entries.map((entry) {
    final sessions = entry.value.sessions;
    final updatedAt = sessions.fold<DateTime>(
        DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
        (latest, session) => session.lastActivityAt.isAfter(latest)
            ? session.lastActivityAt
            : latest);
    return SessionProjectGroup(
      key: entry.key,
      name: projectDirectoryName(entry.value.directory),
      directory: entry.value.directory,
      sessions: sessions,
      updatedAt: updatedAt,
    );
  }).toList(growable: false);
  result.sort((left, right) {
    final byActivity = right.updatedAt.compareTo(left.updatedAt);
    return byActivity != 0 ? byActivity : left.name.compareTo(right.name);
  });
  return result;
}

class RemoteAppStore extends ChangeNotifier {
  RemoteAppStore({
    DeviceSecurity? security,
    BridgeTransportFactory? transportFactory,
    DraftJournalFactory? draftJournalFactory,
  })  : security = security ?? DeviceSecurity(),
        _draftJournalFactory = draftJournalFactory,
        _transportFactory = transportFactory ??
            ((endpoint, security) =>
                BridgeTransport(endpoint: endpoint, security: security));

  final DeviceSecurity security;
  final BridgeTransportFactory _transportFactory;
  final DraftJournalFactory? _draftJournalFactory;
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
  final Map<String, DateTime> _recentModelUsedAt = <String, DateTime>{};
  final Map<String, VisionProxyStatus> visionBySession =
      <String, VisionProxyStatus>{};
  final Map<String, int> _visionStatusGenerations = <String, int>{};
  final Map<String, Future<VisionProxyStatus>> _visionStatusLoads =
      <String, Future<VisionProxyStatus>>{};
  final Map<String, int> _visionStatusFailureCounts = <String, int>{};
  final Map<String, DateTime> _visionStatusRetryAfter = <String, DateTime>{};
  int _visionStatusEpoch = 0;
  final List<VisionProxyTarget> _visionProxyTargets = <VisionProxyTarget>[];
  bool _visionProxyTargetsIncomplete = false;
  final Map<String, SessionContextState> contextBySession =
      <String, SessionContextState>{};
  final Map<String, SessionGoal> goalsBySession = <String, SessionGoal>{};
  final Map<String, int> _goalClearRevisions = <String, int>{};
  final Map<String, RemoteQueuedMessage> queuedMessages =
      <String, RemoteQueuedMessage>{};
  int _queuedRevision = 0;
  int _sideChatRevision = 0;
  final Map<String, RemoteDelegationTask> delegations =
      <String, RemoteDelegationTask>{};
  // A list read may have started just before delegation.prepare persisted on
  // the bridge. Keep that locally submitted presentation until an
  // authoritative snapshot or event contains the same request identity.
  final Set<String> _locallyPreparedDelegationIds = <String>{};
  final Map<String, DelegationSelection> delegationPreferences =
      <String, DelegationSelection>{};
  final Map<String, DelegationSelection> agentDefaults =
      <String, DelegationSelection>{};
  final Map<String, String> _liveAssistantText = <String, String>{};
  final Map<
      String,
      ({
        String text,
        String reasoning,
        DateTime? startedAt,
        RemoteMessage message
      })> _liveAssistantSnapshots = {};
  final Map<String, String> _liveAssistantReasoning = <String, String>{};
  final Map<String, DateTime> _liveAssistantStartedAt = <String, DateTime>{};
  final Set<String> _historySyncs = <String>{};
  final Set<String> _sessionHistoryLoads = <String>{};
  final Set<String> _olderHistoryLoads = <String>{};
  final Map<String, String?> _historyCursors = <String, String?>{};
  final Map<String, ContentPart> _historyImageCache = <String, ContentPart>{};
  final Map<String, Future<ContentPart?>> _historyImageLoads =
      <String, Future<ContentPart?>>{};
  final Map<String, int> _historyImageGenerations = <String, int>{};
  final Map<String, Set<String>> _optimisticMessageIdsBySession =
      <String, Set<String>>{};
  final Set<String> _inFlightOptimisticMessageIds = <String>{};
  final Set<String> _childSessionLoads = <String>{};
  final Map<String, List<AgentEvent>> events = <String, List<AgentEvent>>{};
  final Map<String, int> _lastEventSequenceBySession = <String, int>{};
  final Map<String, int> _liveSessionRevisions = <String, int>{};
  final Map<String, int> _contextRequestGenerations = <String, int>{};
  final Map<String, Future<List<RemoteModel>>> _modelLoads =
      <String, Future<List<RemoteModel>>>{};
  Future<List<VisionProxyTarget>>? _visionProxyTargetLoad;
  int _visionProxyTargetGeneration = 0;
  int _visionProxyTargetLoadGeneration = -1;
  String? _visionProxyTargetHostId;
  bool _visionProxyTargetsLoaded = false;
  final Set<String> _modelLoadFailures = <String>{};
  final Map<String, ApprovalRequest> approvals = <String, ApprovalRequest>{};
  final Map<String, UserInputRequest> userInputs = <String, UserInputRequest>{};
  int _approvalRevision = 0;
  int _userInputRevision = 0;
  final Map<String, String> drafts = <String, String>{};
  final Map<String, List<RemoteAttachment>> draftAttachments =
      <String, List<RemoteAttachment>>{};
  final Map<String, SimplifySettings> draftSimplifySettings =
      <String, SimplifySettings>{};
  final Map<String, List<DelegationSelection>> _draftDelegationSelections =
      <String, List<DelegationSelection>>{};
  final Map<String, int> _draftRevisions = <String, int>{};
  final Map<String, int> _draftAttachmentVersions = <String, int>{};
  final Map<String, int> _retainedDictationVersions = <String, int>{};
  final Map<String, RetainedDictationDraft> _retainedDictations =
      <String, RetainedDictationDraft>{};
  final Map<String, String> _pendingRetainedDictationClears =
      <String, String>{};
  final Map<String, DraftJournalEntry> _draftJournalEntries =
      <String, DraftJournalEntry>{};
  final Expando<DraftJournalBlob> _journalBlobForAttachment =
      Expando<DraftJournalBlob>();
  final Expando<DraftJournalBlob> _journalBlobForRetainedDictation =
      Expando<DraftJournalBlob>();
  final Set<String> _hydratedDraftAttachmentIds = <String>{};
  final Set<String> _hydratedRetainedDictationIds = <String>{};
  final Map<String, String> _dirtyDraftHosts = <String, String>{};
  final Map<String, _PendingDraftJournalDelete> _pendingDraftJournalDeletes =
      <String, _PendingDraftJournalDelete>{};
  final Set<String> _pendingDraftHostDeletes = <String>{};
  final Set<String> unreadSessionIds = <String>{};
  final List<String> dictationDictionary = <String>[];
  final List<TranscriptionSource> dictationSources = <TranscriptionSource>[];
  final Map<String, String> dictationSourcePreferences = <String, String>{};
  final Set<String> _dismissedImageModelNoticeKeys = <String>{};
  final Map<String, DateTime> _lastReadAt = <String, DateTime>{};
  final Set<String> _preparedSessionIds = <String>{};
  final Set<String> _acknowledgedPreparedSessionIds = <String>{};
  final Set<String> _activeBridgeMutationKeys = <String>{};
  final Set<String> _consumedBridgeMutationKeys = <String>{};
  final Set<String> _queueingDisabledSessionIds = <String>{};

  BridgeTransport? _transport;
  StreamSubscription<AgentEvent>? _eventSubscription;
  StreamSubscription<BridgeConnectionState>? _stateSubscription;
  StreamSubscription<void>? _replayGapSubscription;
  Future<void> _readStateWrites = Future<void>.value();
  Future<void> _recentModelWrites = Future<void>.value();
  Future<void> _lastActiveHostWrites = Future<void>.value();
  Future<DraftJournal?>? _draftJournalLoad;
  Future<void> _draftJournalOperations = Future<void>.value();
  Timer? _draftJournalDebounce;
  Timer? _draftJournalRetryTimer;
  int _draftJournalRetryAttempt = 0;
  String? _draftJournalHostId;
  bool _draftJournalCleanupPending = false;
  Future<void>? _reconnectRecovery;
  Object? _reconnectRecoveryToken;
  Timer? _liveDeltaNotificationTimer;
  Timer? _approvalExpiryTimer;
  bool _reconnectRecoveryRequested = false;
  Future<void>? _backgroundResume;
  int _backgroundResumeGeneration = 0;
  int _connectGeneration = 0;
  int _hostSessionCacheGeneration = 0;
  int _transportEpoch = 0;
  int _nextDraftRevision = 0;
  bool _disposed = false;
  bool _hasReadState = false;
  String? _visibleSessionId;
  final List<String> _visibleSessionOwners = <String>[];
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
  String reasoningDisplayMode = 'compact';
  String taskListMode = 'recent';
  bool showSideChats = false;
  String? preferredDictationSourceId;
  EarsSettings ears = const EarsSettings();
  final Map<String, Set<_EarsOperation>> _earsOperationsBySession =
      <String, Set<_EarsOperation>>{};

  bool get earsBusy => _earsOperationsBySession.isNotEmpty;
  bool earsBusyFor(String sessionId) =>
      _earsOperationsBySession[sessionId]?.isNotEmpty == true;

  bool get hasHosts => hosts.isNotEmpty;

  bool get canSyncVisionStatus =>
      _transport != null && connectionState == BridgeConnectionState.online;

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

  RemoteSession prepareSession(
    String providerId, {
    String workingDirectory = '',
  }) {
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
    final availableModels = modelsByProvider[providerId];
    final defaults = availableModels == null
        ? null
        : agentDefaultSelectionFor(providerId, availableModels);
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
      workingDirectory: workingDirectory.trim(),
      modelId: defaults?.modelId,
      reasoningEffort: defaults?.reasoningEffort,
    );
    _preparedSessionIds.add(id);
    sessions.add(session);
    messages[id] = <RemoteMessage>[];
    selectedSession = session;
    _touchDraft(id);
    notifyListeners();
    return session;
  }

  Future<RemoteSession> startPreparedSession(
    String providerId, {
    String workingDirectory = '',
  }) async {
    final openingHostId = activeHost?.hostId;
    await loadModels(providerId);
    if (activeHost?.hostId != openingHostId) {
      throw StateError('The active computer changed while starting this task.');
    }
    final session = prepareSession(
      providerId,
      workingDirectory: workingDirectory,
    );
    return session;
  }

  void updatePreparedDirectory(String sessionId, String directory) {
    if (!_preparedSessionIds.contains(sessionId)) return;
    final index = sessions.indexWhere((item) => item.id == sessionId);
    if (index < 0) return;
    sessions[index] = sessions[index].copyWith(workingDirectory: directory);
    selectedSession = sessions[index];
    _touchDraft(sessionId);
    notifyListeners();
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
    final availableModels = modelsByProvider[providerId];
    final defaults = availableModels == null
        ? null
        : agentDefaultSelectionFor(providerId, availableModels);
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
      modelId: defaults?.modelId,
      reasoningEffort: defaults?.reasoningEffort,
    );
    sessions[index] = updated;
    selectedSession = updated;
    _touchDraft(sessionId);
    unawaited(loadModels(providerId));
    notifyListeners();
  }

  void updatePreparedModelSelection(
    String sessionId, {
    required String? modelId,
    required String? reasoningEffort,
  }) {
    if (!_preparedSessionIds.contains(sessionId)) return;
    final index = sessions.indexWhere((item) => item.id == sessionId);
    if (index < 0) return;
    final current = sessions[index];
    final normalizedModel = modelId?.trim();
    final normalizedReasoning = reasoningEffort?.trim();
    final updated = RemoteSession(
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
      modelId: normalizedModel?.isEmpty == true ? null : normalizedModel,
      reasoningEffort:
          normalizedReasoning?.isEmpty == true ? null : normalizedReasoning,
      variantId: current.variantId,
      parentSessionId: current.parentSessionId,
      agentNickname: current.agentNickname,
      agentRole: current.agentRole,
      relationship: current.relationship,
      contextHandoffSummary: current.contextHandoffSummary,
      sessionKind: current.sessionKind,
    );
    sessions[index] = updated;
    if (selectedSession?.id == sessionId) selectedSession = updated;
    _touchDraft(sessionId);
  }

  void discardPreparedSession(String sessionId) {
    if (!_preparedSessionIds.remove(sessionId)) return;
    _acknowledgedPreparedSessionIds.remove(sessionId);
    final hostId = _hostIdForDraftSession(sessionId);
    sessions.removeWhere((item) => item.id == sessionId);
    messages.remove(sessionId);
    contextBySession.remove(sessionId);
    _contextRequestGenerations.remove(sessionId);
    _liveSessionRevisions.remove(sessionId);
    _visionStatusLoads.removeWhere((key, _) => key == sessionId);
    _visionStatusFailureCounts.remove(sessionId);
    _visionStatusRetryAfter.remove(sessionId);
    drafts.remove(sessionId);
    draftAttachments.remove(sessionId);
    draftSimplifySettings.remove(sessionId);
    _draftDelegationSelections.remove(sessionId);
    _draftRevisions.remove(sessionId);
    _draftAttachmentVersions.remove(sessionId);
    _retainedDictationVersions.remove(sessionId);
    _retainedDictations.remove(sessionId);
    _pendingRetainedDictationClears.remove(sessionId);
    _hydratedDraftAttachmentIds.remove(sessionId);
    _hydratedRetainedDictationIds.remove(sessionId);
    _draftJournalEntries.remove(sessionId);
    _dirtyDraftHosts.remove(sessionId);
    if (hostId != null) {
      unawaited(_deleteDraftJournalEntry(
        hostId,
        sessionId,
        expectedRevision: null,
      ).catchError((Object _) {}));
    }
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
    final rawReasoning = _liveAssistantReasoning[sessionId] ?? '';
    final rawText = _liveAssistantText[sessionId] ?? '';
    final startedAt = _liveAssistantStartedAt[sessionId];
    final cached = _liveAssistantSnapshots[sessionId];
    if (cached != null &&
        cached.text == rawText &&
        cached.reasoning == rawReasoning &&
        cached.startedAt == startedAt) {
      return cached.message;
    }
    final reasoning = rawReasoning.trim();
    final text = rawText.trim();
    if (reasoning.isEmpty && text.isEmpty) return null;
    final message = RemoteMessage(
      id: 'live-assistant-$sessionId',
      sessionId: sessionId,
      role: 'assistant',
      createdAt: startedAt ?? DateTime.now(),
      parts: <ContentPart>[
        if (reasoning.isNotEmpty)
          ContentPart(
              type: 'reasoning', data: <String, Object?>{'text': reasoning}),
        if (text.isNotEmpty)
          ContentPart(type: 'text', data: <String, Object?>{'text': text}),
      ],
      status: 'streaming',
    );
    _liveAssistantSnapshots[sessionId] = (
      text: rawText,
      reasoning: rawReasoning,
      startedAt: startedAt,
      message: message,
    );
    return message;
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

  List<RemoteSession> _filteredTaskSessions({required bool includeSubagents}) {
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
      if (session.sessionKind == 'side_chat' ||
          session.sessionKind == 'internal' ||
          session.relationship?.kind == 'side_chat') {
        return false;
      }
      final hostId = activeHost?.hostId;
      if (hostId != null && session.hostId != hostId) return false;
      if (!includeSubagents && session.relationship?.kind == 'subagent') {
        return false;
      }
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

  List<RemoteSession> get visibleSessions =>
      _filteredTaskSessions(includeSubagents: false);

  List<RemoteSession> get projectModeSessions =>
      _filteredTaskSessions(includeSubagents: true);

  List<SessionProjectGroup> get visibleSessionProjects =>
      groupSessionsByProject(projectModeSessions);

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
            session.sessionKind != 'side_chat' &&
            session.parentSessionId == parentSessionId &&
            (hostId == null || session.hostId == hostId))
        .toList();
    result.sort(
        (left, right) => right.lastActivityAt.compareTo(left.lastActivityAt));
    return result;
  }

  List<RemoteSession> sideChatsFor(String parentSessionId) {
    final hostId = activeHost?.hostId;
    final result = sessions
        .where((session) =>
            session.sessionKind == 'side_chat' &&
            (session.parentSessionId == parentSessionId ||
                session.relationship?.sourceSessionId == parentSessionId) &&
            (hostId == null || session.hostId == hostId))
        .toList(growable: false);
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

  bool isQueueingEnabledFor(String sessionId) =>
      !_queueingDisabledSessionIds.contains(sessionId);

  void turnOffQueueingFor(String sessionId) {
    if (_queueingDisabledSessionIds.add(sessionId)) notifyListeners();
  }

  void turnOnQueueingFor(String sessionId) {
    if (_queueingDisabledSessionIds.remove(sessionId)) notifyListeners();
  }

  Future<void> initialize() async {
    try {
      defaultDeliveryMode = await security.readDefaultDeliveryMode();
      reasoningDisplayMode = await security.readReasoningDisplayMode();
      taskListMode = await security.readTaskListMode();
      dictationDictionary
        ..clear()
        ..addAll(await security.readDictationDictionary());
      preferredDictationSourceId = await security.readDictationSourceId();
      dictationSourcePreferences
        ..clear()
        ..addAll(await security.readDictationSourcePreferences());
      final storedRecentModelUses = await security.readRecentModelUses();
      _recentModelUsedAt
        ..clear()
        ..addEntries(storedRecentModelUses
            .map((use) => MapEntry(use.key, use.usedAt.toUtc())));
      _rebuildRecentModelKeys();
      delegationPreferences
        ..clear()
        ..addEntries((await security.readDelegationPreferences()).entries.where(
            (entry) => _isMobileProviderEnabled(entry.value.providerId)));
      agentDefaults
        ..clear()
        ..addEntries((await security.readAgentDefaults()).entries.where(
            (entry) => _isMobileProviderEnabled(entry.value.providerId)));
      ears = await security.readEarsSettings();
      hosts
        ..clear()
        ..addAll(await security.readHosts());
      final lastActiveHostId = await security.readLastActiveHostId();
      final startupHost =
          hosts.where((host) => host.hostId == lastActiveHostId).firstOrNull ??
              hosts.firstOrNull;
      if (lastActiveHostId != null && startupHost?.hostId != lastActiveHostId) {
        await security.clearLastActiveHostId(lastActiveHostId);
      }
      if (startupHost != null) {
        try {
          await _restoreDraftJournalHost(startupHost.hostId);
        } on Object {
          // Draft recovery is intentionally fail-closed, but a damaged local
          // journal must not prevent the user reconnecting to their computer.
        }
      }
      // Local preferences and saved computers are enough to paint the real
      // app shell. Keep initialize's Future pending for callers which need a
      // completed network bootstrap, but never gate first paint on the socket.
      initialized = true;
      notifyListeners();
      if (startupHost != null) {
        await _connectHost(startupHost, authoritative: false);
      }
    } on Object catch (caught) {
      error = activeHost == null
          ? _startupError
          : _connectionError(caught, fallback: _computerReconnectError);
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
      await _reactivateDraftJournalHost(host.hostId);
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

  Future<void> connectHost(PairedHost host) =>
      _connectHost(host, authoritative: true);

  Future<void> _connectHost(
    PairedHost host, {
    required bool authoritative,
  }) async {
    validateBridgeEndpointUrl(host.endpoint);
    final connectGeneration = ++_connectGeneration;
    bool isLatestConnect() => _connectGeneration == connectGeneration;
    final previousDraftHostId = activeHost?.hostId ?? _draftJournalHostId;
    if (previousDraftHostId != null &&
        (previousDraftHostId != host.hostId || _dirtyDraftHosts.isNotEmpty)) {
      await flushDraftJournal();
    }
    if (!isLatestConnect()) return;
    await _detachTransport();
    if (!isLatestConnect()) return;
    error = null;
    final previousActiveHostId = activeHost?.hostId;
    final switchingHosts =
        previousActiveHostId != null && previousActiveHostId != host.hostId;
    activeHost = host;
    if (authoritative) {
      await _recordLastActiveHost(host.hostId, connectGeneration);
      if (!isLatestConnect()) return;
    }
    _invalidateVisionStatuses();
    if (switchingHosts) {
      _clearHostSessionStateForHostChange();
    }
    if (_draftJournalHostId != host.hostId) {
      _clearDraftStateForHostChange();
      try {
        final restored = await _restoreDraftJournalHost(
          host.hostId,
          isCurrent: () =>
              isLatestConnect() && activeHost?.hostId == host.hostId,
        );
        if (!restored) return;
      } on Object {
        // The encrypted journal remains untouched so a later launch can retry.
      }
      if (!isLatestConnect()) return;
    }
    final readStateLoaded = await _loadSessionReadState(
      host,
      isCurrent: () => isLatestConnect() && activeHost?.hostId == host.hostId,
    );
    if (!readStateLoaded || !isLatestConnect()) return;
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
    var initialConnectFailed = false;
    _eventSubscription = transport.events.listen((event) {
      if (_transport != transport || activeHost?.hostId != host.hostId) return;
      _applyEvent(event);
    });
    _replayGapSubscription = transport.replayGaps.listen((_) {
      _requestReconnectRecovery(transport, host.hostId, transportEpoch);
    });
    _stateSubscription = transport.states.listen((state) {
      if (_transport != transport || _transportEpoch != transportEpoch) return;
      connectionState = state;
      notifyListeners();
      if (state == BridgeConnectionState.online) {
        if ((reachedOnline && disconnectedAfterOnline) ||
            (!reachedOnline && initialConnectFailed)) {
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
    try {
      await transport.connect();
    } on Object catch (caught) {
      if (!isLatestConnect() || _transport != transport) {
        await transport.close();
        return;
      }
      initialConnectFailed = true;
      error = _connectionError(caught, fallback: _computerReconnectError);
      notifyListeners();
      rethrow;
    }
    if (!isLatestConnect() || _transport != transport) {
      await transport.close();
      return;
    }
    await _recordLastActiveHost(host.hostId, connectGeneration);
    if (!isLatestConnect() || _transport != transport) return;
    await Future.wait(<Future<void>>[
      _loadHostMetadata(transport, host.hostId),
      () async {
        await _refreshWithTransport(transport, showProgress: true);
      }(),
    ]);
    if (!isLatestConnect() || _transport != transport) return;
    unawaited(_refreshSelectedVisionStatus(
      transport,
      host.hostId,
      transportEpoch,
    ));
    await Future.wait(<Future<void>>[
      _loadQueuedMessages(transport),
      _loadSideChats(expectedTransport: transport),
      _loadDelegations(transport),
      _loadApprovals(transport),
      _loadUserInputs(transport),
      _loadDictationSources(transport),
    ]);
  }

  Future<void> _recordLastActiveHost(
    String hostId,
    int connectGeneration,
  ) async {
    final operation = _lastActiveHostWrites.then((_) async {
      if (_disposed ||
          _connectGeneration != connectGeneration ||
          activeHost?.hostId != hostId) {
        return;
      }
      await security.saveLastActiveHostId(hostId);
    });
    _lastActiveHostWrites =
        operation.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    try {
      await operation;
    } on Object {
      // A preference write must not make an established computer unusable.
    }
  }

  Future<void> setDefaultDeliveryMode(String mode) async {
    if (mode != 'queue' && mode != 'steer') return;
    defaultDeliveryMode = mode;
    notifyListeners();
    await security.saveDefaultDeliveryMode(mode);
  }

  Future<void> setReasoningDisplayMode(String mode) async {
    if (mode != 'compact' && mode != 'expanded') return;
    reasoningDisplayMode = mode;
    notifyListeners();
    await security.saveReasoningDisplayMode(mode);
  }

  Future<void> setTaskListMode(String mode) async {
    if (mode != 'recent' && mode != 'project') return;
    taskListMode = mode;
    notifyListeners();
    await security.saveTaskListMode(mode);
  }

  Future<DesktopAppState> desktopStatus() => _desktopWakeCoordinator().status();

  Future<DesktopWakeResult> wakeDesktop() => _desktopWakeCoordinator().wake();

  DesktopWakeCoordinator _desktopWakeCoordinator() {
    final origin = _captureTransportOrigin();
    return DesktopWakeCoordinator(
      request: (type, payload, {required timeout}) async {
        _requireTransportOrigin(origin,
            action: 'the desktop was being contacted');
        final result =
            await origin.transport.request(type, payload, timeout: timeout);
        _requireTransportOrigin(origin,
            action: 'the desktop was being contacted');
        return result;
      },
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
    final normalizedHarnessId = harnessId.trim().toLowerCase();
    if (normalizedHarnessId.isEmpty || normalizedHarnessId.length > 80) {
      throw ArgumentError.value(
          harnessId, 'harnessId', 'must be a valid harness ID');
    }
    final normalizedSourceId = sourceId.trim();
    final source = dictationSources
        .where((item) =>
            item.id == normalizedSourceId && isDictationSourceReady(item))
        .firstOrNull;
    // Direct audio is a synthetic, model-dependent option owned by the
    // composer rather than the bridge's speech-to-text catalogue. Persist the
    // choice here; the screen revalidates model/EARS capability before use.
    if (source == null && normalizedSourceId != directAudioDictationSourceId) {
      throw StateError('That speech-to-text source is not ready');
    }
    dictationSourcePreferences[normalizedHarnessId] = normalizedSourceId;
    preferredDictationSourceId = normalizedSourceId;
    notifyListeners();
    await security.saveDictationSourcePreferences(dictationSourcePreferences);
  }

  Future<void> setEars(EarsSettings value) async {
    ears = value;
    notifyListeners();
    await security.saveEarsSettings(value);
  }

  Future<void> cancelEars([String? sessionId]) async {
    final operations = sessionId == null
        ? _earsOperationsBySession.values
            .expand((operations) => operations)
            .toList(growable: false)
        : _earsOperationsBySession[sessionId]?.toList(growable: false) ??
            const <_EarsOperation>[];
    // A global cancel is retained for the single-operation settings surface.
    // When several tasks own work, callers must name the visible session so
    // one task cannot cancel another task's transcription.
    if (sessionId == null && operations.length != 1) return;
    if (operations.isEmpty) return;
    for (final operation in operations) {
      operation.cancel();
    }
    final requestIds = operations
        .map((operation) => operation.currentBridgeRequestId)
        .whereType<String>()
        .toSet();
    await Future.wait<void>(requestIds.map((requestId) async {
      try {
        final operation = operations.firstWhere(
          (operation) => operation.currentBridgeRequestId == requestId,
        );
        await operation.origin.transport.request(
          'ears.cancel',
          <String, Object?>{'requestId': requestId},
        );
      } on Object {
        // Local cancellation already owns the operation. The bridge cancel is
        // best-effort so a lost connection cannot resurrect later batches.
      }
    }));
  }

  Future<void> configureDictationSource(String sourceId,
      {String? apiKey, bool clear = false}) async {
    final origin = _captureTransportOrigin();
    final normalizedSourceId = sourceId.trim();
    if (normalizedSourceId.isEmpty || normalizedSourceId.length > 80) {
      throw ArgumentError.value(sourceId, 'sourceId', 'must be valid');
    }
    final normalizedKey = apiKey?.trim();
    if (!clear &&
        (normalizedKey == null ||
            normalizedKey.length < 8 ||
            normalizedKey.length > 512)) {
      throw ArgumentError.value(
          apiKey, 'apiKey', 'must contain 8–512 characters');
    }
    final result = await origin.transport.request(
      'dictation.source.configure',
      <String, Object?>{
        'sourceId': normalizedSourceId,
        if (clear) 'clear': true else 'apiKey': normalizedKey,
      },
      requestId: randomId('dictation-source'),
    );
    _requireTransportOrigin(origin,
        action: 'the dictation source was being configured');
    dictationSources
      ..clear()
      ..addAll(jsonList(result['sources'])
          .map(TranscriptionSource.fromJson)
          .where(_isMobileDictationSourceEnabled));
    final selected = dictationSources
        .where((source) => source.id == normalizedSourceId && source.isReady)
        .firstOrNull;
    if (selected != null) {
      preferredDictationSourceId = selected.id;
      dictationSourcePreferences[
          selectedSession?.providerId ?? selectedProviderId] = selected.id;
      await security.saveDictationSourcePreferences(dictationSourcePreferences);
    }
    notifyListeners();
  }

  Future<String> transcribeDictation(
    List<int> waveBytes, {
    required String sessionId,
    String? sourceId,
  }) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
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
    final dataBase64 =
        await compute<List<int>, String>(base64Encode, waveBytes);
    _requireTransportOrigin(origin, action: 'dictation was being prepared');
    final attachments = <RemoteAttachment>[
      RemoteAttachment(
        name: 'dictation.wav',
        mimeType: 'audio/wav',
        dataBase64: dataBase64,
        byteLength: waveBytes.length,
      ),
    ];
    final attachmentIds = await _uploadAttachments(attachments, origin: origin);
    try {
      _requireTransportOrigin(origin,
          action: 'dictation was being transcribed');
      final dictionary = List<String>.unmodifiable(dictationDictionary);
      final result = await origin.transport.request(
        'dictation.transcribe',
        <String, Object?>{
          'attachmentId': attachmentIds.single,
          'sourceId': source.id,
          'dictionary': dictionary,
        },
        requestId: randomId('dictation'),
        timeout: const Duration(minutes: 13),
      );
      _requireTransportOrigin(origin,
          action: 'dictation was being transcribed');
      return requireString(result, 'text').trim();
    } catch (_) {
      for (final attachmentId in attachmentIds) {
        unawaited(origin.transport.request(
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
    error = null;
    final removingActiveHost = activeHost?.hostId == hostId;
    final expectedTransport = removingActiveHost ? _transport : null;
    if (removingActiveHost || _draftJournalHostId == hostId) {
      await flushDraftJournal();
    }
    if (target != null &&
        removingActiveHost &&
        expectedTransport != null &&
        connectionState == BridgeConnectionState.online) {
      try {
        final credentialPayload = await security.verifyCredential(
            target.credential, target.hostPublicKeyPem);
        final credentialId = optionalString(credentialPayload, 'credentialId');
        if (credentialId != null &&
            _transport == expectedTransport &&
            activeHost?.hostId == hostId) {
          await expectedTransport.request(
            'device.revoke',
            <String, Object?>{'credentialId': credentialId},
            timeout: const Duration(seconds: 5),
          );
        }
      } on Object {
        // Local removal remains authoritative. If the computer went offline
        // during this best-effort request, no transport diagnostic belongs on
        // the reconnect screen and the user can remove the stale phone there.
      }
    }
    if (removingActiveHost &&
        _transport == expectedTransport &&
        activeHost?.hostId == hostId) {
      _connectGeneration += 1;
      await _detachTransport();
    }
    await _lastActiveHostWrites;
    await security.removeHost(hostId);
    hosts.removeWhere((host) => host.hostId == hostId);
    if (activeHost?.hostId == hostId) {
      _clearHostSessionStateForHostChange();
      _invalidateVisionStatuses();
      activeHost = null;
    }
    if (_draftJournalHostId == hostId) _clearDraftStateForHostChange();
    sessions.removeWhere((session) => session.hostId == hostId);
    try {
      await _deleteDraftJournalHost(hostId);
    } on Object {
      _pendingDraftHostDeletes.add(hostId);
      _scheduleDraftJournalRetry();
    }
    notifyListeners();
  }

  Future<void> reconnectProvider(String providerId) async {
    final origin = _captureTransportOrigin();
    if (!_isMobileProviderEnabled(providerId)) {
      throw StateError('That harness is not available');
    }
    await origin.transport.request(
        'provider.reconnect', <String, Object?>{'providerId': providerId});
    _requireTransportOrigin(origin,
        action: 'the harness was being reconnected');
    await _loadProviders(origin.transport);
  }

  Future<void> revokePairedDevice(String credentialId) async {
    final origin = _captureTransportOrigin();
    final currentDeviceId = activeHost?.deviceId;
    final matches =
        pairedDevices.where((device) => device.credentialId == credentialId);
    if (matches.isEmpty) return;
    if (matches.first.deviceId == currentDeviceId) {
      throw StateError('The current phone cannot revoke itself here');
    }
    final result =
        await origin.transport.request('device.revoke', <String, Object?>{
      'credentialId': credentialId,
    });
    _requireTransportOrigin(origin,
        action: 'the paired phone was being revoked');
    if (result['revoked'] != true) {
      throw StateError('The paired device could not be revoked');
    }
    pairedDevices.removeWhere((device) => device.credentialId == credentialId);
    notifyListeners();
  }

  Future<void> refresh() async {
    final origin = _captureTransportOrigin();
    await _refreshWithTransport(origin.transport, showProgress: true);
    _requireTransportOrigin(origin, action: 'the task list was refreshing');
    await _loadSideChats(expectedTransport: origin.transport);
  }

  Future<void> resumeFromBackground() {
    _backgroundResumeGeneration += 1;
    final existing = _backgroundResume;
    if (existing != null) return existing;
    late final Future<void> operation;
    operation = () async {
      var handledGeneration = -1;
      while (handledGeneration != _backgroundResumeGeneration) {
        handledGeneration = _backgroundResumeGeneration;
        await _resumeFromBackground();
        await Future<void>.delayed(Duration.zero);
      }
    }()
        .whenComplete(() {
      if (identical(_backgroundResume, operation)) _backgroundResume = null;
    });
    _backgroundResume = operation;
    return operation;
  }

  Future<void> _resumeFromBackground() async {
    final transport = _transport;
    final hostId = activeHost?.hostId;
    final transportEpoch = _transportEpoch;
    if (transport == null || hostId == null) return;
    try {
      final reconnected = await transport.resumeFromBackground(
        probeTimeout: const Duration(milliseconds: 800),
      );
      if (_transport != transport ||
          activeHost?.hostId != hostId ||
          _transportEpoch != transportEpoch) {
        return;
      }
      // A replaced socket emits an online transition which owns recovery. A
      // healthy retained socket has no transition, so request it explicitly.
      if (!reconnected) {
        _requestReconnectRecovery(transport, hostId, transportEpoch);
      }
      await Future<void>.delayed(Duration.zero);
      final recovery = _reconnectRecovery;
      if (recovery != null) await recovery;
    } on Object catch (caught) {
      if (_transport == transport &&
          activeHost?.hostId == hostId &&
          _transportEpoch == transportEpoch) {
        error = _connectionError(caught, fallback: _computerReconnectError);
        notifyListeners();
      }
    }
  }

  Future<bool> _refreshWithTransport(
    BridgeTransport transport, {
    required bool showProgress,
    bool loadProviders = true,
  }) async {
    final hostId = activeHost?.hostId;
    if (hostId == null || _transport != transport) return false;
    final sessionIdsAtStart = sessions
        .where((session) => session.hostId == hostId)
        .map((session) => session.id)
        .toSet();
    final liveRevisionsAtStart = <String, int>{
      for (final sessionId in sessionIdsAtStart)
        sessionId: _liveSessionRevisions[sessionId] ?? 0,
    };
    if (showProgress) {
      refreshing = true;
      error = null;
      notifyListeners();
    }
    try {
      final result = await transport
          .request('sessions.refresh', const <String, Object?>{});
      if (_transport != transport || activeHost?.hostId != hostId) return false;
      final refreshedSessions = jsonList(result['sessions'])
          .map(RemoteSession.fromJson)
          .where((session) =>
              session.hostId == hostId &&
              _isMobileProviderEnabled(session.providerId))
          .toList(growable: false);
      final refreshedIds =
          refreshedSessions.map((session) => session.id).toSet();
      sessions.removeWhere((session) {
        if (!_isMobileProviderEnabled(session.providerId)) return true;
        if (session.hostId != hostId ||
            session.parentSessionId != null ||
            _preparedSessionIds.contains(session.id) ||
            refreshedIds.contains(session.id)) {
          return false;
        }
        final createdWhileRefreshing = !sessionIdsAtStart.contains(session.id);
        final changedWhileRefreshing =
            (_liveSessionRevisions[session.id] ?? 0) >
                (liveRevisionsAtStart[session.id] ?? 0);
        return !createdWhileRefreshing && !changedWhileRefreshing;
      });
      for (final refreshed in refreshedSessions) {
        final current =
            sessions.where((session) => session.id == refreshed.id).firstOrNull;
        if (current != null &&
            ((!sessionIdsAtStart.contains(refreshed.id)) ||
                (_liveSessionRevisions[refreshed.id] ?? 0) >
                    (liveRevisionsAtStart[refreshed.id] ?? 0))) {
          _upsertSession(_preserveLiveSessionFields(refreshed, current));
        } else {
          _upsertSession(refreshed);
        }
      }
      _mergeRecentModelUsesFromSessions(refreshedSessions);
      sessions.removeWhere(
          (session) => !_isMobileProviderEnabled(session.providerId));
      await _reconcileUnreadAfterRefresh(
          sessions.where((session) => session.hostId == hostId));
      final timestamp = optionalString(result, 'lastSuccessfulRefreshAt');
      if (timestamp != null)
        lastSuccessfulRefresh = DateTime.tryParse(timestamp)?.toLocal();
      if (loadProviders) await _loadProviders(transport);
      return _transport == transport && activeHost?.hostId == hostId;
    } on Object catch (caught) {
      if (_transport == transport && activeHost?.hostId == hostId) {
        error = _connectionError(caught, fallback: 'Couldn\'t refresh tasks.');
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

  Future<void> loadSessionHistoryFor(RemoteSession session) async {
    if (!_isMobileProviderEnabled(session.providerId) ||
        !_belongsToActiveHost(session)) {
      return;
    }
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
    final cacheGeneration = _hostSessionCacheGeneration;
    notifyListeners();
    unawaited(_finishOpeningSessionForView(session, cacheGeneration));
  }

  Future<void> _finishOpeningSessionForView(
      RemoteSession session, int cacheGeneration) async {
    try {
      await _loadSessionHistory(session, notifyOnComplete: false);
    } on Object catch (caught) {
      if (_hostSessionCacheGeneration == cacheGeneration &&
          activeHost?.hostId == session.hostId) {
        error = caught.toString();
      }
    } finally {
      if (_hostSessionCacheGeneration == cacheGeneration &&
          activeHost?.hostId == session.hostId) {
        _sessionHistoryLoads.remove(session.id);
        notifyListeners();
      }
    }
  }

  Future<List<RemoteModel>> loadModels(
    String providerId, {
    bool force = false,
    bool surfaceErrors = true,
  }) async {
    if (!_isMobileProviderEnabled(providerId)) {
      return const <RemoteModel>[];
    }
    final cached = modelsByProvider[providerId];
    if (!force && cached != null) {
      _mergeRecentModelUsesFromSessions(
          sessions.where((session) => session.providerId == providerId));
      return cached;
    }
    final hostId = activeHost?.hostId;
    final loadKey = '$_transportEpoch:${hostId ?? 'unpaired'}:$providerId';
    final inFlight = _modelLoads[loadKey];
    if (inFlight != null) {
      if (!force) return inFlight;
      try {
        await inFlight;
      } on Object {
        // A forced refresh must still get one post-configuration attempt.
      }
    }
    final load = _loadModels(
      providerId,
      hostId,
      surfaceErrors: surfaceErrors,
    );
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

  bool _isAmbiguousModelValue(String? value) => const <String>{
        '',
        'auto',
        'default',
        'cli default',
        'session default'
      }.contains(value?.trim().toLowerCase() ?? '');

  String? _concreteRecentModelKey(String providerId, String? reportedModel) {
    if (_isAmbiguousModelValue(reportedModel)) return null;
    final normalizedProvider = providerId.trim().toLowerCase();
    final providerEntry = modelsByProvider.entries
        .where((entry) => entry.key.trim().toLowerCase() == normalizedProvider)
        .firstOrNull;
    if (providerEntry == null) return null;
    final normalizedModel = reportedModel!.trim().toLowerCase();
    final idMatch = providerEntry.value
        .where((model) => model.id.trim().toLowerCase() == normalizedModel)
        .firstOrNull;
    final nameMatches = providerEntry.value
        .where((model) =>
            model.displayName.trim().toLowerCase() == normalizedModel)
        .toList(growable: false);
    final model =
        idMatch ?? (nameMatches.length == 1 ? nameMatches.first : null);
    return model == null
        ? null
        : _modelSelectionKey(model.providerId, model.id);
  }

  void _recordRecentModelUse(
    String providerId,
    String? modelId,
    DateTime usedAt, {
    bool acceptedSelection = false,
  }) {
    final concreteKey = _concreteRecentModelKey(providerId, modelId);
    final trimmedProvider = providerId.trim();
    final trimmedModel = modelId?.trim();
    final key = concreteKey ??
        (acceptedSelection &&
                trimmedProvider.isNotEmpty &&
                !_isAmbiguousModelValue(trimmedModel)
            ? _modelSelectionKey(trimmedProvider, trimmedModel!)
            : null);
    if (key == null) return;
    _mergeRecentModelUses(<RecentModelUse>[
      RecentModelUse(key: key, usedAt: usedAt.toUtc()),
    ]);
  }

  DateTime _acceptedModelUseAt(RemoteSession session) {
    final now = DateTime.now().toUtc();
    final knownActivity = session.lastActivityAt.toUtc();
    return now.isAfter(knownActivity)
        ? now
        : knownActivity.add(const Duration(microseconds: 1));
  }

  void _mergeRecentModelUsesFromSessions(Iterable<RemoteSession> observed) {
    final uses = <RecentModelUse>[];
    for (final session in observed) {
      if (session.sessionKind == 'internal' ||
          session.providerSessionId.trim().isEmpty ||
          _preparedSessionIds.contains(session.id) ||
          session.lastActivityAt.millisecondsSinceEpoch <= 0) {
        continue;
      }
      final key = _concreteRecentModelKey(session.providerId, session.modelId);
      if (key == null) continue;
      uses.add(RecentModelUse(
        key: key,
        usedAt: session.lastActivityAt.toUtc(),
      ));
    }
    _mergeRecentModelUses(uses);
  }

  void _mergeRecentModelUses(Iterable<RecentModelUse> observed) {
    var changed = false;
    for (final use in observed) {
      if (use.usedAt.millisecondsSinceEpoch <= 0) continue;
      final previous = _recentModelUsedAt[use.key];
      if (previous != null && !use.usedAt.isAfter(previous)) continue;
      _recentModelUsedAt[use.key] = use.usedAt.toUtc();
      changed = true;
    }
    if (!changed) return;
    _rebuildRecentModelKeys();
    notifyListeners();
    final snapshot = recentModelKeys
        .map((key) => RecentModelUse(
              key: key,
              usedAt: _recentModelUsedAt[key]!,
            ))
        .toList(growable: false);
    _recentModelWrites = _recentModelWrites
        .then((_) => security.saveRecentModelUses(snapshot))
        .catchError((Object _) {});
  }

  void _rebuildRecentModelKeys() {
    final ordered = _recentModelUsedAt.entries.toList()
      ..sort((left, right) {
        final byTime = right.value.compareTo(left.value);
        return byTime != 0 ? byTime : left.key.compareTo(right.key);
      });
    if (ordered.length > _recentModelHistoryLimit) {
      for (final stale in ordered.skip(_recentModelHistoryLimit)) {
        _recentModelUsedAt.remove(stale.key);
      }
      ordered.removeRange(_recentModelHistoryLimit, ordered.length);
    }
    recentModelKeys
      ..clear()
      ..addAll(ordered.map((entry) => entry.key));
  }

  DelegationSelection? agentDefaultSelectionFor(
    String providerId,
    Iterable<RemoteModel> availableModels,
  ) {
    final models = availableModels
        .where((model) => model.providerId == providerId)
        .toList(growable: false);
    if (models.isEmpty) return null;
    final saved = agentDefaults[providerId];
    final model = models
            .where((candidate) => candidate.id == saved?.modelId)
            .firstOrNull ??
        models.where((candidate) => candidate.isDefault).firstOrNull ??
        models.first;
    final efforts = model.reasoningEfforts;
    final savedEffort = saved?.modelId == model.id
        ? efforts
            .where((effort) => effort.id == saved?.reasoningEffort)
            .firstOrNull
            ?.id
        : null;
    final defaultEffort = efforts
            .where((effort) => effort.id == model.defaultReasoningEffort)
            .firstOrNull
            ?.id ??
        efforts.firstOrNull?.id;
    return DelegationSelection(
      providerId: providerId,
      modelId: model.id,
      reasoningEffort: savedEffort ?? defaultEffort,
    );
  }

  Future<void> setAgentDefault(DelegationSelection selection) async {
    final providerId = selection.providerId.trim().toLowerCase();
    final models = modelsByProvider[providerId] ?? const <RemoteModel>[];
    final model = models
        .where((candidate) => candidate.id == selection.modelId)
        .firstOrNull;
    if (model == null) {
      throw StateError('Choose a model currently available through this Agent');
    }
    final reasoningEffort = selection.reasoningEffort?.trim();
    if (model.reasoningEfforts.isEmpty && reasoningEffort != null) {
      throw StateError('That model does not expose a reasoning setting');
    }
    if (model.reasoningEfforts.isNotEmpty &&
        !model.reasoningEfforts.any((effort) => effort.id == reasoningEffort)) {
      throw StateError('Choose a reasoning value supported by this model');
    }
    final normalized = DelegationSelection(
      providerId: providerId,
      modelId: model.id,
      reasoningEffort: reasoningEffort,
    );
    agentDefaults[providerId] = normalized;
    notifyListeners();
    await security.saveAgentDefault(normalized);
  }

  List<RemoteModel> recentModels(Iterable<RemoteModel> models) {
    final byKey = <String, RemoteModel>{
      for (final model in models)
        _modelSelectionKey(model.providerId, model.id): model,
    };
    return recentModelKeys
        .map((key) => byKey[key])
        .whereType<RemoteModel>()
        .take(_recentModelVisibleLimit)
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
      final transport = _requireTransport();
      final hostId = activeHost?.hostId;
      final result = await transport.request(
        'wallet.get',
        <String, Object?>{
          'providerId': providerId,
          if (modelId?.trim().isNotEmpty == true) 'modelId': modelId!.trim(),
          if (normalizedEndpointId?.isNotEmpty == true)
            'endpointId': normalizedEndpointId,
        },
        timeout: const Duration(seconds: 8),
      );
      if (_transport != transport || activeHost?.hostId != hostId) return null;
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
    bool validateApiKey = false,
    bool clearApiKey = false,
    bool clearBalance = false,
    double? setBalance,
    double? addBalance,
    JsonMap? customEndpoint,
  }) async {
    final transport = _requireTransport();
    final hostId = activeHost?.hostId;
    final result = await transport.request(
      'wallet.configure',
      <String, Object?>{
        'providerId': providerId,
        'endpointId': endpointId,
        if (apiKey?.trim().isNotEmpty == true) 'apiKey': apiKey!.trim(),
        if (validateApiKey) 'validateApiKey': true,
        if (clearApiKey) 'clearApiKey': true,
        if (clearBalance) 'clearBalance': true,
        if (setBalance != null) 'setBalance': setBalance,
        if (addBalance != null) 'addBalance': addBalance,
        if (customEndpoint != null) 'customEndpoint': customEndpoint,
      },
      timeout: const Duration(seconds: 15),
    );
    if (_transport != transport || activeHost?.hostId != hostId) {
      throw StateError('The active host changed while wallet state was saving');
    }
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
      _invalidateVisionProxyTargets();
      await loadModels(providerId, force: true, surfaceErrors: false);
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

  List<VisionProxyTarget> get cachedVisionProxyTargets =>
      List<VisionProxyTarget>.unmodifiable(_visionProxyTargets);
  bool get visionProxyTargetsIncomplete => _visionProxyTargetsIncomplete;
  int get visionProxyTargetsRevision => _visionProxyTargetGeneration;

  Future<List<VisionProxyTarget>> loadVisionProxyTargets(
      {bool force = false}) async {
    final hostId = activeHost?.hostId;
    if (_visionProxyTargetHostId != hostId) {
      _invalidateVisionProxyTargets();
      _visionProxyTargetHostId = hostId;
    }
    final existing = _visionProxyTargetLoad;
    if (existing != null &&
        _visionProxyTargetLoadGeneration == _visionProxyTargetGeneration) {
      return existing;
    }
    if (force) {
      _visionProxyTargetGeneration += 1;
      _visionProxyTargetsLoaded = false;
    }
    if (!force && _visionProxyTargetsLoaded) {
      return cachedVisionProxyTargets;
    }
    final generation = _visionProxyTargetGeneration;
    final transport = _requireTransport();
    final load = transport
        .request('vision.targets', const <String, Object?>{},
            timeout: const Duration(seconds: 8))
        .then((result) {
      final targets = jsonList(result['targets'])
          .map(VisionProxyTarget.fromJson)
          .toList(growable: false);
      final incomplete = result['incomplete'] == true;
      if (_transport != transport ||
          activeHost?.hostId != hostId ||
          _visionProxyTargetGeneration != generation) {
        final currentHostId = activeHost?.hostId;
        if (_visionProxyTargetHostId != currentHostId) {
          _invalidateVisionProxyTargets();
          _visionProxyTargetHostId = currentHostId;
        }
        return cachedVisionProxyTargets;
      }
      if (!incomplete || targets.isNotEmpty || _visionProxyTargets.isEmpty) {
        final freshProviders =
            targets.map((target) => target.providerId).toSet();
        final retained = incomplete
            ? _visionProxyTargets
                .where((target) => !freshProviders.contains(target.providerId))
                .toList(growable: false)
            : const <VisionProxyTarget>[];
        _visionProxyTargets
          ..clear()
          ..addAll(targets)
          ..addAll(retained);
      }
      _visionProxyTargetsIncomplete = incomplete;
      _visionProxyTargetsLoaded = !incomplete;
      notifyListeners();
      return cachedVisionProxyTargets;
    });
    _visionProxyTargetLoad = load;
    _visionProxyTargetLoadGeneration = generation;
    return load.whenComplete(() {
      if (identical(_visionProxyTargetLoad, load)) {
        _visionProxyTargetLoad = null;
        _visionProxyTargetLoadGeneration = -1;
      }
    });
  }

  void _invalidateVisionProxyTargets() {
    _visionProxyTargetGeneration += 1;
    _visionProxyTargetsLoaded = false;
    _visionProxyTargets.clear();
    _visionProxyTargetsIncomplete = false;
  }

  void _invalidateVisionStatuses() {
    _visionStatusEpoch += 1;
    visionBySession.clear();
    _visionStatusGenerations.clear();
    _visionStatusLoads.clear();
    _visionStatusFailureCounts.clear();
    _visionStatusRetryAfter.clear();
  }

  Duration visionStatusRetryDelay(String sessionId) {
    final retryAt = _visionStatusRetryAfter[sessionId];
    if (retryAt == null) return Duration.zero;
    final remaining = retryAt.difference(DateTime.now());
    return remaining.isNegative ? Duration.zero : remaining;
  }

  void _recordVisionStatusFailure(String sessionId) {
    final failures = (_visionStatusFailureCounts[sessionId] ?? 0) + 1;
    _visionStatusFailureCounts[sessionId] = failures;
    final exponent = failures > 7 ? 7 : failures - 1;
    final milliseconds = 250 * (1 << exponent);
    _visionStatusRetryAfter[sessionId] = DateTime.now().add(
      Duration(milliseconds: milliseconds > 30000 ? 30000 : milliseconds),
    );
  }

  void _clearVisionStatusFailure(String sessionId) {
    _visionStatusFailureCounts.remove(sessionId);
    _visionStatusRetryAfter.remove(sessionId);
  }

  Future<void> _refreshSelectedVisionStatus(
    BridgeTransport transport,
    String hostId,
    int transportEpoch,
  ) async {
    bool isCurrent() =>
        _transport == transport &&
        activeHost?.hostId == hostId &&
        _transportEpoch == transportEpoch;

    if (!isCurrent()) return;
    final selected = selectedSession;
    if (selected == null || selected.hostId != hostId) return;
    try {
      await loadVisionProxy(selected.id);
    } on Object {
      // The selected task surface owns quiet retry and user-facing recovery.
    }
  }

  Future<VisionProxyStatus> loadVisionProxy(String sessionId) {
    final existing = _visionStatusLoads[sessionId];
    if (existing != null) return existing;
    final load = _loadVisionProxy(sessionId);
    _visionStatusLoads[sessionId] = load;
    return load.whenComplete(() {
      _visionStatusLoads.removeWhere(
        (key, value) => key == sessionId && identical(value, load),
      );
    });
  }

  Future<VisionProxyStatus> _loadVisionProxy(String sessionId) async {
    final transport = _requireTransport();
    final hostId = activeHost?.hostId;
    final generation = _visionStatusGenerations[sessionId] ?? 0;
    final epoch = _visionStatusEpoch;
    try {
      final result = await transport.request(
          'session.vision.get', <String, Object?>{'sessionId': sessionId},
          timeout: const Duration(seconds: 8));
      if (_transport != transport ||
          activeHost?.hostId != hostId ||
          _visionStatusEpoch != epoch) {
        throw StateError(
            'The active host changed while visual support was syncing');
      }
      final status = VisionProxyStatus.fromJson(result['vision']);
      if (status.sessionId != sessionId) {
        throw const FormatException(
            'Visual support status belongs to another session');
      }
      if ((_visionStatusGenerations[sessionId] ?? 0) != generation) {
        final current = visionBySession[sessionId];
        if (current != null) return current;
        throw StateError('Visual support changed while its status was syncing');
      }
      _clearVisionStatusFailure(sessionId);
      visionBySession[sessionId] = status;
      notifyListeners();
      return status;
    } on Object {
      if (_transport == transport &&
          activeHost?.hostId == hostId &&
          _visionStatusEpoch == epoch) {
        _recordVisionStatusFailure(sessionId);
      }
      rethrow;
    }
  }

  Future<VisionProxyStatus> configureVisionProxy(
      String sessionId, VisionProxySelection? selection) async {
    final transport = _requireTransport();
    final hostId = activeHost?.hostId;
    final epoch = _visionStatusEpoch;
    final generation = (_visionStatusGenerations[sessionId] ?? 0) + 1;
    _visionStatusGenerations[sessionId] = generation;
    final result = await transport.request(
        'session.vision.configure',
        <String, Object?>{
          'sessionId': sessionId,
          'selection': selection?.toJson(),
        },
        timeout: const Duration(seconds: 12));
    if (_transport != transport ||
        activeHost?.hostId != hostId ||
        _visionStatusEpoch != epoch) {
      throw StateError(
          'The active host changed while visual support was saving');
    }
    final status = VisionProxyStatus.fromJson(result['vision']);
    if (status.sessionId != sessionId) {
      throw const FormatException(
          'Visual support status belongs to another session');
    }
    if ((_visionStatusGenerations[sessionId] ?? 0) != generation) {
      final current = visionBySession[sessionId];
      if (current != null) return current;
      throw StateError('Visual support changed while it was saving');
    }
    _clearVisionStatusFailure(sessionId);
    visionBySession[sessionId] = status;
    notifyListeners();
    return status;
  }

  Future<SessionContextState> loadSessionContext(String sessionId) async {
    final transport = _requireTransport();
    final hostId = activeHost?.hostId;
    final expectedSession = _sessionForContextRequest(sessionId, hostId);
    if (hostId == null || expectedSession == null) {
      throw StateError('That task is no longer on the active host');
    }
    final generation = (_contextRequestGenerations[sessionId] ?? 0) + 1;
    _contextRequestGenerations[sessionId] = generation;
    final result = await transport.request(
        'session.context.get', <String, Object?>{'sessionId': sessionId});
    _validateContextRequest(
        transport, hostId, sessionId, expectedSession, generation);
    final context = SessionContextState.fromJson(result['context']);
    if (context.sessionId != sessionId) {
      throw const FormatException('Session context belongs to another task');
    }
    contextBySession[sessionId] = context;
    notifyListeners();
    return context;
  }

  Future<SessionGoal?> loadSessionGoal(String sessionId) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    final expectedRevision = goalsBySession[sessionId]?.revision ?? -1;
    final expectedClearRevision = _goalClearRevisions[sessionId] ?? -1;
    final result = await origin.transport
        .request('session.goal.get', <String, Object?>{'sessionId': sessionId});
    _requireTransportOrigin(origin, action: 'the task goal was being loaded');
    final value = result['goal'];
    if (value == null) {
      final currentRevision = goalsBySession[sessionId]?.revision ?? -1;
      final currentClearRevision = _goalClearRevisions[sessionId] ?? -1;
      if (currentRevision <= expectedRevision &&
          currentClearRevision <= expectedClearRevision) {
        goalsBySession.remove(sessionId);
      }
      notifyListeners();
      return goalsBySession[sessionId];
    }
    final goal = SessionGoal.fromJson(value);
    if (goal.sessionId != sessionId) {
      throw const FormatException('Session goal belongs to another task');
    }
    final clearedThrough = _goalClearRevisions[sessionId] ?? -1;
    final currentRevision = goalsBySession[sessionId]?.revision ?? -1;
    if (goal.revision > clearedThrough && goal.revision >= currentRevision) {
      goalsBySession[sessionId] = goal;
    }
    notifyListeners();
    return goalsBySession[sessionId];
  }

  Future<SessionGoal> setSessionGoal(
    String sessionId, {
    String? objective,
    String? status,
    int? tokenBudget,
    bool clearTokenBudget = false,
  }) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    final result =
        await origin.transport.request('session.goal.set', <String, Object?>{
      'sessionId': sessionId,
      if (objective != null) 'objective': objective,
      if (status != null) 'status': status,
      if (clearTokenBudget)
        'tokenBudget': null
      else if (tokenBudget != null)
        'tokenBudget': tokenBudget,
    });
    _requireTransportOrigin(origin, action: 'the task goal was being updated');
    final goal = SessionGoal.fromJson(result['goal']);
    if (goal.sessionId != sessionId) {
      throw const FormatException('Session goal belongs to another task');
    }
    final clearedThrough = _goalClearRevisions[sessionId] ?? -1;
    final currentRevision = goalsBySession[sessionId]?.revision ?? -1;
    if (goal.revision > clearedThrough && goal.revision >= currentRevision) {
      goalsBySession[sessionId] = goal;
    }
    notifyListeners();
    final current = goalsBySession[sessionId];
    if (current == null) {
      throw StateError('Goal changed while the update was pending');
    }
    return current;
  }

  Future<void> clearSessionGoal(String sessionId) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    final result = await origin.transport.request(
        'session.goal.clear', <String, Object?>{'sessionId': sessionId});
    _requireTransportOrigin(origin, action: 'the task goal was being cleared');
    final cleared = result['cleared'];
    final returnedRevision = result['revision'];
    if (cleared is! bool ||
        returnedRevision is! num ||
        !returnedRevision.isFinite ||
        returnedRevision != returnedRevision.roundToDouble() ||
        returnedRevision < 0) {
      throw const FormatException('Session goal clear result is invalid');
    }
    final revision = returnedRevision.toInt();
    if (cleared) {
      final currentRevision = goalsBySession[sessionId]?.revision ?? -1;
      if (revision >= currentRevision) goalsBySession.remove(sessionId);
      final clearedThrough = _goalClearRevisions[sessionId] ?? -1;
      if (revision > clearedThrough) _goalClearRevisions[sessionId] = revision;
    }
    notifyListeners();
  }

  Future<SessionContextState> setSessionCompactionThreshold(
    String sessionId,
    int thresholdTokens, {
    required bool compactNow,
  }) async {
    final transport = _requireTransport();
    final hostId = activeHost?.hostId;
    final expectedSession = _sessionForContextRequest(sessionId, hostId);
    if (hostId == null || expectedSession == null) {
      throw StateError('That task is no longer on the active host');
    }
    final generation = (_contextRequestGenerations[sessionId] ?? 0) + 1;
    _contextRequestGenerations[sessionId] = generation;
    final result = await transport
        .request('session.context.set_threshold', <String, Object?>{
      'sessionId': sessionId,
      'thresholdTokens': thresholdTokens,
      'compactNow': compactNow,
    });
    _validateContextRequest(
        transport, hostId, sessionId, expectedSession, generation);
    final context = SessionContextState.fromJson(result['context']);
    if (context.sessionId != sessionId) {
      throw const FormatException('Session context belongs to another task');
    }
    contextBySession[sessionId] = context;
    notifyListeners();
    return context;
  }

  RemoteSession? _sessionForContextRequest(String sessionId, String? hostId) {
    if (hostId == null) return null;
    return sessions
            .where((session) =>
                session.id == sessionId && session.hostId == hostId)
            .firstOrNull ??
        (selectedSession?.id == sessionId && selectedSession?.hostId == hostId
            ? selectedSession
            : null);
  }

  void _validateContextRequest(
    BridgeTransport transport,
    String hostId,
    String sessionId,
    RemoteSession expectedSession,
    int generation,
  ) {
    if (_transport != transport || activeHost?.hostId != hostId) {
      throw StateError('The active host changed while context was syncing');
    }
    final current = _sessionForContextRequest(sessionId, hostId);
    if (current == null ||
        current.providerId != expectedSession.providerId ||
        current.providerSessionId != expectedSession.providerSessionId) {
      throw StateError('The active task changed while context was syncing');
    }
    if ((_contextRequestGenerations[sessionId] ?? 0) != generation) {
      throw StateError('A newer context update replaced this response');
    }
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
    String providerId,
    String? hostId, {
    required bool surfaceErrors,
  }) async {
    final transport = _transport;
    if (transport == null) {
      return modelsByProvider[providerId] ?? const <RemoteModel>[];
    }
    try {
      final result = await transport
          .request('models.list', <String, Object?>{'providerId': providerId});
      final models = jsonList(result['models'])
          .map(RemoteModel.fromJson)
          .toList(growable: false);
      if (_transport != transport || activeHost?.hostId != hostId) {
        return modelsByProvider[providerId] ?? const <RemoteModel>[];
      }
      _modelLoadFailures.remove(providerId);
      modelsByProvider[providerId] = models;
      _mergeRecentModelUsesFromSessions(
          sessions.where((session) => session.providerId == providerId));
      notifyListeners();
      return models;
    } on Object catch (caught) {
      if (_transport != transport || activeHost?.hostId != hostId) {
        return modelsByProvider[providerId] ?? const <RemoteModel>[];
      }
      if (surfaceErrors) error = caught.toString();
      _modelLoadFailures.add(providerId);
      notifyListeners();
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
    final cacheGeneration = _hostSessionCacheGeneration;
    final hostId = activeHost?.hostId;
    final transport = _requireTransport();
    try {
      final result = await transport.request(
          'session.children', <String, Object?>{'sessionId': parentSessionId});
      if (_transport != transport || activeHost?.hostId != hostId) {
        return childSessionsFor(parentSessionId);
      }
      final childSnapshot = jsonList(result['sessions'])
          .map(RemoteSession.fromJson)
          .where((session) =>
              session.hostId == hostId &&
              session.sessionKind != 'side_chat' &&
              session.parentSessionId == parentSessionId)
          .toList(growable: false);
      final returnedIds = childSnapshot.map((session) => session.id).toSet();
      sessions.removeWhere((session) =>
          session.hostId == hostId &&
          session.sessionKind != 'side_chat' &&
          session.parentSessionId == parentSessionId &&
          !returnedIds.contains(session.id));
      if (selectedSession case final selected?
          when selected.hostId == hostId &&
              selected.sessionKind != 'side_chat' &&
              selected.parentSessionId == parentSessionId &&
              !returnedIds.contains(selected.id)) {
        selectedSession = null;
      }
      for (final session in childSnapshot) {
        _upsertSession(session);
      }
      notifyListeners();
      return childSessionsFor(parentSessionId);
    } finally {
      if (_hostSessionCacheGeneration == cacheGeneration &&
          activeHost?.hostId == hostId) {
        _childSessionLoads.remove(parentSessionId);
      }
    }
  }

  Future<void> _loadSessionHistory(RemoteSession session,
      {bool notifyOnComplete = true,
      BridgeTransport? expectedTransport,
      bool refresh = false}) async {
    final transport = expectedTransport ?? _requireTransport();
    final hostId = activeHost?.hostId;
    if (hostId == null || session.hostId != hostId || _transport != transport) {
      return;
    }
    final origin = _TransportOrigin(transport: transport, hostId: hostId);
    final clearThrough = _lastEventSequenceBySession[session.id] ?? 0;
    final result = await transport.request('session.open', <String, Object?>{
      'sessionId': session.id,
      'limit': 40,
      if (refresh) 'refresh': true,
    });
    if (_transport != transport || activeHost?.hostId != hostId) return;
    final updated = RemoteSession.fromJson(result['session']);
    if (updated.id != session.id || updated.hostId != hostId) return;
    final sessionChanged = _upsertSession(updated);
    final historyImageGeneration =
        (_historyImageGenerations[session.id] ?? 0) + 1;
    _historyImageGenerations[session.id] = historyImageGeneration;
    final snapshotMessages = _applyCachedHistoryImages(
      origin.hostId,
      session.id,
      jsonList(result['messages'])
          .map(RemoteMessage.fromJson)
          .toList(growable: true),
    );
    if (!_transportOriginIsCurrent(origin)) return;
    final localMessages =
        List<RemoteMessage>.of(messages[session.id] ?? const <RemoteMessage>[]);
    final optimisticMessageIds =
        _optimisticMessageIdsBySession[session.id] ?? const <String>{};
    final adoptedOptimisticMessageIds = _adoptedOptimisticUserEchoes(
      snapshotMessages,
      localMessages,
      optimisticMessageIds,
    );
    _adoptLocalAssistantPresentations(snapshotMessages, localMessages);
    final retainedLocalMessages = localMessages
        .where((message) => !optimisticMessageIds.contains(message.id))
        .toList(growable: false);
    final mergedSnapshot = _mergeSnapshotWithLocalArtifacts(
        snapshotMessages, retainedLocalMessages);
    for (final message in localMessages) {
      if (!optimisticMessageIds.contains(message.id) ||
          adoptedOptimisticMessageIds.contains(message.id)) {
        continue;
      }
      mergedSnapshot.add(message);
    }
    mergedSnapshot
        .sort((left, right) => left.createdAt.compareTo(right.createdAt));
    late final List<RemoteMessage> nextMessages;
    if (_historyCursors.containsKey(session.id)) {
      final byId = <String, RemoteMessage>{
        for (final message in retainedLocalMessages) message.id: message,
        for (final message in mergedSnapshot) message.id: message,
      };
      nextMessages = byId.values.toList()
        ..sort((left, right) => left.createdAt.compareTo(right.createdAt));
    } else {
      nextMessages = mergedSnapshot;
    }
    final previousMessages = messages[session.id];
    final reconciledMessages = _preserveEquivalentMessageIdentity(
      previousMessages,
      nextMessages,
    );
    final messageStateChanged =
        !identical(previousMessages, reconciledMessages);
    if (messageStateChanged) messages[session.id] = reconciledMessages;
    final trackedOptimisticIds = _optimisticMessageIdsBySession[session.id];
    trackedOptimisticIds?.removeAll(adoptedOptimisticMessageIds);
    if (trackedOptimisticIds?.isEmpty == true) {
      _optimisticMessageIdsBySession.remove(session.id);
    }
    final nextCursor = optionalString(result, 'nextCursor');
    final cursorStateChanged = _historyCursors[session.id] != nextCursor;
    _historyCursors[session.id] = nextCursor;
    var readAt = updated.lastActivityAt;
    for (final message in messages[session.id]!) {
      if (message.createdAt.isAfter(readAt)) readAt = message.createdAt;
    }
    final retainedEvents = (events[session.id] ?? const <AgentEvent>[])
        .where((event) => event.sequence > clearThrough)
        .toList(growable: true);
    var eventStateChanged = false;
    if (retainedEvents.isEmpty) {
      eventStateChanged = events.remove(session.id) != null;
    } else {
      final previousEvents = events[session.id];
      if (!listEquals(previousEvents, retainedEvents)) {
        events[session.id] = retainedEvents;
        eventStateChanged = true;
      }
    }
    final liveStateChanged =
        retainedEvents.isEmpty && _clearLiveAssistant(session.id);
    final readStateChanged = _markSessionRead(session.id, readAt);
    if (notifyOnComplete &&
        (sessionChanged ||
            messageStateChanged ||
            cursorStateChanged ||
            eventStateChanged ||
            liveStateChanged ||
            readStateChanged)) {
      notifyListeners();
    }
    if (readStateChanged) {
      unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
    }
    unawaited(_hydrateHistoryImages(
      origin,
      session.id,
      snapshotMessages,
      historyImageGeneration,
    ).catchError((Object _) {}));
  }

  Future<bool> loadOlderSessionHistory(String sessionId) async {
    final cursor = _historyCursors[sessionId];
    if (cursor == null) return false;
    final origin = _captureTransportOrigin(sessionId: sessionId);
    if (!_olderHistoryLoads.add(sessionId)) return false;
    final cacheGeneration = _hostSessionCacheGeneration;
    final transport = origin.transport;
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
        _requireTransportOrigin(origin,
            action: 'older messages were being loaded');
        final session = sessions
            .where((candidate) => candidate.id == sessionId)
            .firstOrNull;
        if (session == null) rethrow;
        _historyCursors.remove(sessionId);
        await _loadSessionHistory(session, expectedTransport: transport);
        return true;
      }
      _requireTransportOrigin(origin,
          action: 'older messages were being loaded');
      final older = _applyCachedHistoryImages(
        origin.hostId,
        sessionId,
        jsonList(result['messages'])
            .map(RemoteMessage.fromJson)
            .toList(growable: false),
      );
      _requireTransportOrigin(origin,
          action: 'older messages were being loaded');
      final current = messages[sessionId] ?? const <RemoteMessage>[];
      final byId = <String, RemoteMessage>{
        for (final message in older) message.id: message,
        for (final message in current) message.id: message,
      };
      final nextMessages = byId.values.toList()
        ..sort((left, right) => left.createdAt.compareTo(right.createdAt));
      messages[sessionId] =
          _preserveEquivalentMessageIdentity(messages[sessionId], nextMessages);
      final historyImageGeneration =
          (_historyImageGenerations[sessionId] ?? 0) + 1;
      _historyImageGenerations[sessionId] = historyImageGeneration;
      _historyCursors[sessionId] = optionalString(result, 'nextCursor');
      notifyListeners();
      unawaited(_hydrateHistoryImages(
        origin,
        sessionId,
        messages[sessionId]!,
        historyImageGeneration,
      ).catchError((Object _) {}));
      return older.isNotEmpty;
    } finally {
      if (_hostSessionCacheGeneration == cacheGeneration &&
          _transportOriginIsCurrent(origin)) {
        _olderHistoryLoads.remove(sessionId);
        notifyListeners();
      }
    }
  }

  bool _isExpiredMessageHistoryPage(Object caught) =>
      caught.toString().toLowerCase().contains('message history page expired');

  List<RemoteMessage> _applyCachedHistoryImages(
    String hostId,
    String sessionId,
    List<RemoteMessage> history,
  ) {
    return history.map((message) {
      var changed = false;
      final parts = message.parts.map((part) {
        final retrievalId = optionalString(part.data, 'retrievalId');
        if (part.type != 'image' ||
            part.attachmentUri != null ||
            retrievalId == null) {
          return part;
        }
        final cached = _historyImageCache[
            _historyImageCacheKey(hostId, sessionId, retrievalId)];
        if (cached == null) return part;
        changed = true;
        return cached;
      }).toList(growable: false);
      return changed ? _remoteMessageWithParts(message, parts) : message;
    }).toList(growable: true);
  }

  Future<void> _hydrateHistoryImages(
    _TransportOrigin origin,
    String sessionId,
    List<RemoteMessage> history,
    int generation,
  ) async {
    final pending = <({
      String messageId,
      int partIndex,
      String retrievalId,
      ContentPart part,
    })>[];
    for (final message in history) {
      for (var partIndex = 0;
          partIndex < message.parts.length;
          partIndex += 1) {
        final part = message.parts[partIndex];
        final retrievalId = optionalString(part.data, 'retrievalId');
        if (part.type != 'image' ||
            part.attachmentUri != null ||
            retrievalId == null) {
          continue;
        }
        pending.add((
          messageId: message.id,
          partIndex: partIndex,
          retrievalId: retrievalId,
          part: part,
        ));
      }
    }
    if (pending.isEmpty) return;
    var nextIndex = 0;
    Future<void> worker() async {
      while (nextIndex < pending.length) {
        final item = pending[nextIndex];
        nextIndex += 1;
        final replacement = await _loadHistoryImagePart(
          origin,
          sessionId,
          item.retrievalId,
          item.part,
        );
        if (replacement == null) continue;
        _applyHydratedHistoryImage(
          origin,
          sessionId,
          generation,
          item.messageId,
          item.partIndex,
          item.retrievalId,
          replacement,
        );
      }
    }

    final workerCount = pending.length < 3 ? pending.length : 3;
    await Future.wait(List<Future<void>>.generate(
      workerCount,
      (_) => worker(),
      growable: false,
    ));
  }

  Future<ContentPart?> _loadHistoryImagePart(
    _TransportOrigin origin,
    String sessionId,
    String retrievalId,
    ContentPart part,
  ) async {
    final cacheKey =
        _historyImageCacheKey(origin.hostId, sessionId, retrievalId);
    final cached = _historyImageCache[cacheKey];
    if (cached != null) return cached;
    final loadKey = '${identityHashCode(origin.transport)}\u0000$cacheKey';
    final existing = _historyImageLoads[loadKey];
    if (existing != null) return existing;
    final load = () async {
      final replacement = await _retrieveHistoryImage(
        origin,
        sessionId,
        retrievalId,
        part,
      );
      if (replacement != null && _transportOriginIsCurrent(origin)) {
        _historyImageCache[cacheKey] = replacement;
      }
      return replacement;
    }();
    _historyImageLoads[loadKey] = load;
    try {
      return await load;
    } finally {
      if (identical(_historyImageLoads[loadKey], load)) {
        unawaited(_historyImageLoads.remove(loadKey)?.then<void>((_) {}));
      }
    }
  }

  void _applyHydratedHistoryImage(
    _TransportOrigin origin,
    String sessionId,
    int generation,
    String messageId,
    int expectedPartIndex,
    String retrievalId,
    ContentPart replacement,
  ) {
    if (!_transportOriginIsCurrent(origin) ||
        _historyImageGenerations[sessionId] != generation) {
      return;
    }
    final history = messages[sessionId];
    if (history == null) return;
    final messageIndex =
        history.indexWhere((message) => message.id == messageId);
    if (messageIndex < 0) return;
    final message = history[messageIndex];
    var partIndex = expectedPartIndex;
    if (partIndex >= message.parts.length ||
        optionalString(message.parts[partIndex].data, 'retrievalId') !=
            retrievalId) {
      partIndex = message.parts.indexWhere(
          (part) => optionalString(part.data, 'retrievalId') == retrievalId);
    }
    if (partIndex < 0 || message.parts[partIndex].attachmentUri != null) return;
    final parts = List<ContentPart>.of(message.parts);
    parts[partIndex] = replacement;
    final nextHistory = List<RemoteMessage>.of(history);
    nextHistory[messageIndex] = _remoteMessageWithParts(message, parts);
    messages[sessionId] = nextHistory;
    notifyListeners();
  }

  Future<ContentPart?> _retrieveHistoryImage(
    _TransportOrigin origin,
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
        if (!_transportOriginIsCurrent(origin)) return null;
        final result = await origin.transport.request(
          'session.image.get',
          <String, Object?>{
            'sessionId': sessionId,
            'retrievalId': retrievalId,
            'offset': offset,
          },
        );
        if (!_transportOriginIsCurrent(origin)) return null;
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

  bool _destinationAcceptsAudio(String sessionId, String? modelId) {
    final session = sessions.where((item) => item.id == sessionId).firstOrNull;
    if (session == null || !providerDeliversNativeAudio(session.providerId)) {
      return false;
    }
    final resolvedId = modelId ?? session.modelId;
    final models =
        modelsByProvider[session.providerId] ?? const <RemoteModel>[];
    final model = models.where((item) => item.id == resolvedId).firstOrNull;
    return model?.supportsAudioInput == true;
  }

  Future<({String content, List<RemoteAttachment> attachments})>
      _prepareOutgoing(
    String sessionId,
    String content,
    List<RemoteAttachment> attachments, {
    String? modelId,
    required _TransportOrigin origin,
  }) async {
    _requireTransportOrigin(origin, action: 'the message was being prepared');
    final clips =
        attachments.where(isDictationAudioAttachment).toList(growable: false);
    if (clips.isEmpty) {
      return (content: content, attachments: attachments);
    }
    if (_destinationAcceptsAudio(sessionId, modelId)) {
      return (content: content, attachments: attachments);
    }
    final earsSnapshot = ears;
    if (!earsSnapshot.enabled) {
      throw StateError(
          'This model does not accept direct audio. Enable EARS or choose an audio-capable model.');
    }
    if (earsSnapshot.providerId == null || earsSnapshot.modelId == null) {
      throw StateError('Choose an EARS model before sending dictation.');
    }
    final operation = _EarsOperation(origin);
    _earsOperationsBySession
        .putIfAbsent(sessionId, () => <_EarsOperation>{})
        .add(operation);
    notifyListeners();
    final uploaded = <String>[];
    final transcripts = <String>[];
    try {
      for (var offset = 0;
          offset < clips.length;
          offset += _maxEarsAttachmentsPerRequest) {
        operation.throwIfCancelled();
        final end = (offset + _maxEarsAttachmentsPerRequest)
            .clamp(0, clips.length)
            .toInt();
        final batch = clips.sublist(offset, end);
        final batchUploads = await _uploadAttachments(
          batch,
          origin: origin,
          checkCancelled: operation.throwIfCancelled,
        );
        uploaded.addAll(batchUploads);
        operation.throwIfCancelled();
        final requestId = randomId('ears');
        operation.currentBridgeRequestId = requestId;
        late final JsonMap result;
        try {
          _requireTransportOrigin(origin,
              action: 'EARS was processing the recording');
          result = await origin.transport.request(
            'ears.process',
            <String, Object?>{
              'providerId': earsSnapshot.providerId,
              'modelId': earsSnapshot.modelId,
              'mode': earsSnapshot.mode,
              'attachmentIds': batchUploads,
              if (!_preparedSessionIds.contains(sessionId))
                'sessionId': sessionId,
              'requestId': requestId,
            },
            requestId: requestId,
            timeout: const Duration(minutes: 3),
          );
          _requireTransportOrigin(origin,
              action: 'EARS was processing the recording');
          operation.throwIfCancelled();
        } finally {
          if (operation.currentBridgeRequestId == requestId) {
            operation.currentBridgeRequestId = null;
          }
        }
        final batchTexts = jsonList(result['texts'])
            .whereType<String>()
            .toList(growable: false);
        if (batchTexts.length != batch.length) {
          throw StateError(
              'EARS did not return text for every dictation recording.');
        }
        transcripts.addAll(batchTexts);
        operation.throwIfCancelled();
      }
      final composed = composeEarsDestinationText(content, transcripts);
      if (composed.trim().isEmpty) {
        throw StateError('EARS did not hear any speech.');
      }
      return (
        content: composed,
        attachments: attachments
            .where((attachment) => !isDictationAudioAttachment(attachment))
            .toList(growable: false),
      );
    } catch (error) {
      for (final uploadId in uploaded) {
        unawaited(origin.transport.request(
          'attachment.upload.cancel',
          <String, Object?>{'uploadId': uploadId},
        ).catchError((Object _) => <String, Object?>{}));
      }
      rethrow;
    } finally {
      final ownedOperations = _earsOperationsBySession[sessionId];
      if (ownedOperations?.remove(operation) == true) {
        if (ownedOperations!.isEmpty) {
          _earsOperationsBySession.remove(sessionId);
        }
        notifyListeners();
      }
    }
  }

  void _validateMessageAttachments(List<RemoteAttachment> attachments) {
    if (attachments.length > maxMessageAttachments) {
      throw StateError(
          'You can attach up to $maxMessageAttachments files to one message.');
    }
    var aggregateBytes = 0;
    for (final attachment in attachments) {
      if (attachment.byteLength <= 0) {
        throw StateError('Attachments cannot be empty.');
      }
      if (attachment.byteLength > maxSingleMessageAttachmentBytes) {
        throw StateError('Each attachment can be up to 25 MiB.');
      }
      aggregateBytes += attachment.byteLength;
      if (aggregateBytes > maxMessageAttachmentBytes) {
        throw StateError('Attachments can total up to 50 MiB per message.');
      }
    }
  }

  _OutgoingCompositionSnapshot _captureOutgoingComposition(
    String sessionId,
    String content,
    List<RemoteAttachment> attachments, {
    String? modelId,
    String? reasoningEffort,
    SimplifySettings? simplify,
  }) {
    final immutableAttachments = List<RemoteAttachment>.unmodifiable(
        List<RemoteAttachment>.of(attachments));
    final immutableSimplify = simplify == null
        ? null
        : SimplifySettings(
            maxWords: simplify.maxWords,
            guidance: simplify.guidance,
          );
    final immutableDelegationSelections =
        List<DelegationSelection>.unmodifiable(
      List<DelegationSelection>.of(
        _draftDelegationSelections[sessionId] ?? const <DelegationSelection>[],
      ),
    );
    final snapshot = _OutgoingCompositionSnapshot(
      hostId: _hostIdForDraftSession(sessionId),
      content: content,
      attachments: immutableAttachments,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      simplify: immutableSimplify,
      delegationSelections: immutableDelegationSelections,
    );
    if (_draftMatchesValues(sessionId, snapshot)) {
      var revision = _draftRevisions[sessionId];
      if (revision == null) {
        revision = ++_nextDraftRevision;
        _draftRevisions[sessionId] = revision;
        _markDraftDirty(sessionId);
      }
      return snapshot.trackedAt(revision);
    }
    // An empty draft can be intentional newer input (for example, the user
    // cleared the composer while a send was pending). Its revision, rather
    // than whether it currently has visible content, owns that distinction.
    final hasNewerDraft = _draftRevisions.containsKey(sessionId);
    if (hasNewerDraft) return snapshot;
    drafts[sessionId] = snapshot.content;
    if (snapshot.attachments.isEmpty) {
      draftAttachments.remove(sessionId);
    } else {
      draftAttachments[sessionId] = snapshot.attachments;
    }
    if (snapshot.simplify == null) {
      draftSimplifySettings.remove(sessionId);
    } else {
      draftSimplifySettings[sessionId] = snapshot.simplify!;
    }
    if (snapshot.delegationSelections.isEmpty) {
      _draftDelegationSelections.remove(sessionId);
    } else {
      _draftDelegationSelections[sessionId] = snapshot.delegationSelections;
    }
    final revision = ++_nextDraftRevision;
    _draftRevisions[sessionId] = revision;
    _markDraftDirty(sessionId);
    return snapshot.trackedAt(revision);
  }

  bool _draftMatchesValues(
      String sessionId, _OutgoingCompositionSnapshot snapshot) {
    if ((drafts[sessionId] ?? '') != snapshot.content) return false;
    final currentAttachments =
        draftAttachments[sessionId] ?? const <RemoteAttachment>[];
    if (!_sameAttachments(currentAttachments, snapshot.attachments)) {
      return false;
    }
    return _sameSimplifySettings(
            draftSimplifySettings[sessionId], snapshot.simplify) &&
        _sameDelegationSelections(
          _draftDelegationSelections[sessionId] ??
              const <DelegationSelection>[],
          snapshot.delegationSelections,
        );
  }

  bool _clearDraftIfUnchanged(
      String sessionId, _OutgoingCompositionSnapshot snapshot) {
    if (!_outgoingStillBelongsToActiveHost(snapshot)) return false;
    final revision = snapshot.draftRevision;
    if (revision == null ||
        _draftRevisions[sessionId] != revision ||
        !_draftMatchesValues(sessionId, snapshot)) {
      return false;
    }
    drafts[sessionId] = '';
    draftAttachments.remove(sessionId);
    draftSimplifySettings.remove(sessionId);
    _draftDelegationSelections.remove(sessionId);
    _draftRevisions[sessionId] = ++_nextDraftRevision;
    _draftAttachmentVersions[sessionId] =
        (_draftAttachmentVersions[sessionId] ?? 0) + 1;
    _hydratedDraftAttachmentIds.add(sessionId);
    _markDraftDirty(sessionId);
    return true;
  }

  void _restoreOutgoingCompositionAfterFailure(
      String sessionId, _OutgoingCompositionSnapshot outgoing) {
    if (!_outgoingStillBelongsToActiveHost(outgoing)) return;
    final currentText = drafts[sessionId] ?? '';
    final outgoingIsStillCurrent = outgoing.draftRevision != null &&
        _draftRevisions[sessionId] == outgoing.draftRevision &&
        _draftMatchesValues(sessionId, outgoing);
    final restoredText = outgoingIsStillCurrent || currentText.isEmpty
        ? outgoing.content
        : outgoing.content.isEmpty
            ? currentText
            : '${outgoing.content}\n$currentText';
    final currentAttachments =
        draftAttachments[sessionId] ?? const <RemoteAttachment>[];
    // A newer revision owns a distinct composition even when its values are
    // byte-for-byte identical. Restoration is intentionally lossless and may
    // exceed normal send bounds; validation will ask the user to trim it on
    // the next attempt instead of silently discarding either composition.
    final restoredAttachments = outgoingIsStillCurrent
        ? List<RemoteAttachment>.of(currentAttachments)
        : <RemoteAttachment>[...outgoing.attachments, ...currentAttachments];
    final currentDelegationSelections =
        _draftDelegationSelections[sessionId] ?? const <DelegationSelection>[];
    final restoredDelegationSelections =
        outgoingIsStillCurrent || currentText.isEmpty
            ? outgoing.delegationSelections
            : outgoing.content.isEmpty
                ? currentDelegationSelections
                : _normalizeDraftDelegationSelections(<DelegationSelection>[
                    ...outgoing.delegationSelections,
                    ...currentDelegationSelections,
                  ]);
    drafts[sessionId] = restoredText;
    if (restoredAttachments.isEmpty) {
      draftAttachments.remove(sessionId);
    } else {
      draftAttachments[sessionId] =
          List<RemoteAttachment>.unmodifiable(restoredAttachments);
    }
    if (restoredDelegationSelections.isEmpty) {
      _draftDelegationSelections.remove(sessionId);
    } else {
      _draftDelegationSelections[sessionId] =
          List<DelegationSelection>.unmodifiable(restoredDelegationSelections);
    }
    if (!draftSimplifySettings.containsKey(sessionId) &&
        outgoing.simplify != null) {
      draftSimplifySettings[sessionId] = outgoing.simplify!;
    }
    _draftRevisions[sessionId] = ++_nextDraftRevision;
    _draftAttachmentVersions[sessionId] =
        (_draftAttachmentVersions[sessionId] ?? 0) + 1;
    _markDraftDirty(sessionId);
  }

  Future<void> _moveDraftComposition(
    String fromSessionId,
    String toSessionId, {
    required _TransportOrigin origin,
  }) async {
    _requireTransportOrigin(origin,
        action: 'the prepared task draft was being moved');
    final hostId = origin.hostId;
    final sourceRevision = _draftRevisions[fromSessionId];
    final sourceJournalEntry = _draftJournalEntries[fromSessionId];
    final content = drafts.remove(fromSessionId);
    final attachments = draftAttachments.remove(fromSessionId);
    final simplify = draftSimplifySettings.remove(fromSessionId);
    final delegationSelections =
        _draftDelegationSelections.remove(fromSessionId);
    final retainedDictation = _retainedDictations.remove(fromSessionId);
    final pendingRetainedClearHost =
        _pendingRetainedDictationClears.remove(fromSessionId);
    final attachmentsWereHydrated =
        _hydratedDraftAttachmentIds.remove(fromSessionId);
    final retainedWasHydrated =
        _hydratedRetainedDictationIds.remove(fromSessionId);
    _draftRevisions.remove(fromSessionId);
    _draftAttachmentVersions.remove(fromSessionId);
    _retainedDictationVersions.remove(fromSessionId);
    _dirtyDraftHosts.remove(fromSessionId);
    if (content == null &&
        attachments == null &&
        simplify == null &&
        delegationSelections == null &&
        retainedDictation == null &&
        pendingRetainedClearHost == null &&
        sourceJournalEntry == null) {
      return;
    }
    if (content == null) {
      drafts.remove(toSessionId);
    } else {
      drafts[toSessionId] = content;
    }
    if (attachments == null || attachments.isEmpty) {
      draftAttachments.remove(toSessionId);
    } else {
      draftAttachments[toSessionId] =
          List<RemoteAttachment>.unmodifiable(attachments);
    }
    if (simplify == null) {
      draftSimplifySettings.remove(toSessionId);
    } else {
      draftSimplifySettings[toSessionId] = simplify;
    }
    if (delegationSelections == null || delegationSelections.isEmpty) {
      _draftDelegationSelections.remove(toSessionId);
    } else {
      _draftDelegationSelections[toSessionId] =
          List<DelegationSelection>.unmodifiable(delegationSelections);
    }
    if (retainedDictation == null) {
      _retainedDictations.remove(toSessionId);
    } else {
      _retainedDictations[toSessionId] = retainedDictation;
    }
    if (pendingRetainedClearHost == null) {
      _pendingRetainedDictationClears.remove(toSessionId);
    } else {
      _pendingRetainedDictationClears[toSessionId] = pendingRetainedClearHost;
    }
    if (attachmentsWereHydrated) {
      _hydratedDraftAttachmentIds.add(toSessionId);
    } else {
      _hydratedDraftAttachmentIds.remove(toSessionId);
    }
    if (retainedWasHydrated) {
      _hydratedRetainedDictationIds.add(toSessionId);
    } else {
      _hydratedRetainedDictationIds.remove(toSessionId);
    }
    if (sourceJournalEntry != null) {
      _draftJournalEntries[toSessionId] = sourceJournalEntry;
    }
    _draftRevisions[toSessionId] = ++_nextDraftRevision;
    _draftAttachmentVersions[toSessionId] =
        (_draftAttachmentVersions[toSessionId] ?? 0) + 1;
    _retainedDictationVersions[toSessionId] =
        (_retainedDictationVersions[toSessionId] ?? 0) + 1;
    _markDraftDirty(toSessionId);
    try {
      await flushDraftJournal();
    } on Object {
      // The provider task already exists. Keep the moved composition in
      // memory and let the bounded journal retry make it durable.
    }
    if (sourceRevision != null) {
      try {
        await _deleteDraftJournalEntry(
          hostId,
          fromSessionId,
          expectedRevision: sourceRevision,
        );
      } on Object {
        _queueDraftJournalDelete(hostId, fromSessionId, sourceRevision);
      }
    }
    if (!_transportOriginIsCurrent(origin)) return;
    _draftJournalEntries.remove(fromSessionId);
  }

  bool _sameAttachments(
      List<RemoteAttachment> left, List<RemoteAttachment> right) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (!_sameAttachment(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }

  bool _sameAttachment(RemoteAttachment left, RemoteAttachment right) =>
      left.name == right.name &&
      left.mimeType == right.mimeType &&
      left.dataBase64 == right.dataBase64 &&
      left.byteLength == right.byteLength &&
      left.origin == right.origin;

  bool _sameSimplifySettings(SimplifySettings? left, SimplifySettings? right) {
    if (left == null || right == null) return left == null && right == null;
    return left.maxWords == right.maxWords && left.guidance == right.guidance;
  }

  List<DelegationSelection> _normalizeDraftDelegationSelections(
    Iterable<DelegationSelection> selections,
  ) {
    final normalized = <DelegationSelection>[];
    final providers = <String>{};
    for (final selection in selections) {
      final providerId = selection.providerId.trim();
      if (providerId.isEmpty ||
          providerId.length > 256 ||
          !providers.add(providerId.toLowerCase())) {
        continue;
      }
      final modelId = selection.modelId?.trim();
      final reasoningEffort = selection.reasoningEffort?.trim();
      normalized.add(DelegationSelection(
        providerId: providerId,
        modelId: modelId == null || modelId.isEmpty ? null : modelId,
        reasoningEffort: reasoningEffort == null || reasoningEffort.isEmpty
            ? null
            : reasoningEffort,
      ));
      if (normalized.length == 4) break;
    }
    return List<DelegationSelection>.unmodifiable(normalized);
  }

  bool _sameDelegationSelections(
    List<DelegationSelection> left,
    List<DelegationSelection> right,
  ) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      final leftItem = left[index];
      final rightItem = right[index];
      if (leftItem.providerId != rightItem.providerId ||
          leftItem.modelId != rightItem.modelId ||
          leftItem.reasoningEffort != rightItem.reasoningEffort) {
        return false;
      }
    }
    return true;
  }

  Future<void> sendMessage(
    String sessionId,
    String content, {
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    await hydrateDraftComposition(sessionId);
    _requireTransportOrigin(origin, action: 'the message was being prepared');
    if (_acknowledgedPreparedSessionIds.contains(sessionId)) {
      _scheduleAcknowledgementReconciliation(origin);
      throw StateError('This task was already created and is being refreshed.');
    }
    final hydratedAttachments =
        attachments.isEmpty ? draftAttachmentsFor(sessionId) : attachments;
    final trimmed = content.trim();
    if (trimmed.isEmpty && hydratedAttachments.isEmpty) {
      return;
    }
    _validateMessageAttachments(hydratedAttachments);
    final outgoing = _captureOutgoingComposition(
      sessionId,
      content,
      hydratedAttachments,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      simplify: simplify,
    );
    await flushDraftJournal();
    _requireTransportOrigin(origin, action: 'the message was being sent');
    final requestId = randomId('send');
    final createdAt = DateTime.now();
    _optimisticMessageIdsBySession
        .putIfAbsent(sessionId, () => <String>{})
        .add(requestId);
    _inFlightOptimisticMessageIds.add(requestId);
    RemoteMessage optimisticMessageFor(
      String visibleContent,
      List<RemoteAttachment> visibleAttachments,
    ) =>
        RemoteMessage(
          id: requestId,
          sessionId: sessionId,
          role: 'user',
          createdAt: createdAt,
          parts: <ContentPart>[
            ContentPart(
              type: 'text',
              data: <String, Object?>{'text': visibleContent},
            ),
            ...visibleAttachments.map((attachment) => ContentPart(
                  type: attachment.mimeType.startsWith('audio/')
                      ? 'audio'
                      : attachment.mimeType.startsWith('image/')
                          ? 'image'
                          : 'file',
                  data: <String, Object?>{
                    'uri': attachment.dataUri,
                    'mimeType': attachment.mimeType,
                    'name': attachment.name,
                  },
                )),
          ],
          status: 'completed',
        );
    final sessionMessages =
        messages.putIfAbsent(sessionId, () => <RemoteMessage>[]);
    sessionMessages.add(optimisticMessageFor(
      simplifyVisibleContent(trimmed),
      outgoing.attachments,
    ));
    notifyListeners();
    late final ({String content, List<RemoteAttachment> attachments}) prepared;
    try {
      prepared = await _prepareOutgoing(
        sessionId,
        trimmed,
        outgoing.attachments,
        modelId: outgoing.modelId,
        origin: origin,
      );
    } catch (_) {
      _discardOptimisticMessage(sessionId, requestId);
      _restoreOutgoingCompositionAfterFailure(sessionId, outgoing);
      notifyListeners();
      rethrow;
    }
    _requireTransportOrigin(origin, action: 'the message was being prepared');
    final visibleContent = simplifyVisibleContent(prepared.content);
    final currentSessionMessages = messages[sessionId];
    final optimisticIndex = currentSessionMessages
            ?.indexWhere((message) => message.id == requestId) ??
        -1;
    if (optimisticIndex >= 0) {
      currentSessionMessages![optimisticIndex] =
          optimisticMessageFor(visibleContent, prepared.attachments);
    }
    notifyListeners();
    final attachmentIds = <String>[];
    var acknowledged = false;
    try {
      if (prepared.attachments.isNotEmpty) {
        attachmentIds.addAll(await _uploadAttachments(
          prepared.attachments,
          origin: origin,
        ));
      }
      _requireTransportOrigin(origin, action: 'the message was being sent');
      await origin.transport.request(
        'session.send_message',
        <String, Object?>{
          'sessionId': sessionId,
          'content': prepared.content,
          if (outgoing.modelId != null && outgoing.modelId!.isNotEmpty)
            'modelId': outgoing.modelId,
          if (outgoing.reasoningEffort != null &&
              outgoing.reasoningEffort!.isNotEmpty)
            'reasoningEffort': outgoing.reasoningEffort,
          if (attachmentIds.isNotEmpty)
            'attachmentIds': attachmentIds
          else if (prepared.attachments.isNotEmpty)
            'attachments': prepared.attachments
                .map((attachment) => attachment.toJson())
                .toList(growable: false),
          if (outgoing.simplify != null)
            'simplify': outgoing.simplify!.toJson(),
        },
        requestId: requestId,
      );
      acknowledged = true;
      _requireTransportOrigin(origin, action: 'the message was being sent');
      final acceptedSession =
          sessions.where((session) => session.id == sessionId).firstOrNull;
      if (acceptedSession != null) {
        _recordRecentModelUse(
          acceptedSession.providerId,
          outgoing.modelId ?? acceptedSession.modelId,
          _acceptedModelUseAt(acceptedSession),
          acceptedSelection: outgoing.modelId?.trim().isNotEmpty == true,
        );
      }
      if (_clearDraftIfUnchanged(sessionId, outgoing)) {
        await _deleteAcknowledgedDraft(sessionId, outgoing);
      }
      _inFlightOptimisticMessageIds.remove(requestId);
      notifyListeners();
    } catch (error) {
      if (acknowledged) {
        if (_transportOriginIsCurrent(origin)) {
          _clearDraftIfUnchanged(sessionId, outgoing);
        }
        await _deleteAcknowledgedDraft(sessionId, outgoing);
        _discardOptimisticMessage(sessionId, requestId);
        _notifyListenersAfterAcknowledgement();
        return;
      }
      if (error is BridgeRequestException &&
          error.code == 'DELIVERY_UNKNOWN' &&
          !error.retryable) {
        // The host may have handed this exact submission to the provider.
        // Keep the optimistic transcript row and consumed uploads, but clear
        // the composer so the phone cannot expose a blind duplicate retry.
        if (_transportOriginIsCurrent(origin)) {
          _clearDraftIfUnchanged(sessionId, outgoing);
        }
        await _deleteAcknowledgedDraft(sessionId, outgoing);
        _inFlightOptimisticMessageIds.remove(requestId);
        notifyListeners();
        rethrow;
      }
      for (final attachmentId in attachmentIds) {
        unawaited(origin.transport.request(
          'attachment.upload.cancel',
          <String, Object?>{'uploadId': attachmentId},
        ).catchError((Object _) => <String, Object?>{}));
      }
      _discardOptimisticMessage(sessionId, requestId);
      _restoreOutgoingCompositionAfterFailure(sessionId, outgoing);
      notifyListeners();
      rethrow;
    }
  }

  void _discardOptimisticMessage(String sessionId, String messageId) {
    _inFlightOptimisticMessageIds.remove(messageId);
    final optimisticMessageIds = _optimisticMessageIdsBySession[sessionId];
    optimisticMessageIds?.remove(messageId);
    if (optimisticMessageIds?.isEmpty == true) {
      _optimisticMessageIdsBySession.remove(sessionId);
    }
    messages[sessionId]?.removeWhere((message) => message.id == messageId);
  }

  Future<String?> submitMessage(
    String sessionId,
    String content, {
    String deliveryMode = 'queue',
    String? modelId,
    String? reasoningEffort,
    List<RemoteAttachment> attachments = const <RemoteAttachment>[],
    SimplifySettings? simplify,
  }) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    await hydrateDraftComposition(sessionId);
    _requireTransportOrigin(origin, action: 'the message was being prepared');
    if (_acknowledgedPreparedSessionIds.contains(sessionId)) {
      _scheduleAcknowledgementReconciliation(origin);
      throw StateError('This task was already created and is being refreshed.');
    }
    final hydratedAttachments =
        attachments.isEmpty ? draftAttachmentsFor(sessionId) : attachments;
    final trimmed = content.trim();
    if (trimmed.isEmpty && hydratedAttachments.isEmpty) {
      return null;
    }
    _validateMessageAttachments(hydratedAttachments);
    final outgoing = _captureOutgoingComposition(
      sessionId,
      content,
      hydratedAttachments,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      simplify: simplify,
    );
    await flushDraftJournal();
    _requireTransportOrigin(origin, action: 'the message was being submitted');
    final session = sessions
        .where((item) => item.id == sessionId && item.hostId == origin.hostId)
        .firstOrNull;
    if (session == null) throw StateError('Session is no longer available');
    if (!_isMobileProviderEnabled(session.providerId)) {
      throw StateError('That harness is not available');
    }
    if (_preparedSessionIds.contains(sessionId)) {
      late final RemoteSession created;
      try {
        created = await _createSession(
          providerId: session.providerId,
          workingDirectory: session.workingDirectory?.trim() ?? '',
          firstInstruction: '',
          modelId: outgoing.modelId,
          reasoningEffort: outgoing.reasoningEffort,
          origin: origin,
        );
      } on _AcknowledgedSessionCreateFailure catch (acknowledged) {
        if (_transportOriginIsCurrent(origin)) {
          _acknowledgedPreparedSessionIds.add(sessionId);
        }
        await _consumeAcknowledgedComposition(sessionId, outgoing, origin);
        _scheduleAcknowledgementReconciliation(origin);
        if (_transportOriginIsCurrent(origin)) {
          error = acknowledged.toString();
          _notifyListenersAfterAcknowledgement();
          return acknowledged.session?.id;
        }
        return null;
      } catch (_) {
        _restoreOutgoingCompositionAfterFailure(sessionId, outgoing);
        notifyListeners();
        rethrow;
      }
      _preparedSessionIds.remove(sessionId);
      sessions.removeWhere((item) => item.id == sessionId);
      messages.remove(sessionId);
      contextBySession.remove(sessionId);
      await _moveDraftComposition(sessionId, created.id, origin: origin);
      _requireTransportOrigin(origin,
          action: 'the prepared task was being created');
      try {
        await submitMessage(
          created.id,
          outgoing.content,
          deliveryMode: deliveryMode,
          modelId: outgoing.modelId,
          reasoningEffort: outgoing.reasoningEffort,
          attachments: outgoing.attachments,
          simplify: outgoing.simplify,
        );
      } on Object {
        if (!_transportOriginIsCurrent(origin)) rethrow;
        // The provider task now exists even though its first delivery did not.
        // Returning its ID lets the route move to that real task, where the
        // complete composition remains available for an explicit retry.
        error = 'Message wasn\'t sent. Your draft is ready to retry.';
      }
      notifyListeners();
      return created.id;
    }
    if (deliveryMode == 'send') {
      await sendMessage(
        sessionId,
        trimmed,
        modelId: outgoing.modelId,
        reasoningEffort: outgoing.reasoningEffort,
        attachments: outgoing.attachments,
        simplify: outgoing.simplify,
      );
      return null;
    }
    final mode = deliveryMode == 'steer' &&
            session.state == 'working' &&
            providerSupportsSteering(session.providerId)
        ? 'steer'
        : 'queue';
    notifyListeners();
    late final ({String content, List<RemoteAttachment> attachments}) prepared;
    final attachmentIds = <String>[];
    var acknowledged = false;
    var reconcileAcknowledgedQueue = false;
    try {
      prepared = await _prepareOutgoing(
        sessionId,
        trimmed,
        outgoing.attachments,
        modelId: outgoing.modelId,
        origin: origin,
      );
      if (prepared.attachments.isNotEmpty) {
        attachmentIds.addAll(await _uploadAttachments(
          prepared.attachments,
          origin: origin,
        ));
      }
      _requireTransportOrigin(origin,
          action: 'the message was being submitted');
      final result = await origin.transport.request(
        mode == 'steer' ? 'session.steer_message' : 'message_queue.enqueue',
        <String, Object?>{
          'sessionId': sessionId,
          'content': prepared.content,
          if (outgoing.modelId != null && outgoing.modelId!.isNotEmpty)
            'modelId': outgoing.modelId,
          if (outgoing.reasoningEffort != null &&
              outgoing.reasoningEffort!.isNotEmpty)
            'reasoningEffort': outgoing.reasoningEffort,
          if (attachmentIds.isNotEmpty) 'attachmentIds': attachmentIds,
          if (outgoing.simplify != null)
            'simplify': outgoing.simplify!.toJson(),
        },
        requestId: randomId(mode),
      );
      acknowledged = true;
      _requireTransportOrigin(origin,
          action: 'the message was being submitted');
      if (mode == 'steer') {
        _recordRecentModelUse(
          session.providerId,
          outgoing.modelId ?? session.modelId,
          _acceptedModelUseAt(session),
          acceptedSelection: outgoing.modelId?.trim().isNotEmpty == true,
        );
      }
      if (mode == 'queue') {
        if (result['message'] == null) {
          reconcileAcknowledgedQueue = true;
        } else {
          final queued = _retainQueuedAttachmentPreviews(
            RemoteQueuedMessage.fromJson(result['message']),
            prepared.attachments.map((attachment) => RemoteQueuedAttachment(
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  byteLength: attachment.byteLength,
                  dataBase64: attachment.dataBase64,
                )),
          );
          queuedMessages[queued.id] = queued;
          _queuedRevision += 1;
        }
      }
      if (_clearDraftIfUnchanged(sessionId, outgoing)) {
        await _deleteAcknowledgedDraft(sessionId, outgoing);
      }
      if (reconcileAcknowledgedQueue) {
        await _reconcileAcknowledgedQueue(origin);
      }
      notifyListeners();
      return null;
    } catch (_) {
      if (acknowledged) {
        if (_transportOriginIsCurrent(origin)) {
          _clearDraftIfUnchanged(sessionId, outgoing);
        }
        await _deleteAcknowledgedDraft(sessionId, outgoing);
        if (mode == 'queue') {
          await _reconcileAcknowledgedQueue(origin);
        }
        _notifyListenersAfterAcknowledgement();
        return null;
      }
      for (final attachmentId in attachmentIds) {
        unawaited(origin.transport.request(
            'attachment.upload.cancel', <String, Object?>{
          'uploadId': attachmentId
        }).catchError((Object _) => <String, Object?>{}));
      }
      _restoreOutgoingCompositionAfterFailure(sessionId, outgoing);
      notifyListeners();
      rethrow;
    }
  }

  Future<RemoteDelegationTask?> startDelegation(
    String parentSessionId,
    String prompt,
    List<DelegationSelection> targets, {
    String? modelId,
    String? reasoningEffort,
  }) async {
    final origin = _captureTransportOrigin(sessionId: parentSessionId);
    await hydrateDraftComposition(parentSessionId);
    _requireTransportOrigin(origin,
        action: 'the delegated task was being prepared');
    final targetSnapshot = _normalizeDraftDelegationSelections(targets);
    final presentationSegments =
        _meshPresentationSegments(prompt, targetSnapshot.length);
    final submittedPrompt = _meshPlainText(presentationSegments);
    if (targetSnapshot.isEmpty) {
      throw StateError('Choose a harness for /mesh');
    }
    if (targetSnapshot
        .any((target) => !_isMobileProviderEnabled(target.providerId))) {
      throw StateError('One of the selected harnesses is not available');
    }
    if (draftAttachmentsFor(parentSessionId).isNotEmpty) {
      throw StateError(
          '/mesh attachments are not available yet. Send the attachment in a child session after it opens.');
    }
    // Keep submitted targets in the same durable revision as the text until
    // the bridge acknowledges this exact composition.
    setDraftDelegationSelections(parentSessionId, targetSnapshot);
    final outgoing = _captureOutgoingComposition(
      parentSessionId,
      prompt,
      const <RemoteAttachment>[],
      modelId: modelId,
      reasoningEffort: reasoningEffort,
    );
    final requestId = randomId('mesh');
    final optimisticCreatedAt = DateTime.now();
    final optimisticTask = RemoteDelegationTask(
      id: requestId,
      parentSessionId: parentSessionId,
      prompt: submittedPrompt,
      state: 'awaiting_dispatch',
      createdAt: optimisticCreatedAt,
      updatedAt: optimisticCreatedAt,
      children: const <RemoteDelegationChild>[],
      targets: targetSnapshot,
      presentationSegments: presentationSegments,
      orchestration: 'parent',
    );
    delegations[requestId] = optimisticTask;
    _locallyPreparedDelegationIds.add(requestId);
    notifyListeners();
    try {
      await flushDraftJournal();
      _requireTransportOrigin(origin,
          action: 'the delegated task was being started');
    } on Object {
      if (identical(delegations[requestId], optimisticTask)) {
        delegations.remove(requestId);
      }
      _locallyPreparedDelegationIds.remove(requestId);
      _restoreOutgoingCompositionAfterFailure(parentSessionId, outgoing);
      notifyListeners();
      rethrow;
    }
    late final Map<String, Object?> result;
    try {
      result = await origin.transport.request(
        'delegation.prepare',
        <String, Object?>{
          'parentSessionId': parentSessionId,
          'prompt': submittedPrompt,
          'targets': targetSnapshot
              .map((target) => target.toJson())
              .toList(growable: false),
          'presentationSegments': presentationSegments
              .map((segment) => segment.toJson())
              .toList(growable: false),
          if (modelId?.trim().isNotEmpty == true) 'modelId': modelId!.trim(),
          if (reasoningEffort?.trim().isNotEmpty == true)
            'reasoningEffort': reasoningEffort!.trim(),
        },
        requestId: requestId,
        timeout: const Duration(minutes: 5),
      );
    } on BridgeRequestException catch (caught) {
      if (caught.code == 'DELIVERY_UNKNOWN' && !caught.retryable) {
        await _consumeAcknowledgedComposition(
            parentSessionId, outgoing, origin);
        _scheduleAcknowledgementReconciliation(
          origin,
          includeDelegations: true,
        );
        _notifyListenersAfterAcknowledgement();
        return optimisticTask;
      }
      if (identical(delegations[requestId], optimisticTask)) {
        delegations.remove(requestId);
      }
      _locallyPreparedDelegationIds.remove(requestId);
      _restoreOutgoingCompositionAfterFailure(parentSessionId, outgoing);
      notifyListeners();
      rethrow;
    } catch (_) {
      if (identical(delegations[requestId], optimisticTask)) {
        delegations.remove(requestId);
      }
      _locallyPreparedDelegationIds.remove(requestId);
      _restoreOutgoingCompositionAfterFailure(parentSessionId, outgoing);
      notifyListeners();
      rethrow;
    }
    try {
      final task = _remoteDelegationTaskFromJson(result['delegation']);
      final originIsCurrent = _transportOriginIsCurrent(origin);
      if (originIsCurrent) {
        if (task.id != requestId &&
            identical(delegations[requestId], optimisticTask)) {
          delegations.remove(requestId);
          _locallyPreparedDelegationIds.remove(requestId);
          _locallyPreparedDelegationIds.add(task.id);
        }
        delegations[task.id] = task;
      }
      if (originIsCurrent &&
          _clearDraftIfUnchanged(parentSessionId, outgoing)) {
        await _deleteAcknowledgedDraft(parentSessionId, outgoing);
      } else if (!originIsCurrent) {
        await _deleteAcknowledgedDraft(parentSessionId, outgoing);
      }
      if (originIsCurrent) {
        for (final target in targetSnapshot) {
          delegationPreferences[target.providerId] = target;
          try {
            await security.saveDelegationPreference(target);
          } on Object {
            // The remote delegation is already accepted. A local preference
            // write can be retried by the next explicit selection.
          }
          if (!_transportOriginIsCurrent(origin)) break;
        }
      }
      notifyListeners();
      if (_transportOriginIsCurrent(origin) &&
          task.children.any(_delegationChildHasSession)) {
        unawaited(loadChildSessions(parentSessionId));
      }
      return task;
    } on Object {
      await _consumeAcknowledgedComposition(parentSessionId, outgoing, origin);
      _scheduleAcknowledgementReconciliation(
        origin,
        includeDelegations: true,
      );
      _notifyListenersAfterAcknowledgement();
      return null;
    }
  }

  Future<void> _consumeAcknowledgedComposition(
    String sessionId,
    _OutgoingCompositionSnapshot outgoing,
    _TransportOrigin origin,
  ) async {
    if (_transportOriginIsCurrent(origin)) {
      if (_clearDraftIfUnchanged(sessionId, outgoing)) {
        await _deleteAcknowledgedDraft(sessionId, outgoing);
      }
      return;
    }
    await _deleteAcknowledgedDraft(sessionId, outgoing);
  }

  void _notifyListenersAfterAcknowledgement() {
    try {
      notifyListeners();
    } on Object {
      // The bridge has already accepted the operation. A local observer must
      // never turn that success into a retryable submission.
    }
  }

  Future<void> _reconcileAcknowledgedQueue(_TransportOrigin origin) async {
    if (!_transportOriginIsCurrent(origin)) return;
    try {
      await _loadQueuedMessages(origin.transport);
    } on Object {
      // The enqueue is already accepted. Reconnect recovery will retry this
      // projection without ever restoring or resubmitting the composition.
    }
  }

  String _bridgeMutationKey(
    _TransportOrigin origin,
    String action,
    Iterable<String?> values,
  ) =>
      <String>[origin.hostId, action, ...values.map((value) => value ?? '')]
          .join('\u0000');

  void _beginBridgeMutation(String key) {
    if (_consumedBridgeMutationKeys.contains(key) ||
        !_activeBridgeMutationKeys.add(key)) {
      throw StateError('This change was already sent and is being refreshed.');
    }
  }

  void _finishBridgeMutation(String key) {
    _activeBridgeMutationKeys.remove(key);
    _consumedBridgeMutationKeys.remove(key);
  }

  void _consumeBridgeMutation(String key) {
    _activeBridgeMutationKeys.remove(key);
    _consumedBridgeMutationKeys.add(key);
  }

  Future<void> _reconcileAcknowledgedMutation(
    _TransportOrigin origin, {
    bool includeQueue = false,
    bool includeDelegations = false,
    String? sideChatParentId,
  }) async {
    if (!_transportOriginIsCurrent(origin)) return;
    await _refreshWithTransport(origin.transport, showProgress: false);
    if (includeQueue && _transportOriginIsCurrent(origin)) {
      try {
        await _loadQueuedMessages(origin.transport);
      } on Object {
        // The mutation is already accepted. A later reconnect will refresh it.
      }
    }
    if (sideChatParentId != null && _transportOriginIsCurrent(origin)) {
      await _loadSideChats(
        expectedTransport: origin.transport,
        parentSessionId: sideChatParentId.isEmpty ? null : sideChatParentId,
      );
    }
    if (includeDelegations && _transportOriginIsCurrent(origin)) {
      await _loadDelegations(origin.transport);
    }
  }

  void _scheduleAcknowledgementReconciliation(
    _TransportOrigin origin, {
    bool includeDelegations = false,
    bool includeQueue = false,
    String? sideChatParentId,
  }) {
    unawaited(Future<void>(() async {
      await _reconcileAcknowledgedMutation(
        origin,
        includeDelegations: includeDelegations,
        includeQueue: includeQueue,
        sideChatParentId: sideChatParentId,
      );
    }).catchError((Object _) {}));
  }

  Future<void> cancelQueuedMessage(String messageId) async {
    final message = queuedMessages[messageId];
    if (message == null) return;
    final origin = _captureTransportOrigin(sessionId: message.sessionId);
    final result = await origin.transport.request(
        'message_queue.cancel', <String, Object?>{'messageId': messageId});
    _requireTransportOrigin(origin,
        action: 'the queued message was being cancelled');
    if (result['cancelled'] == true) {
      queuedMessages.remove(messageId);
      _queuedRevision += 1;
      notifyListeners();
    }
  }

  Future<RemoteQueuedMessage> editQueuedMessage(
      RemoteQueuedMessage message, String content) async {
    if (!queuedMessages.containsKey(message.id)) {
      throw StateError('That queued message is no longer available');
    }
    final origin = _captureTransportOrigin(sessionId: message.sessionId);
    final trimmed = content.trim();
    if (trimmed.isEmpty) throw StateError('Enter a message');
    final result = await origin.transport.request(
      'message_queue.edit',
      <String, Object?>{'messageId': message.id, 'content': trimmed},
      requestId: randomId('queue-edit'),
    );
    _requireTransportOrigin(origin,
        action: 'the queued message was being edited');
    final parsed = result['message'] == null
        ? RemoteQueuedMessage(
            id: message.id,
            sessionId: message.sessionId,
            content: trimmed,
            state: message.state,
            createdAt: message.createdAt,
            attachments: message.attachments,
            modelId: message.modelId,
            reasoningEffort: message.reasoningEffort,
            error: message.error,
            retryable: message.retryable,
          )
        : RemoteQueuedMessage.fromJson(result['message']);
    final updated =
        _retainQueuedAttachmentPreviews(parsed, message.attachments);
    queuedMessages[updated.id] = updated;
    _queuedRevision += 1;
    notifyListeners();
    return updated;
  }

  Future<void> deliverQueuedMessage(RemoteQueuedMessage message,
      {required String mode}) async {
    if (!queuedMessages.containsKey(message.id)) return;
    final origin = _captureTransportOrigin(sessionId: message.sessionId);
    final deliveryMode = mode == 'steer' ? 'steer' : 'send';
    final result = await origin.transport.request(
      'message_queue.deliver',
      <String, Object?>{'messageId': message.id, 'mode': deliveryMode},
      requestId: randomId('queue-deliver'),
    );
    _requireTransportOrigin(origin,
        action: 'the queued message was being delivered');
    if (result['delivered'] != false) {
      queuedMessages.remove(message.id);
      _queuedRevision += 1;
      final session =
          sessions.where((item) => item.id == message.sessionId).firstOrNull;
      if (session != null) {
        _recordRecentModelUse(
          session.providerId,
          message.modelId ?? session.modelId,
          _acceptedModelUseAt(session),
          acceptedSelection: message.modelId?.trim().isNotEmpty == true,
        );
      }
      notifyListeners();
    }
  }

  Future<RemoteSession> moveQueuedMessageToNewTask(
    RemoteQueuedMessage message, {
    required String providerId,
    required String modelId,
    String? reasoningEffort,
  }) async {
    if (!queuedMessages.containsKey(message.id)) {
      throw StateError('That queued message is no longer available');
    }
    final origin = _captureTransportOrigin(sessionId: message.sessionId);
    final trimmedProviderId = providerId.trim();
    final trimmedModelId = modelId.trim();
    final trimmedEffort = reasoningEffort?.trim();
    if (trimmedProviderId.isEmpty || trimmedModelId.isEmpty) {
      throw StateError('Choose an Agent and model');
    }
    final mutationKey = _bridgeMutationKey(
      origin,
      'message_queue.move_to_new_task',
      <String?>[message.id],
    );
    _beginBridgeMutation(mutationKey);
    final sessionIdsBefore = sessions.map((session) => session.id).toSet();
    late final Map<String, Object?> result;
    try {
      result = await origin.transport.request(
        'message_queue.move_to_new_task',
        <String, Object?>{
          'messageId': message.id,
          'providerId': trimmedProviderId,
          'modelId': trimmedModelId,
          if (trimmedEffort?.isNotEmpty == true)
            'reasoningEffort': trimmedEffort,
        },
        requestId: randomId('queue-new-task'),
      );
    } on Object {
      _finishBridgeMutation(mutationKey);
      rethrow;
    }
    try {
      _requireTransportOrigin(origin,
          action: 'the queued message was being moved');
    } on Object {
      _finishBridgeMutation(mutationKey);
      rethrow;
    }

    RemoteSession? created;
    try {
      final parsed = RemoteSession.fromJson(result['session']);
      if (parsed.hostId != origin.hostId) {
        throw const FormatException('Created task belongs to another host');
      }
      created = parsed;
    } on Object {
      if (_transportOriginIsCurrent(origin)) {
        queuedMessages.remove(message.id);
        _queuedRevision += 1;
        _notifyListenersAfterAcknowledgement();
        await _reconcileAcknowledgedMutation(origin, includeQueue: true);
        created = sessions
            .where((session) =>
                !sessionIdsBefore.contains(session.id) &&
                session.hostId == origin.hostId &&
                session.providerId == trimmedProviderId &&
                session.sessionKind != 'side_chat')
            .firstOrNull;
      }
    }
    if (created == null) {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(origin, includeQueue: true);
      throw const _AcknowledgedMutationFailure(
        'The queued message was moved and the new task is being refreshed.',
      );
    }

    try {
      _upsertSession(created);
      queuedMessages.remove(message.id);
      _queuedRevision += 1;
      _recordRecentModelUse(
        created.providerId,
        created.modelId ?? trimmedModelId,
        created.lastActivityAt,
        acceptedSelection: true,
      );
      selectedSession = sessions.where((item) => item.id == created!.id).first;
      _notifyListenersAfterAcknowledgement();
      _finishBridgeMutation(mutationKey);
      return selectedSession!;
    } on Object {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(origin, includeQueue: true);
      throw const _AcknowledgedMutationFailure(
        'The queued message was moved and the new task is being refreshed.',
      );
    }
  }

  void setShowSideChats(bool value) {
    if (showSideChats == value) return;
    showSideChats = value;
    notifyListeners();
  }

  Future<List<RemoteSession>> loadSideChats({String? parentSessionId}) async {
    await _loadSideChats(parentSessionId: parentSessionId);
    return parentSessionId == null
        ? sessions
            .where((session) => session.sessionKind == 'side_chat')
            .toList(growable: false)
        : sideChatsFor(parentSessionId);
  }

  Future<RemoteSession> createSideChat(
    String parentSessionId, {
    String? prompt,
    String? queuedMessageId,
  }) async {
    final origin = _captureTransportOrigin(sessionId: parentSessionId);
    final trimmedPrompt = prompt?.trim();
    final mutationKey = _bridgeMutationKey(
      origin,
      'side_chat.create',
      <String?>[parentSessionId, trimmedPrompt, queuedMessageId],
    );
    _beginBridgeMutation(mutationKey);
    final sideChatIdsBefore =
        sideChatsFor(parentSessionId).map((session) => session.id).toSet();
    late final Map<String, Object?> result;
    try {
      result = await origin.transport.request(
        'side_chat.create',
        <String, Object?>{
          'parentSessionId': parentSessionId,
          if (trimmedPrompt?.isNotEmpty == true) 'prompt': trimmedPrompt,
          if (queuedMessageId?.isNotEmpty == true)
            'queuedMessageId': queuedMessageId,
        },
        requestId: randomId('side-chat'),
      );
    } on Object {
      _finishBridgeMutation(mutationKey);
      rethrow;
    }
    try {
      _requireTransportOrigin(origin,
          action: 'the side chat was being created');
    } on Object {
      _consumeBridgeMutation(mutationKey);
      rethrow;
    }

    RemoteSession? created;
    try {
      final parsed = RemoteSession.fromJson(result['session']);
      if (parsed.hostId != origin.hostId) {
        throw const FormatException(
            'Created side chat belongs to another host');
      }
      created = parsed.copyWith(
        parentSessionId: parsed.parentSessionId ?? parentSessionId,
        sessionKind: 'side_chat',
      );
    } on Object {
      if (_transportOriginIsCurrent(origin)) {
        if (queuedMessageId != null) {
          queuedMessages.remove(queuedMessageId);
          _queuedRevision += 1;
        }
        _notifyListenersAfterAcknowledgement();
        await _reconcileAcknowledgedMutation(
          origin,
          includeQueue: queuedMessageId != null,
          sideChatParentId: parentSessionId,
        );
        created = sideChatsFor(parentSessionId)
            .where((session) => !sideChatIdsBefore.contains(session.id))
            .firstOrNull;
      }
    }
    if (created == null) {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(
        origin,
        includeQueue: queuedMessageId != null,
        sideChatParentId: parentSessionId,
      );
      throw const _AcknowledgedMutationFailure(
        'The side chat was created and is being refreshed.',
      );
    }

    try {
      _upsertSession(created);
      _sideChatRevision += 1;
      if (queuedMessageId != null) {
        queuedMessages.remove(queuedMessageId);
        _queuedRevision += 1;
      }
      _notifyListenersAfterAcknowledgement();
      _finishBridgeMutation(mutationKey);
      return sessions.where((session) => session.id == created!.id).first;
    } on Object {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(
        origin,
        includeQueue: queuedMessageId != null,
        sideChatParentId: parentSessionId,
      );
      throw const _AcknowledgedMutationFailure(
        'The side chat was created and is being refreshed.',
      );
    }
  }

  Future<RemoteSession> promoteSideChat(String sessionId) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    final existing =
        sessions.where((session) => session.id == sessionId).firstOrNull;
    final sideChatParentId = existing?.parentSessionId ??
        existing?.relationship?.sourceSessionId ??
        '';
    final mutationKey = _bridgeMutationKey(
      origin,
      'side_chat.promote',
      <String?>[sessionId],
    );
    _beginBridgeMutation(mutationKey);
    late final Map<String, Object?> result;
    try {
      result = await origin.transport.request(
        'side_chat.promote',
        <String, Object?>{'sessionId': sessionId},
        requestId: randomId('side-chat-promote'),
      );
    } on Object {
      _finishBridgeMutation(mutationKey);
      rethrow;
    }
    try {
      _requireTransportOrigin(origin,
          action: 'the side chat was being promoted');
    } on Object {
      _consumeBridgeMutation(mutationKey);
      rethrow;
    }

    RemoteSession? promoted;
    try {
      final parsed = RemoteSession.fromJson(result['session'])
          .copyWith(sessionKind: 'task');
      if (parsed.hostId != origin.hostId) {
        throw const FormatException('Promoted task belongs to another host');
      }
      promoted = parsed;
    } on Object {
      if (_transportOriginIsCurrent(origin)) {
        await _reconcileAcknowledgedMutation(
          origin,
          sideChatParentId: sideChatParentId,
        );
        promoted = sessions
            .where((session) =>
                session.id == sessionId && session.sessionKind != 'side_chat')
            .firstOrNull;
      }
    }
    if (promoted == null) {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(
        origin,
        sideChatParentId: sideChatParentId,
      );
      throw const _AcknowledgedMutationFailure(
        'The side chat was promoted and the task is being refreshed.',
      );
    }

    try {
      sessions.removeWhere((session) => session.id == promoted!.id);
      _upsertSession(promoted);
      _sideChatRevision += 1;
      selectedSession =
          sessions.where((session) => session.id == promoted!.id).firstOrNull;
      _notifyListenersAfterAcknowledgement();
      _finishBridgeMutation(mutationKey);
      return selectedSession ?? promoted;
    } on Object {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(
        origin,
        sideChatParentId: sideChatParentId,
      );
      throw const _AcknowledgedMutationFailure(
        'The side chat was promoted and the task is being refreshed.',
      );
    }
  }

  Future<void> editMessage(
    String sessionId,
    RemoteMessage message,
    String content, {
    String? modelId,
    String? reasoningEffort,
  }) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    final providerMessageId = message.providerMessageId;
    final trimmed = content.trim();
    if (!message.editable || providerMessageId == null || trimmed.isEmpty) {
      throw StateError('That message is not editable');
    }
    await origin.transport.request(
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
    _requireTransportOrigin(origin, action: 'the message was being edited');
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
          presentationId: message.presentationId,
        ),
      ];
    }
    _clearLiveAssistant(sessionId);
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
    List<RemoteAttachment> attachments, {
    required _TransportOrigin origin,
    void Function()? checkCancelled,
  }) async {
    _validateMessageAttachments(attachments);
    final transport = origin.transport;
    final result = <String>[];
    final startedIds = <String>[];
    void checkActive() {
      checkCancelled?.call();
      _requireTransportOrigin(origin,
          action: 'attachments were being uploaded');
    }

    try {
      for (final attachment in attachments) {
        checkActive();
        late final Uint8List bytes;
        try {
          bytes = base64Decode(attachment.dataBase64);
        } on FormatException {
          throw StateError('${attachment.name} could not be read.');
        }
        if (bytes.length != attachment.byteLength) {
          throw StateError('${attachment.name} changed while it was selected.');
        }
        checkActive();
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
        checkActive();
        final advertisedChunkBytes = started['chunkBytes'];
        final chunkBytes = advertisedChunkBytes is num
            ? advertisedChunkBytes.toInt().clamp(32 * 1024, 192 * 1024).toInt()
            : 192 * 1024;
        var offset = 0;
        while (offset < bytes.length) {
          checkActive();
          final end = (offset + chunkBytes).clamp(0, bytes.length).toInt();
          await transport.request(
            'attachment.upload.chunk',
            <String, Object?>{
              'uploadId': uploadId,
              'offset': offset,
              'dataBase64': base64Encode(bytes.sublist(offset, end)),
            },
          );
          checkActive();
          offset = end;
        }
        checkActive();
        final completed = await transport.request('attachment.upload.complete',
            <String, Object?>{'uploadId': uploadId});
        checkActive();
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
  }) {
    final origin = _captureTransportOrigin();
    return _createSession(
      providerId: providerId,
      workingDirectory: workingDirectory,
      firstInstruction: firstInstruction,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      title: title,
      origin: origin,
    );
  }

  Future<RemoteSession> _createSession({
    required String providerId,
    required String workingDirectory,
    required String firstInstruction,
    required _TransportOrigin origin,
    String? modelId,
    String? reasoningEffort,
    String? title,
  }) async {
    _requireTransportOrigin(origin, action: 'the task was being created');
    if (!_isMobileProviderEnabled(providerId)) {
      throw StateError('That harness is not available');
    }
    final result =
        await origin.transport.request('session.create', <String, Object?>{
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
    RemoteSession? acknowledgedSession;
    try {
      acknowledgedSession = RemoteSession.fromJson(result['session']);
      if (acknowledgedSession.hostId != origin.hostId) {
        throw const FormatException('Created task belongs to another host');
      }
      if (!_isMobileProviderEnabled(acknowledgedSession.providerId)) {
        throw StateError('That harness is not available');
      }
      _requireTransportOrigin(origin, action: 'the task was being created');
      _upsertSession(acknowledgedSession);
      selectedSession = acknowledgedSession;
      if (firstInstruction.trim().isNotEmpty) {
        _recordRecentModelUse(
          acknowledgedSession.providerId,
          acknowledgedSession.modelId ?? modelId,
          acknowledgedSession.lastActivityAt,
          acceptedSelection: modelId?.trim().isNotEmpty == true,
        );
      }
      _markSessionRead(
          acknowledgedSession.id, acknowledgedSession.lastActivityAt);
      notifyListeners();
      unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
      return acknowledgedSession;
    } on Object catch (caught) {
      _scheduleAcknowledgementReconciliation(origin);
      throw _AcknowledgedSessionCreateFailure(
        caught,
        session: acknowledgedSession?.hostId == origin.hostId
            ? acknowledgedSession
            : null,
      );
    }
  }

  Future<ContextHandoffResult> contextHandoff(
    String sessionId, {
    String? prompt,
  }) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    final trimmedPrompt = prompt?.trim();
    final mutationKey = _bridgeMutationKey(
      origin,
      'session.context_handoff',
      <String?>[sessionId, trimmedPrompt],
    );
    _beginBridgeMutation(mutationKey);
    final sessionIdsBefore = sessions.map((session) => session.id).toSet();
    late final Map<String, Object?> result;
    try {
      result = await origin.transport.request(
        'session.context_handoff',
        <String, Object?>{
          'sessionId': sessionId,
          if (trimmedPrompt?.isNotEmpty == true) 'prompt': trimmedPrompt,
        },
      );
    } on Object {
      _finishBridgeMutation(mutationKey);
      rethrow;
    }
    try {
      _requireTransportOrigin(origin,
          action: 'the context handoff was being created');
    } on Object {
      _consumeBridgeMutation(mutationKey);
      rethrow;
    }

    ContextHandoffResult? handoff;
    try {
      final parsed = ContextHandoffResult.fromJson(result);
      if (parsed.session.hostId != origin.hostId) {
        throw const FormatException('Context handoff belongs to another host');
      }
      if (!_isMobileProviderEnabled(parsed.session.providerId)) {
        throw StateError('That harness is not available');
      }
      handoff = parsed;
    } on Object {
      if (_transportOriginIsCurrent(origin)) {
        await _reconcileAcknowledgedMutation(origin);
        final recovered = sessions
            .where((session) =>
                !sessionIdsBefore.contains(session.id) &&
                session.hostId == origin.hostId &&
                session.relationship?.kind == 'handoff' &&
                session.relationship?.sourceSessionId == sessionId)
            .firstOrNull;
        if (recovered != null) {
          handoff = ContextHandoffResult(
            summary: recovered.contextHandoffSummary ?? '',
            session: recovered,
            prompt: trimmedPrompt,
          );
        }
      }
    }
    if (handoff == null) {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(origin);
      throw const _AcknowledgedMutationFailure(
        'The context handoff was created and the new task is being refreshed.',
      );
    }

    try {
      _upsertSession(handoff.session);
      handoffSummaries[handoff.session.id] = handoff.summary;
      if (handoff.prompt?.isNotEmpty == true) {
        setDraft(handoff.session.id, handoff.prompt!);
      }
      selectedSession = handoff.session;
      _markSessionRead(handoff.session.id, handoff.session.lastActivityAt);
      _notifyListenersAfterAcknowledgement();
      unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
      _finishBridgeMutation(mutationKey);
      return handoff;
    } on Object {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(origin);
      throw const _AcknowledgedMutationFailure(
        'The context handoff was created and the new task is being refreshed.',
      );
    }
  }

  Future<SessionBranchResult> branchSession(
    String sessionId, {
    String? prompt,
  }) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    final trimmedPrompt = prompt?.trim();
    final mutationKey = _bridgeMutationKey(
      origin,
      'session.branch',
      <String?>[sessionId, trimmedPrompt],
    );
    _beginBridgeMutation(mutationKey);
    final sessionIdsBefore = sessions.map((session) => session.id).toSet();
    late final Map<String, Object?> result;
    try {
      result = await origin.transport.request(
        'session.branch',
        <String, Object?>{
          'sessionId': sessionId,
          if (trimmedPrompt?.isNotEmpty == true) 'prompt': trimmedPrompt,
        },
      );
    } on Object {
      _finishBridgeMutation(mutationKey);
      rethrow;
    }
    try {
      _requireTransportOrigin(origin,
          action: 'the task branch was being created');
    } on Object {
      _consumeBridgeMutation(mutationKey);
      rethrow;
    }

    SessionBranchResult? branch;
    try {
      final parsed = SessionBranchResult.fromJson(result);
      if (parsed.session.hostId != origin.hostId) {
        throw const FormatException('Task branch belongs to another host');
      }
      if (!_isMobileProviderEnabled(parsed.session.providerId)) {
        throw StateError('That harness is not available');
      }
      branch = parsed;
    } on Object {
      if (_transportOriginIsCurrent(origin)) {
        await _reconcileAcknowledgedMutation(origin);
        final recovered = sessions
            .where((session) =>
                !sessionIdsBefore.contains(session.id) &&
                session.hostId == origin.hostId &&
                session.relationship?.kind == 'branch' &&
                session.relationship?.sourceSessionId == sessionId)
            .firstOrNull;
        if (recovered != null) {
          branch = SessionBranchResult(
            session: recovered,
            strategy: recovered.relationship?.strategy ?? 'branch',
            copiedMessageCount: 0,
          );
        }
      }
    }
    if (branch == null) {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(origin);
      throw const _AcknowledgedMutationFailure(
        'The task branch was created and is being refreshed.',
      );
    }

    try {
      _upsertSession(branch.session);
      if (trimmedPrompt?.isNotEmpty == true) {
        setDraft(branch.session.id, trimmedPrompt!);
      }
      selectedSession = branch.session;
      _markSessionRead(branch.session.id, branch.session.lastActivityAt);
      _notifyListenersAfterAcknowledgement();
      unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
      _finishBridgeMutation(mutationKey);
      return branch;
    } on Object {
      _consumeBridgeMutation(mutationKey);
      _scheduleAcknowledgementReconciliation(origin);
      throw const _AcknowledgedMutationFailure(
        'The task branch was created and is being refreshed.',
      );
    }
  }

  Future<void> interrupt(String sessionId) async {
    final origin = _captureTransportOrigin(sessionId: sessionId);
    try {
      await origin.transport.request(
          'session.interrupt', <String, Object?>{'sessionId': sessionId});
      _requireTransportOrigin(origin, action: 'the task was being stopped');
    } on Object catch (caught) {
      _requireTransportOrigin(origin, action: 'the task was being stopped');
      // A delegating parent stays marked working after its hand-off turn ends,
      // which left a stop button on a task with nothing to stop. The harness
      // reporting no turn is proof the task is not running, so settle the
      // state instead of surfacing an error about a turn the user never
      // started.
      if (RegExp(r'no active .* turn', caseSensitive: false)
          .hasMatch(caught.toString())) {
        _settleSessionIdle(sessionId);
        return;
      }
      rethrow;
    }
  }

  void _settleSessionIdle(String sessionId) {
    final index = sessions.indexWhere((session) => session.id == sessionId);
    if (index < 0 || sessions[index].state != 'working') return;
    sessions[index] = sessions[index].copyWith(state: 'idle');
    if (selectedSession?.id == sessionId) {
      selectedSession = sessions[index];
    }
    notifyListeners();
    unawaited(_syncVisibleSessionHistory(sessionId));
  }

  bool _settleSessionsWithoutApprovals(Iterable<String> sessionIds) {
    var changed = false;
    for (final sessionId in sessionIds.toSet()) {
      if (approvals.values.any((approval) => approval.sessionId == sessionId)) {
        continue;
      }
      final index = sessions.indexWhere((session) => session.id == sessionId);
      if (index < 0) continue;
      final current = sessions[index];
      if (current.state != 'needs_approval' && !current.needsApproval) continue;
      final hasUserInput =
          userInputs.values.any((request) => request.sessionId == sessionId);
      final updated = current.copyWith(
        state: current.state == 'needs_approval'
            ? hasUserInput
                ? 'needs_input'
                : 'idle'
            : current.state,
        needsApproval: false,
      );
      sessions[index] = updated;
      if (selectedSession?.id == sessionId) selectedSession = updated;
      changed = true;
    }
    return changed;
  }

  bool _reconcileLocalAttentionState(String sessionId,
      {required String fallbackState}) {
    final index = sessions.indexWhere((session) => session.id == sessionId);
    if (index < 0) return false;
    final current = sessions[index];
    final state = approvals.values.any((item) => item.sessionId == sessionId)
        ? 'needs_approval'
        : userInputs.values.any((item) => item.sessionId == sessionId)
            ? 'needs_input'
            : fallbackState;
    final needsApproval = state == 'needs_approval';
    if (current.state == state && current.needsApproval == needsApproval) {
      return false;
    }
    final updated = current.copyWith(
      state: state,
      needsApproval: needsApproval,
    );
    sessions[index] = updated;
    if (selectedSession?.id == sessionId) selectedSession = updated;
    return true;
  }

  bool _removeExpiredApprovals([DateTime? now]) {
    final expired = approvals.values
        .where((approval) => approval.isExpired(now))
        .toList(growable: false);
    if (expired.isEmpty) return false;
    final affectedSessionIds = expired.map((approval) => approval.sessionId);
    for (final approval in expired) {
      approvals.remove(approval.requestId);
    }
    _approvalRevision += 1;
    _settleSessionsWithoutApprovals(affectedSessionIds);
    return true;
  }

  void _rescheduleApprovalExpiry() {
    _approvalExpiryTimer?.cancel();
    _approvalExpiryTimer = null;
    final expirations = approvals.values
        .map((approval) => approval.expiresAt)
        .whereType<DateTime>()
        .toList(growable: false);
    if (expirations.isEmpty) return;
    expirations.sort();
    final delay = expirations.first.difference(DateTime.now().toUtc());
    _approvalExpiryTimer = Timer(
      delay.isNegative ? Duration.zero : delay,
      () {
        _approvalExpiryTimer = null;
        final changed = _removeExpiredApprovals();
        _rescheduleApprovalExpiry();
        if (changed) notifyListeners();
      },
    );
  }

  Future<void> respondToApproval(
      ApprovalRequest approval, String choiceId) async {
    if (!approvals.containsKey(approval.requestId)) return;
    if (approval.isExpired()) {
      final removed = approvals.remove(approval.requestId) != null;
      if (removed) _approvalRevision += 1;
      final settled =
          _settleSessionsWithoutApprovals(<String>[approval.sessionId]);
      _rescheduleApprovalExpiry();
      if (removed || settled) notifyListeners();
      return;
    }
    final origin = _captureTransportOrigin(sessionId: approval.sessionId);
    await origin.transport.request('approval.respond', <String, Object?>{
      'requestId': approval.requestId,
      'choiceId': choiceId,
      'respondedAt': DateTime.now().toUtc().toIso8601String(),
    });
    _requireTransportOrigin(origin, action: 'the approval was being answered');
    if (approvals.remove(approval.requestId) != null) _approvalRevision += 1;
    _reconcileLocalAttentionState(approval.sessionId,
        fallbackState:
            choiceId.toLowerCase().contains('reject') ? 'idle' : 'working');
    _rescheduleApprovalExpiry();
    notifyListeners();
  }

  Future<void> respondToUserInput(
      UserInputRequest request, JsonMap answers) async {
    final origin = _captureTransportOrigin(sessionId: request.sessionId);
    if (!userInputs.containsKey(request.requestId)) return;
    await origin.transport.request('user_input.respond', <String, Object?>{
      'requestId': request.requestId,
      'answers': answers,
      'respondedAt': DateTime.now().toUtc().toIso8601String(),
    });
    _requireTransportOrigin(origin,
        action: 'the requested input was being submitted');
    if (userInputs.remove(request.requestId) != null) _userInputRevision += 1;
    _reconcileLocalAttentionState(request.sessionId, fallbackState: 'working');
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
    if (!_canMutateDraft(sessionId)) return;
    if (drafts[sessionId] == value && _draftRevisions.containsKey(sessionId)) {
      return;
    }
    drafts[sessionId] = value;
    _touchDraft(sessionId);
  }

  SimplifySettings? simplifySettingsFor(String sessionId) =>
      draftSimplifySettings[sessionId];

  void setDraftSimplifySettings(String sessionId, SimplifySettings? settings) {
    if (!_canMutateDraft(sessionId)) return;
    final current = draftSimplifySettings[sessionId];
    if (_sameSimplifySettings(current, settings)) return;
    if (settings == null) {
      draftSimplifySettings.remove(sessionId);
    } else {
      draftSimplifySettings[sessionId] = settings;
    }
    _touchDraft(sessionId);
  }

  List<DelegationSelection> draftDelegationSelectionsFor(String sessionId) =>
      List<DelegationSelection>.unmodifiable(
        _draftDelegationSelections[sessionId] ?? const <DelegationSelection>[],
      );

  void setDraftDelegationSelections(
    String sessionId,
    Iterable<DelegationSelection> selections,
  ) {
    if (!_canMutateDraft(sessionId)) return;
    final normalized = _normalizeDraftDelegationSelections(selections);
    final current =
        _draftDelegationSelections[sessionId] ?? const <DelegationSelection>[];
    if (_sameDelegationSelections(current, normalized)) return;
    if (normalized.isEmpty) {
      _draftDelegationSelections.remove(sessionId);
    } else {
      _draftDelegationSelections[sessionId] = normalized;
    }
    _touchDraft(sessionId);
    notifyListeners();
  }

  List<RemoteAttachment> draftAttachmentsFor(String sessionId) =>
      List<RemoteAttachment>.unmodifiable(
          draftAttachments[sessionId] ?? const <RemoteAttachment>[]);

  void setDraftAttachments(
      String sessionId, Iterable<RemoteAttachment> attachments) {
    if (!_canMutateDraft(sessionId)) return;
    final retained = List<RemoteAttachment>.unmodifiable(
        List<RemoteAttachment>.of(attachments));
    final current = draftAttachments[sessionId] ?? const <RemoteAttachment>[];
    if (_sameAttachments(current, retained) &&
        _hydratedDraftAttachmentIds.contains(sessionId)) {
      return;
    }
    if (retained.isEmpty) {
      draftAttachments.remove(sessionId);
    } else {
      draftAttachments[sessionId] = retained;
    }
    _hydratedDraftAttachmentIds.add(sessionId);
    _draftAttachmentVersions[sessionId] =
        (_draftAttachmentVersions[sessionId] ?? 0) + 1;
    _touchDraft(sessionId);
  }

  bool draftAttachmentsHydratedFor(String sessionId) =>
      _hydratedDraftAttachmentIds.contains(sessionId);

  RetainedDictationDraft? retainedDictationFor(String sessionId) =>
      _pendingRetainedDictationClears.containsKey(sessionId)
          ? null
          : _retainedDictations[sessionId];

  /// Makes a stopped recording process-death-safe before transcription or an
  /// attachment upload is allowed to begin.
  Future<void> retainDictation(
    String sessionId,
    List<int> bytes, {
    String? sourceId,
    bool directAudio = false,
  }) async {
    if (!_canMutateDraft(sessionId)) {
      throw StateError('That recording belongs to a different computer.');
    }
    if (bytes.isEmpty || bytes.length > maxSingleMessageAttachmentBytes) {
      throw StateError('Audio recordings must be between 1 byte and 25 MiB.');
    }
    _retainedDictations[sessionId] = RetainedDictationDraft(
      bytes: bytes,
      sourceId: sourceId,
      directAudio: directAudio,
    );
    _pendingRetainedDictationClears.remove(sessionId);
    _hydratedRetainedDictationIds.add(sessionId);
    _retainedDictationVersions[sessionId] =
        (_retainedDictationVersions[sessionId] ?? 0) + 1;
    _touchDraft(sessionId);
    await flushDraftJournal();
  }

  /// Clears retained audio only after a successful commit or an explicit user
  /// discard, and makes the replacement composition durable before returning.
  Future<void> clearRetainedDictation(String sessionId) async {
    if (!_canMutateDraft(sessionId)) return;
    final retainedVersion = _retainedDictationVersions[sessionId] ?? 0;
    await hydrateDraftComposition(sessionId);
    if (!_canMutateDraft(sessionId)) {
      throw StateError('That recording belongs to a different computer.');
    }
    if ((_retainedDictationVersions[sessionId] ?? 0) != retainedVersion) {
      return;
    }
    final hadRetained = _retainedDictations.containsKey(sessionId) ||
        !_hydratedRetainedDictationIds.contains(sessionId) &&
            _draftJournalEntries[sessionId]?.retainedDictations.isNotEmpty ==
                true;
    if (!hadRetained) return;
    final hostId = _hostIdForDraftSession(sessionId);
    if (hostId == null) return;
    _retainedDictations.remove(sessionId);
    _pendingRetainedDictationClears[sessionId] = hostId;
    _hydratedRetainedDictationIds.add(sessionId);
    _retainedDictationVersions[sessionId] =
        (_retainedDictationVersions[sessionId] ?? 0) + 1;
    _touchDraft(sessionId);
    await flushDraftJournal();
  }

  /// Hydrates only the binary parts of one already-restored composition. Text
  /// and lightweight settings are available synchronously during first paint.
  Future<void> hydrateDraftComposition(String sessionId) async {
    final hostId = _draftJournalHostId;
    final entry = _draftJournalEntries[sessionId];
    if (hostId == null || entry == null || entry.hostId != hostId) return;
    if (activeHost != null && activeHost!.hostId != hostId) return;
    final hydrateAttachments = !_hydratedDraftAttachmentIds.contains(sessionId);
    final hydrateRetained =
        !_hydratedRetainedDictationIds.contains(sessionId) &&
            !_pendingRetainedDictationClears.containsKey(sessionId);
    if (!hydrateAttachments && !hydrateRetained) return;
    final attachmentVersion = _draftAttachmentVersions[sessionId] ?? 0;
    final retainedVersion = _retainedDictationVersions[sessionId] ?? 0;
    final journal = await _ensureDraftJournal();
    if (journal == null) return;

    final hydratedAttachments = <RemoteAttachment>[];
    var unavailableBlob = entry.unavailableBlobIds.isNotEmpty;
    if (hydrateAttachments) {
      for (final blob in entry.attachments) {
        final bytes = await journal.hydrateBlob(blob);
        if (bytes == null) {
          unavailableBlob = true;
          continue;
        }
        final attachment = RemoteAttachment(
          name: blob.name,
          mimeType: blob.mimeType,
          dataBase64: await compute(base64Encode, bytes),
          byteLength: bytes.length,
          origin: blob.origin,
        );
        _journalBlobForAttachment[attachment] = blob;
        hydratedAttachments.add(attachment);
      }
    }

    RetainedDictationDraft? hydratedRetained;
    if (hydrateRetained && entry.retainedDictations.isNotEmpty) {
      final blob = entry.retainedDictations.first;
      final bytes = await journal.hydrateBlob(blob);
      if (bytes == null) {
        unavailableBlob = true;
      } else {
        hydratedRetained = RetainedDictationDraft(
          bytes: bytes,
          sourceId: blob.sourceId,
          directAudio: blob.directAudio,
        );
        _journalBlobForRetainedDictation[hydratedRetained] = blob;
      }
    }

    if (_draftJournalHostId != hostId ||
        activeHost != null && activeHost!.hostId != hostId) {
      return;
    }
    // A text-only flush replaces the immutable journal entry object while
    // retaining the same lazy blobs. Attachment and recording versions are the
    // authoritative mutation guards, so object identity must not abort valid
    // hydration and leave the screen believing those blobs were loaded.
    var changed = false;
    if (hydrateAttachments &&
        (_draftAttachmentVersions[sessionId] ?? 0) == attachmentVersion) {
      if (hydratedAttachments.isEmpty) {
        draftAttachments.remove(sessionId);
      } else {
        draftAttachments[sessionId] =
            List<RemoteAttachment>.unmodifiable(hydratedAttachments);
      }
      _hydratedDraftAttachmentIds.add(sessionId);
      changed = true;
    }
    if (hydrateRetained &&
        (_retainedDictationVersions[sessionId] ?? 0) == retainedVersion) {
      if (hydratedRetained == null) {
        _retainedDictations.remove(sessionId);
      } else {
        _retainedDictations[sessionId] = hydratedRetained;
      }
      _hydratedRetainedDictationIds.add(sessionId);
      changed = true;
    }
    if (unavailableBlob && changed) {
      _touchDraft(sessionId);
    }
    if (changed) notifyListeners();
  }

  /// Flushes the latest coalesced draft revisions in one ordered journal tail.
  /// Repeated or concurrent calls are safe and become no-ops when clean.
  Future<void> flushDraftJournal({bool runMaintenance = true}) {
    _draftJournalDebounce?.cancel();
    _draftJournalDebounce = null;
    final operation = _enqueueDraftJournalOperation(() async {
      final pendingHostDeletes = Set<String>.of(_pendingDraftHostDeletes);
      Object? firstError;
      StackTrace? firstStack;
      for (final hostId in pendingHostDeletes) {
        try {
          final journal = await _ensureDraftJournal();
          if (journal != null) await journal.deleteHost(hostId);
          _pendingDraftHostDeletes.remove(hostId);
        } on Object catch (caught, stack) {
          firstError ??= caught;
          firstStack ??= stack;
        }
      }
      final pending = Map<String, String>.of(_dirtyDraftHosts);
      for (final entry in pending.entries) {
        if (_dirtyDraftHosts[entry.key] == entry.value) {
          _dirtyDraftHosts.remove(entry.key);
        }
      }
      for (final pendingEntry in pending.entries) {
        final sessionId = pendingEntry.key;
        final hostId = pendingEntry.value;
        try {
          final snapshot = _buildDraftJournalSnapshot(hostId, sessionId);
          if (snapshot != null) await _persistDraftJournalSnapshot(snapshot);
        } on Object catch (caught, stack) {
          if (_hostIdForDraftSession(sessionId) == hostId) {
            _dirtyDraftHosts[sessionId] = hostId;
          }
          firstError ??= caught;
          firstStack ??= stack;
        }
      }
      final pendingDeletes = Map<String, _PendingDraftJournalDelete>.of(
          _pendingDraftJournalDeletes);
      for (final pendingEntry in pendingDeletes.entries) {
        final deletion = pendingEntry.value;
        try {
          final journal = await _ensureDraftJournal();
          final deleted = journal == null
              ? false
              : await journal.delete(
                  deletion.hostId,
                  deletion.sessionId,
                  expectedRevision: deletion.expectedRevision,
                );
          if (identical(
              _pendingDraftJournalDeletes[pendingEntry.key], deletion)) {
            _pendingDraftJournalDeletes.remove(pendingEntry.key);
          }
          if (deleted && _draftJournalHostId == deletion.hostId) {
            final current = _draftJournalEntries[deletion.sessionId];
            if (current?.revision == deletion.expectedRevision) {
              _draftJournalEntries.remove(deletion.sessionId);
            }
          }
        } on Object catch (caught, stack) {
          firstError ??= caught;
          firstStack ??= stack;
        }
      }
      if (runMaintenance && _draftJournalCleanupPending) {
        try {
          final journal = await _ensureDraftJournal();
          if (journal != null) await journal.cleanupOrphans();
          _draftJournalCleanupPending = false;
        } on Object catch (caught, stack) {
          firstError ??= caught;
          firstStack ??= stack;
        }
      }
      if (firstError != null) {
        Error.throwWithStackTrace(firstError, firstStack ?? StackTrace.current);
      }
    });
    return operation.then<void>((_) {
      if (_hasPendingDraftJournalWork) {
        _scheduleDraftJournalRetry();
      } else {
        _draftJournalRetryTimer?.cancel();
        _draftJournalRetryTimer = null;
        _draftJournalRetryAttempt = 0;
      }
    }, onError: (Object caught, StackTrace stack) {
      _scheduleDraftJournalRetry();
      Error.throwWithStackTrace(caught, stack);
    });
  }

  bool get _hasPendingDraftJournalWork =>
      _dirtyDraftHosts.isNotEmpty ||
      _pendingDraftHostDeletes.isNotEmpty ||
      _pendingDraftJournalDeletes.isNotEmpty ||
      _draftJournalCleanupPending;

  bool get hasPendingDraftJournalWrites => _hasPendingDraftJournalWork;

  Future<void> retryDraftJournalWrites() => flushDraftJournal();

  void _scheduleDraftJournalRetry() {
    if (_disposed ||
        _draftJournalFactory == null ||
        !_hasPendingDraftJournalWork ||
        _draftJournalRetryTimer != null) {
      return;
    }
    final delayIndex =
        _draftJournalRetryAttempt < _draftJournalRetryDelays.length
            ? _draftJournalRetryAttempt
            : _draftJournalRetryDelays.length - 1;
    _draftJournalRetryAttempt += 1;
    _draftJournalRetryTimer = Timer(_draftJournalRetryDelays[delayIndex], () {
      _draftJournalRetryTimer = null;
      unawaited(flushDraftJournal().catchError((Object _) {}));
    });
  }

  Future<DraftJournal?> _ensureDraftJournal() {
    if (_draftJournalFactory == null) return Future<DraftJournal?>.value();
    return _draftJournalLoad ??= _draftJournalFactory();
  }

  Future<void> _deleteDraftJournalHost(String hostId) =>
      _enqueueDraftJournalOperation(() async {
        final journal = await _ensureDraftJournal();
        if (journal != null) await journal.deleteHost(hostId);
        _pendingDraftHostDeletes.remove(hostId);
      });

  Future<void> _reactivateDraftJournalHost(String hostId) =>
      _enqueueDraftJournalOperation(() async {
        final journal = await _ensureDraftJournal();
        if (journal != null) await journal.reactivateHost(hostId);
        _pendingDraftHostDeletes.remove(hostId);
      });

  Future<bool> _restoreDraftJournalHost(
    String hostId, {
    bool Function()? isCurrent,
  }) async {
    final journal = await _ensureDraftJournal();
    if (isCurrent != null && !isCurrent()) return false;
    if (journal == null) {
      _draftJournalHostId = hostId;
      return true;
    }
    final entries = await journal.readHost(hostId);
    if (isCurrent != null && !isCurrent()) return false;
    if (_draftJournalHostId != null && _draftJournalHostId != hostId) {
      return false;
    }
    _draftJournalHostId = hostId;
    for (final entry in entries) {
      _draftJournalEntries[entry.sessionId] = entry;
      drafts[entry.sessionId] = entry.text;
      if (entry.simplify case final simplify?) {
        draftSimplifySettings[entry.sessionId] = SimplifySettings(
          maxWords: simplify.maxWords,
          guidance: simplify.guidance,
        );
      }
      if (entry.delegationSelections.isNotEmpty) {
        _draftDelegationSelections[entry.sessionId] =
            List<DelegationSelection>.unmodifiable(
          entry.delegationSelections.map(
            (selection) => DelegationSelection(
              providerId: selection.providerId,
              modelId: selection.modelId,
              reasoningEffort: selection.reasoningEffort,
            ),
          ),
        );
      }
      _draftRevisions[entry.sessionId] = entry.revision;
      if (entry.revision > _nextDraftRevision) {
        _nextDraftRevision = entry.revision;
      }
      _draftAttachmentVersions[entry.sessionId] = 0;
      _retainedDictationVersions[entry.sessionId] = 0;
      if (entry.attachments.isEmpty) {
        _hydratedDraftAttachmentIds.add(entry.sessionId);
      }
      if (entry.retainedDictations.isEmpty) {
        _hydratedRetainedDictationIds.add(entry.sessionId);
      }
      final prepared = entry.preparedTask;
      if (prepared != null &&
          !sessions.any((session) => session.id == entry.sessionId)) {
        final session = RemoteSession(
          id: entry.sessionId,
          hostId: hostId,
          providerId: prepared.providerId,
          providerSessionId: entry.sessionId,
          title: 'New task',
          state: 'idle',
          lastActivityAt: entry.updatedAt.toLocal(),
          needsApproval: false,
          stale: false,
          workingDirectory: prepared.workingDirectory,
          modelId: prepared.modelId,
          reasoningEffort: prepared.reasoningEffort,
        );
        _preparedSessionIds.add(entry.sessionId);
        if (prepared.creationAcknowledged) {
          _acknowledgedPreparedSessionIds.add(entry.sessionId);
        }
        sessions.add(session);
        messages.putIfAbsent(entry.sessionId, () => <RemoteMessage>[]);
      }
    }
    _draftJournalCleanupPending = true;
    return true;
  }

  void _clearDraftStateForHostChange() {
    sessions.removeWhere((session) => _preparedSessionIds.contains(session.id));
    _preparedSessionIds.clear();
    _acknowledgedPreparedSessionIds.clear();
    drafts.clear();
    draftAttachments.clear();
    draftSimplifySettings.clear();
    _draftDelegationSelections.clear();
    _draftRevisions.clear();
    _draftAttachmentVersions.clear();
    _retainedDictationVersions.clear();
    _retainedDictations.clear();
    _pendingRetainedDictationClears.clear();
    _draftJournalEntries.clear();
    _hydratedDraftAttachmentIds.clear();
    _hydratedRetainedDictationIds.clear();
    _dirtyDraftHosts.clear();
    _draftJournalHostId = null;
    _draftJournalCleanupPending = false;
  }

  void _clearHostSessionStateForHostChange() {
    _hostSessionCacheGeneration += 1;
    for (final operation
        in _earsOperationsBySession.values.expand((items) => items)) {
      operation.cancel();
      final requestId = operation.currentBridgeRequestId;
      if (requestId != null) {
        unawaited(operation.origin.transport.request(
          'ears.cancel',
          <String, Object?>{'requestId': requestId},
        ).catchError((Object _) => <String, Object?>{}));
      }
    }
    _earsOperationsBySession.clear();
    selectedSession = null;
    sessions.clear();
    messages.clear();
    events.clear();
    _liveAssistantText.clear();
    _liveAssistantSnapshots.clear();
    _liveAssistantReasoning.clear();
    _liveAssistantStartedAt.clear();
    _historySyncs.clear();
    _sessionHistoryLoads.clear();
    _olderHistoryLoads.clear();
    _historyCursors.clear();
    _historyImageCache.clear();
    _historyImageLoads.clear();
    _historyImageGenerations.clear();
    _optimisticMessageIdsBySession.clear();
    _inFlightOptimisticMessageIds.clear();
    _childSessionLoads.clear();
    _lastEventSequenceBySession.clear();
    _liveSessionRevisions.clear();
    _queueingDisabledSessionIds.clear();
    _visibleSessionId = null;
    _visibleSessionOwners.clear();
    _lastReadAt.clear();
    unreadSessionIds.clear();
    _hasReadState = false;
    providers.clear();
    dictationSources.clear();
    pairedDevices.clear();
    queuedMessages.clear();
    _queuedRevision += 1;
    _sideChatRevision += 1;
    delegations.clear();
    _locallyPreparedDelegationIds.clear();
    approvals.clear();
    _approvalRevision += 1;
    _approvalExpiryTimer?.cancel();
    _approvalExpiryTimer = null;
    userInputs.clear();
    _userInputRevision += 1;
    modelsByProvider.clear();
    walletByModel.clear();
    handoffSummaries.clear();
    _invalidateVisionProxyTargets();
    contextBySession.clear();
    _contextRequestGenerations.clear();
    goalsBySession.clear();
    _goalClearRevisions.clear();
    _modelLoads.clear();
    _modelLoadFailures.clear();
    lastSuccessfulRefresh = null;
    refreshing = false;
  }

  void _touchDraft(String sessionId) {
    _draftRevisions[sessionId] = ++_nextDraftRevision;
    _markDraftDirty(sessionId);
  }

  void _markDraftDirty(String sessionId) {
    if (_draftJournalFactory == null) return;
    final hostId = _hostIdForDraftSession(sessionId);
    if (hostId == null) return;
    final currentHostId = activeHost?.hostId ?? _draftJournalHostId;
    if (currentHostId != null && currentHostId != hostId) return;
    _dirtyDraftHosts[sessionId] = hostId;
    _draftJournalDebounce?.cancel();
    _draftJournalDebounce = Timer(const Duration(milliseconds: 300), () {
      _draftJournalDebounce = null;
      unawaited(flushDraftJournal().catchError((Object _) {}));
    });
  }

  String? _hostIdForDraftSession(String sessionId) {
    final session = sessions.where((item) => item.id == sessionId).firstOrNull;
    return session?.hostId ?? activeHost?.hostId ?? _draftJournalHostId;
  }

  bool _canMutateDraft(String sessionId) {
    final activeHostId = activeHost?.hostId;
    if (activeHostId == null) return true;
    final session = sessions.where((item) => item.id == sessionId).firstOrNull;
    return session != null && session.hostId == activeHostId;
  }

  bool _outgoingStillBelongsToActiveHost(
      _OutgoingCompositionSnapshot outgoing) {
    final activeHostId = activeHost?.hostId;
    return outgoing.hostId == null
        ? activeHostId == null
        : activeHostId == null || outgoing.hostId == activeHostId;
  }

  _DraftJournalSnapshot? _buildDraftJournalSnapshot(
      String hostId, String sessionId) {
    if (_draftJournalFactory == null ||
        _hostIdForDraftSession(sessionId) != hostId) {
      return null;
    }
    final revision = _draftRevisions[sessionId];
    if (revision == null) return null;
    final existing = _draftJournalEntries[sessionId];
    final attachmentObjects = List<RemoteAttachment>.of(
        draftAttachments[sessionId] ?? const <RemoteAttachment>[]);
    final attachmentInputs = <DraftJournalBlobInput>[];
    if (_hydratedDraftAttachmentIds.contains(sessionId)) {
      final existingBlobIds =
          (existing?.attachments ?? const <DraftJournalBlob>[])
              .map((blob) => blob.blobId)
              .toSet();
      for (final attachment in attachmentObjects) {
        final mapped = _journalBlobForAttachment[attachment];
        if (mapped != null && existingBlobIds.contains(mapped.blobId)) {
          attachmentInputs.add(DraftJournalBlobInput.reuse(mapped));
          continue;
        }
        late final Uint8List bytes;
        try {
          bytes = base64Decode(attachment.dataBase64);
        } on FormatException {
          throw StateError('A draft attachment could not be saved.');
        }
        if (bytes.length != attachment.byteLength) {
          throw StateError('A draft attachment changed while being saved.');
        }
        attachmentInputs.add(DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.attachment,
          name: attachment.name,
          mimeType: attachment.mimeType,
          bytes: bytes,
          origin: attachment.origin,
          directAudio: isDictationAudioAttachment(attachment),
        ));
      }
    } else {
      attachmentInputs.addAll(
          (existing?.attachments ?? const <DraftJournalBlob>[])
              .map(DraftJournalBlobInput.reuse));
    }

    final retainedInputs = <DraftJournalBlobInput>[];
    final retained = _retainedDictations[sessionId];
    if (_hydratedRetainedDictationIds.contains(sessionId)) {
      if (retained != null) {
        final mapped = _journalBlobForRetainedDictation[retained];
        final mappedIsCurrent = mapped != null &&
            (existing?.retainedDictations ?? const <DraftJournalBlob>[])
                .any((blob) => blob.blobId == mapped.blobId);
        retainedInputs.add(mappedIsCurrent
            ? DraftJournalBlobInput.reuse(mapped)
            : DraftJournalBlobInput.fromBytes(
                kind: DraftJournalBlobKind.retainedDictation,
                name: 'dictation.wav',
                mimeType: 'audio/wav',
                bytes: retained.bytes,
                origin: 'recording',
                sourceId: retained.sourceId,
                directAudio: retained.directAudio,
              ));
      }
    } else {
      retainedInputs.addAll(
          (existing?.retainedDictations ?? const <DraftJournalBlob>[])
              .map(DraftJournalBlobInput.reuse));
    }

    DraftJournalPreparedTaskState? preparedTask;
    if (_preparedSessionIds.contains(sessionId)) {
      final session =
          sessions.where((item) => item.id == sessionId).firstOrNull;
      if (session != null) {
        preparedTask = DraftJournalPreparedTaskState(
          providerId: session.providerId,
          workingDirectory: session.workingDirectory ?? '',
          modelId: session.modelId,
          reasoningEffort: session.reasoningEffort,
          creationAcknowledged:
              _acknowledgedPreparedSessionIds.contains(sessionId),
        );
      }
    }
    final simplify = draftSimplifySettings[sessionId];
    final delegationSelections =
        _draftDelegationSelections[sessionId] ?? const <DelegationSelection>[];
    final text = drafts[sessionId] ?? '';
    final shouldDelete = text.isEmpty &&
        simplify == null &&
        delegationSelections.isEmpty &&
        attachmentInputs.isEmpty &&
        retainedInputs.isEmpty &&
        preparedTask == null;
    return _DraftJournalSnapshot(
      hostId: hostId,
      sessionId: sessionId,
      revision: revision,
      shouldDelete: shouldDelete,
      attachmentObjects: List<RemoteAttachment>.unmodifiable(attachmentObjects),
      retainedDictation: retained,
      write: DraftJournalWrite(
        hostId: hostId,
        sessionId: sessionId,
        revision: revision,
        text: text,
        simplify: simplify == null
            ? null
            : DraftJournalSimplifyState(
                maxWords: simplify.maxWords,
                guidance: simplify.guidance,
              ),
        preparedTask: preparedTask,
        delegationSelections: delegationSelections.map(
          (selection) => DraftJournalDelegationSelectionState(
            providerId: selection.providerId,
            modelId: selection.modelId,
            reasoningEffort: selection.reasoningEffort,
          ),
        ),
        attachments: attachmentInputs,
        retainedDictations: retainedInputs,
      ),
    );
  }

  Future<void> _persistDraftJournalSnapshot(
      _DraftJournalSnapshot snapshot) async {
    final journal = await _ensureDraftJournal();
    if (journal == null) return;
    final saved = await journal.save(snapshot.write);
    if (saved.revision == snapshot.revision && !snapshot.shouldDelete) {
      final count = snapshot.attachmentObjects.length < saved.attachments.length
          ? snapshot.attachmentObjects.length
          : saved.attachments.length;
      for (var index = 0; index < count; index += 1) {
        _journalBlobForAttachment[snapshot.attachmentObjects[index]] =
            saved.attachments[index];
      }
      final retained = snapshot.retainedDictation;
      if (retained != null && saved.retainedDictations.isNotEmpty) {
        _journalBlobForRetainedDictation[retained] =
            saved.retainedDictations.first;
      }
    }
    if (snapshot.shouldDelete) {
      try {
        await journal.delete(
          snapshot.hostId,
          snapshot.sessionId,
          expectedRevision: snapshot.revision,
        );
      } on Object {
        _queueDraftJournalDelete(
          snapshot.hostId,
          snapshot.sessionId,
          snapshot.revision,
        );
      }
    }
    if (_draftJournalHostId != snapshot.hostId) return;
    if (snapshot.write.retainedDictations.isEmpty &&
        _pendingRetainedDictationClears[snapshot.sessionId] ==
            snapshot.hostId &&
        !_retainedDictations.containsKey(snapshot.sessionId) &&
        _draftRevisions[snapshot.sessionId] == snapshot.revision) {
      _pendingRetainedDictationClears.remove(snapshot.sessionId);
    }
    if (snapshot.shouldDelete) {
      final current = _draftJournalEntries[snapshot.sessionId];
      if (current == null || current.revision <= snapshot.revision) {
        _draftJournalEntries.remove(snapshot.sessionId);
      }
    } else {
      final current = _draftJournalEntries[snapshot.sessionId];
      if (current == null || saved.revision >= current.revision) {
        _draftJournalEntries[snapshot.sessionId] = saved;
      }
    }
  }

  Future<void> _deleteAcknowledgedDraft(
    String sessionId,
    _OutgoingCompositionSnapshot outgoing,
  ) async {
    final hostId = outgoing.hostId;
    final revision = outgoing.draftRevision;
    if (hostId == null || revision == null) return;
    try {
      await _deleteDraftJournalEntry(
        hostId,
        sessionId,
        expectedRevision: revision,
      );
    } on Object {
      _queueDraftJournalDelete(hostId, sessionId, revision);
    }
  }

  void _queueDraftJournalDelete(
      String hostId, String sessionId, int expectedRevision) {
    final deletion = _PendingDraftJournalDelete(
      hostId: hostId,
      sessionId: sessionId,
      expectedRevision: expectedRevision,
    );
    _pendingDraftJournalDeletes[deletion.key] = deletion;
    _scheduleDraftJournalRetry();
  }

  Future<void> _deleteDraftJournalEntry(
    String hostId,
    String sessionId, {
    required int? expectedRevision,
  }) {
    return _enqueueDraftJournalOperation(() async {
      final journal = await _ensureDraftJournal();
      if (journal == null) return;
      final deleted = await journal.delete(
        hostId,
        sessionId,
        expectedRevision: expectedRevision,
      );
      if (!deleted || _draftJournalHostId != hostId) return;
      final current = _draftJournalEntries[sessionId];
      if (expectedRevision == null || current?.revision == expectedRevision) {
        _draftJournalEntries.remove(sessionId);
      }
    });
  }

  Future<void> _enqueueDraftJournalOperation(
      Future<void> Function() operation) {
    final result = _draftJournalOperations.then((_) => operation());
    _draftJournalOperations =
        result.then<void>((_) {}, onError: (Object _, StackTrace __) {});
    return result;
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
    if (sessionId == null) {
      _visibleSessionOwners.clear();
      _activateVisibleSession(null);
      return;
    }
    _visibleSessionOwners.add(sessionId);
    _activateVisibleSession(sessionId);
  }

  void clearVisibleSessionIf(String sessionId) {
    final wasVisible = _visibleSessionId == sessionId;
    final ownerIndex = _visibleSessionOwners.lastIndexOf(sessionId);
    final removed = ownerIndex >= 0;
    if (removed) _visibleSessionOwners.removeAt(ownerIndex);
    if (!wasVisible) return;
    if (!removed) {
      _activateVisibleSession(null);
      return;
    }
    _activateVisibleSession(
        _visibleSessionOwners.isEmpty ? null : _visibleSessionOwners.last);
  }

  @visibleForTesting
  String? get visibleSessionIdForTesting => _visibleSessionId;

  void _activateVisibleSession(String? sessionId) {
    if (_visibleSessionId == sessionId) return;
    final leaving = _visibleSessionId;
    if (leaving != null) {
      final matches = sessions.where((item) => item.id == leaving);
      final session = matches.isEmpty ? null : matches.first;
      if (session != null) _markSessionRead(leaving, session.lastActivityAt);
      unawaited(_enqueueReadStateWrite().catchError((Object _) {}));
    }
    _visibleSessionId = sessionId;
    if (sessionId != null && _transport != null) {
      unawaited(loadSessionGoal(sessionId).catchError((Object _) => null));
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _draftJournalDebounce?.cancel();
    _draftJournalDebounce = null;
    _draftJournalRetryTimer?.cancel();
    _draftJournalRetryTimer = null;
    unawaited(
        flushDraftJournal(runMaintenance: false).catchError((Object _) {}));
    _liveDeltaNotificationTimer?.cancel();
    _liveDeltaNotificationTimer = null;
    _approvalExpiryTimer?.cancel();
    _approvalExpiryTimer = null;
    unawaited(_detachTransport());
    super.dispose();
  }

  Future<void> _loadHostMetadata(
      BridgeTransport transport, String hostId) async {
    if (_transport != transport || activeHost?.hostId != hostId) return;
    final result =
        await transport.request('host.get', const <String, Object?>{});
    if (_transport != transport || activeHost?.hostId != hostId) return;
    final hostJson = jsonMap(result['host'], name: 'host');
    final current = activeHost;
    if (current != null && current.hostId == hostId) {
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
    await _loadPairedDevices(transport, hostId);
  }

  Future<void> _loadPairedDevices(
      BridgeTransport transport, String hostId) async {
    if (_transport != transport || activeHost?.hostId != hostId) return;
    final result =
        await transport.request('device.list', const <String, Object?>{});
    if (_transport != transport || activeHost?.hostId != hostId) return;
    pairedDevices
      ..clear()
      ..addAll(jsonList(result['devices']).map(PairedDevice.fromJson));
    notifyListeners();
  }

  Future<void> _loadProviders([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    if (_transport != transport) return;
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
    if (_transport != transport) return;
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
      // A transient foreground refresh failure must not erase a source that
      // was already ready before the app was backgrounded.
    }
  }

  Future<void> _loadQueuedMessages([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    if (_transport != transport) return;
    final hostId = activeHost?.hostId;
    final revisionAtStart = _queuedRevision;
    final result = await transport
        .request('message_queue.list', const <String, Object?>{});
    if (_transport != transport ||
        activeHost?.hostId != hostId ||
        _queuedRevision != revisionAtStart) return;
    final previous = Map<String, RemoteQueuedMessage>.of(queuedMessages);
    final snapshot = jsonList(result['messages'])
        .map(RemoteQueuedMessage.fromJson)
        .map((message) => _retainQueuedAttachmentPreviews(
              message,
              previous[message.id]?.attachments ??
                  const <RemoteQueuedAttachment>[],
            ))
        .toList(growable: false);
    queuedMessages
      ..clear()
      ..addEntries(snapshot.map((message) => MapEntry(message.id, message)));
    _queuedRevision += 1;
    notifyListeners();
  }

  Future<void> _loadSideChats({
    BridgeTransport? expectedTransport,
    String? parentSessionId,
  }) async {
    final transport = expectedTransport ?? _requireTransport();
    if (_transport != transport) return;
    final hostId = activeHost?.hostId;
    final revisionAtStart = _sideChatRevision;
    try {
      final result = await transport.request(
        'side_chat.list',
        <String, Object?>{
          if (parentSessionId?.isNotEmpty == true)
            'parentSessionId': parentSessionId,
        },
      );
      if (_transport != transport ||
          activeHost?.hostId != hostId ||
          _sideChatRevision != revisionAtStart) return;
      final sideChats = jsonList(result['sessions'])
          .map(RemoteSession.fromJson)
          .map((session) => session.copyWith(sessionKind: 'side_chat'))
          .where((session) => _isMobileProviderEnabled(session.providerId))
          .toList(growable: false);
      sessions.removeWhere((session) =>
          session.hostId == hostId &&
          session.sessionKind == 'side_chat' &&
          (parentSessionId == null ||
              session.parentSessionId == parentSessionId ||
              session.relationship?.sourceSessionId == parentSessionId));
      for (final sideChat in sideChats) {
        _upsertSession(sideChat);
      }
      _sideChatRevision += 1;
      notifyListeners();
    } on Object {
      // Side chats are additive; older bridges keep the normal task flow.
    }
  }

  bool _delegationChildHasSession(RemoteDelegationChild child) =>
      child.sessionId?.trim().isNotEmpty == true;

  bool _delegationIsMobileCompatible(RemoteDelegationTask task) =>
      task.children
          .every((child) => _isMobileProviderEnabled(child.providerId)) &&
      task.targets
          .every((target) => _isMobileProviderEnabled(target.providerId));

  Future<void> _loadDelegations([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    if (_transport != transport) return;
    final hostId = activeHost?.hostId;
    try {
      final result =
          await transport.request('delegation.list', const <String, Object?>{});
      if (_transport != transport || activeHost?.hostId != hostId) return;
      final loaded = jsonList(result['delegations'])
          .map(_remoteDelegationTaskFromJson)
          .where(_delegationIsMobileCompatible)
          .toList(growable: false);
      final loadedIds = loaded.map((task) => task.id).toSet();
      final retainedLocal = delegations.values
          .where((task) =>
              _locallyPreparedDelegationIds.contains(task.id) &&
              !loadedIds.contains(task.id))
          .toList(growable: false);
      _locallyPreparedDelegationIds.removeAll(loadedIds);
      delegations
        ..clear()
        ..addEntries(loaded.map((task) => MapEntry(task.id, task)))
        ..addEntries(retainedLocal.map((task) => MapEntry(task.id, task)));
      notifyListeners();
      for (final parentSessionId in delegations.values
          .where((task) => task.children.any(_delegationChildHasSession))
          .map((task) => task.parentSessionId)
          .toSet()) {
        unawaited(loadChildSessions(parentSessionId)
            .catchError((Object _) => childSessionsFor(parentSessionId)));
      }
    } on Object {
      // Older bridges do not expose /mesh yet; keep the rest of the app usable.
    }
  }

  Future<void> _loadApprovals([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    if (_transport != transport) return;
    final hostId = activeHost?.hostId;
    final revisionAtStart = _approvalRevision;
    try {
      final result =
          await transport.request('approval.list', const <String, Object?>{});
      if (_transport != transport ||
          activeHost?.hostId != hostId ||
          _approvalRevision != revisionAtStart) {
        return;
      }
      final loaded = jsonList(result['approvals'])
          .map(ApprovalRequest.fromJson)
          .where((request) => _isMobileProviderEnabled(request.providerId))
          .toList(growable: false);
      final affectedSessionIds = <String>{
        ...approvals.values.map((request) => request.sessionId),
        ...loaded.map((request) => request.sessionId),
      };
      approvals
        ..clear()
        ..addEntries(
            loaded.map((request) => MapEntry(request.requestId, request)));
      _approvalRevision += 1;
      _removeExpiredApprovals();
      for (final sessionId in affectedSessionIds) {
        final current =
            sessions.where((session) => session.id == sessionId).firstOrNull;
        if (current == null) continue;
        _reconcileLocalAttentionState(
          sessionId,
          fallbackState: current.state == 'needs_approval' ||
                  current.state == 'needs_input'
              ? 'idle'
              : current.state,
        );
      }
      _rescheduleApprovalExpiry();
      notifyListeners();
    } on Object {
      // Compatibility with older bridges which only emitted live approvals.
    }
  }

  Future<void> _loadUserInputs([BridgeTransport? expectedTransport]) async {
    final transport = expectedTransport ?? _requireTransport();
    if (_transport != transport) return;
    final hostId = activeHost?.hostId;
    final revisionAtStart = _userInputRevision;
    try {
      final result =
          await transport.request('user_input.list', const <String, Object?>{});
      if (_transport != transport ||
          activeHost?.hostId != hostId ||
          _userInputRevision != revisionAtStart) {
        return;
      }
      final loaded = jsonList(result['requests'])
          .map(UserInputRequest.fromJson)
          .toList(growable: false);
      final affectedSessionIds = <String>{
        ...userInputs.values.map((request) => request.sessionId),
        ...loaded.map((request) => request.sessionId),
      };
      userInputs
        ..clear()
        ..addEntries(
            loaded.map((request) => MapEntry(request.requestId, request)));
      _userInputRevision += 1;
      for (final sessionId in affectedSessionIds) {
        final current =
            sessions.where((session) => session.id == sessionId).firstOrNull;
        if (current == null) continue;
        _reconcileLocalAttentionState(
          sessionId,
          fallbackState: current.state == 'needs_approval' ||
                  current.state == 'needs_input'
              ? 'idle'
              : current.state,
        );
      }
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
      Future<void>? historyRefresh;
      final visibleSessionId = _visibleSessionId;
      if (visibleSessionId != null) {
        historyRefresh = _refreshVisibleSessionHistory(visibleSessionId);
      } else if (replay?.replayGap == true) {
        final selected = selectedSession;
        if (selected != null && selected.hostId == hostId) {
          historyRefresh = _loadSessionHistory(
            selected,
            notifyOnComplete: false,
            expectedTransport: transport,
          );
        }
      }
      // Start the open conversation and interaction-critical snapshots now.
      // Provider catalogues must never hold the visible chat behind them.
      final criticalRefresh = Future.wait(<Future<void>>[
        if (historyRefresh != null) historyRefresh,
        _loadQueuedMessages(transport),
        _loadApprovals(transport),
        _loadUserInputs(transport),
      ]);
      final refreshed = await _refreshWithTransport(
        transport,
        showProgress: false,
        loadProviders: false,
      );
      await criticalRefresh;
      if (!refreshed) return;
      if (!isCurrent()) return;
      await Future.wait(<Future<void>>[
        _loadSideChats(expectedTransport: transport),
        _loadDelegations(transport),
        _loadDictationSources(transport),
      ]);
      if (!isCurrent()) return;
      error = null;
      notifyListeners();
      unawaited(_refreshSecondaryForegroundState(
        transport,
        hostId,
        transportEpoch,
      ));
    } on Object catch (caught) {
      if (isCurrent()) {
        error = _connectionError(caught, fallback: _computerReconnectError);
        notifyListeners();
      }
    }
  }

  Future<void> _refreshSecondaryForegroundState(
    BridgeTransport transport,
    String hostId,
    int transportEpoch,
  ) async {
    bool isCurrent() =>
        _transport == transport &&
        activeHost?.hostId == hostId &&
        _transportEpoch == transportEpoch;
    if (!isCurrent()) return;
    try {
      await _loadProviders(transport);
    } on Object {
      // Conversation recovery already completed. Keep the last catalogue
      // until a later refresh instead of delaying the foreground surface.
    }
    if (!isCurrent()) return;
    final selected = selectedSession;
    final selectedProvider = selected?.providerId ??
        (providers.any((provider) =>
                provider.providerId == selectedProviderId && provider.detected)
            ? selectedProviderId
            : null);
    final providerIds = <String>{
      ..._modelLoadFailures.where((providerId) => providers.any((provider) =>
          provider.providerId == providerId && provider.detected)),
      if (selectedProvider != null) selectedProvider,
    };
    _invalidateVisionStatuses();
    notifyListeners();
    final refreshes = <Future<void>>[
      ...providerIds.map((providerId) => loadModels(
            providerId,
            force: true,
            surfaceErrors: false,
          ).then((_) {})),
      if (selectedProvider != null)
        loadWallet(
          selectedProvider,
          modelId: selected?.modelId,
          force: true,
        ).then((_) {}),
      _refreshSelectedVisionStatus(transport, hostId, transportEpoch),
    ];
    try {
      await Future.wait(refreshes);
    } on Object {
      // These additive surfaces refresh quietly after chat is already usable.
    }
  }

  @visibleForTesting
  void applyEventForTesting(AgentEvent event) => _applyEvent(event);

  void _applyEvent(AgentEvent event) {
    var syncVisibleHistory = false;
    var approvalRequestIsActive = false;
    final eventSessionId = event.sessionId;
    if (eventSessionId != null) {
      _liveSessionRevisions[eventSessionId] =
          (_liveSessionRevisions[eventSessionId] ?? 0) + 1;
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
      final reportedState = optionalString(event.payload, 'state');
      final clearsAttention = event.type == 'agent.completed' ||
          event.type == 'agent.error' ||
          event.type == 'agent.interrupted' ||
          event.type == 'message.started' ||
          event.type == 'tool.started' ||
          event.type == 'command.started' ||
          ((event.type == 'session.status_changed' ||
                  event.type == 'session.updated') &&
              reportedState != null &&
              reportedState != 'needs_approval' &&
              reportedState != 'needs_input');
      if (clearsAttention) {
        approvals
            .removeWhere((_, approval) => approval.sessionId == eventSessionId);
        userInputs
            .removeWhere((_, request) => request.sessionId == eventSessionId);
        // Even an empty local map may have an older list request in flight.
        // Advance both revisions so that response cannot resurrect a card the
        // provider has already moved past.
        _approvalRevision += 1;
        _userInputRevision += 1;
        _rescheduleApprovalExpiry();
      }
    }
    if (eventSessionId != null &&
        (event.type == 'agent.completed' ||
            event.type == 'agent.error' ||
            event.type == 'agent.interrupted')) {
      if (event.type == 'agent.completed') {
        _commitLiveAssistant(event);
      } else {
        _clearLiveAssistant(eventSessionId);
      }
    }
    if (event.type == 'message.queued' ||
        event.type == 'message.queue_updated') {
      final parsed = RemoteQueuedMessage.fromJson(event.payload);
      final message = _retainQueuedAttachmentPreviews(
        parsed,
        queuedMessages[parsed.id]?.attachments ??
            const <RemoteQueuedAttachment>[],
      );
      queuedMessages[message.id] = message;
      _queuedRevision += 1;
    } else if (event.type == 'message.queue_removed') {
      final messageId = optionalString(event.payload, 'messageId');
      if (messageId != null) {
        queuedMessages.remove(messageId);
        _queuedRevision += 1;
      }
    }
    if (eventSessionId != null &&
        event.type == 'session.goal_updated' &&
        event.payload['goal'] is Map<Object?, Object?>) {
      final goal = SessionGoal.fromJson(event.payload['goal']);
      final currentRevision = goalsBySession[eventSessionId]?.revision ?? -1;
      final clearedThrough = _goalClearRevisions[eventSessionId] ?? -1;
      if (goal.revision >= currentRevision && goal.revision > clearedThrough)
        goalsBySession[eventSessionId] = goal;
    } else if (eventSessionId != null && event.type == 'session.goal_cleared') {
      final rawRevision = event.payload['revision'];
      if (rawRevision is! num ||
          !rawRevision.isFinite ||
          rawRevision != rawRevision.roundToDouble() ||
          rawRevision < 0) {
        return;
      }
      final revision = rawRevision.toInt();
      if (revision >= (goalsBySession[eventSessionId]?.revision ?? -1) &&
          revision > (_goalClearRevisions[eventSessionId] ?? -1)) {
        goalsBySession.remove(eventSessionId);
        _goalClearRevisions[eventSessionId] = revision;
      }
    }
    if (eventSessionId != null &&
        event.type == 'session.vision_updated' &&
        event.payload['vision'] is Map<Object?, Object?>) {
      final status = VisionProxyStatus.fromJson(event.payload['vision']);
      if (status.sessionId == eventSessionId) {
        _visionStatusGenerations[eventSessionId] =
            (_visionStatusGenerations[eventSessionId] ?? 0) + 1;
        _clearVisionStatusFailure(eventSessionId);
        visionBySession[eventSessionId] = status;
      }
    }
    if (event.type == 'provider.connected' ||
        event.type == 'provider.disconnected' ||
        event.type == 'session.catalog_changed') {
      _invalidateVisionProxyTargets();
    }
    if ((event.type == 'side_chat.created' ||
            event.type == 'side_chat.updated' ||
            event.type == 'side_chat.promoted') &&
        event.payload['session'] is Map<Object?, Object?>) {
      final sideChat = RemoteSession.fromJson(event.payload['session']);
      if (event.type == 'side_chat.promoted') {
        sessions.removeWhere((session) => session.id == sideChat.id);
      }
      _upsertSession(sideChat.copyWith(
        sessionKind: event.type == 'side_chat.promoted' ? 'task' : 'side_chat',
      ));
      _sideChatRevision += 1;
    }
    if (event.type == 'delegation.started' ||
        event.type == 'delegation.updated' ||
        event.type == 'delegation.completed' ||
        event.type == 'delegation.failed') {
      final task = _remoteDelegationTaskFromJson(event.payload);
      if (!_delegationIsMobileCompatible(task)) {
        return;
      }
      delegations[task.id] = task;
      if ((event.type == 'delegation.started' ||
              event.type == 'delegation.updated') &&
          task.children.any(_delegationChildHasSession)) {
        unawaited(loadChildSessions(task.parentSessionId)
            .catchError((Object _) => childSessionsFor(task.parentSessionId)));
      }
    }
    if (event.type == 'approval.requested' &&
        event.payload['approval'] is Map<Object?, Object?>) {
      _approvalRevision += 1;
      final approval = ApprovalRequest.fromJson(event.payload['approval']);
      if (_isMobileProviderEnabled(approval.providerId) &&
          !approval.isExpired()) {
        approvals[approval.requestId] = approval;
        approvalRequestIsActive = true;
      } else {
        approvals.remove(approval.requestId);
      }
      _rescheduleApprovalExpiry();
    } else if (event.type == 'approval.resolved') {
      _approvalRevision += 1;
      final requestId = optionalString(event.payload, 'requestId');
      if (requestId != null) approvals.remove(requestId);
      _rescheduleApprovalExpiry();
    } else if (event.type == 'user_input.requested' &&
        event.payload['userInput'] is Map<Object?, Object?>) {
      _userInputRevision += 1;
      final request = UserInputRequest.fromJson(event.payload['userInput']);
      userInputs[request.requestId] = request;
    } else if (event.type == 'user_input.resolved') {
      _userInputRevision += 1;
      final requestId = optionalString(event.payload, 'requestId');
      if (requestId != null) userInputs.remove(requestId);
    }
    final sessionId = event.sessionId;
    if (sessionId != null) {
      final index = sessions.indexWhere((session) => session.id == sessionId);
      if (index >= 0) {
        final current = sessions[index];
        _projectLiveMessageEvent(event);
        final statusState = optionalString(event.payload, 'state');
        final state = switch (event.type) {
          'session.status_changed' ||
          'session.updated'
              when statusState != null &&
                  _sessionStates.contains(statusState) =>
            statusState,
          'approval.requested' when approvalRequestIsActive => 'needs_approval',
          'approval.requested'
              when current.state == 'needs_approval' &&
                  !approvals.values
                      .any((approval) => approval.sessionId == sessionId) =>
            'idle',
          'approval.resolved' =>
            approvals.values.any((approval) => approval.sessionId == sessionId)
                ? 'needs_approval'
                : userInputs.values
                        .any((request) => request.sessionId == sessionId)
                    ? 'needs_input'
                    : current.state == 'needs_approval'
                        ? 'working'
                        : current.state,
          'user_input.requested' => 'needs_input',
          'user_input.resolved' =>
            approvals.values.any((approval) => approval.sessionId == sessionId)
                ? 'needs_approval'
                : userInputs.values
                        .any((request) => request.sessionId == sessionId)
                    ? 'needs_input'
                    : optionalString(event.payload, 'reason') == 'expired'
                        ? 'idle'
                        : current.state == 'needs_input'
                            ? 'working'
                            : current.state,
          'agent.error' => 'failed',
          'agent.completed' => 'completed',
          'agent.interrupted' => 'idle',
          'message.started' ||
          'message.delta' ||
          'tool.started' ||
          'command.started' =>
            'working',
          _ => current.state,
        };
        sessions[index] = current.copyWith(
          state: state,
          lastActivityAt: event.occurredAt,
          needsApproval: state == 'needs_approval',
          modelId: optionalString(event.payload, 'modelId'),
          reasoningEffort: optionalString(event.payload, 'reasoningEffort'),
          variantId: optionalString(event.payload, 'variantId'),
          parentSessionId: event.type.startsWith('delegation.')
              ? null
              : optionalString(event.payload, 'parentSessionId'),
          agentNickname: optionalString(event.payload, 'agentNickname'),
          agentRole: optionalString(event.payload, 'agentRole'),
          externalWriter: event.payload['externalWriter'] is bool
              ? event.payload['externalWriter']! as bool
              : null,
        );
        if (_modelUseEventTypes.contains(event.type)) {
          _recordRecentModelUse(
            sessions[index].providerId,
            sessions[index].modelId,
            event.occurredAt,
          );
        }
        if (selectedSession?.id == sessionId) {
          selectedSession = sessions[index];
        }
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
            (event.type == 'message.remote_received' ||
                (event.type == 'message.completed' &&
                    event.payload['requiresHistoryRefresh'] == true) ||
                event.type == 'agent.completed' ||
                event.type == 'agent.error' ||
                event.type == 'agent.interrupted' ||
                (event.type == 'session.status_changed' &&
                    current.state == 'working' &&
                    state == 'idle'));
      }
    }
    _notifyForEvent(event.type);
    if (event.sessionId != null &&
        (event.type == 'context.compaction_started' ||
            event.type == 'context.compaction_completed' ||
            event.type == 'context.compaction_failed')) {
      final sessionId = event.sessionId!;
      final context = contextBySession[sessionId];
      if (context != null) {
        final active = event.type == 'context.compaction_started';
        contextBySession[sessionId] = SessionContextState(
          sessionId: context.sessionId,
          modelId: context.modelId,
          usedTokens: context.usedTokens,
          contextWindowTokens: context.contextWindowTokens,
          usedPercent: context.usedPercent,
          compactionThresholdTokens: context.compactionThresholdTokens,
          minimumThresholdTokens: context.minimumThresholdTokens,
          supportsManualCompaction: context.supportsManualCompaction,
          supportsThreshold: context.supportsThreshold,
          isCompacting: active,
          compactionKind: active
              ? (event.payload['kind'] == 'automatic' ? 'automatic' : 'manual')
              : null,
          updatedAt: event.occurredAt,
          usage: context.usage,
        );
      }
      if (event.type != 'context.compaction_started') {
        final message = RemoteMessage(
          id: 'compaction-${event.eventId}',
          sessionId: sessionId,
          role: 'system',
          createdAt: event.occurredAt,
          parts: <ContentPart>[
            ContentPart(type: 'text', data: <String, Object?>{
              'text': event.type == 'context.compaction_completed'
                  ? 'Session compacted'
                  : 'Compaction could not be completed. You can try again.',
            }),
          ],
          status: 'completed',
        );
        final current =
            messages.putIfAbsent(sessionId, () => <RemoteMessage>[]);
        if (!current.any((candidate) => candidate.id == message.id)) {
          current.add(message);
          current
              .sort((left, right) => left.createdAt.compareTo(right.createdAt));
        }
      }
      unawaited(_refreshSessionContextQuietly(sessionId));
    }
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
    // This is a separate persisted image, not completion of the model's text.
    if (event.payload['tethoqPresentedImage'] == true) return;
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
      final reasoning = _payloadLooksLikeReasoning(event.payload) ||
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
      presentationId:
          existing >= 0 ? history[existing].presentationId : messageId,
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
        presentationId: live.presentationId,
      ));
    }
    _clearLiveAssistant(sessionId);
  }

  bool _clearLiveAssistant(String sessionId) {
    _liveAssistantSnapshots.remove(sessionId);
    final textRemoved = _liveAssistantText.remove(sessionId) != null;
    final reasoningRemoved = _liveAssistantReasoning.remove(sessionId) != null;
    final startedAtRemoved = _liveAssistantStartedAt.remove(sessionId) != null;
    return textRemoved || reasoningRemoved || startedAtRemoved;
  }

  Future<void> _syncVisibleSessionHistory(String sessionId) async {
    await _refreshVisibleSessionHistory(
      sessionId,
      delay: const Duration(milliseconds: 250),
    );
  }

  Future<void> refreshVisibleSessionHistory(String sessionId) async {
    await _refreshVisibleSessionHistory(sessionId);
  }

  Future<void> _refreshVisibleSessionHistory(
    String sessionId, {
    Duration delay = Duration.zero,
  }) async {
    if (_visibleSessionId != sessionId || !_historySyncs.add(sessionId)) return;
    final cacheGeneration = _hostSessionCacheGeneration;
    final hostId = activeHost?.hostId;
    try {
      if (delay > Duration.zero) await Future<void>.delayed(delay);
      if (_visibleSessionId != sessionId) return;
      final index =
          sessions.indexWhere((candidate) => candidate.id == sessionId);
      if (index >= 0) await _loadSessionHistory(sessions[index], refresh: true);
    } catch (_) {
      // Live events remain visible if the provider snapshot is briefly unavailable.
    } finally {
      if (_hostSessionCacheGeneration == cacheGeneration &&
          activeHost?.hostId == hostId) {
        _historySyncs.remove(sessionId);
      }
    }
  }

  RemoteSession _preserveLiveSessionFields(
      RemoteSession snapshot, RemoteSession live) {
    return RemoteSession(
      id: snapshot.id,
      hostId: snapshot.hostId,
      providerId: snapshot.providerId,
      providerSessionId: snapshot.providerSessionId,
      title: snapshot.title,
      state: live.state,
      lastActivityAt: live.lastActivityAt,
      needsApproval: live.needsApproval,
      stale: snapshot.stale,
      project: snapshot.project,
      workingDirectory: snapshot.workingDirectory,
      preview: snapshot.preview,
      modelId: live.modelId,
      reasoningEffort: live.reasoningEffort,
      variantId: live.variantId,
      parentSessionId: snapshot.parentSessionId,
      agentNickname: snapshot.agentNickname,
      agentRole: snapshot.agentRole,
      relationship: snapshot.relationship,
      contextHandoffSummary: snapshot.contextHandoffSummary,
      sessionKind: snapshot.sessionKind,
      externalWriter: live.externalWriter,
    );
  }

  bool _upsertSession(RemoteSession session) {
    if (!_isMobileProviderEnabled(session.providerId)) return false;
    final activeHostId = activeHost?.hostId;
    if (activeHostId != null && session.hostId != activeHostId) return false;
    final lengthBeforeHostCleanup = sessions.length;
    sessions.removeWhere(
        (item) => item.id == session.id && item.hostId != session.hostId);
    var changed = sessions.length != lengthBeforeHostCleanup;
    final index = sessions.indexWhere(
        (item) => item.id == session.id && item.hostId == session.hostId);
    late RemoteSession stored;
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
      if (_remoteSessionsEquivalent(current, stored)) {
        stored = current;
      } else {
        sessions[index] = stored;
        changed = true;
      }
      final selected = selectedSession;
      if (selected?.id == session.id &&
          selected?.hostId == session.hostId &&
          !_remoteSessionsEquivalent(selected!, stored)) {
        selectedSession = stored;
        changed = true;
      }
    } else {
      stored = session;
      sessions.add(session);
      changed = true;
    }
    final summary = stored.contextHandoffSummary;
    if (summary?.isNotEmpty == true) {
      if (handoffSummaries[session.id] != summary) {
        handoffSummaries[session.id] = summary!;
        changed = true;
      }
    }
    return changed;
  }

  bool _eventMarksUnread(AgentEvent event, String state) =>
      _unreadEventTypes.contains(event.type) ||
      (event.type == 'session.status_changed' && _sessionCanBeUnread(state));

  Future<bool> _loadSessionReadState(
    PairedHost host, {
    required bool Function() isCurrent,
  }) async {
    final state = await security.readSessionReadState(host);
    if (!isCurrent() || activeHost?.hostId != host.hostId) return false;
    _lastReadAt
      ..clear()
      ..addAll(state?.lastReadAt ?? const <String, DateTime>{});
    unreadSessionIds
      ..clear()
      ..addAll(state?.unreadSessionIds ?? const <String>{});
    _hasReadState = state != null;
    _visibleSessionId = null;
    _visibleSessionOwners.clear();
    return true;
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

  _TransportOrigin _captureTransportOrigin({String? sessionId}) {
    final transport = _requireTransport();
    final hostId = activeHost?.hostId;
    if (hostId == null) {
      throw StateError('No computer is connected');
    }
    if (sessionId != null &&
        _sessionForContextRequest(sessionId, hostId) == null) {
      throw StateError('That task is no longer on the active host');
    }
    return _TransportOrigin(transport: transport, hostId: hostId);
  }

  bool _transportOriginIsCurrent(_TransportOrigin origin) =>
      _transport == origin.transport && activeHost?.hostId == origin.hostId;

  void _requireTransportOrigin(
    _TransportOrigin origin, {
    String action = 'the action was pending',
  }) {
    if (!_transportOriginIsCurrent(origin)) {
      throw StateError('The active host changed while $action');
    }
  }

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
    final eventSubscription = _eventSubscription;
    final stateSubscription = _stateSubscription;
    final replayGapSubscription = _replayGapSubscription;
    final transport = _transport;
    _transport = null;
    connectionState = BridgeConnectionState.disconnected;
    await _eventSubscription?.cancel();
    if (identical(_eventSubscription, eventSubscription)) {
      _eventSubscription = null;
    }
    await _stateSubscription?.cancel();
    if (identical(_stateSubscription, stateSubscription)) {
      _stateSubscription = null;
    }
    await _replayGapSubscription?.cancel();
    if (identical(_replayGapSubscription, replayGapSubscription)) {
      _replayGapSubscription = null;
    }
    await transport?.close();
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

String _historyImageCacheKey(
  String hostId,
  String sessionId,
  String retrievalId,
) =>
    '$hostId\u0000$sessionId\u0000$retrievalId';

RemoteMessage _copyRemoteMessage(
  RemoteMessage message, {
  List<ContentPart>? parts,
  String? presentationId,
}) {
  return RemoteMessage(
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    createdAt: message.createdAt,
    parts: parts ?? message.parts,
    status: message.status,
    presentationId: presentationId ?? message.presentationId,
    editable: message.editable,
    providerMessageId: message.providerMessageId,
    origin: message.origin,
  );
}

RemoteMessage _remoteMessageWithParts(
  RemoteMessage message,
  List<ContentPart> parts,
) =>
    _copyRemoteMessage(message, parts: parts);

RemoteMessage _remoteMessageWithPresentationId(
  RemoteMessage message,
  String presentationId,
) =>
    message.presentationId == presentationId
        ? message
        : _copyRemoteMessage(message, presentationId: presentationId);

void _adoptLocalAssistantPresentations(
  List<RemoteMessage> snapshot,
  List<RemoteMessage> local,
) {
  final localPresentations =
      local.where(_isLocalSettledAssistantPresentation).toList(growable: false);
  if (localPresentations.isEmpty) return;

  final claimedLocalIndexes = <int>{};
  final claimedSnapshotIndexes = <int>{};

  void adopt(int localIndex, int snapshotIndex) {
    snapshot[snapshotIndex] = _remoteMessageWithPresentationId(
      snapshot[snapshotIndex],
      localPresentations[localIndex].presentationId,
    );
    claimedLocalIndexes.add(localIndex);
    claimedSnapshotIndexes.add(snapshotIndex);
  }

  for (var localIndex = 0;
      localIndex < localPresentations.length;
      localIndex += 1) {
    final localMessage = localPresentations[localIndex];
    for (var snapshotIndex = 0;
        snapshotIndex < snapshot.length;
        snapshotIndex += 1) {
      if (claimedSnapshotIndexes.contains(snapshotIndex)) continue;
      final candidate = snapshot[snapshotIndex];
      if (!_isSettledAssistant(candidate) ||
          !_messagesShareCanonicalIdentity(localMessage, candidate)) {
        continue;
      }
      adopt(localIndex, snapshotIndex);
      break;
    }
  }

  final knownLocalIds = <String>{};
  for (final message in local) {
    if (!_isSettledAssistant(message) ||
        _isLocalSettledAssistantPresentation(message)) {
      continue;
    }
    knownLocalIds.add(message.id);
    final providerMessageId = message.providerMessageId;
    if (providerMessageId != null) knownLocalIds.add(providerMessageId);
  }

  List<int> compatibleSnapshotIndexes(
    RemoteMessage localMessage, {
    String? content,
  }) {
    final matches = <int>[];
    for (var snapshotIndex = 0;
        snapshotIndex < snapshot.length;
        snapshotIndex += 1) {
      if (claimedSnapshotIndexes.contains(snapshotIndex)) continue;
      final candidate = snapshot[snapshotIndex];
      if (!_isSettledAssistant(candidate) ||
          _messageHasKnownIdentity(candidate, knownLocalIds) ||
          !_assistantPresentationTimesCompatible(localMessage, candidate)) {
        continue;
      }
      if (content != null &&
          _assistantPresentationContent(candidate) != content) {
        continue;
      }
      matches.add(snapshotIndex);
    }
    return matches;
  }

  final contentMatchesByLocal = <int, List<int>>{};
  final contentMatchesBySnapshot = <int, List<int>>{};
  for (var localIndex = 0;
      localIndex < localPresentations.length;
      localIndex += 1) {
    if (claimedLocalIndexes.contains(localIndex)) continue;
    final localMessage = localPresentations[localIndex];
    final content = _assistantPresentationContent(localMessage);
    if (content == null) continue;
    final matches = compatibleSnapshotIndexes(
      localMessage,
      content: content,
    );
    if (matches.isEmpty) continue;
    contentMatchesByLocal[localIndex] = matches;
    for (final snapshotIndex in matches) {
      contentMatchesBySnapshot
          .putIfAbsent(snapshotIndex, () => <int>[])
          .add(localIndex);
    }
  }
  final uniqueContentPairs = <(int, int)>[
    for (final entry in contentMatchesByLocal.entries)
      if (entry.value.length == 1 &&
          contentMatchesBySnapshot[entry.value.single]?.length == 1)
        (entry.key, entry.value.single),
  ];
  for (final pair in uniqueContentPairs) {
    adopt(pair.$1, pair.$2);
  }

  final unmatchedLocalIndexes = <int>[
    for (var index = 0; index < localPresentations.length; index += 1)
      if (!claimedLocalIndexes.contains(index)) index,
  ];
  if (unmatchedLocalIndexes.length != 1) return;
  final localIndex = unmatchedLocalIndexes.single;
  final localMessage = localPresentations[localIndex];
  if (!_hasPrimaryAssistantPresentationContent(localMessage)) return;
  final matches = compatibleSnapshotIndexes(localMessage)
      .where((snapshotIndex) =>
          _hasPrimaryAssistantPresentationContent(snapshot[snapshotIndex]))
      .toList(growable: false);
  if (matches.length == 1) adopt(localIndex, matches.single);
}

bool _isSettledAssistant(RemoteMessage message) =>
    message.role.toLowerCase() == 'assistant' && message.status != 'streaming';

bool _isLocalSettledAssistantPresentation(RemoteMessage message) =>
    _isSettledAssistant(message) && message.presentationId != message.id;

bool _messagesShareCanonicalIdentity(
  RemoteMessage left,
  RemoteMessage right,
) {
  final leftProviderId = left.providerMessageId;
  final rightProviderId = right.providerMessageId;
  return left.id == right.id ||
      left.id == rightProviderId ||
      leftProviderId == right.id ||
      (leftProviderId != null && leftProviderId == rightProviderId);
}

bool _assistantPresentationTimesCompatible(
  RemoteMessage local,
  RemoteMessage canonical,
) {
  final earliest = local.createdAt.subtract(
    _assistantPresentationClockSkewAllowance,
  );
  final latest = local.createdAt.add(_assistantPresentationTimeTolerance);
  return !canonical.createdAt.isBefore(earliest) &&
      !canonical.createdAt.isAfter(latest);
}

bool _hasPrimaryAssistantPresentationContent(RemoteMessage message) =>
    message.parts.any((part) =>
        (part.type == 'text' || part.type == 'error') &&
        part.summary.trim().isNotEmpty);

String? _assistantPresentationContent(RemoteMessage message) {
  if (message.role.toLowerCase() != 'assistant') return null;
  final primary = message.parts
      .where((part) => part.type == 'text' || part.type == 'error')
      .map((part) => part.summary.trim())
      .where((content) => content.isNotEmpty)
      .toList(growable: false);
  final content = (primary.isNotEmpty
          ? primary
          : message.parts
              .where((part) => !part.isAttachment)
              .map((part) => part.summary.trim())
              .where((value) => value.isNotEmpty))
      .join('\n')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return content.isEmpty ? null : content;
}

Set<String> _adoptedOptimisticUserEchoes(
  List<RemoteMessage> snapshot,
  List<RemoteMessage> local,
  Set<String> optimisticMessageIds,
) {
  if (optimisticMessageIds.isEmpty) return const <String>{};
  final optimisticMessages = local
      .where((message) => optimisticMessageIds.contains(message.id))
      .toList(growable: false);
  if (optimisticMessages.isEmpty) return const <String>{};

  final adopted = <String>{};
  final claimedSnapshotIndexes = <int>{};
  for (final optimistic in optimisticMessages) {
    for (var index = 0; index < snapshot.length; index += 1) {
      if (claimedSnapshotIndexes.contains(index)) continue;
      final candidate = snapshot[index];
      if (candidate.role != 'user') continue;
      if (candidate.id == optimistic.id ||
          candidate.providerMessageId == optimistic.id) {
        snapshot[index] = _remoteMessageWithPresentationId(
          candidate,
          optimistic.presentationId,
        );
        adopted.add(optimistic.id);
        claimedSnapshotIndexes.add(index);
        break;
      }
    }
  }

  final knownLocalIdsByContent = <String, Set<String>>{};
  for (final message in local) {
    if (optimisticMessageIds.contains(message.id)) continue;
    final content = _userEchoContent(message);
    if (content == null) continue;
    final ids = knownLocalIdsByContent.putIfAbsent(content, () => <String>{});
    ids.add(message.id);
    final providerMessageId = message.providerMessageId;
    if (providerMessageId != null) ids.add(providerMessageId);
  }

  for (final optimistic in optimisticMessages) {
    if (adopted.contains(optimistic.id)) continue;
    final content = _userEchoContent(optimistic);
    if (content == null) continue;
    final knownLocalIds = knownLocalIdsByContent[content] ?? const <String>{};
    var knownPromptBoundary = -1;
    for (var index = 0; index < snapshot.length; index += 1) {
      final candidate = snapshot[index];
      if (_userEchoContent(candidate) == content &&
          _messageHasKnownIdentity(candidate, knownLocalIds)) {
        knownPromptBoundary = index;
      }
    }

    int? bestIndex;
    int? bestDelta;
    for (var index = knownPromptBoundary + 1;
        index < snapshot.length;
        index += 1) {
      if (claimedSnapshotIndexes.contains(index)) continue;
      final candidate = snapshot[index];
      if (_userEchoContent(candidate) != content ||
          _messageHasKnownIdentity(candidate, knownLocalIds)) {
        continue;
      }
      final earliest =
          optimistic.createdAt.subtract(_optimisticEchoClockSkewAllowance);
      final latest = optimistic.createdAt.add(_optimisticEchoTimeTolerance);
      if (candidate.createdAt.isBefore(earliest) ||
          candidate.createdAt.isAfter(latest)) {
        continue;
      }
      final delta = candidate.createdAt
          .difference(optimistic.createdAt)
          .abs()
          .inMicroseconds;
      if (bestDelta == null ||
          delta < bestDelta ||
          (delta == bestDelta &&
              candidate.createdAt.isAfter(snapshot[bestIndex!].createdAt))) {
        bestIndex = index;
        bestDelta = delta;
      }
    }
    if (bestIndex != null) {
      snapshot[bestIndex] = _remoteMessageWithPresentationId(
        snapshot[bestIndex],
        optimistic.presentationId,
      );
      claimedSnapshotIndexes.add(bestIndex);
      adopted.add(optimistic.id);
    }
  }
  return adopted;
}

String? _userEchoContent(RemoteMessage message) {
  if (message.role != 'user') return null;
  final content = message.parts
      .where((part) => part.type == 'text')
      .map((part) => part.summary)
      .join('\n')
      .replaceAll('\r\n', '\n')
      .trim();
  return content.isEmpty ? null : content;
}

bool _messageHasKnownIdentity(RemoteMessage message, Set<String> knownIds) {
  if (knownIds.contains(message.id)) return true;
  final providerMessageId = message.providerMessageId;
  return providerMessageId != null && knownIds.contains(providerMessageId);
}

List<RemoteMessage> _preserveEquivalentMessageIdentity(
  List<RemoteMessage>? previous,
  List<RemoteMessage> next,
) {
  if (previous == null) return next;
  final previousById = <String, RemoteMessage>{
    for (final message in previous) message.id: message,
  };
  final reconciled = next.map((message) {
    final existing = previousById[message.id];
    final presented = existing == null
        ? message
        : _remoteMessageWithPresentationId(
            message,
            existing.presentationId,
          );
    return existing != null && _remoteMessagesEquivalent(existing, presented)
        ? existing
        : presented;
  }).toList(growable: false);
  if (previous.length == reconciled.length) {
    var unchanged = true;
    for (var index = 0; index < previous.length; index += 1) {
      if (!identical(previous[index], reconciled[index])) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return previous;
  }
  return reconciled;
}

bool _remoteMessagesEquivalent(RemoteMessage left, RemoteMessage right) {
  if (left.id != right.id ||
      left.sessionId != right.sessionId ||
      left.role != right.role ||
      !left.createdAt.isAtSameMomentAs(right.createdAt) ||
      left.status != right.status ||
      left.presentationId != right.presentationId ||
      left.editable != right.editable ||
      left.providerMessageId != right.providerMessageId ||
      !_remoteMessageOriginsEquivalent(left.origin, right.origin) ||
      left.parts.length != right.parts.length) {
    return false;
  }
  for (var index = 0; index < left.parts.length; index += 1) {
    final leftPart = left.parts[index];
    final rightPart = right.parts[index];
    if (leftPart.type != rightPart.type ||
        !_deepValueEquals(leftPart.data, rightPart.data)) {
      return false;
    }
  }
  return true;
}

bool _remoteMessageOriginsEquivalent(
  RemoteMessageOrigin? left,
  RemoteMessageOrigin? right,
) {
  if (identical(left, right)) return true;
  if (left == null || right == null) return false;
  return left.kind == right.kind &&
      left.sourceSessionId == right.sourceSessionId &&
      left.sourceTitle == right.sourceTitle &&
      left.envelopeId == right.envelopeId;
}

bool _deepValueEquals(Object? left, Object? right) {
  if (identical(left, right)) return true;
  if (left is Map<Object?, Object?> && right is Map<Object?, Object?>) {
    if (left.length != right.length) return false;
    for (final key in left.keys) {
      if (!right.containsKey(key) || !_deepValueEquals(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  if (left is List<Object?> && right is List<Object?>) {
    if (left.length != right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (!_deepValueEquals(left[index], right[index])) return false;
    }
    return true;
  }
  return left == right;
}

bool _remoteSessionsEquivalent(RemoteSession left, RemoteSession right) {
  return left.id == right.id &&
      left.hostId == right.hostId &&
      left.providerId == right.providerId &&
      left.providerSessionId == right.providerSessionId &&
      left.title == right.title &&
      left.state == right.state &&
      left.lastActivityAt.isAtSameMomentAs(right.lastActivityAt) &&
      left.needsApproval == right.needsApproval &&
      left.stale == right.stale &&
      left.externalWriter == right.externalWriter &&
      left.project == right.project &&
      left.workingDirectory == right.workingDirectory &&
      left.preview == right.preview &&
      left.modelId == right.modelId &&
      left.reasoningEffort == right.reasoningEffort &&
      left.variantId == right.variantId &&
      left.parentSessionId == right.parentSessionId &&
      left.agentNickname == right.agentNickname &&
      left.agentRole == right.agentRole &&
      _sessionRelationshipsEquivalent(left.relationship, right.relationship) &&
      left.contextHandoffSummary == right.contextHandoffSummary &&
      left.sessionKind == right.sessionKind;
}

bool _sessionRelationshipsEquivalent(
  SessionRelationship? left,
  SessionRelationship? right,
) {
  if (identical(left, right)) return true;
  if (left == null || right == null) return false;
  return left.kind == right.kind &&
      left.sourceSessionId == right.sourceSessionId &&
      left.strategy == right.strategy;
}

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
    var presentationId = onlyArtifacts
        ? message.presentationId
        : '${message.presentationId}-artifacts';
    if (!knownIds.add(id)) {
      final suffix = message.createdAt.microsecondsSinceEpoch;
      id = '$id-$suffix';
      presentationId = '$presentationId-$suffix';
      if (!knownIds.add(id)) continue;
    }
    merged.add(RemoteMessage(
      id: id,
      sessionId: message.sessionId,
      role: 'assistant',
      createdAt: message.createdAt,
      parts: artifactParts,
      status: message.status,
      presentationId: presentationId,
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
  for (final key in const <String>[
    'text',
    'thought',
    'thinking',
    'delta',
    'output',
    'message'
  ]) {
    final value = payload[key];
    if (value is String && value.isNotEmpty) return value;
  }
  for (final key in const <String>['reasoning', 'content', 'item', 'parts']) {
    final text = _nestedMessageText(payload[key]);
    if (text.isNotEmpty) return text;
  }
  return '';
}

bool _payloadLooksLikeReasoning(Map<String, Object?> payload) {
  final partType = optionalString(payload, 'partType')?.toLowerCase();
  if (partType == 'reasoning' ||
      partType == 'thought' ||
      partType == 'thinking') {
    return true;
  }
  if (payload.containsKey('reasoning')) return true;
  if (payload['thought'] == true ||
      payload['isThought'] == true ||
      payload['isThinking'] == true) {
    return true;
  }
  for (final key in const <String>['thought', 'thinking']) {
    final value = payload[key];
    if (value is String && value.isNotEmpty) return true;
  }
  final content = payload['content'];
  if (content is! Map<Object?, Object?>) return false;
  for (final key in const <String>['sessionUpdate', 'session_update', 'type']) {
    final value = content[key];
    if (value is String &&
        (value.toLowerCase().contains('thought') ||
            value.toLowerCase().contains('thinking') ||
            value.toLowerCase().contains('reason'))) {
      return true;
    }
  }
  final nested = content['content'];
  if (nested is Map<Object?, Object?>) {
    final nestedType = nested['type'];
    if (nestedType is String) {
      final type = nestedType.toLowerCase();
      if (type == 'thought' || type == 'thinking' || type == 'reasoning') {
        return true;
      }
    }
  }
  return false;
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
    for (final key in const <String>[
      'text',
      'thought',
      'thinking',
      'delta',
      'output',
      'message'
    ]) {
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
