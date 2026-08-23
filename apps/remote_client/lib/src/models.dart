import 'json.dart';

typedef JsonMap = Map<String, Object?>;

class SessionRelationship {
  const SessionRelationship({
    required this.kind,
    required this.sourceSessionId,
    required this.strategy,
  });

  factory SessionRelationship.fromJson(Object? value) {
    final json = jsonMap(value, name: 'session relationship');
    return SessionRelationship(
      kind: requireString(json, 'kind'),
      sourceSessionId: requireString(json, 'sourceSessionId'),
      strategy: requireString(json, 'strategy'),
    );
  }

  final String kind;
  final String sourceSessionId;
  final String strategy;
}

class RemoteSession {
  const RemoteSession({
    required this.id,
    required this.hostId,
    required this.providerId,
    required this.providerSessionId,
    required this.title,
    required this.state,
    required this.lastActivityAt,
    required this.needsApproval,
    required this.stale,
    this.project,
    this.workingDirectory,
    this.preview,
    this.modelId,
    this.reasoningEffort,
    this.variantId,
    this.parentSessionId,
    this.agentNickname,
    this.agentRole,
    this.relationship,
    this.contextHandoffSummary,
    this.sessionKind = 'task',
  });

  factory RemoteSession.fromJson(Object? value) {
    final json = jsonMap(value, name: 'session');
    final nativeMetadata = json['nativeMetadata'] is Map<Object?, Object?>
        ? jsonMap(json['nativeMetadata'], name: 'session metadata')
        : const <String, Object?>{};
    final relationship = json['relationship'] is Map<Object?, Object?>
        ? SessionRelationship.fromJson(json['relationship'])
        : null;
    final declaredKind = optionalString(json, 'sessionKind') ??
        optionalString(nativeMetadata, 'sessionKind');
    return RemoteSession(
      id: requireString(json, 'id'),
      hostId: requireString(json, 'hostId'),
      providerId: requireString(json, 'providerId'),
      providerSessionId: requireString(json, 'providerSessionId'),
      title: requireString(json, 'title'),
      state: requireString(json, 'state'),
      lastActivityAt:
          DateTime.tryParse(requireString(json, 'lastActivityAt')) ??
              DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      needsApproval: json['needsApproval'] == true,
      stale: json['stale'] == true,
      project: optionalString(json, 'project'),
      workingDirectory: optionalString(json, 'workingDirectory'),
      preview: optionalString(json, 'preview'),
      modelId: optionalString(json, 'modelId'),
      reasoningEffort: optionalString(json, 'reasoningEffort'),
      variantId: optionalString(json, 'variantId'),
      parentSessionId: optionalString(json, 'parentSessionId'),
      agentNickname: optionalString(json, 'agentNickname'),
      agentRole: optionalString(json, 'agentRole'),
      relationship: relationship,
      contextHandoffSummary: optionalString(json, 'contextHandoffSummary') ??
          optionalString(nativeMetadata, 'contextHandoffSummary') ??
          optionalString(nativeMetadata, 'tethoqHandoffSummary'),
      sessionKind: declaredKind ??
          (relationship?.kind == 'side_chat' ? 'side_chat' : 'task'),
    );
  }

  RemoteSession copyWith({
    String? id,
    String? providerSessionId,
    String? title,
    String? state,
    DateTime? lastActivityAt,
    bool? needsApproval,
    bool? stale,
    String? project,
    String? workingDirectory,
    String? preview,
    String? modelId,
    String? reasoningEffort,
    String? variantId,
    String? parentSessionId,
    String? agentNickname,
    String? agentRole,
    SessionRelationship? relationship,
    String? contextHandoffSummary,
    String? sessionKind,
  }) =>
      RemoteSession(
        id: id ?? this.id,
        hostId: hostId,
        providerId: providerId,
        providerSessionId: providerSessionId ?? this.providerSessionId,
        title: title ?? this.title,
        state: state ?? this.state,
        lastActivityAt: lastActivityAt ?? this.lastActivityAt,
        needsApproval: needsApproval ?? this.needsApproval,
        stale: stale ?? this.stale,
        project: project ?? this.project,
        workingDirectory: workingDirectory ?? this.workingDirectory,
        preview: preview ?? this.preview,
        modelId: modelId ?? this.modelId,
        reasoningEffort: reasoningEffort ?? this.reasoningEffort,
        variantId: variantId ?? this.variantId,
        parentSessionId: parentSessionId ?? this.parentSessionId,
        agentNickname: agentNickname ?? this.agentNickname,
        agentRole: agentRole ?? this.agentRole,
        relationship: relationship ?? this.relationship,
        contextHandoffSummary:
            contextHandoffSummary ?? this.contextHandoffSummary,
        sessionKind: sessionKind ?? this.sessionKind,
      );

  final String id;
  final String hostId;
  final String providerId;
  final String providerSessionId;
  final String title;
  final String state;
  final DateTime lastActivityAt;
  final bool needsApproval;
  final bool stale;
  final String? project;
  final String? workingDirectory;
  final String? preview;
  final String? modelId;
  final String? reasoningEffort;
  final String? variantId;
  final String? parentSessionId;
  final String? agentNickname;
  final String? agentRole;
  final SessionRelationship? relationship;
  final String? contextHandoffSummary;
  final String sessionKind;
}

class ContextHandoffResult {
  const ContextHandoffResult({
    required this.summary,
    required this.session,
    this.prompt,
  });

  factory ContextHandoffResult.fromJson(Object? value) {
    final json = jsonMap(value, name: 'context handoff result');
    return ContextHandoffResult(
      summary: requireString(json, 'summary'),
      session: RemoteSession.fromJson(json['session']),
      prompt: optionalString(json, 'prompt'),
    );
  }

