import { describe, expect, it } from 'bun:test';

import {
  KERNEL_COMMAND,
  KERNEL_MESSAGE,
  createErrorMessage,
  createReadyMessage,
  createStartCommand,
  createStopCommand,
  parseKernelCommand,
  parseKernelMessage,
  serializeKernelError,
} from './kernel-protocol.mjs';

describe('createStartCommand', () => {
  it('carries hostname, port, and password', () => {
    expect(createStartCommand({ hostname: '127.0.0.1', port: 4096, password: 'secret' })).toEqual({
      type: KERNEL_COMMAND.START,
      hostname: '127.0.0.1',
      port: 4096,
      password: 'secret',
    });
  });

  it('accepts port 0 so the operating system can choose', () => {
    expect(createStartCommand({ hostname: '127.0.0.1', port: 0 }).port).toBe(0);
  });

  it('omits an absent or blank password rather than forwarding an empty one', () => {
    expect(createStartCommand({ hostname: '127.0.0.1', port: 4096 })).not.toHaveProperty('password');
    expect(createStartCommand({ hostname: '127.0.0.1', port: 4096, password: '  ' })).not.toHaveProperty('password');
  });

  it('rejects a missing hostname or an out-of-range port', () => {
    expect(() => createStartCommand({ hostname: '', port: 4096 })).toThrow(/hostname/);
    expect(() => createStartCommand({ hostname: '127.0.0.1', port: 70000 })).toThrow(/0-65535/);
    expect(() => createStartCommand({ hostname: '127.0.0.1', port: 1.5 })).toThrow(/0-65535/);
  });
});

describe('parseKernelCommand', () => {
  it('round-trips what createStartCommand produces', () => {
    const command = createStartCommand({ hostname: '127.0.0.1', port: 4096, password: 'secret' });
    expect(parseKernelCommand(command)).toEqual(command);
  });

  it('round-trips a stop command', () => {
    expect(parseKernelCommand(createStopCommand())).toEqual({ type: KERNEL_COMMAND.STOP });
  });

  it('returns null for anything it cannot use', () => {
    expect(parseKernelCommand(null)).toBeNull();
    expect(parseKernelCommand('start')).toBeNull();
    expect(parseKernelCommand([])).toBeNull();
    expect(parseKernelCommand({ type: 'restart' })).toBeNull();
    expect(parseKernelCommand({ type: 'start', port: 4096 })).toBeNull();
    expect(parseKernelCommand({ type: 'start', hostname: '127.0.0.1' })).toBeNull();
    expect(parseKernelCommand({ type: 'start', hostname: '127.0.0.1', port: '4096' })).toBeNull();
  });
});

describe('parseKernelMessage', () => {
  it('accepts a ready that names the bound address', () => {
    expect(parseKernelMessage(createReadyMessage({ hostname: '127.0.0.1', port: 51234 }))).toEqual({
      type: KERNEL_MESSAGE.READY,
      hostname: '127.0.0.1',
      port: 51234,
    });
  });

  it('rejects a ready with no usable port, which the host could not point the shell at', () => {
    expect(parseKernelMessage({ type: 'ready', hostname: '127.0.0.1', port: 0 })).toBeNull();
    expect(parseKernelMessage({ type: 'ready', hostname: '127.0.0.1' })).toBeNull();
    expect(parseKernelMessage({ type: 'ready', port: 51234 })).toBeNull();
  });

  it('preserves an error message and stack', () => {
    const error = new Error('kernel exploded');
    expect(parseKernelMessage(createErrorMessage(error))).toEqual({
      type: KERNEL_MESSAGE.ERROR,
      error: { message: 'kernel exploded', stack: error.stack },
    });
  });

  it('substitutes a message when an error arrives without one', () => {
    expect(parseKernelMessage({ type: 'error', error: {} })?.error.message).toMatch(/without a message/);
    expect(parseKernelMessage({ type: 'error' })?.error.message).toMatch(/without a message/);
  });

  it('returns null for unknown shapes instead of throwing', () => {
    expect(parseKernelMessage(undefined)).toBeNull();
    expect(parseKernelMessage({ type: 'listening' })).toBeNull();
  });
});

describe('serializeKernelError', () => {
  it('keeps the message and stack of a real error', () => {
    const serialized = serializeKernelError(new Error('boom'));
    expect(serialized.message).toBe('boom');
    expect(typeof serialized.stack).toBe('string');
  });

  it('stringifies a thrown non-error', () => {
    expect(serializeKernelError('plain string')).toEqual({ message: 'plain string' });
    expect(serializeKernelError(42)).toEqual({ message: '42' });
  });
});
