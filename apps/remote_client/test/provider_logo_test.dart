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

  testWidgets('provider identities render the agreed Tethoq monogram family',
      (tester) async {
    const expectedMonograms = <String, String>{
      'codex': 'CX',
      'opencode': 'OC',
      'grok': 'G',
      'pi': 'π',
      'omp': 'OMP',
      'qwen': 'Q',
      'goose': 'g',
      'kimi': 'K',
      'hermes': 'H',
      'cline': 'CL',
      'copilot': 'CP',
      'direct': 'API',
      'oh-my-pi': 'OMP',
      'github-copilot-cli': 'CP',
      'future-harness': 'FH',
    };

    await tester.pumpWidget(
      MaterialApp(
        home: Wrap(
          children: expectedMonograms.keys
              .map((providerId) => ProviderLogo(
                    providerId: providerId,
                    size: 24,
                  ))
              .toList(growable: false),
        ),
      ),
    );
    await tester.pumpAndSettle();

    for (final entry in expectedMonograms.entries) {
      final finder = find.byKey(ValueKey<String>('provider-logo-${entry.key}'));
      expect(finder, findsOneWidget);
      expect(
        find.descendant(of: finder, matching: find.text(entry.value)),
        findsOneWidget,
      );
      expect(find.descendant(of: finder, matching: find.byType(CustomPaint)),
          findsNothing);
    }
    expect(
        providerVisualThemeFor('future-harness').providerId, 'future-harness');
    expect(
        providerVisualThemeFor('future-harness').displayName, 'Future Harness');
    expect(openCodeVisualTheme.markColor, const Color(0xff80c7a1));
    expect(grokVisualTheme.markColor, const Color(0xffd7d8d5));
    expect(codexVisualTheme.markColor, const Color(0xfff0f1ee));
    expect(openCodeVisualTheme.accent, isNot(openCodeVisualTheme.markColor),
        reason:
            'provider colour should guide the mark without flooding the theme');
  });
}
