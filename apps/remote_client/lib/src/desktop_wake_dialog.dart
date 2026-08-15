import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'desktop_wake.dart';
import 'store.dart';
import 'transport.dart';

typedef DesktopWakeAction = Future<DesktopWakeResult> Function();

Future<bool?> showDesktopWakeDialog(
  BuildContext context,
  RemoteAppStore store,
) {
  return showDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (_) => DesktopWakeDialog(onWake: store.wakeDesktop),
  );
}

class DesktopWakeDialog extends StatefulWidget {
  const DesktopWakeDialog({required this.onWake, super.key});

  final DesktopWakeAction onWake;

  @override
  State<DesktopWakeDialog> createState() => _DesktopWakeDialogState();
}

class _DesktopWakeDialogState extends State<DesktopWakeDialog> {
  bool _opening = true;
  DesktopWakeResult? _result;
  Object? _error;

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  Future<void> _open() async {
    if (!_opening) setState(() => _opening = true);
    _error = null;
    _result = null;
    try {
      final result = await widget.onWake();
      if (!mounted) return;
      setState(() {
        _opening = false;
        _result = result;
      });
    } on Object catch (error) {
      if (!mounted) return;
      setState(() {
        _opening = false;
        _error = error;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final failure = _error == null ? null : _desktopWakeFailure(_error!);
    final success = _result != null;
    return PopScope(
      canPop: !_opening,
      child: Dialog(
        key: const Key('desktop-wake-dialog'),
        insetPadding: const EdgeInsets.symmetric(horizontal: 22, vertical: 24),
        backgroundColor: Colors.transparent,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 390),
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: const Color(0xff171716),
              border: Border.all(color: const Color(0xff373735)),
              borderRadius: BorderRadius.circular(22),
              boxShadow: const <BoxShadow>[
                BoxShadow(
                  color: Color(0x73000000),
                  blurRadius: 30,
                  offset: Offset(0, 14),
                ),
              ],
            ),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(22, 22, 22, 18),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  const _TethoqDesktopMark(),
                  const SizedBox(height: 18),
                  Text(
                    _opening
                        ? 'Opening Tethoq on your PC'
                        : success
                            ? 'Tethoq is open'
                            : failure!.title,
                    key: const Key('desktop-wake-title'),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          fontSize: 20,
                          fontWeight: FontWeight.w600,
                          letterSpacing: -0.25,
                        ),
                  ),
                  const SizedBox(height: 7),
                  Text(
                    _opening
                        ? 'The Bridge is connected. This usually takes a few seconds.'
                        : success
                            ? (_result!.alreadyRunning
                                ? 'Your desktop workspace was already ready on this computer.'
                                : 'Your desktop workspace is ready on this computer.')
                            : failure!.message,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: const Color(0xffadb2ba),
                          height: 1.4,
                        ),
                  ),
                  const SizedBox(height: 20),
                  if (_opening)
                    const SizedBox.square(
                      key: Key('desktop-wake-spinner'),
                      dimension: 26,
                      child: CircularProgressIndicator(
                        strokeWidth: 2.2,
                        color: Color(0xffdededb),
                      ),
                    )
                  else if (success)
                    const Icon(
                      Icons.check_circle_rounded,
                      key: Key('desktop-wake-success'),
                      size: 28,
                      color: Color(0xff7bd79a),
                    )
                  else
                    const Icon(
                      Icons.error_outline_rounded,
                      key: Key('desktop-wake-error'),
                      size: 28,
                      color: Color(0xffffaa62),
                    ),
                  if (!_opening) ...<Widget>[
                    const SizedBox(height: 18),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: <Widget>[
                        TextButton(
                          onPressed: () => Navigator.of(context).pop(success),
                          child: Text(success ? 'Done' : 'Close'),
                        ),
                        if (!success && failure!.retryable) ...<Widget>[
                          const SizedBox(width: 8),
                          FilledButton(
                            key: const Key('desktop-wake-retry'),
                            onPressed: _open,
                            child: const Text('Try again'),
                          ),
                        ],
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _DesktopWakeFailure {
  const _DesktopWakeFailure({
    required this.title,
    required this.message,
    required this.retryable,
  });

  final String title;
  final String message;
  final bool retryable;
}

_DesktopWakeFailure _desktopWakeFailure(Object error) {
  if (error is BridgeRequestException &&
      error.code == 'DESKTOP_NOT_INSTALLED') {
    return const _DesktopWakeFailure(
      title: 'Tethoq Desktop is not installed',
      message: 'The Bridge can still run your phone sessions. Install Tethoq '
          'Desktop on this PC before trying to open the desktop workspace.',
      retryable: false,
    );
  }
  if (error is DesktopWakeTimeoutException ||
      (error is BridgeRequestException && error.code == 'TIMEOUT')) {
    return const _DesktopWakeFailure(
      title: 'Tethoq is taking longer to open',
      message: 'Nothing was sent twice. You can wait a moment and try opening '
          'the desktop workspace again.',
      retryable: true,
    );
  }
  if (error is BridgeRequestException) {
    return _DesktopWakeFailure(
      title: 'Tethoq could not open',
      message: error.code == 'DESKTOP_WAKE_FAILED'
          ? 'The Bridge could not start the trusted Tethoq Desktop installation on this PC.'
          : 'The Bridge could not complete the desktop wake request.',
      retryable: error.retryable,
    );
  }
  return const _DesktopWakeFailure(
    title: 'Tethoq could not open',
    message: 'The Bridge could not complete the desktop wake request.',
    retryable: true,
  );
}

class _TethoqDesktopMark extends StatelessWidget {
  const _TethoqDesktopMark();

  @override
  Widget build(BuildContext context) => Semantics(
        label: 'Tethoq',
        image: true,
        child: Container(
          width: 58,
          height: 58,
          decoration: BoxDecoration(
            color: const Color(0xff090909),
            border: Border.all(color: const Color(0xff30302f)),
            borderRadius: BorderRadius.circular(17),
          ),
          padding: const EdgeInsets.all(10),
          child: const CustomPaint(painter: _TethoqMarkPainter()),
        ),
      );
}

class _TethoqMarkPainter extends CustomPainter {
  const _TethoqMarkPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xffdededb)
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..strokeWidth = math.max(2.1, size.shortestSide * 0.09);
    canvas.drawPath(
      Path()
        ..moveTo(size.width * 0.20, size.height * 0.72)
        ..lineTo(size.width * 0.20, size.height * 0.28)
        ..lineTo(size.width * 0.50, size.height * 0.28),
      paint,
    );
    canvas.drawPath(
      Path()
        ..moveTo(size.width * 0.42, size.height * 0.51)
        ..lineTo(size.width * 0.66, size.height * 0.51)
        ..lineTo(size.width * 0.66, size.height * 0.76)
        ..lineTo(size.width * 0.84, size.height * 0.76)
        ..lineTo(size.width * 0.84, size.height * 0.36),
      paint,
    );
  }

  @override
  bool shouldRepaint(_TethoqMarkPainter oldDelegate) => false;
}
