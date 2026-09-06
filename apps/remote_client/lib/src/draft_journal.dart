import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Supplies the app-specific 256-bit key used only by the draft journal.
///
/// Production wiring can load this key from [FlutterSecureStorage] without
/// coupling the journal or its tests to a particular secure-storage plugin.
abstract interface class DraftJournalKeyProvider {
  Future<List<int>> loadKey();
}

class CallbackDraftJournalKeyProvider implements DraftJournalKeyProvider {
  const CallbackDraftJournalKeyProvider(this.callback);

  final Future<List<int>> Function() callback;

  @override
  Future<List<int>> loadKey() => callback();
}

class StaticDraftJournalKeyProvider implements DraftJournalKeyProvider {
  StaticDraftJournalKeyProvider(List<int> key) : _key = List<int>.of(key);

  final List<int> _key;

  @override
  Future<List<int>> loadKey() async => List<int>.of(_key);
}

enum DraftJournalBlobKind {
  attachment,
  retainedDictation,
}

class DraftJournalSimplifyState {
  const DraftJournalSimplifyState({required this.maxWords, this.guidance});

  final int maxWords;
  final String? guidance;

  Map<String, Object?> toJson() => <String, Object?>{
        'maxWords': maxWords,
        if (guidance != null) 'guidance': guidance,
      };

  static DraftJournalSimplifyState? fromJson(Object? value) {
    if (value == null) return null;
    if (value is! Map<Object?, Object?>) {
      throw const FormatException('Draft simplify state is invalid');
    }
    final maxWords = value['maxWords'];
    final guidance = value['guidance'];
    if (maxWords is! int || maxWords <= 0 || maxWords > 1000000) {
      throw const FormatException('Draft simplify word limit is invalid');
    }
    if (guidance != null && guidance is! String) {
      throw const FormatException('Draft simplify guidance is invalid');
    }
    return DraftJournalSimplifyState(
      maxWords: maxWords,
      guidance: guidance as String?,
    );
  }
}

/// Everything needed to reopen an unsent, not-yet-created task after the
/// operating system kills the mobile app.
class DraftJournalPreparedTaskState {
  const DraftJournalPreparedTaskState({
    required this.providerId,
    required this.workingDirectory,
    this.modelId,
    this.reasoningEffort,
    this.creationAcknowledged = false,
  });

  final String providerId;
  final String workingDirectory;
  final String? modelId;
  final String? reasoningEffort;
  final bool creationAcknowledged;

  Map<String, Object?> toJson() => <String, Object?>{
        'providerId': providerId,
        'workingDirectory': workingDirectory,
        if (modelId != null) 'modelId': modelId,
        if (reasoningEffort != null) 'reasoningEffort': reasoningEffort,
        'creationAcknowledged': creationAcknowledged,
      };

  static DraftJournalPreparedTaskState? fromJson(Object? value) {
    if (value == null) return null;
    if (value is! Map<Object?, Object?>) {
      throw const FormatException('Prepared draft task is invalid');
    }
    final providerId = _safeMetadataValue(
      value['providerId'],
      name: 'prepared draft provider',
      isRequired: true,
      maximumLength: 256,
    )!;
    final workingDirectory = _safeMetadataValue(
      value['workingDirectory'],
      name: 'prepared draft directory',
      isRequired: true,
      maximumLength: 4096,
      allowEmpty: true,
    )!;
    final creationAcknowledged = value['creationAcknowledged'];
    if (creationAcknowledged != null && creationAcknowledged is! bool) {
      throw const FormatException('Prepared draft acknowledgement is invalid');
    }
    return DraftJournalPreparedTaskState(
      providerId: providerId,
      workingDirectory: workingDirectory,
      modelId: _safeMetadataValue(
        value['modelId'],
        name: 'prepared draft model',
        maximumLength: 1024,
      ),
      reasoningEffort: _safeMetadataValue(
        value['reasoningEffort'],
        name: 'prepared draft reasoning effort',
        maximumLength: 256,
      ),
      creationAcknowledged: creationAcknowledged == true,
    );
  }
}

/// Serializable `/mesh` target metadata kept independent of UI model types.
class DraftJournalDelegationSelectionState {
  const DraftJournalDelegationSelectionState({
    required this.providerId,
    this.modelId,
    this.reasoningEffort,
  });

  final String providerId;
  final String? modelId;
  final String? reasoningEffort;

  Map<String, Object?> toJson() => <String, Object?>{
        'providerId': providerId,
        if (modelId != null) 'modelId': modelId,
        if (reasoningEffort != null) 'reasoningEffort': reasoningEffort,
      };

  static DraftJournalDelegationSelectionState fromJson(Object? value) {
    if (value is! Map<Object?, Object?>) {
      throw const FormatException('Draft delegation selection is invalid');
    }
    return DraftJournalDelegationSelectionState(
      providerId: _safeMetadataValue(
        value['providerId'],
        name: 'draft delegation provider',
        isRequired: true,
        maximumLength: 256,
      )!,
      modelId: _safeMetadataValue(
        value['modelId'],
        name: 'draft delegation model',
        maximumLength: 1024,
      ),
      reasoningEffort: _safeMetadataValue(
        value['reasoningEffort'],
        name: 'draft delegation reasoning effort',
        maximumLength: 256,
      ),
    );
  }
}

/// Metadata for one separately encrypted binary blob.
///
/// No binary data is loaded while a journal entry is recovered. Call
/// [DraftJournal.hydrateBlob] for only the attachment the UI or sender needs.
class DraftJournalBlob {
  const DraftJournalBlob({
    required this.blobId,
    required this.kind,
    required this.name,
    required this.mimeType,
    required this.byteLength,
    this.origin,
    this.sourceId,
    this.directAudio = false,
  });

  final String blobId;
  final DraftJournalBlobKind kind;
  final String name;
  final String mimeType;
  final int byteLength;
  final String? origin;
  final String? sourceId;
  final bool directAudio;

  Map<String, Object?> toJson() => <String, Object?>{
        'blobId': blobId,
        'kind': _blobKindName(kind),
        'name': name,
        'mimeType': mimeType,
        'byteLength': byteLength,
        if (origin != null) 'origin': origin,
        if (sourceId != null) 'sourceId': sourceId,
        if (directAudio) 'directAudio': true,
      };

