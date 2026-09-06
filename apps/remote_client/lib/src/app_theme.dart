import 'package:flutter/material.dart';

class ProviderVisualTheme {
  const ProviderVisualTheme({
    required this.providerId,
    required this.displayName,
    required this.version,
    required this.icon,
    this.markColor,
    required this.accent,
    required this.background,
    required this.surface,
    required this.surfaceRaised,
    required this.border,
  });

  final String providerId;
  final String displayName;
  final String version;
  final IconData icon;
  final Color? markColor;
  final Color accent;
  final Color background;
  final Color surface;
  final Color surfaceRaised;
  final Color border;
}

const codexVisualTheme = ProviderVisualTheme(
  providerId: 'codex',
  displayName: 'Codex',
  version: 'v1.3',
  icon: Icons.blur_circular_rounded,
  markColor: Color(0xfff0f1ee),
  accent: Color(0xffd7d7d4),
  background: Color(0xff10100f),
  surface: Color(0xff181817),
  surfaceRaised: Color(0xff20201f),
  border: Color(0xff353533),
);

const openCodeVisualTheme = ProviderVisualTheme(
  providerId: 'opencode',
  displayName: 'OpenCode',
  version: 'v1.2',
  icon: Icons.grid_view_rounded,
  markColor: Color(0xff80c7a1),
  accent: Color(0xffb9bcba),
  background: Color(0xff070808),
  surface: Color(0xff101111),
  surfaceRaised: Color(0xff181919),
  border: Color(0xff2d2f2e),
);

const grokVisualTheme = ProviderVisualTheme(
  providerId: 'grok',
  displayName: 'Grok Build',
  version: 'v1.0',
  icon: Icons.bolt_rounded,
  markColor: Color(0xffd7d8d5),
  accent: Color(0xffffffff),
  background: Color(0xff000000),
  surface: Color(0xff040404),
  surfaceRaised: Color(0xff0b0b0b),
  border: Color(0xff444444),
);

// These are deliberately neutral Tethoq glyphs, not third-party brand marks.
// Distinct silhouettes keep providers recognizable without borrowing logos.
const piVisualTheme = ProviderVisualTheme(
  providerId: 'pi',
  displayName: 'Pi',
  version: 'Local CLI',
  icon: Icons.architecture_rounded,
  markColor: Color(0xff84cdb2),
  accent: Color(0xffd9e7df),
  background: Color(0xff0c100e),
  surface: Color(0xff151b18),
  surfaceRaised: Color(0xff202923),
  border: Color(0xff354139),
);

const ompVisualTheme = ProviderVisualTheme(
  providerId: 'omp',
  displayName: 'Oh My Pi',
  version: 'Local CLI',
  icon: Icons.route_rounded,
  markColor: Color(0xffd9aa70),
  accent: Color(0xffe4ded4),
  background: Color(0xff100d0b),
  surface: Color(0xff1b1714),
  surfaceRaised: Color(0xff28211b),
  border: Color(0xff40362c),
);

const qwenVisualTheme = ProviderVisualTheme(
  providerId: 'qwen',
  displayName: 'Qwen Code',
  version: 'Local CLI',
  icon: Icons.auto_awesome_mosaic_rounded,
  markColor: Color(0xff91a9e9),
  accent: Color(0xffdde1ec),
  background: Color(0xff0b0d12),
  surface: Color(0xff151820),
  surfaceRaised: Color(0xff222735),
  border: Color(0xff394052),
);

const gooseVisualTheme = ProviderVisualTheme(
  providerId: 'goose',
  displayName: 'Goose',
  version: 'Local CLI',
  icon: Icons.flight_rounded,
  markColor: Color(0xffa7c582),
  accent: Color(0xffe1e5da),
  background: Color(0xff0d100b),
  surface: Color(0xff171b15),
  surfaceRaised: Color(0xff23291f),
  border: Color(0xff394133),
);

const kimiVisualTheme = ProviderVisualTheme(
  providerId: 'kimi',
  displayName: 'Kimi Code',
  version: 'Local CLI',
  icon: Icons.nightlight_round,
  markColor: Color(0xffb39be2),
  accent: Color(0xffe4e0ed),
  background: Color(0xff0e0c12),
  surface: Color(0xff18151e),
  surfaceRaised: Color(0xff25202e),
  border: Color(0xff3e374a),
);

const hermesVisualTheme = ProviderVisualTheme(
  providerId: 'hermes',
  displayName: 'Hermes Agent',
  version: 'Local CLI',
  icon: Icons.swap_calls_rounded,
  markColor: Color(0xffe0a673),
  accent: Color(0xffe6dfd5),
  background: Color(0xff100d0b),
  surface: Color(0xff1b1714),
  surfaceRaised: Color(0xff29221c),
  border: Color(0xff43382e),
);

