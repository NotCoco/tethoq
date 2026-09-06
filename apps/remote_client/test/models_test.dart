import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/ears.dart';
import 'package:universal_agent_remote/src/models.dart';

void main() {
  test('transcription source keeps provider API key setup metadata', () {
    final source = TranscriptionSource.fromJson(<String, Object?>{
      'id': 'openai-stt',
      'label': 'OpenAI speech-to-text',
      'status': 'needs_credential',
      'setupEnvironmentVariable': 'TETHOQ_OPENAI_API_KEY',
      'credential': <String, Object?>{
        'kind': 'api_key',
        'label': 'OpenAI API key',
        'setupUrl': 'https://platform.openai.com/api-keys',
      },
      'capabilities': <String, Object?>{
        'batch': true,
        'maxAudioBytes': 4 * 1024 * 1024,
      },
    });

    expect(source.credentialLabel, 'OpenAI API key');
    expect(source.credentialSetupUrl, 'https://platform.openai.com/api-keys');
    expect(source.isReady, isFalse);
  });

  test('simplify settings match bridge bounds and omit empty guidance', () {
    final defaultSettings = SimplifySettings(guidance: '   ');
    final bounded = SimplifySettings(
      maxWords: 9000,
      guidance: ' Keep\n the concrete\t example. ',
    );

    expect(defaultSettings.toJson(), <String, Object?>{'maxWords': 100});
    expect(bounded.maxWords, 2000);
    expect(bounded.guidance, 'Keep the concrete example.');
    expect(bounded.toJson(), <String, Object?>{
      'maxWords': 2000,
      'guidance': 'Keep the concrete example.',
    });
    expect(SimplifySettings(maxWords: 0).maxWords, 1);
  });

  test('simplify visible content mirrors previous and upcoming semantics', () {
    expect(
        simplifyVisibleContent('/simplify'), 'Simplify the previous answer.');
    expect(simplifyVisibleContent('Please /simplify: explain the result'),
        'Please explain the result');
    expect(simplifyVisibleContent('/simplified is not a command'),
        '/simplified is not a command');
  });

  test('EARS helpers keep only explicit dictation origin', () {
    const dictation = RemoteAttachment(
      name: 'clip.wav',
      mimeType: 'audio/wav',
      origin: 'dictation',
      dataBase64: 'AA==',
      byteLength: 1,
    );
    const dropped = RemoteAttachment(
      name: 'clip.wav',
      mimeType: 'audio/wav',
      origin: 'drag-drop',
      dataBase64: 'AA==',
      byteLength: 1,
    );
    expect(isDictationAudioAttachment(dictation), isTrue);
    expect(isDictationAudioAttachment(dropped), isFalse);
    expect(composeEarsDestinationText('typed', const <String>['spoken']),
        'typed\n\nspoken');
    expect(
      EarsSettings.fromJson(<String, Object?>{
        'enabled': true,
        'providerId': 'direct',
        'modelId': 'gpt-5.6-sol',
        'mode': 'verbatim',
      }).mode,
      'verbatim',
    );
  });

  test('EARS transport and MIME checks match the bridge contract', () {
    expect(providerDeliversNativeAudio('direct'), isTrue);
    expect(providerDeliversNativeAudio('codex'), isTrue);
    expect(providerDeliversNativeAudio('opencode'), isTrue);
    expect(providerDeliversNativeAudio('grok'), isFalse);

    RemoteAttachment dictation(String mimeType) => RemoteAttachment(
          name: 'voice',
          mimeType: mimeType,
          origin: 'dictation',
          dataBase64: 'AA==',
          byteLength: 1,
        );
    for (final mimeType in <String>[
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
    ]) {
      expect(isDictationAudioAttachment(dictation(mimeType)), isTrue,
          reason: mimeType);
    }
    expect(isDictationAudioAttachment(dictation('audio/webm')), isFalse);
    expect(isDictationAudioAttachment(dictation('audio/mp4')), isFalse);
  });

  test('session model preserves provider-neutral fields', () {
    final session = RemoteSession.fromJson(<String, Object?>{
      'id': 'host/codex/thread',
      'hostId': 'host',
      'providerId': 'codex',
      'providerSessionId': 'thread',
      'title': 'Fix tests',
      'state': 'working',
      'lastActivityAt': '2026-08-07T12:00:00.000Z',
      'needsApproval': false,
      'stale': false,
      'externalWriter': true,
      'project': 'remote-app',
      'modelId': 'gpt-5.6-sol',
      'reasoningEffort': 'ultra',
      'variantId': 'fast',
      'parentSessionId': 'host/codex/parent',
      'agentNickname': 'Reviewer',
      'agentRole': 'reviewer',
    });
    expect(session.providerId, 'codex');
    expect(session.state, 'working');
    expect(session.externalWriter, isTrue);
    expect(session.project, 'remote-app');
    expect(session.modelId, 'gpt-5.6-sol');
    expect(session.reasoningEffort, 'ultra');
    expect(session.variantId, 'fast');
    expect(session.parentSessionId, 'host/codex/parent');
    expect(session.agentNickname, 'Reviewer');
    expect(session.agentRole, 'reviewer');
    expect(session.copyWith(externalWriter: false).externalWriter, isFalse);
  });

  test('provider connection parses relationship capability', () {
    final provider = ProviderConnection.fromJson(<String, Object?>{
      'providerId': 'codex',
      'displayName': 'Codex',
      'state': 'online',
      'detected': true,
      'authenticated': true,
      'capabilities': <String, Object?>{'sessionRelationships': true},
    });

    expect(provider.capabilities.sessionRelationships, isTrue);
  });

  test('side-chat sessions and cross-task message origins stay explicit', () {
    final sideChat = RemoteSession.fromJson(<String, Object?>{
      'id': 'host/codex/side',
      'hostId': 'host',
      'providerId': 'codex',
      'providerSessionId': 'side',
      'title': 'Check this approach',
      'state': 'idle',
      'lastActivityAt': '2026-08-15T12:00:00.000Z',
      'needsApproval': false,
      'stale': false,
      'sessionKind': 'side_chat',
      'parentSessionId': 'host/codex/parent',
    });
    final message = RemoteMessage.fromJson(<String, Object?>{
      'id': 'cross-task-message',
      'sessionId': 'host/codex/target',
      'role': 'user',
      'createdAt': '2026-08-15T12:01:00.000Z',
      'status': 'completed',
      'parts': <Object?>[
        <String, Object?>{'type': 'text', 'text': 'Please verify this.'},
      ],
      'origin': <String, Object?>{
        'kind': 'cross_session',
        'envelopeId': 'envelope-1',
        'sourceSessionId': 'host/codex/source',
        'sourceTitle': 'Source task',
      },
    });

    expect(sideChat.sessionKind, 'side_chat');
    expect(message.origin?.kind, 'cross_session');
    expect(message.origin?.envelopeId, 'envelope-1');
    expect(message.origin?.sourceTitle, 'Source task');
  });

  test('handoff and branch results preserve source relationship metadata', () {
    Map<String, Object?> session(String id, String kind, String strategy) =>
        <String, Object?>{
          'id': id,
          'hostId': 'host',
          'providerId': 'codex',
          'providerSessionId': id,
          'title': 'New task',
          'state': 'idle',
          'lastActivityAt': '2026-08-14T10:00:00.000Z',
          'needsApproval': false,
          'stale': false,
          'relationship': <String, Object?>{
            'kind': kind,
            'sourceSessionId': 'source-session',
            'strategy': strategy,
          },
        };

    final handoffSession =
        session('handoff-session', 'handoff', 'summary_bootstrap')
          ..['contextHandoffSummary'] = 'Persistent handoff summary.';
    final handoff = ContextHandoffResult.fromJson(<String, Object?>{
      'summary': 'The source task has one failing widget test.',
      'session': handoffSession,
    });
    final branch = SessionBranchResult.fromJson(<String, Object?>{
      'session': session('branch-session', 'branch', 'transcript_bootstrap'),
      'strategy': 'transcript_bootstrap',
      'copiedMessageCount': 12,
    });

    expect(handoff.summary, contains('failing widget test'));
    expect(handoff.session.relationship?.sourceSessionId, 'source-session');
    expect(
        handoff.session.contextHandoffSummary, 'Persistent handoff summary.');
    expect(branch.session.relationship?.kind, 'branch');
    expect(branch.strategy, 'transcript_bootstrap');
    expect(branch.copiedMessageCount, 12);

    final metadataFallback = RemoteSession.fromJson(<String, Object?>{
      ...session('metadata-handoff', 'handoff', 'summary_bootstrap'),
      'nativeMetadata': <String, Object?>{
        'tethoqHandoffSummary': 'Metadata fallback summary.',
      },
    });
    expect(
        metadataFallback.contextHandoffSummary, 'Metadata fallback summary.');
  });

  test('wallet and direct endpoint metadata remain defensive', () {
    final wallet = ProviderWalletStatus.fromJson(<String, Object?>{
      'providerId': 'direct',
      'kind': 'user_api',
      'label': 'Direct API wallet',
      'detail': 'Local budget',
      'endpointId': 'openai',
      'endpointName': 'OpenAI',
      'currency': 'USD',
      'balance': 25,
      'spent': 1.5,
      'apiKeyConfigured': false,
      'apiKeyLabel': 'OpenAI API key',
      'caution': 'Key required',
      'availableEndpoints': <Object?>[
        <String, Object?>{
          'id': 'openai',
          'name': 'OpenAI',
          'apiKeyLabel': 'OPENAI_API_KEY',
        },
        <String, Object?>{
          'id': 'xai',
          'name': 'xAI API',
          'apiKeyLabel': 'XAI_API_KEY',
        },
      ],
    });
    final model = RemoteModel.fromJson(<String, Object?>{
      'id': 'openai::gpt-test',
      'providerId': 'direct',
      'displayName': 'GPT Test',
      'isDefault': true,
      'nativeMetadata': <String, Object?>{'endpointName': 'OpenAI'},
    });

    expect(wallet.requiresApiKey, isTrue);
    expect(wallet.balance, 25);
    expect(wallet.availableEndpoints.map((endpoint) => endpoint.id),
        <String>['openai', 'xai']);
    expect(model.endpointId, 'openai');
    expect(model.endpointName, 'OpenAI');
  });

  test('session context keeps provider-reported limits, usage, and cost', () {
    final context = SessionContextState.fromJson(<String, Object?>{
      'sessionId': 'host/pi/session',
      'modelId': 'provider/model',
      'usedTokens': 42800,
      'contextWindowTokens': 128000,
      'usedPercent': 33.4375,
      'compactionThresholdTokens': 96000,
      'minimumThresholdTokens': 8000,
      'supportsManualCompaction': true,
      'supportsThreshold': true,
      'isCompacting': true,
      'compactionKind': 'automatic',
      'updatedAt': '2026-08-14T10:00:00.000Z',
      'usage': <String, Object?>{
        'inputTokens': 39100,
        'outputTokens': 3700,
        'totalTokens': 42800,
        'cost': .42,
        'currency': 'USD',
      },
    });

    expect(context.sessionId, 'host/pi/session');
    expect(context.contextWindowTokens, 128000);
    expect(context.compactionThresholdTokens, 96000);
    expect(context.supportsThreshold, isTrue);
    expect(context.compactionKind, 'automatic');
    expect(context.usage.totalTokens, 42800);
    expect(context.usage.cost, .42);
  });

  test('approval model retains exact provider choices', () {
    final approval = ApprovalRequest.fromJson(<String, Object?>{
      'requestId': 'approval-1',
      'sessionId': 'host/grok/session',
      'providerId': 'grok',
      'title': 'Allow command',
      'choices': <Object?>[
        <String, Object?>{
          'id': 'allow_once',
          'label': 'Allow once',
          'kind': 'approve'
        },
        <String, Object?>{'id': 'deny', 'label': 'Deny', 'kind': 'reject'},
      ],
      'affectedFiles': <Object?>['lib/main.dart'],
      'networkDestinations': <Object?>[],
    });
    expect(approval.choices.map((choice) => choice.id),
        <String>['allow_once', 'deny']);
  });

  test('model options preserve provider-advertised reasoning order', () {
    final model = RemoteModel.fromJson(<String, Object?>{
      'id': 'gpt-5.6',
      'providerId': 'codex',
      'displayName': 'GPT-5.6',
      'isDefault': true,
      'nativeMetadata': <String, Object?>{
        'supportedReasoningEfforts': <Object?>[
          <String, Object?>{'reasoningEffort': 'low'},
          <String, Object?>{'reasoningEffort': 'high'},
        ],
        'defaultReasoningEffort': 'high',
      },
    });

    expect(model.reasoningEfforts.map((effort) => effort.id),
        <String>['low', 'high']);
    expect(model.defaultReasoningEffort, 'high');
  });

  test('typed reasoning effort lists compose with missing fallback fields', () {
    final model = RemoteModel.fromJson(<String, Object?>{
      'id': 'gpt-5.6-sol',
      'providerId': 'codex',
      'displayName': 'GPT-5.6 Sol',
      'isDefault': true,
      'nativeMetadata': <String, Object?>{
        'supportedReasoningEfforts': <String>['ultra'],
      },
    });

    expect(
        model.reasoningEfforts.map((effort) => effort.id), <String>['ultra']);
  });

  test('model options omit automatic reasoning placeholders', () {
    final model = RemoteModel.fromJson(<String, Object?>{
      'id': 'gpt-5.6',
      'providerId': 'codex',
      'displayName': 'GPT-5.6',
      'isDefault': true,
      'nativeMetadata': <String, Object?>{
        'supportedReasoningEfforts': <Object?>[
          <String, Object?>{'reasoningEffort': 'auto'},
          <String, Object?>{'reasoningEffort': 'default'},
          <String, Object?>{'reasoningEffort': 'medium'},
        ],
        'defaultReasoningEffort': 'medium',
      },
    });

    expect(
        model.reasoningEfforts.map((effort) => effort.id), <String>['medium']);
  });

  test('queued messages keep a concrete session and state', () {
    final message = RemoteQueuedMessage.fromJson(<String, Object?>{
      'id': 'provider_queue/grok/session-one/native-q1',
      'sessionId': 'host/grok/session-one',
      'content': 'Queued from the Grok CLI',
      'state': 'queued',
      'createdAt': '2026-08-17T12:00:00.000Z',
      'attachments': <Object?>[],
      'retryable': false,
    });
    expect(message.sessionId, 'host/grok/session-one');
    expect(message.content, 'Queued from the Grok CLI');
    expect(message.state, 'queued');
    expect(message.retryable, isFalse);
  });

  test('Grok 4.6 documents selectable efforts including xhigh', () {
    final model = RemoteModel.fromJson(<String, Object?>{
      'id': 'grok-4.6',
      'providerId': 'grok',
      'displayName': 'Grok 4.6',
      'isDefault': true,
      'nativeMetadata': <String, Object?>{},
    });

    expect(model.reasoningEfforts.map((effort) => effort.id),
        <String>['low', 'medium', 'high', 'xhigh']);
    expect(model.defaultReasoningEffort, 'high');
    expect(
        reasoningDisplayLabel('low',
            providerId: 'grok', modelId: 'grok-4.6', displayName: 'Grok 4.6'),
        'Low');
    expect(
        reasoningDisplayLabel('xhigh', providerId: 'grok', modelId: 'grok-4.6'),
        'Extra high');
    expect(
        reasoningDisplayLabel('low',
            providerId: 'codex',
            modelId: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol'),
        'Light');
    expect(
        RemoteModel.fromJson(<String, Object?>{
          'id': 'grok-code',
          'providerId': 'grok',
          'displayName': 'Grok Code',
          'isDefault': false,
          'nativeMetadata': <String, Object?>{},
        }).reasoningEfforts,
        isEmpty);
  });

  test('OpenCode model route metadata exposes the upstream provider', () {
    final routed = RemoteModel.fromJson(<String, Object?>{
      'id': 'synthetic/deepseek-v4',
      'providerId': 'opencode',
      'displayName': 'DeepSeek V4',
      'isDefault': false,
      'nativeMetadata': <String, Object?>{
        'sourceProviderId': 'synthetic',
        'sourceProviderName': 'Synthetic',
      },
    });
    final fallback = RemoteModel.fromJson(<String, Object?>{
      'id': 'local-model',
      'providerId': 'opencode',
      'displayName': 'Local model',
      'isDefault': false,
      'nativeMetadata': <String, Object?>{},
    });

    expect(routed.sourceProviderId, 'synthetic');
    expect(routed.routeProviderName, 'Synthetic');
    expect(routed.routeCarrierName, 'OpenCode');
    expect(routed.routeProviderLabel, 'Synthetic via OpenCode');
    expect(fallback.routeProviderName, 'OpenCode');
    expect(fallback.routeCarrierName, isNull);
  });

  test('content parts expose normalized attachment fields without host paths',
      () {
    final image = ContentPart.fromJson(<String, Object?>{
      'type': 'image',
      'uri': 'data:image/png;base64,AQID',
      'mimeType': 'image/png',
      'name': 'phone-shot.png',
    });
    final file = ContentPart.fromJson(<String, Object?>{
      'type': 'file',
      'fileName': 'notes.txt',
      'mime': 'text/plain',
    });

    expect(image.isAttachment, isTrue);
    expect(image.isImageAttachment, isTrue);
    expect(image.attachmentUri, 'data:image/png;base64,AQID');
    expect(image.attachmentName, 'phone-shot.png');
    expect(file.isAttachment, isTrue);
    expect(file.isImageAttachment, isFalse);
    expect(file.summary, 'notes.txt');

    final rawImage = ContentPart.fromJson(<String, Object?>{
      'type': 'attachment',
      'mimeType': 'image/jpeg',
      'dataBase64': 'AQID',
    });
    final nestedImage = ContentPart.fromJson(<String, Object?>{
      'type': 'input_image',
      'image_url': <String, Object?>{'url': 'https://example.test/image.png'},
    });
    expect(rawImage.attachmentUri, 'data:image/jpeg;base64,AQID');
    expect(nestedImage.attachmentUri, 'https://example.test/image.png');

    final workflow = ContentPart.fromJson(<String, Object?>{
      'type': 'workflow',
      'workflow': <String, Object?>{
        'id': 'workflow-1',
        'name': 'Comment workflow',
        'eventCount': 442,
        'screenshotCount': 18,
      },
    });
    expect(workflow.summary, isEmpty,
        reason:
            'structured workflow metadata must not render as raw chat text');
  });

  test('model image support is inferred only from explicit input metadata', () {
    RemoteModel modelWith(Object? modalities) => RemoteModel(
          id: 'model-$modalities',
          providerId: 'provider',
          displayName: 'Model',
          isDefault: false,
          nativeMetadata: modalities == null
              ? const <String, Object?>{}
              : <String, Object?>{'inputModalities': modalities},
        );

    expect(modelWith(<Object?>['text']).supportsImageInput, isFalse);
    expect(modelWith(<Object?>['text', 'image']).supportsImageInput, isTrue);
    expect(modelWith(null).supportsImageInput, isNull);
  });

  test('visual support models preserve selection, modality, and status fields',
      () {
    final target = VisionProxyTarget.fromJson(<String, Object?>{
      'providerId': 'codex',
      'displayName': 'Codex',
      'models': <Object?>[
        <String, Object?>{
          'id': 'vision-model',
          'providerId': 'codex',
          'displayName': 'Vision model',
          'isDefault': true,
          'inputModalities': <Object?>['text', 'image'],
          'nativeMetadata': <String, Object?>{},
        },
      ],
    });
    final status = VisionProxyStatus.fromJson(<String, Object?>{
      'sessionId': 'host/codex/parent',
      'primaryModelId': 'text-model',
      'primaryModelSupportsImageInput': false,
      'configured': <String, Object?>{
        'providerId': 'codex',
        'modelId': 'vision-model',
        'reasoningEffort': 'high',
      },
    });

    expect(target.models.single.supportsImageInput, isTrue);
    expect(status.configured?.toJson(), <String, Object?>{
      'providerId': 'codex',
      'modelId': 'vision-model',
      'reasoningEffort': 'high',
    });
    expect(status.primaryModelSupportsImageInput, isFalse);
  });

  test('prepared Mesh tasks retain authorized targets before children exist',
      () {
    final task = RemoteDelegationTask.fromJson(<String, Object?>{
      'id': 'mesh-1',
      'parentSessionId': 'host/codex/parent',
      'prompt': 'Ask  to investigate',
      'state': 'awaiting_dispatch',
      'createdAt': '2026-09-03T12:00:00.000Z',
      'updatedAt': '2026-09-03T12:00:00.000Z',
      'children': <Object?>[],
      'orchestration': 'parent',
      'targets': <Object?>[
        <String, Object?>{
          'providerId': 'opencode',
          'modelId': 'deepseek-v4-flash',
          'reasoningEffort': 'high',
        },
      ],
      'presentationSegments': <Object?>[
        <String, Object?>{'type': 'text', 'text': 'Ask '},
        <String, Object?>{'type': 'mesh', 'targetIndex': 0},
        <String, Object?>{'type': 'text', 'text': ' to investigate'},
      ],
    });

    expect(task.children, isEmpty);
    expect(task.targets, hasLength(1));
    expect(task.targets.single.providerId, 'opencode');
    expect(task.targets.single.modelId, 'deepseek-v4-flash');
    expect(task.presentationSegments.map((segment) => segment.type),
        <String>['text', 'mesh', 'text']);
  });
}