  final String summary;
  final RemoteSession session;
  final String? prompt;
}

class SessionBranchResult {
  const SessionBranchResult({
    required this.session,
    required this.strategy,
    required this.copiedMessageCount,
  });

  factory SessionBranchResult.fromJson(Object? value) {
    final json = jsonMap(value, name: 'session branch result');
    final copiedMessageCount = json['copiedMessageCount'];
    return SessionBranchResult(
      session: RemoteSession.fromJson(json['session']),
      strategy: requireString(json, 'strategy'),
      copiedMessageCount:
          copiedMessageCount is num ? copiedMessageCount.toInt() : 0,
    );
  }

  final RemoteSession session;
  final String strategy;
  final int copiedMessageCount;
}

class SessionUsageTotals {
  const SessionUsageTotals({
    this.inputTokens,
    this.outputTokens,
    this.cacheReadTokens,
    this.cacheWriteTokens,
    this.totalTokens,
    this.cost,
    this.currency,
  });

  factory SessionUsageTotals.fromJson(Object? value) {
    if (value is! Map<Object?, Object?>) return const SessionUsageTotals();
    final json = jsonMap(value, name: 'session usage');
    int? tokens(String key) =>
        json[key] is num ? (json[key]! as num).toInt() : null;
    return SessionUsageTotals(
      inputTokens: tokens('inputTokens'),
      outputTokens: tokens('outputTokens'),
      cacheReadTokens: tokens('cacheReadTokens'),
      cacheWriteTokens: tokens('cacheWriteTokens'),
      totalTokens: tokens('totalTokens'),
      cost: json['cost'] is num ? (json['cost']! as num).toDouble() : null,
      currency: optionalString(json, 'currency'),
    );
  }

  final int? inputTokens;
  final int? outputTokens;
  final int? cacheReadTokens;
  final int? cacheWriteTokens;
  final int? totalTokens;
  final double? cost;
  final String? currency;
}

class SessionContextState {
  const SessionContextState({
    required this.sessionId,
    required this.usedTokens,
    required this.contextWindowTokens,
    required this.usedPercent,
    required this.compactionThresholdTokens,
    required this.minimumThresholdTokens,
    required this.supportsManualCompaction,
    required this.supportsThreshold,
    required this.isCompacting,
    required this.updatedAt,
    required this.usage,
    this.modelId,
    this.compactionKind,
  });

  factory SessionContextState.fromJson(Object? value) {
    final json = jsonMap(value, name: 'session context');
    int? tokens(String key) =>
        json[key] is num ? (json[key]! as num).toInt() : null;
    return SessionContextState(
      sessionId: requireString(json, 'sessionId'),
      modelId: optionalString(json, 'modelId'),
      usedTokens: tokens('usedTokens'),
      contextWindowTokens: tokens('contextWindowTokens'),
      usedPercent: json['usedPercent'] is num
          ? (json['usedPercent']! as num).toDouble()
          : null,
      compactionThresholdTokens: tokens('compactionThresholdTokens'),
      minimumThresholdTokens: tokens('minimumThresholdTokens'),
      supportsManualCompaction: json['supportsManualCompaction'] == true,
      supportsThreshold: json['supportsThreshold'] == true,
      isCompacting: json['isCompacting'] == true,
      compactionKind: json['compactionKind'] == 'automatic' ||
              json['compactionKind'] == 'manual'
          ? json['compactionKind'] as String
          : null,
      updatedAt: DateTime.tryParse(optionalString(json, 'updatedAt') ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      usage: SessionUsageTotals.fromJson(json['usage']),
    );
  }

  final String sessionId;
  final String? modelId;
  final int? usedTokens;
  final int? contextWindowTokens;
  final double? usedPercent;
  final int? compactionThresholdTokens;
  final int? minimumThresholdTokens;
  final bool supportsManualCompaction;
  final bool supportsThreshold;
  final bool isCompacting;
  final String? compactionKind;
  final DateTime updatedAt;
  final SessionUsageTotals usage;
}

class ContentPart {
  const ContentPart({required this.type, required this.data});

  factory ContentPart.fromJson(Object? value) {
    final json = jsonMap(value, name: 'content part');
    return ContentPart(
        type: optionalString(json, 'type') ?? 'unknown', data: json);
  }

  final String type;
  final JsonMap data;

  bool get isAttachment =>
      type == 'image' ||
      type == 'input_image' ||
      type == 'audio' ||
      type == 'input_audio' ||
      type == 'file' ||
      type == 'attachment';

  String? get attachmentUri {
    final direct = optionalString(data, 'uri') ??
        optionalString(data, 'dataUri') ??
        optionalString(data, 'url') ??
        optionalString(data, 'imageUrl') ??
        optionalString(data, 'image_url');
    if (direct != null) return direct;
    final nested = data['imageUrl'] ?? data['image_url'];
    if (nested is Map<Object?, Object?>) {
      final nestedJson = jsonMap(nested, name: 'image URL');
      final url = optionalString(nestedJson, 'url');
      if (url != null) return url;
    }
    final encoded =
        optionalString(data, 'dataBase64') ?? optionalString(data, 'base64');
    if (encoded == null) return null;
    return 'data:${attachmentMimeType ?? 'application/octet-stream'};base64,$encoded';
  }

  String? get attachmentMimeType =>
      optionalString(data, 'mimeType') ?? optionalString(data, 'mime');

  String? get attachmentName =>
      optionalString(data, 'name') ??
      optionalString(data, 'fileName') ??
      optionalString(data, 'filename');