const clineVisualTheme = ProviderVisualTheme(
  providerId: 'cline',
  displayName: 'Cline',
  version: 'Local CLI',
  icon: Icons.polyline_rounded,
  markColor: Color(0xff70bbcc),
  accent: Color(0xffdce7e9),
  background: Color(0xff0b1012),
  surface: Color(0xff151d20),
  surfaceRaised: Color(0xff202d31),
  border: Color(0xff354b52),
);

const copilotVisualTheme = ProviderVisualTheme(
  providerId: 'copilot',
  displayName: 'GitHub Copilot CLI',
  version: 'Local CLI',
  icon: Icons.hub_rounded,
  markColor: Color(0xffba92d5),
  accent: Color(0xffe4e1eb),
  background: Color(0xff0e0c11),
  surface: Color(0xff1b1821),
  surfaceRaised: Color(0xff292432),
  border: Color(0xff443c50),
);

const directApiVisualTheme = ProviderVisualTheme(
  providerId: 'direct',
  displayName: 'Direct API',
  version: 'User API wallet',
  icon: Icons.cloud_outlined,
  markColor: Color(0xff69aaf9),
  accent: Color(0xff5aa9ff),
  background: Color(0xff09111c),
  surface: Color(0xff111e2d),
  surfaceRaised: Color(0xff192c42),
  border: Color(0xff2d5076),
);

const allHarnessesVisualTheme = ProviderVisualTheme(
  providerId: 'all',
  displayName: 'All harnesses',
  version: 'Combined',
  icon: Icons.all_inclusive_rounded,
  accent: Color(0xffbfbfbf),
  background: Color(0xff0a0a0a),
  surface: Color(0xff161616),
  surfaceRaised: Color(0xff202020),
  border: Color(0xff323232),
);

ProviderVisualTheme providerVisualThemeFor(String providerId) {
  final normalized = providerId.trim().toLowerCase();
  return switch (normalized) {
    'all' => allHarnessesVisualTheme,
    'codex' => codexVisualTheme,
    'opencode' => openCodeVisualTheme,
    'grok' => grokVisualTheme,
    'pi' => piVisualTheme,
    'omp' || 'oh-my-pi' => ompVisualTheme,
    'qwen' || 'qwen-code' => qwenVisualTheme,
    'goose' => gooseVisualTheme,
    'kimi' || 'kimi-code' => kimiVisualTheme,
    'hermes' || 'hermes-agent' => hermesVisualTheme,
    'cline' => clineVisualTheme,
    'copilot' || 'github-copilot' || 'github-copilot-cli' => copilotVisualTheme,
    'direct' => directApiVisualTheme,
    _ => ProviderVisualTheme(
        providerId: providerId,
        displayName: _providerDisplayName(providerId),
        version: 'Local connector',
        icon: Icons.terminal_rounded,
        accent: const Color(0xffd7d9d7),
        background: const Color(0xff0d0d0c),
        surface: const Color(0xff181817),
        surfaceRaised: const Color(0xff212120),
        border: const Color(0xff383835),
      ),
  };
}

String _providerDisplayName(String providerId) {
  final words = providerId
      .trim()
      .split(RegExp(r'[-_\s]+'))
      .where((word) => word.isNotEmpty)
      .map((word) => '${word[0].toUpperCase()}${word.substring(1)}')
      .toList(growable: false);
  return words.isEmpty ? 'Coding tool' : words.join(' ');
}

class ProviderLogo extends StatelessWidget {
  const ProviderLogo({
    required this.providerId,
    required this.size,
    this.semanticLabel,
    super.key,
  });

  final String providerId;
  final double size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final visual = providerVisualThemeFor(providerId);
    final harnessId = _canonicalHarnessId(providerId);
    final markColor = visual.markColor ?? visual.accent;
    final monogram = _tethoqHarnessMonograms[harnessId] ??
        (harnessId == 'all' ? null : _providerInitials(visual.displayName));
    return Semantics(
      label: semanticLabel ?? '${visual.displayName} provider',
      image: true,
      excludeSemantics: true,
      child: SizedBox.square(
        key: ValueKey<String>('provider-logo-$providerId'),
        dimension: size,
        child: monogram != null
            ? _HarnessMonogram(
                monogram: monogram,
                color: markColor,
                size: size,
              )
            : Icon(visual.icon, color: markColor, size: size),
      ),
    );
  }
}

// Recognition comes from the truthful harness name, a restrained colour cue,
// and this one Tethoq-owned typographic family—not copied provider geometry.
const _tethoqHarnessMonograms = <String, String>{
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
};

