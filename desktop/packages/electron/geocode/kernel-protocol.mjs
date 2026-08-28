/* --- GeoCode: the message contract between Electron main and the kernel utility process
 * (docs/DESKTOP.md §5.1).
 *
 * Both ends are ours, but the wire between them is a process boundary. A message that
 * arrives malformed — from a kernel that died mid-handshake, or one still replaying an
 * older exchange — must be rejected here rather than destructured by the caller, so a
 * broken child cannot take the host down with it.
 *
 * The kernel reports the port it actually bound rather than echoing the requested one:
 * asking the host to probe a free port and then trusting that probe is a race, and it
 * also forecloses passing 0 to let the OS choose. --- */

export const KERNEL_COMMAND = {
  START: 'start',
  STOP: 'stop',
};

export const KERNEL_MESSAGE = {
  READY: 'ready',
  STOPPED: 'stopped',
  ERROR: 'error',
};

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isBindablePort = (value) => Number.isInteger(value) && value >= 0 && value <= 65535;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

export const serializeKernelError = (error) => {
  if (error instanceof Error) {
    const serialized = { message: error.message || String(error) };
    if (typeof error.stack === 'string') serialized.stack = error.stack;
    return serialized;
  }
  return { message: String(error) };
};

export const createStartCommand = ({ hostname, port, password }) => {
  if (!isNonEmptyString(hostname)) throw new Error('Kernel start command requires a hostname');
  if (!isBindablePort(port)) throw new Error(`Kernel start command requires a port in 0-65535, got: ${port}`);
  const command = { type: KERNEL_COMMAND.START, hostname: hostname.trim(), port };
  // Absent password means an unsecured kernel, which is a decision for the caller to make
  // explicitly; an empty string here must not be forwarded as if it were one.
  if (isNonEmptyString(password)) command.password = password;
  return command;
};

export const createStopCommand = () => ({ type: KERNEL_COMMAND.STOP });

/** Parsed on the kernel side, where `value` crossed a process boundary. Returns null when unusable. */
export const parseKernelCommand = (value) => {
  if (!isPlainObject(value)) return null;
  if (value.type === KERNEL_COMMAND.STOP) return { type: KERNEL_COMMAND.STOP };
  if (value.type !== KERNEL_COMMAND.START) return null;
  if (!isNonEmptyString(value.hostname) || !isBindablePort(value.port)) return null;
  const command = { type: KERNEL_COMMAND.START, hostname: value.hostname.trim(), port: value.port };
  if (isNonEmptyString(value.password)) command.password = value.password;
  return command;
};

export const createReadyMessage = ({ hostname, port }) => ({
  type: KERNEL_MESSAGE.READY,
  hostname,
  port,
});

export const createStoppedMessage = () => ({ type: KERNEL_MESSAGE.STOPPED });

export const createErrorMessage = (error) => ({
  type: KERNEL_MESSAGE.ERROR,
  error: serializeKernelError(error),
});

/** Parsed on the host side. Returns null when unusable, so an unknown message is ignored, not thrown on. */
export const parseKernelMessage = (value) => {
  if (!isPlainObject(value)) return null;
  if (value.type === KERNEL_MESSAGE.STOPPED) return { type: KERNEL_MESSAGE.STOPPED };
  if (value.type === KERNEL_MESSAGE.ERROR) {
    const message = isPlainObject(value.error) && isNonEmptyString(value.error.message)
      ? value.error.message
      : 'Kernel reported an error without a message';
    const error = { message };
    if (isPlainObject(value.error) && typeof value.error.stack === 'string') error.stack = value.error.stack;
    return { type: KERNEL_MESSAGE.ERROR, error };
  }
  if (value.type !== KERNEL_MESSAGE.READY) return null;
  // A ready without a bound address is not ready: the host has nothing to point the shell at.
  if (!isNonEmptyString(value.hostname) || !Number.isInteger(value.port) || value.port <= 0) return null;
  return { type: KERNEL_MESSAGE.READY, hostname: value.hostname, port: value.port };
};
