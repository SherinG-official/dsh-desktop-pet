'use strict';

/**
 * The two loopback ports the desktop shell uses to talk between its processes.
 *
 * There are no sockets, no IPC channels and no shared parent: the main app and
 * the pet are independent programs that must keep working when the other one is
 * not running. Two small TCP listeners on 127.0.0.1 are the whole contract.
 *
 *   FOCUS_PORT        pet  -> main   "show the main window"
 *                     The pet asks; the app listens while it runs. When the app
 *                     is closed the connection is refused and the pet ignores it.
 *
 *   PET_CONTROL_PORT  main -> pet    "show / hide / toggle / status / quit"
 *                     The pet listens; the app asks. This direction is what makes
 *                     the tray's 显示桌宠 switch actually control the *running*
 *                     pet instead of guessing from a process handle — and because
 *                     only one process can hold the port, it doubles as the pet's
 *                     single-instance lock.
 */

const FOCUS_PORT = 52117;
const PET_CONTROL_PORT = 52118;

module.exports = { FOCUS_PORT, PET_CONTROL_PORT };