  bool get isImageAttachment {
    if (type == 'image' || type == 'input_image') return true;
    if (attachmentMimeType?.toLowerCase().startsWith('image/') == true) {
      return true;
    }
    return attachmentUri?.toLowerCase().startsWith('data:image/') == true;
  }

  bool get isAudioAttachment {
    if (type == 'audio' || type == 'input_audio') return true;
    if (attachmentMimeType?.toLowerCase().startsWith('audio/') == true) {
      return true;
    }
    return attachmentUri?.toLowerCase().startsWith('data:audio/') == true;
  }

  String get summary {
    switch (type) {
      case 'text':
      case 'reasoning':
        return optionalString(data, 'text') ?? '';
      case 'command':
        return optionalString(data, 'command') ?? 'Command';
      case 'tool':
        return optionalString(data, 'name') ?? 'Tool';
      case 'file_change':
        return optionalString(data, 'path') ?? 'File change';
      case 'error':
        return optionalString(data, 'message') ?? 'Error';
      case 'image':
      case 'input_image':
        return attachmentName ?? 'Image attachment';
      case 'file':
      case 'attachment':
        return attachmentName ?? 'File attachment';
      case 'subagent':
        return optionalString(data, 'summary') ??
            optionalString(data, 'action') ??
            'Agent activity';
      case 'workflow':
        return '';
      default:
        return data.toString();
    }
  }
}

class RemoteAttachment {
  const RemoteAttachment({
    required this.name,
    required this.mimeType,
    required this.dataBase64,
    required this.byteLength,
    this.origin,
  });

  final String name;
  final String mimeType;
  final String dataBase64;
  final int byteLength;
  final String? origin;

  String get dataUri => 'data:$mimeType;base64,$dataBase64';

  JsonMap toJson() => <String, Object?>{
        'name': name,
        'mimeType': mimeType,
        'dataBase64': dataBase64,
        'byteLength': byteLength,
        if (origin != null) 'origin': origin,
      };
}

class SimplifySettings {
  factory SimplifySettings({
    int maxWords = defaultMaxWords,
    String? guidance,
  }) {
    final normalizedGuidance = guidance
        ?.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    final boundedGuidance = normalizedGuidance == null ||
            normalizedGuidance.isEmpty
        ? null
        : normalizedGuidance.substring(
            0,
            normalizedGuidance.length.clamp(0, maximumGuidanceLength).toInt(),
          );
    return SimplifySettings._(
      maxWords.clamp(1, maximumMaxWords).toInt(),
      boundedGuidance,
    );
  }

  const SimplifySettings._(this.maxWords, this.guidance);

  static const int defaultMaxWords = 100;
  static const int maximumMaxWords = 2000;
  static const int maximumGuidanceLength = 600;

  final int maxWords;
  final String? guidance;

  JsonMap toJson() => <String, Object?>{
        'maxWords': maxWords,
        if (guidance != null) 'guidance': guidance,
      };
}

final RegExp _simplifyCommand = RegExp(
  r'(^|[\s(])/simplify\b[,:;]?',
  caseSensitive: false,
);

String simplifyVisibleContent(String value) {
  final source = value.trim();
  if (!_simplifyCommand.hasMatch(source)) return source;
  final content = source
      .replaceAllMapped(
        _simplifyCommand,
        (match) => match.group(1) ?? '',
      )
      .replaceAllMapped(
        RegExp(r'[ \t]+([,.;!?])'),
        (match) => match.group(1)!,
      )
      .replaceAll(RegExp(r'[ \t]{2,}'), ' ')
      .replaceFirst(RegExp(r'^\s*[,;:]\s*'), '')
      .trim();
  return content.isEmpty ? 'Simplify the previous answer.' : content;
}

class RemoteQueuedAttachment {
  const RemoteQueuedAttachment({
    required this.name,
    required this.mimeType,
    required this.byteLength,
    this.dataBase64,
  });

  factory RemoteQueuedAttachment.fromJson(Object? value) {
    final json = jsonMap(value, name: 'queued attachment');
    final byteLength = json['byteLength'];
    if (byteLength is! num) {
      throw const FormatException('Queued attachment byteLength is invalid');
    }
    return RemoteQueuedAttachment(
      name: requireString(json, 'name'),
      mimeType: requireString(json, 'mimeType'),
      byteLength: byteLength.toInt(),
      dataBase64: optionalString(json, 'dataBase64'),
    );
  }

  final String name;
  final String mimeType;
  final int byteLength;
  final String? dataBase64;

  String? get localImageDataUri {
    final encoded = dataBase64;
    if (encoded == null || encoded.isEmpty || byteLength <= 0) return null;
    if (!RegExp(r'^image/[a-z0-9.+-]+$', caseSensitive: false)
        .hasMatch(mimeType)) {
      return null;
    }
    if (encoded.length != ((byteLength + 2) ~/ 3) * 4 ||
        !RegExp(r'^[A-Za-z0-9+/]*={0,2}$').hasMatch(encoded)) {
      return null;
    }
    return 'data:$mimeType;base64,$encoded';
  }
}

class RemoteQueuedMessage {
  const RemoteQueuedMessage({
    required this.id,
    required this.sessionId,
    required this.content,
    required this.state,
    required this.createdAt,
    required this.attachments,
    this.modelId,
    this.reasoningEffort,
    this.error,
  });

