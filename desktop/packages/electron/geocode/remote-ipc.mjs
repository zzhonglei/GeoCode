/* --- GeoCode: the IPC commands behind Remote Instances, refused in handleInvoke because hiding their pages leaves
 * them invocable from the renderer (docs/DESKTOP.md §7.3). `desktop_hosts_get` is not among them: the header and
 * the recovery screen read it to learn that the current host is the local one. --- */

export const REMOTE_IPC_COMMANDS = Object.freeze([
  'desktop_ssh_instances_get',
  'desktop_ssh_instances_set',
  'desktop_ssh_import_hosts',
  'desktop_ssh_connect',
  'desktop_ssh_disconnect',
  'desktop_ssh_status',
  'desktop_ssh_logs',
  'desktop_ssh_logs_clear',
  'desktop_remote_password_login',
  'desktop_host_probe',
  'desktop_hosts_set',
]);

const REMOTE_IPC_SET = new Set(REMOTE_IPC_COMMANDS);

export const REMOTE_IPC_REFUSAL = 'Remote instances are not part of GeoCode';

// Upstream's useDesktopSshStore.load still sends two of these with the page hidden, so reads answer empty.
const EMPTY_READ_RESULTS = Object.freeze({
  desktop_ssh_instances_get: () => ({ instances: [] }),
  desktop_ssh_status: () => [],
  desktop_ssh_logs: () => [],
});

export const isRemoteIpcCommand = (command) => REMOTE_IPC_SET.has(command);

export const answerRemoteIpc = (command) => {
  const empty = EMPTY_READ_RESULTS[command];
  if (empty) return empty();
  throw new Error(REMOTE_IPC_REFUSAL);
};