  static DraftJournalBlob fromJson(
    Object? value, {
    required DraftJournalBlobKind expectedKind,
  }) {
    if (value is! Map<Object?, Object?>) {
      throw const FormatException('Draft blob metadata is invalid');
    }
    final blobId = value['blobId'];
    final kindValue = value['kind'];
    final name = value['name'];
    final mimeType = value['mimeType'];
    final byteLength = value['byteLength'];
    final origin = value['origin'];
    final sourceId = _safeSourceId(value['sourceId']);
    final directAudio = value['directAudio'] == true;
    if (blobId is! String || !_validBlobId(blobId)) {
      throw const FormatException('Draft blob ID is invalid');
    }
    final kind = _blobKindFromName(kindValue);
    if (kind != expectedKind) {
      throw const FormatException('Draft blob kind is invalid');
    }
    if (name is! String || name.isEmpty || name.length > 1024) {
      throw const FormatException('Draft blob name is invalid');
    }
    if (mimeType is! String || mimeType.isEmpty || mimeType.length > 256) {
      throw const FormatException('Draft blob MIME type is invalid');
    }
    if (byteLength is! int || byteLength < 0 || byteLength > 0x7fffffff) {
      throw const FormatException('Draft blob byte length is invalid');
    }
    if (origin != null && origin is! String) {
      throw const FormatException('Draft blob origin is invalid');
    }
    return DraftJournalBlob(
      blobId: blobId,
      kind: kind,
      name: name,
      mimeType: mimeType,
      byteLength: byteLength,
      origin: origin as String?,
      sourceId: sourceId,
      directAudio: directAudio,
    );
  }
}

/// A new blob or a reference to a blob already owned by this journal.
///
/// Reusing metadata lets frequent text-only saves avoid reading, decrypting,
/// and re-encrypting attachment bytes.
class DraftJournalBlobInput {
  factory DraftJournalBlobInput.fromBytes({
    required DraftJournalBlobKind kind,
    required String name,
    required String mimeType,
    required List<int> bytes,
    String? origin,
    String? sourceId,
    bool directAudio = false,
  }) {
    return DraftJournalBlobInput._(
      kind: kind,
      name: name,
      mimeType: mimeType,
      bytes: Uint8List.fromList(bytes),
      origin: origin,
      sourceId: sourceId,
      directAudio: directAudio,
    );
  }

  DraftJournalBlobInput.reuse(DraftJournalBlob blob)
      : this._(
          kind: blob.kind,
          name: blob.name,
          mimeType: blob.mimeType,
          existing: blob,
          origin: blob.origin,
          sourceId: blob.sourceId,
          directAudio: blob.directAudio,
        );

  const DraftJournalBlobInput._({
    required this.kind,
    required this.name,
    required this.mimeType,
    this.bytes,
    this.existing,
    this.origin,
    this.sourceId,
    this.directAudio = false,
  });

  final DraftJournalBlobKind kind;
  final String name;
  final String mimeType;
  final Uint8List? bytes;
  final DraftJournalBlob? existing;
  final String? origin;
  final String? sourceId;
  final bool directAudio;
}

class DraftJournalWrite {
  DraftJournalWrite({
    required this.hostId,
    required this.sessionId,
    required this.revision,
    required this.text,
    this.updatedAt,
    this.simplify,
    this.preparedTask,
    Iterable<DraftJournalDelegationSelectionState> delegationSelections =
        const <DraftJournalDelegationSelectionState>[],
    Iterable<DraftJournalBlobInput> attachments =
        const <DraftJournalBlobInput>[],
    Iterable<DraftJournalBlobInput> retainedDictations =
        const <DraftJournalBlobInput>[],
  })  : delegationSelections =
            List<DraftJournalDelegationSelectionState>.unmodifiable(
                delegationSelections),
        attachments = List<DraftJournalBlobInput>.unmodifiable(attachments),
        retainedDictations =
            List<DraftJournalBlobInput>.unmodifiable(retainedDictations);

  final String hostId;
  final String sessionId;
  final int revision;
  final DateTime? updatedAt;
  final String text;
  final DraftJournalSimplifyState? simplify;
  final DraftJournalPreparedTaskState? preparedTask;
  final List<DraftJournalDelegationSelectionState> delegationSelections;
  final List<DraftJournalBlobInput> attachments;
  final List<DraftJournalBlobInput> retainedDictations;
}

class DraftJournalEntry {
  DraftJournalEntry._({
    required this.hostId,
    required this.sessionId,
    required this.revision,
    required this.updatedAt,
    required this.text,
    required this.simplify,
    required this.preparedTask,
    required Iterable<DraftJournalDelegationSelectionState>
        delegationSelections,
    required Iterable<DraftJournalBlob> attachments,
    required Iterable<DraftJournalBlob> retainedDictations,
    Iterable<String> unavailableBlobIds = const <String>[],
  })  : delegationSelections =
            List<DraftJournalDelegationSelectionState>.unmodifiable(
                delegationSelections),
        attachments = List<DraftJournalBlob>.unmodifiable(attachments),
        retainedDictations =
            List<DraftJournalBlob>.unmodifiable(retainedDictations),
        unavailableBlobIds = List<String>.unmodifiable(unavailableBlobIds);

  static const String schema = 'tethoq.mobile-draft';
  static const int version = 4;

  final String hostId;
  final String sessionId;
  final int revision;
  final DateTime updatedAt;
  final String text;
  final DraftJournalSimplifyState? simplify;
  final DraftJournalPreparedTaskState? preparedTask;
  final List<DraftJournalDelegationSelectionState> delegationSelections;
  final List<DraftJournalBlob> attachments;
  final List<DraftJournalBlob> retainedDictations;

  /// Missing or structurally truncated blobs omitted during metadata recovery.
  /// Authentication failures found during lazy hydration return `null` from
  /// [DraftJournal.hydrateBlob] and do not invalidate this entry.
  final List<String> unavailableBlobIds;

  Iterable<DraftJournalBlob> get allBlobs sync* {
    yield* attachments;
    yield* retainedDictations;
  }