  factory RemoteQueuedMessage.fromJson(Object? value) {
    final json = jsonMap(value, name: 'queued message');
    return RemoteQueuedMessage(
      id: requireString(json, 'id'),
      sessionId: requireString(json, 'sessionId'),
      content: requireString(json, 'content'),
      state: requireString(json, 'state'),
      createdAt: DateTime.parse(requireString(json, 'createdAt')).toLocal(),
      attachments: jsonList(json['attachments'])
          .map(RemoteQueuedAttachment.fromJson)
          .toList(growable: false),
      modelId: optionalString(json, 'modelId'),
      reasoningEffort: optionalString(json, 'reasoningEffort'),
      error: optionalString(json, 'error'),
    );
  }

  final String id;
  final String sessionId;
  final String content;
  final String state;
  final DateTime createdAt;
  final List<RemoteQueuedAttachment> attachments;
  final String? modelId;
  final String? reasoningEffort;
  final String? error;
}

class RemoteMessage {
  const RemoteMessage({
    required this.id,
    required this.sessionId,
    required this.role,
    required this.createdAt,
    required this.parts,
    required this.status,
    this.editable = false,
    this.providerMessageId,
    this.origin,
  });

  factory RemoteMessage.fromJson(Object? value) {
    final json = jsonMap(value, name: 'message');
    return RemoteMessage(
      id: requireString(json, 'id'),
      sessionId: requireString(json, 'sessionId'),
      role: requireString(json, 'role'),
      createdAt: DateTime.tryParse(requireString(json, 'createdAt')) ??
          DateTime.now().toUtc(),
      parts: jsonList(json['parts'])
          .map(ContentPart.fromJson)
          .toList(growable: false),
      status: requireString(json, 'status'),
      editable: json['editable'] == true,
      providerMessageId: optionalString(json, 'providerMessageId'),
      origin: _messageOriginFromJson(json),
    );
  }

  final String id;
  final String sessionId;
  final String role;
  final DateTime createdAt;
  final List<ContentPart> parts;
  final String status;
  final bool editable;
  final String? providerMessageId;
  final RemoteMessageOrigin? origin;
}

class RemoteMessageOrigin {
  const RemoteMessageOrigin({
    required this.kind,
    required this.sourceSessionId,
    this.sourceTitle,
    this.envelopeId,
  });

  factory RemoteMessageOrigin.fromJson(Object? value) {
    final json = jsonMap(value, name: 'message origin');
    return RemoteMessageOrigin(
      kind: optionalString(json, 'kind') ?? 'cross_session',
      sourceSessionId: optionalString(json, 'sourceSessionId') ??
          optionalString(json, 'sessionId') ??
          '',
      sourceTitle: optionalString(json, 'sourceTitle') ??
          optionalString(json, 'title') ??
          optionalString(json, 'taskTitle'),
      envelopeId: optionalString(json, 'envelopeId'),
    );
  }

  final String kind;
  final String sourceSessionId;
  final String? sourceTitle;
  final String? envelopeId;
}

RemoteMessageOrigin? _messageOriginFromJson(JsonMap json) {
  final direct = json['origin'];
  if (direct is Map<Object?, Object?>) {
    return RemoteMessageOrigin.fromJson(direct);
  }
  final metadata = json['nativeMetadata'];
  if (metadata is Map<Object?, Object?>) {
    final native = jsonMap(metadata, name: 'message metadata');
    if (native['origin'] is Map<Object?, Object?>) {
      return RemoteMessageOrigin.fromJson(native['origin']);
    }
  }
  final sourceSessionId = optionalString(json, 'originSessionId');
  final sourceTitle = optionalString(json, 'originTitle');
  if (sourceSessionId == null && sourceTitle == null) return null;
  return RemoteMessageOrigin(
    kind: 'cross_session',
    sourceSessionId: sourceSessionId ?? '',
    sourceTitle: sourceTitle,
  );
}

class ReasoningEffortOption {
  const ReasoningEffortOption({required this.id, this.description});

  factory ReasoningEffortOption.fromJson(Object? value) {
    if (value is String && value.trim().isNotEmpty) {
      return ReasoningEffortOption(id: value.trim());
    }
    final json = jsonMap(value, name: 'reasoning effort');
    return ReasoningEffortOption(
      id: optionalString(json, 'reasoningEffort') ??
          optionalString(json, 'id') ??
          optionalString(json, 'value') ??
          optionalString(json, 'effort') ??
          'default',
      description: optionalString(json, 'description'),
    );
  }

  final String id;
  final String? description;
}

class RemoteModel {
  const RemoteModel({
    required this.id,
    required this.providerId,
    required this.displayName,
    required this.isDefault,
    required this.nativeMetadata,
    this.inputModalities = const <String>[],
    this.description,
  });

  factory RemoteModel.fromJson(Object? value) {
    final json = jsonMap(value, name: 'model');
    return RemoteModel(
      id: requireString(json, 'id'),
      providerId: requireString(json, 'providerId'),
      displayName: requireString(json, 'displayName'),
      description: optionalString(json, 'description'),
      isDefault: json['isDefault'] == true,
      inputModalities: jsonList(json['inputModalities'])
          .whereType<String>()
          .toList(growable: false),
      nativeMetadata: jsonMap(json['nativeMetadata'], name: 'model metadata'),
    );
  }

  final String id;
  final String providerId;
  final String displayName;
  final String? description;
  final bool isDefault;
  final List<String> inputModalities;
  final JsonMap nativeMetadata;

  String? get sourceProviderId => optionalString(nativeMetadata, 'sourceProviderId');
  String? get sourceProviderName => optionalString(nativeMetadata, 'sourceProviderName');

  String get routeProviderName {
    if (providerId != 'opencode') return providerId;
    return sourceProviderName ?? sourceProviderId ?? 'OpenCode';
  }