String _canonicalHarnessId(String providerId) {
  final normalized = providerId.trim().toLowerCase();
  return switch (normalized) {
    'oh-my-pi' => 'omp',
    'qwen-code' => 'qwen',
    'kimi-code' => 'kimi',
    'hermes-agent' => 'hermes',
    'github-copilot' || 'github-copilot-cli' => 'copilot',
    _ => normalized,
  };
}

String _providerInitials(String name) {
  final words = name
      .trim()
      .split(RegExp(r'[^A-Za-z0-9]+'))
      .where((word) => word.isNotEmpty)
      .toList(growable: false);
  if (words.length > 1) {
    return '${words.first[0]}${words.last[0]}'.toUpperCase();
  }
  final word = words.isEmpty ? '?' : words.first;
  return (word.length <= 3 ? word : word[0]).toUpperCase();
}

class _HarnessMonogram extends StatelessWidget {
  const _HarnessMonogram({
    required this.monogram,
    required this.color,
    required this.size,
  });

  final String monogram;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.symmetric(horizontal: size * .04),
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(
            monogram,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: color,
              fontSize: size * .56,
              fontWeight: FontWeight.w700,
              height: 1,
              letterSpacing: monogram.length == 3
                  ? -.6
                  : monogram.length == 1
                      ? 0
                      : -.25,
            ),
          ),
        ),
      );
}

ThemeData buildRemoteTheme(ProviderVisualTheme visual) {
  final colorScheme = ColorScheme.dark(
    primary: visual.accent,
    secondary: visual.accent,
    surface: visual.surface,
    onSurface: const Color(0xfff3f5f8),
    error: const Color(0xffff7469),
  );
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    colorScheme: colorScheme,
    scaffoldBackgroundColor: visual.background,
    canvasColor: visual.surface,
    dividerColor: visual.border.withValues(alpha: 0.7),
    textTheme: base.textTheme.copyWith(
      titleLarge: base.textTheme.titleLarge?.copyWith(
        fontSize: 21,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.25,
        height: 1.18,
      ),
      titleMedium: base.textTheme.titleMedium?.copyWith(
        fontSize: 17,
        fontWeight: FontWeight.w600,
      ),
      bodyLarge: base.textTheme.bodyLarge?.copyWith(
        fontSize: 16,
        fontWeight: FontWeight.w400,
        height: 1.45,
      ),
      bodyMedium: base.textTheme.bodyMedium?.copyWith(
        fontSize: 15,
        height: 1.4,
      ),
      bodySmall: base.textTheme.bodySmall?.copyWith(
        fontSize: 12.5,
        height: 1.35,
      ),
      labelMedium: base.textTheme.labelMedium?.copyWith(fontSize: 12.5),
      labelSmall: base.textTheme.labelSmall?.copyWith(fontSize: 11.5),
      labelLarge: base.textTheme.labelLarge?.copyWith(
        fontSize: 14,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.55,
      ),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: visual.background,
      foregroundColor: colorScheme.onSurface,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
    ),
    navigationBarTheme: NavigationBarThemeData(
      height: 66,
      backgroundColor: visual.background.withValues(alpha: 0.98),
      indicatorColor: Colors.transparent,
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        return TextStyle(
          color: states.contains(WidgetState.selected)
              ? visual.accent
              : const Color(0xffaeb7c5),
          fontSize: 12,
          fontWeight: states.contains(WidgetState.selected)
              ? FontWeight.w600
              : FontWeight.w500,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith((states) {
        return IconThemeData(
          color: states.contains(WidgetState.selected)
              ? visual.accent
              : const Color(0xffaeb7c5),
        );
      }),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: visual.surface,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: visual.border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: visual.border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: visual.accent),
      ),
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: visual.surfaceRaised,
      side: BorderSide(color: visual.border),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
    ),
    tooltipTheme: TooltipThemeData(
      waitDuration: const Duration(milliseconds: 500),
      showDuration: const Duration(seconds: 3),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      margin: const EdgeInsets.all(12),
      textStyle: base.textTheme.bodySmall?.copyWith(
        color: colorScheme.onSurface,
        fontSize: 12.5,
        height: 1.25,
      ),
      decoration: BoxDecoration(
        color: visual.surfaceRaised,
        border: Border.all(color: visual.border),
        borderRadius: BorderRadius.circular(8),
        boxShadow: const <BoxShadow>[
          BoxShadow(
            color: Color(0x66000000),
            blurRadius: 14,
            offset: Offset(0, 6),
          ),
        ],
      ),
    ),
  );
}