  Map<String, Object?> toJson() => <String, Object?>{
        'schema': schema,
        'version': version,
        'hostId': hostId,
        'sessionId': sessionId,
        'revision': revision,
        'updatedAt': updatedAt.toUtc().toIso8601String(),
        'text': text,
        'simplify': simplify?.toJson(),
        if (preparedTask != null) 'preparedTask': preparedTask!.toJson(),
        'delegationSelections': delegationSelections
            .map((selection) => selection.toJson())
            .toList(growable: false),
        'attachments': attachments
            .map((attachment) => attachment.toJson())
            .toList(growable: false),
        'retainedDictations': retainedDictations
            .map((attachment) => attachment.toJson())
            .toList(growable: false),
      };

  static DraftJournalEntry fromJson(Object? value) {
    if (value is! Map<Object?, Object?>) {
      throw const FormatException('Draft journal entry is invalid');
    }
    final encodedVersion = value['version'];
    if (value['schema'] != schema ||
        encodedVersion is! int ||
        encodedVersion < 1 ||
        encodedVersion > version) {
      throw const FormatException('Unsupported draft journal schema');
    }
    final hostId = value['hostId'];
    final sessionId = value['sessionId'];
    final revision = value['revision'];
    final timestamp = value['updatedAt'];
    if (hostId is! String || hostId.isEmpty || hostId.length > 4096) {
      throw const FormatException('Draft host ID is invalid');
    }
    if (sessionId is! String || sessionId.isEmpty || sessionId.length > 4096) {
      throw const FormatException('Draft session ID is invalid');
    }
    if (revision is! int || revision < 0) {
      throw const FormatException('Draft revision is invalid');
    }
    if (timestamp is! String) {
      throw const FormatException('Draft timestamp is invalid');
    }
    final updatedAt = DateTime.tryParse(timestamp)?.toUtc();
    if (updatedAt == null) {
      throw const FormatException('Draft timestamp is invalid');
    }

    DraftJournalSimplifyState? simplify;
    try {
      simplify = DraftJournalSimplifyState.fromJson(value['simplify']);
    } on FormatException {
      // A malformed optional setting must not hide recoverable draft text.
    }

    DraftJournalPreparedTaskState? preparedTask;
    try {
      preparedTask =
          DraftJournalPreparedTaskState.fromJson(value['preparedTask']);
    } on FormatException {
      // Optional task metadata must not hide recoverable text or blobs.
    }

    return DraftJournalEntry._(
      hostId: hostId,
      sessionId: sessionId,
      revision: revision,
      updatedAt: updatedAt,
      text: value['text'] is String ? value['text']! as String : '',
      simplify: simplify,
      preparedTask: preparedTask,
      delegationSelections:
          _parseDelegationSelections(value['delegationSelections']),
      attachments: _parseBlobList(
        value['attachments'],
        DraftJournalBlobKind.attachment,
      ),
      retainedDictations: _parseBlobList(
        value['retainedDictations'],
        DraftJournalBlobKind.retainedDictation,
      ),
    );
  }
}

class DraftJournalCleanupResult {
  const DraftJournalCleanupResult({
    required this.deletedBlobCount,
    required this.deletedTemporaryCount,
    required this.deletedTombstoneCount,
    required this.skippedBlobDeletion,
  });

  final int deletedBlobCount;
  final int deletedTemporaryCount;
  final int deletedTombstoneCount;

  /// True when an unreadable current-format entry made its blob references
  /// unknowable. Cleanup then keeps every final blob rather than risking loss.
  final bool skippedBlobDeletion;
}

/// Process-death-safe, encrypted, per-host/session mobile draft storage.
class DraftJournal {
  DraftJournal({
    required Directory root,
    required DraftJournalKeyProvider keyProvider,
    DateTime Function()? clock,
    Random? random,
  })  : _root = root.absolute,
        _keyProvider = keyProvider,
        _clock = clock ?? DateTime.now,
        _random = random ?? Random.secure();

  static const List<int> _magic = <int>[0x54, 0x44, 0x4a, 0x31]; // TDJ1
  static const int _nonceLength = 12;
  static const int _macLength = 16;
  static const int _minimumEnvelopeLength = 4 + _nonceLength + _macLength;

  final Directory _root;
  final DraftJournalKeyProvider _keyProvider;
  final DateTime Function() _clock;
  final Random _random;
  final AesGcm _cipher = AesGcm.with256bits();
  final Sha256 _sha256 = Sha256();

  Future<SecretKey>? _secretKeyFuture;
  Future<void> _operationTail = Future<void>.value();

  Directory get _entriesRoot => Directory(_join(_root.path, 'entries'));
  Directory get _blobsRoot => Directory(_join(_root.path, 'blobs'));
  Directory get _hostTombstonesRoot =>
      Directory(_join(_root.path, 'deleted-hosts'));

  /// Writes all new blobs first and commits the encrypted metadata last.
  ///
  /// A stale or duplicate revision never overwrites a newer committed draft.
  Future<DraftJournalEntry> save(DraftJournalWrite write) =>
      _serialized(() => _saveUnlocked(write));

  Future<DraftJournalEntry?> read(String hostId, String sessionId) =>
      _serialized(() => _readUnlocked(hostId, sessionId));

  /// Recovers every current draft belonging to [hostId], newest first.
  Future<List<DraftJournalEntry>> readHost(String hostId) =>
      _serialized(() => _readHostUnlocked(hostId));

  /// Permanently suppresses every draft for [hostId] before best-effort file
  /// cleanup. The durable marker also rejects stale saves after local unpair.
  Future<void> deleteHost(String hostId) =>
      _serialized(() => _deleteHostUnlocked(hostId));

  /// Explicitly permits a genuinely re-paired host ID to own new drafts.
  /// Old entries are removed while the deletion marker is still authoritative.
  Future<void> reactivateHost(String hostId) =>
      _serialized(() => _reactivateHostUnlocked(hostId));