  String? get routeCarrierName {
    if (providerId != 'opencode' || routeProviderName.toLowerCase() == 'opencode') return null;
    return 'OpenCode';
  }

  String get routeProviderLabel => routeCarrierName == null
      ? routeProviderName
      : '$routeProviderName via $routeCarrierName';

  List<ReasoningEffortOption> get reasoningEfforts {
    final advertised = jsonList(nativeMetadata['supportedReasoningEfforts'])
        .followedBy(jsonList(nativeMetadata['reasoningEfforts']))
        .followedBy(jsonList(nativeMetadata['thoughtLevels']))
        .followedBy(jsonList(nativeMetadata['thought_levels']))
        .map(ReasoningEffortOption.fromJson)
        .where((option) => _isConcreteReasoningEffort(option.id))
        .toList();
    if (advertised.isNotEmpty) return List<ReasoningEffortOption>.unmodifiable(advertised);
    return List<ReasoningEffortOption>.unmodifiable(_knownReasoningEfforts(providerId, id, displayName)
        .map((effort) => ReasoningEffortOption(id: effort)));
  }

  String? get defaultReasoningEffort {
    final advertised = optionalString(nativeMetadata, 'defaultReasoningEffort');
    if (advertised != null) return advertised;
    final haystack = _knownReasoningHaystack(providerId, id, displayName);
    if (RegExp(r'grok[- .]?4\.6').hasMatch(haystack) ||
        RegExp(r'grok[- .]?4\.5').hasMatch(haystack)) {
      return 'high';
    }
    return null;
  }

  bool? get supportsImageInput {
    if (inputModalities.isNotEmpty) {
      return inputModalities
          .any((value) => value == 'image' || value.startsWith('image/'));
    }
    for (final key in const <String>[
      'supportsImageInput',
      'supportsImages',
      'imageInput',
    ]) {
      final value = nativeMetadata[key];
      if (value is bool) return value;
    }

    Object? modalities = nativeMetadata['inputModalities'] ??
        nativeMetadata['supportedInputModalities'] ??
        nativeMetadata['input_modalities'];
    final grouped = nativeMetadata['modalities'];
    if (modalities == null && grouped is Map<Object?, Object?>) {
      modalities = grouped['input'];
    }
    if (modalities is! List<Object?> || modalities.isEmpty) return null;
    final values = modalities
        .map((value) => value is String
            ? value
            : value is Map<Object?, Object?>
                ? value['type']
                : null)
        .whereType<String>()
        .map((value) => value.toLowerCase())
        .toList(growable: false);
    if (values.isEmpty) return null;
    return values
        .any((value) => value == 'image' || value.startsWith('image/'));
  }

  bool? get supportsAudioInput {
    if (inputModalities.isNotEmpty) {
      return inputModalities
          .any((value) => value == 'audio' || value.startsWith('audio/'));
    }
    for (final key in const <String>[
      'supportsAudioInput',
      'supportsAudio',
      'audioInput',
    ]) {
      final value = nativeMetadata[key];
      if (value is bool) return value;
    }

    Object? modalities = nativeMetadata['inputModalities'] ??
        nativeMetadata['supportedInputModalities'] ??
        nativeMetadata['input_modalities'];
    final grouped = nativeMetadata['modalities'];
    if (modalities == null && grouped is Map<Object?, Object?>) {
      modalities = grouped['input'];
    }
    if (modalities is! List<Object?> || modalities.isEmpty) return null;
    final values = modalities
        .map((value) => value is String
            ? value
            : value is Map<Object?, Object?>
                ? value['type']
                : null)
        .whereType<String>()
        .map((value) => value.toLowerCase())
        .toList(growable: false);
    if (values.isEmpty) return null;
    return values
        .any((value) => value == 'audio' || value.startsWith('audio/'));
  }

  String? get endpointId {
    final explicit = optionalString(nativeMetadata, 'endpointId') ??
        optionalString(nativeMetadata, 'sourceProviderId');
    if (explicit != null) return explicit;
    final separator = id.indexOf('::');
    return separator <= 0 ? null : id.substring(0, separator);
  }

  String? get endpointName =>
      optionalString(nativeMetadata, 'endpointName') ??
      optionalString(nativeMetadata, 'sourceName') ??
      optionalString(nativeMetadata, 'sourceProviderName') ??
      endpointId;
}

bool _isConcreteReasoningEffort(String value) {
  final normalized = value.trim().toLowerCase().replaceAll('_', '-');
  return normalized.isNotEmpty &&
      normalized != 'auto' &&
      normalized != 'automatic' &&
      normalized != 'default' &&
      normalized != 'model-default' &&
      normalized != 'unknown' &&
      normalized != 'unspecified';
}

String _knownReasoningHaystack(String providerId, String modelId, String displayName) =>
    '$providerId $modelId $displayName'.toLowerCase();

List<String> _knownReasoningEfforts(
    String providerId, String modelId, String displayName) {
  final haystack = _knownReasoningHaystack(providerId, modelId, displayName);
  if (haystack.contains('non-reasoning') || haystack.contains('non_reasoning')) {
    return const <String>[];
  }
  if (RegExp(r'grok[- .]?4\.6').hasMatch(haystack)) {
    return const <String>['low', 'medium', 'high', 'xhigh'];
  }
  if (RegExp(r'grok[- .]?4\.5').hasMatch(haystack)) {
    return const <String>['low', 'medium', 'high'];
  }
  if (RegExp(r'grok[- .]?4\.3').hasMatch(haystack)) {
    return const <String>['none', 'low', 'medium', 'high'];
  }
  return const <String>[];
}

bool _usesCodexLightLabel(
    String? providerId, String? modelId, String? displayName) {
  final haystack =
      _knownReasoningHaystack(providerId ?? '', modelId ?? '', displayName ?? '');
  if (haystack.contains('grok')) return false;
  if (providerId == 'codex') return true;
  return RegExp(r'gpt[- .]?5\.6').hasMatch(haystack);
}

/// Compact human label. Codex `low` is Light; Grok's documented name is Low.
String reasoningDisplayLabel(
  String effort, {
  String? providerId,
  String? modelId,
  String? displayName,
}) {
  final normalized = effort.trim().toLowerCase();
  if (normalized.isEmpty) return effort;
  if (normalized == 'low') {
    return _usesCodexLightLabel(providerId, modelId, displayName)
        ? 'Light'
        : 'Low';
  }
  if (normalized == 'light') return 'Light';
  if (normalized == 'xhigh' || normalized == 'x-high') return 'Extra high';
  if (normalized == 'none' || normalized == 'off') return 'Off';
  return '${normalized[0].toUpperCase()}${normalized.substring(1)}';
}

class ProviderWalletEndpoint {
  const ProviderWalletEndpoint({
    required this.id,
    required this.name,
    this.apiKeyLabel,
  });

