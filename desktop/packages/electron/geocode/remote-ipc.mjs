/* --- GeoCode: the IPC commands behind Remote Instances (docs/DESKTOP.md §7.3).
 *
 * The renderer reaches the main process through one `openchamber:invoke` channel and a command
 * name. Hiding the Remote Instances page and the host switcher removes the callers the product
 * ships, not the commands: anything running in the renderer can still invoke them. These are
 * the ones that connect to another machine, log in to another server, probe a host, or write a
 * remote host into the hosts list; handleInvoke refuses them before its switch. Reading the
 * hosts list stays, because the header and the recovery screens use it to learn that the
 * current host is the local one. --- */

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

export const isRemoteIpcCommand = (command) => REMOTE_IPC_SET.has(command);