  /// Authenticates and decrypts just one requested blob.
  ///
  /// Missing, truncated, tampered, or length-mismatched blobs return `null` so
  /// one damaged attachment cannot prevent use of the remaining composition.
  Future<Uint8List?> hydrateBlob(DraftJournalBlob blob) async {
    if (!_validBlobId(blob.blobId)) return null;
    final file = _blobFile(blob.blobId);
    try {
      final encrypted = await file.readAsBytes();
      final plaintext = await _decrypt(
        encrypted,
        aad: _blobAad(blob.blobId, blob.kind),
      );
      if (plaintext.length != blob.byteLength) return null;
      return plaintext;
    } on FileSystemException {
      return null;
    } on _DraftJournalCorruption {
      return null;
    }
  }

  /// Removes a draft only after the caller has an acknowledged send or an
  /// explicit user discard. When [expectedRevision] is provided, deletion only
  /// proceeds if it still matches the newest persisted revision. The directory
  /// rename makes deletion durable before best-effort blob cleanup begins.
  Future<bool> delete(
    String hostId,
    String sessionId, {
    int? expectedRevision,
  }) =>
      _serialized(
        () => _deleteUnlocked(
          hostId,
          sessionId,
          expectedRevision: expectedRevision,
        ),
      );

  Future<DraftJournalCleanupResult> cleanupOrphans() =>
      _serialized(_cleanupOrphansUnlocked);

  Future<DraftJournalEntry> _saveUnlocked(DraftJournalWrite write) async {
    _validateIdentity(write.hostId, 'hostId');
    _validateIdentity(write.sessionId, 'sessionId');
    if (write.revision < 0) {
      throw ArgumentError.value(write.revision, 'revision', 'must be >= 0');
    }
    _validateSimplify(write.simplify);
    _validatePreparedTask(write.preparedTask);
    _validateDelegationSelections(write.delegationSelections);

    if (await _hostIsDeleted(write.hostId)) {
      throw StateError('Drafts for this removed computer cannot be saved');
    }

    final entryKey = await _entryKey(write.hostId, write.sessionId);
    final directory = Directory(_join(_entriesRoot.path, entryKey));
    final existing = await _currentRecord(
      directory,
      expectedHostId: write.hostId,
      expectedSessionId: write.sessionId,
    );
    if (existing != null && existing.entry.revision >= write.revision) {
      return _filterUnavailableBlobs(existing.entry);
    }

    await _blobsRoot.create(recursive: true);
    final attachments = await _persistBlobInputs(
      write.attachments,
      DraftJournalBlobKind.attachment,
    );
    final retainedDictations = await _persistBlobInputs(
      write.retainedDictations,
      DraftJournalBlobKind.retainedDictation,
    );
    final entry = DraftJournalEntry._(
      hostId: write.hostId,
      sessionId: write.sessionId,
      revision: write.revision,
      updatedAt: (write.updatedAt ?? _clock()).toUtc(),
      text: write.text,
      simplify: write.simplify,
      preparedTask: write.preparedTask,
      delegationSelections: write.delegationSelections,
      attachments: attachments,
      retainedDictations: retainedDictations,
    );

    await directory.create(recursive: true);
    final plaintext =
        Uint8List.fromList(utf8.encode(jsonEncode(entry.toJson())));
    final encrypted = await _encrypt(plaintext, aad: _entryAad(entryKey));
    final target = await _newEntryFile(directory, write.revision);
    await _atomicWrite(target, encrypted);

    final committed = await _readEntryFile(target, entryKey);
    if (committed == null ||
        committed.entry.hostId != write.hostId ||
        committed.entry.sessionId != write.sessionId ||
        committed.entry.revision != write.revision) {
      throw StateError('The draft journal commit could not be verified');
    }
    await _pruneSupersededEntries(directory, entryKey);
    return _filterUnavailableBlobs(committed.entry);
  }

  Future<DraftJournalEntry?> _readUnlocked(
    String hostId,
    String sessionId,
  ) async {
    _validateIdentity(hostId, 'hostId');
    _validateIdentity(sessionId, 'sessionId');
    if (await _hostIsDeleted(hostId)) return null;
    final entryKey = await _entryKey(hostId, sessionId);
    final directory = Directory(_join(_entriesRoot.path, entryKey));
    final current = await _currentRecord(
      directory,
      expectedHostId: hostId,
      expectedSessionId: sessionId,
    );
    return current == null ? null : _filterUnavailableBlobs(current.entry);
  }

  Future<List<DraftJournalEntry>> _readHostUnlocked(String hostId) async {
    _validateIdentity(hostId, 'hostId');
    if (await _hostIsDeleted(hostId)) {
      return const <DraftJournalEntry>[];
    }
    if (!await _entriesRoot.exists()) return const <DraftJournalEntry>[];
    final entries = <DraftJournalEntry>[];
    await for (final entity in _entriesRoot.list(followLinks: false)) {
      if (entity is! Directory || !_validEntryKey(_basename(entity.path))) {
        continue;
      }
      final record = await _currentRecord(entity);
      if (record != null && record.entry.hostId == hostId) {
        entries.add(await _filterUnavailableBlobs(record.entry));
      }
    }
    entries.sort((left, right) {
      final timestamp = right.updatedAt.compareTo(left.updatedAt);
      if (timestamp != 0) return timestamp;
      return left.sessionId.compareTo(right.sessionId);
    });
    return List<DraftJournalEntry>.unmodifiable(entries);
  }

  Future<void> _deleteHostUnlocked(String hostId) async {
    _validateIdentity(hostId, 'hostId');
    final hostKey = await _hostKey(hostId);
    final tombstone = _hostTombstoneFile(hostKey);
    if (!await tombstone.exists()) {
      final plaintext = Uint8List.fromList(utf8.encode(jsonEncode(
        <String, Object?>{
          'schema': 'tethoq.mobile-draft-host-deletion',
          'version': 1,
          'hostId': hostId,
        },
      )));
      final encrypted = await _encrypt(
        plaintext,
        aad: _hostTombstoneAad(hostKey),
      );
      await _atomicWrite(tombstone, encrypted);
      if (!await _validHostTombstone(tombstone, hostKey, hostId)) {
        throw StateError('The removed-computer marker could not be verified');
      }
    }
    await _deleteHostEntriesUnlocked(hostId);
    await _cleanupOrphansUnlocked();
  }