  factory ProviderWalletEndpoint.fromJson(Object? value) {
    final json = jsonMap(value, name: 'provider wallet endpoint');
    return ProviderWalletEndpoint(
      id: requireString(json, 'id'),
      name: requireString(json, 'name'),
      apiKeyLabel: optionalString(json, 'apiKeyLabel'),
    );
  }

  final String id;
  final String name;
  final String? apiKeyLabel;
}

class ProviderWalletStatus {
  const ProviderWalletStatus({
    required this.providerId,
    required this.kind,
    required this.label,
    required this.detail,
    required this.currency,
    required this.apiKeyConfigured,
    this.endpointId,
    this.endpointName,
    this.balance,
    this.spent,
    this.apiKeyLabel,
    this.caution,
    this.availableEndpoints = const <ProviderWalletEndpoint>[],
  });

  factory ProviderWalletStatus.fromJson(Object? value) {
    final json = jsonMap(value, name: 'provider wallet');
    return ProviderWalletStatus(
      providerId: requireString(json, 'providerId'),
      kind: optionalString(json, 'kind') ?? 'harness',
      label: optionalString(json, 'label') ?? 'Harness wallet',
      detail: optionalString(json, 'detail') ??
          'Payment is managed by the selected harness.',
      endpointId: optionalString(json, 'endpointId'),
      endpointName: optionalString(json, 'endpointName'),
      currency: optionalString(json, 'currency') ?? 'USD',
      balance:
          json['balance'] is num ? (json['balance']! as num).toDouble() : null,
      spent: json['spent'] is num ? (json['spent']! as num).toDouble() : null,
      apiKeyConfigured: json['apiKeyConfigured'] == true,
      apiKeyLabel: optionalString(json, 'apiKeyLabel'),
      caution: optionalString(json, 'caution'),
      availableEndpoints: jsonList(json['availableEndpoints'])
          .map((value) {
            try {
              return ProviderWalletEndpoint.fromJson(value);
            } on FormatException {
              return null;
            }
          })
          .whereType<ProviderWalletEndpoint>()
          .toList(growable: false),
    );
  }

  factory ProviderWalletStatus.fallback({
    required String providerId,
    required bool apiKeyConfigured,
  }) {
    final direct = providerId == 'direct';
    return ProviderWalletStatus(
      providerId: providerId,
      kind: direct ? 'user_api' : 'harness',
      label: direct ? 'Direct API wallet' : 'Harness wallet / subscription',
      detail: direct
          ? 'Uses your API key and local spend budget.'
          : 'Billing is managed by the selected harness or subscription.',
      currency: 'USD',
      apiKeyConfigured: direct ? apiKeyConfigured : true,
      caution: direct && !apiKeyConfigured
          ? 'An API key is required before this model can run.'
          : null,
    );
  }

  final String providerId;
  final String kind;
  final String label;
  final String detail;
  final String? endpointId;
  final String? endpointName;
  final String currency;
  final double? balance;
  final double? spent;
  final bool apiKeyConfigured;
  final String? apiKeyLabel;
  final String? caution;
  final List<ProviderWalletEndpoint> availableEndpoints;

  bool get isDirectApi => kind == 'user_api';
  bool get requiresApiKey => isDirectApi && !apiKeyConfigured;
}

class VisionProxySelection {
  const VisionProxySelection({
    required this.providerId,
    required this.modelId,
    this.reasoningEffort,
  });

  factory VisionProxySelection.fromJson(Object? value) {
    final json = jsonMap(value, name: 'visual support selection');
    return VisionProxySelection(
      providerId: requireString(json, 'providerId'),
      modelId: requireString(json, 'modelId'),
      reasoningEffort: optionalString(json, 'reasoningEffort'),
    );
  }

  final String providerId;
  final String modelId;
  final String? reasoningEffort;

  JsonMap toJson() => <String, Object?>{
        'providerId': providerId,
        'modelId': modelId,
        if (reasoningEffort != null) 'reasoningEffort': reasoningEffort,
      };
}

class VisionProxyTarget {
  const VisionProxyTarget({
    required this.providerId,
    required this.displayName,
    required this.models,
  });

  factory VisionProxyTarget.fromJson(Object? value) {
    final json = jsonMap(value, name: 'visual support target');
    return VisionProxyTarget(
      providerId: requireString(json, 'providerId'),
      displayName: requireString(json, 'displayName'),
      models: jsonList(json['models'])
          .map(RemoteModel.fromJson)
          .toList(growable: false),
    );
  }

