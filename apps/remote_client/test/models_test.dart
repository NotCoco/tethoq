import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/models.dart';

void main() {
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
    expect(session.project, 'remote-app');
    expect(session.modelId, 'gpt-5.6-sol');
    expect(session.reasoningEffort, 'ultra');
    expect(session.variantId, 'fast');
    expect(session.parentSessionId, 'host/codex/parent');
    expect(session.agentNickname, 'Reviewer');
    expect(session.agentRole, 'reviewer');
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
      'isCompacting': false,
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
      'helperSessionId': 'host/codex/eyes',
    });

    expect(target.models.single.supportsImageInput, isTrue);
    expect(status.configured?.toJson(), <String, Object?>{
      'providerId': 'codex',
      'modelId': 'vision-model',
      'reasoningEffort': 'high',
    });
    expect(status.primaryModelSupportsImageInput, isFalse);
    expect(status.helperSessionId, 'host/codex/eyes');
  });
}