  Future<void> _reactivateHostUnlocked(String hostId) async {
    _validateIdentity(hostId, 'hostId');
    final hostKey = await _hostKey(hostId);
    final tombstone = _hostTombstoneFile(hostKey);
    if (!await tombstone.exists()) return;
    await _deleteHostEntriesUnlocked(hostId);
    await _cleanupOrphansUnlocked();
    await tombstone.delete();
  }

  Future<void> _deleteHostEntriesUnlocked(String hostId) async {
    if (!await _entriesRoot.exists()) return;
    final candidates = <Directory>[];
    await for (final entity in _entriesRoot.list(followLinks: false)) {
      if (entity is! Directory || !_validEntryKey(_basename(entity.path))) {
        continue;
      }
      final record = await _currentRecord(entity);
      if (record?.entry.hostId == hostId) candidates.add(entity);
    }
    for (final directory in candidates) {
      if (!await directory.exists()) continue;
      final tombstone = Directory(
        '${directory.path}.deleted-${_randomToken(12)}',
      );
      try {
        await directory.rename(tombstone.path);
      } on FileSystemException {
        if (!await directory.exists()) continue;
        rethrow;
      }
      try {
        await tombstone.delete(recursive: true);
      } on FileSystemException {
        // The host marker already suppresses reads; cleanup can finish later.
      }
    }
  }

  Future<bool> _deleteUnlocked(
    String hostId,
    String sessionId, {
    int? expectedRevision,
  }) async {
    _validateIdentity(hostId, 'hostId');
    _validateIdentity(sessionId, 'sessionId');
    if (await _hostIsDeleted(hostId)) return false;
    if (expectedRevision != null && expectedRevision < 0) {
      throw ArgumentError.value(
        expectedRevision,
        'expectedRevision',
        'must be >= 0',
      );
    }
    final entryKey = await _entryKey(hostId, sessionId);
    final directory = Directory(_join(_entriesRoot.path, entryKey));
    if (!await directory.exists()) return false;
    if (expectedRevision != null) {
      final current = await _currentRecord(
        directory,
        expectedHostId: hostId,
        expectedSessionId: sessionId,
      );
      if (current == null || current.entry.revision != expectedRevision) {
        return false;
      }
    }

    final tombstone = Directory(
      '${directory.path}.deleted-${_randomToken(12)}',
    );
    try {
      await directory.rename(tombstone.path);
    } on FileSystemException {
      if (!await directory.exists()) return false;
      rethrow;
    }
    try {
      await tombstone.delete(recursive: true);
    } on FileSystemException {
      // A later cleanup recognizes the tombstone and finishes the deletion.
    }
    await _cleanupOrphansUnlocked();
    return true;
  }

  Future<DraftJournalCleanupResult> _cleanupOrphansUnlocked() async {
    var deletedBlobs = 0;
    var deletedTemporary = 0;
    var deletedTombstones = 0;
    var uncertainReferences = false;
    final referencedBlobIds = <String>{};

    if (await _entriesRoot.exists()) {
      await for (final entity in _entriesRoot.list(followLinks: false)) {
        final name = _basename(entity.path);
        if (entity is Directory && name.contains('.deleted-')) {
          try {
            await entity.delete(recursive: true);
            deletedTombstones += 1;
          } on FileSystemException {
            // Keep it for a later cleanup attempt.
          }
          continue;
        }
        if (entity is! Directory || !_validEntryKey(name)) continue;
        final scan = await _scanEntryDirectory(entity, removeTemporaries: true);
        deletedTemporary += scan.deletedTemporaryCount;
        uncertainReferences =
            uncertainReferences || scan.unreadableCandidateCount > 0;
        for (final record in scan.records) {
          referencedBlobIds
              .addAll(record.entry.allBlobs.map((blob) => blob.blobId));
        }
      }
    }

    if (await _blobsRoot.exists()) {
      await for (final entity in _blobsRoot.list(followLinks: false)) {
        if (entity is! File) continue;
        final name = _basename(entity.path);
        if (_isTemporaryName(name)) {
          try {
            await entity.delete();
            deletedTemporary += 1;
          } on FileSystemException {
            // Keep it for a later cleanup attempt.
          }
          continue;
        }
        final match = _blobFileName.firstMatch(name);
        if (match == null || uncertainReferences) continue;
        if (referencedBlobIds.contains(match.group(1))) continue;
        try {
          await entity.delete();
          deletedBlobs += 1;
        } on FileSystemException {
          // Keep it for a later cleanup attempt.
        }
      }
    }

    return DraftJournalCleanupResult(
      deletedBlobCount: deletedBlobs,
      deletedTemporaryCount: deletedTemporary,
      deletedTombstoneCount: deletedTombstones,
      skippedBlobDeletion: uncertainReferences,
    );
  }

  Future<List<DraftJournalBlob>> _persistBlobInputs(
    List<DraftJournalBlobInput> inputs,
    DraftJournalBlobKind expectedKind,
  ) async {
    final result = <DraftJournalBlob>[];
    for (final input in inputs) {
      if (input.kind != expectedKind) {
        throw ArgumentError('A draft blob was placed in the wrong list');
      }
      _validateBlobDescription(
        input.name,
        input.mimeType,
        input.origin,
        input.sourceId,
      );
      final existing = input.existing;
      if (existing != null) {
        if (existing.kind != expectedKind ||
            existing.name != input.name ||
            existing.mimeType != input.mimeType ||
            existing.origin != input.origin ||
            existing.sourceId != input.sourceId ||
            existing.directAudio != input.directAudio ||
            !await _plausibleBlob(_blobFile(existing.blobId))) {
          throw StateError('A reused draft blob is unavailable');
        }
        result.add(existing);
        continue;
      }

      final bytes = input.bytes;
      if (bytes == null) {
        throw ArgumentError('A new draft blob requires bytes');
      }
      if (bytes.length > 0x7fffffff) {
        throw ArgumentError.value(bytes.length, 'bytes', 'is too large');
      }
      late String blobId;
      late File target;
      do {
        blobId = _randomToken(16);
        target = _blobFile(blobId);
      } while (await target.exists());
      final encrypted = await _encrypt(
        bytes,
        aad: _blobAad(blobId, expectedKind),
      );
      await _atomicWrite(target, encrypted);
      result.add(DraftJournalBlob(
        blobId: blobId,
        kind: expectedKind,
        name: input.name,
        mimeType: input.mimeType,
        byteLength: bytes.length,
        origin: input.origin,
        sourceId: input.sourceId,
        directAudio: input.directAudio,
      ));
    }
    return result;
  }

