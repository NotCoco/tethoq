import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/draft_journal.dart';

void main() {
  late Directory root;
  late List<int> key;
  late DateTime now;
  late DraftJournal journal;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('tethoq-draft-journal-');
    key = List<int>.generate(32, (index) => index + 1);
    now = DateTime.utc(2026, 9, 2, 12, 34, 56);
    journal = DraftJournal(
      root: root,
      keyProvider: StaticDraftJournalKeyProvider(key),
      clock: () => now,
    );
  });

  tearDown(() async {
    if (await root.exists()) await root.delete(recursive: true);
  });

  test('round trips complete metadata and lazily encrypted separate blobs',
      () async {
    final first = Uint8List.fromList(<int>[1, 2, 3, 4, 5]);
    final second = Uint8List.fromList(<int>[9, 8, 7]);
    final dictation = Uint8List.fromList(<int>[82, 73, 70, 70, 1, 0]);

    final written = await journal.save(DraftJournalWrite(
      hostId: 'host-a',
      sessionId: 'session-a',
      revision: 7,
      text: 'unfinished private composition',
      simplify: const DraftJournalSimplifyState(
        maxWords: 120,
        guidance: 'Keep the examples.',
      ),
      preparedTask: const DraftJournalPreparedTaskState(
        providerId: 'codex',
        workingDirectory: r'C:\work',
        modelId: 'gpt-5.6-sol',
        reasoningEffort: 'high',
        creationAcknowledged: true,
      ),
      delegationSelections: const <DraftJournalDelegationSelectionState>[
        DraftJournalDelegationSelectionState(
          providerId: 'codex',
          modelId: 'gpt-5.6-sol',
          reasoningEffort: 'high',
        ),
        DraftJournalDelegationSelectionState(
          providerId: 'grok',
          modelId: 'grok-code-fast-1',
        ),
      ],
      attachments: <DraftJournalBlobInput>[
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.attachment,
          name: 'first.bin',
          mimeType: 'application/octet-stream',
          bytes: first,
          origin: 'picker',
        ),
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.attachment,
          name: 'second.bin',
          mimeType: 'application/octet-stream',
          bytes: second,
        ),
      ],
      retainedDictations: <DraftJournalBlobInput>[
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.retainedDictation,
          name: 'dictation.wav',
          mimeType: 'audio/wav',
          bytes: dictation,
          origin: 'recording',
          sourceId: 'direct-audio',
          directAudio: true,
        ),
      ],
    ));

    expect(written.revision, 7);
    expect(written.updatedAt, now);
    expect(written.attachments.map((item) => item.name),
        <String>['first.bin', 'second.bin']);
    expect(written.retainedDictations.single.name, 'dictation.wav');
    expect(written.retainedDictations.single.origin, 'recording');
    expect(written.retainedDictations.single.sourceId, 'direct-audio');
    expect(written.retainedDictations.single.directAudio, isTrue);

    final files = await _files(root);
    expect(files.where((file) => _basename(file.path).startsWith('blob-')),
        hasLength(3));
    expect(files.where((file) => _basename(file.path).startsWith('entry-')),
        hasLength(1));
    for (final file in files) {
      final raw = await file.readAsBytes();
      expect(raw.take(4), <int>[0x54, 0x44, 0x4a, 0x31]);
      expect(utf8.decode(raw, allowMalformed: true),
          isNot(contains('unfinished private composition')));
    }

    final restarted = DraftJournal(
      root: root,
      keyProvider: StaticDraftJournalKeyProvider(key),
    );
    final recovered = await restarted.read('host-a', 'session-a');
    expect(recovered, isNotNull);
    expect(recovered!.text, 'unfinished private composition');
    expect(recovered.simplify!.maxWords, 120);
    expect(recovered.simplify!.guidance, 'Keep the examples.');
    expect(recovered.preparedTask!.providerId, 'codex');
    expect(recovered.preparedTask!.workingDirectory, r'C:\work');
    expect(recovered.preparedTask!.modelId, 'gpt-5.6-sol');
    expect(recovered.preparedTask!.reasoningEffort, 'high');
    expect(recovered.preparedTask!.creationAcknowledged, isTrue);
    expect(
      recovered.delegationSelections.map((selection) => selection.providerId),
      <String>['codex', 'grok'],
    );
    expect(recovered.delegationSelections.first.modelId, 'gpt-5.6-sol');
    expect(recovered.delegationSelections.first.reasoningEffort, 'high');
    expect(recovered.attachments.map((item) => item.name),
        <String>['first.bin', 'second.bin']);
    expect(recovered.retainedDictations.single.origin, 'recording');
    expect(recovered.retainedDictations.single.sourceId, 'direct-audio');
    expect(recovered.retainedDictations.single.directAudio, isTrue);
    final restoredDictationJson = recovered.retainedDictations.single.toJson();
    expect(restoredDictationJson['origin'], 'recording');
    expect(restoredDictationJson['sourceId'], 'direct-audio');
    expect(restoredDictationJson['directAudio'], isTrue);
    expect(restoredDictationJson, isNot(contains('autoSubmit')));
    expect(restoredDictationJson, isNot(contains('sendAfterDictation')));
    expect(await restarted.hydrateBlob(recovered.attachments[0]), first);
    expect(await restarted.hydrateBlob(recovered.attachments[1]), second);
    expect(
      await restarted.hydrateBlob(recovered.retainedDictations.single),
      dictation,
    );
  });

  test('keeps host and session namespaces isolated and lists one host',
      () async {
    await journal.save(_textWrite('host-a', 'same-session', 1, 'alpha'));
    await journal.save(_textWrite('host-b', 'same-session', 1, 'bravo'));
    await journal.save(_textWrite('host-a', 'another-session', 2, 'charlie'));

    expect((await journal.read('host-a', 'same-session'))!.text, 'alpha');
    expect((await journal.read('host-b', 'same-session'))!.text, 'bravo');
    final hostDrafts = await journal.readHost('host-a');
    expect(hostDrafts.map((entry) => entry.sessionId).toSet(),
        <String>{'same-session', 'another-session'});
    expect(hostDrafts.every((entry) => entry.hostId == 'host-a'), isTrue);
  });

  test(
      'host tombstone suppresses crash leftovers and reactivation stays isolated',
      () async {
    final removed = await journal.save(_blobWrite(
      hostId: 'host-a',
      sessionId: 'removed-session',
      revision: 1,
      text: 'private removed draft',
      bytes: <int>[1, 2, 3],
    ));
    final kept = await journal.save(_blobWrite(
      hostId: 'host-b',
      sessionId: 'kept-session',
      revision: 1,
      text: 'other computer draft',
      bytes: <int>[4, 5, 6],
    ));
    final backup =
        await Directory.systemTemp.createTemp('tethoq-deleted-host-backup-');
    addTearDown(() async {
      if (await backup.exists()) await backup.delete(recursive: true);
    });
    await _copyDirectory(
      Directory('${root.path}${Platform.pathSeparator}entries'),
      Directory('${backup.path}${Platform.pathSeparator}entries'),
    );

    await journal.deleteHost('host-a');
    // Recreate the pre-delete entry directories to model a crash or partial
    // cleanup after the durable host marker was committed.
    await _copyDirectory(
      Directory('${backup.path}${Platform.pathSeparator}entries'),
      Directory('${root.path}${Platform.pathSeparator}entries'),
    );

    final restarted = DraftJournal(
      root: root,
      keyProvider: StaticDraftJournalKeyProvider(key),
    );
    expect(await restarted.read('host-a', 'removed-session'), isNull);
    expect(await restarted.readHost('host-a'), isEmpty);
    expect((await restarted.read('host-b', 'kept-session'))!.text,
        'other computer draft');
    expect(
      await _blobFile(root, kept.attachments.single.blobId).exists(),
      isTrue,
    );
    await expectLater(
      restarted.save(
          _textWrite('host-a', 'removed-session', 2, 'stale resurrection')),
      throwsStateError,
    );

    await restarted.reactivateHost('host-a');
    await restarted.save(
      _textWrite('host-a', 'new-session', 1, 'genuine re-paired draft'),
    );

    expect(await restarted.read('host-a', 'removed-session'), isNull);
    expect((await restarted.read('host-a', 'new-session'))!.text,
        'genuine re-paired draft');
    expect((await restarted.read('host-b', 'kept-session'))!.text,
        'other computer draft');
    expect(
      await _blobFile(root, removed.attachments.single.blobId).exists(),
      isFalse,
    );
  });

  test('does not allow a stale or duplicate revision to roll back a draft',
      () async {
    await journal.save(_textWrite('host', 'session', 3, 'newest'));
    final stale = await journal.save(
      _textWrite('host', 'session', 2, 'must not replace it'),
    );
    final duplicate = await journal.save(
      _textWrite('host', 'session', 3, 'also must not replace it'),
    );

    expect(stale.revision, 3);
    expect(stale.text, 'newest');
    expect(duplicate.text, 'newest');
    expect((await journal.read('host', 'session'))!.text, 'newest');
    expect(
      (await _files(root))
          .where((file) => _basename(file.path).startsWith('entry-')),
      hasLength(1),
    );
  });

  test('falls back to the previous atomic revision after entry corruption',
      () async {
    await journal.save(_textWrite('host', 'session', 1, 'safe previous text'));
    await journal.save(_textWrite('host', 'session', 2, 'new text'));
    final entries = (await _files(root))
        .where((file) => _basename(file.path).startsWith('entry-'))
        .toList();
    expect(entries, hasLength(2));
    final latest = entries.singleWhere(
      (file) => _basename(file.path).startsWith('entry-${_padded(2)}-'),
    );
    final bytes = await latest.readAsBytes();
    bytes[bytes.length - 1] ^= 0xff;
    await latest.writeAsBytes(bytes, flush: true);

    final restarted = DraftJournal(
      root: root,
      keyProvider: StaticDraftJournalKeyProvider(key),
    );
    final recovered = await restarted.read('host', 'session');
    expect(recovered!.revision, 1);
    expect(recovered.text, 'safe previous text');
  });

  test('malformed optional metadata preserves text and valid ordered items',
      () {
    final tooLongSourceId = List<String>.filled(81, 'x').join();
    final parsed = DraftJournalEntry.fromJson(<String, Object?>{
      'schema': DraftJournalEntry.schema,
      'version': DraftJournalEntry.version,
      'hostId': 'host',
      'sessionId': 'session',
      'revision': 4,
      'updatedAt': now.toIso8601String(),
      'text': 'keep me',
      'simplify': <String, Object?>{'maxWords': 'broken'},
      'delegationSelections': <Object?>[
        <String, Object?>{
          'providerId': 'codex',
          'modelId': 'gpt-5.6-sol',
          'reasoningEffort': 'high',
        },
        <String, Object?>{'providerId': ''},
        <String, Object?>{'providerId': 'CODEX', 'modelId': 'duplicate'},
        <String, Object?>{'providerId': 'grok'},
      ],
      'attachments': <Object?>[
        <String, Object?>{
          ..._blobJson('abcdefghijklmnopqrstuv', 'one.txt'),
          'origin': 'picker',
          'sourceId': 42,
          'directAudio': 'yes',
          'autoSubmit': true,
        },
        <String, Object?>{'blobId': '../escape'},
        <String, Object?>{
          ..._blobJson('zyxwvutsrqponmlkjihgfe', 'two.txt'),
          'sourceId': tooLongSourceId,
          'directAudio': false,
        },
      ],
      'retainedDictations': <Object?>[
        <String, Object?>{
          ..._blobJson(
            'mmmmmmmmmmmmmmmmmmmmmm',
            'retained.wav',
            kind: 'retained_dictation',
          ),
          'origin': 'recording-origin',
          'sourceId': <String>['invalid'],
          'directAudio': 1,
          'sendAfterDictation': true,
        },
      ],
    });

    expect(parsed.text, 'keep me');
    expect(parsed.simplify, isNull);
    expect(
      parsed.delegationSelections.map((selection) => selection.providerId),
      <String>['codex', 'grok'],
    );
    expect(parsed.attachments.map((item) => item.name),
        <String>['one.txt', 'two.txt']);
    expect(parsed.attachments.first.origin, 'picker');
    expect(parsed.attachments.every((item) => item.sourceId == null), isTrue);
    expect(parsed.attachments.every((item) => !item.directAudio), isTrue);
    expect(parsed.retainedDictations.single.name, 'retained.wav');
    expect(parsed.retainedDictations.single.origin, 'recording-origin');
    expect(parsed.retainedDictations.single.sourceId, isNull);
    expect(parsed.retainedDictations.single.directAudio, isFalse);
    final reserialized = parsed.toJson();
    expect(jsonEncode(reserialized), isNot(contains('autoSubmit')));
    expect(jsonEncode(reserialized), isNot(contains('sendAfterDictation')));
  });

  test('rejects invalid source IDs before any journal entry is committed',
      () async {
    await expectLater(
      journal.save(DraftJournalWrite(
        hostId: 'host',
        sessionId: 'session',
        revision: 1,
        text: 'keep in memory',
        retainedDictations: <DraftJournalBlobInput>[
          DraftJournalBlobInput.fromBytes(
            kind: DraftJournalBlobKind.retainedDictation,
            name: 'dictation.wav',
            mimeType: 'audio/wav',
            bytes: <int>[1, 2, 3],
            sourceId: ' source-with-spaces ',
          ),
        ],
      )),
      throwsArgumentError,
    );
    expect(await journal.read('host', 'session'), isNull);
  });

  test('one tampered or missing blob does not hide text or valid blobs',
      () async {
    final saved = await journal.save(DraftJournalWrite(
      hostId: 'host',
      sessionId: 'session',
      revision: 1,
      text: 'recover this text',
      attachments: <DraftJournalBlobInput>[
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.attachment,
          name: 'bad.bin',
          mimeType: 'application/octet-stream',
          bytes: <int>[1, 1, 1, 1],
        ),
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.attachment,
          name: 'good.bin',
          mimeType: 'application/octet-stream',
          bytes: <int>[2, 2, 2, 2],
        ),
      ],
    ));
    final damaged = _blobFile(root, saved.attachments.first.blobId);
    final damagedBytes = await damaged.readAsBytes();
    damagedBytes[damagedBytes.length - 1] ^= 0xff;
    await damaged.writeAsBytes(damagedBytes, flush: true);

    var recovered = await journal.read('host', 'session');
    expect(recovered!.text, 'recover this text');
    expect(recovered.attachments, hasLength(2));
    expect(await journal.hydrateBlob(recovered.attachments.first), isNull);
    expect(
      await journal.hydrateBlob(recovered.attachments.last),
      <int>[2, 2, 2, 2],
    );

    await damaged.delete();
    recovered = await journal.read('host', 'session');
    expect(recovered!.text, 'recover this text');
    expect(recovered.attachments.single.name, 'good.bin');
    expect(
        recovered.unavailableBlobIds, <String>[saved.attachments.first.blobId]);
  });

  test('reuses an existing encrypted blob for frequent text-only saves',
      () async {
    final first = await journal.save(DraftJournalWrite(
      hostId: 'host',
      sessionId: 'session',
      revision: 1,
      text: 'a',
      attachments: <DraftJournalBlobInput>[
        DraftJournalBlobInput.fromBytes(
          kind: DraftJournalBlobKind.attachment,
          name: 'kept.txt',
          mimeType: 'text/plain',
          bytes: utf8.encode('blob contents'),
        ),
      ],
    ));
    final second = await journal.save(DraftJournalWrite(
      hostId: 'host',
      sessionId: 'session',
      revision: 2,
      text: 'ab',
      attachments: <DraftJournalBlobInput>[
        DraftJournalBlobInput.reuse(first.attachments.single),
      ],
    ));

    expect(second.attachments.single.blobId, first.attachments.single.blobId);
    expect(
      (await _files(root))
          .where((file) => _basename(file.path).startsWith('blob-')),
      hasLength(1),
    );
    expect(
      utf8.decode((await journal.hydrateBlob(second.attachments.single))!),
      'blob contents',
    );
  });

  test('explicit delete removes only the acknowledged or discarded draft',
      () async {
    final removed = await journal.save(_blobWrite(
      hostId: 'host',
      sessionId: 'remove',
      revision: 1,
      text: 'sent',
      bytes: <int>[1, 2, 3],
    ));
    final kept = await journal.save(_blobWrite(
      hostId: 'host',
      sessionId: 'keep',
      revision: 1,
      text: 'still drafting',
      bytes: <int>[4, 5, 6],
    ));

    expect(await journal.delete('host', 'remove'), isTrue);
    expect(await journal.delete('host', 'remove'), isFalse);
    expect(await journal.read('host', 'remove'), isNull);
    expect((await journal.read('host', 'keep'))!.text, 'still drafting');
    expect(await _blobFile(root, removed.attachments.single.blobId).exists(),
        isFalse);
    expect(
        await _blobFile(root, kept.attachments.single.blobId).exists(), isTrue);
  });

  test('revision-matched delete removes the current persisted draft', () async {
    await journal.save(_textWrite('host', 'session', 4, 'acknowledged'));

    expect(
      await journal.delete('host', 'session', expectedRevision: 4),
      isTrue,
    );
    expect(await journal.read('host', 'session'), isNull);
  });

  test('revision-mismatched delete preserves the newer persisted draft',
      () async {
    final saved = await journal.save(_blobWrite(
      hostId: 'host',
      sessionId: 'session',
      revision: 5,
      text: 'newer typing',
      bytes: <int>[4, 5, 6],
    ));

    expect(
      await journal.delete('host', 'session', expectedRevision: 4),
      isFalse,
    );
    final recovered = await journal.read('host', 'session');
    expect(recovered!.revision, 5);
    expect(recovered.text, 'newer typing');
    expect(
      await _blobFile(root, saved.attachments.single.blobId).exists(),
      isTrue,
    );
  });

  test('queued newer save wins before a stale revision-matched delete',
      () async {
    await journal.save(_textWrite('host', 'session', 1, 'submitted'));

    final newerSave =
        journal.save(_textWrite('host', 'session', 2, 'typed meanwhile'));
    final staleDelete = journal.delete('host', 'session', expectedRevision: 1);

    expect((await newerSave).revision, 2);
    expect(await staleDelete, isFalse);
    final recovered = await journal.read('host', 'session');
    expect(recovered!.revision, 2);
    expect(recovered.text, 'typed meanwhile');
  });

  test('orphan cleanup keeps every referenced entry and removes leftovers',
      () async {
    final saved = await journal.save(_blobWrite(
      hostId: 'host',
      sessionId: 'session',
      revision: 1,
      text: 'draft',
      bytes: <int>[7, 7, 7],
    ));
    const orphanId = 'AAAAAAAAAAAAAAAAAAAAAA';
    final orphan = _blobFile(root, orphanId);
    await orphan.writeAsBytes(List<int>.filled(40, 9), flush: true);
    final entryFile = (await _files(root))
        .singleWhere((file) => _basename(file.path).startsWith('entry-'));
    final temporary = File(
      '${entryFile.parent.path}${Platform.pathSeparator}.interrupted.tmp-leftover',
    );
    await temporary.writeAsBytes(<int>[1, 2, 3], flush: true);

    final result = await journal.cleanupOrphans();
    expect(result.skippedBlobDeletion, isFalse);
    expect(result.deletedBlobCount, 1);
    expect(result.deletedTemporaryCount, 1);
    expect(await orphan.exists(), isFalse);
    expect(await temporary.exists(), isFalse);
    expect(
      await _blobFile(root, saved.attachments.single.blobId).exists(),
      isTrue,
    );
    expect((await journal.read('host', 'session'))!.text, 'draft');
  });

  test('cleanup preserves the previous revision needed for crash fallback',
      () async {
    final previous = await journal.save(_blobWrite(
      hostId: 'host',
      sessionId: 'session',
      revision: 1,
      text: 'previous with attachment',
      bytes: <int>[5, 4, 3, 2, 1],
    ));
    await journal.save(_textWrite('host', 'session', 2, 'current without it'));

    final cleanup = await journal.cleanupOrphans();
    expect(cleanup.skippedBlobDeletion, isFalse);
    expect(
      await _blobFile(root, previous.attachments.single.blobId).exists(),
      isTrue,
    );

    final latestEntry = (await _files(root)).singleWhere(
      (file) => _basename(file.path).startsWith('entry-${_padded(2)}-'),
    );
    final encrypted = await latestEntry.readAsBytes();
    encrypted[encrypted.length - 1] ^= 0xff;
    await latestEntry.writeAsBytes(encrypted, flush: true);

    final recovered = await journal.read('host', 'session');
    expect(recovered!.revision, 1);
    expect(recovered.text, 'previous with attachment');
    expect(
      await journal.hydrateBlob(recovered.attachments.single),
      <int>[5, 4, 3, 2, 1],
    );
  });

  test('orphan cleanup fails closed when an entry reference is unknowable',
      () async {
    final saved = await journal.save(_blobWrite(
      hostId: 'host',
      sessionId: 'session',
      revision: 1,
      text: 'draft',
      bytes: <int>[3, 2, 1],
    ));
    final entry = (await _files(root))
        .singleWhere((file) => _basename(file.path).startsWith('entry-'));
    await entry.writeAsBytes(<int>[0, 1, 2], flush: true);
    const orphanId = 'BBBBBBBBBBBBBBBBBBBBBB';
    final orphan = _blobFile(root, orphanId);
    await orphan.writeAsBytes(List<int>.filled(40, 8), flush: true);

    final result = await journal.cleanupOrphans();
    expect(result.skippedBlobDeletion, isTrue);
    expect(result.deletedBlobCount, 0);
    expect(await orphan.exists(), isTrue);
    expect(
      await _blobFile(root, saved.attachments.single.blobId).exists(),
      isTrue,
    );
  });

  test('requires an independent key containing exactly 32 bytes', () async {
    final invalid = DraftJournal(
      root: root,
      keyProvider: StaticDraftJournalKeyProvider(List<int>.filled(31, 1)),
    );
    await expectLater(
      invalid.save(_textWrite('host', 'session', 1, 'text')),
      throwsA(isA<StateError>()),
    );
  });
}

