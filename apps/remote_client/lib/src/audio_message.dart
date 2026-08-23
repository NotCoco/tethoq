import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';

/// Decodes a `data:audio/...;base64,...` URI into its raw bytes.
Uint8List audioBytesFromUri(String uri) {
  final comma = uri.indexOf(',');
  if (comma < 0 || !uri.substring(0, comma).endsWith(';base64')) {
    throw const FormatException('Audio attachment is not base64 data');
  }
  return base64Decode(uri.substring(comma + 1));
}

/// Parses the first data chunk of a 16-bit PCM WAV into amplitude peaks.
List<double> wavePeaks(Uint8List bytes, {int bars = 72}) {
  if (bytes.length < 44 ||
      String.fromCharCodes(bytes.sublist(0, 4)) != 'RIFF' ||
      String.fromCharCodes(bytes.sublist(8, 12)) != 'WAVE') {
    return const <double>[];
  }
  final view = ByteData.sublistView(bytes);
  var offset = 12;
  while (offset + 8 <= bytes.length) {
    final id = String.fromCharCodes(bytes.sublist(offset, offset + 4));
    final size = view.getUint32(offset + 4, Endian.little);
    if (id == 'data') {
      final start = offset + 8;
      final count = (size.clamp(0, bytes.length - start) ~/ 2);
      if (count <= 0) return const <double>[];
      final samplesPerBar = count ~/ bars;
      if (samplesPerBar <= 0) return const <double>[];
      final peaks = <double>[];
      for (var bar = 0; bar < bars; bar += 1) {
        var peak = 0.0;
        final from = bar * samplesPerBar;
        final to = (from + samplesPerBar).clamp(0, count);
        for (var index = from; index < to; index += 1) {
          final sample =
              view.getInt16(start + index * 2, Endian.little) / 32768.0;
          final absolute = sample.abs();
          if (absolute > peak) peak = absolute;
        }
        peaks.add(peak);
      }
      return peaks;
    }
    offset += 8 + size + (size.isOdd ? 1 : 0);
  }
  return const <double>[];
}

/// Playable recording widget used in messages: one line traces the clip and
/// the played portion fills with the provider accent as playback advances.
class AudioMessageWidget extends StatefulWidget {
  const AudioMessageWidget({
    super.key,
    required this.uri,
    required this.name,
    required this.mimeType,
    required this.accent,
  });

  final String uri;
  final String name;
  final String mimeType;
  final Color accent;

  @override
  State<AudioMessageWidget> createState() => _AudioMessageWidgetState();
}

class _AudioMessageWidgetState extends State<AudioMessageWidget> {
  final AudioPlayer _player = AudioPlayer();
  StreamSubscription<PlayerState>? _stateSubscription;
  StreamSubscription<Duration>? _positionSubscription;
  StreamSubscription<Duration>? _durationSubscription;
  bool _playing = false;
  bool _failed = false;
  Duration _duration = Duration.zero;
  double _progress = 0;
  List<double> _peaks = const <double>[];

  @override
  void initState() {
    super.initState();
    _stateSubscription = _player.onPlayerStateChanged.listen((state) {
      if (!mounted) return;
      setState(() => _playing = state == PlayerState.playing);
    });
    _positionSubscription =
        _player.onPositionChanged.listen((position) {
      if (!mounted || _duration.inMicroseconds <= 0) return;
      setState(() => _progress = (position.inMicroseconds /
              _duration.inMicroseconds)
          .clamp(0.0, 1.0));
    });
    _durationSubscription =
        _player.onDurationChanged.listen((duration) {
      if (mounted) setState(() => _duration = duration);
    });
    try {
      final bytes = audioBytesFromUri(widget.uri);
      if (widget.mimeType.toLowerCase().contains('wav')) {
        _peaks = wavePeaks(bytes);
      }
    } catch (_) {
      _failed = true;
    }
  }