  Future<_DraftRecord?> _currentRecord(
    Directory directory, {
    String? expectedHostId,
    String? expectedSessionId,
  }) async {
    final scan = await _scanEntryDirectory(directory);
    final records = scan.records.where((record) {
      return (expectedHostId == null ||
              record.entry.hostId == expectedHostId) &&
          (expectedSessionId == null ||
              record.entry.sessionId == expectedSessionId);
    }).toList(growable: false);
    if (records.isEmpty) return null;
    final sorted = List<_DraftRecord>.of(records)
      ..sort(_compareRecordsNewestFirst);
    return sorted.first;
  }

  Future<_DraftScan> _scanEntryDirectory(
    Directory directory, {
    bool removeTemporaries = false,
  }) async {
    if (!await directory.exists()) return const _DraftScan();
    final entryKey = _basename(directory.path);
    if (!_validEntryKey(entryKey)) return const _DraftScan();
    final records = <_DraftRecord>[];
    var unreadableCandidates = 0;
    var deletedTemporary = 0;
    await for (final entity in directory.list(followLinks: false)) {
      if (entity is! File) {
        unreadableCandidates += 1;
        continue;
      }
      final name = _basename(entity.path);
      if (_isTemporaryName(name)) {
        if (removeTemporaries) {
          try {
            await entity.delete();
            deletedTemporary += 1;
          } on FileSystemException {
            // Leave it for a later cleanup.
          }
        }
        continue;
      }
      if (!_entryFileName.hasMatch(name)) {
        unreadableCandidates += 1;
        continue;
      }
      final record = await _readEntryFile(entity, entryKey);
      if (record == null) {
        unreadableCandidates += 1;
      } else {
        records.add(record);
      }
    }
    return _DraftScan(
      records: records,
      unreadableCandidateCount: unreadableCandidates,
      deletedTemporaryCount: deletedTemporary,
    );
  }

  Future<_DraftRecord?> _readEntryFile(File file, String entryKey) async {
    try {
      final encrypted = await file.readAsBytes();
      final plaintext = await _decrypt(encrypted, aad: _entryAad(entryKey));
      final decoded = jsonDecode(utf8.decode(plaintext));
      final entry = DraftJournalEntry.fromJson(decoded);
      if (await _entryKey(entry.hostId, entry.sessionId) != entryKey) {
        throw const FormatException('Draft entry is in the wrong directory');
      }
      return _DraftRecord(file: file, entry: entry);
    } on FileSystemException {
      return null;
    } on FormatException {
      return null;
    } on _DraftJournalCorruption {
      return null;
    }
  }

  Future<DraftJournalEntry> _filterUnavailableBlobs(
    DraftJournalEntry entry,
  ) async {
    final unavailable = <String>[];
    final attachments = <DraftJournalBlob>[];
    final retained = <DraftJournalBlob>[];
    for (final blob in entry.attachments) {
      if (await _plausibleBlob(_blobFile(blob.blobId))) {
        attachments.add(blob);
      } else {
        unavailable.add(blob.blobId);
      }
    }
    for (final blob in entry.retainedDictations) {
      if (await _plausibleBlob(_blobFile(blob.blobId))) {
        retained.add(blob);
      } else {
        unavailable.add(blob.blobId);
      }
    }
    return DraftJournalEntry._(
      hostId: entry.hostId,
      sessionId: entry.sessionId,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      text: entry.text,
      simplify: entry.simplify,
      preparedTask: entry.preparedTask,
      delegationSelections: entry.delegationSelections,
      attachments: attachments,
      retainedDictations: retained,
      unavailableBlobIds: unavailable,
    );
  }

  Future<void> _pruneSupersededEntries(
    Directory directory,
    String entryKey,
  ) async {
    final scan = await _scanEntryDirectory(directory);
    final records = List<_DraftRecord>.of(scan.records)
      ..sort(_compareRecordsNewestFirst);
    final keep = records.take(2).map((record) => record.file.path).toSet();
    await for (final entity in directory.list(followLinks: false)) {
      if (entity is! File) continue;
      final name = _basename(entity.path);
      if (_isTemporaryName(name)) {
        try {
          await entity.delete();
        } on FileSystemException {
          // A later cleanup can retry.
        }
        continue;
      }
      if (!_entryFileName.hasMatch(name) || keep.contains(entity.path)) {
        continue;
      }
      // A verified new entry now owns this session. Superseded or unreadable
      // files are safe to remove; their blobs remain until orphan cleanup.
      try {
        await entity.delete();
      } on FileSystemException {
        // A later save or cleanup can retry.
      }
    }
  }

  Future<File> _newEntryFile(Directory directory, int revision) async {
    File file;
    do {
      file = File(_join(
        directory.path,
        'entry-${revision.toString().padLeft(20, '0')}-${_randomToken(12)}.gcm',
      ));
    } while (await file.exists());
    return file;
  }

  Future<void> _atomicWrite(File target, List<int> bytes) async {
    await target.parent.create(recursive: true);
    final temporary = File(
      _join(target.parent.path,
          '.${_basename(target.path)}.tmp-${_randomToken(8)}'),
    );
    try {
      await temporary.writeAsBytes(bytes, flush: true);
      await temporary.rename(target.path);
    } catch (_) {
      try {
        if (await temporary.exists()) await temporary.delete();
      } on FileSystemException {
        // Preserve the original write error.
      }
      rethrow;
    }
  }

  Future<Uint8List> _encrypt(List<int> plaintext,
      {required List<int> aad}) async {
    final nonce = List<int>.generate(_nonceLength, (_) => _random.nextInt(256));
    final box = await _cipher.encrypt(
      plaintext,
      secretKey: await _secretKey(),
      nonce: nonce,
      aad: aad,
    );
    final builder = BytesBuilder(copy: false)
      ..add(_magic)
      ..add(box.nonce)
      ..add(box.mac.bytes)
      ..add(box.cipherText);
    return builder.takeBytes();
  }