DraftJournalWrite _textWrite(
  String hostId,
  String sessionId,
  int revision,
  String text,
) {
  return DraftJournalWrite(
    hostId: hostId,
    sessionId: sessionId,
    revision: revision,
    text: text,
  );
}

DraftJournalWrite _blobWrite({
  required String hostId,
  required String sessionId,
  required int revision,
  required String text,
  required List<int> bytes,
}) {
  return DraftJournalWrite(
    hostId: hostId,
    sessionId: sessionId,
    revision: revision,
    text: text,
    attachments: <DraftJournalBlobInput>[
      DraftJournalBlobInput.fromBytes(
        kind: DraftJournalBlobKind.attachment,
        name: 'attachment.bin',
        mimeType: 'application/octet-stream',
        bytes: bytes,
      ),
    ],
  );
}

Map<String, Object?> _blobJson(
  String id,
  String name, {
  String kind = 'attachment',
}) =>
    <String, Object?>{
      'blobId': id,
      'kind': kind,
      'name': name,
      'mimeType': 'text/plain',
      'byteLength': 10,
    };

Future<List<File>> _files(Directory root) async {
  if (!await root.exists()) return <File>[];
  return root
      .list(recursive: true, followLinks: false)
      .where((entity) => entity is File)
      .cast<File>()
      .toList();
}

Future<void> _copyDirectory(Directory source, Directory target) async {
  await target.create(recursive: true);
  await for (final entity in source.list(followLinks: false)) {
    final destination =
        '${target.path}${Platform.pathSeparator}${_basename(entity.path)}';
    if (entity is Directory) {
      await _copyDirectory(entity, Directory(destination));
    } else if (entity is File) {
      final targetFile = File(destination);
      if (!await targetFile.exists()) await entity.copy(destination);
    }
  }
}

File _blobFile(Directory root, String blobId) => File(
      '${root.path}${Platform.pathSeparator}blobs${Platform.pathSeparator}blob-$blobId.gcm',
    );

String _basename(String path) => path.split(Platform.pathSeparator).last;

String _padded(int value) => value.toString().padLeft(20, '0');