  final String providerId;
  final String displayName;
  final List<RemoteModel> models;
}

class VisionProxyStatus {
  const VisionProxyStatus({
    required this.sessionId,
    required this.primaryModelSupportsImageInput,
    this.primaryModelId,
    this.configured,
    this.helperSessionId,
  });

  factory VisionProxyStatus.fromJson(Object? value) {
    final json = jsonMap(value, name: 'visual support status');
    return VisionProxyStatus(
      sessionId: requireString(json, 'sessionId'),
      primaryModelId: optionalString(json, 'primaryModelId'),
      primaryModelSupportsImageInput:
          json['primaryModelSupportsImageInput'] is bool
              ? json['primaryModelSupportsImageInput'] as bool
              : null,
      configured: json['configured'] == null
          ? null
          : VisionProxySelection.fromJson(json['configured']),
      helperSessionId: optionalString(json, 'helperSessionId'),
    );
  }

  final String sessionId;
  final String? primaryModelId;
  final bool? primaryModelSupportsImageInput;
  final VisionProxySelection? configured;
  final String? helperSessionId;
}

class DelegationSelection {
  const DelegationSelection({
    required this.providerId,
    this.modelId,
    this.reasoningEffort,
  });

  factory DelegationSelection.fromJson(Object? value) {
    final json = jsonMap(value, name: 'delegation selection');
    return DelegationSelection(
      providerId: requireString(json, 'providerId'),
      modelId: optionalString(json, 'modelId'),
      reasoningEffort: optionalString(json, 'reasoningEffort'),
    );
  }

  final String providerId;
  final String? modelId;
  final String? reasoningEffort;

  JsonMap toJson() => <String, Object?>{
        'providerId': providerId,
        if (modelId != null) 'modelId': modelId,
        if (reasoningEffort != null) 'reasoningEffort': reasoningEffort,
      };
}

class TranscriptionSource {
  const TranscriptionSource({
    required this.id,
    required this.label,
    required this.status,
    required this.setupEnvironmentVariable,
    required this.supportsBatch,
    required this.maxAudioBytes,
    this.credentialLabel,
    this.credentialSetupUrl,
  });

  factory TranscriptionSource.fromJson(Object? value) {
    final json = jsonMap(value, name: 'transcription source');
    final capabilities =
        jsonMap(json['capabilities'], name: 'transcription capabilities');
    final maxAudioBytes = capabilities['maxAudioBytes'];
    if (maxAudioBytes is! num || maxAudioBytes <= 0) {
      throw const FormatException(
          'transcription source maxAudioBytes must be positive');
    }
    final credential = json['credential'] is Map
        ? jsonMap(json['credential'], name: 'transcription credential')
        : const <String, Object?>{};
    return TranscriptionSource(
      id: requireString(json, 'id'),
      label: requireString(json, 'label'),
      status: requireString(json, 'status'),
      setupEnvironmentVariable: requireString(json, 'setupEnvironmentVariable'),
      supportsBatch: capabilities['batch'] == true,
      maxAudioBytes: maxAudioBytes.toInt(),
      credentialLabel: optionalString(credential, 'label'),
      credentialSetupUrl: optionalString(credential, 'setupUrl'),
    );
  }

  final String id;
  final String label;
  final String status;
  final String setupEnvironmentVariable;
  final bool supportsBatch;
  final int maxAudioBytes;
  final String? credentialLabel;
  final String? credentialSetupUrl;

  bool get isReady => status == 'ready';
}

class RemoteDelegationChild {
  const RemoteDelegationChild({
    required this.id,
    required this.providerId,
    required this.state,
    this.sessionId,
    this.modelId,
    this.reasoningEffort,
    this.error,
  });

  factory RemoteDelegationChild.fromJson(Object? value) {
    final json = jsonMap(value, name: 'delegation child');
    return RemoteDelegationChild(
      id: requireString(json, 'id'),
      providerId: requireString(json, 'providerId'),
      state: requireString(json, 'state'),
      sessionId: optionalString(json, 'sessionId'),
      modelId: optionalString(json, 'modelId'),
      reasoningEffort: optionalString(json, 'reasoningEffort'),
      error: optionalString(json, 'error'),
    );
  }

  final String id;
  final String providerId;
  final String state;
  final String? sessionId;
  final String? modelId;
  final String? reasoningEffort;
  final String? error;
}

class RemoteDelegationTask {
  const RemoteDelegationTask({
    required this.id,
    required this.parentSessionId,
    required this.prompt,
    required this.state,
    required this.createdAt,
    required this.updatedAt,
    required this.children,
    this.error,
  });

  factory RemoteDelegationTask.fromJson(Object? value) {
    final json = jsonMap(value, name: 'delegation task');
    return RemoteDelegationTask(
      id: requireString(json, 'id'),
      parentSessionId: requireString(json, 'parentSessionId'),
      prompt: requireString(json, 'prompt'),
      state: requireString(json, 'state'),
      createdAt: DateTime.parse(requireString(json, 'createdAt')).toLocal(),
      updatedAt: DateTime.parse(requireString(json, 'updatedAt')).toLocal(),
      children: jsonList(json['children'])
          .map(RemoteDelegationChild.fromJson)
          .toList(growable: false),
      error: optionalString(json, 'error'),
    );
  }

  final String id;
  final String parentSessionId;
  final String prompt;
  final String state;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<RemoteDelegationChild> children;
  final String? error;
}

class AgentEvent {
  const AgentEvent({
    required this.eventId,
    required this.sequence,
    required this.type,
    required this.occurredAt,
    required this.payload,
    this.sessionId,
    this.providerId,
  });