  @override
  void dispose() {
    unawaited(_stateSubscription?.cancel());
    unawaited(_positionSubscription?.cancel());
    unawaited(_durationSubscription?.cancel());
    unawaited(_player.dispose());
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_failed) return;
    if (_playing) {
      await _player.pause();
      return;
    }
    try {
      final bytes = audioBytesFromUri(widget.uri);
      if (_progress >= 1) {
        await _player.seek(Duration.zero);
        setState(() => _progress = 0);
      }
      await _player.play(BytesSource(bytes, mimeType: widget.mimeType));
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  String get _label {
    if (_failed) return 'Recording unavailable';
    if (_playing) return 'Playing';
    final seconds = _duration.inSeconds;
    if (seconds > 0) {
      return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
    }
    return 'Audio';
  }

  @override
  Widget build(BuildContext context) {
    final onSurfaceVariant = Theme.of(context).colorScheme.onSurfaceVariant;
    return Semantics(
      button: true,
      label: '${_playing ? 'Pause' : 'Play'} ${widget.name}',
      child: Container(
        height: 42,
        padding: const EdgeInsets.fromLTRB(6, 4, 10, 4),
        decoration: BoxDecoration(
          color: Theme.of(context)
              .colorScheme
              .surfaceContainerHighest
              .withValues(alpha: 0.4),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: Theme.of(context).colorScheme.outlineVariant
                .withValues(alpha: 0.55),
          ),
        ),
        child: Row(
          children: <Widget>[
            IconButton(
              key: const Key('audio-message-toggle'),
              visualDensity: VisualDensity.compact,
              tooltip: _playing ? 'Pause recording' : 'Play recording',
              onPressed: _failed ? null : () => unawaited(_toggle()),
              icon: Icon(
                _playing
                    ? Icons.pause_rounded
                    : Icons.play_arrow_rounded,
                size: 22,
              ),
            ),
            Expanded(
              child: CustomPaint(
                size: const Size(double.infinity, 34),
                painter: _AudioWaveformPainter(
                  peaks: _peaks,
                  progress: _progress,
                  accent: widget.accent,
                  base: onSurfaceVariant.withValues(alpha: 0.45),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              _label,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

class _AudioWaveformPainter extends CustomPainter {
  const _AudioWaveformPainter({
    required this.peaks,
    required this.progress,
    required this.accent,
    required this.base,
  });

  final List<double> peaks;
  final double progress;
  final Color accent;
  final Color base;

  @override
  void paint(Canvas canvas, Size size) {
    final mid = size.height / 2;
    final line = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.6
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    if (peaks.isEmpty) {
      line.color = base;
      canvas.drawLine(Offset(2, mid), Offset(size.width - 2, mid), line);
      if (progress > 0) {
        line.color = accent;
        canvas.drawLine(Offset(2, mid),
            Offset(2 + (size.width - 4) * progress.clamp(0.0, 1.0), mid), line);
      }
      return;
    }
    final window = 48.clamp(0, peaks.length);
    final offset = ((progress.clamp(0.0, 1.0)) * (peaks.length - window))
        .round()
        .clamp(0, peaks.length - window);
    final visible = peaks.sublist(offset, offset + window);
    final step = (size.width - 4) / (visible.length - 1);
    final played = progress.clamp(0.0, 1.0) * visible.length;
    final pathBase = Path();
    final pathPlayed = Path();
    for (var index = 0; index < visible.length; index += 1) {
      final x = 2 + index * step;
      final y = mid - visible[index].clamp(0.0, 1.0) * (mid - 2);
      if (index == 0) {
        pathBase.moveTo(x, y);
        pathPlayed.moveTo(x, y);
      } else {
        pathBase.lineTo(x, y);
        if (index <= played) pathPlayed.lineTo(x, y);
      }
    }
    line.color = base;
    canvas.drawPath(pathBase, line);
    if (played > 0) {
      line.color = accent;
      canvas.drawPath(pathPlayed, line);
    }
  }

  @override
  bool shouldRepaint(covariant _AudioWaveformPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.peaks != peaks;
}

/// Compact play toggle for composer attachment chips.
class AudioChipPlayToggle extends StatefulWidget {
  const AudioChipPlayToggle({
    super.key,
    required this.uri,
    required this.mimeType,
    required this.accent,
  });

  final String uri;
  final String mimeType;
  final Color accent;

  @override
  State<AudioChipPlayToggle> createState() => _AudioChipPlayToggleState();
}

class _AudioChipPlayToggleState extends State<AudioChipPlayToggle> {
  final AudioPlayer _player = AudioPlayer();
  bool _playing = false;

  @override
  void initState() {
    super.initState();
    _player.onPlayerStateChanged.listen((state) {
      if (!mounted) return;
      final playing = state == PlayerState.playing;
      if (playing != _playing) setState(() => _playing = playing);
    });
    _player.onPlayerComplete.listen((_) {
      if (mounted) setState(() => _playing = false);
    });
  }

  @override
  void dispose() {
    unawaited(_player.dispose());
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_playing) {
      await _player.stop();
      if (mounted) setState(() => _playing = false);
      return;
    }
    try {
      final bytes = audioBytesFromUri(widget.uri);
      await _player.play(BytesSource(bytes, mimeType: widget.mimeType));
    } catch (_) {
      // Playback is optional in the draft chip; the sent message owns errors.
    }
  }

  @override
  Widget build(BuildContext context) => IconButton(
        key: const Key('audio-chip-play'),
        visualDensity: VisualDensity.compact,
        tooltip: _playing ? 'Pause recording' : 'Play recording',
        onPressed: () => unawaited(_toggle()),
        icon: Icon(
          _playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
          size: 22,
          color: widget.accent,
        ),
      );
}