  Future<Uint8List> _decrypt(List<int> envelope,
      {required List<int> aad}) async {
    if (envelope.length < _minimumEnvelopeLength) {
      throw const _DraftJournalCorruption();
    }
    for (var index = 0; index < _magic.length; index += 1) {
      if (envelope[index] != _magic[index]) {
        throw const _DraftJournalCorruption();
      }
    }
    final nonceStart = _magic.length;
    final macStart = nonceStart + _nonceLength;
    final ciphertextStart = macStart + _macLength;
    final box = SecretBox(
      envelope.sublist(ciphertextStart),
      nonce: envelope.sublist(nonceStart, macStart),
      mac: Mac(envelope.sublist(macStart, ciphertextStart)),
    );
    final key = await _secretKey();
    try {
      final plaintext = await _cipher.decrypt(box, secretKey: key, aad: aad);
      return Uint8List.fromList(plaintext);
    } catch (_) {
      throw const _DraftJournalCorruption();
    }
  }

  Future<SecretKey> _secretKey() {
    return _secretKeyFuture ??= () async {
      final bytes = await _keyProvider.loadKey();
      if (bytes.length != 32 || bytes.any((byte) => byte < 0 || byte > 255)) {
        throw StateError('Draft journal key must contain exactly 32 bytes');
      }
      return SecretKey(List<int>.of(bytes));
    }();
  }

  Future<String> _entryKey(String hostId, String sessionId) async {
    final hash = await _sha256.hash(
      utf8.encode('tethoq.mobile-draft\u0000$hostId\u0000$sessionId'),
    );
    return _base64Url(hash.bytes);
  }

  Future<String> _hostKey(String hostId) async {
    final hash = await _sha256.hash(
      utf8.encode('tethoq.mobile-draft\u0000deleted-host\u0000$hostId'),
    );
    return _base64Url(hash.bytes);
  }

  Future<bool> _hostIsDeleted(String hostId) async =>
      _hostTombstoneFile(await _hostKey(hostId)).exists();

  File _hostTombstoneFile(String hostKey) =>
      File(_join(_hostTombstonesRoot.path, 'host-$hostKey.gcm'));

  Future<bool> _validHostTombstone(
    File file,
    String hostKey,
    String expectedHostId,
  ) async {
    try {
      final encrypted = await file.readAsBytes();
      final plaintext = await _decrypt(
        encrypted,
        aad: _hostTombstoneAad(hostKey),
      );
      final value = jsonDecode(utf8.decode(plaintext));
      return value is Map<Object?, Object?> &&
          value['schema'] == 'tethoq.mobile-draft-host-deletion' &&
          value['version'] == 1 &&
          value['hostId'] == expectedHostId;
    } on FileSystemException {
      return false;
    } on FormatException {
      return false;
    } on _DraftJournalCorruption {
      return false;
    }
  }

  List<int> _entryAad(String entryKey) =>
      utf8.encode('tethoq.mobile-draft|entry|1|$entryKey');

  List<int> _hostTombstoneAad(String hostKey) =>
      utf8.encode('tethoq.mobile-draft|deleted-host|1|$hostKey');

  List<int> _blobAad(String blobId, DraftJournalBlobKind kind) => utf8.encode(
        'tethoq.mobile-draft|blob|1|${_blobKindName(kind)}|$blobId',
      );

  File _blobFile(String blobId) =>
      File(_join(_blobsRoot.path, 'blob-$blobId.gcm'));

  String _randomToken(int byteLength) {
    return _base64Url(
      List<int>.generate(byteLength, (_) => _random.nextInt(256)),
    );
  }

  Future<bool> _plausibleBlob(File file) async {
    try {
      return await file.exists() &&
          await file.length() >= _minimumEnvelopeLength;
    } on FileSystemException {
      return false;
    }
  }

  Future<T> _serialized<T>(Future<T> Function() operation) {
    final result = _operationTail.then((_) => operation());
    _operationTail = result.then<void>((_) {}, onError: (_, __) {});
    return result;
  }
}

class _DraftRecord {
  const _DraftRecord({required this.file, required this.entry});

  final File file;
  final DraftJournalEntry entry;
}

class _DraftScan {
  const _DraftScan({
    this.records = const <_DraftRecord>[],
    this.unreadableCandidateCount = 0,
    this.deletedTemporaryCount = 0,
  });

  final List<_DraftRecord> records;
  final int unreadableCandidateCount;
  final int deletedTemporaryCount;
}

class _DraftJournalCorruption implements Exception {
  const _DraftJournalCorruption();
}

final RegExp _entryFileName =
    RegExp(r'^entry-[0-9]+-[A-Za-z0-9_-]{12,100}\.gcm$');
final RegExp _blobFileName = RegExp(r'^blob-([A-Za-z0-9_-]{16,100})\.gcm$');
final RegExp _blobId = RegExp(r'^[A-Za-z0-9_-]{16,100}$');
final RegExp _entryKeyPattern = RegExp(r'^[A-Za-z0-9_-]{43}$');

bool _validBlobId(String value) => _blobId.hasMatch(value);
bool _validEntryKey(String value) => _entryKeyPattern.hasMatch(value);
bool _isTemporaryName(String value) => value.contains('.tmp-');

String _blobKindName(DraftJournalBlobKind kind) => switch (kind) {
      DraftJournalBlobKind.attachment => 'attachment',
      DraftJournalBlobKind.retainedDictation => 'retained_dictation',
    };

DraftJournalBlobKind _blobKindFromName(Object? value) => switch (value) {
      'attachment' => DraftJournalBlobKind.attachment,
      'retained_dictation' => DraftJournalBlobKind.retainedDictation,
      _ => throw const FormatException('Draft blob kind is invalid'),
    };