  factory AgentEvent.fromJson(Object? value) {
    final json = jsonMap(value, name: 'event');
    final sequence = json['sequence'];
    return AgentEvent(
      eventId: requireString(json, 'eventId'),
      sequence: sequence is num ? sequence.toInt() : 0,
      type: requireString(json, 'type'),
      occurredAt: DateTime.tryParse(requireString(json, 'occurredAt')) ??
          DateTime.now().toUtc(),
      payload: jsonMap(json['payload'], name: 'event payload'),
      sessionId: optionalString(json, 'sessionId'),
      providerId: optionalString(json, 'providerId'),
    );
  }

  final String eventId;
  final int sequence;
  final String type;
  final DateTime occurredAt;
  final JsonMap payload;
  final String? sessionId;
  final String? providerId;
}

class ApprovalChoice {
  const ApprovalChoice(
      {required this.id, required this.label, required this.kind});

  factory ApprovalChoice.fromJson(Object? value) {
    final json = jsonMap(value, name: 'approval choice');
    return ApprovalChoice(
        id: requireString(json, 'id'),
        label: requireString(json, 'label'),
        kind: requireString(json, 'kind'));
  }

  final String id;
  final String label;
  final String kind;
}

class ApprovalRequest {
  const ApprovalRequest({
    required this.requestId,
    required this.sessionId,
    required this.providerId,
    required this.title,
    required this.choices,
    required this.affectedFiles,
    required this.networkDestinations,
    this.reason,
    this.command,
    this.workingDirectory,
  });

  factory ApprovalRequest.fromJson(Object? value) {
    final json = jsonMap(value, name: 'approval');
    return ApprovalRequest(
      requestId: requireString(json, 'requestId'),
      sessionId: requireString(json, 'sessionId'),
      providerId: requireString(json, 'providerId'),
      title: requireString(json, 'title'),
      choices: jsonList(json['choices'])
          .map(ApprovalChoice.fromJson)
          .toList(growable: false),
      affectedFiles: jsonList(json['affectedFiles'])
          .whereType<String>()
          .toList(growable: false),
      networkDestinations: jsonList(json['networkDestinations'])
          .whereType<String>()
          .toList(growable: false),
      reason: optionalString(json, 'reason'),
      command: optionalString(json, 'command'),
      workingDirectory: optionalString(json, 'workingDirectory'),
    );
  }

  final String requestId;
  final String sessionId;
  final String providerId;
  final String title;
  final List<ApprovalChoice> choices;
  final List<String> affectedFiles;
  final List<String> networkDestinations;
  final String? reason;
  final String? command;
  final String? workingDirectory;
}

class UserInputRequest {
  const UserInputRequest(
      {required this.requestId,
      required this.sessionId,
      required this.title,
      required this.request,
      this.prompt});

  factory UserInputRequest.fromJson(Object? value) {
    final json = jsonMap(value, name: 'user input');
    return UserInputRequest(
      requestId: requireString(json, 'requestId'),
      sessionId: requireString(json, 'sessionId'),
      title: requireString(json, 'title'),
      request: jsonMap(json['request'], name: 'user input request'),
      prompt: optionalString(json, 'prompt'),
    );
  }

  final String requestId;
  final String sessionId;
  final String title;
  final String? prompt;
  final JsonMap request;
}

class ProviderCapabilities {
  const ProviderCapabilities({
    this.createSession = false,
    this.modelEnumeration = false,
    this.sessionRelationships = false,
    this.steering = false,
    this.messageEditing = false,
  });

  factory ProviderCapabilities.fromJson(Object? value) {
    if (value is! Map<Object?, Object?>) {
      return const ProviderCapabilities();
    }
    final json = jsonMap(value, name: 'provider capabilities');
    return ProviderCapabilities(
      createSession: json['createSession'] == true,
      modelEnumeration: json['modelEnumeration'] == true,
      sessionRelationships: json['sessionRelationships'] == true,
      steering: json['steering'] == true,
      messageEditing: json['messageEditing'] == true,
    );
  }

  final bool createSession;
  final bool modelEnumeration;
  final bool sessionRelationships;
  final bool steering;
  final bool messageEditing;
}

class PairedDevice {
  const PairedDevice({
    required this.credentialId,
    required this.deviceId,
    required this.issuedAt,
  });

  factory PairedDevice.fromJson(Object? value) {
    final json = jsonMap(value, name: 'paired device');
    return PairedDevice(
      credentialId: requireString(json, 'credentialId'),
      deviceId: requireString(json, 'deviceId'),
      issuedAt: DateTime.parse(requireString(json, 'issuedAt')),
    );
  }

  final String credentialId;
  final String deviceId;
  final DateTime issuedAt;
}

class ProviderConnection {
  const ProviderConnection({
    required this.providerId,
    required this.displayName,
    required this.state,
    required this.detected,
    required this.authenticated,
    this.capabilities = const ProviderCapabilities(),
  });

  factory ProviderConnection.fromJson(Object? value) {
    final json = jsonMap(value, name: 'provider');
    return ProviderConnection(
      providerId: requireString(json, 'providerId'),
      displayName: requireString(json, 'displayName'),
      state: requireString(json, 'state'),
      detected: json['detected'] == true,
      authenticated:
          json['authenticated'] is bool ? json['authenticated'] as bool : null,
      capabilities: ProviderCapabilities.fromJson(json['capabilities']),
    );
  }

  final String providerId;
  final String displayName;
  final String state;
  final bool detected;
  final bool? authenticated;
  final ProviderCapabilities capabilities;
}
