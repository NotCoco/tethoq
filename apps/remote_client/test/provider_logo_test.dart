import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:universal_agent_remote/src/app_theme.dart';

void main() {
  test('theme uses concise delayed Tethoq tooltips', () {
    final tooltip = buildRemoteTheme(codexVisualTheme).tooltipTheme;

    expect(tooltip.waitDuration, const Duration(milliseconds: 500));
    expect(tooltip.showDuration, const Duration(seconds: 3));
    expect(tooltip.decoration, isA<BoxDecoration>());
    expect((tooltip.decoration! as BoxDecoration).borderRadius,
        BorderRadius.circular(8));
  });

  testWidgets('provider identities render neutral bundled glyphs',
      (tester) async {
    const providerIds = <String>[
      'codex',
      'opencode',
      'grok',
      'pi',
      'omp',
      'qwen',
      'goose',
      'kimi',
      'hermes',
      'cline',
      'copilot',
      'future-harness',
    ];

    await tester.pumpWidget(
      MaterialApp(
        home: Wrap(
          children: providerIds
              .map((providerId) => ProviderLogo(
                    providerId: providerId,
                    size: 24,
                  ))
              .toList(growable: false),
        ),
      ),
    );
    await tester.pumpAndSettle();

    for (final providerId in providerIds) {
      final finder = find.byKey(ValueKey<String>('provider-logo-$providerId'));
      expect(finder, findsOneWidget);
      expect(tester.widget<Icon>(finder).icon, isNotNull);
    }
    expect(
        providerVisualThemeFor('future-harness').providerId, 'future-harness');
    expect(
        providerVisualThemeFor('future-harness').displayName, 'Future Harness');
  });
}