List<DraftJournalBlob> _parseBlobList(
  Object? value,
  DraftJournalBlobKind expectedKind,
) {
  if (value is! List<Object?>) return const <DraftJournalBlob>[];
  final result = <DraftJournalBlob>[];
  for (final item in value) {
    try {
      result.add(DraftJournalBlob.fromJson(item, expectedKind: expectedKind));
    } on FormatException {
      // Preserve every independently valid attachment and the draft text.
    }
  }
  return result;
}

List<DraftJournalDelegationSelectionState> _parseDelegationSelections(
    Object? value) {
  if (value is! List<Object?>) {
    return const <DraftJournalDelegationSelectionState>[];
  }
  final result = <DraftJournalDelegationSelectionState>[];
  final providers = <String>{};
  for (final item in value) {
    try {
      final selection = DraftJournalDelegationSelectionState.fromJson(item);
      if (!providers.add(selection.providerId.toLowerCase())) continue;
      result.add(selection);
      if (result.length == 4) break;
    } on FormatException {
      // Optional malformed targets must not hide recoverable draft text.
    }
  }
  return List<DraftJournalDelegationSelectionState>.unmodifiable(result);
}

void _validateIdentity(String value, String name) {
  if (value.isEmpty || value.length > 4096 || value.contains('\u0000')) {
    throw ArgumentError.value(value, name, 'must be a valid non-empty ID');
  }
}

void _validateSimplify(DraftJournalSimplifyState? simplify) {
  if (simplify == null) return;
  if (simplify.maxWords <= 0 || simplify.maxWords > 1000000) {
    throw ArgumentError.value(
      simplify.maxWords,
      'simplify.maxWords',
      'must be between 1 and 1000000',
    );
  }
  if (simplify.guidance != null && simplify.guidance!.length > 10000) {
    throw ArgumentError.value(
      simplify.guidance,
      'simplify.guidance',
      'must contain at most 10000 characters',
    );
  }
}

void _validatePreparedTask(DraftJournalPreparedTaskState? preparedTask) {
  if (preparedTask == null) return;
  _validateMetadataValue(
    preparedTask.providerId,
    'preparedTask.providerId',
    maximumLength: 256,
  );
  _validateMetadataValue(
    preparedTask.workingDirectory,
    'preparedTask.workingDirectory',
    maximumLength: 4096,
    allowEmpty: true,
  );
  if (preparedTask.modelId != null) {
    _validateMetadataValue(
      preparedTask.modelId!,
      'preparedTask.modelId',
      maximumLength: 1024,
    );
  }
  if (preparedTask.reasoningEffort != null) {
    _validateMetadataValue(
      preparedTask.reasoningEffort!,
      'preparedTask.reasoningEffort',
      maximumLength: 256,
    );
  }
}

void _validateDelegationSelections(
  List<DraftJournalDelegationSelectionState> selections,
) {
  if (selections.length > 4) {
    throw ArgumentError.value(
      selections.length,
      'delegationSelections',
      'must contain at most four targets',
    );
  }
  final providers = <String>{};
  for (final selection in selections) {
    _validateMetadataValue(
      selection.providerId,
      'delegationSelections.providerId',
      maximumLength: 256,
    );
    if (!providers.add(selection.providerId.toLowerCase())) {
      throw ArgumentError.value(
        selection.providerId,
        'delegationSelections.providerId',
        'must be unique',
      );
    }
    if (selection.modelId != null) {
      _validateMetadataValue(
        selection.modelId!,
        'delegationSelections.modelId',
        maximumLength: 1024,
      );
    }
    if (selection.reasoningEffort != null) {
      _validateMetadataValue(
        selection.reasoningEffort!,
        'delegationSelections.reasoningEffort',
        maximumLength: 256,
      );
    }
  }
}

void _validateMetadataValue(
  String value,
  String name, {
  required int maximumLength,
  bool allowEmpty = false,
}) {
  if ((!allowEmpty && value.trim().isEmpty) ||
      value.length > maximumLength ||
      value.contains(RegExp(r'[\u0000-\u001f\u007f]'))) {
    throw ArgumentError.value(value, name, 'is invalid');
  }
}

String? _safeMetadataValue(
  Object? value, {
  required String name,
  required int maximumLength,
  bool isRequired = false,
  bool allowEmpty = false,
}) {
  if (value == null && !isRequired) return null;
  if (value is! String ||
      (!allowEmpty && value.trim().isEmpty) ||
      value.length > maximumLength ||
      value.contains(RegExp(r'[\u0000-\u001f\u007f]'))) {
    throw FormatException('$name is invalid');
  }
  return value;
}

void _validateBlobDescription(
  String name,
  String mimeType,
  String? origin,
  String? sourceId,
) {
  if (name.isEmpty || name.length > 1024) {
    throw ArgumentError.value(name, 'name', 'must contain 1-1024 characters');
  }
  if (mimeType.isEmpty || mimeType.length > 256) {
    throw ArgumentError.value(
      mimeType,
      'mimeType',
      'must contain 1-256 characters',
    );
  }
  if (origin != null && origin.length > 4096) {
    throw ArgumentError.value(origin, 'origin', 'is too long');
  }
  if (sourceId != null && _safeSourceId(sourceId) != sourceId) {
    throw ArgumentError.value(
      sourceId,
      'sourceId',
      'must be a trimmed source ID containing 1-80 characters',
    );
  }
}

String? _safeSourceId(Object? value) {
  if (value is! String) return null;
  final normalized = value.trim();
  if (normalized.isEmpty ||
      normalized.length > 80 ||
      normalized.contains(RegExp(r'[\u0000-\u001f\u007f]'))) {
    return null;
  }
  return normalized;
}

int _compareRecordsNewestFirst(_DraftRecord left, _DraftRecord right) {
  final revision = right.entry.revision.compareTo(left.entry.revision);
  if (revision != 0) return revision;
  final timestamp = right.entry.updatedAt.compareTo(left.entry.updatedAt);
  if (timestamp != 0) return timestamp;
  return right.file.path.compareTo(left.file.path);
}

String _join(String parent, String child) =>
    '$parent${Platform.pathSeparator}$child';

String _basename(String path) => path.split(Platform.pathSeparator).last;

String _base64Url(List<int> bytes) =>
    base64UrlEncode(bytes).replaceAll('=', '');
